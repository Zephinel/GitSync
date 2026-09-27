pub async fn commit_verified_entries_ref_guarded(
    repo_path: &str,
    entries: &[(String, Option<String>, String)],
    expected_head: Option<&str>,
    message: &str,
) -> Result<AtomicCommitResult, String> {
    // The real index lock is the cross-process admission fence for ordinary
    // Working Changes Commit. Git merge/cherry-pick/rebase/sequencer commands
    // need this lock before they can establish operation state in the repo.
    let real_index_guard = RealIndexLockGuard::acquire(repo_path).await?;
    ensure_normal_commit_operation_state(repo_path).await?;

    let snapshots = capture_expected_snapshots(repo_path, entries).await?;
    let selected = selected_paths(&snapshots);
    let desired_states = snapshot_worktree_index_map(&snapshots)?;
    let base_states = read_tree_index_states(repo_path, expected_head, &selected).await?;
    let commit_patch = build_index_patch(repo_path, &base_states, &desired_states).await?;
    if commit_patch.is_empty() {
        return Err("所选 immutable mutation input 没有可提交改动。".to_string());
    }

    let (temp_index, envs) = temp_index_from_head(repo_path, expected_head).await?;
    let temp_lock = PathBuf::from(format!("{}.lock", temp_index.to_string_lossy()));
    let result = async {
        apply_index_patch(repo_path, &commit_patch, &envs).await?;

        // Freeze the immutable commit tree before hooks. Hooks receive the
        // private selected-scope index for policy checks, but are not allowed to
        // silently replace the bytes the user confirmed.
        let tree_before_hooks = run_git_text(
            repo_path,
            &["write-tree".to_string()],
            &envs,
            None,
        )
        .await?;
        let tree_before_hooks = parse_oid(&tree_before_hooks, "git write-tree before hooks")?;

        // `core.commentChar=auto` is selected by git-commit from the original
        // message before prepare-commit-msg/commit-msg run. Resolve the cleanup
        // authority before hooks so final strip cleanup uses the same dynamic
        // comment character instead of treating `auto` as the default `#`.
        let cleanup_mode = resolve_commit_cleanup_mode(repo_path, message.as_bytes()).await?;
        let hook_message = run_pre_publish_commit_hooks(repo_path, message, &envs).await?;
        let final_message = finalize_commit_message(repo_path, hook_message, cleanup_mode).await?;

        let tree_after_hooks = run_git_text(
            repo_path,
            &["write-tree".to_string()],
            &envs,
            None,
        )
        .await?;
        let tree_after_hooks = parse_oid(&tree_after_hooks, "git write-tree after hooks")?;
        if tree_after_hooks != tree_before_hooks {
            return Err(
                "Commit hook 修改了 immutable selected index；为避免绕过用户确认的内容 authority，本次 Commit 已拒绝，HEAD 未移动。"
                    .to_string(),
            );
        }

        // A hook can invoke Git itself. Recheck operation-state markers while
        // the real index lock is still held before publishing the commit.
        ensure_normal_commit_operation_state(repo_path).await?;

        let old_index = snapshot_index_map(&snapshots)?;
        let reconcile_patch = build_index_patch(repo_path, &old_index, &desired_states).await?;

        let mut commit_args = vec!["commit-tree".to_string(), tree_before_hooks];
        if let Some(head) = expected_head.filter(|value| !value.is_empty()) {
            commit_args.push("-p".to_string());
            commit_args.push(head.to_string());
        }
        commit_args.push("-F".to_string());
        commit_args.push("-".to_string());
        let commit = run_git_text(repo_path, &commit_args, &[], Some(&final_message)).await?;
        let commit = parse_oid(&commit, "git commit-tree")?;
        let expected_old = match expected_head.filter(|value| !value.is_empty()) {
            Some(head) => head.to_string(),
            None => object_zero_oid(repo_path).await?,
        };
        let reflog_reason = commit_reflog_reason(
            &final_message,
            expected_head.filter(|value| !value.is_empty()).is_none(),
        );
        run_git_bytes(
            repo_path,
            &[
                "update-ref".to_string(),
                "-m".to_string(),
                reflog_reason,
                "HEAD".to_string(),
                commit.clone(),
                expected_old,
            ],
            &[],
            None,
        )
        .await
        .map_err(|error| {
            format!(
                "Commit HEAD CAS 失败；外部 HEAD 变化已保留，本次 commit 未发布: {}",
                error
            )
        })?;

        // The normal-operation admission fence is no longer needed after HEAD
        // publication. Release it before touching the real index so Git's own
        // index lock protocol can be used by the conditional reconcile.
        real_index_guard.release();

        let index_reconciled = match ExpectedHeadRefGuard::acquire(repo_path, Some(&commit)).await {
            Ok(guard) => {
                let reconcile = apply_index_patch(repo_path, &reconcile_patch, &[]).await;
                let release = guard.release().await;
                reconcile.is_ok() && release.is_ok()
            }
            Err(_) => false,
        };

        // post-commit is observational in normal Git semantics: it runs after
        // publication and its exit status must not retroactively turn a
        // successful commit into a failed operation.
        run_post_commit_hook_best_effort(repo_path).await;

        Ok(AtomicCommitResult {
            commit_hash: commit,
            index_reconciled,
        })
    }
    .await;

    let _ = tokio::fs::remove_file(&temp_index).await;
    let _ = tokio::fs::remove_file(&temp_lock).await;
    result
}
