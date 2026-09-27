fn push_atomic_staging_success(
results: &mut Vec<StagingFileOperationResult>,
file: &RepoStagingFile,
operation: &str,
verification: Option<&[RepoStagingFile]>,
) {
let newer_worktree_change = operation == "stage"
&& verification
.map(|files| files.iter().any(|candidate| candidate.has_unstaged_changes))
.unwrap_or(false);
let message = if operation == "stage" && newer_worktree_change {
"已暂存用户确认时的 immutable 内容；之后出现的工作区修改已保留为未暂存。"
} else if operation == "stage" {
"已暂存用户确认时的 immutable 内容。"
} else {
"已条件取消暂存用户确认时的 index 内容；工作区内容保持不变。"
};
results.push(StagingFileOperationResult {
path: file.path.clone(),
old_path: file.old_path.clone(),
status: "success".to_string(),
message: message.to_string(),
});
}
pub async fn get_repo_staging_snapshot_authoritative(
repo_path: String,
state: State<'_, AppState>,
) -> Result<RepoStagingSnapshot, String> {
ensure_repo_path(&repo_path)?;
    let _guard = acquire_repo_git_read_guard(&state, &repo_path).await?;
read_staging_snapshot_authoritative_inner(&repo_path).await
}
pub async fn run_staging_operation_authoritative(
operation: &str,
repo_path: String,
files: Vec<AuthoritativeStagingTarget>,
expected_snapshot_id: String,
state: State<'_, AppState>,
) -> Result<StagingOperationResult, String> {
ensure_repo_path(&repo_path)?;
if !matches!(operation, "stage" | "unstage") {
return Err("不支持的暂存区操作".to_string());
}
if files.is_empty() {
return Err("请至少选择一个文件".to_string());
}
if expected_snapshot_id.trim().is_empty() {
return Err("缺少仓库状态快照，请刷新后重试".to_string());
}
let normalized_files = normalize_authoritative_targets(&files)?;
let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
let initial_snapshot = read_staging_snapshot_authoritative_inner(&repo_path).await?;
if initial_snapshot.snapshot_id != expected_snapshot_id {
let message = "仓库状态已经变化，本次操作未开始，请刷新后重新确认。".to_string();
return Ok(StagingOperationResult {
operation: operation.to_string(),
status: "stale".to_string(),
mutated: false,
needs_confirmation: false,
requested_count: normalized_files.len(),
succeeded_count: 0,
failed_count: 0,
uncertain_count: 0,
results: authoritative_skipped_results(&normalized_files, &message),
snapshot: Some(initial_snapshot),
snapshot_error: None,
message,
});
}
let expected_head = initial_snapshot.head_hash.clone();
let mut results = Vec::new();
let mut succeeded = 0usize;
let mut failed = 0usize;
for (target_index, target) in normalized_files.iter().enumerate() {
let current_files = match read_authoritative_target_status(&repo_path, target).await {
Ok(files) => files,
Err(error) => {
let message = format!(
"执行前无法读取 selected target 状态：{}。当前文件及后续文件均未执行。",
error
);
let remaining = &normalized_files[target_index..];
failed += remaining.len();
results.extend(authoritative_failed_results(remaining, &message));
break;
}
};
let Some(file) = find_authoritative_status_file(&current_files, target) else {
failed += 1;
results.push(StagingFileOperationResult {
path: target.path.clone(),
old_path: target.old_path.clone(),
status: "failed".to_string(),
message: "文件 status authority 已变化，未执行该文件操作。".to_string(),
});
continue;
};
let mutation_result = if operation == "stage" {
crate::git_atomic_mutation::stage_verified_entry(
&repo_path,
&target.path,
target.old_path.as_deref(),
&target.expected_authority_id,
)
.await
} else {
crate::git_atomic_mutation::unstage_verified_entry_ref_guarded(
&repo_path,
&target.path,
target.old_path.as_deref(),
&target.expected_authority_id,
expected_head.as_deref(),
)
.await
};
match mutation_result {
Ok(()) => {
succeeded += 1;
                let verification = read_authoritative_target_status(&repo_path, target).await.ok();
                push_atomic_staging_success(
                    &mut results,
                    &file,
                    operation,
                    verification.as_deref(),
                );
            }
            Err(error) => {
                failed += 1;
                results.push(StagingFileOperationResult {
                    path: target.path.clone(),
                    old_path: target.old_path.clone(),
                    status: "failed".to_string(),
                    message: error,
                });
            }
        }
    }

    let (snapshot, snapshot_error) = match read_staging_snapshot_authoritative_inner(&repo_path).await {
        Ok(snapshot) => (Some(snapshot), None),
        Err(error) => (None, Some(error)),
    };
    let uncertain = usize::from(snapshot_error.is_some());
    let needs_confirmation = snapshot_error.is_some();
    let status = if snapshot_error.is_some() && succeeded == 0 && failed == 0 {
        "needs_confirmation"
    } else if failed == 0 && snapshot_error.is_none() {
        "complete"
    } else if succeeded == 0 && snapshot_error.is_none() {
        "failed"
    } else {
        "partial"
    };
    let message = operation_message(
        operation,
        succeeded,
        failed,
        uncertain,
        snapshot_error.as_deref(),
    );

    Ok(StagingOperationResult {
        operation: operation.to_string(),
        status: status.to_string(),
        mutated: succeeded > 0,
        needs_confirmation,
        requested_count: normalized_files.len(),
        succeeded_count: succeeded,
        failed_count: failed,
        uncertain_count: uncertain,
        results,
        snapshot,
        snapshot_error,
        message,
    })
}
