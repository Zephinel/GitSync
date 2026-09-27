fn option(
    id: &str,
    kind: &str,
    label: String,
    full_ref: String,
    commit: String,
    branch_name: String,
    remote_name: Option<String>,
    recommended: bool,
) -> BranchCreationSourceOption {
    BranchCreationSourceOption {
        id: id.to_string(),
        kind: kind.to_string(),
        label,
        full_ref,
        commit,
        branch_name,
        remote_name,
        recommended,
    }
}

fn stable_fingerprint(parts: &[&str]) -> String {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
        0xff_u8.hash(&mut hasher);
    }
    format!("branch-create-v1-{:016x}", hasher.finish())
}

/// Reads only the already-cached local refs and worktree state.
async fn inspect_locked(
    repo_path: &str,
    source: &BranchCreationSourceRequest,
) -> Result<BranchCreationInspection, String> {
    let remotes = get_remote_names(repo_path).await?;
    let raw_name = source.name.trim();
    if raw_name.is_empty() {
        return Err("来源分支不能为空".to_string());
    }

    let requested_kind = source.kind.trim().to_ascii_lowercase();
    let local_ref_candidate = format!("refs/heads/{}", raw_name);
    let local_exists = ref_exists(repo_path, local_ref_candidate.as_str()).await?;
    let source_is_local = match requested_kind.as_str() {
        "local" => true,
        "remote" => false,
        _ => local_exists,
    };

    let (current_branch, status) = tokio::try_join!(
        current_branch(repo_path),
        read_worktree_status(repo_path)
    )?;
    let (worktree_dirty, changed_path_count, status_signature) = status;
    let detached_head = current_branch.is_none();
    let source_display_name = source
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(raw_name)
        .to_string();

    if source_is_local {
        if !local_exists {
            return Err(format!("本地来源分支不存在: {}", raw_name));
        }
        let local_ref = local_ref_candidate;
        let local_commit = resolve_ref(repo_path, local_ref.as_str())
            .await?
            .ok_or_else(|| format!("无法读取本地来源分支提交: {}", raw_name))?;
        let upstream = read_upstream(repo_path, raw_name).await?;
        let mut relationship = "local-only".to_string();
        let mut remote_name = None;
        let mut remote_branch = None;
        let mut remote_ref = None;
        let mut remote_commit = None;
        let mut ahead = 0;
        let mut behind = 0;
        let mut warnings = Vec::new();
        let mut source_options = Vec::new();
        let mut default_source_option_id = Some("local".to_string());

        if let Some(upstream_ref) = upstream.as_deref() {
            if let Some((remote, branch)) = parse_remote_ref(upstream_ref, &remotes) {
                remote_name = Some(remote.to_string());
                remote_branch = Some(branch.clone());
                let full_remote_ref = format!("refs/remotes/{}/{}", remote, branch);
                remote_ref = Some(full_remote_ref.clone());

                remote_commit = resolve_ref(repo_path, full_remote_ref.as_str()).await?;
                if let Some(remote_hash) = remote_commit.as_deref() {
                    (ahead, behind) =
                        compare_refs(repo_path, local_ref.as_str(), full_remote_ref.as_str()).await?;
                    relationship = match (ahead > 0, behind > 0) {
                        (false, false) => "synced",
                        (false, true) => "behind",
                        (true, false) => "ahead",
                        (true, true) => "diverged",
                    }
                    .to_string();

                    if relationship == "synced" {
                        source_options.push(option(
                            "local",
                            "local",
                            format!("本地 {}（与 {} 一致）", raw_name, upstream_ref),
                            local_ref.clone(),
                            local_commit.clone(),
                            raw_name.to_string(),
                            None,
                            true,
                        ));
                    } else {
                        source_options.push(option(
                            "local",
                            "local",
                            format!("本地 {}", raw_name),
                            local_ref.clone(),
                            local_commit.clone(),
                            raw_name.to_string(),
                            None,
                            relationship == "ahead",
                        ));
                        source_options.push(option(
                            "remote",
                            "remote",
                            format!("远端最新 {}", upstream_ref),
                            full_remote_ref.clone(),
                            remote_hash.to_string(),
                            branch.clone(),
                            Some(remote.to_string()),
                            relationship == "behind",
                        ));
                    }
                    default_source_option_id = match relationship.as_str() {
                        "behind" => Some("remote".to_string()),
                        "ahead" | "synced" => Some("local".to_string()),
                        "diverged" => None,
                        _ => Some("local".to_string()),
                    };
                } else {
                    relationship = "upstream-gone".to_string();
                    warnings.push(format!(
                        "原远端目标 {} 已不存在；本次只能基于本地 {} 创建，不会恢复或重新创建原远端分支。",
                        upstream_ref, raw_name
                    ));
                    source_options.push(option(
                        "local",
                        "local",
                        format!("本地 {}（原 upstream 已消失）", raw_name),
                        local_ref.clone(),
                        local_commit.clone(),
                        raw_name.to_string(),
                        None,
                        true,
                    ));
                }
            } else {
                relationship = "upstream-gone".to_string();
                warnings.push(format!(
                    "原 upstream {} 已无法对应当前远端配置；本次只能基于本地 {} 创建，不会恢复远端配置或重新创建原远端分支。",
                    upstream_ref, raw_name
                ));
                source_options.push(option(
                    "local",
                    "local",
                    format!("本地 {}（原 upstream 已不可用）", raw_name),
                    local_ref.clone(),
                    local_commit.clone(),
                    raw_name.to_string(),
                    None,
                    true,
                ));
            }
        } else {
            source_options.push(option(
                "local",
                "local",
                format!("本地 {}", raw_name),
                local_ref.clone(),
                local_commit.clone(),
                raw_name.to_string(),
                None,
                true,
            ));
        }

        let upstream_ref = upstream.clone();
        let preferred = remote_name
            .clone()
            .or_else(|| remotes.iter().find(|remote| remote.as_str() == "origin").cloned())
            .or_else(|| remotes.first().cloned());
        let ahead_text = ahead.to_string();
        let behind_text = behind.to_string();
        let fingerprint = stable_fingerprint(&[
            source_display_name.as_str(),
            "local",
            relationship.as_str(),
            local_ref.as_str(),
            local_commit.as_str(),
            upstream_ref.as_deref().unwrap_or(""),
            remote_ref.as_deref().unwrap_or(""),
            remote_commit.as_deref().unwrap_or(""),
            ahead_text.as_str(),
            behind_text.as_str(),
            current_branch.as_deref().unwrap_or("DETACHED"),
            status_signature.as_str(),
        ]);

        Ok(BranchCreationInspection {
            source_display_name,
            source_kind: "local".to_string(),
            relationship: relationship.clone(),
            local_name: Some(raw_name.to_string()),
            local_ref: Some(local_ref),
            local_commit: Some(local_commit),
            upstream_ref,
            remote_name,
            remote_branch,
            remote_ref,
            remote_commit,
            ahead,
            behind,
            source_options,
            default_source_option_id,
            requires_source_choice: relationship == "diverged",
            warnings,
            current_branch,
            detached_head,
            worktree_dirty,
            changed_path_count,
            remotes,
            preferred_remote: preferred,
            fingerprint,
        })
    } else {
        let (remote, branch) = parse_remote_ref(raw_name, &remotes)
            .ok_or_else(|| format!("远端来源分支名称无效或远端未配置: {}", raw_name))?;
        let full_remote_ref = format!("refs/remotes/{}/{}", remote, branch);
        let remote_commit = resolve_ref(repo_path, full_remote_ref.as_str())
            .await?
            .ok_or_else(|| format!("远端来源分支不存在: {}/{}", remote, branch))?;
        let source_options = vec![option(
            "remote",
            "remote",
            format!("远端最新 {}/{}", remote, branch),
            full_remote_ref.clone(),
            remote_commit.clone(),
            branch.clone(),
            Some(remote.to_string()),
            true,
        )];
        let fingerprint = stable_fingerprint(&[
            source_display_name.as_str(),
            "remote",
            "remote-only",
            full_remote_ref.as_str(),
            remote_commit.as_str(),
            current_branch.as_deref().unwrap_or("DETACHED"),
            status_signature.as_str(),
        ]);

        Ok(BranchCreationInspection {
            source_display_name,
            source_kind: "remote".to_string(),
            relationship: "remote-only".to_string(),
            local_name: None,
            local_ref: None,
            local_commit: None,
            upstream_ref: None,
            remote_name: Some(remote.to_string()),
            remote_branch: Some(branch.clone()),
            remote_ref: Some(full_remote_ref),
            remote_commit: Some(remote_commit),
            ahead: 0,
            behind: 0,
            source_options,
            default_source_option_id: Some("remote".to_string()),
            requires_source_choice: false,
            warnings: Vec::new(),
            current_branch,
            detached_head,
            worktree_dirty,
            changed_path_count,
            remotes: remotes.clone(),
            preferred_remote: Some(remote.to_string()),
            fingerprint,
        })
    }
}

/// Refreshes the one remote relevant to the requested source, then performs the
/// pure cached-ref inspection. Callers must hold the restart-blocking mutation
/// guard because `git fetch` updates remote-tracking refs and `FETCH_HEAD`.
async fn inspect_with_remote_refresh_locked(
    repo_path: &str,
    source: &BranchCreationSourceRequest,
) -> Result<BranchCreationInspection, String> {
    let remotes = get_remote_names(repo_path).await?;
    let raw_name = source.name.trim();
    if raw_name.is_empty() {
        return Err("来源分支不能为空".to_string());
    }

    let requested_kind = source.kind.trim().to_ascii_lowercase();
    let local_ref_candidate = format!("refs/heads/{}", raw_name);
    let local_exists = ref_exists(repo_path, local_ref_candidate.as_str()).await?;
    let source_is_local = match requested_kind.as_str() {
        "local" => true,
        "remote" => false,
        _ => local_exists,
    };

    if source_is_local {
        if !local_exists {
            return Err(format!("本地来源分支不存在: {}", raw_name));
        }
        if let Some(upstream) = read_upstream(repo_path, raw_name).await? {
            if let Some((remote, _)) = parse_remote_ref(upstream.as_str(), &remotes) {
                fetch_remote(repo_path, remote).await?;
            }
        }
    } else {
        let (remote, branch) = parse_remote_ref(raw_name, &remotes)
            .ok_or_else(|| format!("远端来源分支名称无效或远端未配置: {}", raw_name))?;
        fetch_remote_branch(repo_path, remote, branch.as_str()).await?;
    }

    inspect_locked(repo_path, source).await
}

fn validate_branch_name_shape(name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name.is_empty() {
        errors.push("分支名称不能为空。".to_string());
        return errors;
    }
    if name.chars().count() > MAX_BRANCH_NAME_CHARS || name.len() > MAX_BRANCH_NAME_BYTES {
        errors.push(format!(
            "分支名称过长；最多 {} 个字符且不超过 {} 字节。",
            MAX_BRANCH_NAME_CHARS, MAX_BRANCH_NAME_BYTES
        ));
    }
    if name == "HEAD" {
        errors.push("分支名称不能是 HEAD。".to_string());
    }
    errors
}

async fn ls_remote_branch(
    repo_path: &str,
    remote: &str,
    branch: &str,
) -> Result<Option<String>, String> {
    let full_ref = format!("refs/heads/{}", branch);
    let output = run_git_output(
        repo_path,
        &["ls-remote", "--heads", remote, full_ref.as_str()],
        GIT_FETCH_TIMEOUT_MS,
    )
    .await?;
    if !output.success {
        return Err(format!(
            "无法确认远端 {} 上是否已有同名分支，请检查网络或权限后重试。",
            remote
        ));
    }
    let hash = output
        .stdout
        .lines()
        .find_map(|line| line.split_whitespace().next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(hash)
}

async fn validate_name_locked(
    repo_path: &str,
    request: &BranchNameValidationRequest,
) -> Result<BranchNameValidationResult, String> {
    let normalized_name = request.name.trim().to_string();
    let mut errors = validate_branch_name_shape(normalized_name.as_str());
    let mut warnings = Vec::new();

    if errors.is_empty() {
        let output = run_git_output(
            repo_path,
            &["check-ref-format", "--branch", normalized_name.as_str()],
            GIT_META_TIMEOUT_MS,
        )
        .await?;
        if !output.success {
            errors.push("分支名称不符合 Git 引用格式。".to_string());
        }
    }

    let local_ref = format!("refs/heads/{}", normalized_name);
    let local_exists = if normalized_name.is_empty() {
        false
    } else {
        ref_exists(repo_path, local_ref.as_str()).await?
    };
    if local_exists {
        errors.push(format!("本地已经存在同名分支 {}，不会覆盖。", normalized_name));
    }

    let remotes = get_remote_names(repo_path).await?;
    let mut remote_exists = false;
    let mut remote_checked = false;
    let target_remote = request
        .remote
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if request.publish {
        let remote = target_remote.ok_or_else(|| "发布到远端时必须选择目标远端。".to_string())?;
        if !remotes.iter().any(|candidate| candidate == remote) {
            errors.push(format!("目标远端不存在: {}", remote));
        } else if errors.is_empty() {
            remote_checked = true;
            remote_exists = ls_remote_branch(repo_path, remote, normalized_name.as_str())
                .await?
                .is_some();
            if remote_exists {
                errors.push(format!(
                    "远端 {}/{} 已存在；创建流程不会覆盖、接管或强制更新该分支。",
                    remote, normalized_name
                ));
            }
        }
    } else if let Some(remote) = target_remote {
        if remotes.iter().any(|candidate| candidate == remote) {
            let cached_ref = format!("refs/remotes/{}/{}", remote, normalized_name);
            remote_exists = ref_exists(repo_path, cached_ref.as_str()).await?;
            if remote_exists {
                warnings.push(format!(
                    "缓存显示远端 {}/{} 已存在；本次未开启发布，因此仍可只创建本地分支。",
                    remote, normalized_name
                ));
            }
        }
    }

    Ok(BranchNameValidationResult {
        valid: errors.is_empty(),
        normalized_name,
        errors,
        warnings,
        local_exists,
        remote_exists,
        remote_checked,
    })
}

fn validate_request_id(value: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_ .".contains(character))
    {
        return Err("创建请求 ID 无效。".to_string());
    }
    Ok(normalized.to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

async fn git_common_dir(repo_path: &str) -> Result<PathBuf, String> {
    let raw = run_git(repo_path, &["rev-parse", "--git-common-dir"], GIT_META_TIMEOUT_MS).await?;
    let path = PathBuf::from(raw.trim());
    let absolute = if path.is_absolute() {
        path
    } else {
        Path::new(repo_path).join(path)
    };
    Ok(absolute)
}

async fn journal_path(repo_path: &str, request_id: &str) -> Result<PathBuf, String> {
    let directory = git_common_dir(repo_path).await?.join(OPERATION_DIRECTORY);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建分支操作记录目录: {}", error))?;
    Ok(directory.join(format!("{}.json", request_id)))
}

fn journal_sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("operation.json");
    path.with_file_name(format!("{}.{}", file_name, suffix))
}

fn persist_journal(path: &Path, journal: &mut BranchCreationJournal) -> Result<(), String> {
    journal.updated_at_ms = now_ms();
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("无法序列化分支创建记录: {}", error))?;
    let tmp = journal_sibling_path(path, "tmp");
    #[cfg(target_os = "windows")]
    let backup = journal_sibling_path(path, "bak");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|error| format!("无法写入分支创建记录: {}", error))?;
    file.write_all(&bytes)
        .map_err(|error| format!("无法写入分支创建记录: {}", error))?;
    file.sync_all()
        .map_err(|error| format!("无法同步分支创建记录: {}", error))?;
    drop(file);

    #[cfg(target_os = "windows")]
    {
        let had_previous = path.exists();
        if had_previous {
            if backup.exists() {
                fs::remove_file(&backup)
                    .map_err(|error| format!("无法清理旧分支创建记录备份: {}", error))?;
            }
            fs::rename(path, &backup)
                .map_err(|error| format!("无法备份旧分支创建记录: {}", error))?;
        }
        if let Err(error) = fs::rename(&tmp, path) {
            if had_previous {
                let _ = fs::rename(&backup, path);
            }
            return Err(format!("无法提交分支创建记录: {}", error));
        }
    }

    #[cfg(not(target_os = "windows"))]
    fs::rename(&tmp, path)
        .map_err(|error| format!("无法提交分支创建记录: {}", error))?;

    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }

    #[cfg(target_os = "windows")]
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn parse_journal_file(path: &Path) -> Result<BranchCreationJournal, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取分支创建记录: {}", error))?;
    let journal: BranchCreationJournal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("分支创建记录损坏: {}", error))?;
    if journal.version != JOURNAL_VERSION {
        return Err("分支创建记录版本不受支持。".to_string());
    }
    Ok(journal)
}

fn load_journal(path: &Path) -> Result<Option<BranchCreationJournal>, String> {
    let backup = journal_sibling_path(path, "bak");
    let candidates = [path, backup.as_path()];
    let mut failures = Vec::new();
    let mut found = false;

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        found = true;
        match parse_journal_file(candidate) {
            Ok(journal) => return Ok(Some(journal)),
            Err(error) => failures.push(error),
        }
    }

    if !found {
        return Ok(None);
    }
    Err(format!(
        "分支创建记录损坏，不能盲目重试: {}",
        failures.join("；")
    ))
}

fn signature_from_request(request: &BranchCreationExecuteRequest) -> BranchCreationOperationSignature {
    BranchCreationOperationSignature {
        source: request.source.clone(),
        source_option_id: request.source_option_id.trim().to_string(),
        source_ref: request.source_ref.trim().to_string(),
        source_commit: request.source_commit.trim().to_string(),
        branch_name: request.branch_name.trim().to_string(),
        switch_after_create: request.switch_after_create,
        publish: request.publish,
        target_remote: request
            .target_remote
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

fn new_journal(
    request_id: String,
    signature: BranchCreationOperationSignature,
    worktree_was_dirty: bool,
) -> BranchCreationJournal {
    let timestamp = now_ms();
    BranchCreationJournal {
        version: JOURNAL_VERSION,
        request_id,
        signature,
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
        worktree_was_dirty,
        local_state: "pending".to_string(),
        switch_state: if worktree_was_dirty {
            "pending-dirty".to_string()
        } else {
            "pending".to_string()
        },
        remote_state: "pending".to_string(),
        tracking_state: "pending".to_string(),
        warnings: Vec::new(),
        errors: Vec::new(),
    }
}
