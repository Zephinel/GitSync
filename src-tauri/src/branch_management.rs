use crate::commands::AppState;
use crate::repo_git_lock::{
    acquire as acquire_repo_git_guard, acquire_read as acquire_repo_git_read_guard,
    normalize_repo_lock_key,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::process::Command;

const GIT_META_TIMEOUT_MS: u64 = crate::git_timeouts::META;
const GIT_FETCH_TIMEOUT_MS: u64 = crate::git_timeouts::FETCH;
const GIT_PUSH_TIMEOUT_MS: u64 = crate::git_timeouts::PUSH;
const GIT_UPDATE_TIMEOUT_MS: u64 = crate::git_timeouts::DELETE;
const GIT_REMOTE_HEAD_TIMEOUT_MS: u64 = crate::git_timeouts::REMOTE_HEAD;

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct BranchManagementMeta {
    pub preferred_remote: Option<String>,
    pub default_branch: Option<String>,
    pub remote_default_branches: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct BranchSyncResult {
    pub branch: String,
    pub upstream: String,
    pub direction: String,
    pub updated: bool,
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

fn parse_tracking_remote<'a>(tracking_ref: &str, remote_names: &'a [String]) -> Option<&'a str> {
    let mut candidates: Vec<&String> = remote_names.iter().collect();
    candidates.sort_by_key(|name| std::cmp::Reverse(name.len()));
    candidates.into_iter().find_map(|remote| {
        let prefix = format!("{}/", remote);
        tracking_ref
            .starts_with(prefix.as_str())
            .then_some(remote.as_str())
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
        return Some(remote.to_string());
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
        let output = run_git(
            repo_path,
            &["ls-remote", "--symref", remote, "HEAD"],
            GIT_REMOTE_HEAD_TIMEOUT_MS,
        )
        .await
        .ok()?;
        return parse_ls_remote_head(output.as_str());
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

async fn load_management_meta_inner(
    repo_path: &str,
    query_preferred_remote_if_needed: bool,
) -> BranchManagementMeta {
    let remote_names = get_remote_names(repo_path).await;
    let preferred_remote = get_preferred_remote(repo_path, &remote_names).await;
    let mut remote_default_branches = HashMap::new();

    for remote in &remote_names {
        let query_remote = query_preferred_remote_if_needed
            && preferred_remote.as_deref() == Some(remote.as_str());
        if let Some(default_branch) =
            resolve_remote_default_branch(repo_path, remote, query_remote).await
        {
            remote_default_branches.insert(remote.clone(), default_branch);
        }
    }

    let default_branch = preferred_remote
        .as_ref()
        .and_then(|remote| remote_default_branches.get(remote).cloned())
        .or_else(|| remote_default_branches.values().next().cloned());
    let default_branch = match default_branch {
        Some(branch) => Some(branch),
        None => resolve_local_default_branch(repo_path).await,
    };

    BranchManagementMeta {
        preferred_remote,
        default_branch,
        remote_default_branches,
    }
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

fn parse_remote_branch<'a>(
    remote_branch: &str,
    remote_names: &'a [String],
) -> Result<(&'a str, String), String> {
    let normalized = remote_branch.trim();
    let Some(remote) = parse_tracking_remote(normalized, remote_names) else {
        return Err(format!("远端分支名称无效: {}", normalized));
    };
    let prefix = format!("{}/", remote);
    let branch = normalized
        .strip_prefix(prefix.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "HEAD")
        .ok_or_else(|| format!("远端分支名称无效: {}", normalized))?;
    Ok((remote, branch.to_string()))
}

#[tauri::command]
pub async fn get_repo_branch_management_meta(
    path: String,
    state: State<'_, AppState>,
) -> Result<BranchManagementMeta, String> {
    ensure_repo_path(&path)?;
    let _guard = acquire_repo_git_read_guard(&state, &path).await?;
    Ok(load_management_meta_inner(&path, false).await)
}

#[tauri::command]
pub async fn sync_repo_branch(
    path: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<BranchSyncResult, String> {
    ensure_repo_path(&path)?;
    let target_branch = branch.trim();
    if target_branch.is_empty() || target_branch == "HEAD" {
        return Err("分支名称无效".to_string());
    }
    let _guard = acquire_repo_git_guard(&state, &path).await?;

    let local_ref = format!("refs/heads/{}", target_branch);
    if !ref_exists(&path, local_ref.as_str()).await {
        return Err(format!("本地分支不存在: {}", target_branch));
    }
    if let Some(worktree_path) = checked_out_elsewhere(&path, target_branch).await {
        return Err(format!("该分支已在另一个 worktree 检出: {}", worktree_path));
    }

    // Fetch updates remote-tracking refs and FETCH_HEAD, so it blocks restart.
    run_git_mutation(&path, &["fetch", "--all", "--prune"], GIT_FETCH_TIMEOUT_MS)
        .await
        .map_err(|error| format!("刷新远端信息失败: {}", error))?;

    let upstream_query = format!("{}@{{upstream}}", target_branch);
    let upstream = run_git(
        &path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            upstream_query.as_str(),
        ],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .map_err(|_| format!("分支 {} 没有可用 upstream", target_branch))?;
    let upstream = upstream.trim().to_string();
    if upstream.is_empty() || upstream == "HEAD" {
        return Err(format!("分支 {} 没有可用 upstream", target_branch));
    }

    let comparison_target = format!("{}...{}", target_branch, upstream);
    let counts = run_git(
        &path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            comparison_target.as_str(),
        ],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .map_err(|error| format!("无法比较分支状态: {}", error))?;
    let mut count_parts = counts.split_whitespace();
    let ahead = count_parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let behind = count_parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    if ahead > 0 && behind > 0 {
        return Err(format!(
            "分支 {} 与 {} 已分叉，不能自动同步。",
            target_branch, upstream
        ));
    }
    if ahead == 0 && behind == 0 {
        return Ok(BranchSyncResult {
            branch: target_branch.to_string(),
            upstream,
            direction: "none".to_string(),
            updated: false,
            message: format!("分支 {} 已经同步。", target_branch),
        });
    }

    if ahead > 0 {
        let remote_names = get_remote_names(&path).await;
        let (remote, remote_branch) = parse_remote_branch(&upstream, &remote_names)?;
        let refspec = format!("refs/heads/{}:refs/heads/{}", target_branch, remote_branch);
        run_git_mutation(
            &path,
            &["push", remote, refspec.as_str()],
            GIT_PUSH_TIMEOUT_MS,
        )
        .await
        .map_err(|error| format!("推送分支失败: {}", error))?;
        return Ok(BranchSyncResult {
            branch: target_branch.to_string(),
            upstream: upstream.clone(),
            direction: "push".to_string(),
            updated: true,
            message: format!("已将 {} 推送到 {}。", target_branch, upstream),
        });
    }

    let current = current_branch(&path).await;
    if current.as_deref() == Some(target_branch) {
        let status = run_git(&path, &["status", "--porcelain"], GIT_META_TIMEOUT_MS)
            .await
            .map_err(|error| format!("无法确认工作区状态: {}", error))?;
        if !status.trim().is_empty() {
            return Err("当前分支存在未提交改动，请先提交、stash 或清理后再同步。".to_string());
        }
        run_git_mutation(
            &path,
            &["merge", "--ff-only", upstream.as_str()],
            GIT_UPDATE_TIMEOUT_MS,
        )
        .await
        .map_err(|error| format!("快进同步失败: {}", error))?;
    } else {
        let old_hash = run_git(
            &path,
            &["rev-parse", local_ref.as_str()],
            GIT_META_TIMEOUT_MS,
        )
        .await
        .map_err(|error| format!("无法读取本地分支: {}", error))?;
        let new_hash = run_git(
            &path,
            &["rev-parse", upstream.as_str()],
            GIT_META_TIMEOUT_MS,
        )
        .await
        .map_err(|error| format!("无法读取 upstream: {}", error))?;
        run_git_mutation(
            &path,
            &[
                "update-ref",
                local_ref.as_str(),
                new_hash.trim(),
                old_hash.trim(),
            ],
            GIT_UPDATE_TIMEOUT_MS,
        )
        .await
        .map_err(|error| format!("更新本地分支引用失败: {}", error))?;
    }

    Ok(BranchSyncResult {
        branch: target_branch.to_string(),
        upstream: upstream.clone(),
        direction: "pull".to_string(),
        updated: true,
        message: format!("已将 {} 快进同步到 {}。", target_branch, upstream),
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_ls_remote_head, parse_remote_branch, parse_symbolic_remote_head};

    #[test]
    fn parses_symbolic_remote_head() {
        assert_eq!(
            parse_symbolic_remote_head("origin", "origin/main"),
            Some("main".to_string())
        );
        assert_eq!(parse_symbolic_remote_head("origin", "upstream/main"), None);
    }

    #[test]
    fn parses_ls_remote_symref() {
        let output = "ref: refs/heads/develop\tHEAD\n0123456789\tHEAD";
        assert_eq!(parse_ls_remote_head(output), Some("develop".to_string()));
    }

    #[test]
    fn remote_parser_prefers_the_longest_matching_remote_name() {
        let remotes = vec!["up".to_string(), "up/stream".to_string()];
        let parsed = parse_remote_branch("up/stream/feature", &remotes).unwrap();
        assert_eq!(parsed.0, "up/stream");
        assert_eq!(parsed.1, "feature");
    }
}
