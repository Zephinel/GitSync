#[tauri::command]
pub async fn reconcile_repo_branch_creation(
    path: String,
    request_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BranchCreationOperationResult, String> {
    ensure_repo_path(&path)?;
    let request_id = validate_request_id(&request_id)?;
    // Reconciliation may persist its journal, so it is an application mutation
    // even when it deliberately performs no new Git repository mutation.
    let _guard = acquire_repo_git_guard(&state, &path).await?;
    let journal_file = journal_path(&path, &request_id).await?;
    let mut journal = load_journal(&journal_file)?
        .ok_or_else(|| "找不到可确认的分支创建记录。".to_string())?;
    emit_operation_progress(
        Some(&app),
        &request_id,
        "validating",
        "reconciling-result",
        "正在刷新并确认原操作的真实结果，不会执行新的仓库修改…",
    );
    if let Err(error) =
        reconcile_journal_and_persist_without_repo_mutation(&path, &journal_file, &mut journal).await
    {
        journal.errors.push(format!("无法完整更新结果记录: {}", error));
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

async fn finish_resume_and_persist(
    path: &str,
    journal_file: &Path,
    journal: &mut BranchCreationJournal,
    app: &AppHandle,
) -> BranchCreationOperationResult {
    let _ = persist_journal(journal_file, journal);
    let result = build_result(path, journal).await;
    emit_operation_progress(
        Some(app),
        &journal.request_id,
        result.status.as_str(),
        "completed",
        result.message.as_str(),
    );
    result
}

#[tauri::command]
pub async fn resume_repo_branch_creation(
    path: String,
    request_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BranchCreationOperationResult, String> {
    ensure_repo_path(&path)?;
    let request_id = validate_request_id(&request_id)?;
    let _guard = acquire_repo_git_guard(&state, &path).await?;
    let journal_file = journal_path(&path, &request_id).await?;
    let mut journal = load_journal(&journal_file)?
        .ok_or_else(|| "找不到可重试的分支创建记录。".to_string())?;
    emit_operation_progress(
        Some(&app),
        &request_id,
        "validating",
        "reconciling-retry",
        "正在确认仓库仍与原操作一致，只会处理可证明未开始或尚未完成的部分…",
    );

    let local_was_pending = matches!(journal.local_state.as_str(), "pending" | "absent");
    match reconcile_local_creation(
        &path,
        &journal.signature,
        journal.request_id.as_str(),
    )
    .await
    {
        Ok(state) if state == "created" => {
            journal.local_state = "created".to_string();
            clear_step_error(&mut journal, "local");
        }
        Ok(state) if state == "absent" && local_was_pending => {
            let source_actual = resolve_ref(&path, &journal.signature.source_ref).await?;
            if source_actual.as_deref() != Some(journal.signature.source_commit.as_str()) {
                journal.local_state = "unknown".to_string();
                set_step_error(
                    &mut journal,
                    "local",
                    "创建来源已经变化；不会按旧提交继续创建分支。",
                );
                return Ok(
                    finish_resume_and_persist(&path, &journal_file, &mut journal, &app)
                        .await,
                );
            }
            journal.local_state = "pending".to_string();
            clear_step_error(&mut journal, "local");
        }
        Ok(_) => {
            journal.local_state = "unknown".to_string();
            set_step_error(
                &mut journal,
                "local",
                "本地分支当前状态与原操作记录不一致；不会覆盖外部变化或重复创建。",
            );
            return Ok(
                finish_resume_and_persist(&path, &journal_file, &mut journal, &app).await,
            );
        }
        Err(error) => {
            journal.local_state = "unknown".to_string();
            set_step_error(
                &mut journal,
                "local",
                format!("无法确认本地分支当前状态: {}", error),
            );
            return Ok(
                finish_resume_and_persist(&path, &journal_file, &mut journal, &app).await,
            );
        }
    }

    if journal.signature.publish {
        let remote = journal
            .signature
            .target_remote
            .clone()
            .ok_or_else(|| "原操作缺少目标远端。".to_string())?;
        let remote_state = journal.remote_state.clone();
        match remote_state.as_str() {
            "created" => match ls_remote_branch(
                &path,
                remote.as_str(),
                &journal.signature.branch_name,
            )
            .await
            {
                Ok(Some(hash)) if hash == journal.signature.source_commit => {
                    clear_step_error(&mut journal, "publish");
                }
                Ok(_) => {
                    journal.remote_state = "unknown".to_string();
                    set_step_error(
                        &mut journal,
                        "publish",
                        "远端分支已经发生变化；不会覆盖外部提交或重新发布。",
                    );
                }
                Err(error) => {
                    journal.remote_state = "unknown".to_string();
                    set_step_error(
                        &mut journal,
                        "publish",
                        format!("无法确认远端分支当前状态: {}", error),
                    );
                }
            },
            "pending" | "failed" => match ls_remote_branch(
                &path,
                remote.as_str(),
                &journal.signature.branch_name,
            )
            .await
            {
                Ok(None) => {}
                Ok(Some(_)) => {
                    journal.remote_state = "unknown".to_string();
                    set_step_error(
                        &mut journal,
                        "publish",
                        "远端当前存在同名分支，但无法证明它由原请求创建；不会覆盖、接管或重复发布。",
                    );
                }
                Err(error) => {
                    journal.remote_state = "unknown".to_string();
                    set_step_error(
                        &mut journal,
                        "publish",
                        format!("无法确认远端同名分支状态，不能安全重试发布: {}", error),
                    );
                }
            },
            "unknown" => {
                match ls_remote_branch(
                    &path,
                    remote.as_str(),
                    &journal.signature.branch_name,
                )
                .await
                {
                    Ok(None) => journal.warnings.push(
                        "远端当前没有同名分支，但仍无法证明原发布从未成功后又被外部删除；不会自动重新发布。"
                            .to_string(),
                    ),
                    Ok(Some(_)) => journal.warnings.push(
                        "远端当前存在同名分支，但无法证明它由原请求创建；不会覆盖、接管或重复发布。"
                            .to_string(),
                    ),
                    Err(error) => set_step_error(
                        &mut journal,
                        "publish",
                        format!("无法确认远端分支当前状态: {}", error),
                    ),
                }
            }
            _ => {}
        }
        if journal.remote_state == "unknown" {
            return Ok(
                finish_resume_and_persist(&path, &journal_file, &mut journal, &app).await,
            );
        }
    }

    let allow_switch_attempt = local_was_pending && journal.switch_state == "pending";
    if let Err(error) = execute_pending_steps(
        &path,
        &journal_file,
        &mut journal,
        allow_switch_attempt,
        Some(&app),
    )
    .await
    {
        journal.errors.push(format!(
            "重试已停止；无法完成或持久化后续步骤: {}",
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
