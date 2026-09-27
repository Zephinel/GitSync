fn result_with_snapshot(
    stored: StoredStashOperationResult,
    snapshot: RepoStashSnapshot,
) -> StashOperationResult {
    operation_result(stored, Some(snapshot), None)
}

fn precondition_result(
    operation: &str,
    request_id: &str,
    status: &str,
    target_stash_id: Option<String>,
    snapshot: RepoStashSnapshot,
    message: impl Into<String>,
) -> StashOperationResult {
    let mut stored = stored_result(
        operation,
        request_id,
        status,
        target_stash_id,
        message,
    );
    if status == "stale" {
        stored.needs_confirmation = false;
    }
    result_with_snapshot(stored, snapshot)
}

async fn reconcile_existing_request(
    repo_root: &str,
    journal_path: &Path,
    signature: &StashOperationSignature,
) -> Result<Option<StashOperationResult>, String> {
    let Some(mut journal) = load_stash_journal(journal_path)? else {
        return Ok(None);
    };
    if journal.signature != *signature {
        return Err(
            "相同 Stash 请求 ID 已用于不同操作；为避免误认或重复修改，已拒绝执行。"
                .to_string(),
        );
    }
    reconcile_stash_journal(repo_root, journal_path, &mut journal)
        .await
        .map(Some)
}

fn command_error(args: &[&str], output: &GitCommandOutput) -> Option<String> {
    (!output.success).then(|| git_failure(args, output))
}

async fn run_recorded_stash_step(
    repo_root: &str,
    journal_path: &Path,
    journal: &mut StashOperationJournal,
    phase: &str,
    args: &[&str],
) -> Result<(GitCommandOutput, Option<String>), String> {
    journal.phase = phase.to_string();
    persist_stash_journal(journal_path, journal)?;

    let output = run_git_mutation_output(repo_root, args, GIT_STASH_OPERATION_TIMEOUT_MS).await?;
    journal.command_success = Some(output.success);
    journal.command_error = command_error(args, &output);
    journal.phase = format!("{}-returned", phase);
    let journal_update_error = persist_stash_journal(journal_path, journal).err();
    Ok((output, journal_update_error))
}

fn append_journal_warning(
    result: &mut StoredStashOperationResult,
    journal_update_error: Option<String>,
) {
    if let Some(error) = journal_update_error {
        result.needs_confirmation = true;
        if result.status == "complete" {
            result.status = "needs_confirmation".to_string();
        }
        result.warnings.push(format!(
            "Git 命令已返回，但操作记录更新失败：{}。请按当前真实状态确认结果。",
            error
        ));
    }
}

fn unexpected_drop_changes(
    before: &RepoStashSnapshot,
    after: &RepoStashSnapshot,
    target_id: &str,
) -> bool {
    let mut expected = stash_ids(before);
    expected.remove(target_id);
    stash_ids(after) != expected
}

fn create_result_from_state(
    request_id: &str,
    before: &RepoStashSnapshot,
    after: &RepoStashSnapshot,
    output: &GitCommandOutput,
) -> StoredStashOperationResult {
    let before_ids = stash_ids(before);
    let after_ids = stash_ids(after);
    let new_ids = after_ids
        .difference(&before_ids)
        .cloned()
        .collect::<Vec<_>>();
    let worktree_changed = before.worktree_id != after.worktree_id;
    let mut result = stored_result(
        "create",
        request_id,
        "failed",
        None,
        "Stash 创建未完成。",
    );
    result.worktree_changed = worktree_changed;

    if new_ids.len() == 1 {
        result.status = "complete".to_string();
        result.mutated = true;
        result.created_stash_id = new_ids.first().cloned();
        result.message = "Stash 已创建，并通过稳定条目标识完成验证。".to_string();
        if !output.success {
            result.warnings.push(
                "Git 命令返回异常，但新 Stash 条目已经被真实列表确认。".to_string(),
            );
        }
    } else if new_ids.len() > 1 {
        result.status = "needs_confirmation".to_string();
        result.mutated = true;
        result.needs_confirmation = true;
        result.message =
            "操作后出现多个新 Stash，无法把其中任意一条冒认为本次结果。".to_string();
    } else if worktree_changed {
        result.status = "needs_confirmation".to_string();
        result.mutated = true;
        result.needs_confirmation = true;
        result.message =
            "工作区已经变化，但没有找到可证明属于本次请求的新 Stash；请立即确认。"
                .to_string();
    } else if output.success {
        result.errors.push(
            "Git 命令已返回，但没有创建新的 Stash 条目，且工作区未发生变化。".to_string(),
        );
    } else {
        result.errors.push(git_failure(&["stash", "push"], output));
    }
    result
}

fn restore_result_after_apply(
    operation: &str,
    request_id: &str,
    target_id: &str,
    before: &RepoStashSnapshot,
    after: &RepoStashSnapshot,
    output: &GitCommandOutput,
) -> StoredStashOperationResult {
    let target_present = find_stash_entry(after, target_id).is_some();
    let worktree_changed = before.worktree_id != after.worktree_id;
    let mut result = stored_result(
        operation,
        request_id,
        "failed",
        Some(target_id.to_string()),
        if operation == "pop" {
            "Stash Pop 的应用阶段未完成。"
        } else {
            "Stash Apply 未完成。"
        },
    );
    result.worktree_changed = worktree_changed;
    result.stash_retained = target_present;

    if after.conflicted_files > 0 {
        result.status = "conflict".to_string();
        result.mutated = true;
        result.conflicts = after.conflict_paths.clone();
        result.message = if operation == "pop" {
            "Stash Pop 的应用阶段产生冲突；工作区保留已应用内容，原 Stash 保留。"
                .to_string()
        } else {
            "Stash Apply 产生冲突；已应用内容保留在工作区，原 Stash 不会删除。"
                .to_string()
        };
    } else if output.success && target_present {
        result.status = "complete".to_string();
        result.mutated = worktree_changed;
        result.applied = true;
        result.message = if operation == "pop" {
            "Stash 内容已应用，正在确认并删除同一稳定条目。".to_string()
        } else {
            "Stash 已应用到当前工作区，原条目仍然保留。".to_string()
        };
    } else if output.success && !target_present {
        result.status = "needs_confirmation".to_string();
        result.mutated = true;
        result.needs_confirmation = true;
        result.applied = true;
        result.dropped = operation == "pop";
        result.message =
            "应用阶段成功，但目标 Stash 已在验证前消失；无法确认删除是否属于本次请求。"
                .to_string();
    } else if worktree_changed {
        result.status = "needs_confirmation".to_string();
        result.mutated = true;
        result.needs_confirmation = true;
        result.message =
            "Git 返回异常且工作区已经变化；不能判定恢复是否完整完成，也不会自动重试。"
                .to_string();
        result.errors.push(git_failure(&["stash", "apply"], output));
    } else {
        result.errors.push(git_failure(&["stash", "apply"], output));
    }
    result
}

fn drop_result_from_state(
    operation: &str,
    request_id: &str,
    target_id: &str,
    before: &RepoStashSnapshot,
    after: &RepoStashSnapshot,
    output: &GitCommandOutput,
    applied: bool,
) -> StoredStashOperationResult {
    let target_present = find_stash_entry(after, target_id).is_some();
    let worktree_changed = before.worktree_id != after.worktree_id;
    let mut result = stored_result(
        operation,
        request_id,
        "failed",
        Some(target_id.to_string()),
        if operation == "pop" {
            "Stash 内容已应用，但删除阶段未完成。"
        } else {
            "Stash 删除未完成。"
        },
    );
    result.applied = applied;
    result.worktree_changed = worktree_changed;
    result.stash_retained = target_present;

    if !target_present {
        result.status = "complete".to_string();
        result.mutated = true;
        result.dropped = true;
        result.message = if operation == "pop" {
            "Stash 内容已应用，并已确认同一稳定条目删除。".to_string()
        } else {
            "目标 Stash 已按稳定条目标识确认删除。".to_string()
        };
        if unexpected_drop_changes(before, after, target_id) {
            result.status = "needs_confirmation".to_string();
            result.needs_confirmation = true;
            result.warnings.push(
                "目标 Stash 已删除，但列表还出现其他外部变化；请刷新确认完整列表。"
                    .to_string(),
            );
        }
        if !output.success {
            result.warnings.push(
                "Git 命令返回异常，但目标 Stash 已确认不存在。".to_string(),
            );
        }
    } else if applied {
        result.status = "partial".to_string();
        result.mutated = true;
        result.stash_retained = true;
        result.message =
            "Stash 内容已应用，但同一稳定条目仍然存在；不得再次盲目应用。"
                .to_string();
        if !output.success {
            result.errors.push(git_failure(&["stash", "drop"], output));
        }
    } else if output.success {
        result.status = "needs_confirmation".to_string();
        result.needs_confirmation = true;
        result.message =
            "Git 命令已返回，但目标 Stash 仍然存在；不会自动重复删除。".to_string();
    } else {
        result.errors.push(git_failure(&["stash", "drop"], output));
    }
    result
}

async fn prepare_target_operation(
    operation: &str,
    repo_path: String,
    request: TargetStashRequest,
    state: State<'_, AppState>,
) -> Result<
    (
        String,
        crate::repo_git_lock::RepoGitGuard,
        String,
        StashOperationSignature,
        PathBuf,
        RepoStashSnapshot,
    ),
    String,
> {
    ensure_repo_path(&repo_path)?;
    let request_id = normalize_request_id(&request.request_id)?;
    let stash_id = normalize_stash_id(&request.stash_id)?;
    let repo_root = resolve_repo_root(&repo_path).await?;
    let guard = acquire_repo_git_guard(&state, &repo_root).await?;
    let current = read_stash_snapshot_core(&repo_root).await?;
    let signature = StashOperationSignature {
        operation: operation.to_string(),
        expected_snapshot_id: request.expected_snapshot_id,
        target_stash_id: Some(stash_id),
        message: String::new(),
        include_untracked: false,
        keep_index: false,
    };
    let journal_path = stash_operation_path(&repo_root, &request_id).await?;
    Ok((
        repo_root,
        guard,
        request_id,
        signature,
        journal_path,
        current,
    ))
}

pub async fn create_repo_stash(
    repo_path: String,
    request: CreateStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    ensure_repo_path(&repo_path)?;
    let request_id = normalize_request_id(&request.request_id)?;
    let message = normalize_stash_message(&request.message)?;
    let repo_root = resolve_repo_root(&repo_path).await?;
    let _guard = acquire_repo_git_guard(&state, &repo_root).await?;
    let current = read_stash_snapshot_core(&repo_root).await?;
    let signature = StashOperationSignature {
        operation: "create".to_string(),
        expected_snapshot_id: request.expected_snapshot_id,
        target_stash_id: None,
        message: message.clone(),
        include_untracked: request.include_untracked,
        keep_index: request.keep_index,
    };
    let journal_path = stash_operation_path(&repo_root, &request_id).await?;
    if let Some(result) = reconcile_existing_request(&repo_root, &journal_path, &signature).await? {
        return Ok(result);
    }
    if current.snapshot_id != signature.expected_snapshot_id {
        return Ok(precondition_result(
            "create",
            &request_id,
            "stale",
            None,
            current,
            "仓库或 Stash 列表已经变化，本次创建未开始。",
        ));
    }
    if current.head_hash.is_none() {
        return Ok(precondition_result(
            "create",
            &request_id,
            "failed",
            None,
            current,
            "当前仓库还没有首个提交，Git 无法创建标准 Stash。",
        ));
    }
    if current.conflicted_files > 0 {
        return Ok(precondition_result(
            "create",
            &request_id,
            "failed",
            None,
            current,
            "工作区存在未解决冲突，不能创建 Stash。",
        ));
    }
    let can_create = if request.include_untracked {
        current.can_create_with_untracked
    } else {
        current.can_create_default
    };
    if !can_create {
        let message = if current.has_untracked_changes {
            "当前只有未跟踪文件；请明确开启“包含未跟踪文件”后再创建。"
        } else {
            "当前范围没有可保存的修改，不会创建空 Stash。"
        };
        return Ok(precondition_result(
            "create",
            &request_id,
            "failed",
            None,
            current,
            message,
        ));
    }

    let mut journal = new_stash_journal(request_id.clone(), signature, &current);
    persist_stash_journal(&journal_path, &mut journal)?;
    let mut owned_args = vec!["stash".to_string(), "push".to_string()];
    if request.include_untracked {
        owned_args.push("--include-untracked".to_string());
    }
    if request.keep_index {
        owned_args.push("--keep-index".to_string());
    }
    if !message.is_empty() {
        owned_args.push("--message".to_string());
        owned_args.push(message);
    }
    let args = owned_args.iter().map(String::as_str).collect::<Vec<_>>();
    let (output, journal_error) = run_recorded_stash_step(
        &repo_root,
        &journal_path,
        &mut journal,
        "creating",
        &args,
    )
    .await?;
    let after = match read_stash_snapshot_core(&repo_root).await {
        Ok(value) => value,
        Err(error) => {
            let mut result = stored_result(
                "create",
                &request_id,
                "needs_confirmation",
                None,
                "Stash 命令已执行，但操作后状态读取失败。",
            );
            result.mutated = true;
            result.needs_confirmation = true;
            result.errors.push(error);
            append_journal_warning(&mut result, journal_error);
            return settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await;
        }
    };
    let mut result = create_result_from_state(&request_id, &current, &after, &output);
    append_journal_warning(&mut result, journal_error);
    settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await
}

async fn run_restore_stash_operation(
    operation: &str,
    repo_path: String,
    request: TargetStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    let (repo_root, _guard, request_id, signature, journal_path, current) =
        prepare_target_operation(operation, repo_path, request, state).await?;
    if let Some(result) = reconcile_existing_request(&repo_root, &journal_path, &signature).await? {
        return Ok(result);
    }
    let target_id = signature.target_stash_id.clone().unwrap_or_default();
    if current.snapshot_id != signature.expected_snapshot_id {
        return Ok(precondition_result(
            operation,
            &request_id,
            "stale",
            Some(target_id),
            current,
            "仓库或 Stash 列表已经变化，本次恢复未开始。",
        ));
    }
    let Some(target) = find_stash_entry(&current, &target_id).cloned() else {
        return Ok(precondition_result(
            operation,
            &request_id,
            "stale",
            Some(target_id),
            current,
            "目标 Stash 已移动或不存在，请刷新列表后重新选择。",
        ));
    };
    if current.conflicted_files > 0 {
        return Ok(precondition_result(
            operation,
            &request_id,
            "failed",
            Some(target_id),
            current,
            "当前工作区已有未解决冲突，不能继续恢复 Stash。",
        ));
    }

    let mut journal = new_stash_journal(request_id.clone(), signature, &current);
    persist_stash_journal(&journal_path, &mut journal)?;
    let apply_args = ["stash", "apply", "--quiet", target.oid.as_str()];
    let (apply_output, apply_journal_error) = run_recorded_stash_step(
        &repo_root,
        &journal_path,
        &mut journal,
        "applying",
        &apply_args,
    )
    .await?;
    let after_apply = match read_stash_snapshot_core(&repo_root).await {
        Ok(value) => value,
        Err(error) => {
            let mut result = stored_result(
                operation,
                &request_id,
                "needs_confirmation",
                Some(target_id),
                "Stash 应用命令已执行，但操作后状态读取失败。",
            );
            result.mutated = true;
            result.needs_confirmation = true;
            result.errors.push(error);
            append_journal_warning(&mut result, apply_journal_error);
            return settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await;
        }
    };
    let mut applied_result = restore_result_after_apply(
        operation,
        &request_id,
        &target_id,
        &current,
        &after_apply,
        &apply_output,
    );
    append_journal_warning(&mut applied_result, apply_journal_error);

    if operation == "apply" || applied_result.status != "complete" || !applied_result.applied {
        return settle_stash_journal(
            &repo_root,
            &journal_path,
            &mut journal,
            applied_result,
        )
        .await;
    }

    let Some(target_after_apply) = find_stash_entry(&after_apply, &target_id).cloned() else {
        applied_result.status = "needs_confirmation".to_string();
        applied_result.needs_confirmation = true;
        applied_result.dropped = true;
        applied_result.message =
            "Stash 内容已应用，但目标条目在删除阶段前已消失；结果需要确认。"
                .to_string();
        return settle_stash_journal(
            &repo_root,
            &journal_path,
            &mut journal,
            applied_result,
        )
        .await;
    };

    applied_result.status = "partial".to_string();
    applied_result.stash_retained = true;
    applied_result.message =
        "Stash 内容已应用；删除阶段尚未开始，不能再次执行 Apply。".to_string();
    journal.phase = "drop-prepared".to_string();
    journal.result = Some(applied_result.clone());
    if let Err(error) = persist_stash_journal(&journal_path, &mut journal) {
        applied_result.needs_confirmation = true;
        applied_result.errors.push(format!(
            "已应用状态无法持久化，因此为避免重复恢复，本次不会执行删除：{}",
            error
        ));
        return settle_stash_journal(
            &repo_root,
            &journal_path,
            &mut journal,
            applied_result,
        )
        .await;
    }

    let drop_args = [
        "stash",
        "drop",
        "--quiet",
        target_after_apply.selector.as_str(),
    ];
    let (drop_output, drop_journal_error) = run_recorded_stash_step(
        &repo_root,
        &journal_path,
        &mut journal,
        "dropping-after-apply",
        &drop_args,
    )
    .await?;
    let after_drop = match read_stash_snapshot_core(&repo_root).await {
        Ok(value) => value,
        Err(error) => {
            let mut result = applied_result;
            result.status = "needs_confirmation".to_string();
            result.needs_confirmation = true;
            result.errors.push(format!(
                "删除命令已执行，但无法重新读取 Stash 列表：{}",
                error
            ));
            append_journal_warning(&mut result, drop_journal_error);
            return settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await;
        }
    };
    let mut result = drop_result_from_state(
        "pop",
        &request_id,
        &target_id,
        &after_apply,
        &after_drop,
        &drop_output,
        true,
    );
    append_journal_warning(&mut result, drop_journal_error);
    settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await
}

async fn run_drop_stash_operation(
    repo_path: String,
    request: TargetStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    let operation = "drop";
    let (repo_root, _guard, request_id, signature, journal_path, current) =
        prepare_target_operation(operation, repo_path, request, state).await?;
    if let Some(result) = reconcile_existing_request(&repo_root, &journal_path, &signature).await? {
        return Ok(result);
    }
    let target_id = signature.target_stash_id.clone().unwrap_or_default();
    if current.snapshot_id != signature.expected_snapshot_id {
        return Ok(precondition_result(
            operation,
            &request_id,
            "stale",
            Some(target_id),
            current,
            "仓库或 Stash 列表已经变化，本次删除未开始。",
        ));
    }
    let Some(target) = find_stash_entry(&current, &target_id).cloned() else {
        return Ok(precondition_result(
            operation,
            &request_id,
            "stale",
            Some(target_id),
            current,
            "目标 Stash 已移动或不存在，请刷新列表后重新选择。",
        ));
    };

    let mut journal = new_stash_journal(request_id.clone(), signature, &current);
    persist_stash_journal(&journal_path, &mut journal)?;
    let args = ["stash", "drop", "--quiet", target.selector.as_str()];
    let (output, journal_error) = run_recorded_stash_step(
        &repo_root,
        &journal_path,
        &mut journal,
        "dropping",
        &args,
    )
    .await?;
    let after = match read_stash_snapshot_core(&repo_root).await {
        Ok(value) => value,
        Err(error) => {
            let mut result = stored_result(
                operation,
                &request_id,
                "needs_confirmation",
                Some(target_id),
                "Stash 删除命令已执行，但操作后状态读取失败。",
            );
            result.mutated = true;
            result.needs_confirmation = true;
            result.errors.push(error);
            append_journal_warning(&mut result, journal_error);
            return settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await;
        }
    };
    let mut result = drop_result_from_state(
        operation,
        &request_id,
        &target_id,
        &current,
        &after,
        &output,
        false,
    );
    append_journal_warning(&mut result, journal_error);
    settle_stash_journal(&repo_root, &journal_path, &mut journal, result).await
}

pub async fn apply_repo_stash(
    repo_path: String,
    request: TargetStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    run_restore_stash_operation("apply", repo_path, request, state).await
}

pub async fn pop_repo_stash(
    repo_path: String,
    request: TargetStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    run_restore_stash_operation("pop", repo_path, request, state).await
}

pub(crate) async fn drop_repo_stash_internal(
    repo_path: String,
    request: TargetStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    run_drop_stash_operation(repo_path, request, state).await
}
