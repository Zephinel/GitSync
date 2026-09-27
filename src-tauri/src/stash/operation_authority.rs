const STASH_OPERATION_AUTHORITY_WAIT_TIMEOUT_MS: u64 = GIT_STASH_OPERATION_TIMEOUT_MS * 4;
const STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE: &str = "STASH_AUTHORITY_ADMISSION_TIMEOUT";

static STASH_OPERATION_LOCKS: std::sync::OnceLock<
    AsyncMutex<HashMap<String, std::sync::Weak<AsyncMutex<()>>>>,
> = std::sync::OnceLock::new();

struct StashOperationAuthorityGuard {
    _process_guard: OwnedMutexGuard<()>,
    _cross_process_file: File,
}

impl Drop for StashOperationAuthorityGuard {
    fn drop(&mut self) {
        // Release the OS lock before dropping the process-local mutex guard.
        // Explicit unlock makes the critical-section boundary independent of
        // the later file and process-mutex field drops.
        let _ = self._cross_process_file.unlock();
    }
}

async fn stash_operation_authority_identity(
    repo_root: &str,
) -> Result<(String, PathBuf), String> {
    // Git Stash refs and journals belong to the Git common directory, not an
    // individual linked worktree. Canonicalizing the common directory makes
    // both the in-process key and the cross-process lock file converge on the
    // same authority for every linked worktree.
    let common_dir = resolve_git_common_dir(repo_root).await?;
    let common_dir = fs::canonicalize(&common_dir).unwrap_or(common_dir);
    let common_key = common_dir.to_string_lossy().to_string();
    let key = normalize_repo_lock_key(&common_key);
    let lock_path = common_dir
        .join("gitsync")
        .join("stash-operation-authority.lock");
    Ok((key, lock_path))
}

async fn acquire_cross_process_stash_lock(lock_path: &Path) -> Result<File, String> {
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Stash 操作锁目录: {}", error))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| format!("无法打开 Stash 操作锁文件: {}", error))?;

    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                // try_lock is non-blocking. The enclosing authority acquisition
                // owns the deadline so process-local and cross-process waiting
                // share one bounded liveness policy.
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(format!("无法获取 Stash 跨进程操作锁: {}", error));
            }
        }
    }
}

async fn acquire_stash_operation_authority(
    repo_root: &str,
) -> Result<StashOperationAuthorityGuard, String> {
    let (key, lock_path) = stash_operation_authority_identity(repo_root).await?;
    let locks = STASH_OPERATION_LOCKS.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let lock = {
        let mut entries = locks.lock().await;
        entries.retain(|_, value| value.strong_count() > 0);
        if let Some(existing) = entries.get(&key).and_then(std::sync::Weak::upgrade) {
            existing
        } else {
            let created = Arc::new(AsyncMutex::new(()));
            entries.insert(key, Arc::downgrade(&created));
            created
        }
    };

    let acquisition = async {
        let process_guard = lock.lock_owned().await;
        let cross_process_file = acquire_cross_process_stash_lock(&lock_path).await?;
        Ok::<_, String>((process_guard, cross_process_file))
    };
    let (process_guard, cross_process_file) = tokio::time::timeout(
        Duration::from_millis(STASH_OPERATION_AUTHORITY_WAIT_TIMEOUT_MS),
        acquisition,
    )
    .await
    .map_err(|_| {
        format!(
            "[{}] 等待 Stash authority 超过 {} 秒；另一 GitSync 进程或任务可能仍持有该仓库的 Stash 临界区。本次 Stash 请求未进入 Git 读写临界区。",
            STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE,
            STASH_OPERATION_AUTHORITY_WAIT_TIMEOUT_MS / 1_000
        )
    })??;

    Ok(StashOperationAuthorityGuard {
        _process_guard: process_guard,
        _cross_process_file: cross_process_file,
    })
}

#[derive(Debug, Clone)]
struct UnresolvedStashAuthority {
    request_id: String,
    operation: String,
    target_stash_id: Option<String>,
    origin_repo_path: Option<String>,
    status: String,
    message: String,
    applied: bool,
    needs_confirmation: bool,
    updated_at_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StashJournalFamily {
    Regular,
    Selected,
}

fn journal_origin_projection(origin_repo_root: &str) -> Option<String> {
    let origin = origin_repo_root.trim();
    (!origin.is_empty()).then(|| origin.to_string())
}

fn stash_result_is_terminal(
    phase: &str,
    result: Option<&StoredStashOperationResult>,
    completion_validated: bool,
) -> bool {
    phase == "settled"
        && result.is_some_and(|value| {
            stash_result_is_durable_terminal(value, completion_validated)
        })
}

fn canonical_journal_path(path: &Path) -> Option<PathBuf> {
    let file_name = path.file_name()?.to_str()?;
    if file_name.ends_with(".json") {
        return Some(path.to_path_buf());
    }
    if file_name.ends_with(".json.bak") {
        return Some(path.with_file_name(file_name.trim_end_matches(".bak")));
    }
    None
}

fn journal_base_paths(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut paths = HashSet::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("无法读取 Stash 操作证据目录: {}", error))?
    {
        let entry = entry.map_err(|error| format!("无法读取 Stash 操作证据: {}", error))?;
        if let Some(path) = canonical_journal_path(&entry.path()) {
            paths.insert(path);
        }
    }
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn parse_selected_stash_journal_authoritative(
    path: &Path,
) -> Result<SelectedStashOperationJournal, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("无法读取文件级 Stash 操作记录: {}", error))?;
    let journal: SelectedStashOperationJournal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("文件级 Stash 操作记录损坏: {}", error))?;
    if journal.version != SELECTED_STASH_JOURNAL_VERSION {
        return Err("文件级 Stash 操作记录版本不受支持。".to_string());
    }
    validate_selected_stash_journal(path, &journal)?;
    Ok(journal)
}

fn load_selected_stash_journal_authoritative(
    path: &Path,
) -> Result<Option<SelectedStashOperationJournal>, String> {
    let backup = journal_sibling_path(path, "bak");
    let candidates = [path, backup.as_path()];
    let mut found = false;
    let mut failures = Vec::new();

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        found = true;
        match parse_selected_stash_journal_authoritative(candidate) {
            Ok(journal) => return Ok(Some(journal)),
            Err(error) => failures.push(error),
        }
    }

    if !found {
        return Ok(None);
    }
    Err(format!(
        "文件级 Stash 操作记录损坏，不能盲目重试: {}",
        failures.join("；")
    ))
}

async fn stash_request_journal_family(
    repo_root: &str,
    request_id: &str,
) -> Result<Option<StashJournalFamily>, String> {
    // Request-family lookup is read-only. It must not prune the very journal
    // that an explicit retry/reconcile/acknowledgement is trying to resolve.
    let regular_path = stash_journal_directory(repo_root)
        .await?
        .join(format!("{}.json", request_id));
    let selected_path = selected_stash_journal_directory(repo_root)
        .await?
        .join(format!("{}.json", request_id));
    let regular_exists = load_stash_journal(&regular_path)?.is_some();
    let selected_exists = load_selected_stash_journal_authoritative(&selected_path)?.is_some();

    match (regular_exists, selected_exists) {
        (true, true) => Err(format!(
            "Stash 请求 ID {} 同时存在于普通和文件级操作记录；无法安全确认请求归属。",
            request_id
        )),
        (true, false) => Ok(Some(StashJournalFamily::Regular)),
        (false, true) => Ok(Some(StashJournalFamily::Selected)),
        (false, false) => Ok(None),
    }
}

async fn ensure_stash_request_family(
    repo_root: &str,
    request_id: &str,
    expected: StashJournalFamily,
) -> Result<(), String> {
    if let Some(actual) = stash_request_journal_family(repo_root, request_id).await? {
        if actual != expected {
            return Err(format!(
                "Stash 请求 ID {} 已由另一类操作记录占用；为避免跨操作串线，本次操作未开始。",
                request_id
            ));
        }
    }
    Ok(())
}

fn claim_journal_request_id(request_ids: &mut HashSet<String>, request_id: &str) -> Result<(), String> {
    if request_ids.insert(request_id.to_string()) {
        return Ok(());
    }
    Err(format!(
        "Stash 操作证据存在重复请求 ID {}；无法安全判断操作归属。",
        request_id
    ))
}

fn unvalidated_completion_projection(
    result: Option<&StoredStashOperationResult>,
    completion_validated: bool,
) -> bool {
    result.is_some_and(|value| {
        value.status == "complete" && !value.needs_confirmation && !completion_validated
    })
}

async fn collect_unresolved_stash_authorities(
    repo_root: &str,
) -> Result<Vec<UnresolvedStashAuthority>, String> {
    let mut unresolved = Vec::new();
    let mut request_ids = HashSet::new();

    let regular_directory = stash_journal_directory(repo_root).await?;
    for path in journal_base_paths(&regular_directory)? {
        let Some(journal) = load_stash_journal(&path)? else {
            continue;
        };
        claim_journal_request_id(&mut request_ids, &journal.request_id)?;
        if !stash_result_is_terminal(
            journal.phase.as_str(),
            journal.result.as_ref(),
            journal.completion_validated,
        ) {
            let result = journal.result.as_ref();
            let completion_unvalidated =
                unvalidated_completion_projection(result, journal.completion_validated);
            unresolved.push(UnresolvedStashAuthority {
                request_id: journal.request_id,
                operation: journal.signature.operation,
                target_stash_id: journal.signature.target_stash_id,
                origin_repo_path: journal_origin_projection(&journal.origin_repo_root),
                status: if completion_unvalidated {
                    "needs_confirmation".to_string()
                } else {
                    result
                        .map(|value| value.status.clone())
                        .unwrap_or_else(|| "needs_confirmation".to_string())
                },
                message: if completion_unvalidated {
                    "Stash 操作已记录为 complete，但 authoritative completion proof 尚未持久化；必须先对账确认。"
                        .to_string()
                } else {
                    result
                        .map(|value| value.message.clone())
                        .unwrap_or_else(|| {
                            "原 Stash 操作未留下可确认终态，请先确认真实仓库状态。"
                                .to_string()
                        })
                },
                applied: result.is_some_and(|value| value.applied),
                needs_confirmation: completion_unvalidated
                    || result
                        .map(|value| value.needs_confirmation)
                        .unwrap_or(true),
                updated_at_ms: journal.updated_at_ms,
            });
        }
    }

    let selected_directory = selected_stash_journal_directory(repo_root).await?;
    for path in journal_base_paths(&selected_directory)? {
        let Some(journal) = load_selected_stash_journal_authoritative(&path)? else {
            continue;
        };
        claim_journal_request_id(&mut request_ids, &journal.request_id)?;
        if !stash_result_is_terminal(
            journal.phase.as_str(),
            journal.result.as_ref(),
            journal.completion_validated,
        ) {
            let result = journal.result.as_ref();
            let completion_unvalidated =
                unvalidated_completion_projection(result, journal.completion_validated);
            unresolved.push(UnresolvedStashAuthority {
                request_id: journal.request_id,
                operation: "create_selected".to_string(),
                target_stash_id: None,
                origin_repo_path: journal_origin_projection(&journal.origin_repo_root),
                status: if completion_unvalidated {
                    "needs_confirmation".to_string()
                } else {
                    result
                        .map(|value| value.status.clone())
                        .unwrap_or_else(|| "needs_confirmation".to_string())
                },
                message: if completion_unvalidated {
                    "文件级 Stash 已记录为 complete，但 authoritative completion proof 尚未持久化；必须先对账确认。"
                        .to_string()
                } else {
                    result
                        .map(|value| value.message.clone())
                        .unwrap_or_else(|| {
                            "文件级 Stash 操作未留下可确认终态，请先确认真实仓库状态。"
                                .to_string()
                        })
                },
                applied: false,
                needs_confirmation: completion_unvalidated
                    || result
                        .map(|value| value.needs_confirmation)
                        .unwrap_or(true),
                updated_at_ms: journal.updated_at_ms,
            });
        }
    }

    unresolved.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    Ok(unresolved)
}

async fn unresolved_stash_authorities_protecting(
    repo_root: &str,
    protected_request_id: Option<&str>,
) -> Result<Vec<UnresolvedStashAuthority>, String> {
    let _ = prune_settled_stash_journals_except(repo_root, protected_request_id).await;
    collect_unresolved_stash_authorities(repo_root).await
}

async fn unresolved_stash_authorities(
    repo_root: &str,
) -> Result<Vec<UnresolvedStashAuthority>, String> {
    unresolved_stash_authorities_protecting(repo_root, None).await
}

fn project_pending_stash_operations(
    unresolved: Vec<UnresolvedStashAuthority>,
) -> Vec<PendingStashOperation> {
    unresolved
        .into_iter()
        .take(20)
        .map(|operation| PendingStashOperation {
            request_id: operation.request_id,
            operation: operation.operation,
            target_stash_id: operation.target_stash_id,
            origin_repo_path: operation.origin_repo_path,
            status: operation.status,
            message: operation.message,
            updated_at_ms: operation.updated_at_ms,
        })
        .collect()
}

async fn ensure_stash_evidence_readable_for_request(
    repo_root: &str,
    request_id: &str,
) -> Result<(), String> {
    let _ = unresolved_stash_authorities_protecting(repo_root, Some(request_id)).await?;
    Ok(())
}

fn pending_origin_matches_repo(
    pending: &UnresolvedStashAuthority,
    repo_root: &str,
) -> bool {
    pending
        .origin_repo_path
        .as_deref()
        .is_some_and(|origin| origin == stash_worktree_origin(repo_root))
}

fn is_safe_partial_pop_drop(
    pending: &UnresolvedStashAuthority,
    proposed_operation: &str,
    proposed_target_stash_id: Option<&str>,
    repo_root: &str,
) -> bool {
    proposed_operation == "drop"
        && pending.operation == "pop"
        && pending.status == "partial"
        && pending.applied
        && !pending.needs_confirmation
        && pending.target_stash_id.as_deref() == proposed_target_stash_id
        && pending_origin_matches_repo(pending, repo_root)
}

async fn ensure_stash_operation_policy(
    repo_root: &str,
    request_id: &str,
    proposed_operation: &str,
    proposed_target_stash_id: Option<&str>,
) -> Result<(), String> {
    let unresolved = unresolved_stash_authorities(repo_root).await?;
    if let Some(operation) = unresolved.iter().find(|operation| {
        operation.request_id != request_id
            && !is_safe_partial_pop_drop(
                operation,
                proposed_operation,
                proposed_target_stash_id,
                repo_root,
            )
    }) {
        let origin = operation
            .origin_repo_path
            .as_deref()
            .map(|path| format!("，来源 worktree {}", path))
            .unwrap_or_else(|| "，旧记录缺少来源 worktree 身份".to_string());
        return Err(format!(
            "存在尚未确认的 Stash 操作（{}，请求 {}{}）。请先在原 worktree 的 Stash 管理中确认真实结果；为避免重复保存、重复应用或误删，本次操作未开始。",
            operation.operation, operation.request_id, origin
        ));
    }
    Ok(())
}

async fn ensure_no_other_unresolved_stash_operation(
    repo_root: &str,
    request_id: &str,
) -> Result<(), String> {
    ensure_stash_operation_policy(repo_root, request_id, "unknown", None).await
}
