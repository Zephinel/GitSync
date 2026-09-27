async fn persist_drop_uncertainty(
    repo_root: &str,
    request_id: &str,
    result: &StashOperationResult,
    warning: &str,
    message: &str,
) -> Result<(), String> {
    let journal_path = stash_operation_path(repo_root, request_id).await?;
    let Some(mut journal) = load_stash_journal(&journal_path)? else {
        return Err("找不到需要更新的 Stash Drop 操作记录。".to_string());
    };
    let mut stored = journal.result.clone().unwrap_or_else(|| {
        stored_result(
            "drop",
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
    stored.dropped = result.dropped;
    stored.stash_retained = result.stash_retained;
    if !stored.warnings.iter().any(|value| value == warning) {
        stored.warnings.push(warning.to_string());
    }
    stored.message = message.to_string();
    journal.phase = "settled".to_string();
    journal.completion_validated = false;
    journal.result = Some(stored);
    persist_stash_journal(&journal_path, &mut journal)
}

fn downgrade_drop_result(
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

async fn validate_drop_complete_result_under_guard(
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
    let command_evidence_missing = journal
        .as_ref()
        .map(|value| value.command_success != Some(true))
        .unwrap_or(true);
    let target_id = result.target_stash_id.clone().unwrap_or_default();
    let target_present = match result.snapshot.as_ref() {
        Some(snapshot) => find_stash_entry(snapshot, &target_id).is_some(),
        None => true,
    };

    let uncertainty = if command_evidence_missing {
        Some((
            "Drop 没有留下明确的 Git 命令成功证据；不会把外部删除冒认为本次结果。",
            "目标 Stash 当前已经不存在，但本次 Drop 的命令身份无法确认；结果需要确认。",
        ))
    } else if result.worktree_changed {
        Some((
            "Drop 本身不应修改工作区，但执行期间检测到工作区变化；请确认是否存在外部操作。",
            "目标 Stash 已不在当前列表中，但工作区同时发生变化；删除结果需要确认。",
        ))
    } else if !result.dropped || result.stash_retained || target_present {
        Some((
            "Drop 的最终条目身份与返回结果不一致。",
            "删除命令已经返回，但当前权威快照尚未确认目标 Stash 精确消失。",
        ))
    } else {
        None
    };

    if let Some((warning, message)) = uncertainty {
        downgrade_drop_result(&mut result, warning, message);
        if let Err(error) = persist_drop_uncertainty(
            repo_root,
            &result.request_id,
            &result,
            warning,
            message,
        )
        .await
        {
            result.errors.push(format!(
                "无法持久化 Drop 的结果不确定状态：{}",
                error
            ));
        }
    }

    Ok(finalize_validated_completion_result(repo_root, result).await)
}

pub mod authoritative_drop {
    use super::{
        acquire_repo_git_guard, acquire_stash_operation_authority,
        ensure_repo_path, ensure_stash_evidence_readable_for_request,
        ensure_stash_operation_policy, ensure_stash_request_family,
        normalize_request_id, normalize_stash_id, project_operation_result_snapshot,
        reconcile_matching_stash_request, resolve_repo_root, stash_operation_path,
        validate_drop_complete_result_under_guard, AppState, StashJournalFamily,
        StashOperationResult, StashOperationSignature, TargetStashRequest,
    };
    use tauri::State;

    #[tauri::command]
    pub async fn drop_repo_stash(
        repo_path: String,
        request: TargetStashRequest,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        ensure_repo_path(&repo_path)?;
        let request_id = normalize_request_id(&request.request_id)?;
        let target_id = normalize_stash_id(&request.stash_id)?;
        let repo_root = resolve_repo_root(&repo_path).await?;
        let signature = StashOperationSignature {
            operation: "drop".to_string(),
            expected_snapshot_id: request.expected_snapshot_id.clone(),
            target_stash_id: Some(target_id.clone()),
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
                let result = validate_drop_complete_result_under_guard(&repo_root, result).await?;
                return project_operation_result_snapshot(&repo_root, result).await;
            }
        }

        ensure_stash_operation_policy(
            &repo_root,
            &request_id,
            "drop",
            Some(target_id.as_str()),
        )
        .await?;

        let result = super::drop_repo_stash_internal(repo_path, request, state.clone()).await?;
        let _guard = acquire_repo_git_guard(&state, &repo_root).await?;
        let result = validate_drop_complete_result_under_guard(&repo_root, result).await?;
        project_operation_result_snapshot(&repo_root, result).await
    }
}
