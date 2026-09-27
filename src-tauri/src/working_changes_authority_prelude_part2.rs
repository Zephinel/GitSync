async fn run_git_display_content(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    let mut command = new_git_command(repo_path, args, &[]);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("Git 内容命令执行超时: git {}", args.join(" ")))?
        .map_err(|error| format!("无法执行 Git 内容命令: {}", error))?;
    let decoded = GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: crate::git_encoding::decode_git_display_content(output.stdout),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    };
    if decoded.success {
        Ok(decoded.stdout)
    } else {
        Err(git_failure(args, decoded))
    }
}

async fn read_tracked_patch_display(
    repo_path: &str,
    file: &RepoWorkingChangeFile,
) -> Result<String, String> {
    let has_head = git_succeeds(repo_path, &["rev-parse", "--verify", "HEAD"]).await;
    let mut args = if has_head {
        vec![
            "diff".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--unified=3".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            literal_pathspec(&file.path),
        ]
    } else {
        vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--unified=3".to_string(),
            "--".to_string(),
            literal_pathspec(&file.path),
        ]
    };
    if let Some(old_path) = file.old_path.as_ref() {
        if old_path != &file.path {
            args.push(literal_pathspec(old_path));
        }
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git_display_content(repo_path, &refs, GIT_WORKING_FILE_DIFF_TIMEOUT_MS).await
}

pub async fn get_repo_working_diff_summary_authoritative(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<RepoWorkingChangesSummary, String> {
    ensure_repo_path(&repo_path)?;
    let _guard = crate::repo_git_lock::acquire_read(&state, &repo_path).await?;
    read_working_summary_authoritative_inner(&repo_path).await
}

pub async fn get_repo_working_file_diff_authoritative(
    repo_path: String,
    path: String,
    old_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoWorkingFileDiff, String> {
    ensure_repo_path(&repo_path)?;
    let normalized_path = validate_relative_path(&path)?;
    let normalized_old_path = old_path
        .as_deref()
        .map(validate_relative_path)
        .transpose()?;
    let _guard = crate::repo_git_lock::acquire_read(&state, &repo_path).await?;

    // File Diff remains display-only and never recaptures mutation-content authority.
    let summary = read_working_summary_inner(&repo_path).await?;
    let matches = summary
        .files
        .iter()
        .filter(|file| {
            file.path == normalized_path
                && normalized_old_path.as_deref().map_or(file.old_path.is_none(), |value| {
                    file.old_path.as_deref() == Some(value)
                })
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(format!(
            "文件 Diff identity 已变化或同一路径存在多个 Git status identity，请刷新后重试: {}",
            normalized_path
        ));
    }
    let file = matches[0].clone();
    if file.is_binary {
        return Ok(RepoWorkingFileDiff {
            hash: summary.hash,
            full_hash: summary.full_hash,
            path: file.path,
            old_path: file.old_path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            is_binary: true,
            is_too_large: file.is_too_large,
            truncated: false,
            patch: String::new(),
        });
    }
    let patch = if file.is_untracked {
        let absolute_path = Path::new(&repo_path).join(&file.path);
        let bytes = tokio::fs::read(&absolute_path)
            .await
            .map_err(|error| format!("读取未跟踪文件失败: {}", error))?;
        let contents = crate::git_encoding::decode_git_display_content(bytes);
        synthetic_untracked_patch(&file.path, &contents)
    } else {
        read_tracked_patch_display(&repo_path, &file).await?
    };
    let (patch, is_too_large, truncated) = normalize_patch_for_response(patch);
    Ok(RepoWorkingFileDiff {
        hash: summary.hash,
        full_hash: summary.full_hash,
        path: file.path,
        old_path: file.old_path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        is_binary: false,
        is_too_large,
        truncated,
        patch,
    })
}
