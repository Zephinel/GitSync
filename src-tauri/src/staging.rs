use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Component, Path};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::process::Command;

const GIT_STAGING_META_TIMEOUT_MS: u64 = crate::git_timeouts::STAGING_META;
const GIT_STAGING_STATUS_TIMEOUT_MS: u64 = crate::git_timeouts::STAGING_STATUS;
#[cfg(test)]
const GIT_STAGING_OPERATION_TIMEOUT_MS: u64 = crate::git_timeouts::STAGING_OPERATION;
const GIT_STAGING_MAX_FILES: usize = 5_000;

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct RepoStagingFile {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub index_code: String,
    pub worktree_code: String,
    pub staging_state: String,
    pub has_staged_changes: bool,
    pub has_unstaged_changes: bool,
    pub is_untracked: bool,
    pub is_conflicted: bool,
    pub can_stage: bool,
    pub can_unstage: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoStagingSnapshot {
    pub repo_path: String,
    pub branch: Option<String>,
    pub detached_head: bool,
    pub head_hash: Option<String>,
    pub snapshot_id: String,
    pub files_changed: usize,
    pub files_truncated: bool,
    pub staged_files: usize,
    pub unstaged_files: usize,
    pub mixed_files: usize,
    pub untracked_files: usize,
    pub conflicted_files: usize,
    pub files: Vec<RepoStagingFile>,
}

#[cfg(test)]
#[derive(Debug, Deserialize, Clone, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct StagingTarget {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub expected_index_code: String,
    pub expected_worktree_code: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StagingFileOperationResult {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StagingOperationResult {
    pub operation: String,
    pub status: String,
    pub mutated: bool,
    pub needs_confirmation: bool,
    pub requested_count: usize,
    pub succeeded_count: usize,
    pub failed_count: usize,
    pub uncertain_count: usize,
    pub results: Vec<StagingFileOperationResult>,
    pub snapshot: Option<RepoStagingSnapshot>,
    pub snapshot_error: Option<String>,
    pub message: String,
}

fn ensure_repo_path(path: &str) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("仓库路径不能为空".to_string());
    }
    if !Path::new(normalized).is_dir() {
        return Err(format!("仓库目录不存在: {}", normalized));
    }
    Ok(())
}

async fn resolve_repo_lock_key(path: &str) -> Result<String, String> {
    let output = run_git(
        path,
        &["rev-parse", "--show-toplevel"],
        GIT_STAGING_META_TIMEOUT_MS,
    )
    .await?;
    let root = output.trim();
    if root.is_empty() {
        return Err("无法解析 Git 工作区根目录".to_string());
    }
    Ok(crate::repo_git_lock::normalize_repo_lock_key(root))
}

/// Resolving the worktree root needs git, so this keeps its own key resolution and
/// delegates the key normalization and the bounded wait to the lock authority.
async fn acquire_repo_git_guard(
    state: &AppState,
    path: &str,
) -> Result<crate::repo_git_lock::RepoGitGuard, String> {
    let key = resolve_repo_lock_key(path).await?;
    crate::repo_git_lock::acquire_key(state, key).await
}

async fn acquire_repo_git_read_guard(
    state: &AppState,
    path: &str,
) -> Result<crate::repo_git_lock::RepoGitGuard, String> {
    let key = resolve_repo_lock_key(path).await?;
    crate::repo_git_lock::acquire_key_read(state, key).await
}

fn new_git_command(repo_path: &str, args: &[&str]) -> Command {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn run_git_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    run_git_output_with_command(
        new_git_command(repo_path, args),
        args,
        timeout_ms,
    )
    .await
}

async fn run_git_output_with_command(
    mut command: Command,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("Git 命令执行超时: git {}", args.join(" ")))?
        .map_err(|error| format!("无法执行 Git 命令: {}", error))?;
    let stdout = crate::git_encoding::decode_git_stdout(output.stdout, "Staging Git stdout")?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

#[cfg(test)]
async fn run_git_mutation(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    let output = run_git_output_with_command(
        crate::git_command::new_mutation_async_command(repo_path, args),
        args,
        timeout_ms,
    )
    .await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(git_failure(args, output))
    }
}

fn git_failure(args: &[&str], output: GitCommandOutput) -> String {
    if output.stderr.is_empty() {
        format!(
            "Git 命令失败: git {}（退出码 {:?}）",
            args.join(" "),
            output.code
        )
    } else {
        output.stderr
    }
}

async fn run_git(repo_path: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let output = run_git_output(repo_path, args, timeout_ms).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(git_failure(args, output))
    }
}

#[cfg(test)]
async fn git_succeeds(repo_path: &str, args: &[&str]) -> bool {
    run_git_output(repo_path, args, GIT_STAGING_META_TIMEOUT_MS)
        .await
        .map(|output| output.success)
        .unwrap_or(false)
}

fn split_z(output: &str) -> Vec<String> {
    output
        .split('\0')
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn is_conflict_code(code: &str) -> bool {
    matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") || code.contains('U')
}

fn has_index_change(code: char, is_untracked: bool) -> bool {
    !is_untracked && !matches!(code, ' ' | '?' | '!')
}

fn has_worktree_change(code: char, is_untracked: bool) -> bool {
    is_untracked || !matches!(code, ' ' | '!')
}

fn normalize_status(
    index_code: char,
    worktree_code: char,
    is_untracked: bool,
    conflicted: bool,
) -> String {
    if is_untracked {
        return "added".to_string();
    }
    if conflicted {
        return "unmerged".to_string();
    }
    for code in [index_code, worktree_code] {
        match code {
            'R' => return "renamed".to_string(),
            'C' => return "copied".to_string(),
            'A' => return "added".to_string(),
            'D' => return "deleted".to_string(),
            'T' => return "typechange".to_string(),
            'M' => return "modified".to_string(),
            _ => {}
        }
    }
    "unknown".to_string()
}

fn staging_state(
    is_untracked: bool,
    is_conflicted: bool,
    has_staged_changes: bool,
    has_unstaged_changes: bool,
) -> String {
    if is_untracked {
        "untracked"
    } else if is_conflicted {
        "conflicted"
    } else if has_staged_changes && has_unstaged_changes {
        "mixed"
    } else if has_staged_changes {
        "staged"
    } else if has_unstaged_changes {
        "unstaged"
    } else {
        "clean"
    }
    .to_string()
}

fn make_file_id(
    index_code: char,
    worktree_code: char,
    old_path: Option<&str>,
    path: &str,
) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        index_code,
        worktree_code,
        old_path.unwrap_or_default(),
        path
    )
}

fn parse_status_porcelain_z(output: &str) -> Vec<RepoStagingFile> {
    let fields = split_z(output);
    let mut files = Vec::new();
    let mut index = 0usize;

    while index < fields.len() {
        let field = &fields[index];
        index += 1;
        if field.len() < 3 {
            continue;
        }

        let code = &field[..2];
        let mut code_chars = code.chars();
        let index_code = code_chars.next().unwrap_or(' ');
        let worktree_code = code_chars.next().unwrap_or(' ');
        let path = field[3..].to_string();
        if path.is_empty() {
            continue;
        }

        let rename_or_copy = matches!(index_code, 'R' | 'C') || matches!(worktree_code, 'R' | 'C');
        let old_path = if rename_or_copy && index < fields.len() {
            let value = fields[index].clone();
            index += 1;
            (!value.is_empty()).then_some(value)
        } else {
            None
        };

        let is_untracked = code == "??";
        let is_conflicted = is_conflict_code(code);
        let has_staged_changes = has_index_change(index_code, is_untracked);
        let has_unstaged_changes = has_worktree_change(worktree_code, is_untracked);
        let state = staging_state(
            is_untracked,
            is_conflicted,
            has_staged_changes,
            has_unstaged_changes,
        );

        files.push(RepoStagingFile {
            id: make_file_id(index_code, worktree_code, old_path.as_deref(), &path),
            path,
            old_path,
            status: normalize_status(index_code, worktree_code, is_untracked, is_conflicted),
            index_code: index_code.to_string(),
            worktree_code: worktree_code.to_string(),
            staging_state: state,
            has_staged_changes,
            has_unstaged_changes,
            is_untracked,
            is_conflicted,
            can_stage: has_unstaged_changes && !is_conflicted,
            can_unstage: has_staged_changes && !is_conflicted,
        });
    }

    files
}

fn validate_relative_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path == "." || path.contains('\0') {
        return Err("文件路径不能为空".to_string());
    }
    let parsed = Path::new(path);
    for component in parsed.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("文件路径不安全: {}", path));
        }
    }
    Ok(path.to_string())
}

fn literal_pathspec(path: &str) -> String {
    format!(":(literal){}", path)
}

async fn read_optional_git_line(repo_path: &str, args: &[&str]) -> Option<String> {
    let output = run_git_output(repo_path, args, GIT_STAGING_META_TIMEOUT_MS)
        .await
        .ok()?;
    if !output.success {
        return None;
    }
    let value = output.stdout.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn make_snapshot_id(branch: Option<&str>, head_hash: Option<&str>, status_output: &str) -> String {
    let mut hasher = DefaultHasher::new();
    branch.unwrap_or_default().hash(&mut hasher);
    head_hash.unwrap_or_default().hash(&mut hasher);
    status_output.hash(&mut hasher);
    format!("staging-v1-{:016x}", hasher.finish())
}

async fn read_staging_snapshot_inner(repo_path: &str) -> Result<RepoStagingSnapshot, String> {
    let inside = run_git(
        repo_path,
        &["rev-parse", "--is-inside-work-tree"],
        GIT_STAGING_META_TIMEOUT_MS,
    )
    .await?;
    if inside.trim() != "true" {
        return Err("目标目录不是可用的 Git 工作区".to_string());
    }

    let status_output = run_git(
        repo_path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--untracked-files=all",
        ],
        GIT_STAGING_STATUS_TIMEOUT_MS,
    )
    .await?;
    let branch =
        read_optional_git_line(repo_path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
    let head_hash = read_optional_git_line(repo_path, &["rev-parse", "--verify", "HEAD"]).await;
    let snapshot_id = make_snapshot_id(branch.as_deref(), head_hash.as_deref(), &status_output);
    let mut files = parse_status_porcelain_z(&status_output);
    let files_changed = files.len();
    let files_truncated = files_changed > GIT_STAGING_MAX_FILES;
    let staged_files = files.iter().filter(|file| file.has_staged_changes).count();
    let unstaged_files = files
        .iter()
        .filter(|file| file.has_unstaged_changes)
        .count();
    let mixed_files = files
        .iter()
        .filter(|file| file.staging_state == "mixed")
        .count();
    let untracked_files = files.iter().filter(|file| file.is_untracked).count();
    let conflicted_files = files.iter().filter(|file| file.is_conflicted).count();
    if files_truncated {
        files.truncate(GIT_STAGING_MAX_FILES);
    }

    Ok(RepoStagingSnapshot {
        repo_path: repo_path.to_string(),
        detached_head: branch.is_none() && head_hash.is_some(),
        branch,
        head_hash,
        snapshot_id,
        files_changed,
        files_truncated,
        staged_files,
        unstaged_files,
        mixed_files,
        untracked_files,
        conflicted_files,
        files,
    })
}

#[cfg(test)]
fn normalized_target(target: &StagingTarget) -> Result<StagingTarget, String> {
    let path = validate_relative_path(&target.path)?;
    let old_path = target
        .old_path
        .as_deref()
        .map(validate_relative_path)
        .transpose()?;
    if target.expected_index_code.chars().count() != 1
        || target.expected_worktree_code.chars().count() != 1
    {
        return Err(format!("文件状态快照无效: {}", path));
    }
    Ok(StagingTarget {
        path,
        old_path,
        expected_index_code: target.expected_index_code.clone(),
        expected_worktree_code: target.expected_worktree_code.clone(),
    })
}

#[cfg(test)]
fn normalized_targets(targets: &[StagingTarget]) -> Result<Vec<StagingTarget>, String> {
    let mut normalized_files = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        let normalized = normalized_target(target)?;
        if seen.insert(normalized.clone()) {
            normalized_files.push(normalized);
        }
    }
    Ok(normalized_files)
}

#[cfg(test)]
fn find_target_file(
    snapshot: &RepoStagingSnapshot,
    target: &StagingTarget,
) -> Option<RepoStagingFile> {
    snapshot
        .files
        .iter()
        .find(|file| {
            file.path == target.path
                && file.old_path == target.old_path
                && file.index_code == target.expected_index_code
                && file.worktree_code == target.expected_worktree_code
        })
        .cloned()
}

#[cfg(test)]
fn pathspecs(file: &RepoStagingFile) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if seen.insert(file.path.clone()) {
        paths.push(literal_pathspec(&file.path));
    }
    if let Some(old_path) = file.old_path.as_ref() {
        if seen.insert(old_path.clone()) {
            paths.push(literal_pathspec(old_path));
        }
    }
    paths
}

#[cfg(test)]
fn shares_logical_path(candidate: &RepoStagingFile, original: &RepoStagingFile) -> bool {
    let candidate_paths = [Some(candidate.path.as_str()), candidate.old_path.as_deref()];
    let original_paths = [Some(original.path.as_str()), original.old_path.as_deref()];

    candidate_paths.into_iter().flatten().any(|candidate_path| {
        original_paths
            .into_iter()
            .flatten()
            .any(|original_path| candidate_path == original_path)
    })
}

#[cfg(test)]
fn verify_operation(
    snapshot: &RepoStagingSnapshot,
    original: &RepoStagingFile,
    operation: &str,
) -> bool {
    let related = snapshot
        .files
        .iter()
        .filter(|candidate| shares_logical_path(candidate, original))
        .collect::<Vec<_>>();
    if related.is_empty() {
        return false;
    }

    match operation {
        "stage" => {
            related.iter().any(|file| file.has_staged_changes)
                && related.iter().all(|file| !file.has_unstaged_changes)
        }
        "unstage" => {
            related.iter().any(|file| file.has_unstaged_changes)
                && related.iter().all(|file| !file.has_staged_changes)
        }
        _ => false,
    }
}

#[cfg(test)]
async fn stage_file(repo_path: &str, file: &RepoStagingFile) -> Result<(), String> {
    if file.is_conflicted {
        return Err("冲突文件不能通过普通 Stage 操作标记为已解决".to_string());
    }
    if !file.has_unstaged_changes {
        return Err("该文件没有可暂存的改动".to_string());
    }

    let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(pathspecs(file));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_mutation(repo_path, &refs, GIT_STAGING_OPERATION_TIMEOUT_MS)
        .await
        .map(|_| ())
}

#[cfg(test)]
async fn unstage_file(repo_path: &str, file: &RepoStagingFile) -> Result<(), String> {
    if file.is_conflicted {
        return Err("冲突文件不能通过普通 Unstage 操作改变解决状态".to_string());
    }
    if !file.has_staged_changes {
        return Err("该文件没有已暂存的改动".to_string());
    }

    let has_head = git_succeeds(repo_path, &["rev-parse", "--verify", "HEAD"]).await;
    let mut args = if has_head {
        vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--source=HEAD".to_string(),
            "--".to_string(),
        ]
    } else {
        vec![
            "rm".to_string(),
            "-r".to_string(),
            "-f".to_string(),
            "--cached".to_string(),
            "--ignore-unmatch".to_string(),
            "--".to_string(),
        ]
    };
    args.extend(pathspecs(file));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_mutation(repo_path, &refs, GIT_STAGING_OPERATION_TIMEOUT_MS)
        .await
        .map(|_| ())
}

#[cfg(test)]
fn skipped_results(targets: &[StagingTarget], message: &str) -> Vec<StagingFileOperationResult> {
    targets
        .iter()
        .map(|target| StagingFileOperationResult {
            path: target.path.clone(),
            old_path: target.old_path.clone(),
            status: "skipped".to_string(),
            message: message.to_string(),
        })
        .collect()
}

#[cfg(test)]
fn failed_results(targets: &[StagingTarget], message: &str) -> Vec<StagingFileOperationResult> {
    targets
        .iter()
        .map(|target| StagingFileOperationResult {
            path: target.path.clone(),
            old_path: target.old_path.clone(),
            status: "failed".to_string(),
            message: message.to_string(),
        })
        .collect()
}

fn operation_message(
    operation: &str,
    succeeded: usize,
    failed: usize,
    uncertain: usize,
    snapshot_error: Option<&str>,
) -> String {
    let label = if operation == "stage" {
        "暂存"
    } else {
        "取消暂存"
    };
    let mut parts = Vec::new();
    if succeeded > 0 {
        parts.push(format!("已{} {} 个文件", label, succeeded));
    }
    if failed > 0 {
        parts.push(format!("{} 个文件失败或未执行", failed));
    }
    if uncertain > 0 {
        parts.push(format!("{} 个文件的结果需要确认", uncertain));
    }
    if parts.is_empty() {
        parts.push(format!("没有文件完成{}", label));
    }
    if snapshot_error.is_some() {
        parts.push("最终仓库状态读取失败".to_string());
    }
    format!("{}。", parts.join("，"))
}

#[cfg(test)]
fn push_success_result(
    results: &mut Vec<StagingFileOperationResult>,
    file: &RepoStagingFile,
    operation: &str,
    recovered_from_error: bool,
) {
    let message = if recovered_from_error {
        if operation == "stage" {
            "Git 命令返回异常，但重新读取后已确认文件完成暂存。"
        } else {
            "Git 命令返回异常，但重新读取后已确认文件完成取消暂存。"
        }
    } else if operation == "stage" {
        "文件已暂存。"
    } else {
        "文件已取消暂存，工作区内容保持不变。"
    };
    results.push(StagingFileOperationResult {
        path: file.path.clone(),
        old_path: file.old_path.clone(),
        status: "success".to_string(),
        message: message.to_string(),
    });
}

#[cfg(test)]
fn push_uncertain_result(
    results: &mut Vec<StagingFileOperationResult>,
    file: &RepoStagingFile,
    message: String,
) {
    results.push(StagingFileOperationResult {
        path: file.path.clone(),
        old_path: file.old_path.clone(),
        status: "needs_confirmation".to_string(),
        message,
    });
}

#[cfg(test)]
async fn run_staging_operation(
    operation: &str,
    repo_path: String,
    files: Vec<StagingTarget>,
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

    let normalized_files = normalized_targets(&files)?;

    let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
    let initial_snapshot = read_staging_snapshot_inner(&repo_path).await?;
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
            results: skipped_results(&normalized_files, &message),
            snapshot: Some(initial_snapshot),
            snapshot_error: None,
            message,
        });
    }

    let mut results = Vec::new();
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut uncertain = 0usize;

    for (target_index, target) in normalized_files.iter().enumerate() {
        let current_snapshot = match read_staging_snapshot_inner(&repo_path).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let message = format!(
                    "执行前无法重新读取仓库状态：{}。当前文件及后续文件均未执行。",
                    error
                );
                let remaining = &normalized_files[target_index..];
                failed += remaining.len();
                results.extend(failed_results(remaining, &message));
                break;
            }
        };
        let Some(file) = find_target_file(&current_snapshot, target) else {
            failed += 1;
            results.push(StagingFileOperationResult {
                path: target.path.clone(),
                old_path: target.old_path.clone(),
                status: "failed".to_string(),
                message: "文件状态已经变化，未执行该文件操作。".to_string(),
            });
            continue;
        };

        let operation_result = if operation == "stage" {
            stage_file(&repo_path, &file).await
        } else {
            unstage_file(&repo_path, &file).await
        };

        match operation_result {
            Ok(()) => match read_staging_snapshot_inner(&repo_path).await {
                Ok(verification) if verify_operation(&verification, &file, operation) => {
                    succeeded += 1;
                    push_success_result(&mut results, &file, operation, false);
                }
                Ok(verification) if verification.snapshot_id == current_snapshot.snapshot_id => {
                    failed += 1;
                    results.push(StagingFileOperationResult {
                        path: file.path.clone(),
                        old_path: file.old_path.clone(),
                        status: "failed".to_string(),
                        message: "Git 命令已完成，但仓库状态没有发生变化。".to_string(),
                    });
                }
                Ok(_) => {
                    uncertain += 1;
                    push_uncertain_result(
                        &mut results,
                        &file,
                        "Git 命令已返回，但仓库状态未达到预期；请刷新状态，不要直接重试。"
                            .to_string(),
                    );
                }
                Err(error) => {
                    uncertain += 1;
                    push_uncertain_result(
                        &mut results,
                        &file,
                        format!(
                            "Git 命令已返回，但操作后状态读取失败：{}。请重新确认，不要直接重试。",
                            error
                        ),
                    );
                }
            },
            Err(command_error) => match read_staging_snapshot_inner(&repo_path).await {
                Ok(verification) if verify_operation(&verification, &file, operation) => {
                    succeeded += 1;
                    push_success_result(&mut results, &file, operation, true);
                }
                Ok(verification) if verification.snapshot_id == current_snapshot.snapshot_id => {
                    failed += 1;
                    results.push(StagingFileOperationResult {
                        path: file.path.clone(),
                        old_path: file.old_path.clone(),
                        status: "failed".to_string(),
                        message: command_error,
                    });
                }
                Ok(_) => {
                    uncertain += 1;
                    push_uncertain_result(
                        &mut results,
                        &file,
                        format!(
                            "Git 命令返回异常，且仓库状态已变化但未达到预期：{}。请重新确认，不要直接重试。",
                            command_error
                        ),
                    );
                }
                Err(verification_error) => {
                    uncertain += 1;
                    push_uncertain_result(
                        &mut results,
                        &file,
                        format!(
                            "Git 命令返回异常（{}），随后状态读取也失败（{}）。请重新确认，不要直接重试。",
                            command_error, verification_error
                        ),
                    );
                }
            },
        }
    }

    let (snapshot, snapshot_error) = match read_staging_snapshot_inner(&repo_path).await {
        Ok(snapshot) => (Some(snapshot), None),
        Err(error) => (None, Some(error)),
    };
    let needs_confirmation = uncertain > 0 || snapshot_error.is_some();
    let status = if snapshot_error.is_some() || (uncertain > 0 && succeeded == 0 && failed == 0) {
        "needs_confirmation"
    } else if failed == 0 && uncertain == 0 {
        "complete"
    } else if succeeded == 0 && uncertain == 0 {
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
        mutated: succeeded > 0 || uncertain > 0,
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

#[cfg(test)]
pub async fn get_repo_staging_snapshot(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<RepoStagingSnapshot, String> {
    ensure_repo_path(&repo_path)?;
    let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
    read_staging_snapshot_inner(&repo_path).await
}

#[cfg(test)]
pub async fn stage_repo_files(
    repo_path: String,
    files: Vec<StagingTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<StagingOperationResult, String> {
    run_staging_operation("stage", repo_path, files, expected_snapshot_id, state).await
}

#[cfg(test)]
pub async fn unstage_repo_files(
    repo_path: String,
    files: Vec<StagingTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<StagingOperationResult, String> {
    run_staging_operation("unstage", repo_path, files, expected_snapshot_id, state).await
}

#[cfg(test)]
mod tests {
    use super::{
        make_snapshot_id, normalized_targets, parse_status_porcelain_z, pathspecs,
        validate_relative_path, verify_operation, RepoStagingSnapshot, StagingTarget,
    };

    fn snapshot(files: Vec<super::RepoStagingFile>) -> RepoStagingSnapshot {
        RepoStagingSnapshot {
            repo_path: "/repo".to_string(),
            branch: Some("main".to_string()),
            detached_head: false,
            head_hash: Some("abc".to_string()),
            snapshot_id: "test".to_string(),
            files_changed: files.len(),
            files_truncated: false,
            staged_files: files.iter().filter(|file| file.has_staged_changes).count(),
            unstaged_files: files
                .iter()
                .filter(|file| file.has_unstaged_changes)
                .count(),
            mixed_files: files
                .iter()
                .filter(|file| file.staging_state == "mixed")
                .count(),
            untracked_files: files.iter().filter(|file| file.is_untracked).count(),
            conflicted_files: files.iter().filter(|file| file.is_conflicted).count(),
            files,
        }
    }

    #[test]
    fn preserves_index_and_worktree_columns() {
        let files = parse_status_porcelain_z(
            " M src/unstaged.rs\0M  src/staged.rs\0MM src/mixed.rs\0?? notes.txt\0UU conflict.txt\0R  src/new.rs\0src/old.rs\0",
        );

        assert_eq!(files.len(), 6);
        assert_eq!(files[0].staging_state, "unstaged");
        assert!(files[0].can_stage);
        assert!(!files[0].can_unstage);
        assert_eq!(files[1].staging_state, "staged");
        assert!(!files[1].can_stage);
        assert!(files[1].can_unstage);
        assert_eq!(files[2].staging_state, "mixed");
        assert!(files[2].can_stage);
        assert!(files[2].can_unstage);
        assert_eq!(files[3].staging_state, "untracked");
        assert_eq!(files[4].staging_state, "conflicted");
        assert!(!files[4].can_stage);
        assert!(!files[4].can_unstage);
        assert_eq!(files[5].status, "renamed");
        assert_eq!(files[5].old_path.as_deref(), Some("src/old.rs"));
    }

    #[test]
    fn same_path_git_status_entries_keep_distinct_snapshot_ids() {
        let files = parse_status_porcelain_z("D  same.txt\0?? same.txt\0");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "same.txt");
        assert_eq!(files[1].path, "same.txt");
        assert_ne!(files[0].id, files[1].id);
        assert_ne!(files[0].index_code, files[1].index_code);
        assert_ne!(files[0].is_untracked, files[1].is_untracked);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn normalized_targets_do_not_collapse_legal_colon_composites() {
        let modified = StagingTarget {
            path: "a:b".to_string(),
            old_path: None,
            expected_index_code: "M".to_string(),
            expected_worktree_code: " ".to_string(),
        };
        let renamed = StagingTarget {
            path: "b".to_string(),
            old_path: Some(":a".to_string()),
            expected_index_code: "R".to_string(),
            expected_worktree_code: " ".to_string(),
        };
        let normalized = normalized_targets(&[modified.clone(), renamed.clone(), modified.clone()])
            .expect("normalize staging targets");

        assert_eq!(normalized, vec![modified, renamed]);
        assert_eq!(normalized.len(), 2);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn preserves_posix_git_path_identity_and_literal_pathspecs() {
        assert_eq!(validate_relative_path("a\\b.txt").unwrap(), "a\\b.txt");
        assert_eq!(validate_relative_path(" file.txt").unwrap(), " file.txt");
        assert_eq!(validate_relative_path("tail.txt ").unwrap(), "tail.txt ");
        assert_ne!(
            validate_relative_path("a\\b.txt").unwrap(),
            validate_relative_path("a/b.txt").unwrap()
        );
        assert_ne!(
            validate_relative_path(" file.txt").unwrap(),
            validate_relative_path("file.txt").unwrap()
        );

        let files = parse_status_porcelain_z(" M a\\b.txt\0 M  file.txt\0 M tail.txt \0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "a\\b.txt");
        assert_eq!(files[1].path, " file.txt");
        assert_eq!(files[2].path, "tail.txt ");
        assert_eq!(pathspecs(&files[0]), vec![":(literal)a\\b.txt"]);
        assert_eq!(pathspecs(&files[1]), vec![":(literal) file.txt"]);
    }

    #[test]
    fn verifies_a_rename_that_splits_after_unstage() {
        let original = parse_status_porcelain_z("R  src/new.rs\0src/old.rs\0")
            .into_iter()
            .next()
            .expect("rename");
        let verification = snapshot(parse_status_porcelain_z(" D src/old.rs\0?? src/new.rs\0"));

        assert!(verify_operation(&verification, &original, "unstage"));
    }

    #[test]
    fn snapshot_identity_changes_with_head_or_status() {
        let first = make_snapshot_id(Some("main"), Some("abc"), " M a.rs\0");
        let second = make_snapshot_id(Some("main"), Some("abc"), "M  a.rs\0");
        let third = make_snapshot_id(Some("main"), Some("def"), " M a.rs\0");
        assert_ne!(first, second);
        assert_ne!(first, third);
    }

    #[test]
    fn rejects_paths_that_escape_the_repository() {
        assert!(validate_relative_path("src/main.rs").is_ok());
        assert!(validate_relative_path("../outside").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(validate_relative_path(".").is_err());
        assert!(validate_relative_path("").is_err());
        assert!(validate_relative_path("bad\0path").is_err());
    }
}
