async fn hash_snapshot_file(
    repo_path: &str,
    snapshot: &Path,
    logical_path: Option<&str>,
) -> Result<String, String> {
    let snapshot_path = snapshot.to_string_lossy().to_string();
    let mut args = vec!["hash-object".to_string(), "-w".to_string()];
    if let Some(path) = logical_path {
        args.push(format!("--path={}", path));
    } else {
        args.push("--no-filters".to_string());
    }
    args.push(snapshot_path);
    let output = run_git_mutation_bytes(repo_path, &args).await?;
    let oid = String::from_utf8(output)
        .map_err(|_| "git hash-object 返回了非 UTF-8 object id。".to_string())?;
    parse_git_oid(&oid, "git hash-object")
}

async fn capture_regular_file(
    repo_path: &str,
    logical_path: &str,
    absolute: &Path,
    metadata: &std::fs::Metadata,
) -> Result<(String, MutationWorktreeState), String> {
    let snapshot = snapshot_temp_path("file");
    tokio::fs::copy(absolute, &snapshot)
        .await
        .map_err(|error| format!("复制 immutable worktree snapshot 失败（{}）: {}", logical_path, error))?;
    let raw_oid_result = hash_snapshot_file(repo_path, &snapshot, None).await;
    let staged_oid_result = hash_snapshot_file(repo_path, &snapshot, Some(logical_path)).await;
    let _ = tokio::fs::remove_file(&snapshot).await;
    let raw_oid = raw_oid_result?;
    let staged_oid = staged_oid_result?;
    let authority_mode = metadata_mode(metadata);
    let worktree_id = format!("worktree-v1:file:{}:{}", authority_mode, raw_oid);
    Ok((
        worktree_id,
        MutationWorktreeState::File {
            authority_mode,
            git_mode: regular_git_mode(metadata),
            raw_oid,
            staged_oid,
        },
    ))
}

async fn capture_symlink(
    repo_path: &str,
    logical_path: &str,
    absolute: &Path,
    metadata: &std::fs::Metadata,
) -> Result<(String, MutationWorktreeState), String> {
    let target = tokio::fs::read_link(absolute)
        .await
        .map_err(|error| format!("读取符号链接 immutable snapshot 失败（{}）: {}", logical_path, error))?;
    let target_bytes = symlink_target_bytes(target.as_os_str())?;
    let snapshot = snapshot_temp_path("symlink");
    tokio::fs::write(&snapshot, target_bytes)
        .await
        .map_err(|error| format!("写入符号链接 immutable blob 失败（{}）: {}", logical_path, error))?;
    let raw_oid_result = hash_snapshot_file(repo_path, &snapshot, None).await;
    let _ = tokio::fs::remove_file(&snapshot).await;
    let raw_oid = raw_oid_result?;
    let authority_mode = metadata_mode(metadata);
    let worktree_id = format!(
        "worktree-v1:symlink:{}:{}",
        authority_mode,
        os_str_bytes_identity(target.as_os_str())
    );
    Ok((
        worktree_id,
        MutationWorktreeState::Symlink {
            authority_mode,
            raw_oid,
        },
    ))
}
