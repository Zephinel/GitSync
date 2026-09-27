fn acknowledged_stash_result(
    existing: Option<StoredStashOperationResult>,
    operation: &str,
    request_id: &str,
    target_stash_id: Option<String>,
    snapshot_id: &str,
) -> StoredStashOperationResult {
    let mut result = existing.unwrap_or_else(|| {
        stored_result(
            operation,
            request_id,
            "acknowledged",
            target_stash_id,
            "用户已接受当前仓库状态。",
        )
    });
    result.status = "acknowledged".to_string();
    result.needs_confirmation = false;
    result.message = format!(
        "用户已基于当前权威快照 {} 接受该操作的现状；本次确认没有执行任何 Git mutation。",
        snapshot_id
    );
    result
}

pub mod authoritative_acknowledge {
    use super::{
        acknowledged_stash_result, acquire_repo_git_guard,
        acquire_stash_operation_authority, ensure_repo_path,
        ensure_stash_evidence_readable_for_request, ensure_stash_journal_origin,
        load_selected_stash_journal_authoritative, load_stash_journal,
        normalize_request_id, operation_result, precondition_result,
        project_operation_result_snapshot, read_stash_snapshot, read_stash_snapshot_core,
        resolve_repo_root, selected_stash_operation_path, settle_selected_stash_journal,
        settle_stash_journal, stash_operation_path, stash_request_journal_family,
        stash_result_is_durable_terminal, AppState, StashJournalFamily, StashOperationResult,
    };
    use tauri::State;

    #[tauri::command]
    pub async fn acknowledge_repo_stash_operation(
        repo_path: String,
        request_id: String,
        expected_snapshot_id: String,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        ensure_repo_path(&repo_path)?;
        let request_id = normalize_request_id(&request_id)?;
        let expected_snapshot_id = expected_snapshot_id.trim().to_string();
        if expected_snapshot_id.is_empty() {
            return Err("确认 Stash 操作时必须绑定当前快照。".to_string());
        }
        let repo_root = resolve_repo_root(&repo_path).await?;
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        let family = stash_request_journal_family(&repo_root, &request_id).await?;
        ensure_stash_evidence_readable_for_request(&repo_root, &request_id).await?;
        let _guard = acquire_repo_git_guard(&state, &repo_root).await?;

        let current = read_stash_snapshot_core(&repo_root).await?;
        if current.snapshot_id != expected_snapshot_id {
            let result = precondition_result(
                "acknowledge",
                &request_id,
                "stale",
                None,
                current,
                "Stash 列表或工作区已经变化；请刷新并重新确认当前状态。",
            );
            return project_operation_result_snapshot(&repo_root, result).await;
        }

        match family {
            Some(StashJournalFamily::Regular) => {
                let journal_path = stash_operation_path(&repo_root, &request_id).await?;
                let mut journal = load_stash_journal(&journal_path)?
                    .ok_or_else(|| "找不到需要接受的 Stash 操作记录。".to_string())?;
                // Legacy journals without an origin can only leave the system through
                // explicit user acknowledgement. A known origin must still match.
                ensure_stash_journal_origin(&journal.origin_repo_root, &repo_root, true)?;
                if let Some(result) = journal.result.clone().filter(|result| {
                    stash_result_is_durable_terminal(result, journal.completion_validated)
                }) {
                    return match read_stash_snapshot(&repo_root).await {
                        Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
                        Err(error) => Ok(operation_result(result, None, Some(error))),
                    };
                }
                let result = acknowledged_stash_result(
                    journal.result.clone(),
                    &journal.signature.operation,
                    &journal.request_id,
                    journal.signature.target_stash_id.clone(),
                    &current.snapshot_id,
                );
                settle_stash_journal(
                    &repo_root,
                    &journal_path,
                    &mut journal,
                    result,
                )
                .await
            }
            Some(StashJournalFamily::Selected) => {
                let selected_path = selected_stash_operation_path(&repo_root, &request_id).await?;
                let mut journal = load_selected_stash_journal_authoritative(&selected_path)?
                    .ok_or_else(|| "找不到需要接受的文件级 Stash 操作记录。".to_string())?;
                ensure_stash_journal_origin(&journal.origin_repo_root, &repo_root, true)?;
                if let Some(result) = journal.result.clone().filter(|result| {
                    stash_result_is_durable_terminal(result, journal.completion_validated)
                }) {
                    return match read_stash_snapshot(&repo_root).await {
                        Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
                        Err(error) => Ok(operation_result(result, None, Some(error))),
                    };
                }
                let result = acknowledged_stash_result(
                    journal.result.clone(),
                    "create_selected",
                    &journal.request_id,
                    None,
                    &current.snapshot_id,
                );
                settle_selected_stash_journal(
                    &repo_root,
                    &selected_path,
                    &mut journal,
                    result,
                )
                .await
            }
            None => Err("找不到需要接受的 Stash 操作记录。".to_string()),
        }
    }
}
