fn is_final_stash_result(result: &StoredStashOperationResult) -> bool {
    matches!(
        result.status.as_str(),
        "complete" | "failed" | "stale" | "acknowledged"
    ) && !result.needs_confirmation
}

async fn reconcile_matching_stash_request(
    repo_root: &str,
    journal_path: &Path,
    signature: &StashOperationSignature,
) -> Result<Option<StashOperationResult>, String> {
    let Some(mut journal) = load_stash_journal(journal_path)? else {
        return Ok(None);
    };
    ensure_stash_journal_origin(&journal.origin_repo_root, repo_root, false)?;
    if journal.signature != *signature {
        return Err(
            "相同 Stash 请求 ID 已用于不同操作；为避免误认或重复修改，已拒绝执行。"
                .to_string(),
        );
    }
    reconcile_unresolved_stash_journal(repo_root, journal_path, &mut journal)
        .await
        .map(Some)
}

async fn validate_reconciled_result_under_guard(
    repo_root: &str,
    result: StashOperationResult,
) -> Result<StashOperationResult, String> {
    match result.operation.as_str() {
        "create" => validate_create_complete_result_under_guard(repo_root, result).await,
        "create_selected" => {
            validate_selected_create_complete_result_under_guard(repo_root, result).await
        }
        "apply" | "pop" => {
            validate_restore_complete_result_under_guard(repo_root, result).await
        }
        "drop" => validate_drop_complete_result_under_guard(repo_root, result).await,
        _ => Ok(result),
    }
}

fn interrupted_without_recorded_identity(
    operation: &str,
    request_id: &str,
    phase: &str,
    command_success: Option<bool>,
    before_snapshot_id: &str,
    before_worktree_id: &str,
    current: &RepoStashSnapshot,
) -> Option<StoredStashOperationResult> {
    if !matches!(operation, "create" | "create_selected") {
        return None;
    }

    if phase == "prepared" && current.snapshot_id == before_snapshot_id {
        let mut result = stored_result(
            operation,
            request_id,
            "failed",
            None,
            "Stash 创建操作只完成了持久化准备，仓库状态没有变化；本次创建未开始。",
        );
        result.needs_confirmation = false;
        return Some(result);
    }

    if command_success == Some(false)
        && current.snapshot_id == before_snapshot_id
        && current.worktree_id == before_worktree_id
    {
        let mut result = stored_result(
            operation,
            request_id,
            "failed",
            None,
            "Stash 创建命令已明确失败，仓库状态没有变化。",
        );
        result.needs_confirmation = false;
        return Some(result);
    }

    let mut result = stored_result(
        operation,
        request_id,
        "needs_confirmation",
        None,
        "创建操作被中断，而且没有持久化可归属于本次请求的稳定 Stash OID。为避免把外部创建的条目冒认为成功，不会自动认领任何新 Stash。",
    );
    result.needs_confirmation = true;
    result.worktree_changed = current.worktree_id != before_worktree_id;
    result.mutated = result.worktree_changed || current.snapshot_id != before_snapshot_id;
    Some(result)
}

async fn reconcile_unresolved_stash_journal(
    repo_root: &str,
    journal_path: &Path,
    journal: &mut StashOperationJournal,
) -> Result<StashOperationResult, String> {
    ensure_stash_journal_origin(&journal.origin_repo_root, repo_root, false)?;
    if let Some(result) = journal.result.clone().filter(is_final_stash_result) {
        return match read_stash_snapshot(repo_root).await {
            Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
            Err(error) => Ok(operation_result(result, None, Some(error))),
        };
    }

    let current = match read_stash_snapshot_core(repo_root).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let mut result = journal.result.clone().unwrap_or_else(|| {
                stored_result(
                    &journal.signature.operation,
                    &journal.request_id,
                    "needs_confirmation",
                    journal.signature.target_stash_id.clone(),
                    "原 Stash 操作需要确认，但当前仓库状态读取失败。",
                )
            });
            result.status = "needs_confirmation".to_string();
            result.needs_confirmation = true;
            result.errors.push(error);
            return settle_stash_journal(repo_root, journal_path, journal, result).await;
        }
    };

    let result = if journal
        .result
        .as_ref()
        .and_then(|value| value.created_stash_id.as_ref())
        .is_none()
    {
        interrupted_without_recorded_identity(
            &journal.signature.operation,
            &journal.request_id,
            &journal.phase,
            journal.command_success,
            &journal.before_snapshot_id,
            &journal.before_worktree_id,
            &current,
        )
        .unwrap_or_else(|| derive_interrupted_result(journal, &current))
    } else {
        derive_interrupted_result(journal, &current)
    };
    settle_stash_journal(repo_root, journal_path, journal, result).await
}

fn selected_interrupted_without_recorded_identity(
    journal: &SelectedStashOperationJournal,
    current: &RepoStashSnapshot,
) -> Option<StoredStashOperationResult> {
    if journal
        .result
        .as_ref()
        .and_then(|value| value.created_stash_id.as_ref())
        .is_some()
    {
        return None;
    }
    interrupted_without_recorded_identity(
        "create_selected",
        &journal.request_id,
        &journal.phase,
        journal.command_success,
        &journal.before_snapshot_id,
        &journal.before_worktree_id,
        current,
    )
}

pub mod authoritative_reconcile {
    use super::{
        acquire_repo_git_guard, acquire_stash_operation_authority,
        ensure_repo_path, ensure_stash_evidence_readable_for_request,
        ensure_stash_journal_origin, find_stash_entry, is_final_stash_result,
        load_selected_stash_journal_authoritative, load_stash_journal,
        normalize_request_id, normalize_stash_id, operation_result,
        precondition_result, project_operation_result_snapshot, read_stash_snapshot,
        read_stash_snapshot_core, reconcile_selected_stash_journal,
        reconcile_unresolved_stash_journal, resolve_repo_root,
        selected_interrupted_without_recorded_identity, selected_stash_operation_path,
        settle_selected_stash_journal, stash_operation_path,
        stash_request_journal_family, validate_reconciled_result_under_guard,
        AppState, StashJournalFamily, StashOperationResult,
    };
    use tauri::State;

    fn normalize_expected_operation(value: Option<String>) -> Result<Option<String>, String> {
        let operation = value.unwrap_or_default().trim().to_string();
        if operation.is_empty() {
            return Ok(None);
        }
        if matches!(
            operation.as_str(),
            "create" | "create_selected" | "apply" | "pop" | "drop"
        ) {
            Ok(Some(operation))
        } else {
            Err("Stash 对账的预期操作类型无效。".to_string())
        }
    }

    fn normalize_expected_target(
        operation: Option<&str>,
        value: Option<String>,
    ) -> Result<Option<String>, String> {
        let target = value.unwrap_or_default().trim().to_string();
        if target.is_empty() {
            return Ok(None);
        }
        if !matches!(operation, Some("apply" | "pop" | "drop")) {
            return Err("只有目标型 Stash 操作可以携带预期条目标识。".to_string());
        }
        normalize_stash_id(&target).map(Some)
    }

    fn normalize_expected_snapshot_id(value: Option<String>) -> Option<String> {
        let snapshot_id = value.unwrap_or_default().trim().to_string();
        (!snapshot_id.is_empty()).then_some(snapshot_id)
    }

    fn ensure_expected_reconcile_identity(
        expected_operation: Option<&str>,
        expected_target_stash_id: Option<&str>,
        actual_operation: &str,
        actual_target_stash_id: Option<&str>,
    ) -> Result<(), String> {
        let Some(expected_operation) = expected_operation else {
            return Ok(());
        };
        if expected_operation == actual_operation
            && expected_target_stash_id == actual_target_stash_id
        {
            return Ok(());
        }
        Err(
            "Stash 对账请求与已持久化操作身份不一致；不会把其他请求的证据冒认为本次结果。"
                .to_string(),
        )
    }

    #[tauri::command]
    pub async fn reconcile_repo_stash_operation(
        repo_path: String,
        request_id: String,
        expected_operation: Option<String>,
        expected_target_stash_id: Option<String>,
        expected_snapshot_id: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<StashOperationResult, String> {
        ensure_repo_path(&repo_path)?;
        let request_id = normalize_request_id(&request_id)?;
        let expected_operation = normalize_expected_operation(expected_operation)?;
        let expected_target_stash_id = normalize_expected_target(
            expected_operation.as_deref(),
            expected_target_stash_id,
        )?;
        let expected_snapshot_id = normalize_expected_snapshot_id(expected_snapshot_id);
        let repo_root = resolve_repo_root(&repo_path).await?;
        let _authority = acquire_stash_operation_authority(&repo_root).await?;
        let family = stash_request_journal_family(&repo_root, &request_id).await?;
        ensure_stash_evidence_readable_for_request(&repo_root, &request_id).await?;
        let _guard = acquire_repo_git_guard(&state, &repo_root).await?;

        match family {
            Some(StashJournalFamily::Regular) => {
                let journal_path = stash_operation_path(&repo_root, &request_id).await?;
                let mut journal = load_stash_journal(&journal_path)?
                    .ok_or_else(|| "找不到可确认的 Stash 操作记录。".to_string())?;
                ensure_expected_reconcile_identity(
                    expected_operation.as_deref(),
                    expected_target_stash_id.as_deref(),
                    &journal.signature.operation,
                    journal.signature.target_stash_id.as_deref(),
                )?;
                let result = reconcile_unresolved_stash_journal(
                    &repo_root,
                    &journal_path,
                    &mut journal,
                )
                .await?;
                let result = validate_reconciled_result_under_guard(&repo_root, result).await?;
                project_operation_result_snapshot(&repo_root, result).await
            }
            Some(StashJournalFamily::Selected) => {
                let selected_path = selected_stash_operation_path(&repo_root, &request_id).await?;
                let mut journal = load_selected_stash_journal_authoritative(&selected_path)?
                    .ok_or_else(|| "找不到可确认的文件级 Stash 操作记录。".to_string())?;
                ensure_stash_journal_origin(&journal.origin_repo_root, &repo_root, false)?;
                ensure_expected_reconcile_identity(
                    expected_operation.as_deref(),
                    expected_target_stash_id.as_deref(),
                    "create_selected",
                    None,
                )?;
                let result = if let Some(result) = journal.result.clone().filter(is_final_stash_result) {
                    match read_stash_snapshot(&repo_root).await {
                        Ok(snapshot) => operation_result(result, Some(snapshot), None),
                        Err(error) => operation_result(result, None, Some(error)),
                    }
                } else if let Ok(current) = read_stash_snapshot_core(&repo_root).await {
                    if let Some(result) =
                        selected_interrupted_without_recorded_identity(&journal, &current)
                    {
                        settle_selected_stash_journal(
                            &repo_root,
                            &selected_path,
                            &mut journal,
                            result,
                        )
                        .await?
                    } else {
                        reconcile_selected_stash_journal(
                            &repo_root,
                            &selected_path,
                            &mut journal,
                        )
                        .await?
                    }
                } else {
                    reconcile_selected_stash_journal(
                        &repo_root,
                        &selected_path,
                        &mut journal,
                    )
                    .await?
                };
                let result = validate_reconciled_result_under_guard(&repo_root, result).await?;
                project_operation_result_snapshot(&repo_root, result).await
            }
            None => {
                let Some(operation) = expected_operation.as_deref() else {
                    return Err("找不到可确认的 Stash 操作记录。".to_string());
                };
                let current = read_stash_snapshot_core(&repo_root).await?;
                let target_present = expected_target_stash_id
                    .as_deref()
                    .is_some_and(|target| find_stash_entry(&current, target).is_some());
                let unchanged_since_request = expected_snapshot_id
                    .as_deref()
                    .is_some_and(|expected| expected == current.snapshot_id);

                let mut result = if unchanged_since_request {
                    precondition_result(
                        operation,
                        &request_id,
                        "failed",
                        expected_target_stash_id,
                        current,
                        "本次请求没有持久化 Stash 操作证据，且仓库仍处于请求前快照；Git mutation 未开始。",
                    )
                } else {
                    let mut result = precondition_result(
                        operation,
                        &request_id,
                        "needs_confirmation",
                        expected_target_stash_id,
                        current,
                        "本次请求没有可读取的持久化 Stash 操作证据，且无法证明仓库仍处于请求前状态；不会把错误文案或外部变化推断为本次操作结果。",
                    );
                    result.needs_confirmation = true;
                    result
                };
                result.stash_retained = target_present;
                project_operation_result_snapshot(&repo_root, result).await
            }
        }
    }
}
