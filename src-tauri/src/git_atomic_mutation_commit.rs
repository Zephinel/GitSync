#[cfg(test)]
async fn commit_verified_entries_inner(
    repo_path: &str,
    entries: &[(String, Option<String>, String)],
    expected_head: Option<&str>,
    message: &str,
    before_commit: Option<&(dyn Fn() + Send + Sync)>,
) -> Result<AtomicCommitResult, String> {
    let snapshots = capture_expected_snapshots(repo_path, entries).await?;
    let selected = selected_paths(&snapshots);
    let desired_states = snapshot_worktree_index_map(&snapshots)?;
    let base_states = read_tree_index_states(repo_path, expected_head, &selected).await?;
    let commit_patch = build_index_patch(repo_path, &base_states, &desired_states).await?;
    if commit_patch.is_empty() {
        return Err("所选 immutable mutation input 没有可提交改动。".to_string());
    }

    if let Some(hook) = before_commit {
        hook();
    }

    let (temp_index, envs) = temp_index_from_head(repo_path, expected_head).await?;
    let temp_lock = PathBuf::from(format!("{}.lock", temp_index.to_string_lossy()));
    let result = async {
        apply_index_patch(repo_path, &commit_patch, &envs).await?;
        let tree = run_git_text(
            repo_path,
            &["write-tree".to_string()],
            &envs,
            None,
        )
        .await?;
        let tree = parse_oid(&tree, "git write-tree")?;
        let mut commit_args = vec!["commit-tree".to_string(), tree];
        if let Some(head) = expected_head.filter(|value| !value.is_empty()) {
            commit_args.push("-p".to_string());
            commit_args.push(head.to_string());
        }
        commit_args.push("-F".to_string());
        commit_args.push("-".to_string());
        let commit = run_git_text(repo_path, &commit_args, &[], Some(message.as_bytes())).await?;
        let commit = parse_oid(&commit, "git commit-tree")?;
        let expected_old = match expected_head.filter(|value| !value.is_empty()) {
            Some(head) => head.to_string(),
            None => object_zero_oid(repo_path).await?,
        };
        run_git_bytes(
            repo_path,
            &[
                "update-ref".to_string(),
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

        let old_index = snapshot_index_map(&snapshots)?;
        let reconcile_patch = build_index_patch(repo_path, &old_index, &desired_states).await?;
        let index_reconciled = match apply_index_patch(repo_path, &reconcile_patch, &[]).await {
            Ok(()) => true,
            Err(_) => false,
        };
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
