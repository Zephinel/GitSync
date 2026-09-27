pub async fn discard_repo_working_files_authoritative(
repo_path: String,
files: Vec<AuthoritativeWorkingChangeTarget>,
expected_snapshot_id: String,
state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
ensure_repo_path(&repo_path)?;
let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
let normalized_targets = normalize_authoritative_working_targets(&files)?;
let summary = read_working_summary_inner(&repo_path).await?;
ensure_expected_snapshot(&summary, &expected_snapshot_id)?;
let selected = find_authoritative_requested_status_files(&summary.files, &normalized_targets)?;
let expected_head = (!summary.full_hash.is_empty()).then_some(summary.full_hash.as_str());
let mut recovery_total = 0usize;
let mut external_change_preserved = false;
for (index, (file, target)) in selected.iter().zip(&normalized_targets).enumerate() {
match crate::git_atomic_mutation::discard_verified_entry_ref_guarded(
&repo_path,
&file.path,
file.old_path.as_deref(),
&target.expected_authority_id,
expected_head,
)
.await
{
Ok(result) => {
recovery_total += result.recovery_paths.len();
external_change_preserved |= result.external_change_preserved;
}
Err(error) => {
return Err(format!(
"Discard 在第 {} / {} 个文件安全停止：{}。已完成的 preimage 均保留在 Git recovery，请刷新确认。",
index + 1,
selected.len(),
error
));
}
}
}
let message = if external_change_preserved {
format!(
"已条件丢弃 {} 个文件的已确认内容；检测到之后出现的外部 worktree 内容并已原位保留。{} 个 preimage 已保存在 Git recovery。",
selected.len(), recovery_total
)
} else {
format!(
"已条件丢弃 {} 个文件的已确认内容；{} 个 preimage 已保存在 Git recovery。",
selected.len(), recovery_total
)
};
Ok(WorkingChangesOperationResult {
affected_count: selected.len(),
commit_hash: None,
message,
})
}
pub async fn discard_repo_working_files_unstaged_authoritative(
repo_path: String,
files: Vec<AuthoritativeWorkingChangeTarget>,
expected_snapshot_id: String,
state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
ensure_repo_path(&repo_path)?;
let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
let normalized_targets = normalize_authoritative_working_targets(&files)?;
let summary = read_working_summary_inner(&repo_path).await?;
ensure_expected_snapshot(&summary, &expected_snapshot_id)?;
let selected = find_authoritative_requested_status_files(&summary.files, &normalized_targets)?;
for file in &selected {
if !file.is_untracked && matches!(file.worktree_code.as_str(), " " | "!") {
return Err(format!(
"文件没有未暂存改动，不能丢弃工作区内容: {}",
file.path
));
}
}
let expected_head = (!summary.full_hash.is_empty()).then_some(summary.full_hash.as_str());
let mut recovery_total = 0usize;
let mut external_change_preserved = false;
for (index, (file, target)) in selected.iter().zip(&normalized_targets).enumerate() {
match crate::git_atomic_mutation::discard_worktree_verified_entry_ref_guarded(
&repo_path,
&file.path,
file.old_path.as_deref(),
&target.expected_authority_id,
expected_head,
)
.await
{
Ok(result) => {
recovery_total += result.recovery_paths.len();
external_change_preserved |= result.external_change_preserved;
}
Err(error) => {
return Err(format!(
"丢弃未暂存改动在第 {} / {} 个文件安全停止：{}。已完成的 preimage 均保留在 Git recovery，请刷新确认。",
index + 1,
selected.len(),
error
));
}
}
}
let message = if external_change_preserved {
format!(
"已条件丢弃 {} 个文件的未暂存改动；检测到之后出现的外部 worktree 内容并已原位保留。{} 个 preimage 已保存在 Git recovery。",
selected.len(), recovery_total
)
} else {
format!(
"已条件丢弃 {} 个文件的未暂存改动；{} 个 preimage 已保存在 Git recovery。",
selected.len(), recovery_total
)
};
Ok(WorkingChangesOperationResult {
affected_count: selected.len(),
commit_hash: None,
message,
})
}
pub async fn commit_repo_working_files_authoritative(
repo_path: String,
files: Vec<AuthoritativeWorkingChangeTarget>,
expected_snapshot_id: String,
message: String,
state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
ensure_repo_path(&repo_path)?;
let message = message.trim().to_string();
if message.is_empty() {
return Err("提交信息不能为空".to_string());
}
let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
let normalized_targets = normalize_authoritative_working_targets(&files)?;
let summary = read_working_summary_inner(&repo_path).await?;
ensure_expected_snapshot(&summary, &expected_snapshot_id)?;
let selected = find_authoritative_requested_status_files(&summary.files, &normalized_targets)?;
if selected.iter().any(|file| file.is_conflicted) {
return Err("所选文件包含未解决冲突，请先解决冲突后再提交。".to_string());
}
let immutable_entries = selected
.iter()
.zip(&normalized_targets)
.map(|(file, target)| {
(
file.path.clone(),
file.old_path.clone(),
target.expected_authority_id.clone(),
)
})
.collect::<Vec<_>>();
let expected_head = (!summary.full_hash.is_empty()).then_some(summary.full_hash.as_str());
let result = crate::git_atomic_mutation::commit_verified_entries_ref_guarded(
&repo_path,
&immutable_entries,
expected_head,
&message,
)
.await?;
let result_message = if result.index_reconciled {
format!(
"已提交 {} 个文件：{}。Commit 使用用户确认时的 immutable 内容；之后的 worktree 修改会继续保留为未提交改动。",
selected.len(),
result.commit_hash.chars().take(7).collect::<String>()
)
} else {
format!(
"已提交 {} 个文件：{}。检测到外部 index 变化，GitSync 未覆盖该 index；请刷新查看保留的外部暂存内容。",
selected.len(),
result.commit_hash.chars().take(7).collect::<String>()
)
};
Ok(WorkingChangesOperationResult {
affected_count: selected.len(),
commit_hash: Some(result.commit_hash),
message: result_message,
})
}
