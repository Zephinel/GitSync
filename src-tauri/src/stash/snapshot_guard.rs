pub mod authoritative_snapshot {
    use super::{
        acquire_repo_git_read_guard, acquire_stash_operation_authority, ensure_repo_path,
        prune_settled_stash_journals, read_stash_snapshot, resolve_repo_root, AppState,
        RepoStashSnapshot,
    };
    use tauri::State;

    #[tauri::command]
    pub async fn get_repo_stash_snapshot(
        repo_path: String,
        state: State<'_, AppState>,
    ) -> Result<RepoStashSnapshot, String> {
        ensure_repo_path(&repo_path)?;
        let repo_root = resolve_repo_root(&repo_path).await?;

        // Public snapshot reads share the same lock order as authoritative
        // mutations: common-dir Stash authority first, repository Git guard
        // second. Holding Stash authority through projection prevents a reader
        // from observing the gap between raw Git mutation and final evidence
        // validation/persistence.
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        let _ = prune_settled_stash_journals(&repo_root).await;
        let _guard = acquire_repo_git_read_guard(&state, &repo_root).await?;
        read_stash_snapshot(&repo_root).await
    }
}
