pub mod authoritative_detail {
    use super::{
        acquire_repo_git_read_guard, acquire_stash_operation_authority, ensure_repo_path,
        read_repo_stash_detail, read_repo_stash_file_diff, resolve_repo_root, AppState,
        RepoStashDetail, RepoStashFileDiff,
    };
    use tauri::State;

    #[tauri::command]
    pub async fn get_repo_stash_detail(
        repo_path: String,
        stash_id: String,
        state: State<'_, AppState>,
    ) -> Result<RepoStashDetail, String> {
        ensure_repo_path(&repo_path)?;
        let repo_root = resolve_repo_root(&repo_path).await?;
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        let _guard = acquire_repo_git_read_guard(&state, &repo_root).await?;
        read_repo_stash_detail(&repo_root, &stash_id).await
    }

    #[tauri::command]
    pub async fn get_repo_stash_file_diff(
        repo_path: String,
        stash_id: String,
        path: String,
        state: State<'_, AppState>,
    ) -> Result<RepoStashFileDiff, String> {
        ensure_repo_path(&repo_path)?;
        let repo_root = resolve_repo_root(&repo_path).await?;
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        let _guard = acquire_repo_git_read_guard(&state, &repo_root).await?;
        read_repo_stash_file_diff(&repo_root, &stash_id, &path).await
    }
}
