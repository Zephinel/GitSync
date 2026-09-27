use crate::commands::AppState;
use crate::repo_git_lock::acquire as acquire_repo_git_guard;
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Component, Path};
#[cfg(test)]
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::process::Command;

const GIT_META_TIMEOUT_MS: u64 = crate::git_timeouts::META;
const GIT_WORKING_SUMMARY_TIMEOUT_MS: u64 = crate::git_timeouts::WORKING_SUMMARY;
const GIT_WORKING_FILE_DIFF_TIMEOUT_MS: u64 = crate::git_timeouts::WORKING_FILE_DIFF;
#[cfg(test)]
const GIT_WORKING_OPERATION_TIMEOUT_MS: u64 = crate::git_timeouts::WORKING_OPERATION;
#[cfg(test)]
const GIT_WORKING_COMMIT_TIMEOUT_MS: u64 = crate::git_timeouts::WORKING_COMMIT;
const GIT_WORKING_FILE_DIFF_LARGE_BYTES: usize = 1_500_000;
const GIT_WORKING_FILE_DIFF_MAX_BYTES: usize = 5_000_000;
const GIT_WORKING_MAX_FILES: usize = 1_000;

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone)]
struct WorkingStatusRecord {
    path: String,
    old_path: Option<String>,
    status: String,
    index_code: String,
    worktree_code: String,
    is_untracked: bool,
    is_conflicted: bool,
}

#[derive(Debug, Clone)]
struct DiffNumstatRecord {
    path: String,
    old_path: Option<String>,
    additions: u32,
    deletions: u32,
    is_binary: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoWorkingChangeFile {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub index_code: String,
    pub worktree_code: String,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    pub is_too_large: bool,
    pub is_untracked: bool,
    pub is_conflicted: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoWorkingChangesSummary {
    pub repo_path: String,
    pub hash: String,
    pub full_hash: String,
    pub snapshot_id: String,
    pub files_changed: usize,
    pub insertions: u32,
    pub deletions: u32,
    pub files: Vec<RepoWorkingChangeFile>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoWorkingFileDiff {
    pub hash: String,
    pub full_hash: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    pub is_too_large: bool,
    pub truncated: bool,
    pub patch: String,
}

#[cfg(test)]
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct WorkingChangeTarget {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub expected_index_code: String,
    pub expected_worktree_code: String,
    pub expected_is_untracked: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkingChangesOperationResult {
    pub affected_count: usize,
    pub commit_hash: Option<String>,
    pub message: String,
}

fn ensure_repo_path(path: &str) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("仓库路径不能为空".to_string());
    }
    let repo_path = Path::new(normalized);
    if !repo_path.is_dir() {
        return Err(format!("仓库目录不存在: {}", normalized));
    }
    Ok(())
}

fn new_git_command(repo_path: &str, args: &[&str], envs: &[(String, String)]) -> Command {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    configure_git_output(&mut command);
    for (key, value) in envs {
        command.env(key, value);
    }
    command
}

fn configure_git_output(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
}

#[cfg(test)]
fn new_git_mutation_command(
    repo_path: &str,
    args: &[&str],
    envs: &[(String, String)],
) -> Command {
    let mut command = crate::git_command::new_mutation_async_command(repo_path, args);
    configure_git_output(&mut command);
    for (key, value) in envs {
        command.env(key, value);
    }
    command
}

async fn run_git_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
    envs: &[(String, String)],
) -> Result<GitCommandOutput, String> {
    let mut command = new_git_command(repo_path, args, envs);
    run_git_output_from_command(&mut command, args, timeout_ms).await
}

#[cfg(test)]
async fn run_git_mutation_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
    envs: &[(String, String)],
) -> Result<GitCommandOutput, String> {
    let mut command = new_git_mutation_command(repo_path, args, envs);
    run_git_output_from_command(&mut command, args, timeout_ms).await
}

async fn run_git_output_from_command(
    command: &mut Command,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("Git 命令执行超时: git {}", args.join(" ")))?
        .map_err(|error| format!("无法执行 Git 命令: {}", error))?;
    let stdout = crate::git_encoding::decode_git_stdout(output.stdout, "Working Changes Git stdout")?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
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
    run_git_with_env(repo_path, args, timeout_ms, &[]).await
}

async fn run_git_with_env(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
    envs: &[(String, String)],
) -> Result<String, String> {
    let output = run_git_output(repo_path, args, timeout_ms, envs).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(git_failure(args, output))
    }
}

#[cfg(test)]
async fn run_git_mutation_with_env(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
    envs: &[(String, String)],
) -> Result<String, String> {
    let output = run_git_mutation_output(repo_path, args, timeout_ms, envs).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(git_failure(args, output))
    }
}

#[cfg(test)]
async fn run_git_mutation(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    run_git_mutation_with_env(repo_path, args, timeout_ms, &[]).await
}

async fn git_succeeds(repo_path: &str, args: &[&str]) -> bool {
    run_git_output(repo_path, args, GIT_META_TIMEOUT_MS, &[])
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

fn normalize_working_status(code: &str) -> String {
    if code == "??" {
        return "added".to_string();
    }
    if is_conflict_code(code) {
        return "unmerged".to_string();
    }
    if code.contains('R') {
        return "renamed".to_string();
    }
    if code.contains('C') {
        return "copied".to_string();
    }
    if code.contains('A') {
        return "added".to_string();
    }
    if code.contains('D') {
        return "deleted".to_string();
    }
    if code.contains('T') {
        return "typechange".to_string();
    }
    if code.contains('M') {
        return "modified".to_string();
    }
    "unknown".to_string()
}

fn parse_status_porcelain_z(output: &str) -> Vec<WorkingStatusRecord> {
    let fields = split_z(output);
    let mut records = Vec::new();
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
        let rename_or_copy = code.contains('R') || code.contains('C');
        let old_path = if rename_or_copy && index < fields.len() {
            let value = fields[index].clone();
            index += 1;
            (!value.is_empty()).then_some(value)
        } else {
            None
        };
        records.push(WorkingStatusRecord {
            path,
            old_path,
            status: normalize_working_status(code),
            index_code: index_code.to_string(),
            worktree_code: worktree_code.to_string(),
            is_untracked: code == "??",
            is_conflicted: is_conflict_code(code),
        });
    }

    records
}

fn parse_count_field(value: &str) -> (u32, bool) {
    let value = value.trim();
    if value == "-" {
        return (0, true);
    }
    (value.parse::<u32>().unwrap_or(0), false)
}

fn looks_like_numstat_field(value: &str) -> bool {
    let mut parts = value.splitn(3, '\t');
    let additions = parts.next().unwrap_or_default();
    let deletions = parts.next().unwrap_or_default();
    if additions.is_empty() || deletions.is_empty() {
        return false;
    }
    let valid = |item: &str| item == "-" || item.parse::<u32>().is_ok();
    valid(additions) && valid(deletions)
}

fn parse_numstat_z(output: &str) -> Vec<DiffNumstatRecord> {
    let fields = split_z(output);
    let mut records = Vec::new();
    let mut index = 0usize;

    while index < fields.len() {
        let stat_field = fields[index].clone();
        index += 1;
        let mut parts = stat_field.splitn(3, '\t');
        let additions_text = parts.next().unwrap_or_default();
        let deletions_text = parts.next().unwrap_or_default();
        let path_field = parts.next().unwrap_or_default();
        let (additions, additions_binary) = parse_count_field(additions_text);
        let (deletions, deletions_binary) = parse_count_field(deletions_text);
        let is_binary = additions_binary || deletions_binary;

        if path_field.is_empty() {
            if index + 1 >= fields.len()
                || looks_like_numstat_field(&fields[index])
                || looks_like_numstat_field(&fields[index + 1])
            {
                continue;
            }
            let old_path = fields[index].clone();
            let path = fields[index + 1].clone();
            index += 2;
            records.push(DiffNumstatRecord {
                path,
                old_path: Some(old_path),
                additions,
                deletions,
                is_binary,
            });
        } else {
            records.push(DiffNumstatRecord {
                path: path_field.to_string(),
                old_path: None,
                additions,
                deletions,
                is_binary,
            });
        }
    }

    records
}

fn make_file_id(record: &WorkingStatusRecord) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}",
        record.index_code,
        record.worktree_code,
        record.old_path.as_deref().unwrap_or_default(),
        record.path,
        record.is_untracked
    )
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

async fn inspect_untracked_file(repo_path: &str, relative_path: &str) -> (u32, bool, bool) {
    let absolute_path = Path::new(repo_path).join(relative_path);
    let metadata = match tokio::fs::symlink_metadata(&absolute_path).await {
        Ok(metadata) => metadata,
        Err(_) => return (0, false, false),
    };
    if metadata.file_type().is_symlink() {
        return (1, false, false);
    }
    if !metadata.is_file() {
        return (0, false, false);
    }
    let is_too_large = metadata.len() as usize > GIT_WORKING_FILE_DIFF_LARGE_BYTES;
    let bytes = match tokio::fs::read(&absolute_path).await {
        Ok(bytes) => bytes,
        Err(_) => return (0, false, is_too_large),
    };
    let is_binary = bytes.iter().any(|byte| *byte == 0);
    if is_binary {
        return (0, true, is_too_large);
    }
    let additions = if bytes.is_empty() {
        0
    } else {
        bytes.iter().filter(|byte| **byte == b'\n').count() as u32
            + u32::from(bytes.last().copied() != Some(b'\n'))
    };
    (additions, false, is_too_large)
}

async fn read_head_hash(repo_path: &str) -> String {
    run_git(
        repo_path,
        &["rev-parse", "--verify", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .unwrap_or_default()
    .trim()
    .to_string()
}

fn make_working_snapshot_id(head_hash: &str, status_output: &str) -> String {
    let mut hasher = DefaultHasher::new();
    head_hash.hash(&mut hasher);
    status_output.hash(&mut hasher);
    format!("working-v1-{:016x}", hasher.finish())
}

async fn read_working_summary_inner(repo_path: &str) -> Result<RepoWorkingChangesSummary, String> {
    let status_output = run_git(
        repo_path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--untracked-files=all",
        ],
        GIT_WORKING_SUMMARY_TIMEOUT_MS,
    )
    .await?;
    let status_records = parse_status_porcelain_z(&status_output);
    let head_hash = read_head_hash(repo_path).await;
    let snapshot_id = make_working_snapshot_id(&head_hash, &status_output);
    let has_head = !head_hash.is_empty();
    let numstat_output = if has_head {
        run_git(
            repo_path,
            &[
                "diff",
                "--numstat",
                "-z",
                "--find-renames",
                "--find-copies",
                "HEAD",
                "--",
            ],
            GIT_WORKING_SUMMARY_TIMEOUT_MS,
        )
        .await?
    } else {
        run_git(
            repo_path,
            &[
                "diff",
                "--cached",
                "--numstat",
                "-z",
                "--find-renames",
                "--find-copies",
                "--",
            ],
            GIT_WORKING_SUMMARY_TIMEOUT_MS,
        )
        .await?
    };
    let numstat_records = parse_numstat_z(&numstat_output);
    let mut files = Vec::new();

    for status_record in status_records {
        let matched = numstat_records.iter().find(|stat| {
            stat.path == status_record.path
                || stat.old_path.as_deref() == Some(status_record.path.as_str())
                || status_record.old_path.as_deref() == Some(stat.path.as_str())
        });
        let (additions, deletions, is_binary, is_too_large) = if status_record.is_untracked {
            let (additions, is_binary, is_too_large) =
                inspect_untracked_file(repo_path, &status_record.path).await;
            (additions, 0, is_binary, is_too_large)
        } else {
            (
                matched.map(|stat| stat.additions).unwrap_or(0),
                matched.map(|stat| stat.deletions).unwrap_or(0),
                matched.map(|stat| stat.is_binary).unwrap_or(false),
                false,
            )
        };
        let id = make_file_id(&status_record);
        files.push(RepoWorkingChangeFile {
            id,
            path: status_record.path,
            old_path: status_record.old_path,
            status: status_record.status,
            index_code: status_record.index_code,
            worktree_code: status_record.worktree_code,
            additions,
            deletions,
            is_binary,
            is_too_large,
            is_untracked: status_record.is_untracked,
            is_conflicted: status_record.is_conflicted,
        });
    }

    if files.len() > GIT_WORKING_MAX_FILES {
        files.truncate(GIT_WORKING_MAX_FILES);
    }
    let insertions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();

    Ok(RepoWorkingChangesSummary {
        repo_path: repo_path.to_string(),
        hash: "WORKTREE".to_string(),
        full_hash: head_hash,
        snapshot_id,
        files_changed: files.len(),
        insertions,
        deletions,
        files,
    })
}

#[cfg(test)]
fn normalize_target(target: &WorkingChangeTarget) -> Result<WorkingChangeTarget, String> {
    let path = validate_relative_path(&target.path)?;
    let old_path = target
        .old_path
        .as_deref()
        .map(validate_relative_path)
        .transpose()?;
    if target.expected_index_code.chars().count() != 1
        || target.expected_worktree_code.chars().count() != 1
    {
        return Err(format!("Working Changes 文件状态 identity 无效: {}", path));
    }
    Ok(WorkingChangeTarget {
        path,
        old_path,
        expected_index_code: target.expected_index_code.clone(),
        expected_worktree_code: target.expected_worktree_code.clone(),
        expected_is_untracked: target.expected_is_untracked,
    })
}

#[cfg(test)]
fn normalize_targets(targets: &[WorkingChangeTarget]) -> Result<Vec<WorkingChangeTarget>, String> {
    if targets.is_empty() {
        return Err("请至少选择一个文件".to_string());
    }
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        let target = normalize_target(target)?;
        if seen.insert(target.clone()) {
            normalized.push(target);
        }
    }
    Ok(normalized)
}

#[cfg(test)]
fn target_matches_file(target: &WorkingChangeTarget, file: &RepoWorkingChangeFile) -> bool {
    file.path == target.path
        && file.old_path == target.old_path
        && file.index_code == target.expected_index_code
        && file.worktree_code == target.expected_worktree_code
        && file.is_untracked == target.expected_is_untracked
}

fn files_share_identity_path(left: &RepoWorkingChangeFile, right: &RepoWorkingChangeFile) -> bool {
    let left_paths = [Some(left.path.as_str()), left.old_path.as_deref()];
    let right_paths = [Some(right.path.as_str()), right.old_path.as_deref()];
    left_paths.into_iter().flatten().any(|left_path| {
        right_paths
            .into_iter()
            .flatten()
            .any(|right_path| left_path == right_path)
    })
}

#[cfg(test)]
fn find_requested_files(
    current_files: &[RepoWorkingChangeFile],
    targets: &[WorkingChangeTarget],
) -> Result<Vec<RepoWorkingChangeFile>, String> {
    let targets = normalize_targets(targets)?;
    let mut selected = Vec::with_capacity(targets.len());

    for target in &targets {
        let matches = current_files
            .iter()
            .filter(|file| target_matches_file(target, file))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(format!(
                "文件状态 identity 已变化，请刷新后重试: {}",
                target.path
            ));
        }
        let file = matches[0];
        if current_files
            .iter()
            .any(|candidate| candidate.id != file.id && files_share_identity_path(candidate, file))
        {
            return Err(format!(
                "同一路径同时存在多个 Git status identity，Commit / Discard 不会猜测目标；请先用 Stage / Unstage 消解状态后刷新: {}",
                file.path
            ));
        }
        selected.push(file.clone());
    }

    Ok(selected)
}

fn ensure_expected_snapshot(
    summary: &RepoWorkingChangesSummary,
    expected_snapshot_id: &str,
) -> Result<(), String> {
    if expected_snapshot_id.is_empty() {
        return Err("缺少 Working Changes 快照，请刷新后重试。".to_string());
    }
    if summary.snapshot_id != expected_snapshot_id {
        return Err("仓库状态已经变化，本次操作未开始，请刷新后重新确认。".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn selected_scope_still_dirty(
    summary: &RepoWorkingChangesSummary,
    selected: &[RepoWorkingChangeFile],
) -> bool {
    selected.iter().any(|selected_file| {
        summary
            .files
            .iter()
            .any(|candidate| files_share_identity_path(candidate, selected_file))
    })
}

#[cfg(test)]
async fn verify_selected_scope_clean(
    repo_path: &str,
    selected: &[RepoWorkingChangeFile],
    operation: &str,
) -> Result<(), String> {
    let summary = read_working_summary_inner(repo_path).await.map_err(|error| {
        format!(
            "{} 可能已经执行，但操作后仓库状态读取失败：{}。请刷新确认，不要直接重试。",
            operation, error
        )
    })?;
    if selected_scope_still_dirty(&summary, selected) {
        return Err(format!(
            "{} 已返回，但所选文件范围仍存在改动；请刷新确认，不要直接重试。",
            operation
        ));
    }
    Ok(())
}

fn normalize_patch_for_response(patch: String) -> (String, bool, bool) {
    let bytes = patch.len();
    if bytes > GIT_WORKING_FILE_DIFF_MAX_BYTES {
        return (String::new(), true, true);
    }
    if bytes > GIT_WORKING_FILE_DIFF_LARGE_BYTES {
        return (patch, true, false);
    }
    (patch, false, false)
}

fn synthetic_untracked_patch(path: &str, contents: &str) -> String {
    let line_count = if contents.is_empty() {
        0
    } else {
        contents.lines().count().max(1)
    };
    let mut patch = format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n",
        path, line_count
    );
    for line in contents.split_inclusive('\n') {
        patch.push('+');
        patch.push_str(line);
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        patch.push('\n');
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

#[cfg(test)]
async fn read_tracked_patch(
    repo_path: &str,
    file: &RepoWorkingChangeFile,
) -> Result<String, String> {
    let has_head = git_succeeds(repo_path, &["rev-parse", "--verify", "HEAD"]).await;
    let mut args = if has_head {
        vec![
            "diff".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--unified=3".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            literal_pathspec(&file.path),
        ]
    } else {
        vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--unified=3".to_string(),
            "--".to_string(),
            literal_pathspec(&file.path),
        ]
    };
    if let Some(old_path) = file.old_path.as_ref() {
        if old_path != &file.path {
            args.push(literal_pathspec(old_path));
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo_path, &refs, GIT_WORKING_FILE_DIFF_TIMEOUT_MS).await
}

#[cfg(test)]
async fn path_exists_in_head(repo_path: &str, path: &str) -> bool {
    let object = format!("HEAD:{}", path);
    git_succeeds(repo_path, &["cat-file", "-e", object.as_str()]).await
}

#[cfg(test)]
async fn remove_added_path(repo_path: &str, path: &str) -> Result<(), String> {
    let pathspec = literal_pathspec(path);
    run_git_mutation(
        repo_path,
        &[
            "rm",
            "-f",
            "--cached",
            "--ignore-unmatch",
            "--",
            pathspec.as_str(),
        ],
        GIT_WORKING_OPERATION_TIMEOUT_MS,
    )
    .await?;
    run_git_mutation(
        repo_path,
        &["clean", "-f", "--", pathspec.as_str()],
        GIT_WORKING_OPERATION_TIMEOUT_MS,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
async fn discard_file(repo_path: &str, file: &RepoWorkingChangeFile) -> Result<(), String> {
    if file.is_untracked {
        let pathspec = literal_pathspec(&file.path);
        return run_git_mutation(
            repo_path,
            &["clean", "-f", "--", pathspec.as_str()],
            GIT_WORKING_OPERATION_TIMEOUT_MS,
        )
        .await
        .map(|_| ());
    }

    let has_head = git_succeeds(repo_path, &["rev-parse", "--verify", "HEAD"]).await;
    if !has_head {
        return remove_added_path(repo_path, &file.path).await;
    }

    let path_in_head = path_exists_in_head(repo_path, &file.path).await;
    let old_path_in_head = match file.old_path.as_deref() {
        Some(old_path) => path_exists_in_head(repo_path, old_path).await,
        None => false,
    };

    let mut restore_paths = Vec::new();
    if path_in_head {
        restore_paths.push(literal_pathspec(&file.path));
    }
    if old_path_in_head {
        if let Some(old_path) = file.old_path.as_ref() {
            restore_paths.push(literal_pathspec(old_path));
        }
    }
    if !restore_paths.is_empty() {
        let mut args = vec![
            "restore".to_string(),
            "--source=HEAD".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend(restore_paths);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git_mutation(repo_path, &refs, GIT_WORKING_OPERATION_TIMEOUT_MS).await?;
    }
    if !path_in_head {
        remove_added_path(repo_path, &file.path).await?;
    }
    Ok(())
}

#[cfg(test)]
fn collect_pathspecs(files: &[RepoWorkingChangeFile]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for file in files {
        if seen.insert(file.path.clone()) {
            paths.push(literal_pathspec(&file.path));
        }
        if let Some(old_path) = file.old_path.as_ref() {
            if seen.insert(old_path.clone()) {
                paths.push(literal_pathspec(old_path));
            }
        }
    }
    paths
}

#[cfg(test)]
async fn resolve_git_dir(repo_path: &str) -> Result<PathBuf, String> {
    let output = run_git(repo_path, &["rev-parse", "--git-dir"], GIT_META_TIMEOUT_MS).await?;
    let value = output.trim();
    if value.is_empty() {
        return Err("无法读取 Git 目录".to_string());
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        Path::new(repo_path).join(path)
    })
}

#[cfg(test)]
async fn commit_selected_files(
    repo_path: &str,
    files: &[RepoWorkingChangeFile],
    message: &str,
) -> Result<String, String> {
    if files.iter().any(|file| file.is_conflicted) {
        return Err("所选文件包含未解决冲突，请先解决冲突后再提交。".to_string());
    }
    let pathspecs = collect_pathspecs(files);
    if pathspecs.is_empty() {
        return Err("没有可提交的文件".to_string());
    }

    let git_dir = resolve_git_dir(repo_path).await?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_index = git_dir.join(format!("gitsync-index-{}-{}", std::process::id(), nonce));
    let temp_lock = PathBuf::from(format!("{}.lock", temp_index.to_string_lossy()));
    let envs = vec![(
        "GIT_INDEX_FILE".to_string(),
        temp_index.to_string_lossy().to_string(),
    )];

    let operation = async {
        if git_succeeds(repo_path, &["rev-parse", "--verify", "HEAD"]).await {
            run_git_mutation_with_env(
                repo_path,
                &["read-tree", "HEAD"],
                GIT_META_TIMEOUT_MS,
                &envs,
            )
            .await?;
        } else {
            run_git_mutation_with_env(
                repo_path,
                &["read-tree", "--empty"],
                GIT_META_TIMEOUT_MS,
                &envs,
            )
            .await?;
        }

        let mut add_args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
        add_args.extend(pathspecs.iter().cloned());
        let add_refs: Vec<&str> = add_args.iter().map(String::as_str).collect();
        run_git_mutation_with_env(
            repo_path,
            &add_refs,
            GIT_WORKING_OPERATION_TIMEOUT_MS,
            &envs,
        )
        .await?;

        let staged = run_git_with_env(
            repo_path,
            &["diff", "--cached", "--name-only", "--"],
            GIT_META_TIMEOUT_MS,
            &envs,
        )
        .await?;
        if staged.trim().is_empty() {
            return Err("所选文件没有可提交的改动".to_string());
        }

        run_git_mutation_with_env(
            repo_path,
            &["-c", "commit.gpgSign=false", "commit", "-m", message],
            GIT_WORKING_COMMIT_TIMEOUT_MS,
            &envs,
        )
        .await?;

        let hash = run_git(
            repo_path,
            &["rev-parse", "--verify", "HEAD"],
            GIT_META_TIMEOUT_MS,
        )
        .await?
        .trim()
        .to_string();

        let mut reset_args = vec![
            "reset".to_string(),
            "-q".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
        ];
        reset_args.extend(pathspecs.iter().cloned());
        let reset_refs: Vec<&str> = reset_args.iter().map(String::as_str).collect();
        run_git_mutation(repo_path, &reset_refs, GIT_WORKING_OPERATION_TIMEOUT_MS).await?;
        Ok(hash)
    }
    .await;

    let _ = tokio::fs::remove_file(&temp_index).await;
    let _ = tokio::fs::remove_file(&temp_lock).await;
    operation
}

#[cfg(test)]
pub async fn get_repo_working_diff_summary(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<RepoWorkingChangesSummary, String> {
    ensure_repo_path(&repo_path)?;
    let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
    read_working_summary_inner(&repo_path).await
}

#[cfg(test)]
pub async fn get_repo_working_file_diff(
    repo_path: String,
    path: String,
    old_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoWorkingFileDiff, String> {
    ensure_repo_path(&repo_path)?;
    let normalized_path = validate_relative_path(&path)?;
    let normalized_old_path = old_path
        .as_deref()
        .map(validate_relative_path)
        .transpose()?;
    let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
    let summary = read_working_summary_inner(&repo_path).await?;
    let matches = summary
        .files
        .iter()
        .filter(|file| {
            file.path == normalized_path
                && normalized_old_path
                    .as_deref()
                    .map_or(file.old_path.is_none(), |value| file.old_path.as_deref() == Some(value))
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(format!(
            "文件 Diff identity 已变化或同一路径存在多个 Git status identity，请刷新后重试: {}",
            normalized_path
        ));
    }
    let file = matches[0].clone();

    if file.is_binary {
        return Ok(RepoWorkingFileDiff {
            hash: summary.hash,
            full_hash: summary.full_hash,
            path: file.path,
            old_path: file.old_path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            is_binary: true,
            is_too_large: file.is_too_large,
            truncated: false,
            patch: String::new(),
        });
    }

    let patch = if file.is_untracked {
        let absolute_path = Path::new(&repo_path).join(&file.path);
        let contents = tokio::fs::read_to_string(&absolute_path)
            .await
            .map_err(|error| format!("读取未跟踪文件失败: {}", error))?;
        synthetic_untracked_patch(&file.path, &contents)
    } else {
        read_tracked_patch(&repo_path, &file).await?
    };
    let (patch, is_too_large, truncated) = normalize_patch_for_response(patch);

    Ok(RepoWorkingFileDiff {
        hash: summary.hash,
        full_hash: summary.full_hash,
        path: file.path,
        old_path: file.old_path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        is_binary: false,
        is_too_large,
        truncated,
        patch,
    })
}

#[cfg(test)]
pub async fn discard_repo_working_files(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
    ensure_repo_path(&repo_path)?;
    let _guard = acquire_repo_git_guard(&state, &repo_path).await?;
    let summary = read_working_summary_inner(&repo_path).await?;
    ensure_expected_snapshot(&summary, &expected_snapshot_id)?;
    let selected = find_requested_files(&summary.files, &files)?;
    for file in &selected {
        discard_file(&repo_path, file).await?;
    }
    verify_selected_scope_clean(&repo_path, &selected, "Discard").await?;
    Ok(WorkingChangesOperationResult {
        affected_count: selected.len(),
        commit_hash: None,
        message: format!("已丢弃 {} 个文件的改动。", selected.len()),
    })
}

#[cfg(test)]
pub async fn commit_repo_working_files(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
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
    let summary = read_working_summary_inner(&repo_path).await?;
    ensure_expected_snapshot(&summary, &expected_snapshot_id)?;
    let selected = find_requested_files(&summary.files, &files)?;
    let hash = commit_selected_files(&repo_path, &selected, &message).await?;
    verify_selected_scope_clean(&repo_path, &selected, "Commit").await?;
    Ok(WorkingChangesOperationResult {
        affected_count: selected.len(),
        commit_hash: Some(hash.clone()),
        message: format!(
            "已提交 {} 个文件：{}",
            selected.len(),
            hash.chars().take(7).collect::<String>()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        collect_pathspecs, find_requested_files, make_working_snapshot_id, normalize_targets,
        normalize_working_status, parse_status_porcelain_z, synthetic_untracked_patch,
        validate_relative_path, RepoWorkingChangeFile, WorkingChangeTarget,
    };

    fn working_file(
        id: &str,
        path: &str,
        old_path: Option<&str>,
        index_code: &str,
        worktree_code: &str,
        is_untracked: bool,
    ) -> RepoWorkingChangeFile {
        RepoWorkingChangeFile {
            id: id.to_string(),
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            status: if is_untracked { "added" } else { "modified" }.to_string(),
            index_code: index_code.to_string(),
            worktree_code: worktree_code.to_string(),
            additions: 0,
            deletions: 0,
            is_binary: false,
            is_too_large: false,
            is_untracked,
            is_conflicted: false,
        }
    }

    fn target(
        path: &str,
        old_path: Option<&str>,
        index_code: &str,
        worktree_code: &str,
        is_untracked: bool,
    ) -> WorkingChangeTarget {
        WorkingChangeTarget {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            expected_index_code: index_code.to_string(),
            expected_worktree_code: worktree_code.to_string(),
            expected_is_untracked: is_untracked,
        }
    }

    #[test]
    fn parses_porcelain_records_including_rename_untracked_and_xy_identity() {
        let records = parse_status_porcelain_z(
            " M src/a.rs\0R  src/new.rs\0src/old.rs\0?? notes.txt\0",
        );
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].status, "modified");
        assert_eq!(records[0].index_code, " ");
        assert_eq!(records[0].worktree_code, "M");
        assert_eq!(records[1].status, "renamed");
        assert_eq!(records[1].path, "src/new.rs");
        assert_eq!(records[1].old_path.as_deref(), Some("src/old.rs"));
        assert!(records[2].is_untracked);
        assert_eq!(records[2].index_code, "?");
        assert_eq!(records[2].worktree_code, "?");
    }

    #[test]
    fn same_path_status_identities_are_not_guessable_for_destructive_mutations() {
        let current = vec![
            working_file("deleted", "same.txt", None, "D", " ", false),
            working_file("untracked", "same.txt", None, "?", "?", true),
        ];
        let deleted = target("same.txt", None, "D", " ", false);
        let untracked = target("same.txt", None, "?", "?", true);

        assert!(find_requested_files(&current, &[deleted]).unwrap_err().contains("多个 Git status identity"));
        assert!(find_requested_files(&current, &[untracked]).unwrap_err().contains("多个 Git status identity"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn structured_targets_and_literal_pathspecs_preserve_posix_identity() {
        let first = target("a:b", None, "M", " ", false);
        let second = target("b", Some(":a"), "R", " ", false);
        let normalized = normalize_targets(&[first.clone(), second.clone(), first.clone()]).unwrap();
        assert_eq!(normalized, vec![first, second]);

        assert_eq!(validate_relative_path("a\\b.txt").unwrap(), "a\\b.txt");
        assert_eq!(validate_relative_path(" file.txt").unwrap(), " file.txt");
        let special = working_file(
            "special",
            ":(glob)*.txt",
            None,
            " ",
            "M",
            false,
        );
        assert_eq!(collect_pathspecs(&[special]), vec![":(literal):(glob)*.txt"]);
    }

    #[test]
    fn snapshot_identity_changes_with_head_or_raw_status() {
        let first = make_working_snapshot_id("abc", " M a.txt\0");
        let second = make_working_snapshot_id("abc", "M  a.txt\0");
        let third = make_working_snapshot_id("def", " M a.txt\0");
        assert_ne!(first, second);
        assert_ne!(first, third);
    }

    #[test]
    fn detects_conflicts_and_rejects_escaping_paths() {
        assert_eq!(normalize_working_status("UU"), "unmerged");
        assert!(validate_relative_path("src/main.rs").is_ok());
        assert!(validate_relative_path("../outside").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(validate_relative_path(".").is_err());
        assert!(validate_relative_path("bad\0path").is_err());
    }

    #[test]
    fn builds_a_renderable_patch_for_untracked_text() {
        let patch = synthetic_untracked_patch("notes.txt", "one\ntwo\n");
        assert!(patch.contains("--- /dev/null"));
        assert!(patch.contains("+++ b/notes.txt"));
        assert!(patch.contains("+one"));
        assert!(patch.contains("+two"));
    }
}
