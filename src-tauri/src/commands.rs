use arboard::Clipboard;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, Mutex as AsyncMutex, Semaphore};

use crate::app_restart_guard::{AppRestartGuard, RestartGuardResult};
use crate::repo_git_lock::{
    acquire as acquire_repo_git_guard, acquire_read as acquire_repo_git_read_guard,
    lock_for as repo_git_lock, normalize_repo_lock_key,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Time budgets come from the single authority in `git_timeouts`; these local
// names are aliases only, so a value can never diverge from another module's.
const GIT_STATUS_TIMEOUT_MS: u64 = crate::git_timeouts::STATUS;
const GIT_META_TIMEOUT_MS: u64 = crate::git_timeouts::META;
const GIT_PRECHECK_TIMEOUT_MS: u64 = crate::git_timeouts::PRECHECK;
const GIT_SYNC_MISC_TIMEOUT_MS: u64 = crate::git_timeouts::SYNC_MISC;
const GIT_SYNC_STASH_TIMEOUT_MS: u64 = crate::git_timeouts::SYNC_STASH;
const GIT_SYNC_FETCH_TIMEOUT_MS: u64 = crate::git_timeouts::FETCH;
const GIT_SYNC_PULL_TIMEOUT_MS: u64 = crate::git_timeouts::PULL;
const GIT_SYNC_PUSH_TIMEOUT_MS: u64 = crate::git_timeouts::PUSH;
const GIT_CLONE_TIMEOUT_MS: u64 = crate::git_timeouts::CLONE;
const GIT_CLONE_CANCELLED_MESSAGE: &str = "克隆已取消";
const GIT_PUSH_WITH_TAGS_ARGS: &[&str] = &["push", "--follow-tags"];
const GIT_BRANCH_OVERVIEW_TIMEOUT_MS: u64 = crate::git_timeouts::BRANCH_OVERVIEW;
const GIT_COMMIT_HISTORY_TIMEOUT_MS: u64 = crate::git_timeouts::COMMIT_HISTORY;
const REPO_METADATA_REFRESH_DEFAULT_CONCURRENCY: usize = 4;
const REPO_METADATA_REFRESH_MAX_CONCURRENCY: usize = 10;
const SYNC_BEHAVIOR_CHANGED_ONLY: &str = "changes_only";
const BUILD_SCRIPT_TIMEOUT_MS: u64 = crate::git_timeouts::BUILD_SCRIPT;
const BUILD_SCRIPT_OUTPUT_LIMIT: usize = 12000;
const REPOS_FILE_NAME: &str = "repos.json";
#[cfg(target_os = "macos")]
static SYSTEM_TERMINAL_SCRIPT_ID: AtomicU64 = AtomicU64::new(0);

// ==================== 数据结构 ====================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepoConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(
        default = "default_sync_interval",
        deserialize_with = "deserialize_u64_with_default"
    )]
    pub sync_interval: u64,
    #[serde(
        default = "default_auto_sync",
        deserialize_with = "deserialize_bool_with_default_true"
    )]
    pub auto_sync: bool,
    #[serde(default = "default_sync_mode")]
    pub sync_mode: String, // "auto" | "manual"
    #[serde(default = "default_pull_strategy")]
    pub pull_strategy: String, // "rebase" | "merge"
    #[serde(default = "default_status")]
    pub status: String, // "idle" | "syncing" | "conflict" | "error" | "paused"
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub error_logs: Vec<String>,
    #[serde(default)]
    pub post_sync_build_enabled: bool,
    #[serde(default)]
    pub post_sync_build_script: Option<String>,
    #[serde(default = "now_timestamp")]
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoStatus {
    pub branch: String,
    pub is_clean: bool,
    pub modified: Vec<String>,
    pub ahead: i32,
    pub behind: i32,
    pub comparison_state: String,
    pub comparison_error: Option<String>,
    pub upstream: Option<String>,
    pub needs_upstream_publish: bool,
    pub detached_head: bool,
    pub head_hash: Option<String>,
    pub conflicted: Vec<String>,
    pub last_commit: Option<CommitInfo>,
    /// True when `git status` exceeded its budget: `modified`/`conflicted` are
    /// then unknown rather than empty, and callers must keep their last known
    /// working tree instead of treating the repository as clean.
    #[serde(default)]
    pub status_timed_out: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoBranchInfo {
    pub identity: String,
    pub name: String,
    pub local_name: Option<String>,
    pub is_current: bool,
    pub has_local: bool,
    pub has_remote: bool,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub is_remote_only: bool,
    pub remote_name: Option<String>,
    pub full_ref: Option<String>,
    pub comparison_state: String,
    pub comparison_error: Option<String>,
    pub detached_head: bool,
    pub head_hash: Option<String>,
    pub upstream_gone: bool,
    pub rebind_upstream: Option<String>,
    pub is_checked_out_elsewhere: bool,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoBranchOverview {
    pub current_branch: String,
    pub detached_head: bool,
    pub head_hash: Option<String>,
    pub preferred_remote: Option<String>,
    pub local_branch_count: usize,
    pub remote_branch_count: usize,
    pub remote_only_count: usize,
    pub ahead_branch_count: usize,
    pub behind_branch_count: usize,
    pub updated_branch_count: usize,
    pub divergent_branch_count: usize,
    pub upstream_gone_count: usize,
    pub no_upstream_count: usize,
    pub comparison_error_count: usize,
    pub checked_out_elsewhere_count: usize,
    pub branches: Vec<RepoBranchInfo>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BranchOperationResult {
    pub switched: bool,
    pub branch: String,
    pub tracked: bool,
    pub tracking_remote: Option<String>,
    pub status_refreshed: bool,
    pub remote_fetched: bool,
    pub warning: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub date: String,
    pub author: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoCommitHistory {
    pub branch: String,
    pub head_hash: String,
    pub remote_branch: Option<String>,
    pub remote_head_hash: Option<String>,
    pub commits: Vec<CommitInfo>,
    pub remote_commits: Vec<CommitInfo>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    pub conflict: bool,
    pub conflict_files: Vec<String>,
    pub did_pull: bool,
    pub did_push: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncPrecheckResult {
    pub repo_id: String,
    pub repo_name: String,
    pub has_local_changes: bool,
    pub missing_remote: bool,
    pub has_unmerged_conflicts: bool,
    pub ahead: i32,
    pub behind: i32,
    pub conflict_risk: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoBuildScriptRunResult {
    pub success: bool,
    pub message: String,
    pub script_path: String,
    pub command: String,
    pub output: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RemoveReposBatchResult {
    pub requested_count: usize,
    pub removed_ids: Vec<String>,
    pub missing_ids: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoBuildScriptLogChunkEvent {
    pub repo_id: String,
    pub session_id: Option<String>,
    pub chunk: String,
    pub is_stderr: bool,
}

enum ScriptOutputMessage {
    Chunk { text: String, is_stderr: bool },
    End { is_stderr: bool },
}

const BRANCH_COMPARISON_OK: &str = "ok";
const BRANCH_COMPARISON_NO_UPSTREAM: &str = "no-upstream";
const BRANCH_COMPARISON_UPSTREAM_GONE: &str = "upstream-gone";
const BRANCH_COMPARISON_REMOTE_ONLY: &str = "remote-only";
const BRANCH_COMPARISON_DETACHED: &str = "detached";
const BRANCH_COMPARISON_ERROR: &str = "error";

#[derive(Debug, Clone)]
struct BranchComparison {
    state: &'static str,
    error: Option<String>,
    ahead: i32,
    behind: i32,
}

#[derive(Debug, Clone)]
struct BranchUpstream {
    remote_name: String,
    short_ref: String,
    full_ref: String,
}

#[derive(Debug, Clone)]
struct RemoteBranchRef {
    remote_name: String,
    branch_name: String,
    short_ref: String,
    full_ref: String,
    head_hash: Option<String>,
}

#[derive(Debug, Clone)]
struct CurrentHeadInfo {
    branch: Option<String>,
    detached_head: bool,
    head_hash: Option<String>,
}

// GitHub Device Flow 认证响应
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceAuthResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

// GitHub 账号信息
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubAccount {
    pub login: String,
    pub avatar_url: String,
    pub name: Option<String>,
}

// GitHub 仓库浏览信息
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GithubRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub clone_url: String,
    pub ssh_url: String,
    pub private: bool,
    pub html_url: String,
    pub default_branch: String,
    pub language: Option<String>,
    pub stargazers_count: u64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

pub struct AppState {
    pub repos: Mutex<Vec<RepoConfig>>,
    pub data_path: Mutex<Option<PathBuf>>,
    save_lock: Mutex<()>,
    pub syncing_repos: Mutex<HashSet<String>>,
    pub git_repo_locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pub clone_cancel_tasks: AsyncMutex<HashSet<String>>,
    pub(crate) app_restart_guard: AppRestartGuard,
    pub http_client: reqwest::Client,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            repos: Mutex::new(Vec::new()),
            data_path: Mutex::new(None),
            save_lock: Mutex::new(()),
            syncing_repos: Mutex::new(HashSet::new()),
            git_repo_locks: AsyncMutex::new(HashMap::new()),
            clone_cancel_tasks: AsyncMutex::new(HashSet::new()),
            app_restart_guard: AppRestartGuard::default(),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap(),
        }
    }

    /// 初始化数据目录并加载已保存的仓库配置
    pub fn init(&self, app_data_dir: PathBuf) {
        let data_file = app_data_dir.join(REPOS_FILE_NAME);

        // 确保目录存在
        if let Some(parent) = data_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        *self.data_path.lock().unwrap() = Some(data_file.clone());

        // 加载已保存的数据；主文件损坏时优先从备份恢复，避免启动后静默变成空列表。
        match load_repo_configs_with_backup(&data_file) {
            Ok(loaded) => {
                let mut repos = loaded.repos;
                let mut should_rewrite =
                    loaded.recovered_from_backup || loaded.skipped_invalid_entries > 0;

                // 重置所有运行时状态（上次可能是在同步中关闭的）
                for repo in repos.iter_mut() {
                    if repo.status == "syncing" {
                        repo.status = default_status();
                        should_rewrite = true;
                    }
                }

                let mut r = self.repos.lock().unwrap();
                *r = repos;
                drop(r);

                if should_rewrite {
                    self.save();
                }
            }
            Err(error) => {
                eprintln!("加载仓库配置失败: {}", error);
            }
        }
    }

    /// 保存当前仓库列表到 JSON 文件
    pub fn save(&self) {
        if let Err(error) = self.save_to_disk() {
            eprintln!("保存仓库配置失败: {}", error);
        }
    }

    fn save_to_disk(&self) -> Result<(), String> {
        let _save_guard = self.save_lock.lock().unwrap();
        let data_file = self.data_path.lock().unwrap().clone();
        let Some(data_file) = data_file else {
            return Ok(());
        };

        let repos_snapshot = self.repos.lock().unwrap().clone();
        save_repo_configs_to_file(&data_file, &repos_snapshot)
    }
}

#[tauri::command]
pub fn get_app_restart_blockers(state: State<'_, AppState>) -> Vec<String> {
    state.app_restart_guard.blockers()
}

#[tauri::command]
pub fn acquire_app_restart_guard(state: State<'_, AppState>) -> RestartGuardResult {
    state.app_restart_guard.try_acquire_restart()
}

#[tauri::command]
pub fn release_app_restart_guard(token: u64, state: State<'_, AppState>) -> bool {
    state.app_restart_guard.release_restart(token)
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

struct LoadedRepoConfigs {
    repos: Vec<RepoConfig>,
    recovered_from_backup: bool,
    skipped_invalid_entries: usize,
}

fn default_branch() -> String {
    "main".to_string()
}

fn default_sync_interval() -> u64 {
    300
}

fn default_auto_sync() -> bool {
    true
}

fn default_sync_mode() -> String {
    "auto".to_string()
}

fn default_pull_strategy() -> String {
    "rebase".to_string()
}

fn default_status() -> String {
    "idle".to_string()
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };

    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        serde_json::Value::Number(value) => Ok(Some(value.to_string())),
        serde_json::Value::Bool(value) => Ok(Some(value.to_string())),
        other => Ok(Some(other.to_string())),
    }
}

fn deserialize_u64_with_default<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let parsed = match value {
        serde_json::Value::Number(value) => value.as_u64(),
        serde_json::Value::String(value) => value.trim().parse::<u64>().ok(),
        _ => None,
    };

    Ok(parsed
        .filter(|value| *value > 0)
        .unwrap_or_else(default_sync_interval))
}

fn deserialize_bool_with_default_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let parsed = match value {
        serde_json::Value::Bool(value) => Some(value),
        serde_json::Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    };

    Ok(parsed.unwrap_or_else(default_auto_sync))
}

fn repo_backup_path(data_file: &Path) -> PathBuf {
    let mut backup_file = data_file.to_path_buf();
    let file_name = data_file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(REPOS_FILE_NAME);
    backup_file.set_file_name(format!("{}.bak", file_name));
    backup_file
}

fn repo_tmp_path(data_file: &Path) -> PathBuf {
    let mut tmp_file = data_file.to_path_buf();
    let file_name = data_file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(REPOS_FILE_NAME);
    tmp_file.set_file_name(format!("{}.tmp", file_name));
    tmp_file
}

fn load_repo_configs_with_backup(data_file: &Path) -> Result<LoadedRepoConfigs, String> {
    if !data_file.exists() {
        let backup_file = repo_backup_path(data_file);
        if backup_file.exists() {
            let (repos, skipped_invalid_entries) = load_repo_configs_from_file(&backup_file)
                .map_err(|error| format!("主配置不存在，备份配置也不可用: {}", error))?;
            return Ok(LoadedRepoConfigs {
                repos,
                recovered_from_backup: true,
                skipped_invalid_entries,
            });
        }

        return Ok(LoadedRepoConfigs {
            repos: Vec::new(),
            recovered_from_backup: false,
            skipped_invalid_entries: 0,
        });
    }

    match load_repo_configs_from_file(data_file) {
        Ok((repos, skipped_invalid_entries)) => Ok(LoadedRepoConfigs {
            repos,
            recovered_from_backup: false,
            skipped_invalid_entries,
        }),
        Err(primary_error) => {
            let backup_file = repo_backup_path(data_file);
            if backup_file.exists() {
                match load_repo_configs_from_file(&backup_file) {
                    Ok((repos, skipped_invalid_entries)) => {
                        eprintln!(
                            "主仓库配置不可用，已从备份恢复: {}; backup={}",
                            primary_error,
                            backup_file.display()
                        );
                        Ok(LoadedRepoConfigs {
                            repos,
                            recovered_from_backup: true,
                            skipped_invalid_entries,
                        })
                    }
                    Err(backup_error) => Err(format!(
                        "主配置不可用: {}; 备份配置也不可用: {}",
                        primary_error, backup_error
                    )),
                }
            } else {
                Err(primary_error)
            }
        }
    }
}

fn load_repo_configs_from_file(data_file: &Path) -> Result<(Vec<RepoConfig>, usize), String> {
    let content = std::fs::read_to_string(data_file)
        .map_err(|error| format!("读取 {} 失败: {}", data_file.display(), error))?;
    load_repo_configs_from_str(&content)
        .map_err(|error| format!("解析 {} 失败: {}", data_file.display(), error))
}

fn load_repo_configs_from_str(content: &str) -> Result<(Vec<RepoConfig>, usize), String> {
    let value = serde_json::from_str::<serde_json::Value>(content)
        .map_err(|error| format!("JSON 格式无效: {}", error))?;
    let entries = value
        .as_array()
        .ok_or_else(|| "仓库配置根节点不是数组".to_string())?;

    let mut repos = Vec::with_capacity(entries.len());
    let mut skipped_invalid_entries = 0usize;
    for entry in entries {
        match serde_json::from_value::<RepoConfig>(entry.clone())
            .ok()
            .and_then(normalize_loaded_repo_config)
        {
            Some(repo) => repos.push(repo),
            None => skipped_invalid_entries += 1,
        }
    }

    if repos.is_empty() && !entries.is_empty() {
        return Err("仓库配置中没有可用条目".to_string());
    }

    Ok((repos, skipped_invalid_entries))
}

fn normalize_loaded_repo_config(mut repo: RepoConfig) -> Option<RepoConfig> {
    repo.id = repo.id.trim().to_string();
    repo.path = repo.path.trim().to_string();
    if repo.id.is_empty() || repo.path.is_empty() {
        return None;
    }

    repo.name = repo.name.trim().to_string();
    if repo.name.is_empty() {
        repo.name = infer_repo_name_from_path(&repo.path).unwrap_or_else(|| repo.id.clone());
    }

    repo.branch = repo.branch.trim().to_string();
    if repo.branch.is_empty() {
        repo.branch = default_branch();
    }

    if repo.sync_interval == 0 {
        repo.sync_interval = default_sync_interval();
    }

    repo.sync_mode = match repo.sync_mode.trim() {
        "auto" | "manual" => repo.sync_mode.trim().to_string(),
        _ => default_sync_mode(),
    };

    repo.pull_strategy = match repo.pull_strategy.trim() {
        "rebase" | "merge" => repo.pull_strategy.trim().to_string(),
        _ => default_pull_strategy(),
    };

    repo.status = repo.status.trim().to_string();
    if repo.status.is_empty() {
        repo.status = default_status();
    }

    repo.created_at = repo.created_at.trim().to_string();
    if repo.created_at.is_empty() {
        repo.created_at = now_timestamp();
    }

    repo.post_sync_build_script = repo
        .post_sync_build_script
        .as_deref()
        .and_then(normalize_optional_repo_script_path);

    Some(repo)
}

fn infer_repo_name_from_path(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_end_matches(|ch| ch == '/' || ch == '\\');
    trimmed
        .rsplit(|ch| ch == '/' || ch == '\\')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn save_repo_configs_to_file(data_file: &Path, repos: &[RepoConfig]) -> Result<(), String> {
    if let Some(parent) = data_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建数据目录 {} 失败: {}", parent.display(), error))?;
    }

    let json = serde_json::to_string_pretty(repos)
        .map_err(|error| format!("序列化仓库配置失败: {}", error))?;
    let tmp_file = repo_tmp_path(data_file);
    let backup_file = repo_backup_path(data_file);

    if tmp_file.exists() {
        let _ = std::fs::remove_file(&tmp_file);
    }

    let should_update_backup = data_file.exists() && load_repo_configs_from_file(data_file).is_ok();
    if should_update_backup {
        std::fs::copy(data_file, &backup_file).map_err(|error| {
            format!(
                "备份现有仓库配置到 {} 失败: {}",
                backup_file.display(),
                error
            )
        })?;
    } else if data_file.exists() {
        eprintln!(
            "现有仓库配置不可解析，保留备份不覆盖: {}",
            data_file.display()
        );
    }

    {
        let mut file = std::fs::File::create(&tmp_file)
            .map_err(|error| format!("创建临时配置文件 {} 失败: {}", tmp_file.display(), error))?;
        file.write_all(json.as_bytes())
            .map_err(|error| format!("写入临时配置文件 {} 失败: {}", tmp_file.display(), error))?;
        file.sync_all()
            .map_err(|error| format!("同步临时配置文件 {} 失败: {}", tmp_file.display(), error))?;
    }

    replace_repo_config_file(&tmp_file, data_file, &backup_file)?;

    if !backup_file.exists() {
        let _ = std::fs::copy(data_file, &backup_file);
    }

    Ok(())
}

fn replace_repo_config_file(
    tmp_file: &Path,
    data_file: &Path,
    backup_file: &Path,
) -> Result<(), String> {
    match std::fs::rename(tmp_file, data_file) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if data_file.exists() {
                std::fs::remove_file(data_file).map_err(|remove_error| {
                    format!(
                        "替换仓库配置失败: rename={} remove={}",
                        first_error, remove_error
                    )
                })?;

                if let Err(rename_error) = std::fs::rename(tmp_file, data_file) {
                    if backup_file.exists() {
                        let _ = std::fs::copy(backup_file, data_file);
                    }
                    return Err(format!("替换仓库配置失败: {}", rename_error));
                }

                Ok(())
            } else {
                Err(format!("替换仓库配置失败: {}", first_error))
            }
        }
    }
}

// ==================== Git 辅助函数 ====================

fn new_git_command(repo_path: &str, args: &[&str]) -> Command {
    crate::git_command::new_read_only_command(repo_path, args)
}

fn new_git_async_command(repo_path: &str, args: &[&str]) -> tokio::process::Command {
    crate::git_command::new_read_only_async_command(repo_path, args)
}

fn run_git_read_only(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = new_git_command(repo_path, args)
        .output()
        .map_err(|e| format!("执行 git 命令失败: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(stderr)
    }
}

fn run_git_mutation(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = crate::git_command::new_mutation_command(repo_path, args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("执行 git 命令失败: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn run_git_allow_fail_read_only(repo_path: &str, args: &[&str]) -> String {
    match new_git_command(repo_path, args).output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stdout.is_empty() {
                stderr
            } else {
                stdout
            }
        }
        Err(e) => format!("Error: {}", e),
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

fn parse_clone_repo_name(repo_url: &str) -> Option<String> {
    let trimmed = repo_url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_suffix = trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    if without_suffix.is_empty() {
        return None;
    }

    let candidate = without_suffix
        .rsplit(|ch| ch == '/' || ch == ':')
        .next()
        .unwrap_or(without_suffix)
        .trim()
        .trim_end_matches(".git")
        .trim();

    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

fn add_repo_internal(path: String, state: &State<'_, AppState>) -> Result<RepoConfig, String> {
    if !is_git_repo(path.clone()) {
        return Err("所选目录不是有效的 Git 仓库".to_string());
    }

    let mut repos = state.repos.lock().unwrap();
    if repos.iter().any(|r| r.path == path) {
        return Err("该仓库已添加".to_string());
    }

    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let branch = run_git_read_only(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|_| "main".to_string());

    let remote = get_preferred_remote_name(&path).and_then(|remote_name| {
        run_git_read_only(&path, &["remote", "get-url", remote_name.as_str()]).ok()
    });

    let repo = RepoConfig {
        id: generate_id(),
        name,
        path,
        branch,
        remote,
        sync_interval: 30,
        auto_sync: true,
        sync_mode: "manual".to_string(),
        pull_strategy: "rebase".to_string(),
        status: "idle".to_string(),
        last_sync_at: None,
        last_error: None,
        error_logs: Vec::new(),
        post_sync_build_enabled: false,
        post_sync_build_script: None,
        created_at: now_timestamp(),
    };

    repos.push(repo.clone());
    drop(repos);
    state.save();
    Ok(repo)
}

#[cfg(not(target_os = "windows"))]
fn spawn_and_check(mut command: Command, fail_message: &str) -> Result<bool, String> {
    let status = command
        .status()
        .map_err(|e| format!("{}: {}", fail_message, e))?;
    if status.success() {
        Ok(true)
    } else {
        Err(format!("{} (exit code: {:?})", fail_message, status.code()))
    }
}

#[cfg(target_os = "windows")]
fn spawn_and_detach(mut command: Command, fail_message: &str) -> Result<bool, String> {
    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{}: {}", fail_message, e))?;
    Ok(true)
}

async fn run_git_read_only_async_with_timeout(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    run_git_async_with_command(new_git_async_command(repo_path, args), args, timeout_ms).await
}

async fn run_git_mutation_async_with_timeout(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    run_git_async_with_command(
        crate::git_command::new_mutation_async_command(repo_path, args),
        args,
        timeout_ms,
    )
    .await
}

async fn run_git_async_with_command(
    mut command: tokio::process::Command,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    command.kill_on_drop(true);

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
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(stderr)
    }
}

async fn run_git_allow_fail_read_only_async_with_timeout(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> String {
    let mut command = new_git_async_command(repo_path, args);
    command.kill_on_drop(true);

    match tokio::time::timeout(Duration::from_millis(timeout_ms), command.output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stdout.is_empty() {
                stderr
            } else {
                stdout
            }
        }
        Ok(Err(e)) => format!("Error: {}", e),
        Err(_) => format!(
            "Error: {}git {}",
            crate::git_timeouts::TIMEOUT_ERROR_PREFIX,
            args.join(" ")
        ),
    }
}

struct GitCloneOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn normalize_clone_task_id(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

async fn read_child_pipe<R>(mut reader: R) -> Vec<u8>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut buffer = Vec::new();
    let _ = reader.read_to_end(&mut buffer).await;
    buffer
}

async fn clear_clone_cancel_task(state: &State<'_, AppState>, clone_task_id: Option<&str>) {
    if let Some(clone_task_id) = clone_task_id {
        state.clone_cancel_tasks.lock().await.remove(clone_task_id);
    }
}

async fn wait_for_clone_output(
    mut child: tokio::process::Child,
    clone_task_id: Option<&str>,
    state: &State<'_, AppState>,
) -> Result<GitCloneOutput, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 git clone 标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 git clone 错误输出".to_string())?;
    let stdout_task = tokio::spawn(read_child_pipe(stdout));
    let stderr_task = tokio::spawn(read_child_pipe(stderr));
    let timeout_at = tokio::time::Instant::now() + Duration::from_millis(GIT_CLONE_TIMEOUT_MS);

    let status = loop {
        if let Some(clone_task_id) = clone_task_id {
            let cancelled = {
                let mut cancel_tasks = state.clone_cancel_tasks.lock().await;
                cancel_tasks.remove(clone_task_id)
            };
            if cancelled {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(GIT_CLONE_CANCELLED_MESSAGE.to_string());
            }
        }

        if tokio::time::Instant::now() >= timeout_at {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("克隆仓库超时，请检查网络后重试".to_string());
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!("等待 git clone 结束失败: {}", error));
            }
        }
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();

    Ok(GitCloneOutput {
        status,
        stdout,
        stderr,
    })
}

fn generate_id() -> String {
    use std::time::SystemTime;
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let chars: Vec<char> = "abcdefghijklmnopqrstuvwxyz0123456789".chars().collect();
    let mut result = String::new();
    let mut n = ts;
    for _ in 0..6 {
        n = n.wrapping_mul(6364136223846793005).wrapping_add(1);
        result.push(chars[(n as usize) % chars.len()]);
    }
    format!("repo_{}_{}", ts, result)
}

#[cfg(target_os = "macos")]
fn open_directory_default(path: &str) -> Result<bool, String> {
    let mut command = Command::new("open");
    command.arg(path);
    spawn_and_check(command, "打开目录失败")
}

#[cfg(target_os = "windows")]
fn open_directory_default(path: &str) -> Result<bool, String> {
    let mut command = Command::new("explorer");
    command.arg(path);
    spawn_and_detach(command, "打开目录失败")
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_directory_default(path: &str) -> Result<bool, String> {
    let mut command = Command::new("xdg-open");
    command.arg(path);
    spawn_and_check(command, "打开目录失败")
}

#[cfg(target_os = "macos")]
fn open_directory_with_app(path: &str, app: &str) -> Result<bool, String> {
    let mut command = Command::new("open");
    command.arg("-a").arg(app).arg(path);
    spawn_and_check(command, "使用指定应用打开目录失败")
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_directory_with_app(path: &str, app: &str) -> Result<bool, String> {
    let mut command = Command::new(app);
    command.arg(path);
    spawn_and_check(command, "使用指定应用打开目录失败")
}

#[cfg(target_os = "windows")]
fn open_directory_with_app(path: &str, app: &str) -> Result<bool, String> {
    let mut command = Command::new(app);
    command.arg(path);
    spawn_and_detach(command, "使用指定应用打开目录失败")
}

fn is_supported_build_script_extension(ext: &str) -> bool {
    matches!(ext, "sh" | "command" | "bat" | "cmd" | "ps1")
}

#[cfg(target_os = "windows")]
fn normalize_windows_cmd_path(path: &Path) -> std::path::PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{}", stripped))
    } else if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

fn resolve_repo_script_file(
    repo_path: &str,
    script_path: &str,
) -> Result<(std::path::PathBuf, String), String> {
    let normalized_script_path = script_path.trim();
    if normalized_script_path.is_empty() {
        return Err("脚本路径不能为空".to_string());
    }

    let repo_root = Path::new(repo_path);
    let raw_script_path = Path::new(normalized_script_path);
    let candidate = if raw_script_path.is_absolute() {
        raw_script_path.to_path_buf()
    } else {
        repo_root.join(raw_script_path)
    };

    if !candidate.exists() {
        return Err(format!("脚本文件不存在: {}", normalized_script_path));
    }
    if !candidate.is_file() {
        return Err(format!("脚本路径不是文件: {}", normalized_script_path));
    }

    let canonical_repo = repo_root
        .canonicalize()
        .map_err(|e| format!("解析仓库路径失败: {}", e))?;
    let canonical_script = candidate
        .canonicalize()
        .map_err(|e| format!("解析脚本路径失败: {}", e))?;

    if !canonical_script.starts_with(&canonical_repo) {
        return Err("脚本必须位于当前仓库目录内".to_string());
    }

    let extension = canonical_script
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_supported_build_script_extension(&extension) {
        return Err("仅支持 .sh / .command / .bat / .cmd / .ps1 脚本".to_string());
    }

    let display_path = canonical_script
        .strip_prefix(&canonical_repo)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| canonical_script.to_string_lossy().replace('\\', "/"));

    #[cfg(target_os = "windows")]
    let executable_script = normalize_windows_cmd_path(&canonical_script);
    #[cfg(not(target_os = "windows"))]
    let executable_script = canonical_script;

    Ok((executable_script, display_path))
}

fn build_script_file_command(
    repo_path: &str,
    script_file: &Path,
) -> Result<(tokio::process::Command, String), String> {
    let extension = script_file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    let script_file_for_exec = normalize_windows_cmd_path(script_file);

    #[cfg(target_os = "windows")]
    let (mut command, readable_command) = match extension.as_str() {
        "bat" | "cmd" => {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.arg("/C").arg(&script_file_for_exec);
            (cmd, format!("cmd /C {}", script_file_for_exec.display()))
        }
        "ps1" => {
            let mut cmd = tokio::process::Command::new("powershell");
            cmd.arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(&script_file_for_exec);
            (
                cmd,
                format!(
                    "powershell -NoProfile -ExecutionPolicy Bypass -File {}",
                    script_file_for_exec.display()
                ),
            )
        }
        "sh" | "command" => {
            let mut cmd = tokio::process::Command::new("bash");
            cmd.arg(&script_file_for_exec);
            (cmd, format!("bash {}", script_file_for_exec.display()))
        }
        _ => {
            return Err("当前脚本扩展名不受支持".to_string());
        }
    };

    #[cfg(not(target_os = "windows"))]
    let (mut command, readable_command) = match extension.as_str() {
        "sh" | "command" => {
            #[cfg(target_os = "macos")]
            {
                // Run scripts through a pseudo terminal to better match manual terminal execution.
                let mut cmd = tokio::process::Command::new("script");
                cmd.arg("-q")
                    .arg("/dev/null")
                    .arg("bash")
                    .arg("-l")
                    .arg(script_file);
                (
                    cmd,
                    format!("script -q /dev/null bash -l {}", script_file.display()),
                )
            }
            #[cfg(all(not(target_os = "macos"), target_family = "unix"))]
            {
                let mut cmd = tokio::process::Command::new("bash");
                cmd.arg("-l").arg(script_file);
                (cmd, format!("bash -l {}", script_file.display()))
            }
        }
        "bat" | "cmd" | "ps1" => {
            return Err("当前系统不支持执行 Windows 脚本，请选择 .sh/.command".to_string());
        }
        _ => {
            return Err("当前脚本扩展名不受支持".to_string());
        }
    };

    command.current_dir(repo_path);

    #[cfg(target_os = "windows")]
    {
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    Ok((command, readable_command))
}

#[cfg(not(target_os = "windows"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "macos")]
fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn run_script_in_system_terminal(
    repo_path: &str,
    script_file: &Path,
    completion_marker: &Path,
) -> Result<String, String> {
    if let Some(parent) = completion_marker.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法准备系统终端脚本状态目录: {}", error))?;
    }
    let shell_body =
        "printf '%s\\n' \"$$\" > \"$1\"; trap 'rm -f \"$1\"' EXIT; cd \"$2\" && bash -l \"$3\"";
    let command_text = format!(
        "sh -c {} _ {} {} {}",
        shell_single_quote(shell_body),
        shell_single_quote(&completion_marker.to_string_lossy()),
        shell_single_quote(repo_path),
        shell_single_quote(&script_file.to_string_lossy())
    );
    std::fs::write(completion_marker, "pending")
        .map_err(|error| format!("无法跟踪系统终端脚本状态: {}", error))?;
    let escaped = escape_applescript_string(&command_text);
    let applescript = format!(
        r#"set commandText to "{}"
set terminalWasRunning to application "Terminal" is running
tell application "Terminal"
    activate
    if terminalWasRunning then
        do script commandText
    else
        if not (exists front window) then reopen
        do script commandText in front window
    end if
end tell"#,
        escaped
    );

    let status = Command::new("osascript")
        .arg("-e")
        .arg(applescript)
        .status()
        .map_err(|e| format!("启动系统终端失败: {}", e))?;

    if !status.success() {
        let _ = std::fs::remove_file(completion_marker);
        return Err("系统终端未能成功启动脚本".to_string());
    }

    Ok(format!("Terminal: {}", command_text))
}

#[cfg(target_os = "macos")]
fn system_terminal_script_marker() -> PathBuf {
    let id = SYSTEM_TERMINAL_SCRIPT_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join("gitsync-system-terminal-scripts")
        .join(format!("{}-{}.pid", std::process::id(), id))
}

#[cfg(target_os = "macos")]
async fn retain_operation_until_terminal_script_finishes(
    completion_marker: PathBuf,
    operation: crate::app_restart_guard::AppOperationLease,
) {
    let pending_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let marker = match tokio::fs::read_to_string(&completion_marker).await {
            Ok(marker) => marker,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        let pid = marker.trim().parse::<u32>().ok();
        if pid.is_none() {
            if tokio::time::Instant::now() >= pending_deadline {
                let _ = tokio::fs::remove_file(&completion_marker).await;
                break;
            }
        } else {
            let alive = tokio::process::Command::new("/bin/kill")
                .args(["-0", &pid.unwrap().to_string()])
                .status()
                .await
                .map(|status| status.success())
                .unwrap_or(false);
            if !alive {
                let _ = tokio::fs::remove_file(&completion_marker).await;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    drop(operation);
}

#[cfg(target_os = "windows")]
fn run_script_in_system_terminal(repo_path: &str, script_file: &Path) -> Result<String, String> {
    let repo_path_for_cmd = normalize_windows_cmd_path(Path::new(repo_path));
    let repo_path_for_cmd_text = repo_path_for_cmd.to_string_lossy().to_string();
    let script_file_for_exec = normalize_windows_cmd_path(script_file);
    let script_path_for_cmd = script_file_for_exec.to_string_lossy().to_string();
    let extension = script_file_for_exec
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut cmd = Command::new("cmd");
    cmd.arg("/C")
        .arg("start")
        .arg("")
        .arg("/D")
        .arg(&repo_path_for_cmd_text)
        .arg("cmd")
        .arg("/K");

    let readable_command = match extension.as_str() {
        "bat" | "cmd" => {
            cmd.arg("call").arg(&script_path_for_cmd);
            format!("call \"{}\"", script_path_for_cmd)
        }
        "ps1" => {
            cmd.arg("powershell")
                .arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(&script_path_for_cmd);
            format!(
                "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
                script_path_for_cmd
            )
        }
        "sh" | "command" => {
            cmd.arg("bash").arg(&script_path_for_cmd);
            format!("bash \"{}\"", script_path_for_cmd)
        }
        _ => return Err("当前脚本扩展名不受支持".to_string()),
    };

    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn()
        .map_err(|e| format!("启动系统终端失败: {}", e))?;

    Ok(format!("cmd /K {}", readable_command))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn run_script_in_system_terminal(repo_path: &str, script_file: &Path) -> Result<String, String> {
    let command_text = format!(
        "cd {} && bash -l {}",
        shell_single_quote(repo_path),
        shell_single_quote(&script_file.to_string_lossy())
    );

    let status = Command::new("x-terminal-emulator")
        .arg("-e")
        .arg(format!("bash -lc {}", shell_single_quote(&command_text)))
        .status()
        .map_err(|e| format!("启动系统终端失败: {}", e))?;

    if !status.success() {
        return Err("系统终端未能成功启动脚本".to_string());
    }

    Ok(format!("x-terminal-emulator: {}", command_text))
}

fn truncate_script_output(output: String) -> String {
    let normalized = output.trim().to_string();
    if normalized.chars().count() <= BUILD_SCRIPT_OUTPUT_LIMIT {
        return normalized;
    }
    let tail: String = normalized
        .chars()
        .rev()
        .take(BUILD_SCRIPT_OUTPUT_LIMIT)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    format!("...输出过长，已截断...\n{}", tail)
}

fn sanitize_script_output(output: String) -> String {
    let mut result = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            // Strip ANSI escape sequences.
            if let Some('[') = chars.peek().copied() {
                chars.next();
                for code in chars.by_ref() {
                    if ('@'..='~').contains(&code) {
                        break;
                    }
                }
            }
            continue;
        }

        if ch == '\u{8}' || ch == '\u{7f}' {
            continue;
        }
        if ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t' {
            continue;
        }

        result.push(ch);
    }

    result
}

async fn stream_script_reader<R>(
    mut reader: R,
    sender: mpsc::UnboundedSender<ScriptOutputMessage>,
    is_stderr: bool,
) where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0u8; 2048];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                let clean = sanitize_script_output(text);
                if !clean.is_empty() {
                    let _ = sender.send(ScriptOutputMessage::Chunk {
                        text: clean,
                        is_stderr,
                    });
                }
            }
            Err(_) => break,
        }
    }
    let _ = sender.send(ScriptOutputMessage::End { is_stderr });
}

fn now_readable() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn now_timestamp() -> String {
    use std::time::SystemTime;
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!("{}", millis)
}

fn normalize_optional_repo_script_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn apply_repo_update_fields(
    repo: &mut RepoConfig,
    sync_mode: Option<&str>,
    sync_interval: Option<u64>,
    auto_sync: Option<bool>,
    pull_strategy: Option<&str>,
    status: Option<&str>,
    post_sync_build_enabled: Option<bool>,
    post_sync_build_script: Option<&str>,
) {
    if let Some(v) = sync_mode {
        repo.sync_mode = v.to_string();
    }
    if let Some(v) = sync_interval {
        repo.sync_interval = v;
    }
    if let Some(v) = auto_sync {
        repo.auto_sync = v;
    }
    if let Some(v) = pull_strategy {
        repo.pull_strategy = v.to_string();
    }
    if let Some(v) = status {
        repo.status = v.to_string();
    }
    if let Some(v) = post_sync_build_enabled {
        repo.post_sync_build_enabled = v;
    }
    if let Some(v) = post_sync_build_script {
        repo.post_sync_build_script = normalize_optional_repo_script_path(v);
    }
}

fn normalize_git_metadata_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Debug)]
struct RepoGitMetadataRefresh {
    repo_id: String,
    repo_path: String,
    branch: Option<String>,
    remote: Option<Option<String>>,
}

fn normalize_repo_metadata_refresh_concurrency(
    metadata_concurrency: Option<usize>,
    repo_count: usize,
) -> usize {
    if repo_count == 0 {
        return 1;
    }

    metadata_concurrency
        .unwrap_or(REPO_METADATA_REFRESH_DEFAULT_CONCURRENCY)
        .clamp(1, REPO_METADATA_REFRESH_MAX_CONCURRENCY)
        .min(repo_count)
}

async fn is_git_repo_async(path: &str) -> bool {
    Path::new(path).join(".git").exists()
        || run_git_read_only_async_with_timeout(
            path,
            &["rev-parse", "--git-dir"],
            GIT_META_TIMEOUT_MS,
        )
        .await
        .is_ok()
}

async fn read_current_repo_branch_async(repo_path: &str) -> Option<String> {
    run_git_read_only_async_with_timeout(
        repo_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .ok()
    .and_then(|value| normalize_git_metadata_value(&value))
}

async fn read_current_repo_remote_async(repo_path: &str) -> Option<Option<String>> {
    let remote_names_output = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["remote"],
        GIT_META_TIMEOUT_MS,
    )
    .await;
    if is_git_output_error(&remote_names_output) {
        return None;
    }

    let remote_names = collect_trimmed_non_empty_lines(&remote_names_output);
    if remote_names.is_empty() {
        return Some(None);
    }

    let upstream_ref = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        GIT_META_TIMEOUT_MS,
    )
    .await;
    let upstream_ref = if is_git_output_error(&upstream_ref) {
        None
    } else {
        normalize_git_metadata_value(&upstream_ref)
    };
    let remote_name = choose_preferred_remote_name(&remote_names, upstream_ref.as_deref())?;
    let remote_url = run_git_read_only_async_with_timeout(
        repo_path,
        &["remote", "get-url", remote_name.as_str()],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .ok()
    .and_then(|value| normalize_git_metadata_value(&value));

    Some(remote_url)
}

async fn read_repo_git_metadata(repo: RepoConfig) -> RepoGitMetadataRefresh {
    if !is_git_repo_async(&repo.path).await {
        return RepoGitMetadataRefresh {
            repo_id: repo.id,
            repo_path: repo.path,
            branch: None,
            remote: None,
        };
    }

    let (branch, remote) = tokio::join!(
        read_current_repo_branch_async(&repo.path),
        read_current_repo_remote_async(&repo.path)
    );

    RepoGitMetadataRefresh {
        repo_id: repo.id,
        repo_path: repo.path,
        branch,
        remote,
    }
}

async fn refresh_repos_git_metadata_concurrently(
    repos_snapshot: Vec<RepoConfig>,
    metadata_concurrency: Option<usize>,
    state: &AppState,
) -> Vec<RepoGitMetadataRefresh> {
    if repos_snapshot.is_empty() {
        return Vec::new();
    }

    let concurrency =
        normalize_repo_metadata_refresh_concurrency(metadata_concurrency, repos_snapshot.len());
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let mut handles = Vec::with_capacity(repos_snapshot.len());

    for repo in repos_snapshot {
        let semaphore = Arc::clone(&semaphore);
        // Take the same per-repository lock the other git commands use, so a metadata
        // read cannot run git concurrently with get_repo_status on the same repository.
        let repo_lock = repo_git_lock(state, &repo.path).await;
        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok();
            let _repo_guard = match crate::repo_git_lock::acquire_read_from_lock(repo_lock).await {
                Ok(guard) => guard,
                Err(_) => {
                    return RepoGitMetadataRefresh {
                        repo_id: repo.id,
                        repo_path: repo.path,
                        branch: None,
                        remote: None,
                    }
                }
            };
            read_repo_git_metadata(repo).await
        }));
    }

    let mut metadata = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(result) = handle.await {
            metadata.push(result);
        }
    }

    metadata
}

fn apply_repo_git_metadata(
    repo: &mut RepoConfig,
    branch: Option<String>,
    remote: Option<Option<String>>,
) -> bool {
    let mut changed = false;

    if let Some(branch) = branch {
        if repo.branch != branch {
            repo.branch = branch;
            changed = true;
        }
    }

    if let Some(remote) = remote {
        if repo.remote != remote {
            repo.remote = remote;
            changed = true;
        }
    }

    changed
}

fn update_status(state: &State<'_, AppState>, repo_id: &str, status: &str) {
    let mut repos = state.repos.lock().unwrap();
    if let Some(repo) = repos.iter_mut().find(|r| r.id == repo_id) {
        repo.status = status.to_string();
    }
}

fn clear_last_error(state: &State<'_, AppState>, repo_id: &str) {
    let mut repos = state.repos.lock().unwrap();
    if let Some(repo) = repos.iter_mut().find(|r| r.id == repo_id) {
        repo.last_error = None;
        repo.error_logs.clear();
    }
}

fn get_repo_by_id(state: &AppState, repo_id: &str) -> Result<RepoConfig, String> {
    state
        .repos
        .lock()
        .unwrap()
        .iter()
        .find(|repo| repo.id == repo_id)
        .cloned()
        .ok_or("仓库不存在".to_string())
}

fn push_repo_error(state: &State<'_, AppState>, repo_id: &str, message: String) {
    let mut repos = state.repos.lock().unwrap();
    if let Some(repo) = repos.iter_mut().find(|r| r.id == repo_id) {
        repo.status = "error".to_string();
        repo.last_error = Some(message.clone());
        let entry = format!("[{}] {}", now_readable(), message);
        repo.error_logs.push(entry);

        const MAX_ERROR_LOGS: usize = 100;
        if repo.error_logs.len() > MAX_ERROR_LOGS {
            let overflow = repo.error_logs.len() - MAX_ERROR_LOGS;
            repo.error_logs.drain(0..overflow);
        }
    }
}

fn has_meaningful_output(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && !trimmed.starts_with("Error:")
}

fn is_conflict_error(message: &str) -> bool {
    message.contains("CONFLICT")
        || message.contains("conflict")
        || message.contains("Merge conflict")
}

fn is_push_rejected_by_remote_update(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("failed to push some refs")
}

async fn get_current_branch_async(repo_path: &str, timeout_ms: u64) -> Option<String> {
    match run_git_read_only_async_with_timeout(
        repo_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        timeout_ms,
    )
    .await
    {
        Ok(branch) if !branch.is_empty() && branch != "HEAD" => Some(branch),
        _ => None,
    }
}

async fn get_current_ahead_behind_async(repo_path: &str, timeout_ms: u64) -> (i32, i32) {
    let Some(branch) = get_current_branch_async(repo_path, timeout_ms).await else {
        return (0, 0);
    };
    get_branch_ahead_behind_async(repo_path, &branch, timeout_ms).await
}

async fn get_head_commit_async(repo_path: &str, timeout_ms: u64) -> Option<String> {
    match run_git_read_only_async_with_timeout(repo_path, &["rev-parse", "HEAD"], timeout_ms).await
    {
        Ok(head) if !head.is_empty() => Some(head),
        _ => None,
    }
}

fn normalize_merge_ref(merge_ref: &str) -> Option<String> {
    let trimmed = merge_ref.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix("refs/heads/") {
        if stripped.is_empty() {
            return None;
        }
        return Some(stripped.to_string());
    }
    Some(trimmed.to_string())
}

async fn get_pull_target_async(repo_path: &str, timeout_ms: u64) -> Option<(String, String)> {
    let branch = get_current_branch_async(repo_path, timeout_ms).await?;

    let remote_key = format!("branch.{}.remote", branch);
    let remote = run_git_read_only_async_with_timeout(
        repo_path,
        &["config", "--get", &remote_key],
        timeout_ms,
    )
    .await
    .ok()?;
    let remote = remote.trim().to_string();
    if remote.is_empty() {
        return None;
    }

    let merge_key = format!("branch.{}.merge", branch);
    let merge_output = run_git_read_only_async_with_timeout(
        repo_path,
        &["config", "--get-all", &merge_key],
        timeout_ms,
    )
    .await
    .ok()?;
    let merge_refs: Vec<String> = merge_output
        .lines()
        .filter_map(normalize_merge_ref)
        .collect();
    if merge_refs.is_empty() {
        return None;
    }

    let preferred_merge_ref = merge_refs
        .iter()
        .find(|merge_ref| merge_ref.as_str() == branch.as_str())
        .cloned()
        .or_else(|| merge_refs.first().cloned())?;

    Some((remote, preferred_merge_ref))
}

async fn remote_branch_exists_async(
    repo_path: &str,
    remote_name: &str,
    branch: &str,
    timeout_ms: u64,
) -> bool {
    let remote_ref = format!("refs/remotes/{}/{}", remote_name, branch);
    run_git_read_only_async_with_timeout(
        repo_path,
        &["show-ref", "--verify", "--quiet", &remote_ref],
        timeout_ms,
    )
    .await
    .is_ok()
}

async fn ensure_current_branch_upstream_async(repo_path: &str) -> Result<bool, String> {
    let Some(branch) = get_current_branch_async(repo_path, GIT_SYNC_MISC_TIMEOUT_MS).await else {
        return Ok(false);
    };
    if get_pull_target_async(repo_path, GIT_SYNC_MISC_TIMEOUT_MS)
        .await
        .is_some()
    {
        return Ok(false);
    }

    let Some(remote_name) =
        get_preferred_remote_name_async(repo_path, GIT_SYNC_MISC_TIMEOUT_MS).await
    else {
        return Err("当前分支没有 upstream，且仓库没有可用远端，无法同步。".to_string());
    };

    if remote_branch_exists_async(repo_path, &remote_name, &branch, GIT_SYNC_MISC_TIMEOUT_MS).await
    {
        let upstream_ref = format!("{}/{}", remote_name, branch);
        run_git_mutation_async_with_timeout(
            repo_path,
            &["branch", "--set-upstream-to", &upstream_ref, &branch],
            GIT_SYNC_MISC_TIMEOUT_MS,
        )
        .await
        .map(|_| false)
        .map_err(|e| format!("设置 upstream 失败: {}", e))
    } else {
        run_git_mutation_async_with_timeout(
            repo_path,
            &[
                "push",
                "--follow-tags",
                "--set-upstream",
                &remote_name,
                &branch,
            ],
            GIT_SYNC_PUSH_TIMEOUT_MS,
        )
        .await
        .map(|_| true)
        .map_err(|e| format!("发布当前分支失败: {}", e))
    }
}

async fn run_pull_with_strategy_async(repo_path: &str, pull_strategy: &str) -> Result<(), String> {
    let pull_target = get_pull_target_async(repo_path, GIT_SYNC_MISC_TIMEOUT_MS).await;
    let mut pull_args = match pull_strategy {
        "rebase" => vec!["pull", "--rebase", "--autostash"],
        _ => vec!["pull", "--no-edit"],
    };

    if let Some((remote, target_branch)) = pull_target.as_ref() {
        pull_args.push(remote.as_str());
        pull_args.push(target_branch.as_str());
    }

    run_git_mutation_async_with_timeout(repo_path, &pull_args, GIT_SYNC_PULL_TIMEOUT_MS)
        .await
        .map(|_| ())
}

async fn detect_did_pull_async(
    repo_path: &str,
    head_before_pull: &Option<String>,
    had_remote_commits_before_pull: bool,
    timeout_ms: u64,
) -> bool {
    let head_after_pull = get_head_commit_async(repo_path, timeout_ms).await;
    match (head_before_pull.as_ref(), head_after_pull.as_ref()) {
        (Some(before), Some(after)) => before != after,
        _ => had_remote_commits_before_pull,
    }
}

async fn collect_conflict_files_async(repo_path: &str, timeout_ms: u64) -> Vec<String> {
    run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["diff", "--name-only", "--diff-filter=U"],
        timeout_ms,
    )
    .await
    .lines()
    .filter(|line| !line.is_empty())
    .map(|line| line.to_string())
    .collect()
}

fn mark_sync_success(
    state: &State<'_, AppState>,
    repo_id: &str,
    message: String,
    did_pull: bool,
    did_push: bool,
) -> SyncResult {
    let now = now_timestamp();
    {
        let mut repos = state.repos.lock().unwrap();
        if let Some(repo) = repos.iter_mut().find(|r| r.id == repo_id) {
            repo.status = "idle".to_string();
            repo.last_sync_at = Some(now);
        }
    }
    clear_last_error(state, repo_id);
    state.save();
    SyncResult {
        success: true,
        message,
        conflict: false,
        conflict_files: vec![],
        did_pull,
        did_push,
    }
}

fn create_sync_failure(message: String) -> SyncResult {
    SyncResult {
        success: false,
        message,
        conflict: false,
        conflict_files: vec![],
        did_pull: false,
        did_push: false,
    }
}

fn create_sync_conflict(message: String, conflict_files: Vec<String>) -> SyncResult {
    SyncResult {
        success: false,
        message,
        conflict: true,
        conflict_files,
        did_pull: false,
        did_push: false,
    }
}

fn mark_sync_failure(state: &State<'_, AppState>, repo_id: &str, message: String) -> SyncResult {
    push_repo_error(state, repo_id, message.clone());
    state.save();
    create_sync_failure(message)
}

async fn sync_repo_changed_only_inner(
    repo_id: &str,
    state: &State<'_, AppState>,
    path: &str,
    pull_strategy: &str,
) -> Result<SyncResult, String> {
    let mut did_push = match ensure_current_branch_upstream_async(path).await {
        Ok(value) => value,
        Err(e) => return Ok(mark_sync_failure(state, repo_id, e)),
    };
    let (mut ahead, mut behind) =
        get_current_ahead_behind_async(path, GIT_SYNC_MISC_TIMEOUT_MS).await;

    if ahead <= 0 && behind <= 0 {
        if did_push {
            return Ok(mark_sync_success(
                state,
                repo_id,
                "当前分支已发布到远端".to_string(),
                false,
                true,
            ));
        }
        return Ok(mark_sync_success(
            state,
            repo_id,
            "无未推送或未拉取提交，已跳过同步".to_string(),
            false,
            false,
        ));
    }

    let mut did_pull = false;
    let mut should_pull_after_push = false;
    if ahead > 0 {
        if let Err(e) = run_git_mutation_async_with_timeout(
            path,
            GIT_PUSH_WITH_TAGS_ARGS,
            GIT_SYNC_PUSH_TIMEOUT_MS,
        )
        .await
        {
            if is_push_rejected_by_remote_update(&e) {
                should_pull_after_push = true;
            } else {
                return Ok(mark_sync_failure(
                    state,
                    repo_id,
                    format!("Push 失败: {}", e),
                ));
            }
        } else {
            did_push = true;
        }
        let counts = get_current_ahead_behind_async(path, GIT_SYNC_MISC_TIMEOUT_MS).await;
        ahead = counts.0;
        behind = counts.1;
    }

    let needs_pull = should_pull_after_push || behind > 0;
    if needs_pull {
        let had_remote_commits_before_pull = behind > 0;
        let head_before_pull = get_head_commit_async(path, GIT_SYNC_MISC_TIMEOUT_MS).await;
        match run_pull_with_strategy_async(path, pull_strategy).await {
            Ok(_) => {
                did_pull = detect_did_pull_async(
                    path,
                    &head_before_pull,
                    had_remote_commits_before_pull,
                    GIT_SYNC_MISC_TIMEOUT_MS,
                )
                .await;
            }
            Err(e) => {
                if is_conflict_error(&e) {
                    let conflict_files =
                        collect_conflict_files_async(path, GIT_SYNC_MISC_TIMEOUT_MS).await;
                    update_status(state, repo_id, "conflict");
                    return Ok(create_sync_conflict(
                        "存在合并冲突".to_string(),
                        conflict_files,
                    ));
                }
                return Ok(mark_sync_failure(
                    state,
                    repo_id,
                    format!("Pull 失败: {}", e),
                ));
            }
        }
        let counts = get_current_ahead_behind_async(path, GIT_SYNC_MISC_TIMEOUT_MS).await;
        ahead = counts.0;
    }

    if ahead > 0 {
        if let Err(e) = run_git_mutation_async_with_timeout(
            path,
            GIT_PUSH_WITH_TAGS_ARGS,
            GIT_SYNC_PUSH_TIMEOUT_MS,
        )
        .await
        {
            return Ok(mark_sync_failure(
                state,
                repo_id,
                format!("Push 失败: {}", e),
            ));
        } else {
            did_push = true;
        }
    }

    Ok(mark_sync_success(
        state,
        repo_id,
        "按改动同步完成".to_string(),
        did_pull,
        did_push,
    ))
}

fn parse_ahead_behind_counts(value: &str) -> (i32, i32) {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 2 {
        return (0, 0);
    }
    let ahead = parts[0].parse().unwrap_or(0);
    let behind = parts[1].parse().unwrap_or(0);
    (ahead, behind)
}

fn is_git_output_error(output: &str) -> bool {
    output.starts_with("Error:") || output.starts_with("fatal:")
}

fn collect_trimmed_non_empty_lines(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

fn parse_remote_name_from_tracking_ref(
    upstream_ref: &str,
    remote_names: &[String],
) -> Option<String> {
    let upstream = upstream_ref.trim();
    if upstream.is_empty() {
        return None;
    }

    remote_names
        .iter()
        .filter(|remote| {
            let prefix = format!("{}/", remote);
            upstream.starts_with(prefix.as_str())
        })
        .max_by_key(|remote| remote.len())
        .cloned()
}

fn choose_preferred_remote_name(
    remote_names: &[String],
    upstream_ref: Option<&str>,
) -> Option<String> {
    if remote_names.is_empty() {
        return None;
    }

    if let Some(upstream) = upstream_ref {
        if let Some(remote_name) = parse_remote_name_from_tracking_ref(upstream, remote_names) {
            return Some(remote_name);
        }
    }

    remote_names
        .iter()
        .find(|remote| remote.as_str() == "origin")
        .cloned()
        .or_else(|| remote_names.first().cloned())
}

fn get_preferred_remote_name(repo_path: &str) -> Option<String> {
    let remote_names_output = run_git_allow_fail_read_only(repo_path, &["remote"]);
    if is_git_output_error(&remote_names_output) {
        return None;
    }
    let remote_names = collect_trimmed_non_empty_lines(&remote_names_output);
    if remote_names.is_empty() {
        return None;
    }

    let upstream_output = run_git_allow_fail_read_only(
        repo_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    let upstream_ref = if is_git_output_error(&upstream_output) {
        None
    } else {
        let trimmed = upstream_output.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    };

    choose_preferred_remote_name(&remote_names, upstream_ref)
}

async fn get_preferred_remote_name_async(repo_path: &str, timeout_ms: u64) -> Option<String> {
    let remote_names_output =
        run_git_allow_fail_read_only_async_with_timeout(repo_path, &["remote"], timeout_ms).await;
    if is_git_output_error(&remote_names_output) {
        return None;
    }
    let remote_names = collect_trimmed_non_empty_lines(&remote_names_output);
    if remote_names.is_empty() {
        return None;
    }

    let upstream_output = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        timeout_ms,
    )
    .await;
    let upstream_ref = if is_git_output_error(&upstream_output) {
        None
    } else {
        let trimmed = upstream_output.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    };

    choose_preferred_remote_name(&remote_names, upstream_ref)
}

fn is_unmerged_porcelain_status_line(line: &str) -> bool {
    matches!(
        line.get(0..2),
        Some("DD") | Some("AU") | Some("UD") | Some("UA") | Some("DU") | Some("AA") | Some("UU")
    )
}

fn branch_comparison(
    state: &'static str,
    ahead: i32,
    behind: i32,
    error: Option<String>,
) -> BranchComparison {
    BranchComparison {
        state,
        ahead,
        behind,
        error,
    }
}

fn short_hash(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(7).collect())
}

fn format_detached_branch_name(head_hash: Option<&str>) -> String {
    match head_hash.and_then(short_hash) {
        Some(hash) => format!("HEAD @ {}", hash),
        None => "detached HEAD".to_string(),
    }
}

fn is_no_upstream_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("no upstream configured")
        || lower.contains("no tracking information")
        || lower.contains("does not point to a branch")
        || lower.contains("没有上游")
}

fn is_upstream_gone_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("upstream branch")
        && (lower.contains("gone") || lower.contains("does not exist"))
        || lower.contains("上游分支")
}

async fn get_remote_names_async(repo_path: &str, timeout_ms: u64) -> Vec<String> {
    let output =
        run_git_allow_fail_read_only_async_with_timeout(repo_path, &["remote"], timeout_ms).await;
    if is_git_output_error(&output) {
        return Vec::new();
    }
    collect_trimmed_non_empty_lines(&output)
}

fn parse_remote_branch_ref(
    short_ref: &str,
    full_ref: &str,
    remote_names: &[String],
) -> Option<RemoteBranchRef> {
    let short_ref = short_ref.trim();
    if short_ref.is_empty() || short_ref.ends_with("/HEAD") {
        return None;
    }
    let remote_name = parse_remote_name_from_tracking_ref(short_ref, remote_names)?;
    let prefix = format!("{}/", remote_name);
    let branch_name = short_ref.strip_prefix(prefix.as_str())?.trim();
    if branch_name.is_empty() || branch_name == "HEAD" {
        return None;
    }
    Some(RemoteBranchRef {
        remote_name,
        branch_name: branch_name.to_string(),
        short_ref: short_ref.to_string(),
        full_ref: full_ref.trim().to_string(),
        head_hash: None,
    })
}

fn normalize_full_ref(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

async fn ref_exists_async(repo_path: &str, full_ref: &str, timeout_ms: u64) -> bool {
    run_git_read_only_async_with_timeout(
        repo_path,
        &["show-ref", "--verify", "--quiet", full_ref],
        timeout_ms,
    )
    .await
    .is_ok()
}

async fn get_current_head_info_async(repo_path: &str, timeout_ms: u64) -> CurrentHeadInfo {
    let branch_output = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        timeout_ms,
    )
    .await;
    let head_hash =
        run_git_read_only_async_with_timeout(repo_path, &["rev-parse", "HEAD"], timeout_ms)
            .await
            .ok()
            .and_then(|value| normalize_git_metadata_value(&value));
    let branch = if is_git_output_error(&branch_output) {
        None
    } else {
        normalize_git_metadata_value(&branch_output)
    };
    let detached_head = branch.as_deref() == Some("HEAD");

    CurrentHeadInfo {
        branch: if detached_head { None } else { branch },
        detached_head,
        head_hash,
    }
}

async fn get_branch_upstream_config_async(
    repo_path: &str,
    branch: &str,
    timeout_ms: u64,
) -> Result<Option<BranchUpstream>, String> {
    let branch = branch.trim();
    if branch.is_empty() || branch == "HEAD" {
        return Ok(None);
    }

    let remote_key = format!("branch.{}.remote", branch);
    let remote_output = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["config", "--get", &remote_key],
        timeout_ms,
    )
    .await;
    if is_git_output_error(&remote_output) {
        return Err(remote_output);
    }
    let Some(remote_name) = normalize_git_metadata_value(&remote_output) else {
        return Ok(None);
    };

    let merge_key = format!("branch.{}.merge", branch);
    let merge_output = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["config", "--get", &merge_key],
        timeout_ms,
    )
    .await;
    if is_git_output_error(&merge_output) {
        return Err(merge_output);
    }
    let Some(merge_branch) =
        normalize_git_metadata_value(&merge_output).and_then(|value| normalize_merge_ref(&value))
    else {
        return Ok(None);
    };

    if remote_name == "." {
        let full_ref = format!("refs/heads/{}", merge_branch);
        return Ok(Some(BranchUpstream {
            remote_name,
            short_ref: merge_branch,
            full_ref,
        }));
    }

    Ok(Some(BranchUpstream {
        short_ref: format!("{}/{}", remote_name, merge_branch),
        full_ref: format!("refs/remotes/{}/{}", remote_name, merge_branch),
        remote_name,
    }))
}

async fn compare_refs_async(
    repo_path: &str,
    lhs_ref: &str,
    rhs_ref: &str,
    timeout_ms: u64,
) -> BranchComparison {
    let target = format!("{}...{}", lhs_ref, rhs_ref);
    match run_git_read_only_async_with_timeout(
        repo_path,
        &["rev-list", "--left-right", "--count", &target],
        timeout_ms,
    )
    .await
    {
        Ok(output) => {
            let (ahead, behind) = parse_ahead_behind_counts(&output);
            branch_comparison(BRANCH_COMPARISON_OK, ahead, behind, None)
        }
        Err(error) => branch_comparison(BRANCH_COMPARISON_ERROR, 0, 0, Some(error)),
    }
}

async fn compare_local_branch_to_upstream_async(
    repo_path: &str,
    branch: &str,
    timeout_ms: u64,
) -> (BranchComparison, Option<BranchUpstream>) {
    let upstream = match get_branch_upstream_config_async(repo_path, branch, timeout_ms).await {
        Ok(value) => value,
        Err(error) => {
            if is_no_upstream_error(&error) {
                return (
                    branch_comparison(BRANCH_COMPARISON_NO_UPSTREAM, 0, 0, None),
                    None,
                );
            }
            if is_upstream_gone_error(&error) {
                return (
                    branch_comparison(BRANCH_COMPARISON_UPSTREAM_GONE, 0, 0, Some(error)),
                    None,
                );
            }
            return (
                branch_comparison(BRANCH_COMPARISON_ERROR, 0, 0, Some(error)),
                None,
            );
        }
    };

    let Some(upstream) = upstream else {
        return (
            branch_comparison(BRANCH_COMPARISON_NO_UPSTREAM, 0, 0, None),
            None,
        );
    };

    if !ref_exists_async(repo_path, &upstream.full_ref, timeout_ms).await {
        return (
            branch_comparison(
                BRANCH_COMPARISON_UPSTREAM_GONE,
                0,
                0,
                Some(format!("上游已删除: {}", upstream.short_ref)),
            ),
            Some(upstream),
        );
    }

    (
        compare_refs_async(repo_path, branch, &upstream.short_ref, timeout_ms).await,
        Some(upstream),
    )
}

async fn read_checked_out_branch_worktrees_async(
    repo_path: &str,
    timeout_ms: u64,
) -> HashMap<String, String> {
    let current_root = run_git_read_only_async_with_timeout(
        repo_path,
        &["rev-parse", "--show-toplevel"],
        timeout_ms,
    )
    .await
    .ok()
    .and_then(|value| normalize_git_metadata_value(&value));
    let current_root_key = current_root.as_deref().map(normalize_repo_lock_key);
    let output = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["worktree", "list", "--porcelain"],
        timeout_ms,
    )
    .await;
    if is_git_output_error(&output) {
        return HashMap::new();
    }

    let mut result = HashMap::new();
    let mut worktree_path = String::new();
    let mut branch_name = String::new();
    let flush_record = |result: &mut HashMap<String, String>, path: &str, branch: &str| {
        if path.trim().is_empty() || branch.trim().is_empty() {
            return;
        }
        let path_key = normalize_repo_lock_key(path.trim());
        if current_root_key
            .as_deref()
            .map(|root| root == path_key.as_str())
            .unwrap_or(false)
        {
            return;
        }
        result.insert(branch.trim().to_string(), path.trim().to_string());
    };

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            flush_record(&mut result, &worktree_path, &branch_name);
            worktree_path.clear();
            branch_name.clear();
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            worktree_path = path.trim().to_string();
            continue;
        }
        if let Some(branch_ref) = line.strip_prefix("branch refs/heads/") {
            branch_name = branch_ref.trim().to_string();
        }
    }
    flush_record(&mut result, &worktree_path, &branch_name);

    result
}

fn find_unique_same_name_remote<'a>(
    remote_refs: &'a [RemoteBranchRef],
    branch_name: &str,
) -> Option<&'a RemoteBranchRef> {
    let mut matches = remote_refs
        .iter()
        .filter(|item| item.branch_name == branch_name);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first)
}

async fn parse_remote_branch_arg_async(
    repo_path: &str,
    remote_branch: &str,
    timeout_ms: u64,
) -> Result<RemoteBranchRef, String> {
    let remote_names = get_remote_names_async(repo_path, timeout_ms).await;
    if remote_names.is_empty() {
        return Err("仓库没有可用远端".to_string());
    }
    let trimmed = remote_branch.trim();
    let Some(remote_name) = parse_remote_name_from_tracking_ref(trimmed, &remote_names) else {
        return Err(format!("远端分支名称无效: {}", trimmed));
    };
    let prefix = format!("{}/", remote_name);
    let branch_name = trimmed
        .strip_prefix(prefix.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "HEAD")
        .ok_or_else(|| format!("远端分支名称无效: {}", trimmed))?;
    Ok(RemoteBranchRef {
        remote_name: remote_name.clone(),
        branch_name: branch_name.to_string(),
        short_ref: trimmed.to_string(),
        full_ref: format!("refs/remotes/{}/{}", remote_name, branch_name),
        head_hash: None,
    })
}

fn branch_operation_result(
    switched: bool,
    branch: String,
    tracked: bool,
    tracking_remote: Option<String>,
    message: String,
) -> BranchOperationResult {
    BranchOperationResult {
        switched,
        branch,
        tracked,
        tracking_remote,
        status_refreshed: false,
        remote_fetched: false,
        warning: None,
        message,
    }
}

async fn get_branch_ahead_behind_async(
    repo_path: &str,
    branch: &str,
    timeout_ms: u64,
) -> (i32, i32) {
    let (comparison, _) =
        compare_local_branch_to_upstream_async(repo_path, branch, timeout_ms).await;
    (comparison.ahead, comparison.behind)
}

/// 检查工作区是否有未提交的改动
async fn has_local_changes_async(repo_path: &str) -> bool {
    let st = run_git_allow_fail_read_only_async_with_timeout(
        repo_path,
        &["status", "--porcelain"],
        GIT_SYNC_MISC_TIMEOUT_MS,
    )
    .await;
    !st.is_empty() && !st.starts_with("Error")
}

// ==================== Tauri 命令 ====================

#[tauri::command]
pub fn is_git_repo(path: String) -> bool {
    Path::new(&path).join(".git").exists()
        || run_git_read_only(&path, &["rev-parse", "--git-dir"]).is_ok()
}

#[tauri::command]
pub fn open_repo_directory(path: String) -> Result<bool, String> {
    ensure_repo_path(&path)?;
    open_directory_default(&path)
}

#[tauri::command]
pub fn open_repo_directory_with_app(path: String, app: String) -> Result<bool, String> {
    ensure_repo_path(&path)?;
    let app_value = app.trim();
    if app_value.is_empty() {
        return Err("应用路径不能为空".to_string());
    }
    open_directory_with_app(&path, app_value)
}

#[tauri::command]
pub async fn get_repo_status(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepoStatus, String> {
    get_repo_status_inner(path, &state).await
}

async fn get_repo_status_inner(path: String, state: &AppState) -> Result<RepoStatus, String> {
    ensure_repo_path(&path)?;
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &path).await?;

    let head_future = get_current_head_info_async(&path, GIT_META_TIMEOUT_MS);
    let status_future = run_git_read_only_async_with_timeout(
        &path,
        &["status", "--porcelain"],
        GIT_STATUS_TIMEOUT_MS,
    );
    let last_commit_future = run_git_read_only_async_with_timeout(
        &path,
        &["log", "-1", "--format=%h|%s|%ai|%an"],
        GIT_META_TIMEOUT_MS,
    );

    let (head_info, status_result, last_commit_result) =
        tokio::join!(head_future, status_future, last_commit_future);

    let branch = head_info.branch.clone().unwrap_or_else(|| {
        if head_info.detached_head {
            format_detached_branch_name(head_info.head_hash.as_deref())
        } else {
            "unknown".to_string()
        }
    });
    // A `git status` watchdog expiry is not a repository failure: it means the
    // working tree could not be read in time. Keep everything else we already
    // have and mark the gap, instead of discarding head/upstream/commit data.
    let (status_output, status_timed_out) = match status_result {
        Ok(output) => (output, false),
        Err(error) if crate::git_timeouts::is_timeout_error(&error) => (String::new(), true),
        Err(error) => return Err(format!("读取工作区状态失败: {}", error)),
    };

    let modified: Vec<String> = if status_timed_out {
        Vec::new()
    } else {
        status_output
            .lines()
            .filter(|l| !l.is_empty() && l.len() > 3)
            .map(|l| l[3..].to_string())
            .collect()
    };

    let is_clean = !status_timed_out && modified.is_empty();

    let (comparison, upstream) = if head_info.detached_head {
        (
            branch_comparison(BRANCH_COMPARISON_DETACHED, 0, 0, None),
            None,
        )
    } else if let Some(branch_name) = head_info.branch.as_deref() {
        compare_local_branch_to_upstream_async(&path, branch_name, GIT_META_TIMEOUT_MS).await
    } else {
        (
            branch_comparison(
                BRANCH_COMPARISON_ERROR,
                0,
                0,
                Some("无法读取当前分支".to_string()),
            ),
            None,
        )
    };
    let needs_upstream_publish = matches!(
        comparison.state,
        BRANCH_COMPARISON_NO_UPSTREAM | BRANCH_COMPARISON_UPSTREAM_GONE
    );

    let conflicted: Vec<String> = status_output
        .lines()
        .filter(|l| is_unmerged_porcelain_status_line(l))
        .filter(|l| l.len() > 3)
        .map(|l| l[3..].to_string())
        .collect();

    let last_commit = last_commit_result.ok().and_then(|log| {
        let parts: Vec<&str> = log.splitn(4, '|').collect();
        if parts.len() == 4 {
            Some(CommitInfo {
                hash: parts[0].to_string(),
                message: parts[1].to_string(),
                date: parts[2].to_string(),
                author: parts[3].to_string(),
            })
        } else {
            None
        }
    });

    Ok(RepoStatus {
        branch,
        is_clean,
        modified,
        ahead: comparison.ahead,
        behind: comparison.behind,
        comparison_state: comparison.state.to_string(),
        comparison_error: comparison.error,
        upstream: upstream.map(|item| item.short_ref),
        needs_upstream_publish,
        detached_head: head_info.detached_head,
        head_hash: head_info.head_hash,
        conflicted,
        last_commit,
        status_timed_out,
    })
}

#[tauri::command]
pub async fn refresh_repo_remote(path: String, state: State<'_, AppState>) -> Result<bool, String> {
    ensure_repo_path(&path)?;
    let _repo_git_guard = acquire_repo_git_guard(&state, &path).await?;

    run_git_mutation_async_with_timeout(
        &path,
        &["fetch", "--all", "--prune"],
        GIT_SYNC_FETCH_TIMEOUT_MS,
    )
    .await
    .map(|_| true)
    .map_err(|e| format!("刷新远程信息失败: {}", e))
}

#[tauri::command]
pub async fn get_repo_branch_overview(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepoBranchOverview, String> {
    get_repo_branch_overview_inner(path, &state).await
}

async fn get_repo_branch_overview_inner(
    path: String,
    state: &AppState,
) -> Result<RepoBranchOverview, String> {
    ensure_repo_path(&path)?;
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &path).await?;
    let preferred_remote_name =
        get_preferred_remote_name_async(&path, GIT_BRANCH_OVERVIEW_TIMEOUT_MS).await;
    let remote_names = get_remote_names_async(&path, GIT_BRANCH_OVERVIEW_TIMEOUT_MS).await;
    let current_head = get_current_head_info_async(&path, GIT_BRANCH_OVERVIEW_TIMEOUT_MS).await;
    let worktree_paths =
        read_checked_out_branch_worktrees_async(&path, GIT_BRANCH_OVERVIEW_TIMEOUT_MS).await;

    let local_branches_future = run_git_read_only_async_with_timeout(
        &path,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(upstream:short)\t%(objectname)",
            "refs/heads",
        ],
        GIT_BRANCH_OVERVIEW_TIMEOUT_MS,
    );
    let remote_branches_future = run_git_allow_fail_read_only_async_with_timeout(
        &path,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(refname)\t%(objectname)",
            "refs/remotes",
        ],
        GIT_BRANCH_OVERVIEW_TIMEOUT_MS,
    );
    let (local_branches_output, remote_branches_output) =
        tokio::join!(local_branches_future, remote_branches_future);
    let local_branches_output =
        local_branches_output.map_err(|e| format!("读取本地分支失败: {}", e))?;
    if is_git_output_error(&remote_branches_output) {
        return Err(format!("读取远端分支失败: {}", remote_branches_output));
    }

    let mut remote_refs: Vec<RemoteBranchRef> = Vec::new();
    for line in collect_trimmed_non_empty_lines(&remote_branches_output) {
        let mut parts = line.splitn(3, '\t');
        let short_ref = parts.next().unwrap_or("").trim();
        let full_ref = parts.next().unwrap_or("").trim();
        let object_hash = normalize_git_metadata_value(parts.next().unwrap_or(""));
        if let Some(remote_ref) = parse_remote_branch_ref(short_ref, full_ref, &remote_names) {
            let mut remote_ref = remote_ref;
            if let Some(hash) = object_hash {
                remote_ref.head_hash = Some(hash);
            }
            remote_refs.push(remote_ref);
        }
    }

    let mut branch_map: HashMap<String, RepoBranchInfo> = HashMap::new();
    let mut local_branch_names: HashSet<String> = HashSet::new();

    for line in local_branches_output.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let mut parts = line.splitn(3, '\t');
        let name = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }

        let upstream_text = parts.next().unwrap_or("").trim().to_string();
        let object_hash = normalize_git_metadata_value(parts.next().unwrap_or(""));
        local_branch_names.insert(name.clone());

        let is_current = current_head.branch.as_deref() == Some(name.as_str());
        let (comparison, upstream_config) =
            compare_local_branch_to_upstream_async(&path, &name, GIT_BRANCH_OVERVIEW_TIMEOUT_MS)
                .await;
        let same_name_remote = find_unique_same_name_remote(&remote_refs, &name);
        let upstream = upstream_config
            .as_ref()
            .map(|item| item.short_ref.clone())
            .or_else(|| normalize_full_ref(&upstream_text));
        let rebind_upstream = if comparison.state == BRANCH_COMPARISON_UPSTREAM_GONE {
            same_name_remote.map(|item| item.short_ref.clone())
        } else {
            None
        };
        let checked_out_path = worktree_paths.get(&name).cloned();

        branch_map.insert(
            name.clone(),
            RepoBranchInfo {
                identity: format!("local:{}", name),
                name: name.clone(),
                local_name: Some(name.clone()),
                is_current,
                has_local: true,
                has_remote: upstream.is_some()
                    || remote_refs
                        .iter()
                        .any(|remote_ref| remote_ref.branch_name == name),
                upstream,
                ahead: comparison.ahead,
                behind: comparison.behind,
                is_remote_only: false,
                remote_name: upstream_config
                    .as_ref()
                    .and_then(|item| {
                        if item.remote_name == "." {
                            None
                        } else {
                            Some(item.remote_name.clone())
                        }
                    })
                    .or_else(|| same_name_remote.map(|item| item.remote_name.clone())),
                full_ref: Some(format!("refs/heads/{}", name)),
                comparison_state: comparison.state.to_string(),
                comparison_error: comparison.error,
                detached_head: false,
                head_hash: object_hash,
                upstream_gone: comparison.state == BRANCH_COMPARISON_UPSTREAM_GONE,
                rebind_upstream,
                is_checked_out_elsewhere: checked_out_path.is_some(),
                worktree_path: checked_out_path,
            },
        );
    }

    for remote_ref in &remote_refs {
        let has_local_branch = local_branch_names.contains(&remote_ref.branch_name);
        if has_local_branch {
            if let Some(item) = branch_map.get_mut(&remote_ref.branch_name) {
                item.has_remote = true;
            }
        }
        branch_map.insert(
            format!("remote:{}", remote_ref.full_ref),
            RepoBranchInfo {
                identity: format!("remote:{}", remote_ref.full_ref),
                name: remote_ref.short_ref.clone(),
                local_name: Some(remote_ref.branch_name.clone()),
                is_current: false,
                has_local: has_local_branch,
                has_remote: true,
                upstream: Some(remote_ref.short_ref.clone()),
                ahead: 0,
                behind: 0,
                is_remote_only: !has_local_branch,
                remote_name: Some(remote_ref.remote_name.clone()),
                full_ref: Some(remote_ref.full_ref.clone()),
                comparison_state: if has_local_branch {
                    BRANCH_COMPARISON_OK.to_string()
                } else {
                    BRANCH_COMPARISON_REMOTE_ONLY.to_string()
                },
                comparison_error: None,
                detached_head: false,
                head_hash: remote_ref.head_hash.clone(),
                upstream_gone: false,
                rebind_upstream: None,
                is_checked_out_elsewhere: false,
                worktree_path: None,
            },
        );
    }

    if current_head.detached_head {
        let display_name = format_detached_branch_name(current_head.head_hash.as_deref());
        branch_map.insert(
            "detached:HEAD".to_string(),
            RepoBranchInfo {
                identity: "detached:HEAD".to_string(),
                name: display_name,
                local_name: None,
                is_current: true,
                has_local: false,
                has_remote: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                is_remote_only: false,
                remote_name: None,
                full_ref: None,
                comparison_state: BRANCH_COMPARISON_DETACHED.to_string(),
                comparison_error: None,
                detached_head: true,
                head_hash: current_head.head_hash.clone(),
                upstream_gone: false,
                rebind_upstream: None,
                is_checked_out_elsewhere: false,
                worktree_path: None,
            },
        );
    }

    let mut branches: Vec<RepoBranchInfo> = branch_map.into_values().collect();
    branches.sort_by(|a, b| {
        let a_has_updates = a.is_remote_only
            || a.behind > 0
            || a.upstream_gone
            || a.comparison_state == BRANCH_COMPARISON_ERROR;
        let b_has_updates = b.is_remote_only
            || b.behind > 0
            || b.upstream_gone
            || b.comparison_state == BRANCH_COMPARISON_ERROR;

        b.is_current
            .cmp(&a.is_current)
            .then_with(|| b_has_updates.cmp(&a_has_updates))
            .then_with(|| b.has_local.cmp(&a.has_local))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });

    let local_branch_count = local_branch_names.len();
    let remote_branch_count = remote_refs.len();
    let remote_only_count = branches.iter().filter(|item| item.is_remote_only).count();
    let ahead_branch_count = branches.iter().filter(|item| item.ahead > 0).count();
    let behind_branch_count = branches.iter().filter(|item| item.behind > 0).count();
    let divergent_branch_count = branches
        .iter()
        .filter(|item| item.ahead > 0 && item.behind > 0)
        .count();
    let updated_branch_count = branches
        .iter()
        .filter(|item| {
            item.is_remote_only
                || item.behind > 0
                || item.upstream_gone
                || item.comparison_state == BRANCH_COMPARISON_ERROR
        })
        .count();
    let upstream_gone_count = branches.iter().filter(|item| item.upstream_gone).count();
    let no_upstream_count = branches
        .iter()
        .filter(|item| item.comparison_state == BRANCH_COMPARISON_NO_UPSTREAM)
        .count();
    let comparison_error_count = branches
        .iter()
        .filter(|item| item.comparison_state == BRANCH_COMPARISON_ERROR)
        .count();
    let checked_out_elsewhere_count = branches
        .iter()
        .filter(|item| item.is_checked_out_elsewhere)
        .count();
    let current_branch = current_head
        .branch
        .clone()
        .unwrap_or_else(|| format_detached_branch_name(current_head.head_hash.as_deref()));

    Ok(RepoBranchOverview {
        current_branch,
        detached_head: current_head.detached_head,
        head_hash: current_head.head_hash,
        preferred_remote: preferred_remote_name,
        local_branch_count,
        remote_branch_count,
        remote_only_count,
        ahead_branch_count,
        behind_branch_count,
        updated_branch_count,
        divergent_branch_count,
        upstream_gone_count,
        no_upstream_count,
        comparison_error_count,
        checked_out_elsewhere_count,
        branches,
    })
}

async fn ensure_clean_worktree_for_branch_switch(path: &str) -> Result<(), String> {
    let local_status_output = run_git_read_only_async_with_timeout(
        path,
        &["status", "--porcelain"],
        GIT_STATUS_TIMEOUT_MS,
    )
    .await
    .map_err(|e| format!("无法确认工作区状态，已取消分支切换: {}", e))?;
    if local_status_output.trim().is_empty() {
        return Ok(());
    }
    Err("工作区或暂存区存在未提交改动，请先提交、stash 或清理后再切换分支。".to_string())
}

async fn ensure_branch_not_checked_out_elsewhere(
    path: &str,
    target_branch: &str,
) -> Result<(), String> {
    if let Some(worktree_path) =
        read_checked_out_branch_worktrees_async(path, GIT_SYNC_MISC_TIMEOUT_MS)
            .await
            .get(target_branch)
            .cloned()
    {
        return Err(format!("该分支已在另一个 worktree 检出: {}", worktree_path));
    }
    Ok(())
}

#[tauri::command]
pub async fn switch_repo_branch(
    path: String,
    branch: String,
    remote_branch: Option<String>,
    state: State<'_, AppState>,
) -> Result<BranchOperationResult, String> {
    switch_repo_branch_inner(path, branch, remote_branch, &state).await
}

async fn switch_repo_branch_inner(
    path: String,
    branch: String,
    remote_branch: Option<String>,
    state: &AppState,
) -> Result<BranchOperationResult, String> {
    ensure_repo_path(&path)?;
    let target_branch = branch.trim();
    let target_remote_branch = remote_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if target_branch.is_empty() && target_remote_branch.is_none() {
        return Err("分支名称不能为空".to_string());
    }
    if target_branch == "HEAD" {
        return Err("无法切换到 HEAD".to_string());
    }

    let _repo_git_guard = acquire_repo_git_guard(&state, &path).await?;

    ensure_clean_worktree_for_branch_switch(&path).await?;

    if let Some(remote_branch) = target_remote_branch {
        let remote_ref =
            parse_remote_branch_arg_async(&path, remote_branch, GIT_SYNC_MISC_TIMEOUT_MS).await?;
        if !ref_exists_async(&path, &remote_ref.full_ref, GIT_SYNC_MISC_TIMEOUT_MS).await {
            return Err(format!("远端分支不存在: {}", remote_ref.short_ref));
        }
        let local_ref = format!("refs/heads/{}", remote_ref.branch_name);
        if ref_exists_async(&path, &local_ref, GIT_SYNC_MISC_TIMEOUT_MS).await {
            return Err(format!("本地分支已存在: {}", remote_ref.branch_name));
        }

        run_git_mutation_async_with_timeout(
            &path,
            &["switch", "--track", &remote_ref.short_ref],
            GIT_SYNC_MISC_TIMEOUT_MS,
        )
        .await
        .map_err(|e| format!("切换分支失败: {}", e))?;

        return Ok(branch_operation_result(
            true,
            remote_ref.branch_name,
            true,
            Some(remote_ref.remote_name.clone()),
            format!("已切换并跟踪 {}", remote_ref.short_ref),
        ));
    }

    if let Ok(current_branch) = run_git_read_only_async_with_timeout(
        &path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    {
        if current_branch.trim() == target_branch {
            return Ok(branch_operation_result(
                false,
                target_branch.to_string(),
                false,
                None,
                format!("已在当前分支 {}", target_branch),
            ));
        }
    }

    let local_ref = format!("refs/heads/{}", target_branch);
    let has_local_branch = ref_exists_async(&path, &local_ref, GIT_META_TIMEOUT_MS).await;

    if has_local_branch {
        ensure_branch_not_checked_out_elsewhere(&path, target_branch).await?;

        run_git_mutation_async_with_timeout(
            &path,
            &["switch", target_branch],
            GIT_SYNC_MISC_TIMEOUT_MS,
        )
        .await
        .map_err(|e| format!("切换分支失败: {}", e))?;
        return Ok(branch_operation_result(
            true,
            target_branch.to_string(),
            false,
            None,
            format!("已切换到 {}", target_branch),
        ));
    }

    Err(format!("分支不存在: {}", target_branch))
}

#[tauri::command]
pub async fn switch_and_update_repo_branch(
    path: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<BranchOperationResult, String> {
    switch_and_update_repo_branch_inner(path, branch, &state).await
}

async fn switch_and_update_repo_branch_inner(
    path: String,
    branch: String,
    state: &AppState,
) -> Result<BranchOperationResult, String> {
    ensure_repo_path(&path)?;
    let target_branch = branch.trim();
    if target_branch.is_empty() {
        return Err("分支名称不能为空".to_string());
    }
    if target_branch == "HEAD" {
        return Err("无法切换到 HEAD".to_string());
    }

    let _repo_git_guard = acquire_repo_git_guard(state, &path).await?;
    ensure_clean_worktree_for_branch_switch(&path).await?;

    let local_ref = format!("refs/heads/{}", target_branch);
    if !ref_exists_async(&path, &local_ref, GIT_META_TIMEOUT_MS).await {
        return Err(format!("本地分支不存在: {}", target_branch));
    }

    let current_branch = run_git_read_only_async_with_timeout(
        &path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .unwrap_or_default();
    let is_current = current_branch.trim() == target_branch;
    if !is_current {
        ensure_branch_not_checked_out_elsewhere(&path, target_branch).await?;
    }

    run_git_mutation_async_with_timeout(
        &path,
        &["fetch", "--all", "--prune"],
        GIT_SYNC_FETCH_TIMEOUT_MS,
    )
    .await
    .map_err(|e| format!("刷新远程信息失败: {}", e))?;

    let (comparison, upstream) =
        compare_local_branch_to_upstream_async(&path, target_branch, GIT_SYNC_MISC_TIMEOUT_MS)
            .await;
    let upstream = upstream.ok_or_else(|| format!("分支 {} 没有可用 upstream", target_branch))?;
    if comparison.state != BRANCH_COMPARISON_OK {
        return Err(comparison
            .error
            .unwrap_or_else(|| format!("无法确认 {} 与 upstream 的状态", target_branch)));
    }
    if comparison.ahead > 0 {
        return Err(format!(
            "分支 {} 与 {} 存在本地提交，不能直接快进更新，请查看分支详情。",
            target_branch, upstream.short_ref
        ));
    }

    if !is_current {
        run_git_mutation_async_with_timeout(
            &path,
            &["switch", target_branch],
            GIT_SYNC_MISC_TIMEOUT_MS,
        )
        .await
        .map_err(|e| format!("切换分支失败: {}", e))?;
    }
    if comparison.behind > 0 {
        run_git_mutation_async_with_timeout(
            &path,
            &["merge", "--ff-only", &upstream.short_ref],
            GIT_SYNC_PULL_TIMEOUT_MS,
        )
        .await
        .map_err(|e| format!("已切换到 {}，但快进更新失败: {}", target_branch, e))?;
    }

    let mut result = branch_operation_result(
        !is_current,
        target_branch.to_string(),
        false,
        Some(upstream.remote_name),
        if comparison.behind > 0 {
            format!("已切换并更新 {}", target_branch)
        } else {
            format!("已切换到 {}，分支已是最新", target_branch)
        },
    );
    result.remote_fetched = true;
    Ok(result)
}

#[tauri::command]
pub async fn rebind_repo_branch_upstream(
    path: String,
    branch: String,
    upstream: String,
    state: State<'_, AppState>,
) -> Result<BranchOperationResult, String> {
    rebind_repo_branch_upstream_inner(path, branch, upstream, &state).await
}

async fn rebind_repo_branch_upstream_inner(
    path: String,
    branch: String,
    upstream: String,
    state: &AppState,
) -> Result<BranchOperationResult, String> {
    ensure_repo_path(&path)?;
    let target_branch = branch.trim();
    let target_upstream = upstream.trim();
    if target_branch.is_empty() {
        return Err("分支名称不能为空".to_string());
    }
    if target_upstream.is_empty() {
        return Err("上游分支不能为空".to_string());
    }

    let _repo_git_guard = acquire_repo_git_guard(&state, &path).await?;
    let local_ref = format!("refs/heads/{}", target_branch);
    if !ref_exists_async(&path, &local_ref, GIT_SYNC_MISC_TIMEOUT_MS).await {
        return Err(format!("本地分支不存在: {}", target_branch));
    }
    let remote_ref =
        parse_remote_branch_arg_async(&path, target_upstream, GIT_SYNC_MISC_TIMEOUT_MS).await?;
    if !ref_exists_async(&path, &remote_ref.full_ref, GIT_SYNC_MISC_TIMEOUT_MS).await {
        return Err(format!("远端分支不存在: {}", remote_ref.short_ref));
    }

    run_git_mutation_async_with_timeout(
        &path,
        &[
            "branch",
            "--set-upstream-to",
            &remote_ref.short_ref,
            target_branch,
        ],
        GIT_SYNC_MISC_TIMEOUT_MS,
    )
    .await
    .map_err(|e| format!("重新绑定 upstream 失败: {}", e))?;

    Ok(branch_operation_result(
        false,
        target_branch.to_string(),
        true,
        Some(remote_ref.remote_name.clone()),
        format!("已将 {} 重新绑定到 {}", target_branch, remote_ref.short_ref),
    ))
}

#[tauri::command]
pub async fn unset_repo_branch_upstream(
    path: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<BranchOperationResult, String> {
    unset_repo_branch_upstream_inner(path, branch, &state).await
}

async fn unset_repo_branch_upstream_inner(
    path: String,
    branch: String,
    state: &AppState,
) -> Result<BranchOperationResult, String> {
    ensure_repo_path(&path)?;
    let target_branch = branch.trim();
    if target_branch.is_empty() {
        return Err("分支名称不能为空".to_string());
    }

    let _repo_git_guard = acquire_repo_git_guard(&state, &path).await?;
    let local_ref = format!("refs/heads/{}", target_branch);
    if !ref_exists_async(&path, &local_ref, GIT_SYNC_MISC_TIMEOUT_MS).await {
        return Err(format!("本地分支不存在: {}", target_branch));
    }

    match run_git_mutation_async_with_timeout(
        &path,
        &["branch", "--unset-upstream", target_branch],
        GIT_SYNC_MISC_TIMEOUT_MS,
    )
    .await
    {
        Ok(_) => {}
        Err(error) if is_no_upstream_error(&error) => {}
        Err(error) => return Err(format!("取消 upstream 失败: {}", error)),
    }

    Ok(branch_operation_result(
        false,
        target_branch.to_string(),
        false,
        None,
        format!("已取消 {} 的 upstream", target_branch),
    ))
}

#[tauri::command]
pub async fn refresh_repo_git_metadata(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<RepoConfig, String> {
    refresh_repo_git_metadata_inner(repo_id, &state).await
}

async fn refresh_repo_git_metadata_inner(
    repo_id: String,
    state: &AppState,
) -> Result<RepoConfig, String> {
    let repo = get_repo_by_id(&state, &repo_id)?;
    ensure_repo_path(&repo.path)?;
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &repo.path).await?;
    let metadata = read_repo_git_metadata(repo.clone()).await;

    let (updated_repo, should_save) = {
        let mut repos = state.repos.lock().unwrap();
        let Some(target_repo) = repos.iter_mut().find(|item| item.id == repo_id) else {
            return Err("仓库不存在".to_string());
        };
        let changed = apply_repo_git_metadata(target_repo, metadata.branch, metadata.remote);
        (target_repo.clone(), changed)
    };
    if should_save {
        state.save();
    }

    Ok(updated_repo)
}

#[tauri::command]
pub async fn get_repos(
    metadata_concurrency: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<RepoConfig>, String> {
    let repos_before_refresh = state.repos.lock().unwrap().clone();
    // Metadata refresh is best-effort; a ceiling keeps a slow repository from
    // stalling the whole list read (the previous values are kept on expiry).
    let metadata = tokio::time::timeout(
        Duration::from_millis(crate::git_timeouts::REPO_LIST_COMMAND),
        refresh_repos_git_metadata_concurrently(repos_before_refresh, metadata_concurrency, &state),
    )
    .await
    .unwrap_or_default();

    let (repos_snapshot, should_save) = {
        let mut repos = state.repos.lock().unwrap();
        let mut changed = false;
        for refresh in metadata {
            if let Some(repo) = repos.iter_mut().find(|repo| {
                if !refresh.repo_id.is_empty() {
                    repo.id == refresh.repo_id
                } else {
                    repo.path == refresh.repo_path
                }
            }) {
                changed |= apply_repo_git_metadata(repo, refresh.branch, refresh.remote);
            }
        }
        (repos.clone(), changed)
    };

    if should_save {
        state.save();
    }

    Ok(repos_snapshot)
}

#[tauri::command]
pub async fn run_repo_build_script(
    repo_id: String,
    script_path: String,
    log_session_id: Option<String>,
    use_system_terminal: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RepoBuildScriptRunResult, String> {
    let repo = get_repo_by_id(&state, &repo_id)?;
    let (script_file, display_path) = resolve_repo_script_file(&repo.path, &script_path)?;
    let operation = state
        .app_restart_guard
        .begin_operation(format!("同步后脚本：{}", display_path))?;

    if use_system_terminal.unwrap_or(false) {
        #[cfg(target_os = "macos")]
        let terminal_command = {
            let marker = system_terminal_script_marker();
            let terminal_command =
                run_script_in_system_terminal(&repo.path, &script_file, &marker)?;
            tokio::spawn(retain_operation_until_terminal_script_finishes(
                marker, operation,
            ));
            terminal_command
        };
        #[cfg(not(target_os = "macos"))]
        let terminal_command = {
            let terminal_command = run_script_in_system_terminal(&repo.path, &script_file)?;
            drop(operation);
            terminal_command
        };
        return Ok(RepoBuildScriptRunResult {
            success: true,
            message: "已在系统终端启动脚本执行，请在终端窗口查看完整日志".to_string(),
            script_path: display_path,
            command: terminal_command,
            output: "脚本已交由系统终端执行。".to_string(),
        });
    }

    let (mut command, readable_command) = build_script_file_command(&repo.path, &script_file)?;
    command.kill_on_drop(true);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("执行同步后脚本失败: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取脚本标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取脚本错误输出".to_string())?;

    let (stream_sender, mut stream_receiver) = mpsc::unbounded_channel::<ScriptOutputMessage>();
    tokio::spawn(stream_script_reader(stdout, stream_sender.clone(), false));
    tokio::spawn(stream_script_reader(stderr, stream_sender.clone(), true));
    drop(stream_sender);

    let mut output_buffer = String::new();
    let timeout_at = tokio::time::Instant::now() + Duration::from_millis(BUILD_SCRIPT_TIMEOUT_MS);
    let mut child_status: Option<std::process::ExitStatus> = None;
    let mut stdout_finished = false;
    let mut stderr_finished = false;

    loop {
        if tokio::time::Instant::now() >= timeout_at {
            let _ = child.kill().await;
            return Err(format!(
                "执行同步后脚本超时（{} 分钟）: {}",
                BUILD_SCRIPT_TIMEOUT_MS / 60000,
                readable_command
            ));
        }

        if child_status.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => child_status = Some(status),
                Ok(None) => {}
                Err(e) => return Err(format!("获取脚本执行状态失败: {}", e)),
            }
        }

        if child_status.is_some() && stdout_finished && stderr_finished {
            break;
        }

        let remaining = timeout_at.saturating_duration_since(tokio::time::Instant::now());
        let wait_duration = remaining.min(Duration::from_millis(120));
        match tokio::time::timeout(wait_duration, stream_receiver.recv()).await {
            Ok(Some(ScriptOutputMessage::Chunk { text, is_stderr })) => {
                output_buffer.push_str(&text);
                let _ = app.emit(
                    "repo-build-script-log-chunk",
                    RepoBuildScriptLogChunkEvent {
                        repo_id: repo_id.clone(),
                        session_id: log_session_id.clone(),
                        chunk: text,
                        is_stderr,
                    },
                );
            }
            Ok(Some(ScriptOutputMessage::End { is_stderr })) => {
                if is_stderr {
                    stderr_finished = true;
                } else {
                    stdout_finished = true;
                }
            }
            Ok(None) => {
                stdout_finished = true;
                stderr_finished = true;
            }
            Err(_) => {}
        }
    }

    let status = if let Some(status) = child_status {
        status
    } else {
        child
            .wait()
            .await
            .map_err(|e| format!("等待脚本执行结束失败: {}", e))?
    };
    let output_text = truncate_script_output(output_buffer);

    if status.success() {
        return Ok(RepoBuildScriptRunResult {
            success: true,
            message: "脚本执行成功".to_string(),
            script_path: display_path,
            command: readable_command,
            output: output_text,
        });
    }

    let exit_code_text = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "未知".to_string());

    Ok(RepoBuildScriptRunResult {
        success: false,
        message: format!("脚本执行失败（退出码 {}）", exit_code_text),
        script_path: display_path,
        command: readable_command,
        output: output_text,
    })
}

#[tauri::command]
pub fn add_repo(path: String, state: State<'_, AppState>) -> Result<RepoConfig, String> {
    add_repo_internal(path, &state)
}

#[tauri::command]
pub async fn clone_repo(
    repo_url: String,
    parent_path: String,
    clone_task_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoConfig, String> {
    let clone_task_id = normalize_clone_task_id(clone_task_id);
    clear_clone_cancel_task(&state, clone_task_id.as_deref()).await;

    let normalized_repo_url = repo_url.trim();
    if normalized_repo_url.is_empty() {
        return Err("仓库地址不能为空".to_string());
    }

    let normalized_parent_path = parent_path.trim();
    if normalized_parent_path.is_empty() {
        return Err("本地保存路径不能为空".to_string());
    }
    ensure_repo_path(normalized_parent_path)?;

    let repo_name = parse_clone_repo_name(normalized_repo_url)
        .ok_or_else(|| "无法从仓库地址解析仓库名，请检查地址格式".to_string())?;
    let target_repo_path = Path::new(normalized_parent_path).join(&repo_name);

    if target_repo_path.exists() {
        return Err(format!(
            "目标目录已存在，请更换保存路径或手动移除目录：{}",
            target_repo_path.to_string_lossy()
        ));
    }

    let _operation = state
        .app_restart_guard
        .begin_operation(format!("克隆仓库：{}", repo_name))?;

    let mut clone_command = crate::git_command::new_mutation_async_command(
        normalized_parent_path,
        ["clone", normalized_repo_url, repo_name.as_str()],
    );
    clone_command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = clone_command
        .spawn()
        .map_err(|e| format!("执行 git clone 失败: {}", e))?;
    let output = match wait_for_clone_output(child, clone_task_id.as_deref(), &state).await {
        Ok(output) => output,
        Err(message) => {
            clear_clone_cancel_task(&state, clone_task_id.as_deref()).await;
            if message == GIT_CLONE_CANCELLED_MESSAGE || message.starts_with("克隆仓库超时") {
                let _ = std::fs::remove_dir_all(&target_repo_path);
            }
            return Err(message);
        }
    };
    clear_clone_cancel_task(&state, clone_task_id.as_deref()).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        if detail.is_empty() {
            return Err("克隆仓库失败".to_string());
        }
        return Err(format!("克隆仓库失败: {}", detail));
    }

    let normalized_target_repo_path = target_repo_path.to_string_lossy().to_string();
    add_repo_internal(normalized_target_repo_path, &state)
}

#[tauri::command]
pub async fn cancel_clone_task(
    clone_task_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let clone_task_id = clone_task_id.trim();
    if clone_task_id.is_empty() {
        return Err("克隆任务 ID 不能为空".to_string());
    }

    state
        .clone_cancel_tasks
        .lock()
        .await
        .insert(clone_task_id.to_string());
    Ok(true)
}

#[tauri::command]
pub fn remove_repo(repo_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let normalized_repo_id = repo_id.trim().to_string();
    if normalized_repo_id.is_empty() {
        Err("仓库不存在".to_string())
    } else {
        let remove_result = remove_repos_batch_internal(vec![normalized_repo_id], &state);
        if remove_result.removed_ids.is_empty() {
            Err("仓库不存在".to_string())
        } else {
            Ok(true)
        }
    }
}

fn remove_repos_batch_internal(
    repo_ids: Vec<String>,
    state: &State<'_, AppState>,
) -> RemoveReposBatchResult {
    if repo_ids.is_empty() {
        return empty_remove_repos_batch_result();
    }

    let mut normalized_repo_ids = Vec::new();
    let mut seen = HashSet::new();
    for repo_id in repo_ids {
        let normalized_repo_id = repo_id.trim().to_string();
        if normalized_repo_id.is_empty() || !seen.insert(normalized_repo_id.clone()) {
            continue;
        }
        normalized_repo_ids.push(normalized_repo_id);
    }

    if normalized_repo_ids.is_empty() {
        return empty_remove_repos_batch_result();
    }

    let repo_id_set: HashSet<String> = normalized_repo_ids.iter().cloned().collect();
    let mut removed_ids = Vec::new();

    let mut repos = state.repos.lock().unwrap();
    repos.retain(|repo| {
        let should_remove = repo_id_set.contains(&repo.id);
        if should_remove {
            removed_ids.push(repo.id.clone());
        }
        !should_remove
    });
    drop(repos);

    let removed_id_set: HashSet<String> = removed_ids.iter().cloned().collect();
    let missing_ids = normalized_repo_ids
        .iter()
        .filter(|repo_id| !removed_id_set.contains(*repo_id))
        .cloned()
        .collect();

    if !removed_ids.is_empty() {
        state.save();
    }

    RemoveReposBatchResult {
        requested_count: normalized_repo_ids.len(),
        removed_ids,
        missing_ids,
    }
}

#[tauri::command]
pub fn remove_repos_batch(
    repo_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<RemoveReposBatchResult, String> {
    Ok(remove_repos_batch_internal(repo_ids, &state))
}

#[tauri::command]
pub fn restore_repos(repos: Vec<RepoConfig>, state: State<'_, AppState>) -> Result<usize, String> {
    if repos.is_empty() {
        return Ok(0);
    }

    let mut restored_count = 0usize;
    let mut existing = state.repos.lock().unwrap();
    for mut repo in repos {
        let duplicated = existing
            .iter()
            .any(|item| item.id == repo.id || item.path == repo.path);
        if duplicated {
            continue;
        }

        if repo.status == "syncing" {
            repo.status = "idle".to_string();
        }
        existing.push(repo);
        restored_count += 1;
    }
    drop(existing);
    state.save();
    Ok(restored_count)
}

#[tauri::command]
pub async fn check_sync_prerequisites(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<SyncPrecheckResult, String> {
    let (repo_name, repo_path) = {
        let repos = state.repos.lock().unwrap();
        let repo = repos
            .iter()
            .find(|item| item.id == repo_id)
            .ok_or("仓库不存在".to_string())?;
        (repo.name.clone(), repo.path.clone())
    };
    ensure_repo_path(&repo_path)?;
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &repo_path).await?;

    let local_status_future = run_git_allow_fail_read_only_async_with_timeout(
        &repo_path,
        &["status", "--porcelain"],
        GIT_PRECHECK_TIMEOUT_MS,
    );
    let preferred_remote_future =
        get_preferred_remote_name_async(&repo_path, GIT_PRECHECK_TIMEOUT_MS);
    let conflict_future = run_git_allow_fail_read_only_async_with_timeout(
        &repo_path,
        &["diff", "--name-only", "--diff-filter=U"],
        GIT_PRECHECK_TIMEOUT_MS,
    );
    let branch_future = run_git_read_only_async_with_timeout(
        &repo_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_PRECHECK_TIMEOUT_MS,
    );

    let (local_status_output, preferred_remote_name, conflict_output, branch_result) = tokio::join!(
        local_status_future,
        preferred_remote_future,
        conflict_future,
        branch_future
    );

    let has_local_changes = has_meaningful_output(&local_status_output);
    let missing_remote = preferred_remote_name.is_none();
    let has_unmerged_conflicts = has_meaningful_output(&conflict_output);

    let (ahead, behind) = if missing_remote {
        (0, 0)
    } else {
        match branch_result {
            Ok(branch) if !branch.is_empty() => {
                get_branch_ahead_behind_async(&repo_path, &branch, GIT_PRECHECK_TIMEOUT_MS).await
            }
            _ => (0, 0),
        }
    };

    let conflict_risk = has_unmerged_conflicts || (ahead > 0 && behind > 0);

    Ok(SyncPrecheckResult {
        repo_id,
        repo_name,
        has_local_changes,
        missing_remote,
        has_unmerged_conflicts,
        ahead,
        behind,
        conflict_risk,
    })
}

#[tauri::command]
pub fn update_repo(
    repo_id: String,
    sync_mode: Option<String>,
    sync_interval: Option<u64>,
    auto_sync: Option<bool>,
    pull_strategy: Option<String>,
    status: Option<String>,
    post_sync_build_enabled: Option<bool>,
    post_sync_build_script: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoConfig, String> {
    let mut repos = state.repos.lock().unwrap();
    let repo = repos
        .iter_mut()
        .find(|r| r.id == repo_id)
        .ok_or("仓库不存在".to_string())?;

    apply_repo_update_fields(
        repo,
        sync_mode.as_deref(),
        sync_interval,
        auto_sync,
        pull_strategy.as_deref(),
        status.as_deref(),
        post_sync_build_enabled,
        post_sync_build_script.as_deref(),
    );

    let result = repo.clone();
    drop(repos);
    state.save();
    Ok(result)
}

#[tauri::command]
pub fn update_repos_batch(
    repo_ids: Vec<String>,
    sync_mode: Option<String>,
    sync_interval: Option<u64>,
    auto_sync: Option<bool>,
    pull_strategy: Option<String>,
    status: Option<String>,
    post_sync_build_enabled: Option<bool>,
    post_sync_build_script: Option<String>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    if repo_ids.is_empty() {
        return Ok(0);
    }
    if sync_mode.is_none()
        && sync_interval.is_none()
        && auto_sync.is_none()
        && pull_strategy.is_none()
        && status.is_none()
        && post_sync_build_enabled.is_none()
        && post_sync_build_script.is_none()
    {
        return Err("未提供可更新字段".to_string());
    }

    let repo_id_set: HashSet<String> = repo_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if repo_id_set.is_empty() {
        return Ok(0);
    }

    let mut updated = 0usize;
    let sync_mode = sync_mode.as_deref();
    let pull_strategy = pull_strategy.as_deref();
    let status = status.as_deref();
    let post_sync_build_script = post_sync_build_script.as_deref();
    let mut repos = state.repos.lock().unwrap();
    for repo in repos.iter_mut() {
        if !repo_id_set.contains(&repo.id) {
            continue;
        }

        apply_repo_update_fields(
            repo,
            sync_mode,
            sync_interval,
            auto_sync,
            pull_strategy,
            status,
            post_sync_build_enabled,
            post_sync_build_script,
        );
        updated += 1;
    }
    drop(repos);

    if updated > 0 {
        state.save();
    }
    Ok(updated)
}

/// 核心同步逻辑（异步 + 并发）
///
/// 1. fetch 远程信息
/// 2. 如有本地改动则 stash
/// 3. 按策略 pull
/// 4. 如有 stash 则 pop
/// 5. 如存在 ahead 提交则 push
#[tauri::command]
pub async fn sync_repo(
    repo_id: String,
    sync_behavior: Option<String>,
    state: State<'_, AppState>,
) -> Result<SyncResult, String> {
    {
        let mut syncing = state.syncing_repos.lock().unwrap();
        if syncing.contains(&repo_id) {
            return Ok(create_sync_failure(
                "仓库正在同步中，请稍后重试".to_string(),
            ));
        }
        syncing.insert(repo_id.clone());
    }

    // Whole-command ceiling: every git step below already has its own budget, but a
    // wedged step or a stuck IPC would otherwise pin the repository as "syncing"
    // forever. The inner future is dropped on expiry so the repo is always freed.
    let result = tokio::time::timeout(
        Duration::from_millis(crate::git_timeouts::SYNC_COMMAND),
        sync_repo_inner(&repo_id, sync_behavior.as_deref(), &state),
    )
    .await
    .unwrap_or_else(|_| {
        Ok(create_sync_failure(
            "同步操作超过总时限，已中止。".to_string(),
        ))
    });
    state.syncing_repos.lock().unwrap().remove(&repo_id);
    result
}

async fn sync_repo_inner(
    repo_id: &str,
    sync_behavior: Option<&str>,
    state: &State<'_, AppState>,
) -> Result<SyncResult, String> {
    let (path, pull_strategy) = {
        let mut repos = state.repos.lock().unwrap();
        let repo = repos
            .iter_mut()
            .find(|r| r.id == repo_id)
            .ok_or("仓库不存在".to_string())?;
        repo.status = "syncing".to_string();
        (repo.path.clone(), repo.pull_strategy.clone())
    };

    if let Err(message) = ensure_repo_path(&path) {
        return Ok(mark_sync_failure(state, repo_id, message));
    }

    let _repo_git_guard = acquire_repo_git_guard(state, &path).await?;

    // ===== 1. Fetch =====
    if let Err(e) = run_git_mutation_async_with_timeout(
        &path,
        &["fetch", "--all", "--prune"],
        GIT_SYNC_FETCH_TIMEOUT_MS,
    )
    .await
    {
        let message = format!("Fetch 失败: {}", e);
        return Ok(mark_sync_failure(state, repo_id, message));
    }

    if sync_behavior == Some(SYNC_BEHAVIOR_CHANGED_ONLY) {
        return sync_repo_changed_only_inner(repo_id, state, &path, &pull_strategy).await;
    }

    let mut did_push = match ensure_current_branch_upstream_async(&path).await {
        Ok(value) => value,
        Err(e) => return Ok(mark_sync_failure(state, repo_id, e)),
    };

    // ===== 2. 处理本地未提交改动（stash 暂存）=====
    let did_stash;
    if has_local_changes_async(&path).await {
        match run_git_mutation_async_with_timeout(
            &path,
            &["stash", "push", "-m", "GitSync: 同步前暂存"],
            GIT_SYNC_STASH_TIMEOUT_MS,
        )
        .await
        {
            Ok(_) => {
                did_stash = true;
            }
            Err(e) => {
                let message = format!("Stash 失败: {}", e);
                return Ok(mark_sync_failure(state, repo_id, message));
            }
        }
    } else {
        did_stash = false;
    }

    // ===== 3. Pull（根据策略）=====
    let had_remote_commits_before_pull =
        get_current_ahead_behind_async(&path, GIT_SYNC_MISC_TIMEOUT_MS)
            .await
            .1
            > 0;
    let head_before_pull = get_head_commit_async(&path, GIT_SYNC_MISC_TIMEOUT_MS).await;
    let pull_result = run_pull_with_strategy_async(&path, pull_strategy.as_str()).await;

    // ===== 4. 如果用了 stash，恢复 =====
    if did_stash {
        let stash_pop_result = run_git_mutation_async_with_timeout(
            &path,
            &["stash", "pop"],
            GIT_SYNC_STASH_TIMEOUT_MS,
        )
        .await;
        if let Err(e) = &stash_pop_result {
            if is_conflict_error(e) {
                let conflict_files =
                    collect_conflict_files_async(&path, GIT_SYNC_MISC_TIMEOUT_MS).await;

                update_status(state, repo_id, "conflict");
                return Ok(create_sync_conflict(
                    "Stash pop 存在冲突，请手动处理本地暂存的改动".to_string(),
                    conflict_files,
                ));
            }
        }
    }

    // ===== 5. 处理 pull 结果 =====
    match pull_result {
        Ok(_) => {
            let did_pull = detect_did_pull_async(
                &path,
                &head_before_pull,
                had_remote_commits_before_pull,
                GIT_SYNC_MISC_TIMEOUT_MS,
            )
            .await;
            // 成功后检查是否 ahead，必要时 push
            let mut ahead = 0i32;
            if let Ok(branch) = run_git_read_only_async_with_timeout(
                &path,
                &["rev-parse", "--abbrev-ref", "HEAD"],
                GIT_SYNC_MISC_TIMEOUT_MS,
            )
            .await
            {
                if let Ok(ab) = run_git_read_only_async_with_timeout(
                    &path,
                    &[
                        "rev-list",
                        "--left-right",
                        "--count",
                        &format!("{}...@{{u}}", branch),
                    ],
                    GIT_SYNC_MISC_TIMEOUT_MS,
                )
                .await
                {
                    ahead = parse_ahead_behind_counts(&ab).0;
                }
            }
            if ahead > 0
                && run_git_mutation_async_with_timeout(
                    &path,
                    GIT_PUSH_WITH_TAGS_ARGS,
                    GIT_SYNC_PUSH_TIMEOUT_MS,
                )
                .await
                .is_ok()
            {
                did_push = true;
            }

            Ok(mark_sync_success(
                state,
                repo_id,
                "同步完成".to_string(),
                did_pull,
                did_push,
            ))
        }
        Err(e) => {
            if is_conflict_error(&e) {
                let conflict_files =
                    collect_conflict_files_async(&path, GIT_SYNC_MISC_TIMEOUT_MS).await;

                update_status(state, repo_id, "conflict");
                Ok(create_sync_conflict(
                    "存在合并冲突".to_string(),
                    conflict_files,
                ))
            } else {
                let message = format!("Pull 失败: {}", e);
                Ok(mark_sync_failure(state, repo_id, message))
            }
        }
    }
}

#[tauri::command]
pub async fn resolve_conflict(
    repo_path: String,
    file_path: String,
    strategy: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    ensure_repo_path(&repo_path)?;
    let _repo_git_guard = acquire_repo_git_guard(&state, &repo_path).await?;
    resolve_conflict_locked(&repo_path, &file_path, &strategy)
}

fn resolve_conflict_locked(
    repo_path: &str,
    file_path: &str,
    strategy: &str,
) -> Result<bool, String> {
    match strategy {
        "ours" => {
            run_git_mutation(repo_path, &["checkout", "--ours", file_path])?;
        }
        "theirs" => {
            run_git_mutation(repo_path, &["checkout", "--theirs", file_path])?;
        }
        _ => return Err("无效的解决策略".to_string()),
    }
    run_git_mutation(repo_path, &["add", file_path])?;
    Ok(true)
}

#[tauri::command]
pub async fn resolve_all_conflicts(
    repo_path: String,
    strategy: String,
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    ensure_repo_path(&repo_path)?;
    let _repo_git_guard = acquire_repo_git_guard(&state, &repo_path).await?;
    let conflict_files: Vec<String> =
        run_git_allow_fail_read_only(&repo_path, &["diff", "--name-only", "--diff-filter=U"])
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();

    for file in &conflict_files {
        resolve_conflict_locked(&repo_path, file, &strategy)?;
    }

    let strategy_label = if strategy == "ours" {
        "保留本地"
    } else {
        "保留远程"
    };
    let msg = format!(
        "GitSync: 冲突解决 ({}) - {}",
        strategy_label,
        now_readable()
    );
    run_git_mutation(&repo_path, &["commit", "-m", &msg])?;
    update_status(&state, &repo_id, "idle");
    Ok(true)
}

#[tauri::command]
pub async fn abort_merge(
    repo_path: String,
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    ensure_repo_path(&repo_path)?;
    let _repo_git_guard = acquire_repo_git_guard(&state, &repo_path).await?;
    // 尝试 merge --abort, 如果失败尝试 rebase --abort
    if run_git_mutation(&repo_path, &["merge", "--abort"]).is_err() {
        let _ = run_git_mutation(&repo_path, &["rebase", "--abort"]);
    }
    update_status(&state, &repo_id, "idle");
    Ok(true)
}

#[tauri::command]
pub fn get_conflict_files(repo_path: String) -> Vec<String> {
    run_git_allow_fail_read_only(&repo_path, &["diff", "--name-only", "--diff-filter=U"])
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

#[tauri::command]
pub fn get_log(repo_path: String, count: u32) -> Vec<CommitInfo> {
    let count_str = format!("-{}", count);
    run_git_read_only(&repo_path, &["log", &count_str, "--format=%h|%s|%ai|%an"])
        .ok()
        .map(|output| {
            output
                .lines()
                .filter_map(|line| {
                    let parts: Vec<&str> = line.splitn(4, '|').collect();
                    if parts.len() == 4 {
                        Some(CommitInfo {
                            hash: parts[0].to_string(),
                            message: parts[1].to_string(),
                            date: parts[2].to_string(),
                            author: parts[3].to_string(),
                        })
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_repo_commit_history(
    repo_path: String,
    count: u32,
    branch: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoCommitHistory, String> {
    get_repo_commit_history_inner(repo_path, count, branch, &state).await
}

async fn read_commit_history_for_ref_async(
    repo_path: &str,
    log_target: &str,
    count_arg: &str,
) -> Result<Vec<CommitInfo>, String> {
    let format_arg = "--format=%h%x1f%s%x1f%ai%x1f%an";
    let log_output = match run_git_read_only_async_with_timeout(
        repo_path,
        &["log", count_arg, log_target, format_arg],
        GIT_COMMIT_HISTORY_TIMEOUT_MS,
    )
    .await
    {
        Ok(output) => output,
        Err(error)
            if error.contains("does not have any commits yet")
                || error.contains("bad revision 'HEAD'") =>
        {
            String::new()
        }
        Err(error) => return Err(error),
    };

    Ok(log_output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\u{1f}').collect();
            if parts.len() == 4 {
                Some(CommitInfo {
                    hash: parts[0].to_string(),
                    message: parts[1].to_string(),
                    date: parts[2].to_string(),
                    author: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect())
}

async fn get_repo_commit_history_inner(
    repo_path: String,
    count: u32,
    branch: Option<String>,
    state: &AppState,
) -> Result<RepoCommitHistory, String> {
    ensure_repo_path(&repo_path)?;
    let _repo_git_guard = acquire_repo_git_read_guard(&state, &repo_path).await?;

    let safe_count = count.clamp(1, 100);
    let count_arg = format!("-{}", safe_count);
    let branch_arg = branch.unwrap_or_default().trim().to_string();

    let current_branch = run_git_read_only_async_with_timeout(
        &repo_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .unwrap_or_else(|_| "unknown".to_string());

    let log_target = if branch_arg.is_empty() {
        "HEAD".to_string()
    } else {
        branch_arg.clone()
    };
    let branch_name = if branch_arg.is_empty() {
        current_branch
    } else {
        branch_arg
    };

    let head_hash = run_git_read_only_async_with_timeout(
        &repo_path,
        &["rev-parse", "--short", &log_target],
        GIT_META_TIMEOUT_MS,
    )
    .await
    .unwrap_or_default();

    let commits = read_commit_history_for_ref_async(&repo_path, &log_target, &count_arg).await?;
    let mut remote_branch = None;
    let mut remote_head_hash = None;
    let mut remote_commits = Vec::new();
    let local_full_ref = format!("refs/heads/{}", branch_name);
    if ref_exists_async(&repo_path, &local_full_ref, GIT_META_TIMEOUT_MS).await {
        if let Ok(Some(upstream)) =
            get_branch_upstream_config_async(&repo_path, &branch_name, GIT_META_TIMEOUT_MS).await
        {
            if upstream.remote_name != "."
                && ref_exists_async(&repo_path, &upstream.full_ref, GIT_META_TIMEOUT_MS).await
            {
                let remote_range = format!("{}..{}", log_target, upstream.short_ref);
                remote_branch = Some(upstream.short_ref.clone());
                remote_head_hash = run_git_read_only_async_with_timeout(
                    &repo_path,
                    &["rev-parse", "--short", &upstream.short_ref],
                    GIT_META_TIMEOUT_MS,
                )
                .await
                .ok()
                .and_then(|value| normalize_git_metadata_value(&value));
                remote_commits =
                    read_commit_history_for_ref_async(&repo_path, &remote_range, &count_arg)
                        .await?;
            }
        }
    }

    Ok(RepoCommitHistory {
        branch: branch_name,
        head_hash,
        remote_branch,
        remote_head_hash,
        commits,
        remote_commits,
    })
}

// ─── GitHub Device Flow 认证 ───

/// GitHub OAuth client_id 查找优先级：
/// 1. 运行时环境变量 GITSYNC_GITHUB_CLIENT_ID
/// 2. 配置文件 ./github_client_id（项目根目录，纯文本，写一行 client_id）
/// 3. 配置文件 ~/.gitsync/github_client_id（打包后也有效）
/// 4. 编译时嵌入值 GITSYNC_GITHUB_CLIENT_ID=xxx cargo build
fn read_nonempty_trimmed_file(path: &Path) -> Option<String> {
    let value = std::fs::read_to_string(path).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn push_home_candidate(homes: &mut Vec<PathBuf>, value: Option<String>) {
    let Some(value) = value else { return };
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    let path = PathBuf::from(value);
    if !homes.contains(&path) {
        homes.push(path);
    }
}

fn github_client_id_home_dirs_from_env(
    home: Option<String>,
    user_profile: Option<String>,
    home_drive: Option<String>,
    home_path: Option<String>,
) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    push_home_candidate(&mut homes, home);
    push_home_candidate(&mut homes, user_profile);

    if let (Some(drive), Some(path)) = (home_drive, home_path) {
        let drive = drive.trim();
        let path = path.trim();
        if !drive.is_empty() && !path.is_empty() {
            push_home_candidate(&mut homes, Some(format!("{drive}{path}")));
        }
    }

    homes
}

fn github_client_id_home_dirs() -> Vec<PathBuf> {
    github_client_id_home_dirs_from_env(
        std::env::var("HOME").ok(),
        std::env::var("USERPROFILE").ok(),
        std::env::var("HOMEDRIVE").ok(),
        std::env::var("HOMEPATH").ok(),
    )
}

fn get_github_client_id() -> Result<String, String> {
    // 1. 运行时环境变量
    if let Ok(val) = std::env::var("GITSYNC_GITHUB_CLIENT_ID") {
        let val = val.trim().to_string();
        if !val.is_empty() {
            return Ok(val);
        }
    }
    // 2. 配置文件 ./github_client_id（开发模式，项目根目录）
    if let Ok(cwd) = std::env::current_dir() {
        let config_path = cwd.join("github_client_id");
        if let Some(val) = read_nonempty_trimmed_file(&config_path) {
            return Ok(val);
        }
        // 也尝试上级目录（tauri dev 时 cwd 可能是 src-tauri/）
        let parent_path = cwd.join("..").join("github_client_id");
        if let Some(val) = read_nonempty_trimmed_file(&parent_path) {
            return Ok(val);
        }
    }
    // 3. 配置文件 ~/.gitsync/github_client_id（打包后也有效）
    for home in github_client_id_home_dirs() {
        let config_path = home.join(".gitsync").join("github_client_id");
        if let Some(val) = read_nonempty_trimmed_file(&config_path) {
            return Ok(val);
        }
    }
    // 4. 编译时嵌入值
    option_env!("GITSYNC_GITHUB_CLIENT_ID")
        .map(|s| s.to_string())
        .ok_or_else(|| "未找到 GitHub client_id。请任选一种方式配置：\n  - 环境变量: export GITSYNC_GITHUB_CLIENT_ID=xxx\n  - 开发模式: echo xxx > github_client_id\n  - 生产环境: echo xxx > ~/.gitsync/github_client_id（Windows 可使用 %USERPROFILE%\\.gitsync\\github_client_id）\n  - 编译嵌入: GITSYNC_GITHUB_CLIENT_ID=xxx cargo build".to_string())
}

const GITHUB_KEYRING_SERVICE: &str = "gitsync-github";
const GITHUB_KEYRING_ACCOUNT: &str = "default";

pub(crate) fn get_github_token() -> Result<String, String> {
    let entry = keyring::Entry::new(GITHUB_KEYRING_SERVICE, GITHUB_KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring 初始化失败: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("未登录 GitHub，请先登录: {e}"))
}

fn store_github_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(GITHUB_KEYRING_SERVICE, GITHUB_KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring 初始化失败: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("token 保存失败: {e}"))
}

fn delete_github_token() -> Result<(), String> {
    let entry = keyring::Entry::new(GITHUB_KEYRING_SERVICE, GITHUB_KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring 初始化失败: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("token 删除失败: {e}"))
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GithubAccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[tauri::command]
pub async fn github_start_device_auth(
    state: State<'_, AppState>,
) -> Result<DeviceAuthResponse, String> {
    let client = &state.http_client;
    let client_id = get_github_client_id()?;
    let params = [("client_id", client_id.as_str()), ("scope", "repo")];

    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .header("User-Agent", "GitSync")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub 认证初始化失败: {body}"));
    }

    resp.json::<DeviceAuthResponse>()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))
}

#[tauri::command]
pub async fn github_poll_token(
    device_code: String,
    state: State<'_, AppState>,
) -> Result<GithubAccount, String> {
    let client = &state.http_client;
    let client_id = get_github_client_id()?;
    let params = [
        ("client_id", client_id.as_str()),
        ("device_code", &device_code),
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
    ];

    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("User-Agent", "GitSync")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let token_resp: GithubAccessTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;

    if let Some(error) = token_resp.error {
        match error.as_str() {
            "authorization_pending" => return Err("authorization_pending".to_string()),
            "slow_down" => return Err("slow_down".to_string()),
            "expired_token" => return Err("授权码已过期".to_string()),
            "access_denied" => return Err("用户取消了授权".to_string()),
            _ => return Err(format!("授权失败: {}", error)),
        }
    }

    let token = token_resp
        .access_token
        .ok_or_else(|| "未获取到 access token".to_string())?;

    store_github_token(&token)?;

    let user_resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", &token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "GitSync")
        .send()
        .await
        .map_err(|e| format!("获取用户信息失败: {e}"))?;

    if !user_resp.status().is_success() {
        return Err("获取用户信息失败".to_string());
    }

    user_resp
        .json::<GithubAccount>()
        .await
        .map_err(|e| format!("解析用户信息失败: {e}"))
}

#[tauri::command]
pub async fn github_get_account(state: State<'_, AppState>) -> Result<GithubAccount, String> {
    let token = get_github_token()?;
    let client = &state.http_client;

    let resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", &token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "GitSync")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let _ = delete_github_token();
        return Err("登录已过期，请重新登录 GitHub".to_string());
    }
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("获取用户信息失败: {}", body));
    }

    resp.json::<GithubAccount>()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))
}

#[tauri::command]
pub fn github_logout() -> Result<bool, String> {
    delete_github_token()?;
    Ok(true)
}

fn normalize_github_repo_visibility_filter(value: Option<String>) -> &'static str {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("public") => "public",
        Some("private") => "private",
        _ => "all",
    }
}

fn normalize_github_repo_sort(value: Option<String>) -> &'static str {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("created") => "created",
        Some("updated") => "updated",
        _ => "updated",
    }
}

fn normalize_github_repo_direction(value: Option<String>) -> &'static str {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("asc") => "asc",
        Some("desc") => "desc",
        _ => "desc",
    }
}

#[tauri::command]
pub async fn github_get_repos(
    page: u32,
    visibility: Option<String>,
    sort: Option<String>,
    direction: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<GithubRepo>, String> {
    let token = get_github_token()?;
    let client = &state.http_client;
    let safe_page = page.max(1);
    let page_text = safe_page.to_string();
    let visibility = normalize_github_repo_visibility_filter(visibility);
    let sort = normalize_github_repo_sort(sort);
    let direction = normalize_github_repo_direction(direction);

    let resp = client
        .get("https://api.github.com/user/repos")
        .query(&[
            ("per_page", "100"),
            ("page", page_text.as_str()),
            ("visibility", visibility),
            ("sort", sort),
            ("direction", direction),
            ("affiliation", "owner,collaborator,organization_member"),
        ])
        .header("Authorization", format!("Bearer {}", &token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "GitSync")
        .send()
        .await
        .map_err(|e| format!("请求仓库列表失败: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let _ = delete_github_token();
        return Err("登录已过期，请重新登录 GitHub".to_string());
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("获取仓库列表失败（{}）: {}", status, body));
    }

    resp.json::<Vec<GithubRepo>>()
        .await
        .map_err(|e| format!("解析仓库列表失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_repo_git_metadata, choose_preferred_remote_name, compare_refs_async,
        default_pull_strategy, default_status, default_sync_interval, default_sync_mode,
        get_repo_branch_overview_inner, get_repo_commit_history_inner, get_repo_status_inner,
        github_client_id_home_dirs_from_env, load_repo_configs_from_str, normalize_clone_task_id,
        normalize_github_repo_direction, normalize_github_repo_sort,
        normalize_github_repo_visibility_filter, normalize_repo_metadata_refresh_concurrency,
        now_timestamp, rebind_repo_branch_upstream_inner, switch_and_update_repo_branch_inner,
        switch_repo_branch_inner, unset_repo_branch_upstream_inner, AppState, RepoConfig,
        BRANCH_COMPARISON_DETACHED, BRANCH_COMPARISON_ERROR, BRANCH_COMPARISON_NO_UPSTREAM,
        BRANCH_COMPARISON_OK, BRANCH_COMPARISON_REMOTE_ONLY, BRANCH_COMPARISON_UPSTREAM_GONE,
        REPOS_FILE_NAME,
    };
    use crate::branch_delete::{delete_branch_locked, BranchDeleteRequest};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gitsync-{}-{}", name, suffix));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_repo_config(id: &str, path: &str) -> RepoConfig {
        RepoConfig {
            id: id.to_string(),
            name: id.to_string(),
            path: path.to_string(),
            branch: "main".to_string(),
            remote: None,
            sync_interval: default_sync_interval(),
            auto_sync: true,
            sync_mode: default_sync_mode(),
            pull_strategy: default_pull_strategy(),
            status: default_status(),
            last_sync_at: None,
            last_error: None,
            error_logs: Vec::new(),
            post_sync_build_enabled: false,
            post_sync_build_script: None,
            created_at: "1710000000".to_string(),
        }
    }

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(name: &str) -> Self {
            Self {
                path: unique_temp_dir(name),
            }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    struct GitBranchFixture {
        _root: TempDirGuard,
        repo_path: PathBuf,
        origin_path: PathBuf,
        state: AppState,
    }

    impl GitBranchFixture {
        fn repo_path_string(&self) -> String {
            path_to_string(&self.repo_path)
        }
    }

    fn path_to_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn run_test_git(repo_path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "GitSync Test")
            .env("GIT_AUTHOR_EMAIL", "gitsync-test@example.com")
            .env("GIT_COMMITTER_NAME", "GitSync Test")
            .env("GIT_COMMITTER_EMAIL", "gitsync-test@example.com")
            .output()
            .unwrap_or_else(|error| panic!("failed to run git {:?}: {}", args, error));
        if !output.status.success() {
            panic!(
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn commit_file(repo_path: &Path, file_name: &str, content: &str, message: &str) {
        fs::write(repo_path.join(file_name), content).unwrap();
        run_test_git(repo_path, &["add", file_name]);
        run_test_git(repo_path, &["commit", "-m", message]);
    }

    fn configure_test_repo(repo_path: &Path) {
        run_test_git(repo_path, &["config", "user.name", "GitSync Test"]);
        run_test_git(
            repo_path,
            &["config", "user.email", "gitsync-test@example.com"],
        );
    }

    fn create_branch_fixture(name: &str) -> GitBranchFixture {
        let root = TempDirGuard::new(name);
        let origin_path = root.path().join("origin.git");
        let repo_path = root.path().join("work");
        let origin_arg = path_to_string(&origin_path);
        let repo_arg = path_to_string(&repo_path);

        run_test_git(root.path(), &["init", "--bare", &origin_arg]);
        run_test_git(root.path(), &["init", "--initial-branch=main", &repo_arg]);
        configure_test_repo(&repo_path);
        commit_file(&repo_path, "README.md", "base\n", "initial commit");
        run_test_git(&repo_path, &["remote", "add", "origin", &origin_arg]);
        run_test_git(&repo_path, &["push", "-u", "origin", "main"]);
        run_test_git(&origin_path, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        GitBranchFixture {
            _root: root,
            repo_path,
            origin_path,
            state: AppState::new(),
        }
    }

    fn create_remote_branch(fixture: &GitBranchFixture, branch: &str, file_name: &str) {
        let clone_path = fixture
            ._root
            .path()
            .join(format!("remote-work-{}", branch.replace('/', "-")));
        let origin_arg = path_to_string(&fixture.origin_path);
        let clone_arg = path_to_string(&clone_path);
        run_test_git(fixture._root.path(), &["clone", &origin_arg, &clone_arg]);
        configure_test_repo(&clone_path);
        run_test_git(&clone_path, &["switch", "-c", branch]);
        commit_file(
            &clone_path,
            file_name,
            &format!("remote branch {}\n", branch),
            &format!("add {}", branch),
        );
        run_test_git(&clone_path, &["push", "-u", "origin", branch]);
        run_test_git(&fixture.repo_path, &["fetch", "--all", "--prune"]);
    }

    fn create_remote_commit(fixture: &GitBranchFixture, file_name: &str, content: &str) {
        let clone_path = fixture
            ._root
            .path()
            .join(format!("remote-commit-{}", file_name));
        let origin_arg = path_to_string(&fixture.origin_path);
        let clone_arg = path_to_string(&clone_path);
        run_test_git(fixture._root.path(), &["clone", &origin_arg, &clone_arg]);
        configure_test_repo(&clone_path);
        run_test_git(&clone_path, &["switch", "main"]);
        commit_file(
            &clone_path,
            file_name,
            content,
            &format!("remote {}", file_name),
        );
        run_test_git(&clone_path, &["push", "origin", "main"]);
        run_test_git(&fixture.repo_path, &["fetch", "--all", "--prune"]);
    }

    fn add_upstream_remote_with_main(fixture: &GitBranchFixture) -> PathBuf {
        let upstream_path = fixture._root.path().join("upstream.git");
        let upstream_arg = path_to_string(&upstream_path);
        run_test_git(fixture._root.path(), &["init", "--bare", &upstream_arg]);
        run_test_git(
            &fixture.repo_path,
            &["remote", "add", "upstream", &upstream_arg],
        );
        run_test_git(&fixture.repo_path, &["push", "upstream", "main"]);
        run_test_git(&upstream_path, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        upstream_path
    }

    fn create_branch_on_remote(root: &Path, remote_path: &Path, branch: &str, file_name: &str) {
        let clone_path = root.join(format!(
            "remote-{}-{}",
            remote_path.file_stem().unwrap().to_string_lossy(),
            branch.replace('/', "-")
        ));
        let remote_arg = path_to_string(remote_path);
        let clone_arg = path_to_string(&clone_path);
        run_test_git(root, &["clone", &remote_arg, &clone_arg]);
        configure_test_repo(&clone_path);
        run_test_git(&clone_path, &["switch", "-c", branch]);
        commit_file(
            &clone_path,
            file_name,
            &format!("{} {}\n", remote_path.display(), branch),
            &format!("add {}", branch),
        );
        run_test_git(&clone_path, &["push", "-u", "origin", branch]);
    }

    #[test]
    fn github_client_id_home_dirs_include_windows_user_profile() {
        let dirs = github_client_id_home_dirs_from_env(
            Some("/Users/dev".to_string()),
            Some(r"C:\Users\dev".to_string()),
            Some("C:".to_string()),
            Some(r"\Users\dev".to_string()),
        );

        assert_eq!(
            dirs,
            vec![PathBuf::from("/Users/dev"), PathBuf::from(r"C:\Users\dev")]
        );
    }

    #[test]
    fn github_client_id_home_dirs_fall_back_to_home_drive_and_path() {
        let dirs = github_client_id_home_dirs_from_env(
            None,
            None,
            Some("C:".to_string()),
            Some(r"\Users\dev".to_string()),
        );

        assert_eq!(dirs, vec![PathBuf::from(r"C:\Users\dev")]);
    }

    #[test]
    fn github_repo_query_filters_are_allowlisted() {
        assert_eq!(
            normalize_github_repo_visibility_filter(Some(" PRIVATE ".to_string())),
            "private"
        );
        assert_eq!(
            normalize_github_repo_visibility_filter(Some("invalid".to_string())),
            "all"
        );
        assert_eq!(normalize_github_repo_visibility_filter(None), "all");

        assert_eq!(
            normalize_github_repo_sort(Some("created".to_string())),
            "created"
        );
        assert_eq!(
            normalize_github_repo_sort(Some("pushed".to_string())),
            "updated"
        );

        assert_eq!(
            normalize_github_repo_direction(Some("ASC".to_string())),
            "asc"
        );
        assert_eq!(
            normalize_github_repo_direction(Some("sideways".to_string())),
            "desc"
        );
    }

    #[test]
    fn clone_task_id_is_trimmed_and_optional() {
        assert_eq!(
            normalize_clone_task_id(Some(" github-clone-1 ".to_string())).as_deref(),
            Some("github-clone-1")
        );
        assert_eq!(normalize_clone_task_id(Some("   ".to_string())), None);
        assert_eq!(normalize_clone_task_id(None), None);
    }

    #[test]
    fn preferred_remote_uses_upstream_remote_first() {
        let remotes = vec!["origin".to_string(), "upstream".to_string()];
        let preferred = choose_preferred_remote_name(&remotes, Some("upstream/main"));
        assert_eq!(preferred, Some("upstream".to_string()));
    }

    #[test]
    fn preferred_remote_falls_back_to_origin_then_first() {
        let with_origin = vec!["backup".to_string(), "origin".to_string()];
        let without_origin = vec!["backup".to_string(), "mirror".to_string()];

        assert_eq!(
            choose_preferred_remote_name(&with_origin, None),
            Some("origin".to_string())
        );
        assert_eq!(
            choose_preferred_remote_name(&without_origin, None),
            Some("backup".to_string())
        );
    }

    #[test]
    fn repo_git_metadata_refresh_replaces_stale_remote() {
        let mut repo = test_repo_config("SampleRepo", "/tmp/SampleRepo");
        repo.branch = "master".to_string();
        repo.remote = Some("git@github.com:example-user/OldRepo.git".to_string());

        let changed = apply_repo_git_metadata(
            &mut repo,
            Some("main".to_string()),
            Some(Some("git@github.com:example-user/SampleRepo.git".to_string())),
        );

        assert!(changed);
        assert_eq!(repo.branch, "main");
        assert_eq!(
            repo.remote.as_deref(),
            Some("git@github.com:example-user/SampleRepo.git")
        );
    }

    #[test]
    fn repo_git_metadata_refresh_keeps_values_when_read_fails() {
        let mut repo = test_repo_config("SampleRepo", "/tmp/SampleRepo");
        repo.branch = "main".to_string();
        repo.remote = Some("git@github.com:example-user/SampleRepo.git".to_string());

        let changed = apply_repo_git_metadata(&mut repo, None, None);

        assert!(!changed);
        assert_eq!(repo.branch, "main");
        assert_eq!(
            repo.remote.as_deref(),
            Some("git@github.com:example-user/SampleRepo.git")
        );
    }

    #[test]
    fn repo_metadata_refresh_concurrency_is_bounded() {
        assert_eq!(normalize_repo_metadata_refresh_concurrency(None, 20), 4);
        assert_eq!(normalize_repo_metadata_refresh_concurrency(Some(0), 20), 1);
        assert_eq!(
            normalize_repo_metadata_refresh_concurrency(Some(99), 20),
            10
        );
        assert_eq!(normalize_repo_metadata_refresh_concurrency(Some(10), 3), 3);
        assert_eq!(normalize_repo_metadata_refresh_concurrency(Some(4), 0), 1);
    }

    #[test]
    fn now_timestamp_uses_millisecond_precision() {
        let timestamp = now_timestamp().parse::<u128>().unwrap();
        assert!(timestamp >= 1_000_000_000_000);
    }

    #[tokio::test]
    async fn repo_status_reports_current_branch_only_without_overview_counts() {
        let fixture = create_branch_fixture("status-current-only");

        let status = get_repo_status_inner(fixture.repo_path_string(), &fixture.state)
            .await
            .unwrap();

        assert_eq!(status.branch, "main");
        assert_eq!(status.comparison_state, BRANCH_COMPARISON_OK);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));

        let serialized = serde_json::to_value(&status).unwrap();
        assert!(serialized.get("remote_only_count").is_none());
        assert!(serialized.get("behind_branch_count").is_none());
    }

    #[tokio::test]
    async fn repo_status_distinguishes_ahead_behind_and_diverged_current_branch() {
        let ahead_fixture = create_branch_fixture("status-ahead");
        commit_file(
            &ahead_fixture.repo_path,
            "ahead.txt",
            "ahead\n",
            "local ahead",
        );
        let ahead_status =
            get_repo_status_inner(ahead_fixture.repo_path_string(), &ahead_fixture.state)
                .await
                .unwrap();
        assert_eq!(ahead_status.comparison_state, BRANCH_COMPARISON_OK);
        assert_eq!(ahead_status.ahead, 1);
        assert_eq!(ahead_status.behind, 0);

        let behind_fixture = create_branch_fixture("status-behind");
        create_remote_commit(&behind_fixture, "behind.txt", "behind\n");
        let behind_status =
            get_repo_status_inner(behind_fixture.repo_path_string(), &behind_fixture.state)
                .await
                .unwrap();
        assert_eq!(behind_status.comparison_state, BRANCH_COMPARISON_OK);
        assert_eq!(behind_status.ahead, 0);
        assert_eq!(behind_status.behind, 1);

        let diverged_fixture = create_branch_fixture("status-diverged");
        commit_file(
            &diverged_fixture.repo_path,
            "local.txt",
            "local\n",
            "local diverged",
        );
        create_remote_commit(&diverged_fixture, "remote.txt", "remote\n");
        let diverged_status =
            get_repo_status_inner(diverged_fixture.repo_path_string(), &diverged_fixture.state)
                .await
                .unwrap();
        assert_eq!(diverged_status.comparison_state, BRANCH_COMPARISON_OK);
        assert_eq!(diverged_status.ahead, 1);
        assert_eq!(diverged_status.behind, 1);
    }

    #[tokio::test]
    async fn commit_history_includes_upstream_only_commits_separately() {
        let fixture = create_branch_fixture("history-remote-commits");
        create_remote_commit(&fixture, "remote-history.txt", "remote history\n");
        let remote_head =
            run_test_git(&fixture.repo_path, &["rev-parse", "--short", "origin/main"]);

        let history = get_repo_commit_history_inner(
            fixture.repo_path_string(),
            30,
            Some("main".to_string()),
            &fixture.state,
        )
        .await
        .unwrap();

        assert_eq!(history.branch, "main");
        assert_eq!(history.remote_branch.as_deref(), Some("origin/main"));
        assert_eq!(
            history.remote_head_hash.as_deref(),
            Some(remote_head.as_str())
        );
        assert!(history
            .commits
            .iter()
            .any(|commit| commit.message == "initial commit"));
        assert!(history
            .remote_commits
            .iter()
            .any(|commit| commit.message == "remote remote-history.txt"));
        assert!(!history
            .commits
            .iter()
            .any(|commit| commit.message == "remote remote-history.txt"));
    }

    #[tokio::test]
    async fn branch_overview_preserves_remote_only_identity_per_remote() {
        let fixture = create_branch_fixture("overview-remote-only");
        let upstream_path = add_upstream_remote_with_main(&fixture);
        create_remote_branch(&fixture, "feature", "origin-feature.txt");
        create_branch_on_remote(
            fixture._root.path(),
            &upstream_path,
            "feature",
            "upstream-feature.txt",
        );
        run_test_git(&fixture.repo_path, &["fetch", "--all", "--prune"]);

        let overview = get_repo_branch_overview_inner(fixture.repo_path_string(), &fixture.state)
            .await
            .unwrap();

        let remote_rows: Vec<_> = overview
            .branches
            .iter()
            .filter(|branch| {
                branch.is_remote_only && branch.local_name.as_deref() == Some("feature")
            })
            .collect();
        assert_eq!(remote_rows.len(), 2);
        assert!(remote_rows.iter().any(|branch| {
            branch.identity == "remote:refs/remotes/origin/feature"
                && branch.name == "origin/feature"
                && branch.remote_name.as_deref() == Some("origin")
                && branch.comparison_state == BRANCH_COMPARISON_REMOTE_ONLY
        }));
        assert!(remote_rows.iter().any(|branch| {
            branch.identity == "remote:refs/remotes/upstream/feature"
                && branch.name == "upstream/feature"
                && branch.remote_name.as_deref() == Some("upstream")
                && branch.comparison_state == BRANCH_COMPARISON_REMOTE_ONLY
        }));
        assert_eq!(overview.remote_only_count, 2);
    }

    #[tokio::test]
    async fn branch_overview_counts_local_branch_once_when_remote_ref_matches() {
        let fixture = create_branch_fixture("overview-local-count");

        let overview = get_repo_branch_overview_inner(fixture.repo_path_string(), &fixture.state)
            .await
            .unwrap();

        assert_eq!(overview.local_branch_count, 1);
        assert_eq!(overview.remote_branch_count, 1);
        assert_eq!(
            overview
                .branches
                .iter()
                .filter(|branch| branch.local_name.as_deref() == Some("main"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn branch_overview_does_not_merge_remote_refs_when_local_branch_exists() {
        let fixture = create_branch_fixture("overview-local-plus-remotes");
        let upstream_path = add_upstream_remote_with_main(&fixture);
        run_test_git(&fixture.repo_path, &["switch", "-c", "feature"]);
        commit_file(
            &fixture.repo_path,
            "feature.txt",
            "local\n",
            "local feature",
        );
        run_test_git(&fixture.repo_path, &["push", "-u", "origin", "feature"]);
        create_branch_on_remote(
            fixture._root.path(),
            &upstream_path,
            "feature",
            "upstream-feature.txt",
        );
        run_test_git(&fixture.repo_path, &["fetch", "--all", "--prune"]);

        let overview = get_repo_branch_overview_inner(fixture.repo_path_string(), &fixture.state)
            .await
            .unwrap();

        let feature_rows: Vec<_> = overview
            .branches
            .iter()
            .filter(|branch| branch.local_name.as_deref() == Some("feature"))
            .collect();
        assert_eq!(feature_rows.len(), 3);
        assert!(feature_rows.iter().any(|branch| {
            branch.identity == "local:feature"
                && branch.name == "feature"
                && branch.has_local
                && branch.has_remote
        }));
        assert!(feature_rows.iter().any(|branch| {
            branch.identity == "remote:refs/remotes/origin/feature"
                && branch.name == "origin/feature"
                && branch.has_local
                && !branch.is_remote_only
        }));
        assert!(feature_rows.iter().any(|branch| {
            branch.identity == "remote:refs/remotes/upstream/feature"
                && branch.name == "upstream/feature"
                && branch.has_local
                && !branch.is_remote_only
        }));
    }

    #[tokio::test]
    async fn branch_operations_switch_local_and_track_exact_remote_without_touching_sync_time() {
        let fixture = create_branch_fixture("branch-operations");
        let path = fixture.repo_path_string();
        run_test_git(&fixture.repo_path, &["branch", "local-only"]);
        let mut repo = test_repo_config("repo-1", &path);
        repo.last_sync_at = Some("1710000000".to_string());
        fixture.state.repos.lock().unwrap().push(repo);

        let local_result =
            switch_repo_branch_inner(path.clone(), "local-only".to_string(), None, &fixture.state)
                .await
                .unwrap();
        assert!(local_result.switched);
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--show-current"]),
            "local-only"
        );
        assert_eq!(
            fixture.state.repos.lock().unwrap()[0]
                .last_sync_at
                .as_deref(),
            Some("1710000000")
        );

        let tracking_fixture = create_branch_fixture("branch-track-exact");
        create_remote_branch(&tracking_fixture, "track-me", "track-me.txt");
        let tracking_result = switch_repo_branch_inner(
            tracking_fixture.repo_path_string(),
            "track-me".to_string(),
            Some("origin/track-me".to_string()),
            &tracking_fixture.state,
        )
        .await
        .unwrap();
        assert!(tracking_result.switched);
        assert!(tracking_result.tracked);
        assert_eq!(
            run_test_git(&tracking_fixture.repo_path, &["branch", "--show-current"]),
            "track-me"
        );
        assert_eq!(
            run_test_git(
                &tracking_fixture.repo_path,
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]
            ),
            "origin/track-me"
        );
    }

    #[tokio::test]
    async fn branch_shortcut_switches_to_a_behind_branch_and_fast_forwards_it() {
        let fixture = create_branch_fixture("branch-shortcut-update");
        run_test_git(&fixture.repo_path, &["switch", "-c", "feature-a"]);
        create_remote_commit(&fixture, "merged-pr.txt", "merged pull request\n");
        let remote_head = run_test_git(&fixture.repo_path, &["rev-parse", "origin/main"]);

        let result = switch_and_update_repo_branch_inner(
            fixture.repo_path_string(),
            "main".to_string(),
            &fixture.state,
        )
        .await
        .unwrap();

        assert!(result.switched);
        assert!(result.remote_fetched);
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--show-current"]),
            "main"
        );
        assert_eq!(
            run_test_git(&fixture.repo_path, &["rev-parse", "HEAD"]),
            remote_head
        );
    }

    #[tokio::test]
    async fn branch_shortcut_refuses_a_divergent_branch_before_switching() {
        let fixture = create_branch_fixture("branch-shortcut-divergent");
        commit_file(
            &fixture.repo_path,
            "local-main.txt",
            "local main commit\n",
            "local main commit",
        );
        run_test_git(&fixture.repo_path, &["switch", "-c", "feature-a"]);
        create_remote_commit(&fixture, "remote-main.txt", "remote main commit\n");

        let error = switch_and_update_repo_branch_inner(
            fixture.repo_path_string(),
            "main".to_string(),
            &fixture.state,
        )
        .await
        .unwrap_err();

        assert!(error.contains("不能直接快进更新"));
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--show-current"]),
            "feature-a"
        );
    }

    #[tokio::test]
    async fn branch_operations_switch_from_detached_head_to_local_branch() {
        let fixture = create_branch_fixture("branch-switch-detached");
        let path = fixture.repo_path_string();
        run_test_git(&fixture.repo_path, &["switch", "--detach", "HEAD"]);
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--show-current"]),
            ""
        );

        let result = switch_repo_branch_inner(path, "main".to_string(), None, &fixture.state)
            .await
            .unwrap();

        assert!(result.switched);
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--show-current"]),
            "main"
        );
    }

    #[tokio::test]
    async fn upstream_gone_branches_can_rebind_or_unset_explicitly() {
        let fixture = create_branch_fixture("upstream-gone");
        let upstream_path = add_upstream_remote_with_main(&fixture);
        let path = fixture.repo_path_string();
        run_test_git(&fixture.repo_path, &["switch", "-c", "feature"]);
        commit_file(&fixture.repo_path, "feature.txt", "feature\n", "feature");
        run_test_git(&fixture.repo_path, &["push", "-u", "origin", "feature"]);
        run_test_git(&fixture.repo_path, &["switch", "main"]);
        run_test_git(
            &fixture.repo_path,
            &["push", "origin", "--delete", "feature"],
        );
        create_branch_on_remote(
            fixture._root.path(),
            &upstream_path,
            "feature",
            "upstream-feature.txt",
        );
        run_test_git(&fixture.repo_path, &["fetch", "--all", "--prune"]);

        let overview = get_repo_branch_overview_inner(path.clone(), &fixture.state)
            .await
            .unwrap();
        let feature = overview
            .branches
            .iter()
            .find(|branch| branch.name == "feature")
            .unwrap();
        assert!(feature.upstream_gone);
        assert_eq!(feature.comparison_state, BRANCH_COMPARISON_UPSTREAM_GONE);
        assert_eq!(feature.rebind_upstream.as_deref(), Some("upstream/feature"));

        let rebind_result = rebind_repo_branch_upstream_inner(
            path.clone(),
            "feature".to_string(),
            "upstream/feature".to_string(),
            &fixture.state,
        )
        .await
        .unwrap();
        assert!(rebind_result.tracked);
        assert_eq!(
            run_test_git(
                &fixture.repo_path,
                &[
                    "for-each-ref",
                    "--format=%(upstream:short)",
                    "refs/heads/feature"
                ]
            ),
            "upstream/feature"
        );

        unset_repo_branch_upstream_inner(path.clone(), "feature".to_string(), &fixture.state)
            .await
            .unwrap();
        let overview = get_repo_branch_overview_inner(path, &fixture.state)
            .await
            .unwrap();
        let feature = overview
            .branches
            .iter()
            .find(|branch| branch.name == "feature")
            .unwrap();
        assert_eq!(feature.comparison_state, BRANCH_COMPARISON_NO_UPSTREAM);
        assert_eq!(feature.upstream, None);
    }

    #[tokio::test]
    async fn branch_delete_refuses_current_branch() {
        let fixture = create_branch_fixture("branch-delete-current");
        let error = delete_branch_locked(
            &fixture.repo_path_string(),
            &BranchDeleteRequest {
                identity: String::new(),
                branch: "main".to_string(),
                remote_branch: None,
                delete_local: true,
                delete_remote: false,
                force_delete: false,
            },
        )
        .await
        .unwrap_err();

        assert!(error.contains("不能删除当前分支"));
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--show-current"]),
            "main"
        );
    }

    #[tokio::test]
    async fn branch_delete_removes_local_branch_safely() {
        let fixture = create_branch_fixture("branch-delete-local");
        run_test_git(&fixture.repo_path, &["branch", "cleanup"]);

        let result = delete_branch_locked(
            &fixture.repo_path_string(),
            &BranchDeleteRequest {
                identity: String::new(),
                branch: "cleanup".to_string(),
                remote_branch: None,
                delete_local: true,
                delete_remote: false,
                force_delete: false,
            },
        )
        .await
        .unwrap();

        assert!(result.message.contains("已删除本地分支"));
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--list", "cleanup"]),
            ""
        );
    }

    #[tokio::test]
    async fn branch_delete_can_remove_local_and_remote_branch() {
        let fixture = create_branch_fixture("branch-delete-local-remote");
        run_test_git(&fixture.repo_path, &["branch", "cleanup"]);
        run_test_git(&fixture.repo_path, &["push", "-u", "origin", "cleanup"]);

        let result = delete_branch_locked(
            &fixture.repo_path_string(),
            &BranchDeleteRequest {
                identity: String::new(),
                branch: "cleanup".to_string(),
                remote_branch: Some("origin/cleanup".to_string()),
                delete_local: true,
                delete_remote: true,
                force_delete: false,
            },
        )
        .await
        .unwrap();

        assert_eq!(result.warning, None);
        assert!(result
            .message
            .contains("已删除本地分支 cleanup 和远端分支 origin/cleanup"));
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--list", "cleanup"]),
            ""
        );
        assert_eq!(
            run_test_git(
                &fixture.repo_path,
                &["ls-remote", "--heads", "origin", "cleanup"]
            ),
            ""
        );
    }

    #[tokio::test]
    async fn branch_delete_can_remove_remote_only_branch() {
        let fixture = create_branch_fixture("branch-delete-remote-only");
        create_remote_branch(&fixture, "remote-cleanup", "remote-cleanup.txt");

        let result = delete_branch_locked(
            &fixture.repo_path_string(),
            &BranchDeleteRequest {
                identity: String::new(),
                branch: "remote-cleanup".to_string(),
                remote_branch: Some("origin/remote-cleanup".to_string()),
                delete_local: false,
                delete_remote: true,
                force_delete: false,
            },
        )
        .await
        .unwrap();

        assert!(result.message.contains("已删除远端分支"));
        assert_eq!(
            run_test_git(
                &fixture.repo_path,
                &["ls-remote", "--heads", "origin", "remote-cleanup"]
            ),
            ""
        );
    }

    #[tokio::test]
    async fn branch_delete_safe_and_forced_share_one_command() {
        let fixture = create_branch_fixture("branch-delete-force");
        run_test_git(&fixture.repo_path, &["switch", "-c", "unmerged"]);
        commit_file(&fixture.repo_path, "only-here.txt", "x\n", "unmerged work");
        run_test_git(&fixture.repo_path, &["switch", "main"]);

        // The same command refuses an unmerged branch when force is not requested...
        let safe_error = delete_branch_locked(
            &fixture.repo_path_string(),
            &BranchDeleteRequest {
                identity: String::new(),
                branch: "unmerged".to_string(),
                remote_branch: None,
                delete_local: true,
                delete_remote: false,
                force_delete: false,
            },
        )
        .await
        .unwrap_err();
        assert!(safe_error.contains("删除本地分支失败"));

        // ...and removes it when the request carries force_delete.
        let result = delete_branch_locked(
            &fixture.repo_path_string(),
            &BranchDeleteRequest {
                identity: String::new(),
                branch: "unmerged".to_string(),
                remote_branch: None,
                delete_local: true,
                delete_remote: false,
                force_delete: true,
            },
        )
        .await
        .unwrap();
        assert!(result.message.contains("已强制删除本地分支"));
        assert_eq!(
            run_test_git(&fixture.repo_path, &["branch", "--list", "unmerged"]),
            ""
        );
    }

    #[tokio::test]
    async fn branch_edge_cases_cover_detached_worktree_dirty_and_compare_errors() {
        let detached_fixture = create_branch_fixture("detached");
        run_test_git(&detached_fixture.repo_path, &["switch", "--detach", "HEAD"]);
        let detached_status =
            get_repo_status_inner(detached_fixture.repo_path_string(), &detached_fixture.state)
                .await
                .unwrap();
        assert!(detached_status.detached_head);
        assert!(detached_status.branch.starts_with("HEAD @ "));
        assert_eq!(detached_status.comparison_state, BRANCH_COMPARISON_DETACHED);
        let detached_overview = get_repo_branch_overview_inner(
            detached_fixture.repo_path_string(),
            &detached_fixture.state,
        )
        .await
        .unwrap();
        assert!(detached_overview.detached_head);
        assert!(detached_overview.branches.iter().any(|branch| {
            branch.detached_head && branch.is_current && branch.name.starts_with("HEAD @ ")
        }));

        let worktree_fixture = create_branch_fixture("worktree");
        let worktree_path = worktree_fixture._root.path().join("elsewhere-worktree");
        let worktree_path_string = path_to_string(&worktree_path);
        run_test_git(&worktree_fixture.repo_path, &["branch", "elsewhere"]);
        run_test_git(
            &worktree_fixture.repo_path,
            &["worktree", "add", &worktree_path_string, "elsewhere"],
        );
        let worktree_overview = get_repo_branch_overview_inner(
            worktree_fixture.repo_path_string(),
            &worktree_fixture.state,
        )
        .await
        .unwrap();
        let elsewhere = worktree_overview
            .branches
            .iter()
            .find(|branch| branch.name == "elsewhere")
            .unwrap();
        let expected_worktree_path =
            path_to_string(&fs::canonicalize(&worktree_path).unwrap_or(worktree_path));
        assert!(elsewhere.is_checked_out_elsewhere);
        assert_eq!(
            elsewhere.worktree_path.as_deref(),
            Some(expected_worktree_path.as_str())
        );
        let worktree_error = switch_repo_branch_inner(
            worktree_fixture.repo_path_string(),
            "elsewhere".to_string(),
            None,
            &worktree_fixture.state,
        )
        .await
        .unwrap_err();
        assert!(worktree_error.contains("另一个 worktree"));

        let dirty_fixture = create_branch_fixture("dirty");
        run_test_git(&dirty_fixture.repo_path, &["branch", "next"]);
        fs::write(dirty_fixture.repo_path.join("dirty.txt"), "dirty\n").unwrap();
        let dirty_error = switch_repo_branch_inner(
            dirty_fixture.repo_path_string(),
            "next".to_string(),
            None,
            &dirty_fixture.state,
        )
        .await
        .unwrap_err();
        assert_eq!(
            dirty_error,
            "工作区或暂存区存在未提交改动，请先提交、stash 或清理后再切换分支。"
        );

        let status_failure_fixture = create_branch_fixture("status-failure");
        run_test_git(&status_failure_fixture.repo_path, &["branch", "next"]);
        fs::write(
            status_failure_fixture.repo_path.join(".git").join("index"),
            "not a git index",
        )
        .unwrap();
        let status_failure_error = switch_repo_branch_inner(
            status_failure_fixture.repo_path_string(),
            "next".to_string(),
            None,
            &status_failure_fixture.state,
        )
        .await
        .unwrap_err();
        assert!(status_failure_error.contains("无法确认工作区状态，已取消分支切换"));
        assert_eq!(
            run_test_git(
                &status_failure_fixture.repo_path,
                &["rev-parse", "--abbrev-ref", "HEAD"]
            ),
            "main"
        );

        let comparison = compare_refs_async(
            &dirty_fixture.repo_path_string(),
            "main",
            "refs/heads/does-not-exist",
            1000,
        )
        .await;
        assert_eq!(comparison.state, BRANCH_COMPARISON_ERROR);
        assert_eq!(comparison.ahead, 0);
        assert_eq!(comparison.behind, 0);
        assert!(comparison.error.is_some());
    }

    #[test]
    fn repo_config_loader_accepts_legacy_entries_with_defaults() {
        let json = r#"
        [
          {
            "id": "repo-1",
            "name": "",
            "path": "C:\\Users\\me\\Repo One",
            "branch": "",
            "last_sync_at": 1710000000,
            "created_at": ""
          }
        ]
        "#;

        let (repos, skipped) = load_repo_configs_from_str(json).unwrap();

        assert_eq!(skipped, 0);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].name, "Repo One");
        assert_eq!(repos[0].branch, "main");
        assert_eq!(repos[0].sync_interval, default_sync_interval());
        assert_eq!(repos[0].auto_sync, true);
        assert_eq!(repos[0].sync_mode, "auto");
        assert_eq!(repos[0].pull_strategy, "rebase");
        assert_eq!(repos[0].status, "idle");
        assert_eq!(repos[0].last_sync_at.as_deref(), Some("1710000000"));
        assert!(!repos[0].created_at.is_empty());
    }

    #[test]
    fn repo_config_loader_skips_invalid_entries_without_dropping_valid_repos() {
        let json = r#"
        [
          { "id": "repo-1", "path": "/tmp/repo-1", "branch": "main" },
          { "id": "repo-2", "name": "missing path" }
        ]
        "#;

        let (repos, skipped) = load_repo_configs_from_str(json).unwrap();

        assert_eq!(skipped, 1);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].id, "repo-1");
    }

    #[test]
    fn app_state_init_recovers_repos_from_backup_when_primary_is_corrupt() {
        let dir = unique_temp_dir("backup-recovery");
        let data_file = dir.join(REPOS_FILE_NAME);
        let backup_file = dir.join(format!("{}.bak", REPOS_FILE_NAME));
        fs::write(&data_file, "{not valid json").unwrap();
        fs::write(
            &backup_file,
            r#"[{ "id": "repo-1", "path": "/tmp/repo-1", "branch": "main" }]"#,
        )
        .unwrap();

        let state = AppState::new();
        state.init(dir.clone());

        let repos = state.repos.lock().unwrap().clone();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].id, "repo-1");

        let repaired = fs::read_to_string(&data_file).unwrap();
        let (repaired_repos, _) = load_repo_configs_from_str(&repaired).unwrap();
        assert_eq!(repaired_repos.len(), 1);
        assert_eq!(repaired_repos[0].id, "repo-1");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn app_state_save_creates_primary_and_backup_files() {
        let dir = unique_temp_dir("save-backup");
        let data_file = dir.join(REPOS_FILE_NAME);
        let backup_file = dir.join(format!("{}.bak", REPOS_FILE_NAME));
        let state = AppState::new();
        state.init(dir.clone());

        state
            .repos
            .lock()
            .unwrap()
            .push(test_repo_config("repo-1", "/tmp/repo-1"));
        state.save();

        assert!(data_file.exists());
        assert!(backup_file.exists());
        let (repos, skipped) =
            load_repo_configs_from_str(&fs::read_to_string(&data_file).unwrap()).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].id, "repo-1");

        fs::remove_dir_all(dir).unwrap();
    }
}
fn empty_remove_repos_batch_result() -> RemoveReposBatchResult {
    RemoveReposBatchResult {
        requested_count: 0,
        removed_ids: Vec::new(),
        missing_ids: Vec::new(),
    }
}

#[tauri::command]
pub fn write_clipboard(text: String) -> Result<bool, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("剪贴板内容不能为空".to_string());
    }

    let mut clipboard =
        Clipboard::new().map_err(|error| format!("无法打开系统剪贴板: {}", error))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|error| format!("写入剪贴板失败: {}", error))?;
    Ok(true)
}
