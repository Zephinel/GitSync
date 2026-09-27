fn journal_sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("operation.json");
    path.with_file_name(format!("{}.{}", file_name, suffix))
}

async fn stash_operation_path(repo_root: &str, request_id: &str) -> Result<PathBuf, String> {
    let directory = stash_journal_directory(repo_root).await?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建 Stash 操作记录目录: {}", error))?;
    Ok(directory.join(format!("{}.json", request_id)))
}

fn persist_stash_journal(
    path: &Path,
    journal: &mut StashOperationJournal,
) -> Result<(), String> {
    journal.updated_at_ms = now_ms();
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("无法序列化 Stash 操作记录: {}", error))?;
    let tmp = journal_sibling_path(path, "tmp");
    #[cfg(target_os = "windows")]
    let backup = journal_sibling_path(path, "bak");

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|error| format!("无法写入 Stash 操作记录: {}", error))?;
    file.write_all(&bytes)
        .map_err(|error| format!("无法写入 Stash 操作记录: {}", error))?;
    file.sync_all()
        .map_err(|error| format!("无法同步 Stash 操作记录: {}", error))?;
    drop(file);

    #[cfg(target_os = "windows")]
    {
        let had_previous = path.exists();
        if had_previous {
            if backup.exists() {
                fs::remove_file(&backup)
                    .map_err(|error| format!("无法清理旧 Stash 操作备份: {}", error))?;
            }
            fs::rename(path, &backup)
                .map_err(|error| format!("无法备份旧 Stash 操作记录: {}", error))?;
        }
        if let Err(error) = fs::rename(&tmp, path) {
            if had_previous {
                let _ = fs::rename(&backup, path);
            }
            return Err(format!("无法提交 Stash 操作记录: {}", error));
        }
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
    }

    #[cfg(not(target_os = "windows"))]
    fs::rename(&tmp, path)
        .map_err(|error| format!("无法提交 Stash 操作记录: {}", error))?;

    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn evidence_path_request_id(path: &Path) -> Result<String, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Stash 操作记录路径缺少有效文件名。".to_string())?;
    let canonical_name = file_name.strip_suffix(".bak").unwrap_or(file_name);
    let request_id = canonical_name
        .strip_suffix(".json")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Stash 操作记录文件名不符合 request-id.json 约定。".to_string())?;
    normalize_request_id(request_id)
}

fn stored_result_status_is_terminal(status: &str) -> bool {
    matches!(status, "complete" | "failed" | "stale" | "acknowledged")
}

fn stash_result_is_durable_terminal(
    result: &StoredStashOperationResult,
    completion_validated: bool,
) -> bool {
    if result.needs_confirmation {
        return false;
    }
    match result.status.as_str() {
        "complete" => completion_validated,
        "failed" | "stale" | "acknowledged" => true,
        _ => false,
    }
}

fn validate_completion_proof(
    phase: &str,
    result: Option<&StoredStashOperationResult>,
    completion_validated: bool,
    command_success: Option<bool>,
    command_error: Option<&str>,
) -> Result<(), String> {
    if !completion_validated {
        return Ok(());
    }
    let result = result.ok_or_else(|| {
        "completion_validated Stash journal 缺少持久化 result。".to_string()
    })?;
    if phase != "settled" || result.status != "complete" || result.needs_confirmation {
        return Err(
            "completion_validated 只能标记 settled 且无需确认的 complete result。".to_string(),
        );
    }
    if command_success != Some(true) || command_error.is_some() {
        return Err(
            "completion_validated Stash journal 缺少一致的 Git command-success evidence。"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_stored_result_semantics(
    result: &StoredStashOperationResult,
    expected_operation: &str,
) -> Result<(), String> {
    if result.status == "needs_confirmation" && !result.needs_confirmation {
        return Err("needs_confirmation result 必须显式保留 confirmation barrier。".to_string());
    }
    if stored_result_status_is_terminal(&result.status) && result.needs_confirmation {
        return Err("terminal Stash result 不能同时要求 confirmation。".to_string());
    }

    match result.status.as_str() {
        "complete" => match expected_operation {
            "create" | "create_selected" => {
                if !result.mutated
                    || result.created_stash_id.is_none()
                    || result.applied
                    || result.dropped
                    || result.stash_retained
                {
                    return Err("Create complete result 的 mutation/created-OID axes 不一致。".to_string());
                }
            }
            "apply" => {
                if result.created_stash_id.is_some()
                    || !result.applied
                    || result.dropped
                    || !result.stash_retained
                {
                    return Err("Apply complete result 的 applied/retained axes 不一致。".to_string());
                }
            }
            "pop" => {
                if !result.mutated
                    || result.created_stash_id.is_some()
                    || !result.applied
                    || !result.dropped
                    || result.stash_retained
                {
                    return Err("Pop complete result 的 apply/drop axes 不一致。".to_string());
                }
            }
            "drop" => {
                if !result.mutated
                    || result.created_stash_id.is_some()
                    || result.applied
                    || !result.dropped
                    || result.stash_retained
                {
                    return Err("Drop complete result 的 deletion axes 不一致。".to_string());
                }
            }
            _ => return Err("complete result 使用了未知 Stash operation。".to_string()),
        },
        "failed" | "stale" => {
            if result.mutated
                || result.worktree_changed
                || result.created_stash_id.is_some()
                || result.applied
                || result.dropped
            {
                return Err("failed/stale result 不能宣称已经发生 Git mutation。".to_string());
            }
        }
        "partial" => {
            if expected_operation != "pop"
                || result.dropped
                || !result.stash_retained
                || (!result.needs_confirmation && !result.applied)
            {
                return Err("partial result 必须是 retained Pop；只有 confirmed partial 才能宣称 Apply 已完成。".to_string());
            }
        }
        "conflict" => {
            if !matches!(expected_operation, "apply" | "pop")
                || !result.mutated
                || result.dropped
                || !result.stash_retained
                || result.conflicts.is_empty()
            {
                return Err("conflict result 的 restore/retained axes 不一致。".to_string());
            }
        }
        "needs_confirmation" | "acknowledged" => {}
        _ => return Err("Stash 操作记录包含未知 result status。".to_string()),
    }
    Ok(())
}

fn validate_stored_result_identity(
    result: &StoredStashOperationResult,
    expected_operation: &str,
    expected_request_id: &str,
    expected_target_stash_id: Option<&str>,
) -> Result<(), String> {
    if result.operation != expected_operation
        || result.request_id != expected_request_id
        || result.target_stash_id.as_deref() != expected_target_stash_id
    {
        return Err(
            "Stash 操作记录中的 result 身份与 journal 身份不一致，不能作为恢复证据。"
                .to_string(),
        );
    }
    if !matches!(
        result.status.as_str(),
        "complete"
            | "partial"
            | "conflict"
            | "failed"
            | "stale"
            | "needs_confirmation"
            | "acknowledged"
    ) {
        return Err("Stash 操作记录包含未知 result status。".to_string());
    }
    if let Some(created_id) = result.created_stash_id.as_deref() {
        normalize_stash_id(created_id)?;
        if expected_operation != "create" && expected_operation != "create_selected" {
            return Err("非 Create Stash 结果不能携带 created_stash_id。".to_string());
        }
    }
    validate_stored_result_semantics(result, expected_operation)
}

fn validate_before_stash_ids(ids: &[String]) -> Result<(), String> {
    let mut seen = HashSet::new();
    for stash_id in ids {
        let normalized = normalize_stash_id(stash_id)?;
        if !seen.insert(normalized) {
            return Err("Stash 操作记录的 before_stash_ids 存在重复稳定 OID。".to_string());
        }
    }
    Ok(())
}

fn stored_completion_matches_public(
    stored: &StoredStashOperationResult,
    result: &StashOperationResult,
) -> bool {
    stored.operation == result.operation
        && stored.request_id == result.request_id
        && stored.status == result.status
        && stored.mutated == result.mutated
        && stored.needs_confirmation == result.needs_confirmation
        && stored.worktree_changed == result.worktree_changed
        && stored.created_stash_id == result.created_stash_id
        && stored.target_stash_id == result.target_stash_id
        && stored.applied == result.applied
        && stored.dropped == result.dropped
        && stored.stash_retained == result.stash_retained
        && stored.conflicts == result.conflicts
        && stored.warnings == result.warnings
        && stored.errors == result.errors
        && stored.message == result.message
}

async fn persist_completion_validated(
    repo_root: &str,
    result: &StashOperationResult,
) -> Result<(), String> {
    if result.status != "complete" || result.needs_confirmation {
        return Err("只有无需确认的 complete result 可以持久化 completion proof。".to_string());
    }

    match result.operation.as_str() {
        "create_selected" => {
            let path = selected_stash_operation_path(repo_root, &result.request_id).await?;
            let Some(mut journal) = load_selected_stash_journal_authoritative(&path)? else {
                return Err("找不到需要完成 authoritative validation 的文件级 Stash journal。".to_string());
            };
            ensure_stash_journal_origin(&journal.origin_repo_root, repo_root, false)?;
            {
                let stored = journal.result.as_ref().ok_or_else(|| {
                    "文件级 Stash journal 缺少待验证 complete result。".to_string()
                })?;
                validate_stored_result_identity(
                    stored,
                    "create_selected",
                    &journal.request_id,
                    None,
                )?;
                if !stored_completion_matches_public(stored, result) {
                    return Err(
                        "文件级 Stash journal result 与 authoritative validated result 不一致。"
                            .to_string(),
                    );
                }
            }
            if journal.completion_validated {
                return Ok(());
            }
            journal.completion_validated = true;
            validate_selected_stash_journal(&path, &journal)?;
            persist_selected_stash_journal(&path, &mut journal)
        }
        "create" | "apply" | "pop" | "drop" => {
            let path = stash_operation_path(repo_root, &result.request_id).await?;
            let Some(mut journal) = load_stash_journal(&path)? else {
                return Err("找不到需要完成 authoritative validation 的 Stash journal。".to_string());
            };
            ensure_stash_journal_origin(&journal.origin_repo_root, repo_root, false)?;
            {
                let stored = journal.result.as_ref().ok_or_else(|| {
                    "Stash journal 缺少待验证 complete result。".to_string()
                })?;
                validate_stored_result_identity(
                    stored,
                    &journal.signature.operation,
                    &journal.request_id,
                    journal.signature.target_stash_id.as_deref(),
                )?;
                if !stored_completion_matches_public(stored, result) {
                    return Err(
                        "Stash journal result 与 authoritative validated result 不一致。"
                            .to_string(),
                    );
                }
            }
            if journal.completion_validated {
                return Ok(());
            }
            journal.completion_validated = true;
            validate_regular_stash_journal(&path, &journal)?;
            persist_stash_journal(&path, &mut journal)
        }
        _ => Err("不受支持的 Stash completion validation operation。".to_string()),
    }
}

fn regular_phase_is_valid(operation: &str, phase: &str) -> bool {
    match operation {
        "create" => matches!(phase, "prepared" | "creating" | "creating-returned" | "settled"),
        "apply" => matches!(phase, "prepared" | "applying" | "applying-returned" | "settled"),
        "pop" => matches!(
            phase,
            "prepared"
                | "applying"
                | "applying-returned"
                | "drop-prepared"
                | "dropping-after-apply"
                | "dropping-after-apply-returned"
                | "settled"
        ),
        "drop" => matches!(phase, "prepared" | "dropping" | "dropping-returned" | "settled"),
        _ => false,
    }
}

fn validate_regular_stash_journal(
    path: &Path,
    journal: &StashOperationJournal,
) -> Result<(), String> {
    let path_request_id = evidence_path_request_id(path)?;
    let journal_request_id = normalize_request_id(&journal.request_id)?;
    if path_request_id != journal_request_id {
        return Err(format!(
            "Stash 操作记录文件身份 {} 与 journal request ID {} 不一致。",
            path_request_id, journal_request_id
        ));
    }
    if journal.signature.expected_snapshot_id.trim().is_empty()
        || journal.before_snapshot_id.trim().is_empty()
        || journal.before_worktree_id.trim().is_empty()
        || journal.signature.expected_snapshot_id != journal.before_snapshot_id
    {
        return Err("Stash 操作记录缺少或错绑 request-before snapshot/worktree identity。".to_string());
    }
    let target = journal.signature.target_stash_id.as_deref();
    match journal.signature.operation.as_str() {
        "create" if target.is_none() => {}
        "apply" | "pop" | "drop" => {
            normalize_stash_id(
                target.ok_or_else(|| "目标型 Stash journal 缺少稳定 target OID。".to_string())?,
            )?;
        }
        "create" => return Err("Create Stash journal 不应携带 target OID。".to_string()),
        _ => return Err("Stash 操作记录包含未知 operation。".to_string()),
    }
    if !regular_phase_is_valid(&journal.signature.operation, &journal.phase) {
        return Err("Stash 操作记录包含不属于该 operation 的 phase。".to_string());
    }
    validate_before_stash_ids(&journal.before_stash_ids)?;
    if journal.phase == "settled" && journal.result.is_none() {
        return Err("settled Stash journal 缺少最终 result。".to_string());
    }
    if let Some(result) = journal.result.as_ref() {
        validate_stored_result_identity(
            result,
            &journal.signature.operation,
            &journal.request_id,
            target,
        )?;
        if stored_result_status_is_terminal(&result.status) && journal.phase != "settled" {
            return Err("terminal Stash result 只能存在于 settled journal。".to_string());
        }
        if journal.phase != "settled"
            && !(journal.signature.operation == "pop"
                && journal.phase == "drop-prepared"
                && result.status == "partial"
                && !result.needs_confirmation)
        {
            return Err("非 settled journal 出现了不属于安全中间阶段的 result。".to_string());
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

fn parse_stash_journal(path: &Path) -> Result<StashOperationJournal, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("无法读取 Stash 操作记录: {}", error))?;
    let journal: StashOperationJournal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Stash 操作记录损坏: {}", error))?;
    if journal.version != STASH_JOURNAL_VERSION {
        return Err("Stash 操作记录版本不受支持。".to_string());
    }
    validate_regular_stash_journal(path, &journal)?;
    Ok(journal)
}

fn load_stash_journal(path: &Path) -> Result<Option<StashOperationJournal>, String> {
    let backup = journal_sibling_path(path, "bak");
    let candidates = [path, backup.as_path()];
    let mut found = false;
    let mut failures = Vec::new();

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        found = true;
        match parse_stash_journal(candidate) {
            Ok(journal) => return Ok(Some(journal)),
            Err(error) => failures.push(error),
        }
    }

    if !found {
        return Ok(None);
    }
    Err(format!(
        "Stash 操作记录损坏，不能盲目重试: {}",
        failures.join("；")
    ))
}

fn stash_worktree_origin(repo_root: &str) -> String {
    normalize_repo_lock_key(repo_root)
}

fn ensure_stash_journal_origin(
    origin_repo_root: &str,
    repo_root: &str,
    allow_legacy_origin: bool,
) -> Result<(), String> {
    let origin = origin_repo_root.trim();
    if origin.is_empty() {
        return if allow_legacy_origin {
            Ok(())
        } else {
            Err("旧 Stash 操作记录缺少来源 worktree 身份，不能自动对账；只能显式接受当前状态。".to_string())
        };
    }
    if origin != stash_worktree_origin(repo_root) {
        return Err(format!(
            "该 Stash 操作属于另一个 worktree（{}）；请回到原 worktree 确认或接受结果。",
            origin_repo_root
        ));
    }
    Ok(())
}

fn stored_result(
    operation: &str,
    request_id: &str,
    status: &str,
    target_stash_id: Option<String>,
    message: impl Into<String>,
) -> StoredStashOperationResult {
    StoredStashOperationResult {
        operation: operation.to_string(),
        request_id: request_id.to_string(),
        status: status.to_string(),
        mutated: false,
        needs_confirmation: status == "needs_confirmation",
        worktree_changed: false,
        created_stash_id: None,
        target_stash_id,
        applied: false,
        dropped: false,
        stash_retained: false,
        conflicts: Vec::new(),
        warnings: Vec::new(),
        errors: Vec::new(),
        message: message.into(),
    }
}

fn operation_result(
    stored: StoredStashOperationResult,
    snapshot: Option<RepoStashSnapshot>,
    snapshot_error: Option<String>,
) -> StashOperationResult {
    let needs_confirmation = stored.needs_confirmation || snapshot_error.is_some();
    let status = if needs_confirmation
        && matches!(stored.status.as_str(), "complete" | "acknowledged")
    {
        "needs_confirmation".to_string()
    } else {
        stored.status
    };

    StashOperationResult {
        operation: stored.operation,
        request_id: stored.request_id,
        status,
        mutated: stored.mutated,
        needs_confirmation,
        worktree_changed: stored.worktree_changed,
        created_stash_id: stored.created_stash_id,
        target_stash_id: stored.target_stash_id,
        applied: stored.applied,
        dropped: stored.dropped,
        stash_retained: stored.stash_retained,
        conflicts: stored.conflicts,
        warnings: stored.warnings,
        errors: stored.errors,
        snapshot,
        snapshot_error,
        message: stored.message,
    }
}

fn new_stash_journal(
    request_id: String,
    signature: StashOperationSignature,
    snapshot: &RepoStashSnapshot,
) -> StashOperationJournal {
    let timestamp = now_ms();
    StashOperationJournal {
        version: STASH_JOURNAL_VERSION,
        request_id,
        origin_repo_root: stash_worktree_origin(&snapshot.repo_path),
        completion_validated: false,
        signature,
        phase: "prepared".to_string(),
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
        before_snapshot_id: snapshot.snapshot_id.clone(),
        before_worktree_id: snapshot.worktree_id.clone(),
        before_stash_ids: snapshot
            .all_stashes
            .iter()
            .map(|entry| entry.id.clone())
            .collect(),
        command_success: None,
        command_error: None,
        result: None,
    }
}

fn recorded_pop_result(
    journal: &StashOperationJournal,
    current: &RepoStashSnapshot,
    before_ids: &HashSet<String>,
    current_ids: &HashSet<String>,
    target: &Option<String>,
    target_present: bool,
    worktree_changed: bool,
) -> Option<StoredStashOperationResult> {
    if journal.signature.operation != "pop" {
        return None;
    }
    let recorded = journal.result.as_ref()?;
    if !recorded.applied {
        return None;
    }

    let mut result = recorded.clone();
    result.mutated = true;
    result.worktree_changed = worktree_changed;
    result.stash_retained = target_present;

    if current.conflicted_files > 0 {
        result.status = "conflict".to_string();
        result.needs_confirmation = false;
        result.dropped = false;
        result.conflicts = current.conflict_paths.clone();
        result.message =
            "已确认 Pop 的应用阶段完成，但当前工作区存在冲突；原 Stash 保留。"
                .to_string();
        return Some(result);
    }

    if target_present {
        result.status = "partial".to_string();
        result.needs_confirmation = false;
        result.dropped = false;
        result.message =
            "已确认 Stash 内容应用完成，但原稳定条目仍存在；不会再次 Apply。"
                .to_string();
        return Some(result);
    }

    let mut expected = before_ids.clone();
    if let Some(target_id) = target {
        expected.remove(target_id);
    }
    result.dropped = true;
    result.stash_retained = false;
    if &expected == current_ids {
        result.status = "complete".to_string();
        result.needs_confirmation = false;
        result.message = "已确认 Pop 的应用和精确条目删除均已完成。".to_string();
    } else {
        result.status = "needs_confirmation".to_string();
        result.needs_confirmation = true;
        result.message =
            "目标 Stash 已不存在，但列表还发生其他变化；应用已确认，删除结果需要复核。"
                .to_string();
    }
    Some(result)
}

fn derive_interrupted_result(
    journal: &StashOperationJournal,
    current: &RepoStashSnapshot,
) -> StoredStashOperationResult {
    let operation = journal.signature.operation.as_str();
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
    let target = journal.signature.target_stash_id.clone();
    let target_present = target
        .as_ref()
        .map(|value| current_ids.contains(value))
        .unwrap_or(false);
    let worktree_changed = current.worktree_id != journal.before_worktree_id;

    if let Some(result) = recorded_pop_result(
        journal,
        current,
        &before_ids,
        &current_ids,
        &target,
        target_present,
        worktree_changed,
    ) {
        return result;
    }

    let mut result = stored_result(
        operation,
        &journal.request_id,
        "needs_confirmation",
        target.clone(),
        "原操作被中断，当前只按真实仓库状态对账，不会重复执行。",
    );
    result.needs_confirmation = true;
    result.worktree_changed = worktree_changed;
    result.mutated = worktree_changed || current.snapshot_id != journal.before_snapshot_id;
    result.stash_retained = target_present;

    match operation {
        "create" if new_ids.len() == 1 => {
            result.status = "complete".to_string();
            result.needs_confirmation = false;
            result.mutated = true;
            result.created_stash_id = new_ids.first().cloned();
            result.message = "已通过稳定条目标识确认原 Stash 创建完成。".to_string();
        }
        "create" if new_ids.len() > 1 => {
            result.message = "操作中断后出现多个新 Stash，无法把其中任意一条冒认为本次结果。".to_string();
        }
        "apply" if current.conflicted_files > 0 => {
            result.status = "conflict".to_string();
            result.mutated = true;
            result.conflicts = current.conflict_paths.clone();
            result.message = "Stash 恢复产生冲突；工作区与原 Stash 均保持当前真实状态。".to_string();
        }
        "apply" if worktree_changed => {
            result.message = "工作区已经变化，但无法证明原 Apply 是否完整完成；原 Stash 不会被删除。".to_string();
        }
        "pop" if current.conflicted_files > 0 => {
            result.status = "conflict".to_string();
            result.mutated = true;
            result.conflicts = current.conflict_paths.clone();
            result.message = "Pop 恢复产生冲突；原 Stash 保留，不会继续删除。".to_string();
        }
        "pop" if worktree_changed && target_present => {
            result.status = "partial".to_string();
            result.message = "工作区已经变化，但原 Stash 仍存在；不能再次盲目应用。".to_string();
        }
        "pop" if worktree_changed && !target_present => {
            result.dropped = true;
            result.message = "工作区已变化且原 Stash 已不存在，但响应中断使完整结果仍需确认。".to_string();
        }
        "drop" if !target_present => {
            let mut expected = before_ids.clone();
            if let Some(target_id) = target.as_ref() {
                expected.remove(target_id);
            }
            result.mutated = true;
            result.dropped = true;
            if expected == current_ids {
                result.status = "complete".to_string();
                result.needs_confirmation = false;
                result.message = "已确认目标 Stash 不再存在。".to_string();
            } else {
                result.message =
                    "目标 Stash 已不存在，但列表还发生其他变化；删除结果需要复核。"
                        .to_string();
            }
        }
        _ => {}
    }
    result
}

async fn settle_stash_journal(
    repo_root: &str,
    journal_path: &Path,
    journal: &mut StashOperationJournal,
    mut result: StoredStashOperationResult,
) -> Result<StashOperationResult, String> {
    journal.phase = "settled".to_string();
    journal.completion_validated = false;
    journal.result = Some(result.clone());

    if let Err(error) = persist_stash_journal(journal_path, journal) {
        result.needs_confirmation = true;
        if result.status == "complete" {
            result.status = "needs_confirmation".to_string();
        }
        result.errors.push(format!(
            "Git 状态已经发生变化，但最终 Stash 操作记录无法持久化：{}。请立即按真实仓库状态确认结果。",
            error
        ));
        result.message =
            "Git 操作可能已经完成，但最终结果记录失败；不会猜测成功，也不会自动重试。"
                .to_string();
        return match read_stash_snapshot(repo_root).await {
            Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
            Err(snapshot_error) => Ok(operation_result(result, None, Some(snapshot_error))),
        };
    }

    match read_stash_snapshot(repo_root).await {
        Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
        Err(error) => Ok(operation_result(result, None, Some(error))),
    }
}

async fn reconcile_stash_journal(
    repo_root: &str,
    journal_path: &Path,
    journal: &mut StashOperationJournal,
) -> Result<StashOperationResult, String> {
    ensure_stash_journal_origin(&journal.origin_repo_root, repo_root, false)?;
    if journal.phase == "settled" {
        if let Some(result) = journal.result.clone() {
            return match read_stash_snapshot(repo_root).await {
                Ok(snapshot) => Ok(operation_result(result, Some(snapshot), None)),
                Err(error) => Ok(operation_result(result, None, Some(error))),
            };
        }
    }

    let current = match read_stash_snapshot_core(repo_root).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let mut result = stored_result(
                &journal.signature.operation,
                &journal.request_id,
                "needs_confirmation",
                journal.signature.target_stash_id.clone(),
                "原 Stash 操作需要确认，但当前仓库状态读取失败。",
            );
            result.needs_confirmation = true;
            result.errors.push(error.clone());
            return settle_stash_journal(repo_root, journal_path, journal, result).await;
        }
    };
    let result = derive_interrupted_result(journal, &current);
    settle_stash_journal(repo_root, journal_path, journal, result).await
}
