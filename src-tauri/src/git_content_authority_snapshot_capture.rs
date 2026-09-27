async fn capture_worktree_snapshot(
    repo_path: &str,
    path: &str,
) -> Result<(String, MutationWorktreeState), String> {
    let absolute = Path::new(repo_path).join(path);
    let metadata = match tokio::fs::symlink_metadata(&absolute).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok((
                "worktree-v1:missing".to_string(),
                MutationWorktreeState::Missing,
            ));
        }
        Err(error) => {
            return Err(format!("读取 immutable worktree 元数据失败（{}）: {}", path, error));
        }
    };
    let authority_mode = metadata_mode(&metadata);
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return capture_symlink(repo_path, path, &absolute, &metadata).await;
    }
    if file_type.is_file() {
        return capture_regular_file(repo_path, path, &absolute, &metadata).await;
    }
    if file_type.is_dir() {
        let head = directory_head(repo_path, path).await?;
        return match head {
            Some(oid) => Ok((
                format!("worktree-v1:directory:{}:{}", authority_mode, oid),
                MutationWorktreeState::Gitlink {
                    authority_mode,
                    oid: parse_git_oid(&oid, "Gitlink HEAD")?,
                },
            )),
            None => Ok((
                format!("worktree-v1:directory:{}:no-git-head", authority_mode),
                MutationWorktreeState::Directory { authority_mode },
            )),
        };
    }
    Ok((
        format!("worktree-v1:special:{}:{}", authority_mode, metadata.len()),
        MutationWorktreeState::Special {
            authority_mode,
            len: metadata.len(),
        },
    ))
}

pub async fn capture_mutation_entry_snapshots(
    repo_path: &str,
    entries: &[(String, Option<String>)],
) -> Result<Vec<MutationEntrySnapshot>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let mut unique = BTreeMap::<String, ()>::new();
    for (path, old_path) in entries {
        unique.insert(path.clone(), ());
        if let Some(old_path) = old_path {
            unique.insert(old_path.clone(), ());
        }
    }
    let paths = unique.into_keys().collect::<Vec<_>>();
    let index = capture_index_snapshots(repo_path, &paths).await?;
    let mut path_snapshots = HashMap::with_capacity(paths.len());

    for path in paths {
        let (index_id, index_entries) = index
            .get(&path)
            .cloned()
            .ok_or_else(|| format!("缺少 immutable index snapshot: {}", path))?;
        let (worktree_id, worktree) = capture_worktree_snapshot(repo_path, &path).await?;
        path_snapshots.insert(
            path.clone(),
            MutationPathSnapshot {
                path,
                index_entries,
                index_id,
                worktree_id,
                worktree,
            },
        );
    }

    entries
        .iter()
        .map(|(path, old_path)| {
            let current = path_snapshots
                .get(path)
                .cloned()
                .ok_or_else(|| format!("缺少当前路径 immutable snapshot: {}", path))?;
            let old = old_path
                .as_ref()
                .map(|old_path| {
                    path_snapshots
                        .get(old_path)
                        .cloned()
                        .ok_or_else(|| format!("缺少旧路径 immutable snapshot: {}", old_path))
                })
                .transpose()?;
            let current_authority = PathContentAuthority {
                index_id: current.index_id.clone(),
                worktree_id: current.worktree_id.clone(),
            };
            let old_authority = old.as_ref().map(|old| PathContentAuthority {
                index_id: old.index_id.clone(),
                worktree_id: old.worktree_id.clone(),
            });
            Ok(MutationEntrySnapshot {
                path: path.clone(),
                old_path: old_path.clone(),
                authority_id: encode_entry_content_authority(
                    &current_authority,
                    old_authority.as_ref(),
                ),
                current,
                old,
            })
        })
        .collect()
}
