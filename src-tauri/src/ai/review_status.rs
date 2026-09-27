use crate::ai::errors::AiUiError;
use crate::ai::review_pipeline::capture_review_plan;
use crate::commands::AppState;
use crate::working_changes::WorkingChangeTarget;
use tauri::State;

#[tauri::command]
pub async fn get_ai_review_scope_fingerprint(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    scope_kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, AiUiError> {
    let scope_kind = scope_kind.unwrap_or_else(|| "all".to_string());
    capture_review_plan(&repo_path, &files, &scope_kind, &state)
        .await
        .map(|plan| plan.fingerprint)
}
