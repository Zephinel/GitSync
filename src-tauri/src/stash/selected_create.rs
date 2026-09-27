const SELECTED_STASH_OPERATION_DIRECTORY: &str = "gitsync/stash-selected-operations";
const SELECTED_STASH_JOURNAL_VERSION: u32 = 1;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSelectedStashRequest {
    pub request_id: String,
    pub expected_snapshot_id: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub include_untracked: bool,
    #[serde(default)]
    pub keep_index: bool,
    pub files: Vec<StashPathTarget>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SelectedStashOperationJournal {
    version: u32,
    request_id: String,
    #[serde(default)]
    origin_repo_root: String,
    #[serde(default)]
    completion_validated: bool,
    expected_snapshot_id: String,
    message: String,
    include_untracked: bool,
    keep_index: bool,
    targets: Vec<StashPathTarget>,
    selected_files: Vec<StashWorktreeFile>,
    before_snapshot_id: String,
    before_worktree_id: String,
    before_stash_ids: Vec<String>,
    #[serde(default)]
    before_unselected_status_oid: String,
    #[serde(default)]
    before_files: Vec<StashWorktreeFile>,
    phase: String,
    created_at_ms: u128,
    updated_at_ms: u128,
    command_success: Option<bool>,
    command_error: Option<String>,
    result: Option<StoredStashOperationResult>,
}

async fn selected_stash_journal_directory(repo_root: &str) -> Result<PathBuf, String> {
    Ok(resolve_git_common_dir(repo_root)
        .await?
        .join(SELECTED_STASH_OPERATION_DIRECTORY))
}

async fn selected_stash_operation_path(
    repo_root: &str,
    request_id: &str,
) -> Result<PathBuf, String> {
    let directory = selected_stash_journal_directory(repo_root).await?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建文件级 Stash 操作记录目录: {}", error))?;
    Ok(directory.join(format!("{}.json", request_id)))
}

fn persist_selected_stash_journal(
    path: &Path,
    journal: &mut SelectedStashOperationJournal,
) -> Result<(), String> {
    journal.updated_at_ms = now_ms();
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("无法序列化文件级 Stash 操作记录: {}", error))?;
    let temporary = journal_sibling_path(path, "tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("无法写入文件级 Stash 操作记录: {}", error))?;
    file.write_all(&bytes)
        .map_err(|error| format!("无法写入文件级 Stash 操作记录: {}", error))?;
    file.sync_all()
        .map_err(|error| format!("无法同步文件级 Stash 操作记录: {}", error))?;
    drop(file);

    #[cfg(target_os = "windows")]
    {
        let backup = journal_sibling_path(path, "bak");
        let had_previous = path.exists();
        if had_previous {
            if backup.exists() {
                fs::remove_file(&backup)
                    .map_err(|error| format!("无法清理旧文件级 Stash 备份: {}", error))?;
            }
            fs::rename(path, &backup)
                .map_err(|error| format!("无法备份文件级 Stash 操作记录: {}", error))?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            if had_previous {
                let _ = fs::rename(&backup, path);
            }
            return Err(format!("无法提交文件级 Stash 操作记录: {}", error));
        }
        if backup.exists() {
            let _ = fs::remove_file(backup);
        }
    }

    #[cfg(not(target_os = "windows"))]
    fs::rename(&temporary, path)
        .map_err(|error| format!("无法提交文件级 Stash 操作记录: {}", error))?;

    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn selected_phase_is_valid(phase: &str) -> bool {
    matches!(phase, "prepared" | "executing" | "command-returned" | "settled")
}

fn selected_file_targets(files: &[StashWorktreeFile]) -> Result<Vec<StashPathTarget>, String> {
    let values = files
        .iter()
        .map(|file| StashPathTarget {
            path: file.path.clone(),
            old_path: file.old_path.clone(),
        })
        .collect::<Vec<_>>();
    normalize_stash_scope_targets(&values)
}

fn validate_selected_scope_evidence(journal: &SelectedStashOperationJournal) -> Result<(), String> {
    if journal.selected_files.is_empty() {
        return Err("文件级 Stash journal 缺少 selected file identity。".to_string());
    }
    let digest = journal.before_unselected_status_oid.trim();
    match (digest.is_empty(), journal.before_files.is_empty()) {
        (true, false) => Ok(()),
        (false, true) => {
            normalize_git_content_oid(digest)?;
            Ok(())
        }
        (true, true) => Err(
            "文件级 Stash journal 同时缺少 legacy before_files 与 unselected digest。"
                .to_string(),
        ),
        (false, false) => Err(
            "文件级 Stash journal 同时携带 legacy before_files 与 unselected digest；authority 不唯一。"
                .to_string(),
        ),
    }
}

fn validate_selected_stash_journal(
    path: &Path,
    journal: &SelectedStashOperationJournal,
) -> Result<(), String> {
    let path_request_id = evidence_path_request_id(path)?;
    let journal_request_id = normalize_request_id(&journal.request_id)?;
    if path_request_id != journal_request_id {
        return Err(format!(
            "文件级 Stash 操作记录文件身份 {} 与 journal request ID {} 不一致。",
            path_request_id, journal_request_id
        ));
    }
    if journal.expected_snapshot_id.trim().is_empty()
        || journal.before_snapshot_id.trim().is_empty()
        || journal.before_worktree_id.trim().is_empty()
        || journal.expected_snapshot_id != journal.before_snapshot_id
    {
        return Err("文件级 Stash 操作记录缺少或错绑 request-before snapshot/worktree identity。".to_string());
    }
    if !selected_phase_is_valid(&journal.phase) {
        return Err("文件级 Stash 操作记录包含未知 phase。".to_string());
    }
    let normalized_targets = normalize_stash_scope_targets(&journal.targets)?;
    if normalized_targets != journal.targets || normalized_targets.is_empty() {
        return Err("文件级 Stash 操作记录包含无效或非规范 selected target identity。".to_string());
    }
    let selected_targets = selected_file_targets(&journal.selected_files)?;
    if selected_targets.len() != journal.selected_files.len()
        || selected_targets != normalized_targets
    {
        return Err(
            "文件级 Stash journal 的 selected_files 与 request target identity 不一致或重复。"
                .to_string(),
        );
    }
    validate_selected_scope_evidence(journal)?;
    validate_before_stash_ids(&journal.before_stash_ids)?;
    if journal.phase == "settled" && journal.result.is_none() {
        return Err("settled 文件级 Stash journal 缺少最终 result。".to_string());
    }
    if let Some(result) = journal.result.as_ref() {
        validate_stored_result_identity(result, "create_selected", &journal.request_id, None)?;
        if journal.phase != "settled" {
            return Err("非 settled 文件级 Stash journal 不能持久化 result。".to_string());
        }
    }
    validate_completion_proof(
        &journal.phase,
        journal.result.as_ref(),
        journal.completion_validated,
        journal.command_success,
        journal.command_error.as_deref(),
    )?;
    Ok(())
}

fn load_selected_stash_journal(
    path: &Path,
) -> Result<Option<SelectedStashOperationJournal>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("无法读取文件级 Stash 操作记录: {}", error))?;
    let journal: SelectedStashOperationJournal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("文件级 Stash 操作记录损坏: {}", error))?;
    if journal.version != SELECTED_STASH_JOURNAL_VERSION {
        return Err("文件级 Stash 操作记录版本不受支持。".to_string());
    }
    validate_selected_stash_journal(path, &journal)?;
    Ok(Some(journal))
}

fn selected_request_matches(
    journal: &SelectedStashOperationJournal,
    expected_snapshot_id: &str,
    message: &str,
    include_untracked: bool,
    keep_index: bool,
    targets: &[StashPathTarget],
) -> bool {
    journal.expected_snapshot_id == expected_snapshot_id
        && journal.message == message
        && journal.include_untracked == include_untracked
        && journal.keep_index == keep_index
        && journal.targets == targets
}

fn selected_create_reconciled_result(
    journal: &SelectedStashOperationJournal,
    current: &RepoStashSnapshot,
    scope_verified: bool,
) -> StoredStashOperationResult {
    if let Some(result) = journal.result.clone() {
        if matches!(
            result.status.as_str(),
            "complete" | "failed" | "stale" | "acknowledged"
        ) && !result.needs_confirmation
        {
            return result;
        }
    }

    let before_ids = journal
        .before_stash_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let current_ids = stash_ids(current);
    let new_ids = current_ids
        .difference(&before_ids)
        .cloned()
        .collect::<Vec<_>>();
    let mut result = stored_result(
        "create_selected",
        &journal.request_id,
        "needs_confirmation",
        None,
        "文件级 Stash 操作被中断，当前只按真实仓库状态对账，不会重复执行。",
    );
    result.needs_confirmation = true;
    result.worktree_changed = current.worktree_id != journal.before_worktree_id;
    result.mutated = result.worktree_changed || current.snapshot_id != journal.before_snapshot_id;

    if new_ids.len() == 1 && scope_verified {
        result.status = "complete".to_string();
        result.needs_confirmation = false;
        result.mutated = true;
        result.created_stash_id = new_ids.first().cloned();
        result.message = format!(
            "已确认文件级 Stash 创建完成，范围为所选的 {} 个文件。",
            journal.selected_files.len()
        );
    } else if new_ids.len() > 1 {
        result.message = "操作中断后出现多个新 Stash，无法把任意条目冒认为本次文件级结果。"
            .to_string();
    } else if new_ids.len() == 1 {
        result.created_stash_id = new_ids.first().cloned();
        result.message =
            "已确认新 Stash 条目存在，但文件级范围结果不符合完整预期；请核对工作区。"
                .to_string();
    } else if !result.worktree_changed && journal.command_success == Some(false) {
        result.status = "failed".to_string();
        result.needs_confirmation = false;
        result.mutated = false;
        result.message = "文件级 Stash 命令已明确失败，仓库状态没有变化。".to_string();
        if let Some(error) = journal.command_error.clone() {
            result.errors.push(error);
        }
    }
    result
}

async fn settle_selected_stash_journal(
    repo_root: &str,
    path: &Path,
    journal: &mut SelectedStashOperationJournal,
    mut result: StoredStashOperationResult,
) -> Result<StashOperationResult, String> {
    journal.phase = "settled".to_string();
    journal.completion_validated = false;
    journal.result = Some(result.clone());
    if let Err(error) = persist_selected_stash_journal(path, journal) {
        result.status = "needs_confirmation".to_string();
        result.needs_confirmation = true;
        result.errors.push(format!(
            "文件级 Stash 状态已变化，但最终操作记录无法持久化：{}",
            error
        ));
    }
    match read_stash_snapshot(repo_root).await {
        Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
        Err(error) => Ok(operation_result(result, None, Some(error))),
    }
}

async fn selected_scope_verified_for_journal(
    repo_root: &str,
    journal: &SelectedStashOperationJournal,
) -> Result<bool, String> {
    if !journal.before_unselected_status_oid.trim().is_empty() {
        let current_unselected =
            hash_unselected_stash_worktree_status(repo_root, &journal.selected_files).await?;
        let current_selected =
            read_stash_worktree_files_for_selected(repo_root, &journal.selected_files).await?;
        return Ok(verify_selected_scope_digest_after_create(
            &journal.before_unselected_status_oid,
            &current_unselected,
            &current_selected,
            &journal.selected_files,
            journal.keep_index,
        ));
    }

    let current_files = read_stash_worktree_files(repo_root).await?;
    Ok(verify_selected_scope_after_create(
        &journal.before_files,
        &current_files,
        &journal.selected_files,
        journal.keep_index,
    ))
}

async fn reconcile_selected_stash_journal(
    repo_root: &str,
    path: &Path,
    journal: &mut SelectedStashOperationJournal,
) -> Result<StashOperationResult, String> {
    ensure_stash_journal_origin(&journal.origin_repo_root, repo_root, false)?;
    let current = read_stash_snapshot_core(repo_root).await?;
    let scope_verified = selected_scope_verified_for_journal(repo_root, journal).await?;
    let result = selected_create_reconciled_result(journal, &current, scope_verified);
    settle_selected_stash_journal(repo_root, path, journal, result).await
}

pub(crate) async fn create_repo_stash_selected(
    repo_path: String,
    request: CreateSelectedStashRequest,
    state: State<'_, AppState>,
) -> Result<StashOperationResult, String> {
    ensure_repo_path(&repo_path)?;
    let request_id = normalize_request_id(&request.request_id)?;
    let message = normalize_stash_message(&request.message)?;
    let targets = normalize_stash_scope_targets(&request.files)?;
    let repo_root = resolve_repo_root(&repo_path).await?;
    let _guard = acquire_repo_git_guard(&state, &repo_root).await?;
    let current = read_stash_snapshot_core(&repo_root).await?;
    let journal_path = selected_stash_operation_path(&repo_root, &request_id).await?;

    if let Some(mut journal) = load_selected_stash_journal(&journal_path)? {
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
                "相同文件级 Stash 请求 ID 已用于不同范围；已拒绝重复执行。".to_string(),
            );
        }
        return reconcile_selected_stash_journal(&repo_root, &journal_path, &mut journal).await;
    }

    if current.snapshot_id != request.expected_snapshot_id {
        return Ok(precondition_result(
            "create_selected",
            &request_id,
            "stale",
            None,
            current,
            "仓库或 Stash 列表已经变化，本次文件级创建未开始。",
        ));
    }
    if current.head_hash.is_none() {
        return Ok(precondition_result(
            "create_selected",
            &request_id,
            "failed",
            None,
            current,
            "当前仓库还没有首个提交，Git 无法创建标准 Stash。",
        ));
    }
    if current.conflicted_files > 0 {
        return Ok(precondition_result(
            "create_selected",
            &request_id,
            "failed",
            None,
            current,
            "工作区存在未解决冲突，不能创建文件级 Stash。",
        ));
    }

    let selected_candidates = read_stash_worktree_files_for_targets(&repo_root, &targets).await?;
    let selected_files = match resolve_selected_scope(
        &selected_candidates,
        &targets,
        request.include_untracked,
        request.keep_index,
    ) {
        Ok(files) => files,
        Err(error) => {
            return Ok(precondition_result(
                "create_selected",
                &request_id,
                "failed",
                None,
                current,
                error,
            ));
        }
    };
    let before_unselected_status_oid =
        hash_unselected_stash_worktree_status(&repo_root, &selected_files).await?;

    let timestamp = now_ms();
    let mut journal = SelectedStashOperationJournal {
        version: SELECTED_STASH_JOURNAL_VERSION,
        request_id: request_id.clone(),
        origin_repo_root: stash_worktree_origin(&repo_root),
        completion_validated: false,
        expected_snapshot_id: request.expected_snapshot_id,
        message: message.clone(),
        include_untracked: request.include_untracked,
        keep_index: request.keep_index,
        targets,
        selected_files: selected_files.clone(),
        before_snapshot_id: current.snapshot_id.clone(),
        before_worktree_id: current.worktree_id.clone(),
        before_stash_ids: current
            .all_stashes
            .iter()
            .map(|entry| entry.id.clone())
            .collect(),
        before_unselected_status_oid,
        before_files: Vec::new(),
        phase: "prepared".to_string(),
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
        command_success: None,
        command_error: None,
        result: None,
    };
    persist_selected_stash_journal(&journal_path, &mut journal)?;

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
    owned_args.push("--".to_string());
    owned_args.extend(selected_scope_pathspecs(&selected_files));
    let args = owned_args.iter().map(String::as_str).collect::<Vec<_>>();

    journal.phase = "executing".to_string();
    persist_selected_stash_journal(&journal_path, &mut journal)?;
    let output = run_git_mutation_output(&repo_root, &args, GIT_STASH_OPERATION_TIMEOUT_MS).await?;
    journal.command_success = Some(output.success);
    journal.command_error = command_error(&args, &output);
    journal.phase = "command-returned".to_string();
    let journal_warning = persist_selected_stash_journal(&journal_path, &mut journal).err();

    let after = match read_stash_snapshot_core(&repo_root).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let mut result = stored_result(
                "create_selected",
                &request_id,
                "needs_confirmation",
                None,
                "文件级 Stash 命令已执行，但操作后状态读取失败。",
            );
            result.mutated = true;
            result.needs_confirmation = true;
            result.errors.push(error);
            if let Some(error) = journal_warning {
                result.warnings.push(error);
            }
            return settle_selected_stash_journal(
                &repo_root,
                &journal_path,
                &mut journal,
                result,
            )
            .await;
        }
    };

    let mut result = create_result_from_state(&request_id, &current, &after, &output);
    result.operation = "create_selected".to_string();
    match async {
        let after_unselected =
            hash_unselected_stash_worktree_status(&repo_root, &selected_files).await?;
        let after_selected =
            read_stash_worktree_files_for_selected(&repo_root, &selected_files).await?;
        Ok::<_, String>(verify_selected_scope_digest_after_create(
            &journal.before_unselected_status_oid,
            &after_unselected,
            &after_selected,
            &selected_files,
            request.keep_index,
        ))
    }
    .await
    {
        Ok(verified) => {
            apply_selected_scope_verification_result(&mut result, verified, selected_files.len())
        }
        Err(error) => {
            if result.status == "complete" {
                result.status = "needs_confirmation".to_string();
            }
            result.needs_confirmation = true;
            result.errors.push(format!(
                "文件级 Stash 已执行，但范围 digest/selected residual 无法复核：{}",
                error
            ));
            result.message =
                "文件级 Stash 已执行，但操作后范围证据读取失败；不会自动重试。"
                    .to_string();
        }
    }
    if let Some(error) = journal_warning {
        result.needs_confirmation = true;
        if result.status == "complete" {
            result.status = "needs_confirmation".to_string();
        }
        result.warnings.push(format!(
            "Git 命令已返回，但文件级操作记录更新失败：{}",
            error
        ));
    }
    settle_selected_stash_journal(&repo_root, &journal_path, &mut journal, result).await
}
