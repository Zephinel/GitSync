fn normalize_stash_scope_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value == "." || value.contains('\0') {
        return Err("Stash 文件路径无效。".to_string());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("Stash 文件路径越出仓库范围: {}", value));
    }
    Ok(value.to_string())
}

fn normalize_stash_scope_targets(
    values: &[StashPathTarget],
) -> Result<Vec<StashPathTarget>, String> {
    let mut by_path = std::collections::BTreeMap::new();
    for value in values {
        let path = normalize_stash_scope_path(&value.path)?;
        let old_path = value
            .old_path
            .as_deref()
            .map(normalize_stash_scope_path)
            .transpose()?;
        let target = StashPathTarget {
            path: path.clone(),
            old_path,
        };
        if let Some(previous) = by_path.insert(path.clone(), target.clone()) {
            if previous != target {
                return Err(format!("同一 Stash 文件路径出现了冲突身份: {}", path));
            }
        }
    }
    Ok(by_path.into_values().collect())
}

async fn read_stash_worktree_files(repo_root: &str) -> Result<Vec<StashWorktreeFile>, String> {
    read_stash_worktree_files_streamed(repo_root).await
}

fn top_literal_pathspec(path: &str) -> String {
    format!(":(top,literal){}", path)
}

fn top_literal_exclude_pathspec(path: &str) -> String {
    format!(":(top,literal,exclude){}", path)
}

fn scope_identity_paths_from_targets(targets: &[StashPathTarget]) -> Vec<String> {
    let mut paths = std::collections::BTreeSet::new();
    for target in targets {
        paths.insert(target.path.clone());
        if let Some(old_path) = target.old_path.as_ref() {
            paths.insert(old_path.clone());
        }
    }
    paths.into_iter().collect()
}

fn scope_identity_paths_from_files(files: &[StashWorktreeFile]) -> Vec<String> {
    let mut paths = std::collections::BTreeSet::new();
    for file in files {
        paths.insert(file.path.clone());
        if let Some(old_path) = file.old_path.as_ref() {
            paths.insert(old_path.clone());
        }
    }
    paths.into_iter().collect()
}

fn worktree_status_args_with_pathspecs(pathspecs: Vec<String>) -> Vec<String> {
    let mut args = STASH_WORKTREE_STATUS_ARGS
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    if !pathspecs.is_empty() {
        args.push("--".to_string());
        args.extend(pathspecs);
    }
    args
}

async fn read_stash_worktree_files_for_paths(
    repo_root: &str,
    paths: &[String],
) -> Result<Vec<StashWorktreeFile>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let args = worktree_status_args_with_pathspecs(
        paths.iter().map(|path| top_literal_pathspec(path)).collect(),
    );
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut parser = WorktreeStatusStreamParser::new(true);
    run_git_nul_fields(
        repo_root,
        &borrowed,
        GIT_STASH_STATUS_TIMEOUT_MS,
        |field| parser.push_field(field),
    )
    .await?;
    let (_, files) = parser.finish()?;
    Ok(files)
}

async fn read_stash_worktree_files_for_targets(
    repo_root: &str,
    targets: &[StashPathTarget],
) -> Result<Vec<StashWorktreeFile>, String> {
    read_stash_worktree_files_for_paths(repo_root, &scope_identity_paths_from_targets(targets)).await
}

async fn read_stash_worktree_files_for_selected(
    repo_root: &str,
    selected: &[StashWorktreeFile],
) -> Result<Vec<StashWorktreeFile>, String> {
    read_stash_worktree_files_for_paths(repo_root, &scope_identity_paths_from_files(selected)).await
}

async fn hash_unselected_stash_worktree_status(
    repo_root: &str,
    selected: &[StashWorktreeFile],
) -> Result<String, String> {
    let paths = scope_identity_paths_from_files(selected);
    if paths.is_empty() {
        return Err("无法为文件级 Stash 计算空 selected scope 的未选范围 digest。".to_string());
    }
    let args = worktree_status_args_with_pathspecs(
        paths
            .iter()
            .map(|path| top_literal_exclude_pathspec(path))
            .collect(),
    );
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    hash_git_command_stdout(repo_root, &borrowed, GIT_STASH_DIGEST_TIMEOUT_MS).await
}

fn resolve_selected_scope(
    files: &[StashWorktreeFile],
    targets: &[StashPathTarget],
    _include_untracked: bool,
    keep_index: bool,
) -> Result<Vec<StashWorktreeFile>, String> {
    let mut selected = Vec::with_capacity(targets.len());
    for target in targets {
        let matches = files
            .iter()
            .filter(|file| file.path == target.path)
            .collect::<Vec<_>>();
        if matches.is_empty() {
            return Err(format!(
                "所选文件状态已经变化或文件不再存在: {}",
                target.path
            ));
        }
        if matches.len() > 1 {
            return Err(format!(
                "所选路径同时存在多种 Git 身份（常见于已暂存删除与未跟踪副本并存），请先处理暂存区后刷新: {}",
                target.path
            ));
        }
        let file = matches[0];
        if file.old_path != target.old_path {
            return Err(format!("所选文件的重命名身份已经变化: {}", target.path));
        }
        if file.is_conflicted {
            return Err(format!("所选文件仍存在未解决冲突: {}", target.path));
        }
        selected.push(file.clone());
    }

    if selected.is_empty() {
        return Err("没有选择可保存的文件。".to_string());
    }
    if keep_index
        && !selected
            .iter()
            .any(|file| file.has_unstaged_changes || file.is_untracked)
    {
        return Err("所选文件只有已暂存修改；保留暂存区时没有可保存内容。".to_string());
    }
    Ok(selected)
}

async fn git_path_is_known(repo_root: &str, path: &str) -> bool {
    let literal_path = top_literal_pathspec(path);
    let index = run_git_output(
        repo_root,
        &[
            "ls-files",
            "--error-unmatch",
            "--",
            literal_path.as_str(),
        ],
        GIT_STASH_META_TIMEOUT_MS,
    )
    .await
    .map(|output| output.success)
    .unwrap_or(false);
    if index {
        return true;
    }
    let object = format!("HEAD:{}", path);
    run_git_output(
        repo_root,
        &["cat-file", "-e", object.as_str()],
        GIT_STASH_META_TIMEOUT_MS,
    )
    .await
    .map(|output| output.success)
    .unwrap_or(false)
}

fn unsupported_selected_pathspec_state(file: &StashWorktreeFile) -> Option<String> {
    match file.code.chars().next().unwrap_or(' ') {
        'D' => Some(format!(
            "文件已在暂存区标记为删除，Git 无法安全地按该单一路径创建文件级 Stash。请改用“Stash 全部改动”，或先取消暂存后重试: {}",
            file.path
        )),
        'R' => Some(format!(
            "文件已在暂存区标记为重命名，Git 的文件级 Stash 无法同时完整保存新旧路径。请改用“Stash 全部改动”，或先取消暂存后重试: {}",
            file.path
        )),
        _ => None,
    }
}

async fn validate_selected_scope_git_identity(
    repo_root: &str,
    selected: &[StashWorktreeFile],
) -> Result<(), String> {
    for file in selected {
        if let Some(error) = unsupported_selected_pathspec_state(file) {
            return Err(error);
        }
        if file.is_untracked {
            continue;
        }
        let current_known = git_path_is_known(repo_root, &file.path).await;
        let old_known = match file.old_path.as_deref() {
            Some(old_path) => git_path_is_known(repo_root, old_path).await,
            None => false,
        };
        if !current_known && !old_known {
            return Err(format!(
                "所选文件已不再由当前 Index 或 HEAD 识别，请刷新未提交改动后重新选择: {}",
                file.path
            ));
        }
    }
    Ok(())
}

fn literal_stash_pathspec(path: &str) -> String {
    format!(":(literal){}", path)
}

fn selected_scope_pathspecs(files: &[StashWorktreeFile]) -> Vec<String> {
    let mut values = std::collections::BTreeSet::new();
    for file in files {
        values.insert(literal_stash_pathspec(&file.path));
        if let Some(old_path) = file.old_path.as_deref() {
            values.insert(literal_stash_pathspec(old_path));
        }
    }
    values.into_iter().collect()
}

fn worktree_file_map(
    files: &[StashWorktreeFile],
    excluded_paths: &HashSet<String>,
) -> HashMap<String, StashWorktreeFile> {
    files
        .iter()
        .filter(|file| {
            !excluded_paths.contains(&file.path)
                && file
                    .old_path
                    .as_ref()
                    .map(|path| !excluded_paths.contains(path))
                    .unwrap_or(true)
        })
        .map(|file| (format!("{}:{}", file.code, file.path), file.clone()))
        .collect()
}

fn selected_residual_matches(
    after_files: &[StashWorktreeFile],
    selected: &[StashWorktreeFile],
    keep_index: bool,
) -> bool {
    for before_file in selected {
        let matching = after_files
            .iter()
            .filter(|file| file.path == before_file.path)
            .collect::<Vec<_>>();
        if keep_index && before_file.has_staged_changes && !before_file.is_untracked {
            if matching.len() != 1 {
                return false;
            }
            let after_file = matching[0];
            if !after_file.has_staged_changes
                || after_file.has_unstaged_changes
                || after_file.is_untracked
                || after_file.is_conflicted
                || after_file.old_path != before_file.old_path
            {
                return false;
            }
        } else if !matching.is_empty() {
            return false;
        }
    }
    true
}

fn verify_selected_scope_after_create(
    before_files: &[StashWorktreeFile],
    after_files: &[StashWorktreeFile],
    selected: &[StashWorktreeFile],
    keep_index: bool,
) -> bool {
    let mut selected_paths = HashSet::new();
    for file in selected {
        selected_paths.insert(file.path.clone());
        if let Some(old_path) = file.old_path.as_ref() {
            selected_paths.insert(old_path.clone());
        }
    }

    worktree_file_map(before_files, &selected_paths)
        == worktree_file_map(after_files, &selected_paths)
        && selected_residual_matches(after_files, selected, keep_index)
}

fn verify_selected_scope_digest_after_create(
    before_unselected_status_oid: &str,
    after_unselected_status_oid: &str,
    after_selected_files: &[StashWorktreeFile],
    selected: &[StashWorktreeFile],
    keep_index: bool,
) -> bool {
    before_unselected_status_oid == after_unselected_status_oid
        && selected_residual_matches(after_selected_files, selected, keep_index)
}

fn apply_selected_scope_verification_result(
    result: &mut StoredStashOperationResult,
    verified: bool,
    selected_count: usize,
) {
    if result.status != "complete" {
        return;
    }
    if verified {
        result.message = format!(
            "已创建 Stash，并确认只移除所选的 {} 个文件范围。",
            selected_count
        );
        return;
    }
    result.status = "needs_confirmation".to_string();
    result.needs_confirmation = true;
    result.warnings.push(
        "新 Stash 已出现，但所选与未选文件的操作后状态未完全符合预期；不会自动重试。"
            .to_string(),
    );
    result.message = "文件级 Stash 已执行，但范围结果需要确认。".to_string();
}
