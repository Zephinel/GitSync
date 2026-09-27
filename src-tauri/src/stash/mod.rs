use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[cfg(test)]
static STASH_TEST_REPO_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(test)]
fn stash_test_repo_path(namespace: &str, label: &str) -> PathBuf {
    use std::sync::atomic::Ordering;

    let nonce = STASH_TEST_REPO_NONCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "{namespace}-{label}-{}-{}-{nonce}",
        std::process::id(),
        now_ms()
    ))
}

const GIT_STASH_META_TIMEOUT_MS: u64 = 8_000;
const GIT_STASH_STATUS_TIMEOUT_MS: u64 = 15_000;
const GIT_STASH_DIGEST_TIMEOUT_MS: u64 = 30_000;
const GIT_STASH_OPERATION_TIMEOUT_MS: u64 = 60_000;
const GIT_STASH_BASE_SUMMARY_LIMIT: usize = 100;
const STASH_DETAIL_MAX_FILES: usize = 5_000;
const STASH_DETAIL_MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
const STASH_OPERATION_DIRECTORY: &str = "gitsync/stash-operations";
const STASH_JOURNAL_VERSION: u32 = 1;
const STASH_MESSAGE_MAX_CHARS: usize = 500;
const STASH_SETTLED_RETENTION_MS: u128 = 30 * 24 * 60 * 60 * 1_000;
const STASH_SETTLED_MAX_JOURNALS: usize = 256;

#[derive(Debug)]
struct GitCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct RepoStashEntry {
    pub id: String,
    pub oid: String,
    pub selector: String,
    pub ordinal: usize,
    pub message: String,
    pub subject: String,
    pub branch_context: Option<String>,
    pub created_at: String,
    pub base_commit: Option<String>,
    pub base_summary: Option<String>,
    pub includes_untracked: bool,
    pub scope_summary: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct RepoStashDetailFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    pub is_untracked: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoStashDetail {
    pub entry: RepoStashEntry,
    pub file_count: usize,
    pub additions: u32,
    pub deletions: u32,
    pub added_files: usize,
    pub modified_files: usize,
    pub deleted_files: usize,
    pub renamed_files: usize,
    pub untracked_files: usize,
    pub files_truncated: bool,
    pub files: Vec<RepoStashDetailFile>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoStashFileDiff {
    pub stash_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub patch: String,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    pub truncated: bool,
    pub too_large: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct PendingStashOperation {
    pub request_id: String,
    pub operation: String,
    pub target_stash_id: Option<String>,
    pub origin_repo_path: Option<String>,
    pub status: String,
    pub message: String,
    pub updated_at_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashPathTarget {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
struct StashWorktreeFile {
    path: String,
    old_path: Option<String>,
    code: String,
    is_untracked: bool,
    is_conflicted: bool,
    has_staged_changes: bool,
    has_unstaged_changes: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoStashSnapshot {
    pub repo_path: String,
    pub branch: Option<String>,
    pub detached_head: bool,
    pub head_hash: Option<String>,
    pub snapshot_id: String,
    pub worktree_id: String,
    pub staged_files: usize,
    pub unstaged_files: usize,
    pub mixed_files: usize,
    pub untracked_files: usize,
    pub conflicted_files: usize,
    pub conflict_paths: Vec<String>,
    pub has_tracked_changes: bool,
    pub has_untracked_changes: bool,
    pub can_create_default: bool,
    pub can_create_with_untracked: bool,
    pub stash_total: usize,
    pub stashes_truncated: bool,
    pub stashes: Vec<RepoStashEntry>,
    #[serde(skip_serializing)]
    pub(crate) all_stashes: Vec<RepoStashEntry>,
    pub pending_operation_total: usize,
    pub pending_operations_truncated: bool,
    pub pending_operations: Vec<PendingStashOperation>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateStashRequest {
    pub request_id: String,
    pub expected_snapshot_id: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub include_untracked: bool,
    #[serde(default)]
    pub keep_index: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TargetStashRequest {
    pub request_id: String,
    pub expected_snapshot_id: String,
    pub stash_id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StashOperationResult {
    pub operation: String,
    pub request_id: String,
    pub status: String,
    pub mutated: bool,
    pub needs_confirmation: bool,
    pub worktree_changed: bool,
    pub created_stash_id: Option<String>,
    pub target_stash_id: Option<String>,
    pub applied: bool,
    pub dropped: bool,
    pub stash_retained: bool,
    pub conflicts: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub snapshot: Option<RepoStashSnapshot>,
    pub snapshot_error: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StashOperationSignature {
    operation: String,
    expected_snapshot_id: String,
    target_stash_id: Option<String>,
    message: String,
    include_untracked: bool,
    keep_index: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredStashOperationResult {
    operation: String,
    request_id: String,
    status: String,
    mutated: bool,
    needs_confirmation: bool,
    worktree_changed: bool,
    created_stash_id: Option<String>,
    target_stash_id: Option<String>,
    applied: bool,
    dropped: bool,
    stash_retained: bool,
    conflicts: Vec<String>,
    warnings: Vec<String>,
    errors: Vec<String>,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StashOperationJournal {
    version: u32,
    request_id: String,
    #[serde(default)]
    origin_repo_root: String,
    #[serde(default)]
    completion_validated: bool,
    signature: StashOperationSignature,
    phase: String,
    created_at_ms: u128,
    updated_at_ms: u128,
    before_snapshot_id: String,
    before_worktree_id: String,
    before_stash_ids: Vec<String>,
    command_success: Option<bool>,
    command_error: Option<String>,
    result: Option<StoredStashOperationResult>,
}

include!("git.rs");
include!("git_stream.rs");
include!("snapshot_stream.rs");
include!("snapshot.rs");
include!("selected_scope.rs");
include!("selected_scope_budget.rs");
include!("stash_detail_stream.rs");
include!("stash_detail.rs");
include!("journal.rs");
include!("selected_create.rs");
include!("completion_finalizer.rs");
include!("operation_authority.rs");
include!("stash_detail_guard.rs");
include!("reconcile.rs");
include!("retention.rs");
include!("commands.rs");
include!("snapshot_guard.rs");
include!("create_guard.rs");
include!("restore_guard.rs");
include!("drop_guard.rs");
include!("selected_create_guard.rs");
include!("acknowledge_guard.rs");

#[cfg(test)]
include!("tests.rs");
#[cfg(test)]
include!("snapshot_stream_tests.rs");
#[cfg(test)]
include!("git_tests.rs");
#[cfg(test)]
include!("long_list_tests.rs");
#[cfg(test)]
include!("selected_scope_tests.rs");
#[cfg(test)]
include!("selected_git_tests.rs");
#[cfg(test)]
include!("stash_detail_tests.rs");
#[cfg(test)]
include!("stash_detail_git_tests.rs");
#[cfg(test)]
include!("selected_scope_git_tests.rs");
#[cfg(test)]
include!("journal_validation_tests.rs");
