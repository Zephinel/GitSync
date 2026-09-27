#[cfg(test)]
fn stable_hash_stream_push_str_part(hasher: &mut DefaultHasher, value: &str) {
    value.hash(hasher);
    0xff_u8.hash(hasher);
}

fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    let normalized = subject.trim();
    for prefix in ["WIP on ", "On "] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            if let Some((branch, message)) = rest.split_once(':') {
                let branch = branch.trim();
                let message = message.trim();
                return (
                    (!branch.is_empty()).then(|| branch.to_string()),
                    if message.is_empty() {
                        normalized.to_string()
                    } else {
                        message.to_string()
                    },
                );
            }
        }
    }
    (None, normalized.to_string())
}

fn parse_stash_ordinal(selector: &str) -> usize {
    selector
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
fn parse_stash_list(raw: &str) -> Vec<RepoStashEntry> {
    raw.lines()
        .filter_map(|line| parse_stash_list_record(line).ok())
        .collect()
}

async fn read_base_summaries(
    repo_root: &str,
    entries: &[RepoStashEntry],
) -> Result<HashMap<String, String>, String> {
    let unique = entries
        .iter()
        .filter_map(|entry| entry.base_commit.clone())
        .collect::<HashSet<_>>();
    if unique.is_empty() {
        return Ok(HashMap::new());
    }

    let mut owned_args = vec![
        "show".to_string(),
        "-s".to_string(),
        "--format=%H%x00%s".to_string(),
    ];
    owned_args.extend(unique);
    let args = owned_args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_git(repo_root, &args, GIT_STASH_META_TIMEOUT_MS).await?;
    let mut summaries = HashMap::new();
    for line in output.lines() {
        if let Some((oid, summary)) = line.split_once('\0') {
            let oid = oid.trim();
            if !oid.is_empty() {
                summaries.insert(oid.to_string(), summary.trim().to_string());
            }
        }
    }
    Ok(summaries)
}

async fn read_optional_git_value(repo_root: &str, args: &[&str]) -> Result<Option<String>, String> {
    let output = run_git_output(repo_root, args, GIT_STASH_META_TIMEOUT_MS).await?;
    if !output.success {
        return Ok(None);
    }
    let value = output.stdout.trim();
    Ok((!value.is_empty()).then(|| value.to_string()))
}

async fn read_stash_snapshot_core(repo_root: &str) -> Result<RepoStashSnapshot, String> {
    let branch = read_optional_git_value(
        repo_root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await?;
    let head_hash = read_optional_git_value(
        repo_root,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )
    .await?;
    let branch_value = branch.as_deref().unwrap_or("DETACHED");
    let head_value = head_hash.as_deref().unwrap_or("UNBORN");
    let (worktree, worktree_id, mut snapshot_hasher) =
        read_snapshot_worktree_status(repo_root, branch_value, head_value).await?;
    let all_stashes = read_snapshot_stash_list(repo_root, &mut snapshot_hasher).await?;

    let stash_total = all_stashes.len();
    let summary_entries = all_stashes
        .iter()
        .take(GIT_STASH_BASE_SUMMARY_LIMIT)
        .cloned()
        .collect::<Vec<_>>();
    let base_summaries = read_base_summaries(repo_root, &summary_entries)
        .await
        .unwrap_or_default();
    let mut display_stashes = all_stashes.clone();
    for entry in &mut display_stashes {
        entry.base_summary = entry
            .base_commit
            .as_ref()
            .and_then(|oid| base_summaries.get(oid).cloned());
    }

    let snapshot_id = finish_snapshot_identity(snapshot_hasher);
    let has_untracked_changes = worktree.untracked_files > 0;
    let can_create_default = worktree.has_tracked_changes && worktree.conflicted_files == 0;
    let can_create_with_untracked = (worktree.has_tracked_changes || has_untracked_changes)
        && worktree.conflicted_files == 0;

    Ok(RepoStashSnapshot {
        repo_path: repo_root.to_string(),
        branch: branch.clone(),
        detached_head: branch.is_none(),
        head_hash,
        snapshot_id,
        worktree_id,
        staged_files: worktree.staged_files,
        unstaged_files: worktree.unstaged_files,
        mixed_files: worktree.mixed_files,
        untracked_files: worktree.untracked_files,
        conflicted_files: worktree.conflicted_files,
        conflict_paths: worktree.conflict_paths,
        has_tracked_changes: worktree.has_tracked_changes,
        has_untracked_changes,
        can_create_default,
        can_create_with_untracked,
        stash_total,
        stashes_truncated: false,
        stashes: display_stashes,
        all_stashes,
        pending_operation_total: 0,
        pending_operations_truncated: false,
        pending_operations: Vec::new(),
    })
}

fn order_pending_for_snapshot(
    repo_root: &str,
    unresolved: Vec<UnresolvedStashAuthority>,
) -> Vec<UnresolvedStashAuthority> {
    let current_origin = stash_worktree_origin(repo_root);
    let mut current = Vec::new();
    let mut legacy = Vec::new();
    let mut foreign = Vec::new();

    for operation in unresolved {
        match operation.origin_repo_path.as_deref() {
            Some(origin) if origin == current_origin => current.push(operation),
            None => legacy.push(operation),
            Some(_) => foreign.push(operation),
        }
    }

    current.extend(legacy);
    current.extend(foreign);
    current
}

fn apply_pending_projection(
    mut snapshot: RepoStashSnapshot,
    unresolved: Vec<UnresolvedStashAuthority>,
) -> RepoStashSnapshot {
    let total = unresolved.len();
    let ordered = order_pending_for_snapshot(&snapshot.repo_path, unresolved);
    let operations = project_pending_stash_operations(ordered);
    snapshot.pending_operation_total = total;
    snapshot.pending_operations_truncated = total > operations.len();
    snapshot.pending_operations = operations;
    snapshot
}

async fn project_pending_into_snapshot(
    repo_root: &str,
    snapshot: RepoStashSnapshot,
) -> Result<RepoStashSnapshot, String> {
    let unresolved = collect_unresolved_stash_authorities(repo_root).await?;
    Ok(apply_pending_projection(snapshot, unresolved))
}

async fn project_operation_result_snapshot(
    repo_root: &str,
    mut result: StashOperationResult,
) -> Result<StashOperationResult, String> {
    if let Some(snapshot) = result.snapshot.take() {
        match project_pending_into_snapshot(repo_root, snapshot.clone()).await {
            Ok(projected) => result.snapshot = Some(projected),
            Err(error) => {
                result.snapshot = Some(snapshot);
                result.needs_confirmation = true;
                if matches!(result.status.as_str(), "complete" | "acknowledged") {
                    result.status = "needs_confirmation".to_string();
                }
                let message = format!("Stash 操作结果已保留，但待确认操作证据投影失败：{}", error);
                if result.snapshot_error.is_none() {
                    result.snapshot_error = Some(message.clone());
                }
                if !result.warnings.iter().any(|value| value == &message) {
                    result.warnings.push(message);
                }
            }
        }
    }
    Ok(result)
}

async fn read_stash_snapshot(repo_root: &str) -> Result<RepoStashSnapshot, String> {
    // Snapshot projection is intentionally read-only. Retention belongs to the
    // public snapshot boundary and explicit admission scans, never to internal
    // operation-result projection where it could erase the current request's
    // idempotency evidence before the result is returned.
    let snapshot = read_stash_snapshot_core(repo_root).await?;
    project_pending_into_snapshot(repo_root, snapshot).await
}

fn stash_ids(snapshot: &RepoStashSnapshot) -> HashSet<String> {
    snapshot
        .all_stashes
        .iter()
        .map(|entry| entry.id.clone())
        .collect()
}

fn find_stash_entry<'a>(snapshot: &'a RepoStashSnapshot, stash_id: &str) -> Option<&'a RepoStashEntry> {
    snapshot
        .all_stashes
        .iter()
        .find(|entry| entry.id == stash_id)
}
