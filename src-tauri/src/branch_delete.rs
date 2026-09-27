//! The single branch-deletion authority.
//!
//! One command (`delete_repo_branches_batch`), one request shape and one set of
//! protection checks serve every delete surface. `force_delete` is a per-request
//! field that only selects `-d` versus `-D`; the default-branch, current-branch
//! and worktree protections apply either way.
//!
//! The guarded single-branch delete and the parallel batch implementation that
//! previously lived in `branch_management.rs` were removed so a delete can no
//! longer get a different guard set depending on which UI started it.

use crate::commands::{AppState, BranchOperationResult};
use crate::repo_git_lock::{acquire as acquire_repo_git_guard, normalize_repo_lock_key};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::process::Command;

const GIT_META_TIMEOUT_MS: u64 = crate::git_timeouts::META;
const GIT_PUSH_TIMEOUT_MS: u64 = crate::git_timeouts::PUSH;
const GIT_DELETE_TIMEOUT_MS: u64 = crate::git_timeouts::DELETE;
const GIT_REMOTE_HEAD_TIMEOUT_MS: u64 = crate::git_timeouts::REMOTE_HEAD;

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteRequest {
    #[serde(default)]
    pub identity: String,
    pub branch: String,
    #[serde(default)]
    pub remote_branch: Option<String>,
    #[serde(default)]
    pub delete_local: bool,
    #[serde(default)]
    pub delete_remote: bool,
    #[serde(default)]
    pub force_delete: bool,
}

#[derive(Debug, Serialize)]
pub struct BranchBatchDeleteItemResult {
    pub identity: String,
    pub branch: String,
    pub success: bool,
    pub message: String,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BranchBatchDeleteResult {
    pub requested_count: usize,
    pub succeeded_count: usize,
    pub failed_count: usize,
    pub results: Vec<BranchBatchDeleteItemResult>,
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

fn new_git_command(repo_path: &str, args: &[&str]) -> Command {
    crate::git_command::new_read_only_async_command(repo_path, args)
}

async fn run_git_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    run_git_output_with_command(new_git_command(repo_path, args), args, timeout_ms).await
}

async fn run_git_mutation_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    run_git_output_with_command(
        crate::git_command::new_mutation_async_command(repo_path, args),
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

    Ok(GitCommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

async fn run_git(repo_path: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let output = run_git_output(repo_path, args, timeout_ms).await?;
    if output.success {
        return Ok(output.stdout);
    }
    let detail = if output.stderr.is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    Err(if detail.is_empty() {
        format!("Git 命令失败: git {}", args.join(" "))
    } else {
        detail
    })
}

async fn run_git_mutation(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    let output = run_git_mutation_output(repo_path, args, timeout_ms).await?;
    if output.success {
        return Ok(output.stdout);
    }
    let detail = if output.stderr.is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    Err(if detail.is_empty() {
        format!("Git 命令失败: git {}", args.join(" "))
    } else {
        detail
    })
}

async fn ref_exists(repo_path: &str, full_ref: &str) -> bool {
    run_git_output(
        repo_path,
        &["show-ref", "--verify", "--quiet", full_ref],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .map(|output| output.success)
    .unwrap_or(false)
}

async fn get_remote_names(repo_path: &str) -> Vec<String> {
    run_git(repo_path, &["remote"], GIT_META_TIMEOUT_MS)
        .await
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_tracking_remote(tracking_ref: &str, remote_names: &[String]) -> Option<String> {
    let mut candidates: Vec<&String> = remote_names.iter().collect();
    candidates.sort_by_key(|name| std::cmp::Reverse(name.len()));
    candidates.into_iter().find_map(|remote| {
        let prefix = format!("{}/", remote);
        tracking_ref
            .starts_with(prefix.as_str())
            .then(|| remote.clone())
    })
}

async fn get_preferred_remote(repo_path: &str, remote_names: &[String]) -> Option<String> {
    if remote_names.is_empty() {
        return None;
    }
    let upstream = run_git(
        repo_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .unwrap_or_default();
    if let Some(remote) = parse_tracking_remote(upstream.trim(), remote_names) {
        return Some(remote);
    }
    if remote_names.iter().any(|remote| remote == "origin") {
        return Some("origin".to_string());
    }
    remote_names.first().cloned()
}

fn parse_symbolic_remote_head(remote: &str, output: &str) -> Option<String> {
    let prefix = format!("{}/", remote);
    output
        .trim()
        .strip_prefix(prefix.as_str())
        .map(str::trim)
        .filter(|branch| !branch.is_empty() && *branch != "HEAD")
        .map(str::to_string)
}

fn parse_ls_remote_head(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (reference, target) = line.split_once('\t')?;
        if target.trim() != "HEAD" {
            return None;
        }
        reference
            .trim()
            .strip_prefix("ref: refs/heads/")
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_string)
    })
}

async fn resolve_remote_default_branch(
    repo_path: &str,
    remote: &str,
    query_remote_if_needed: bool,
) -> Option<String> {
    let remote_head_ref = format!("refs/remotes/{}/HEAD", remote);
    if let Ok(symbolic) = run_git(
        repo_path,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            remote_head_ref.as_str(),
        ],
        GIT_META_TIMEOUT_MS,
    )
    .await
    {
        if let Some(branch) = parse_symbolic_remote_head(remote, symbolic.as_str()) {
            return Some(branch);
        }
    }

    if query_remote_if_needed {
        if let Ok(output) = run_git(
            repo_path,
            &["ls-remote", "--symref", remote, "HEAD"],
            GIT_REMOTE_HEAD_TIMEOUT_MS,
        )
        .await
        {
            if let Some(branch) = parse_ls_remote_head(output.as_str()) {
                return Some(branch);
            }
        }
    }

    for candidate in ["main", "master"] {
        let full_ref = format!("refs/remotes/{}/{}", remote, candidate);
        if ref_exists(repo_path, full_ref.as_str()).await {
            return Some(candidate.to_string());
        }
    }
    None
}

async fn resolve_local_default_branch(repo_path: &str) -> Option<String> {
    if let Ok(configured) = run_git(
        repo_path,
        &["config", "--get", "init.defaultBranch"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    {
        let branch = configured.trim();
        if !branch.is_empty() {
            let full_ref = format!("refs/heads/{}", branch);
            if ref_exists(repo_path, full_ref.as_str()).await {
                return Some(branch.to_string());
            }
        }
    }
    for candidate in ["main", "master"] {
        let full_ref = format!("refs/heads/{}", candidate);
        if ref_exists(repo_path, full_ref.as_str()).await {
            return Some(candidate.to_string());
        }
    }
    None
}

async fn current_branch(repo_path: &str) -> Option<String> {
    run_git(
        repo_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty() && value != "HEAD")
}

async fn checked_out_elsewhere(repo_path: &str, target_branch: &str) -> Option<String> {
    let current_root = run_git(
        repo_path,
        &["rev-parse", "--show-toplevel"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .ok()
    .map(|value| normalize_repo_lock_key(value.trim()));
    let output = run_git(
        repo_path,
        &["worktree", "list", "--porcelain"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .unwrap_or_default();

    let mut worktree_path = String::new();
    let mut branch_name = String::new();
    let check_record = |path: &str, branch: &str| -> Option<String> {
        if branch != target_branch || path.trim().is_empty() {
            return None;
        }
        let path_key = normalize_repo_lock_key(path.trim());
        if current_root.as_deref() == Some(path_key.as_str()) {
            None
        } else {
            Some(path.trim().to_string())
        }
    };

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let Some(path) = check_record(&worktree_path, &branch_name) {
                return Some(path);
            }
            worktree_path.clear();
            branch_name.clear();
        } else if let Some(path) = line.strip_prefix("worktree ") {
            worktree_path = path.trim().to_string();
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            branch_name = branch.trim().to_string();
        }
    }
    check_record(&worktree_path, &branch_name)
}

fn parse_remote_branch(
    remote_branch: &str,
    remote_names: &[String],
) -> Result<(String, String), String> {
    let normalized = remote_branch.trim();
    let remote = parse_tracking_remote(normalized, remote_names)
        .ok_or_else(|| format!("远端分支名称无效: {}", normalized))?;
    let prefix = format!("{}/", remote);
    let branch = normalized
        .strip_prefix(prefix.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "HEAD")
        .ok_or_else(|| format!("远端分支名称无效: {}", normalized))?;
    Ok((remote, branch.to_string()))
}

async fn ensure_local_branch_is_deletable(repo_path: &str, branch: &str) -> Result<(), String> {
    if branch.is_empty() || branch == "HEAD" {
        return Err("分支名称无效".to_string());
    }
    if current_branch(repo_path).await.as_deref() == Some(branch) {
        return Err(format!("不能删除当前分支: {}", branch));
    }

    let remote_names = get_remote_names(repo_path).await;
    if let Some(preferred_remote) = get_preferred_remote(repo_path, &remote_names).await {
        let default_branch =
            resolve_remote_default_branch(repo_path, preferred_remote.as_str(), true)
                .await
                .ok_or_else(|| {
                    format!(
                "无法确认远端 {} 的默认分支，已取消删除。请检查网络或刷新远端 HEAD 后重试。",
                preferred_remote
            )
                })?;
        if default_branch == branch {
            return Err(format!("默认分支不能删除: {}", branch));
        }

        for remote in remote_names
            .iter()
            .filter(|remote| remote.as_str() != preferred_remote.as_str())
        {
            if resolve_remote_default_branch(repo_path, remote, false)
                .await
                .as_deref()
                == Some(branch)
            {
                return Err(format!("默认分支不能删除: {}", branch));
            }
        }
    } else if resolve_local_default_branch(repo_path).await.as_deref() == Some(branch) {
        return Err(format!("默认分支不能删除: {}", branch));
    }

    let local_ref = format!("refs/heads/{}", branch);
    if !ref_exists(repo_path, local_ref.as_str()).await {
        return Err(format!("本地分支不存在: {}", branch));
    }
    if let Some(worktree_path) = checked_out_elsewhere(repo_path, branch).await {
        return Err(format!("该分支已在另一个 worktree 检出: {}", worktree_path));
    }
    Ok(())
}

async fn ensure_remote_branch_is_deletable(
    repo_path: &str,
    remote: &str,
    branch: &str,
) -> Result<(), String> {
    let Some(default_branch) = resolve_remote_default_branch(repo_path, remote, true).await else {
        return Err(format!(
            "无法确认远端 {} 的默认分支，已取消删除。请检查网络或刷新远端 HEAD 后重试。",
            remote
        ));
    };
    if default_branch == branch {
        return Err(format!("默认分支不能删除: {}/{}", remote, branch));
    }
    let remote_ref = format!("refs/remotes/{}/{}", remote, branch);
    if !ref_exists(repo_path, remote_ref.as_str()).await {
        return Err(format!("远端分支不存在: {}/{}", remote, branch));
    }
    Ok(())
}

fn local_delete_flag(force_delete: bool) -> &'static str {
    if force_delete {
        "-D"
    } else {
        "-d"
    }
}

pub(crate) async fn delete_branch_locked(
    repo_path: &str,
    request: &BranchDeleteRequest,
) -> Result<BranchOperationResult, String> {
    if !request.delete_local && !request.delete_remote {
        return Err("请选择要删除的本地或远端分支。".to_string());
    }

    let target_branch = request.branch.trim();
    let remote_names = get_remote_names(repo_path).await;
    let parsed_remote = if request.delete_remote {
        let remote_branch = request
            .remote_branch
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "远端分支不能为空".to_string())?;
        Some(parse_remote_branch(remote_branch, &remote_names)?)
    } else {
        None
    };

    if request.delete_local {
        ensure_local_branch_is_deletable(repo_path, target_branch).await?;
    }
    if let Some((remote, remote_branch)) = parsed_remote.as_ref() {
        ensure_remote_branch_is_deletable(repo_path, remote, remote_branch).await?;
    }

    let mut deleted_local = false;
    let mut deleted_remote = false;
    let mut warning = None;
    let mut tracking_remote = None;

    if request.delete_local {
        let delete_flag = local_delete_flag(request.force_delete);
        run_git_mutation(
            repo_path,
            &["branch", delete_flag, "--", target_branch],
            GIT_DELETE_TIMEOUT_MS,
        )
        .await
        .map_err(|error| {
            if request.force_delete {
                format!("强制删除本地分支失败: {}", error)
            } else {
                format!("删除本地分支失败: {}", error)
            }
        })?;
        deleted_local = true;
    }

    if let Some((remote, remote_branch)) = parsed_remote.as_ref() {
        tracking_remote = Some(remote.clone());
        match run_git_mutation(
            repo_path,
            &["push", remote.as_str(), "--delete", remote_branch.as_str()],
            GIT_PUSH_TIMEOUT_MS,
        )
        .await
        {
            Ok(_) => deleted_remote = true,
            Err(error) if deleted_local => {
                warning = Some(format!("本地分支已删除，但删除远端分支失败: {}", error));
            }
            Err(error) => return Err(format!("删除远端分支失败: {}", error)),
        }
    }

    let remote_label = parsed_remote
        .as_ref()
        .map(|(remote, branch)| format!("{}/{}", remote, branch));
    let branch_label = if deleted_local {
        target_branch.to_string()
    } else {
        remote_label
            .clone()
            .unwrap_or_else(|| target_branch.to_string())
    };
    let local_action = if request.force_delete {
        "强制删除"
    } else {
        "删除"
    };
    let message = match (deleted_local, deleted_remote) {
        (true, true) => format!(
            "已{}本地分支 {} 和远端分支 {}",
            local_action,
            target_branch,
            remote_label.unwrap_or_default()
        ),
        (true, false) => format!("已{}本地分支 {}", local_action, target_branch),
        (false, true) => format!("已删除远端分支 {}", remote_label.unwrap_or_default()),
        (false, false) => "没有删除任何分支。".to_string(),
    };

    Ok(BranchOperationResult {
        switched: false,
        branch: branch_label,
        tracked: false,
        tracking_remote,
        status_refreshed: false,
        remote_fetched: false,
        warning,
        message,
    })
}

#[tauri::command]
pub async fn delete_repo_branches_batch(
    path: String,
    requests: Vec<BranchDeleteRequest>,
    state: State<'_, AppState>,
) -> Result<BranchBatchDeleteResult, String> {
    ensure_repo_path(&path)?;
    if requests.is_empty() {
        return Err("请至少选择一个可删除分支。".to_string());
    }

    let _guard = acquire_repo_git_guard(&state, &path).await?;
    let requested_count = requests.len();
    let mut succeeded_count = 0usize;
    let mut results = Vec::with_capacity(requested_count);

    for request in requests {
        let identity = request.identity.clone();
        let branch = request.branch.clone();
        match delete_branch_locked(&path, &request).await {
            Ok(result) => {
                succeeded_count += 1;
                results.push(BranchBatchDeleteItemResult {
                    identity,
                    branch: result.branch,
                    success: true,
                    message: result.message,
                    warning: result.warning,
                });
            }
            Err(error) => {
                results.push(BranchBatchDeleteItemResult {
                    identity,
                    branch,
                    success: false,
                    message: error,
                    warning: None,
                });
            }
        }
    }

    Ok(BranchBatchDeleteResult {
        requested_count,
        succeeded_count,
        failed_count: requested_count.saturating_sub(succeeded_count),
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_uppercase_delete_flag_only_when_forced() {
        assert_eq!(local_delete_flag(false), "-d");
        assert_eq!(local_delete_flag(true), "-D");
    }

    #[test]
    fn parses_remote_head_symref() {
        let output = "ref: refs/heads/main\tHEAD\nabc123\tHEAD";
        assert_eq!(parse_ls_remote_head(output).as_deref(), Some("main"));
    }

    #[test]
    fn parses_remote_names_with_slashes_in_branch_names() {
        let remotes = vec!["origin".to_string(), "company".to_string()];
        let parsed = parse_remote_branch("origin/feature/deep", &remotes).unwrap();
        assert_eq!(parsed, ("origin".to_string(), "feature/deep".to_string()));
    }
}
