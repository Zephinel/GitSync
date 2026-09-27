use crate::commands::AppState;
use tauri::State;

#[cfg_attr(test, allow(dead_code))]
mod implementation {
    include!("working_changes.rs");
    include!("working_changes_authority_overlay.rs");
}

pub use implementation::{
    AuthoritativeWorkingChangeTarget as WorkingChangeTarget, RepoWorkingChangesSummary,
    RepoWorkingFileDiff, WorkingChangesOperationResult,
};

#[tauri::command]
pub async fn get_repo_working_diff_summary(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<RepoWorkingChangesSummary, String> {
    implementation::get_repo_working_diff_summary_authoritative(repo_path, state).await
}

#[tauri::command]
pub async fn get_repo_working_file_diff(
    repo_path: String,
    path: String,
    old_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoWorkingFileDiff, String> {
    implementation::get_repo_working_file_diff_authoritative(repo_path, path, old_path, state).await
}

#[tauri::command]
pub async fn discard_repo_working_files(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
    implementation::discard_repo_working_files_authoritative(
        repo_path,
        files,
        expected_snapshot_id,
        state,
    )
    .await
}

#[tauri::command]
pub async fn discard_repo_working_files_unstaged(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
    implementation::discard_repo_working_files_unstaged_authoritative(
        repo_path,
        files,
        expected_snapshot_id,
        state,
    )
    .await
}

#[tauri::command]
pub async fn commit_repo_working_files(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    expected_snapshot_id: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<WorkingChangesOperationResult, String> {
    implementation::commit_repo_working_files_authoritative(
        repo_path,
        files,
        expected_snapshot_id,
        message,
        state,
    )
    .await
}
