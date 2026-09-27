async fn persist_selected_create_uncertainty(
    repo_root: &str,
    request_id: &str,
    warning: &str,
    message: &str,
) -> Result<(), String> {
    let journal_path = selected_stash_operation_path(repo_root, request_id).await?;
    let Some(mut journal) = load_selected_stash_journal_authoritative(&journal_path)? else {
        return Err("找不到需要更新的文件级 Stash 操作记录。".to_string());
    };
    let mut stored = journal.result.clone().unwrap_or_else(|| {
        stored_result(
            "create_selected",
            request_id,
            "needs_confirmation",
            None,
            message,
        )
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
    persist_selected_stash_journal(&journal_path, &mut journal)
}

fn downgrade_selected_create_result(
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

async fn validate_selected_create_complete_result_under_guard(
    repo_root: &str,
    mut result: StashOperationResult,
) -> Result<StashOperationResult, String> {
    if result.status != "complete" {
        return Ok(result);
    }

    let journal_path = selected_stash_operation_path(repo_root, &result.request_id).await?;
    let journal = load_selected_stash_journal_authoritative(&journal_path)?;
    if let Some(value) = journal.as_ref() {
        ensure_stash_journal_origin(&value.origin_repo_root, repo_root, false)?;
        if value.completion_validated {
            return Ok(result);
        }
    }

    let scope_verified = match journal.as_ref() {
        Some(value) if value.command_success == Some(true) => {
            selected_scope_verified_for_journal(repo_root, value).await?
        }
        _ => false,
    };

    let uncertainty = if journal
        .as_ref()
        .map(|value| value.command_success != Some(true))
        .unwrap_or(true)
    {
        Some((
            "文件级 Stash 没有留下明确的 Git 命令成功证据；不会把外部新增条目冒认为本次结果。",
            "检测到文件级 Stash 变化，但本次命令身份无法确认；结果需要确认。",
        ))
    } else if !scope_verified {
        Some((
            "文件级 Stash 的 selected/unselected scope authority 未能重新验证。",
            "检测到新 Stash，但未选范围 digest 或 selected residual 与本次请求不完全一致；结果需要确认。",
        ))
    } else if result.created_stash_id.is_none() {
        Some((
            "文件级 Stash 完成结果缺少稳定 OID。",
            "Git 命令已返回，但没有可绑定到本次请求的稳定 Stash 身份；结果需要确认。",
        ))
    } else if result.snapshot.is_none() {
        Some((
            "文件级 Stash 完成后缺少权威列表快照。",
            "新 Stash 可能已经创建，但完整列表尚未确认；结果需要确认。",
        ))
    } else {
        let journal = journal.as_ref().expect("journal checked above");
        let created_id = result.created_stash_id.as_ref().expect("created id checked above");
        let snapshot = result.snapshot.as_ref().expect("snapshot checked above");
        let mut expected = journal
            .before_stash_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        expected.insert(created_id.clone());
        let actual = stash_ids(snapshot);
        if !actual.contains(created_id) || actual != expected {
            Some((
                "文件级 Stash 的稳定 OID 或完整列表身份与本次请求不完全一致。",
                "本次文件级 Stash 不能与并发列表变化安全区分；结果需要确认。",
            ))
        } else {
            None
        }
    };

    if let Some((warning, message)) = uncertainty {
        downgrade_selected_create_result(&mut result, warning, message);
        if let Err(error) = persist_selected_create_uncertainty(
            repo_root,
            &result.request_id,
            warning,
            message,
        )
        .await
        {
            result.errors.push(format!(
                "无法持久化文件级 Create 的结果不确定状态：{}",
                error
            ));
        }
    }

    Ok(finalize_validated_completion_result(repo_root, result).await)
}

async fn validate_selected_create_completion(
    repo_root: &str,
    state: &State<'_, AppState>,
    result: StashOperationResult,
) -> Result<StashOperationResult, String> {
    let _guard = acquire_repo_git_guard(state, repo_root).await?;
    validate_selected_create_complete_result_under_guard(repo_root, result).await
}

pub mod authoritative_selected_create {
    use super::{
        acquire_repo_git_guard, acquire_stash_operation_authority,
        ensure_no_other_unresolved_stash_operation, ensure_repo_path,
        ensure_selected_scope_request_budget, ensure_stash_evidence_readable_for_request,
        ensure_stash_journal_origin, ensure_stash_request_family, is_final_stash_result,
        load_selected_stash_journal_authoritative, normalize_request_id,
        normalize_stash_message, normalize_stash_scope_targets,
        operation_result, project_operation_result_snapshot, read_stash_snapshot,
        read_stash_snapshot_core, read_stash_worktree_files_for_targets,
        reconcile_selected_stash_journal, resolve_repo_root, resolve_selected_scope,
        selected_interrupted_without_recorded_identity, selected_request_matches,
        selected_stash_operation_path, settle_selected_stash_journal,
        validate_selected_create_completion, validate_selected_scope_git_identity,
        AppState, CreateSelectedStashRequest, StashJournalFamily,
        StashOperationResult,
    };
    use tauri::State;

    #[tauri::command]
    pub async fn create_repo_stash_selected_authoritative(
        repo_path: String,
        mut request: CreateSelectedStashRequest,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        ensure_repo_path(&repo_path)?;

        let request_id = normalize_request_id(&request.request_id)?;
        let message = normalize_stash_message(&request.message)?;
        let targets = normalize_stash_scope_targets(&request.files)?;
        let repo_root = resolve_repo_root(&repo_path).await?;
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        ensure_stash_request_family(
            &repo_root,
            &request_id,
            StashJournalFamily::Selected,
        )
        .await?;
        ensure_stash_evidence_readable_for_request(&repo_root, &request_id).await?;

        request.include_untracked = true;
        let journal_path = selected_stash_operation_path(&repo_root, &request_id).await?;

        let existing_result = {
            let _guard = acquire_repo_git_guard(&state, &repo_root).await?;
            if let Some(mut journal) = load_selected_stash_journal_authoritative(&journal_path)? {
                ensure_stash_journal_origin(&journal.origin_repo_root, &repo_root, false)?;
                if !selected_request_matches(
                    &journal,
                    &request.expected_snapshot_id,
                    &message,
                    request.include_untracked,
                    request.keep_index,
                    &targets,
                ) {
                    return Err(
                        "相同文件级 Stash 请求 ID 已用于不同范围；已拒绝重复执行。"
                            .to_string(),
                    );
                }

                if let Some(result) = journal.result.clone().filter(is_final_stash_result) {
                    Some(match read_stash_snapshot(&repo_root).await {
                        Ok(snapshot) => operation_result(result, Some(snapshot), None),
                        Err(error) => operation_result(result, None, Some(error)),
                    })
                } else {
                    let recorded_created_id = journal
                        .result
                        .as_ref()
                        .and_then(|result| result.created_stash_id.as_ref())
                        .is_some();
                    if !recorded_created_id && journal.command_success != Some(true) {
                        let current = read_stash_snapshot_core(&repo_root).await?;
                        if let Some(result) =
                            selected_interrupted_without_recorded_identity(&journal, &current)
                        {
                            Some(
                                settle_selected_stash_journal(
                                    &repo_root,
                                    &journal_path,
                                    &mut journal,
                                    result,
                                )
                                .await?,
                            )
                        } else {
                            Some(
                                reconcile_selected_stash_journal(
                                    &repo_root,
                                    &journal_path,
                                    &mut journal,
                                )
                                .await?,
                            )
                        }
                    } else {
                        Some(
                            reconcile_selected_stash_journal(
                                &repo_root,
                                &journal_path,
                                &mut journal,
                            )
                            .await?,
                        )
                    }
                }
            } else {
                None
            }
        };

        if let Some(result) = existing_result {
            let result = validate_selected_create_completion(&repo_root, &state, result).await?;
            return project_operation_result_snapshot(&repo_root, result).await;
        }

        ensure_selected_scope_request_budget(&targets)?;
        ensure_no_other_unresolved_stash_operation(&repo_root, &request_id).await?;

        let files = read_stash_worktree_files_for_targets(&repo_root, &targets).await?;
        let selected = resolve_selected_scope(&files, &targets, true, request.keep_index)?;
        validate_selected_scope_git_identity(&repo_root, &selected).await?;

        let result = super::create_repo_stash_selected(repo_path, request, state.clone()).await?;
        let result = validate_selected_create_completion(&repo_root, &state, result).await?;
        project_operation_result_snapshot(&repo_root, result).await
    }
}
