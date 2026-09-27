async fn persist_restore_uncertainty(
    repo_root: &str,
    request_id: &str,
    result: &StashOperationResult,
    warning: &str,
    message: &str,
) -> Result<(), String> {
    let journal_path = stash_operation_path(repo_root, request_id).await?;
    let Some(mut journal) = load_stash_journal(&journal_path)? else {
        return Err("找不到需要更新的 Stash 恢复操作记录。".to_string());
    };
    let mut stored = journal.result.clone().unwrap_or_else(|| {
        stored_result(
            &result.operation,
            request_id,
            "needs_confirmation",
            result.target_stash_id.clone(),
            message,
        )
    });
    stored.status = "needs_confirmation".to_string();
    stored.needs_confirmation = true;
    stored.mutated = result.mutated;
    stored.worktree_changed = result.worktree_changed;
    stored.target_stash_id = result.target_stash_id.clone();
    stored.applied = result.applied;
    stored.dropped = result.dropped;
    stored.stash_retained = result.stash_retained;
    stored.conflicts = result.conflicts.clone();
    if !stored.warnings.iter().any(|value| value == warning) {
        stored.warnings.push(warning.to_string());
    }
    stored.message = message.to_string();
    journal.phase = "settled".to_string();
    journal.completion_validated = false;
    journal.result = Some(stored);
    persist_stash_journal(&journal_path, &mut journal)
}

fn downgrade_restore_result(
    result: &mut StashOperationResult,
    warning: &str,
    message: &str,
) {
    result.status = "needs_confirmation".to_string();
    result.needs_confirmation = true;
    if !result.warnings.iter().any(|value| value == warning) {
        result.warnings.push(warning.to_string());
    }
    result.message = message.to_string();
}

async fn validate_restore_complete_result_under_guard(
    repo_root: &str,
    mut result: StashOperationResult,
) -> Result<StashOperationResult, String> {
    if result.status != "complete" {
        return Ok(result);
    }

    let journal_path = stash_operation_path(repo_root, &result.request_id).await?;
    let journal = load_stash_journal(&journal_path)?;
    if journal
        .as_ref()
        .is_some_and(|value| value.completion_validated)
    {
        return Ok(result);
    }
    let command_success = journal
        .as_ref()
        .and_then(|value| value.command_success)
        == Some(true);
    let target_id = result.target_stash_id.clone().unwrap_or_default();
    let target_present = result
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| find_stash_entry(snapshot, &target_id).is_some());

    let uncertainty = if !command_success {
        Some((
            "Stash 恢复没有留下明确的 Git 命令成功证据；不会把外部工作区或列表变化冒认为本次结果。",
            "当前仓库已经发生变化，但本次恢复命令身份无法完整确认；结果需要确认。",
        ))
    } else if result.operation == "apply"
        && (!result.applied || result.dropped || !result.stash_retained || !target_present)
    {
        Some((
            "Apply 的最终条目身份与返回结果不一致。",
            "Stash 内容可能已经应用，但原条目保留状态无法由当前权威快照确认。",
        ))
    } else if result.operation == "pop"
        && (!result.applied || !result.dropped || result.stash_retained || target_present)
    {
        Some((
            "Pop 的应用或删除身份与返回结果不一致。",
            "Stash Pop 的完整成功条件尚未同时得到权威快照确认。",
        ))
    } else {
        None
    };

    if let Some((warning, message)) = uncertainty {
        downgrade_restore_result(&mut result, warning, message);
        if let Err(error) = persist_restore_uncertainty(
            repo_root,
            &result.request_id,
            &result,
            warning,
            message,
        )
        .await
        {
            result.errors.push(format!(
                "无法持久化 Stash 恢复的不确定状态：{}",
                error
            ));
        }
    }

    Ok(finalize_validated_completion_result(repo_root, result).await)
}

pub mod authoritative_restore {
    use super::{
        acquire_repo_git_guard, acquire_stash_operation_authority,
        ensure_no_other_unresolved_stash_operation, ensure_repo_path,
        ensure_stash_evidence_readable_for_request, ensure_stash_request_family,
        normalize_request_id, normalize_stash_id, project_operation_result_snapshot,
        reconcile_matching_stash_request, resolve_repo_root, stash_operation_path,
        validate_restore_complete_result_under_guard, AppState, StashJournalFamily,
        StashOperationResult, StashOperationSignature, TargetStashRequest,
    };
    use tauri::State;

    async fn validate_complete_result(
        repo_root: &str,
        state: &State<'_, AppState>,
        result: StashOperationResult,
    ) -> Result<StashOperationResult, String> {
        let _guard = acquire_repo_git_guard(state, repo_root).await?;
        validate_restore_complete_result_under_guard(repo_root, result).await
    }

    async fn run(
        operation: &str,
        repo_path: String,
        request: TargetStashRequest,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        ensure_repo_path(&repo_path)?;
        let request_id = normalize_request_id(&request.request_id)?;
        let target_id = normalize_stash_id(&request.stash_id)?;
        let repo_root = resolve_repo_root(&repo_path).await?;
        let signature = StashOperationSignature {
            operation: operation.to_string(),
            expected_snapshot_id: request.expected_snapshot_id.clone(),
            target_stash_id: Some(target_id),
            message: String::new(),
            include_untracked: false,
            keep_index: false,
        };
        let journal_path = stash_operation_path(&repo_root, &request_id).await?;
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        ensure_stash_request_family(
            &repo_root,
            &request_id,
            StashJournalFamily::Regular,
        )
        .await?;
        ensure_stash_evidence_readable_for_request(&repo_root, &request_id).await?;

        {
            let _guard = acquire_repo_git_guard(&state, &repo_root).await?;
            if let Some(result) = reconcile_matching_stash_request(
                &repo_root,
                &journal_path,
                &signature,
            )
            .await?
            {
                let result = validate_restore_complete_result_under_guard(&repo_root, result).await?;
                return project_operation_result_snapshot(&repo_root, result).await;
            }
        }

        ensure_no_other_unresolved_stash_operation(&repo_root, &request_id).await?;
        let result = match operation {
            "apply" => super::apply_repo_stash(repo_path, request, state.clone()).await?,
            "pop" => super::pop_repo_stash(repo_path, request, state.clone()).await?,
            _ => return Err("不受支持的 Stash 恢复操作。".to_string()),
        };
        let result = validate_complete_result(&repo_root, &state, result).await?;
        project_operation_result_snapshot(&repo_root, result).await
    }

    #[tauri::command]
    pub async fn apply_repo_stash(
        repo_path: String,
        request: TargetStashRequest,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        run("apply", repo_path, request, state).await
    }

    #[tauri::command]
    pub async fn pop_repo_stash(
        repo_path: String,
        request: TargetStashRequest,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        run("pop", repo_path, request, state).await
    }
}
