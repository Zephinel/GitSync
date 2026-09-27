use crate::commands::AppState;
use tauri::State;

#[cfg_attr(test, allow(dead_code))]
mod implementation {
    include!("staging.rs");
    include!("staging_authority_overlay.rs");
}

pub use implementation::{
    AuthoritativeStagingTarget as StagingTarget, RepoStagingSnapshot, StagingOperationResult,
};

#[tauri::command]
pub async fn get_repo_staging_snapshot(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<RepoStagingSnapshot, String> {
    implementation::get_repo_staging_snapshot_authoritative(repo_path, state).await
}

#[tauri::command]
pub async fn stage_repo_files(
    repo_path: String,
    files: Vec<StagingTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<StagingOperationResult, String> {
    implementation::run_staging_operation_authoritative(
        "stage",
        repo_path,
        files,
        expected_snapshot_id,
        state,
    )
    .await
}

#[tauri::command]
pub async fn unstage_repo_files(
    repo_path: String,
    files: Vec<StagingTarget>,
    expected_snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<StagingOperationResult, String> {
    implementation::run_staging_operation_authoritative(
        "unstage",
        repo_path,
        files,
        expected_snapshot_id,
        state,
    )
    .await
}
