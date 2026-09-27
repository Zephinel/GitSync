use crate::commands::AppState;
use crate::repo_git_lock::acquire as acquire_repo_git_guard;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const GIT_META_TIMEOUT_MS: u64 = 8_000;
const GIT_FETCH_TIMEOUT_MS: u64 = 45_000;
const GIT_UPDATE_TIMEOUT_MS: u64 = 30_000;
const GIT_SWITCH_TIMEOUT_MS: u64 = 30_000;
const GIT_PUSH_TIMEOUT_MS: u64 = 60_000;
const MAX_BRANCH_NAME_CHARS: usize = 200;
const MAX_BRANCH_NAME_BYTES: usize = 240;
const OPERATION_DIRECTORY: &str = "gitsync/branch-create-operations";
const JOURNAL_VERSION: u32 = 1;

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    // Retained beside stdout/stderr for diagnostics and future typed error mapping.
    #[allow(dead_code)]
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreationSourceRequest {
    #[serde(default = "default_source_kind")]
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

fn default_source_kind() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreationSourceOption {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub full_ref: String,
    pub commit: String,
    pub branch_name: String,
    pub remote_name: Option<String>,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreationInspection {
    pub source_display_name: String,
    pub source_kind: String,
    pub relationship: String,
    pub local_name: Option<String>,
    pub local_ref: Option<String>,
    pub local_commit: Option<String>,
    pub upstream_ref: Option<String>,
    pub remote_name: Option<String>,
    pub remote_branch: Option<String>,
    pub remote_ref: Option<String>,
    pub remote_commit: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub source_options: Vec<BranchCreationSourceOption>,
    pub default_source_option_id: Option<String>,
    pub requires_source_choice: bool,
    pub warnings: Vec<String>,
    pub current_branch: Option<String>,
    pub detached_head: bool,
    pub worktree_dirty: bool,
    pub changed_path_count: usize,
    pub remotes: Vec<String>,
    pub preferred_remote: Option<String>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameValidationRequest {
    pub name: String,
    #[serde(default)]
    pub publish: bool,
    #[serde(default)]
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameValidationResult {
    pub valid: bool,
    pub normalized_name: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub local_exists: bool,
    pub remote_exists: bool,
    pub remote_checked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreationExecuteRequest {
    pub request_id: String,
    pub source: BranchCreationSourceRequest,
    pub inspection_fingerprint: String,
    pub source_option_id: String,
    pub source_ref: String,
    pub source_commit: String,
    pub branch_name: String,
    #[serde(default = "default_true")]
    pub switch_after_create: bool,
    #[serde(default)]
    pub publish: bool,
    #[serde(default)]
    pub target_remote: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreationOperationResult {
    pub request_id: String,
    pub status: String,
    pub branch_name: String,
    pub source_ref: String,
    pub source_commit: String,
    pub local_created: bool,
    pub switched: bool,
    pub current_branch: Option<String>,
    pub worktree_was_dirty: bool,
    pub worktree_is_dirty: bool,
    pub remote_created: bool,
    pub tracking_configured: bool,
    pub target_remote: Option<String>,
    pub completed_steps: Vec<String>,
    pub pending_steps: Vec<String>,
    pub retryable_steps: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub result_needs_confirmation: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreationProgressEvent {
    pub request_id: String,
    pub status: String,
    pub phase: String,
    pub label: String,
}

fn emit_operation_progress(
    app: Option<&AppHandle>,
    request_id: &str,
    status: &str,
    phase: &str,
    label: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "branch-create://progress",
            BranchCreationProgressEvent {
                request_id: request_id.to_string(),
                status: status.to_string(),
                phase: phase.to_string(),
                label: label.to_string(),
            },
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BranchCreationOperationSignature {
    source: BranchCreationSourceRequest,
    source_option_id: String,
    source_ref: String,
    source_commit: String,
    branch_name: String,
    switch_after_create: bool,
    publish: bool,
    target_remote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchCreationJournal {
    version: u32,
    request_id: String,
    signature: BranchCreationOperationSignature,
    created_at_ms: u128,
    updated_at_ms: u128,
    worktree_was_dirty: bool,
    local_state: String,
    switch_state: String,
    remote_state: String,
    tracking_state: String,
    warnings: Vec<String>,
    errors: Vec<String>,
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

include!("git.rs");
include!("source.rs");
include!("operation.rs");
include!("commands.rs");
