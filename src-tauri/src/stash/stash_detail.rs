#[derive(Debug, Clone)]
struct StashDetailContext {
    entry: RepoStashEntry,
    base_commit: String,
    untracked_commit: Option<String>,
}

fn parse_stash_parents(raw: &str) -> Result<(String, Option<String>), String> {
    let values = raw.split_whitespace().collect::<Vec<_>>();
    if values.len() < 3 {
        return Err("Stash 提交缺少可用的基线与 Index 父提交。".to_string());
    }
    Ok((
        values[1].to_string(),
        values.get(3).map(|value| (*value).to_string()),
    ))
}

fn stash_detail_status(code: &str, untracked: bool) -> String {
    if untracked {
        return "untracked".to_string();
    }
    match code.chars().next().unwrap_or('M') {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    }
    .to_string()
}

#[cfg(test)]
fn parse_name_status_z(raw: &str) -> Vec<RepoStashDetailFile> {
    let fields = raw
        .split('\0')
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0usize;
    while index < fields.len() {
        let code = fields[index];
        index += 1;
        if code.starts_with('R') || code.starts_with('C') {
            if index + 1 >= fields.len() {
                break;
            }
            let old_path = fields[index].to_string();
            let path = fields[index + 1].to_string();
            index += 2;
            files.push(RepoStashDetailFile {
                path,
                old_path: Some(old_path),
                status: stash_detail_status(code, false),
                additions: 0,
                deletions: 0,
                is_binary: false,
                is_untracked: false,
            });
        } else {
            let Some(path) = fields.get(index) else {
                break;
            };
            index += 1;
            files.push(RepoStashDetailFile {
                path: (*path).to_string(),
                old_path: None,
                status: stash_detail_status(code, false),
                additions: 0,
                deletions: 0,
                is_binary: false,
                is_untracked: false,
            });
        }
    }
    files
}

#[cfg(test)]
fn parse_numstat_z(raw: &str) -> HashMap<String, (u32, u32, bool)> {
    let mut result = HashMap::new();
    let fields = raw.split('\0').collect::<Vec<_>>();
    let mut index = 0usize;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.is_empty() {
            continue;
        }
        let mut parts = field.splitn(3, '\t');
        let additions_raw = parts.next().unwrap_or_default();
        let deletions_raw = parts.next().unwrap_or_default();
        let inline_path = parts.next().unwrap_or_default();
        let binary = additions_raw == "-" || deletions_raw == "-";
        let additions = additions_raw.parse::<u32>().unwrap_or(0);
        let deletions = deletions_raw.parse::<u32>().unwrap_or(0);
        let path = if inline_path.is_empty() {
            if index + 1 >= fields.len() {
                continue;
            }
            index += 1;
            let new_path = fields[index];
            index += 1;
            new_path
        } else {
            inline_path
        };
        if !path.is_empty() {
            result.insert(path.to_string(), (additions, deletions, binary));
        }
    }
    result
}

#[cfg(test)]
fn merge_stash_detail_stats(
    files: &mut [RepoStashDetailFile],
    stats: &HashMap<String, (u32, u32, bool)>,
) {
    for file in files {
        if let Some((additions, deletions, binary)) = stats.get(&file.path) {
            file.additions = *additions;
            file.deletions = *deletions;
            file.is_binary = *binary;
        }
    }
}

#[cfg(test)]
fn mark_untracked_detail_files(files: &mut [RepoStashDetailFile]) {
    for file in files {
        file.status = "untracked".to_string();
        file.is_untracked = true;
        file.old_path = None;
    }
}

async fn resolve_stash_detail_context(
    repo_root: &str,
    stash_id: &str,
) -> Result<StashDetailContext, String> {
    let stash_id = normalize_stash_id(stash_id)?;
    let snapshot = read_stash_snapshot_core(repo_root).await?;
    let entry = find_stash_entry(&snapshot, &stash_id)
        .cloned()
        .ok_or_else(|| "所选 Stash 已不存在或列表已经变化。".to_string())?;
    let parent_output = run_git(
        repo_root,
        &["rev-list", "--parents", "-n", "1", entry.oid.as_str()],
        GIT_STASH_META_TIMEOUT_MS,
    )
    .await?;
    let (base_commit, untracked_commit) = parse_stash_parents(&parent_output)?;
    Ok(StashDetailContext {
        entry,
        base_commit,
        untracked_commit,
    })
}

async fn read_repo_stash_detail(
    repo_root: &str,
    stash_id: &str,
) -> Result<RepoStashDetail, String> {
    read_repo_stash_detail_streamed(repo_root, stash_id).await
}

fn bounded_patch(raw: String) -> (String, bool) {
    if raw.len() <= STASH_DETAIL_MAX_PATCH_BYTES {
        return (raw, false);
    }
    let bytes = raw.as_bytes();
    let bounded = String::from_utf8_lossy(&bytes[..STASH_DETAIL_MAX_PATCH_BYTES]).to_string();
    (bounded, true)
}

fn untracked_file_patch(path: &str, content: &str) -> String {
    let line_count = content.lines().count();
    let mut patch = format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n",
        path, line_count
    );
    for line in content.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    patch
}

async fn read_object_size(repo_root: &str, object: &str) -> Result<Option<u64>, String> {
    let output = run_git_output(
        repo_root,
        &["cat-file", "-s", object],
        GIT_STASH_META_TIMEOUT_MS,
    )
    .await?;
    if !output.success {
        return Ok(None);
    }
    let size = output
        .stdout
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("Git 返回了无效的对象大小: {}", object))?;
    Ok(Some(size))
}

async fn stash_file_object_bytes(
    repo_root: &str,
    context: &StashDetailContext,
    file: &RepoStashDetailFile,
) -> Result<u64, String> {
    if file.is_untracked {
        let Some(commit) = context.untracked_commit.as_deref() else {
            return Ok(0);
        };
        let object = format!("{}:{}", commit, file.path);
        return Ok(read_object_size(repo_root, &object).await?.unwrap_or(0));
    }

    let current = format!("{}:{}", context.entry.oid, file.path);
    let base_path = file.old_path.as_deref().unwrap_or(file.path.as_str());
    let base = format!("{}:{}", context.base_commit, base_path);
    let current_size = read_object_size(repo_root, &current).await?.unwrap_or(0);
    let base_size = read_object_size(repo_root, &base).await?.unwrap_or(0);
    Ok(current_size.saturating_add(base_size))
}

fn empty_file_diff(
    context: &StashDetailContext,
    file: RepoStashDetailFile,
    is_binary: bool,
    truncated: bool,
    too_large: bool,
) -> RepoStashFileDiff {
    RepoStashFileDiff {
        stash_id: context.entry.id.clone(),
        path: file.path,
        old_path: file.old_path,
        status: file.status,
        patch: String::new(),
        additions: file.additions,
        deletions: file.deletions,
        is_binary,
        truncated,
        too_large,
    }
}

async fn read_repo_stash_file_diff(
    repo_root: &str,
    stash_id: &str,
    path: &str,
) -> Result<RepoStashFileDiff, String> {
    let path = normalize_stash_scope_path(path)?;
    let context = resolve_stash_detail_context(repo_root, stash_id).await?;
    let file = read_repo_stash_file_metadata_streamed(repo_root, &context, &path).await?;

    if file.is_binary {
        return Ok(empty_file_diff(&context, file, true, false, false));
    }
    let object_bytes = stash_file_object_bytes(repo_root, &context, &file).await?;
    if object_bytes > STASH_DETAIL_MAX_PATCH_BYTES as u64 {
        return Ok(empty_file_diff(&context, file, false, false, true));
    }

    let (patch, truncated) = if file.is_untracked {
        let commit = context
            .untracked_commit
            .as_deref()
            .ok_or_else(|| "Stash 中没有可读取的未跟踪文件父提交。".to_string())?;
        let object = format!("{}:{}", commit, file.path);
        let output = run_git_content_output(
            repo_root,
            &["show", "--no-textconv", object.as_str()],
            GIT_STASH_STATUS_TIMEOUT_MS,
        )
        .await?;
        if !output.success {
            return Err(git_failure(&["show", object.as_str()], &output));
        }
        bounded_patch(untracked_file_patch(&file.path, &output.stdout))
    } else {
        let mut owned_args = vec![
            "diff".to_string(),
            "--no-ext-diff".to_string(),
            "--no-color".to_string(),
            "--unified=3".to_string(),
            context.base_commit.clone(),
            context.entry.oid.clone(),
            "--".to_string(),
        ];
        if let Some(old_path) = file.old_path.as_ref() {
            owned_args.push(literal_stash_pathspec(old_path));
        }
        owned_args.push(literal_stash_pathspec(&file.path));
        let args = owned_args.iter().map(String::as_str).collect::<Vec<_>>();
        let output = run_git_content_output(repo_root, &args, GIT_STASH_STATUS_TIMEOUT_MS).await?;
        if !output.success {
            return Err(git_failure(&args, &output));
        }
        bounded_patch(output.stdout)
    };

    Ok(RepoStashFileDiff {
        stash_id: context.entry.id,
        path: file.path,
        old_path: file.old_path,
        status: file.status,
        patch,
        additions: file.additions,
        deletions: file.deletions,
        is_binary: false,
        truncated,
        too_large: false,
    })
}
