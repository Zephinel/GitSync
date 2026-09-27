use crate::repo_git_lock::normalize_repo_lock_key;

fn ensure_repo_path(path: &str) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("仓库路径不能为空".to_string());
    }
    if !Path::new(normalized).is_dir() {
        return Err(format!("仓库目录不存在: {}", normalized));
    }
    Ok(())
}

fn new_git_command(repo_path: &str, args: &[&str]) -> Command {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    command
}

async fn run_git_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    run_git_output_with_command(new_git_command(repo_path, args), args, timeout_ms).await
}

async fn run_git_mutation_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    run_git_output_with_command(
        crate::git_command::new_mutation_async_command(repo_path, args),
        args,
        timeout_ms,
    )
    .await
}

async fn run_git_output_with_command(
    mut command: Command,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("Git 命令执行超时: git {}", args.join(" ")))?
        .map_err(|error| format!("无法执行 Git 命令: {}", error))?;
    let stdout = crate::git_encoding::decode_git_stdout(output.stdout, "Stash Git stdout")?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

// Stash diff/file payloads can legally contain non-UTF-8 bytes even when the
// repository path is valid UTF-8. Keep display decoding separate from the
// strict path-bearing runner above so content bytes can never masquerade as a
// path-encoding failure.
async fn run_git_content_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    let mut command = new_git_command(repo_path, args);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("Git 内容命令执行超时: git {}", args.join(" ")))?
        .map_err(|error| format!("无法执行 Git 内容命令: {}", error))?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: crate::git_encoding::decode_git_display_content(output.stdout),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn git_failure(args: &[&str], output: &GitCommandOutput) -> String {
    if output.stderr.is_empty() {
        format!(
            "Git 命令失败: git {}（退出码 {:?}）",
            args.join(" "),
            output.code
        )
    } else {
        output.stderr.clone()
    }
}

async fn run_git(repo_path: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let output = run_git_output(repo_path, args, timeout_ms).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(git_failure(args, &output))
    }
}

async fn resolve_repo_root(path: &str) -> Result<String, String> {
    let output = run_git(
        path,
        &["rev-parse", "--show-toplevel"],
        GIT_STASH_META_TIMEOUT_MS,
    )
    .await?;
    let root = output.trim();
    if root.is_empty() {
        return Err("无法解析 Git 工作区根目录".to_string());
    }
    Ok(normalize_repo_lock_key(root))
}

async fn acquire_repo_git_guard(
    state: &AppState,
    root: &str,
) -> Result<crate::repo_git_lock::RepoGitGuard, String> {
    crate::repo_git_lock::acquire(state, root).await
}

async fn acquire_repo_git_read_guard(
    state: &AppState,
    root: &str,
) -> Result<crate::repo_git_lock::RepoGitGuard, String> {
    crate::repo_git_lock::acquire_read(state, root).await
}

async fn resolve_git_common_dir(repo_root: &str) -> Result<PathBuf, String> {
    let raw = run_git(
        repo_root,
        &["rev-parse", "--git-common-dir"],
        GIT_STASH_META_TIMEOUT_MS,
    )
    .await?;
    let value = raw.trim();
    if value.is_empty() {
        return Err("无法解析 Git common dir".to_string());
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        Path::new(repo_root).join(path)
    })
}

async fn stash_journal_directory(repo_root: &str) -> Result<PathBuf, String> {
    Ok(resolve_git_common_dir(repo_root)
        .await?
        .join(STASH_OPERATION_DIRECTORY))
}

fn normalize_request_id(value: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("Stash 请求 ID 无效。".to_string());
    }
    Ok(normalized.to_string())
}

fn normalize_stash_id(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() < 7
        || normalized.len() > 64
        || !normalized.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err("Stash 条目标识无效。".to_string());
    }
    Ok(normalized)
}

fn normalize_stash_message(value: &str) -> Result<String, String> {
    let sanitized = value
        .chars()
        .map(|character| {
            if matches!(character, '\r' | '\n' | '\0') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let normalized = sanitized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.chars().count() > STASH_MESSAGE_MAX_CHARS {
        return Err(format!(
            "Stash 说明最多允许 {} 个字符。",
            STASH_MESSAGE_MAX_CHARS
        ));
    }
    Ok(normalized)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
fn stable_hash(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = DefaultHasher::new();
    prefix.hash(&mut hasher);
    for part in parts {
        part.hash(&mut hasher);
        0xff_u8.hash(&mut hasher);
    }
    format!("{}-{:016x}", prefix, hasher.finish())
}
