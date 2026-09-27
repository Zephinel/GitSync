async fn persist_create_uncertainty(
    repo_root: &str,
    request_id: &str,
    warning: &str,
    message: &str,
) -> Result<(), String> {
    let journal_path = stash_operation_path(repo_root, request_id).await?;
    let Some(mut journal) = load_stash_journal(&journal_path)? else {
        return Err("找不到需要更新的 Stash Create 操作记录。".to_string());
    };
    let mut stored = journal.result.clone().unwrap_or_else(|| {
        stored_result("create", request_id, "needs_confirmation", None, message)
    });
    stored.status = "needs_confirmation".to_string();
    stored.needs_confirmation = true;
    if !stored.warnings.iter().any(|value| value == warning) {
        stored.warnings.push(warning.to_string());
    }
    stored.message = message.to_string();
    journal.phase = "settled".to_string();
    journal.completion_validated = false;
    journal.result = Some(stored);
    persist_stash_journal(&journal_path, &mut journal)
}

fn downgrade_create_result(
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

async fn validate_create_complete_result_under_guard(
    repo_root: &str,
    mut result: StashOperationResult,
) -> Result<StashOperationResult, String> {
    if result.status != "complete" {
        return Ok(result);
    }

    let journal_path = stash_operation_path(repo_root, &result.request_id).await?;
    let Some(journal) = load_stash_journal(&journal_path)? else {
        downgrade_create_result(
            &mut result,
            "创建结果缺少持久化操作证据。",
            "新 Stash 可能已经创建，但无法读取本次操作证据；结果需要确认。",
        );
        return Ok(result);
    };

    if journal.completion_validated {
        return Ok(result);
    }

    if journal.command_success != Some(true) {
        let warning = "Git 命令没有留下明确成功证据；不会把并发产生的新 Stash 冒认为本次结果。";
        let message = "检测到新 Stash，但本次命令成功身份无法确认；结果需要确认。";
        downgrade_create_result(&mut result, warning, message);
        if let Err(error) = persist_create_uncertainty(
            repo_root,
            &result.request_id,
            warning,
            message,
        )
        .await
        {
            result
                .errors
                .push(format!("无法持久化 Create 的证据不确定状态：{}", error));
        }
        return Ok(result);
    }

    let Some(created_id) = result.created_stash_id.clone() else {
        let warning = "创建完成结果没有稳定 Stash OID。";
        let message = "Git 命令返回成功，但没有可绑定到本次请求的稳定条目标识；结果需要确认。";
        downgrade_create_result(&mut result, warning, message);
        let _ = persist_create_uncertainty(
            repo_root,
            &result.request_id,
            warning,
            message,
        )
        .await;
        return Ok(result);
    };

    let Some(snapshot) = result.snapshot.as_ref() else {
        let warning = "创建完成后缺少权威 Stash 快照。";
        let message = "新 Stash 可能已经创建，但完整列表尚未确认；结果需要确认。";
        downgrade_create_result(&mut result, warning, message);
        let _ = persist_create_uncertainty(
            repo_root,
            &result.request_id,
            warning,
            message,
        )
        .await;
        return Ok(result);
    };

    let mut expected = journal
        .before_stash_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    expected.insert(created_id.clone());
    let actual = stash_ids(snapshot);
    let created_visible = actual.contains(&created_id);

    if !created_visible || actual != expected {
        let warning = if created_visible {
            "新 Stash 已确认创建，但列表同时发生其他变化；不会把外部新增或删除归因于本次请求。"
        } else {
            "返回的稳定 Stash OID 不在最新权威列表中。"
        };
        let message = if created_visible {
            "本次新 Stash 已确认，但完整列表还发生其他变化；结果需要确认。"
        } else {
            "Git 命令返回成功，但最新列表尚未确认本次稳定条目；结果需要确认。"
        };
        downgrade_create_result(&mut result, warning, message);
        if let Err(error) = persist_create_uncertainty(
            repo_root,
            &result.request_id,
            warning,
            message,
        )
        .await
        {
            result
                .errors
                .push(format!("无法持久化 Create 的列表不确定状态：{}", error));
        }
    }

    Ok(finalize_validated_completion_result(repo_root, result).await)
}

pub mod authoritative_create {
    use super::{
        acquire_repo_git_guard, acquire_stash_operation_authority,
        ensure_no_other_unresolved_stash_operation, ensure_repo_path,
        ensure_stash_evidence_readable_for_request, ensure_stash_request_family,
        normalize_request_id, normalize_stash_message,
        project_operation_result_snapshot, reconcile_matching_stash_request,
        resolve_repo_root, stash_operation_path,
        validate_create_complete_result_under_guard, AppState,
        CreateStashRequest, StashJournalFamily, StashOperationResult,
        StashOperationSignature,
    };
    use tauri::State;

    #[tauri::command]
    pub async fn create_repo_stash(
        repo_path: String,
        request: CreateStashRequest,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        ensure_repo_path(&repo_path)?;
        let request_id = normalize_request_id(&request.request_id)?;
        let message = normalize_stash_message(&request.message)?;
        let repo_root = resolve_repo_root(&repo_path).await?;
        let signature = StashOperationSignature {
            operation: "create".to_string(),
            expected_snapshot_id: request.expected_snapshot_id.clone(),
            target_stash_id: None,
            message,
            include_untracked: request.include_untracked,
            keep_index: request.keep_index,
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
                let result = validate_create_complete_result_under_guard(&repo_root, result).await?;
                return project_operation_result_snapshot(&repo_root, result).await;
            }
        }

        ensure_no_other_unresolved_stash_operation(&repo_root, &request_id).await?;
        let result = super::create_repo_stash(repo_path, request, state.clone()).await?;
        let _guard = acquire_repo_git_guard(&state, &repo_root).await?;
        let result = validate_create_complete_result_under_guard(&repo_root, result).await?;
        project_operation_result_snapshot(&repo_root, result).await
    }
}
