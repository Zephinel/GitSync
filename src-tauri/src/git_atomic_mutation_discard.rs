#[cfg(unix)]
fn authority_metadata_mode(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!("{:o}", metadata.permissions().mode())
}

#[cfg(not(unix))]
fn authority_metadata_mode(metadata: &std::fs::Metadata) -> String {
    format!("readonly={}", metadata.permissions().readonly())
}

async fn recovery_matches_state(
    repo_path: &str,
    recovery: &Path,
    expected: &MutationWorktreeState,
) -> Result<bool, String> {
    let metadata = tokio::fs::symlink_metadata(recovery)
        .await
        .map_err(|error| format!("读取 discard recovery preimage 失败: {}", error))?;
    match expected {
        MutationWorktreeState::File {
            authority_mode,
            raw_oid,
            ..
        } => {
            if !metadata.file_type().is_file() || authority_metadata_mode(&metadata) != *authority_mode {
                return Ok(false);
            }
            let oid = run_git_text(
                repo_path,
                &[
                    "hash-object".to_string(),
                    "--no-filters".to_string(),
                    recovery.to_string_lossy().to_string(),
                ],
                &[],
                None,
            )
            .await?;
            Ok(parse_oid(&oid, "discard recovery hash")? == *raw_oid)
        }
        MutationWorktreeState::Symlink {
            authority_mode,
            raw_oid,
        } => {
            if !metadata.file_type().is_symlink() || authority_metadata_mode(&metadata) != *authority_mode {
                return Ok(false);
            }
            let target = tokio::fs::read_link(recovery)
                .await
                .map_err(|error| format!("读取 recovery symlink 失败: {}", error))?;
            #[cfg(unix)]
            let target_bytes = {
                use std::os::unix::ffi::OsStrExt;
                target.as_os_str().as_bytes().to_vec()
            };
            #[cfg(target_os = "windows")]
            let target_bytes = target
                .to_str()
                .map(|value| value.as_bytes().to_vec())
                .ok_or_else(|| "Windows recovery symlink target 无法转换为 Git blob。".to_string())?;
            #[cfg(not(any(unix, target_os = "windows")))]
            let target_bytes = target
                .to_str()
                .map(|value| value.as_bytes().to_vec())
                .ok_or_else(|| "Recovery symlink target 无法转换为 Git blob。".to_string())?;
            let oid = run_git_text(
                repo_path,
                &["hash-object".to_string(), "--stdin".to_string()],
                &[],
                Some(&target_bytes),
            )
            .await?;
            Ok(parse_oid(&oid, "discard recovery symlink hash")? == *raw_oid)
        }
        MutationWorktreeState::Missing => Ok(false),
        MutationWorktreeState::Gitlink { .. }
        | MutationWorktreeState::Directory { .. }
        | MutationWorktreeState::Special { .. } => Ok(false),
    }
}

async fn recovery_dir(repo_path: &str) -> Result<PathBuf, String> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let dir = git_dir.join("gitsync").join("discard-recovery");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("创建 discard recovery 目录失败: {}", error))?;
    Ok(dir)
}

async fn claim_worktree_preimage(
    repo_path: &str,
    path: &MutationPathSnapshot,
) -> Result<Option<PathBuf>, String> {
    match &path.worktree {
        MutationWorktreeState::Missing => return Ok(None),
        state if !state.is_claimable_discard_preimage() => {
            return Err(format!(
                "Discard 不会对无法原子 recovery 的 worktree 类型执行不可逆覆盖: {}",
                path.path
            ));
        }
        _ => {}
    }
    let original = Path::new(repo_path).join(&path.path);
    let root = recovery_dir(repo_path).await?;
    let recovery = unique_temp_path(&root, "preimage");
    tokio::fs::rename(&original, &recovery)
        .await
        .map_err(|error| {
            format!(
                "无法原子 claim Discard preimage（可能跨文件系统或已被外部修改）{}: {}",
                path.path, error
            )
        })?;
    let metadata = serde_json::json!({
        "originalPath": path.path,
        "createdAtNanos": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_string(),
    });
    let sidecar = PathBuf::from(format!("{}.json", recovery.to_string_lossy()));
    if let Ok(bytes) = serde_json::to_vec_pretty(&metadata) {
        let _ = tokio::fs::write(sidecar, bytes).await;
    }
    if !recovery_matches_state(repo_path, &recovery, &path.worktree).await? {
        let _ = restore_recovery_no_clobber(&recovery, &original).await;
        return Err(format!(
            "Discard preimage 在原子 claim 时已不是用户确认的内容；外部内容已保留: {}",
            path.path
        ));
    }
    Ok(Some(recovery))
}

async fn restore_recovery_no_clobber(recovery: &Path, original: &Path) -> Result<bool, String> {
    if tokio::fs::symlink_metadata(original).await.is_ok() {
        return Ok(false);
    }
    let metadata = tokio::fs::symlink_metadata(recovery)
        .await
        .map_err(|error| format!("读取 recovery restore 元数据失败: {}", error))?;
    if metadata.file_type().is_file() {
        match tokio::fs::hard_link(recovery, original).await {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(format!("恢复 recovery hard-link 失败: {}", error)),
        }
    } else if metadata.file_type().is_symlink() {
        let target = tokio::fs::read_link(recovery)
            .await
            .map_err(|error| format!("读取 recovery symlink target 失败: {}", error))?;
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&target, original);
        #[cfg(target_os = "windows")]
        let result = std::os::windows::fs::symlink_file(&target, original);
        #[cfg(not(any(unix, target_os = "windows")))]
        let result: std::io::Result<()> = Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "symlink recovery unsupported",
        ));
        match result {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(format!("恢复 recovery symlink 失败: {}", error)),
        }
    } else {
        Err("Recovery preimage 不是可安全恢复的 file/symlink。".to_string())
    }
}

async fn replace_materialized_path(temp: &Path, original: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        tokio::fs::rename(temp, original)
            .await
            .map_err(|error| format!("HEAD restore replace 失败: {}", error))
    }
    #[cfg(not(unix))]
    {
        match tokio::fs::symlink_metadata(original).await {
            Ok(metadata) if metadata.file_type().is_dir() => {
                return Err("HEAD restore 不会递归替换目录。".to_string());
            }
            Ok(_) => tokio::fs::remove_file(original)
                .await
                .map_err(|error| format!("移除待替换的 worktree 路径失败: {}", error))?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("检查待替换的 worktree 路径失败: {}", error));
            }
        }
        tokio::fs::rename(temp, original)
            .await
            .map_err(|error| format!("HEAD restore replace 失败: {}", error))
    }
}

async fn remove_discard_target(original: &Path, logical_path: &str) -> Result<(), String> {
    match tokio::fs::symlink_metadata(original).await {
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            tokio::fs::remove_file(original)
                .await
                .map_err(|error| format!("Discard 删除 {} 的 worktree 内容失败: {}", logical_path, error))
        }
        Ok(_) => Err(format!(
            "Discard 不会递归删除外部目录或特殊路径: {}",
            logical_path
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Discard 检查 {} 的 worktree 内容失败: {}",
            logical_path, error
        )),
    }
}

async fn materialize_blob(
    repo_path: &str,
    logical_path: &str,
    original: &Path,
    entry: &MutationIndexEntry,
    overwrite_existing: bool,
) -> Result<bool, String> {
    if entry.mode == "160000" {
        return Err("Discard 对 submodule/gitlink worktree 不执行自动覆盖；请手动处理。".to_string());
    }
    // Symlink blobs are raw link targets. Regular files must go through Git's
    // checkout filters so atomic Discard preserves normal `git restore` semantics
    // for .gitattributes / clean-smudge filters.
    let bytes = if entry.mode == "120000" {
        run_git_bytes(
            repo_path,
            &["cat-file".to_string(), "blob".to_string(), entry.oid.clone()],
            &[],
            None,
        )
        .await?
    } else {
        run_git_bytes(
            repo_path,
            &[
                "cat-file".to_string(),
                "--filters".to_string(),
                format!("--path={}", logical_path),
                entry.oid.clone(),
            ],
            &[],
            None,
        )
        .await?
    };
    if entry.mode == "120000" {
        #[cfg(unix)]
        let target = {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            OsString::from_vec(bytes)
        };
        #[cfg(target_os = "windows")]
        let target = std::ffi::OsString::from(
            String::from_utf8(bytes)
                .map_err(|_| "Windows HEAD symlink blob 不是 UTF-8。".to_string())?,
        );
        #[cfg(not(any(unix, target_os = "windows")))]
        let target = std::ffi::OsString::from(
            String::from_utf8(bytes)
                .map_err(|_| "HEAD symlink blob 不是 UTF-8。".to_string())?,
        );
        if overwrite_existing {
            let parent = original
                .parent()
                .ok_or_else(|| "Discard target 缺少 parent directory。".to_string())?;
            let temp = unique_temp_path(parent, "restore");
            #[cfg(unix)]
            let result = std::os::unix::fs::symlink(PathBuf::from(target.clone()), &temp);
            #[cfg(target_os = "windows")]
            let result = std::os::windows::fs::symlink_file(PathBuf::from(target.clone()), &temp);
            #[cfg(not(any(unix, target_os = "windows")))]
            let result: std::io::Result<()> = Err(std::io::Error::new(
                ErrorKind::Unsupported,
                "symlink install unsupported",
            ));
            result.map_err(|error| format!("创建 HEAD restore symlink 失败: {}", error))?;
            let replaced = replace_materialized_path(&temp, original).await.map(|()| true);
            let _ = tokio::fs::remove_file(&temp).await;
            return replaced;
        }

        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(PathBuf::from(target), original);
        #[cfg(target_os = "windows")]
        let result = std::os::windows::fs::symlink_file(PathBuf::from(target), original);
        #[cfg(not(any(unix, target_os = "windows")))]
        let result: std::io::Result<()> = Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "symlink install unsupported",
        ));
        return match result {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(format!("安装 HEAD symlink 失败: {}", error)),
        };
    }
    if entry.mode != "100644" && entry.mode != "100755" {
        return Err(format!("Discard 不支持自动 materialize Git mode {}。", entry.mode));
    }
    let parent = original
        .parent()
        .ok_or_else(|| "Discard target 缺少 parent directory。".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("创建 Discard parent directory 失败: {}", error))?;
    let temp = unique_temp_path(parent, "restore");
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(&temp)
        .await
        .map_err(|error| format!("创建 HEAD restore temp file 失败: {}", error))?;
    file.write_all(&bytes)
        .await
        .map_err(|error| format!("写入 HEAD restore temp file 失败: {}", error))?;
    file.sync_all().await.ok();
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if entry.mode == "100755" { 0o755 } else { 0o644 };
        let _ = tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode)).await;
    }
    let linked = if overwrite_existing {
        replace_materialized_path(&temp, original).await.map(|()| true)
    } else {
        match tokio::fs::hard_link(&temp, original).await {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(format!("HEAD restore no-clobber hard-link 失败: {}", error)),
        }
    };
    let _ = tokio::fs::remove_file(&temp).await;
    linked
}

async fn materialize_blob_no_clobber(
    repo_path: &str,
    logical_path: &str,
    original: &Path,
    entry: &MutationIndexEntry,
) -> Result<bool, String> {
    materialize_blob(repo_path, logical_path, original, entry, false).await
}

async fn materialize_blob_overwrite(
    repo_path: &str,
    logical_path: &str,
    original: &Path,
    entry: &MutationIndexEntry,
) -> Result<(), String> {
    materialize_blob(repo_path, logical_path, original, entry, true)
        .await
        .map(|_| ())
}

async fn discard_verified_entry_inner(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
    before_claim: Option<&(dyn Fn() + Send + Sync)>,
    after_claim: Option<&(dyn Fn() + Send + Sync)>,
) -> Result<AtomicDiscardResult, String> {
    let snapshots = capture_expected_snapshots(
        repo_path,
        &[(
            path.to_string(),
            old_path.map(str::to_string),
            expected_authority_id.to_string(),
        )],
    )
    .await?;
    let snapshot = snapshots
        .first()
        .ok_or_else(|| "Discard immutable snapshot 缺失。".to_string())?;
    for path_snapshot in snapshot_paths(snapshot) {
        if !matches!(
            path_snapshot.worktree,
            MutationWorktreeState::Missing
                | MutationWorktreeState::File { .. }
                | MutationWorktreeState::Symlink { .. }
        ) {
            return Err(format!(
                "Discard 不会自动覆盖无法原子 recovery 的路径类型: {}",
                path_snapshot.path
            ));
        }
    }
    let paths = selected_paths(&snapshots);
    let desired_index = read_tree_index_states(repo_path, expected_head, &paths).await?;
    for (path, entry) in &desired_index {
        if let Some(entry) = entry {
            if !matches!(entry.mode.as_str(), "100644" | "100755" | "120000") {
                return Err(format!(
                    "Discard HEAD target mode 无法自动 materialize（{}）: {}",
                    entry.mode, path
                ));
            }
        }
    }

    if let Some(hook) = before_claim {
        hook();
    }

    let mut claims = Vec::<(PathBuf, PathBuf)>::new();
    for path_snapshot in snapshot_paths(snapshot) {
        match claim_worktree_preimage(repo_path, path_snapshot).await {
            Ok(Some(recovery)) => claims.push((
                Path::new(repo_path).join(&path_snapshot.path),
                recovery,
            )),
            Ok(None) => {}
            Err(error) => {
                for (original, recovery) in &claims {
                    let _ = restore_recovery_no_clobber(recovery, original).await;
                }
                return Err(error);
            }
        }
    }

    if let Some(hook) = after_claim {
        hook();
    }

    let old_index = snapshot_index_map(&snapshots)?;
    let index_patch = build_index_patch(repo_path, &old_index, &desired_index).await?;
    if let Err(error) = apply_index_patch(repo_path, &index_patch, &[]).await {
        for (original, recovery) in &claims {
            let _ = restore_recovery_no_clobber(recovery, original).await;
        }
        return Err(format!(
            "Discard conditional index mutation 被外部 index 变化拒绝；preimage 已保留: {}",
            error
        ));
    }

    // Full Discard has explicit user authority: once the confirmed preimage
    // has been claimed, HEAD wins over any later worktree replacement.
    for path in &paths {
        let original = Path::new(repo_path).join(path);
        match desired_index.get(path).cloned().flatten() {
            None => {
                remove_discard_target(&original, path).await?;
            }
            Some(entry) => materialize_blob_overwrite(repo_path, path, &original, &entry)
                .await
                .map_err(|error| {
                    format!(
                        "Discard index 已条件更新，但 worktree HEAD restore 未完成；preimage 保留在 recovery: {}",
                        error
                    )
                })?,
        }
    }

    Ok(AtomicDiscardResult {
        recovery_paths: claims
            .into_iter()
            .map(|(_, recovery)| recovery.to_string_lossy().to_string())
            .collect(),
        external_change_preserved: false,
    })
}

pub async fn discard_verified_entry(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
) -> Result<AtomicDiscardResult, String> {
    discard_verified_entry_inner(
        repo_path,
        path,
        old_path,
        expected_authority_id,
        expected_head,
        None,
        None,
    )
    .await
}

async fn resolve_index_path(repo_path: &str) -> Result<PathBuf, String> {
    let value = run_git_text(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--git-path".to_string(),
            "index".to_string(),
        ],
        &[],
        None,
    )
    .await?;
    let value = value.trim();
    if value.is_empty() {
        return Err("无法解析 Git index 路径".to_string());
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        Path::new(repo_path).join(path)
    })
}

/*
 * Holds the real Git index write lock (<index>.lock) for the whole
 * verify-then-materialize critical section. Git index writers fail while the
 * lock exists, so an external `git add` / `git reset` cannot insert between the
 * captured-index comparison and the worktree materialize. The lock path is
 * resolved through `git rev-parse --git-path index`, which is correct for the
 * repository root as well as linked worktrees.
 */
struct IndexLockGuard {
    lock_path: PathBuf,
}

impl IndexLockGuard {
    async fn acquire(repo_path: &str) -> Result<Self, String> {
        let index_path = resolve_index_path(repo_path).await?;
        let lock_path = PathBuf::from(format!("{}.lock", index_path.to_string_lossy()));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        options.open(&lock_path).await.map_err(|error| {
            format!(
                "无法获取 Git index 写锁（{}）: {}；外部 Git 操作可能正在进行，mutation 未开始。",
                lock_path.display(),
                error
            )
        })?;
        Ok(Self { lock_path })
    }
}

impl Drop for IndexLockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

async fn read_current_index_states(
    repo_path: &str,
    paths: &[String],
) -> Result<IndexStateMap, String> {
    let mut result = paths
        .iter()
        .cloned()
        .map(|path| (path, None))
        .collect::<IndexStateMap>();
    if paths.is_empty() {
        return Ok(result);
    }
    let mut args = vec![
        "ls-files".to_string(),
        "--stage".to_string(),
        "-z".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| literal_pathspec(path)));
    let bytes = run_git_bytes(repo_path, &args, &[], None).await?;
    let text = crate::git_encoding::decode_git_stdout(
        bytes,
        "worktree discard index verification",
    )?;
    for record in text.split('\0').filter(|record| !record.is_empty()) {
        let (metadata, path) = record
            .split_once('\t')
            .ok_or_else(|| "git ls-files 返回了无法解析的记录。".to_string())?;
        let mut fields = metadata.split_whitespace();
        let mode = fields
            .next()
            .ok_or_else(|| "git ls-files 缺少 mode。".to_string())?
            .to_string();
        let oid = fields
            .next()
            .ok_or_else(|| "git ls-files 缺少 object id。".to_string())?
            .trim()
            .to_ascii_lowercase();
        let stage = fields
            .next()
            .ok_or_else(|| "git ls-files 缺少 stage。".to_string())?
            .parse::<u8>()
            .map_err(|_| "git ls-files stage 无法解析。".to_string())?;
        if !result.contains_key(path) {
            return Err(format!("git ls-files 返回了未请求路径: {}", path));
        }
        result.insert(
            path.to_string(),
            Some(MutationIndexEntry {
                mode,
                oid,
                stage,
            }),
        );
    }
    Ok(result)
}

async fn discard_worktree_verified_entry_inner(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    before_claim: Option<&(dyn Fn() + Send + Sync)>,
    after_index_verification: Option<&(dyn Fn() + Send + Sync)>,
) -> Result<AtomicDiscardResult, String> {
    let snapshots = capture_expected_snapshots(
        repo_path,
        &[(
            path.to_string(),
            old_path.map(str::to_string),
            expected_authority_id.to_string(),
        )],
    )
    .await?;
    let snapshot = snapshots
        .first()
        .ok_or_else(|| "Discard worktree immutable snapshot 缺失。".to_string())?;
    for path_snapshot in snapshot_paths(snapshot) {
        if !matches!(
            path_snapshot.worktree,
            MutationWorktreeState::Missing
                | MutationWorktreeState::File { .. }
                | MutationWorktreeState::Symlink { .. }
        ) {
            return Err(format!(
                "Discard 不会自动覆盖无法原子 recovery 的路径类型: {}",
                path_snapshot.path
            ));
        }
    }
    let paths = selected_paths(&snapshots);
    // Worktree-only discard restores the worktree to the current index content,
    // which is exactly the “staged layer”. The index itself is never mutated.
    let desired_worktree = snapshot_index_map(&snapshots)?;

    if let Some(hook) = before_claim {
        hook();
    }

    let mut claims = Vec::<(PathBuf, PathBuf)>::new();
    for path_snapshot in snapshot_paths(snapshot) {
        match claim_worktree_preimage(repo_path, path_snapshot).await {
            Ok(Some(recovery)) => claims.push((
                Path::new(repo_path).join(&path_snapshot.path),
                recovery,
            )),
            Ok(None) => {}
            Err(error) => {
                for (original, recovery) in &claims {
                    let _ = restore_recovery_no_clobber(recovery, original).await;
                }
                return Err(error);
            }
        }
    }

    let _index_lock = match IndexLockGuard::acquire(repo_path).await {
        Ok(guard) => guard,
        Err(error) => {
            for (original, recovery) in &claims {
                let _ = restore_recovery_no_clobber(recovery, original).await;
            }
            return Err(error);
        }
    };

    let current_index = match read_current_index_states(repo_path, &paths).await {
        Ok(states) => states,
        Err(error) => {
            for (original, recovery) in &claims {
                let _ = restore_recovery_no_clobber(recovery, original).await;
            }
            return Err(error);
        }
    };
    if current_index != desired_worktree {
        for (original, recovery) in &claims {
            let _ = restore_recovery_no_clobber(recovery, original).await;
        }
        return Err(format!(
            "Discard worktree 的外部 index 已变化；preimage 已原位恢复，mutation 未开始: {}",
            path
        ));
    }

    if let Some(hook) = after_index_verification {
        hook();
    }

    let mut external_change_preserved = false;
    for path in &paths {
        let original = Path::new(repo_path).join(path);
        match desired_worktree.get(path).cloned().flatten() {
            None => {
                if tokio::fs::symlink_metadata(&original).await.is_ok() {
                    external_change_preserved = true;
                }
            }
            Some(entry) => match materialize_blob_no_clobber(repo_path, path, &original, &entry).await {
                Ok(true) => {}
                Ok(false) => external_change_preserved = true,
                Err(error) => {
                    return Err(format!(
                        "Discard worktree index restore 未完成；preimage 保留在 recovery: {}",
                        error
                    ));
                }
            },
        }
    }

    Ok(AtomicDiscardResult {
        recovery_paths: claims
            .into_iter()
            .map(|(_, recovery)| recovery.to_string_lossy().to_string())
            .collect(),
        external_change_preserved,
    })
}

pub async fn discard_worktree_verified_entry(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
) -> Result<AtomicDiscardResult, String> {
    discard_worktree_verified_entry_inner(
        repo_path,
        path,
        old_path,
        expected_authority_id,
        None,
        None,
    )
    .await
}
