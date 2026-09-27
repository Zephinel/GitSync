#[tauri::command]
pub async fn inspect_repo_branch_creation(
    path: String,
    source: BranchCreationSourceRequest,
    state: State<'_, AppState>,
) -> Result<BranchCreationInspection, String> {
    inspect_repo_branch_creation_in_state(&path, &source, &state).await
}

async fn acquire_remote_refresh_guard(
    state: &AppState,
    path: &str,
) -> Result<crate::repo_git_lock::RepoGitGuard, String> {
    // Remote refresh executes git fetch and therefore takes the restart-blocking
    // operation lease before waiting for the per-repository lock.
    crate::repo_git_lock::acquire(state, path).await
}

async fn inspect_repo_branch_creation_in_state(
    path: &str,
    source: &BranchCreationSourceRequest,
    state: &AppState,
) -> Result<BranchCreationInspection, String> {
    ensure_repo_path(path)?;
    let _guard = acquire_remote_refresh_guard(state, path).await?;
    inspect_with_remote_refresh_locked(path, source).await
}

#[tauri::command]
pub async fn validate_repo_branch_creation_name(
    path: String,
    request: BranchNameValidationRequest,
    state: State<'_, AppState>,
) -> Result<BranchNameValidationResult, String> {
    ensure_repo_path(&path)?;
    let _guard = crate::repo_git_lock::acquire_read(&state, &path).await?;
    validate_name_locked(&path, &request).await
}

#[tauri::command]
pub async fn execute_repo_branch_creation(
    path: String,
    request: BranchCreationExecuteRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BranchCreationOperationResult, String> {
    ensure_repo_path(&path)?;
    let request_id = validate_request_id(&request.request_id)?;
    let _guard = acquire_repo_git_guard(&state, &path).await?;
    let journal_file = journal_path(&path, &request_id).await?;
    let requested_signature = signature_from_request(&request);

    if let Some(mut journal) = load_journal(&journal_file)? {
        if journal.request_id != request_id || journal.signature != requested_signature {
            return Err(
                "相同请求 ID 已用于不同的分支创建操作；为避免误认结果，已拒绝执行。"
                    .to_string(),
            );
        }
        emit_operation_progress(
            Some(&app),
            &request_id,
            "validating",
            "reconciling-existing-request",
            "正在确认重复请求的真实结果，不会重复执行已完成步骤…",
        );
        if let Err(error) =
            reconcile_journal_and_persist_without_repo_mutation(&path, &journal_file, &mut journal).await
        {
            journal.errors.push(format!(
                "重复请求只执行了状态确认，但结果记录更新失败: {}",
                error
            ));
        }
        let result = build_result(&path, &journal).await;
        emit_operation_progress(
            Some(&app),
            &request_id,
            result.status.as_str(),
            "completed",
            result.message.as_str(),
        );
        return Ok(result);
    }

    emit_operation_progress(
        Some(&app),
        &request_id,
        "validating",
        "confirming-source",
        "正在重新确认来源分支、远端状态和工作区…",
    );
    let inspection = inspect_with_remote_refresh_locked(&path, &request.source).await?;
    if inspection.fingerprint != request.inspection_fingerprint {
        return Err(
            "来源分支、远端状态或工作区已经变化；旧预览已过期，请重新确认后再创建。"
                .to_string(),
        );
    }
    let selected = inspection
        .source_options
        .iter()
        .find(|option| option.id == request.source_option_id)
        .ok_or_else(|| "所选创建起点已经不可用，请重新确认来源。".to_string())?;
    if selected.full_ref != request.source_ref || selected.commit != request.source_commit {
        return Err("创建起点或提交已变化，请重新确认来源。".to_string());
    }

    emit_operation_progress(
        Some(&app),
        &request_id,
        "validating",
        "validating-name",
        "正在重新验证分支名称与目标远端…",
    );
    let validation = validate_name_locked(
        &path,
        &BranchNameValidationRequest {
            name: request.branch_name.clone(),
            publish: request.publish,
            remote: request.target_remote.clone(),
        },
    )
    .await?;
    if !validation.valid {
        return Err(validation.errors.join("；"));
    }

    let mut journal = new_journal(
        request_id.clone(),
        requested_signature,
        inspection.worktree_dirty,
    );
    // No repository mutation is allowed before the operation identity is durable.
    persist_journal(&journal_file, &mut journal)?;
    if let Err(error) =
        execute_pending_steps(&path, &journal_file, &mut journal, true, Some(&app)).await
    {
        journal.errors.push(format!(
            "操作已停止；无法完成或持久化后续步骤: {}",
            error
        ));
        let _ = persist_journal(&journal_file, &mut journal);
    }
    let result = build_result(&path, &journal).await;
    emit_operation_progress(
        Some(&app),
        &request_id,
        result.status.as_str(),
        "completed",
        result.message.as_str(),
    );
    Ok(result)
}
