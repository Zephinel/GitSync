async fn run_git_output(
    repo_path: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    run_git_output_with_command(
        crate::git_command::new_read_only_async_command(repo_path, args),
        args,
        timeout_ms,
    )
    .await
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

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

async fn run_git_with_input(
    repo_path: &str,
    args: &[&str],
    input: &str,
    timeout_ms: u64,
) -> Result<GitCommandOutput, String> {
    let mut command = crate::git_command::new_mutation_async_command(repo_path, args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法执行 Git 命令: {}", error))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 Git 命令输入".to_string())?;
    stdin
        .write_all(input.as_bytes())
        .await
        .map_err(|error| format!("无法写入 Git 命令输入: {}", error))?;
    stdin
        .shutdown()
        .await
        .map_err(|error| format!("无法结束 Git 命令输入: {}", error))?;
    drop(stdin);

    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
        .await
        .map_err(|_| format!("Git 命令执行超时: git {}", args.join(" ")))?
        .map_err(|error| format!("无法等待 Git 命令: {}", error))?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

async fn run_git(repo_path: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let output = run_git_output(repo_path, args, timeout_ms).await?;
    if output.success {
        return Ok(output.stdout);
    }
    let detail = if output.stderr.is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    Err(if detail.is_empty() {
        format!("Git 命令失败: git {}", args.join(" "))
    } else {
        detail
    })
}

async fn ref_exists(repo_path: &str, full_ref: &str) -> Result<bool, String> {
    let output = run_git_output(
        repo_path,
        &["show-ref", "--verify", "--quiet", full_ref],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    Ok(output.success)
}

async fn resolve_ref(repo_path: &str, full_ref: &str) -> Result<Option<String>, String> {
    let revision = format!("{}^{{commit}}", full_ref);
    let output = run_git_output(
        repo_path,
        &["rev-parse", "--verify", revision.as_str()],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    if output.success {
        let value = output.stdout.trim();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value.to_string()))
        }
    } else {
        Ok(None)
    }
}

async fn get_remote_names(repo_path: &str) -> Result<Vec<String>, String> {
    let output = run_git(repo_path, &["remote"], GIT_META_TIMEOUT_MS).await?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect())
}

fn parse_remote_ref<'a>(value: &str, remotes: &'a [String]) -> Option<(&'a str, String)> {
    let normalized = value.trim();
    let mut candidates: Vec<&String> = remotes.iter().collect();
    candidates.sort_by_key(|remote| std::cmp::Reverse(remote.len()));
    candidates.into_iter().find_map(|remote| {
        let prefix = format!("{}/", remote);
        normalized
            .strip_prefix(prefix.as_str())
            .map(str::trim)
            .filter(|branch| !branch.is_empty() && *branch != "HEAD")
            .map(|branch| (remote.as_str(), branch.to_string()))
    })
}

async fn read_optional_git_config(repo_path: &str, key: &str) -> Result<Option<String>, String> {
    let output = run_git_output(
        repo_path,
        &["config", "--get", key],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    if !output.success {
        return Ok(None);
    }
    let value = output.stdout.trim();
    Ok((!value.is_empty()).then(|| value.to_string()))
}

async fn read_upstream(repo_path: &str, local_name: &str) -> Result<Option<String>, String> {
    let full_ref = format!("refs/heads/{}", local_name);
    let output = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(upstream:short)",
            full_ref.as_str(),
        ],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    let value = output.trim();
    if !value.is_empty() {
        return Ok(Some(value.to_string()));
    }

    // Git omits %(upstream:short) when the configured remote itself has disappeared.
    // Read the branch config so the product can report an unavailable former target
    // instead of silently treating the branch as if it had never had an upstream.
    let remote_key = format!("branch.{}.remote", local_name);
    let merge_key = format!("branch.{}.merge", local_name);
    let (remote, merge) = tokio::try_join!(
        read_optional_git_config(repo_path, remote_key.as_str()),
        read_optional_git_config(repo_path, merge_key.as_str())
    )?;
    let Some(remote) = remote else {
        return Ok(None);
    };
    let Some(merge) = merge else {
        return Ok(None);
    };
    let branch = merge
        .strip_prefix("refs/heads/")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok(branch.map(|branch| format!("{}/{}", remote, branch)))
}

async fn current_branch(repo_path: &str) -> Result<Option<String>, String> {
    let output = run_git_output(
        repo_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    if output.success {
        let value = output.stdout.trim();
        Ok((!value.is_empty()).then(|| value.to_string()))
    } else {
        Ok(None)
    }
}

async fn read_worktree_status(repo_path: &str) -> Result<(bool, usize, String), String> {
    let output = run_git(
        repo_path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    let count = output.as_bytes().iter().filter(|byte| **byte == 0).count();
    let dirty = !output.is_empty();
    Ok((dirty, count, output))
}

async fn compare_refs(repo_path: &str, left: &str, right: &str) -> Result<(u64, u64), String> {
    let range = format!("{}...{}", left, right);
    let output = run_git(
        repo_path,
        &["rev-list", "--left-right", "--count", range.as_str()],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    let mut values = output.split_whitespace();
    let ahead = values
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "无法解析本地领先提交数".to_string())?;
    let behind = values
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "无法解析远端领先提交数".to_string())?;
    Ok((ahead, behind))
}

async fn fetch_remote(repo_path: &str, remote: &str) -> Result<(), String> {
    // Fetch updates remote-tracking refs and FETCH_HEAD, so it blocks restart.
    let output = run_git_mutation_output(
        repo_path,
        &["fetch", "--prune", "--no-tags", remote],
        GIT_FETCH_TIMEOUT_MS,
    )
    .await?;
    if output.success {
        Ok(())
    } else {
        Err(format!(
            "无法确认远端 {} 的最新状态，请检查网络、权限或远端配置后重试。",
            remote
        ))
    }
}

async fn fetch_remote_branch(
    repo_path: &str,
    remote: &str,
    branch: &str,
) -> Result<(), String> {
    let refspec = format!(
        "+refs/heads/{}:refs/remotes/{}/{}",
        branch, remote, branch
    );
    // Fetch is a repository mutation even when the working tree is untouched.
    let output = run_git_mutation_output(
        repo_path,
        &["fetch", "--prune", "--no-tags", remote, refspec.as_str()],
        GIT_FETCH_TIMEOUT_MS,
    )
    .await?;
    if output.success {
        Ok(())
    } else {
        Err(format!(
            "无法确认远端分支 {}/{} 的最新状态；该分支可能已删除，或当前网络与权限不可用。",
            remote, branch
        ))
    }
}
