use crate::commands::AppState;
use crate::repo_git_lock::acquire_read as acquire_repo_git_read_guard;
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;

const GIT_META_TIMEOUT_MS: u64 = crate::git_timeouts::META;
const GIT_COMMIT_DIFF_SUMMARY_TIMEOUT_MS: u64 = crate::git_timeouts::COMMIT_DIFF_SUMMARY;
const GIT_COMMIT_FILE_DIFF_TIMEOUT_MS: u64 = crate::git_timeouts::COMMIT_FILE_DIFF;
const GIT_COMMIT_FILE_DIFF_LARGE_BYTES: usize = 1_500_000;
const GIT_COMMIT_FILE_DIFF_MAX_BYTES: usize = 5_000_000;
const GIT_COMMIT_DIFF_MAX_FILES: usize = 1_000;

#[derive(Debug, Serialize, Clone)]
pub struct RepoCommitDiffSummary {
    pub repo_path: String,
    pub hash: String,
    pub full_hash: String,
    pub parent_hashes: Vec<String>,
    pub is_root: bool,
    pub is_merge: bool,
    pub files_changed: usize,
    pub insertions: u32,
    pub deletions: u32,
    pub files: Vec<RepoCommitDiffFile>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoCommitDiffFile {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    pub is_too_large: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoCommitFileDiff {
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

#[derive(Debug, Clone)]
struct DiffNameStatusRecord {
    status_code: String,
    path: String,
    old_path: Option<String>,
}

#[derive(Debug, Clone)]
struct DiffNumstatRecord {
    path: String,
    old_path: Option<String>,
    additions: u32,
    deletions: u32,
    is_binary: bool,
}

fn new_git_async_command(repo_path: &str, args: &[&str]) -> tokio::process::Command {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    command.stdin(Stdio::null()).kill_on_drop(true);
    command
}

async fn run_git_async_with_timeout(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    let mut command = new_git_async_command(repo_path, args);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| {
            format!(
                "{}git {}",
                crate::git_timeouts::TIMEOUT_ERROR_PREFIX,
                args.join(" ")
            )
        })?
        .map_err(|e| format!("{}{}", crate::git_timeouts::SPAWN_ERROR_PREFIX, e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format_git_failure_error(
            args,
            output.status.code(),
            &stderr,
        ))
    }
}

fn format_git_failure_error(args: &[&str], exit_code: Option<i32>, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        format!("git {} 退出失败，退出码: {:?}", args.join(" "), exit_code)
    } else {
        trimmed.to_string()
    }
}

fn ensure_repo_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err("目录不存在".to_string());
    }
    if !p.is_dir() {
        return Err("目标路径不是目录".to_string());
    }
    Ok(())
}

fn split_z(output: &str) -> Vec<String> {
    output
        .split('\0')
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn normalize_diff_status(status_code: &str) -> String {
    match status_code.chars().next().unwrap_or('?') {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "unmerged",
        _ => "unknown",
    }
    .to_string()
}

fn looks_like_name_status_code(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    match trimmed.chars().next().unwrap_or('?') {
        'M' | 'A' | 'D' | 'T' | 'U' => trimmed.len() == 1,
        'R' | 'C' => trimmed[1..].chars().all(|ch| ch.is_ascii_digit()),
        _ => false,
    }
}

fn parse_name_status_z(output: &str) -> Vec<DiffNameStatusRecord> {
    let fields = split_z(output);
    let mut records = Vec::new();
    let mut index = 0usize;

    while index < fields.len() {
        let status_code = fields[index].trim().to_string();
        index += 1;
        if status_code.is_empty() {
            continue;
        }

        let status_kind = status_code.chars().next().unwrap_or('?');
        if status_kind == 'R' || status_kind == 'C' {
            if index + 1 >= fields.len() {
                tracing::warn!(
                    status_code = %status_code,
                    "跳过截断的 git name-status rename/copy 记录"
                );
                continue;
            }
            if looks_like_name_status_code(&fields[index]) {
                tracing::warn!(
                    status_code = %status_code,
                    next_status = %fields[index],
                    "跳过缺少路径的 git name-status rename/copy 记录"
                );
                continue;
            }
            if looks_like_name_status_code(&fields[index + 1]) {
                tracing::warn!(
                    status_code = %status_code,
                    next_status = %fields[index + 1],
                    "跳过缺少新路径的 git name-status rename/copy 记录"
                );
                index += 1;
                continue;
            }
            let old_path = fields[index].clone();
            let path = fields[index + 1].clone();
            index += 2;
            records.push(DiffNameStatusRecord {
                status_code,
                path,
                old_path: Some(old_path),
            });
        } else {
            if index >= fields.len() {
                tracing::warn!(
                    status_code = %status_code,
                    "跳过截断的 git name-status 记录"
                );
                continue;
            }
            if looks_like_name_status_code(&fields[index]) {
                tracing::warn!(
                    status_code = %status_code,
                    next_status = %fields[index],
                    "跳过缺少路径的 git name-status 记录"
                );
                continue;
            }
            let path = fields[index].clone();
            index += 1;
            records.push(DiffNameStatusRecord {
                status_code,
                path,
                old_path: None,
            });
        }
    }

    records
}

fn parse_count_field(value: &str) -> (u32, bool) {
    let trimmed = value.trim();
    if trimmed == "-" {
        return (0, true);
    }
    (trimmed.parse::<u32>().unwrap_or(0), false)
}

fn looks_like_numstat_field(value: &str) -> bool {
    let mut parts = value.splitn(3, '\t');
    let additions = parts.next().unwrap_or_default();
    let deletions = parts.next().unwrap_or_default();
    if additions.is_empty() || deletions.is_empty() {
        return false;
    }

    let count_is_valid = |count: &str| count == "-" || count.parse::<u32>().is_ok();
    count_is_valid(additions) && count_is_valid(deletions)
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
        if additions_text.is_empty() && deletions_text.is_empty() && path_field.is_empty() {
            continue;
        }

        let (additions, additions_binary) = parse_count_field(additions_text);
        let (deletions, deletions_binary) = parse_count_field(deletions_text);
        let is_binary = additions_binary || deletions_binary;

        if path_field.is_empty() {
            if index + 1 >= fields.len() {
                tracing::warn!(
                    stat_field = %stat_field,
                    "跳过截断的 git numstat rename/copy 记录"
                );
                continue;
            }
            if looks_like_numstat_field(&fields[index]) {
                tracing::warn!(
                    stat_field = %stat_field,
                    next_stat = %fields[index],
                    "跳过缺少路径的 git numstat rename/copy 记录"
                );
                continue;
            }
            if looks_like_numstat_field(&fields[index + 1]) {
                tracing::warn!(
                    stat_field = %stat_field,
                    next_stat = %fields[index + 1],
                    "跳过缺少新路径的 git numstat rename/copy 记录"
                );
                index += 1;
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

fn make_file_id(status: &str, old_path: Option<&str>, path: &str) -> String {
    format!("{}:{}:{}", status, old_path.unwrap_or_default(), path)
}

fn count_record_matches_status(stat: &DiffNumstatRecord, status: &DiffNameStatusRecord) -> bool {
    stat.path == status.path && stat.old_path == status.old_path
}

fn build_diff_files(name_status_output: &str, numstat_output: &str) -> Vec<RepoCommitDiffFile> {
    let status_records = parse_name_status_z(name_status_output);
    let stat_records = parse_numstat_z(numstat_output);
    let mut files = Vec::new();

    if !status_records.is_empty() {
        for (index, status_record) in status_records.iter().enumerate() {
            let matched_stat = stat_records
                .get(index)
                .filter(|stat| count_record_matches_status(stat, status_record))
                .or_else(|| {
                    stat_records
                        .iter()
                        .find(|stat| count_record_matches_status(stat, status_record))
                });
            let status = normalize_diff_status(&status_record.status_code);
            let additions = matched_stat.map(|stat| stat.additions).unwrap_or(0);
            let deletions = matched_stat.map(|stat| stat.deletions).unwrap_or(0);
            let is_binary = matched_stat.map(|stat| stat.is_binary).unwrap_or(false);
            files.push(RepoCommitDiffFile {
                id: make_file_id(
                    &status,
                    status_record.old_path.as_deref(),
                    &status_record.path,
                ),
                path: status_record.path.clone(),
                old_path: status_record.old_path.clone(),
                status,
                additions,
                deletions,
                is_binary,
                is_too_large: false,
            });
        }
    } else {
        for stat_record in stat_records {
            let status = "unknown".to_string();
            files.push(RepoCommitDiffFile {
                id: make_file_id(&status, stat_record.old_path.as_deref(), &stat_record.path),
                path: stat_record.path,
                old_path: stat_record.old_path,
                status,
                additions: stat_record.additions,
                deletions: stat_record.deletions,
                is_binary: stat_record.is_binary,
                is_too_large: false,
            });
        }
    }

    if files.len() > GIT_COMMIT_DIFF_MAX_FILES {
        files.truncate(GIT_COMMIT_DIFF_MAX_FILES);
    }

    files
}

fn normalize_optional_path(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn selected_file_matches(file: &RepoCommitDiffFile, path: &str, old_path: Option<&str>) -> bool {
    if file.path == path && old_path.map_or(true, |old| file.old_path.as_deref() == Some(old)) {
        return true;
    }
    if file.old_path.as_deref() == Some(path) {
        return true;
    }
    if let Some(old_path) = old_path {
        return file.path == old_path || file.old_path.as_deref() == Some(old_path);
    }
    false
}

fn find_selected_file_metadata(
    files: &[RepoCommitDiffFile],
    path: &str,
    old_path: Option<&str>,
) -> Option<RepoCommitDiffFile> {
    files
        .iter()
        .find(|file| selected_file_matches(file, path, old_path))
        .cloned()
}

fn normalize_patch_for_response_with_limits(
    patch: String,
    large_bytes: usize,
    max_bytes: usize,
) -> (String, bool, bool) {
    let byte_len = patch.len();
    if byte_len > max_bytes {
        return (String::new(), true, false);
    }
    if byte_len > large_bytes {
        return (patch, true, false);
    }
    (patch, false, false)
}

fn normalize_patch_for_response(patch: String) -> (String, bool, bool) {
    normalize_patch_for_response_with_limits(
        patch,
        GIT_COMMIT_FILE_DIFF_LARGE_BYTES,
        GIT_COMMIT_FILE_DIFF_MAX_BYTES,
    )
}

async fn resolve_commit_full_hash(repo_path: &str, commit_hash: &str) -> Result<String, String> {
    let normalized_hash = commit_hash.trim();
    if normalized_hash.is_empty() {
        return Err("Commit hash 不能为空".to_string());
    }
    let commit_ref = format!("{}^{{commit}}", normalized_hash);
    run_git_async_with_timeout(
        repo_path,
        &["rev-parse", "--verify", commit_ref.as_str()],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .map(|output| output.trim().to_string())
    .map_err(|error| {
        format!(
            "Commit 不存在或不是有效 commit: {} ({})",
            normalized_hash, error
        )
    })
}

async fn read_parent_hashes(repo_path: &str, full_hash: &str) -> Result<Vec<String>, String> {
    let output = run_git_async_with_timeout(
        repo_path,
        &["show", "-s", "--format=%P", full_hash],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    Ok(output
        .split_whitespace()
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .collect())
}

async fn read_diff_summary_outputs(
    repo_path: &str,
    full_hash: &str,
    parent_hashes: &[String],
) -> Result<(String, String), String> {
    if parent_hashes.is_empty() {
        let numstat = run_git_async_with_timeout(
            repo_path,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--numstat",
                "-z",
                "--find-renames",
                "--find-copies",
                "-r",
                full_hash,
            ],
            GIT_COMMIT_DIFF_SUMMARY_TIMEOUT_MS,
        )
        .await?;
        let name_status = run_git_async_with_timeout(
            repo_path,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-z",
                "--find-renames",
                "--find-copies",
                "-r",
                full_hash,
            ],
            GIT_COMMIT_DIFF_SUMMARY_TIMEOUT_MS,
        )
        .await?;
        return Ok((name_status, numstat));
    }

    let first_parent = parent_hashes[0].as_str();
    let numstat = run_git_async_with_timeout(
        repo_path,
        &[
            "diff",
            "--numstat",
            "-z",
            "--find-renames",
            "--find-copies",
            first_parent,
            full_hash,
        ],
        GIT_COMMIT_DIFF_SUMMARY_TIMEOUT_MS,
    )
    .await?;
    let name_status = run_git_async_with_timeout(
        repo_path,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--find-copies",
            first_parent,
            full_hash,
        ],
        GIT_COMMIT_DIFF_SUMMARY_TIMEOUT_MS,
    )
    .await?;
    Ok((name_status, numstat))
}

async fn read_file_patch_for_path(
    repo_path: &str,
    full_hash: &str,
    parent_hashes: &[String],
    path: &str,
) -> Result<String, String> {
    if parent_hashes.is_empty() {
        return run_git_async_with_timeout(
            repo_path,
            &[
                "show",
                "--format=",
                "--root",
                "--find-renames",
                "--find-copies",
                "--unified=3",
                full_hash,
                "--",
                path,
            ],
            GIT_COMMIT_FILE_DIFF_TIMEOUT_MS,
        )
        .await;
    }

    let first_parent = parent_hashes[0].as_str();
    run_git_async_with_timeout(
        repo_path,
        &[
            "diff",
            "--find-renames",
            "--find-copies",
            "--unified=3",
            first_parent,
            full_hash,
            "--",
            path,
        ],
        GIT_COMMIT_FILE_DIFF_TIMEOUT_MS,
    )
    .await
}

async fn read_selected_file_patch(
    repo_path: &str,
    full_hash: &str,
    parent_hashes: &[String],
    file: &RepoCommitDiffFile,
) -> Result<String, String> {
    let primary_result =
        read_file_patch_for_path(repo_path, full_hash, parent_hashes, &file.path).await;
    match primary_result {
        Ok(patch) if !patch.trim().is_empty() => Ok(patch),
        Ok(patch) => {
            if let Some(old_path) = file.old_path.as_deref() {
                if old_path != file.path {
                    return read_file_patch_for_path(repo_path, full_hash, parent_hashes, old_path)
                        .await;
                }
            }
            Ok(patch)
        }
        Err(error) => {
            if let Some(old_path) = file.old_path.as_deref() {
                if old_path != file.path {
                    return read_file_patch_for_path(repo_path, full_hash, parent_hashes, old_path)
                        .await;
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn get_repo_commit_diff_summary(
    repo_path: String,
    commit_hash: String,
    state: State<'_, AppState>,
) -> Result<RepoCommitDiffSummary, String> {
    ensure_repo_path(&repo_path)?;
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &repo_path).await?;

    let full_hash = resolve_commit_full_hash(&repo_path, &commit_hash).await?;
    let parent_hashes = read_parent_hashes(&repo_path, &full_hash).await?;
    let (name_status_output, numstat_output) =
        read_diff_summary_outputs(&repo_path, &full_hash, &parent_hashes).await?;
    let files = build_diff_files(&name_status_output, &numstat_output);
    let insertions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();

    Ok(RepoCommitDiffSummary {
        repo_path,
        hash: full_hash.chars().take(7).collect(),
        full_hash,
        is_root: parent_hashes.is_empty(),
        is_merge: parent_hashes.len() > 1,
        parent_hashes,
        files_changed: files.len(),
        insertions,
        deletions,
        files,
    })
}

#[tauri::command]
pub async fn get_repo_commit_file_diff(
    repo_path: String,
    commit_hash: String,
    path: String,
    old_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoCommitFileDiff, String> {
    ensure_repo_path(&repo_path)?;
    let normalized_path = path.trim().to_string();
    if normalized_path.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let normalized_old_path = normalize_optional_path(old_path);
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &repo_path).await?;

    let full_hash = resolve_commit_full_hash(&repo_path, &commit_hash).await?;
    let parent_hashes = read_parent_hashes(&repo_path, &full_hash).await?;
    let (name_status_output, numstat_output) =
        read_diff_summary_outputs(&repo_path, &full_hash, &parent_hashes).await?;
    let files = build_diff_files(&name_status_output, &numstat_output);
    let file =
        find_selected_file_metadata(&files, &normalized_path, normalized_old_path.as_deref())
            .ok_or_else(|| format!("该文件不属于此 commit 的改动: {}", normalized_path))?;

    if file.is_binary {
        return Ok(RepoCommitFileDiff {
            hash: full_hash.chars().take(7).collect(),
            full_hash,
            path: file.path,
            old_path: file.old_path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            is_binary: true,
            is_too_large: false,
            truncated: false,
            patch: String::new(),
        });
    }

    let patch = read_selected_file_patch(&repo_path, &full_hash, &parent_hashes, &file).await?;
    let (patch, is_too_large, truncated) = normalize_patch_for_response(patch);

    Ok(RepoCommitFileDiff {
        hash: full_hash.chars().take(7).collect(),
        full_hash,
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
mod tests {
    use super::{
        build_diff_files, find_selected_file_metadata, format_git_failure_error,
        normalize_patch_for_response_with_limits, parse_name_status_z, parse_numstat_z,
    };

    #[test]
    fn parse_name_status_z_handles_simple_and_renamed_files() {
        let output = concat!(
            "M",
            "\0",
            "src/App.jsx",
            "\0",
            "R100",
            "\0",
            "old/name.md",
            "\0",
            "new/name.md",
            "\0"
        );
        let records = parse_name_status_z(output);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].status_code, "M");
        assert_eq!(records[0].path, "src/App.jsx");
        assert_eq!(records[0].old_path, None);
        assert_eq!(records[1].status_code, "R100");
        assert_eq!(records[1].old_path.as_deref(), Some("old/name.md"));
        assert_eq!(records[1].path, "new/name.md");
    }

    #[test]
    fn format_git_failure_error_uses_stderr_or_exit_code_fallback() {
        assert_eq!(
            format_git_failure_error(&["show", "HEAD"], Some(128), "fatal: bad revision"),
            "fatal: bad revision"
        );
        assert_eq!(
            format_git_failure_error(&["diff", "--stat"], Some(137), ""),
            "git diff --stat 退出失败，退出码: Some(137)"
        );
    }

    #[test]
    fn parse_name_status_z_skips_truncated_rename_without_dropping_later_records() {
        let output = concat!(
            "M",
            "\0",
            "src/App.jsx",
            "\0",
            "R100",
            "\0",
            "old/missing-new.md",
            "\0",
            "A",
            "\0",
            "src/New.jsx",
            "\0"
        );
        let records = parse_name_status_z(output);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].status_code, "M");
        assert_eq!(records[0].path, "src/App.jsx");
        assert_eq!(records[1].status_code, "A");
        assert_eq!(records[1].path, "src/New.jsx");
    }

    #[test]
    fn parse_numstat_z_handles_binary_and_renamed_files() {
        let output = concat!(
            "10\t2\tsrc/App.jsx",
            "\0",
            "-\t-\tassets/logo.png",
            "\0",
            "1\t0\t",
            "\0",
            "old/name.md",
            "\0",
            "new/name.md",
            "\0"
        );
        let records = parse_numstat_z(output);

        assert_eq!(records.len(), 3);
        assert_eq!(records[0].path, "src/App.jsx");
        assert_eq!(records[0].additions, 10);
        assert_eq!(records[0].deletions, 2);
        assert!(!records[0].is_binary);
        assert_eq!(records[1].path, "assets/logo.png");
        assert!(records[1].is_binary);
        assert_eq!(records[2].old_path.as_deref(), Some("old/name.md"));
        assert_eq!(records[2].path, "new/name.md");
    }

    #[test]
    fn parse_numstat_z_skips_truncated_rename_without_dropping_later_records() {
        let output = concat!(
            "10\t2\tsrc/App.jsx",
            "\0",
            "1\t0\t",
            "\0",
            "old/missing-new.md",
            "\0",
            "7\t0\tsrc/New.jsx",
            "\0"
        );
        let records = parse_numstat_z(output);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].path, "src/App.jsx");
        assert_eq!(records[0].additions, 10);
        assert_eq!(records[1].path, "src/New.jsx");
        assert_eq!(records[1].additions, 7);
    }

    #[test]
    fn build_diff_files_combines_status_and_numstat_records() {
        let name_status = concat!(
            "M",
            "\0",
            "src/App.jsx",
            "\0",
            "A",
            "\0",
            "src/New.jsx",
            "\0",
            "R050",
            "\0",
            "old/name.md",
            "\0",
            "new/name.md",
            "\0"
        );
        let numstat = concat!(
            "3\t1\tsrc/App.jsx",
            "\0",
            "7\t0\tsrc/New.jsx",
            "\0",
            "1\t2\t",
            "\0",
            "old/name.md",
            "\0",
            "new/name.md",
            "\0"
        );
        let files = build_diff_files(name_status, numstat);

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].additions, 3);
        assert_eq!(files[0].deletions, 1);
        assert_eq!(files[1].status, "added");
        assert_eq!(files[1].additions, 7);
        assert_eq!(files[2].status, "renamed");
        assert_eq!(files[2].old_path.as_deref(), Some("old/name.md"));
        assert_eq!(files[2].path, "new/name.md");
        assert_eq!(files[2].additions, 1);
        assert_eq!(files[2].deletions, 2);
    }

    #[test]
    fn selected_file_metadata_matches_new_or_old_path() {
        let name_status = concat!("R050", "\0", "old/name.md", "\0", "new/name.md", "\0");
        let numstat = concat!("1\t2\t", "\0", "old/name.md", "\0", "new/name.md", "\0");
        let files = build_diff_files(name_status, numstat);

        let by_new_path = find_selected_file_metadata(&files, "new/name.md", None).unwrap();
        assert_eq!(by_new_path.status, "renamed");
        let by_old_path = find_selected_file_metadata(&files, "old/name.md", None).unwrap();
        assert_eq!(by_old_path.path, "new/name.md");
        let by_both_paths =
            find_selected_file_metadata(&files, "new/name.md", Some("old/name.md")).unwrap();
        assert_eq!(by_both_paths.old_path.as_deref(), Some("old/name.md"));
    }

    #[test]
    fn patch_payload_marks_large_and_oversized_patches() {
        let (patch, is_too_large, truncated) =
            normalize_patch_for_response_with_limits("abc".to_string(), 4, 8);
        assert_eq!(patch, "abc");
        assert!(!is_too_large);
        assert!(!truncated);

        let (patch, is_too_large, truncated) =
            normalize_patch_for_response_with_limits("abcdef".to_string(), 4, 8);
        assert_eq!(patch, "abcdef");
        assert!(is_too_large);
        assert!(!truncated);

        let (patch, is_too_large, truncated) =
            normalize_patch_for_response_with_limits("abcdefghi".to_string(), 4, 8);
        assert_eq!(patch, "");
        assert!(is_too_large);
        assert!(!truncated);
    }
}
