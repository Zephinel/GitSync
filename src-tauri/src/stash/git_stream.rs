const GIT_STREAM_FIELD_MAX_BYTES: usize = 64 * 1024;
const GIT_STREAM_STDERR_MAX_BYTES: usize = 64 * 1024;
const GIT_STREAM_BUFFER_BYTES: usize = 16 * 1024;
const GIT_STREAM_HASH_STDOUT_MAX_BYTES: usize = 128;

async fn read_bounded_git_stderr(mut stderr: tokio::process::ChildStderr) -> String {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; GIT_STREAM_BUFFER_BYTES];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if retained.len() < GIT_STREAM_STDERR_MAX_BYTES {
                    let remaining = GIT_STREAM_STDERR_MAX_BYTES - retained.len();
                    retained.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
    }
    String::from_utf8_lossy(&retained).trim().to_string()
}

async fn read_bounded_git_stdout(
    mut stdout: tokio::process::ChildStdout,
    limit: usize,
) -> Result<String, String> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; GIT_STREAM_BUFFER_BYTES];
    loop {
        let read = stdout
            .read(&mut buffer)
            .await
            .map_err(|error| format!("读取 Git 标准输出失败: {}", error))?;
        if read == 0 {
            break;
        }
        if retained.len().saturating_add(read) > limit {
            return Err(format!("Git 标准输出超过 {} 字节安全上限。", limit));
        }
        retained.extend_from_slice(&buffer[..read]);
    }
    Ok(crate::git_encoding::decode_git_stdout(
        retained,
        "Stash streamed Git stdout",
    )?
    .trim()
    .to_string())
}

async fn run_git_delimited_fields<F>(
    repo_root: &str,
    args: &[&str],
    timeout_ms: u64,
    delimiter: u8,
    mut on_field: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String> + Send,
{
    let mut command = new_git_command(repo_root, args);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法执行 Git 命令: {}", error))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 Git 标准输出。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 Git 错误输出。".to_string())?;
    let stderr_task = tokio::spawn(read_bounded_git_stderr(stderr));

    let execution = async {
        let mut field = Vec::new();
        let mut buffer = [0_u8; GIT_STREAM_BUFFER_BYTES];
        loop {
            let read = stdout
                .read(&mut buffer)
                .await
                .map_err(|error| format!("读取 Git 标准输出失败: {}", error))?;
            if read == 0 {
                break;
            }
            for byte in &buffer[..read] {
                if *byte == delimiter {
                    let value = crate::git_encoding::decode_git_field(
                        &field,
                        "Stash delimited Git field",
                    )?;
                    field.clear();
                    on_field(value)?;
                } else {
                    if field.len() >= GIT_STREAM_FIELD_MAX_BYTES {
                        return Err(format!(
                            "Git 流式输出包含超过 {} 字节的单字段；为避免无界内存占用已停止读取。",
                            GIT_STREAM_FIELD_MAX_BYTES
                        ));
                    }
                    field.push(*byte);
                }
            }
        }
        if !field.is_empty() {
            return Err(format!(
                "Git 流式输出未以 0x{:02x} 分隔符结束，无法安全确认字段边界。",
                delimiter
            ));
        }
        child
            .wait()
            .await
            .map_err(|error| format!("等待 Git 命令结束失败: {}", error))
    };

    let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms), execution).await;
    if outcome.is_err() || matches!(&outcome, Ok(Err(_))) {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let stderr = stderr_task.await.unwrap_or_default();

    match outcome {
        Err(_) => Err(format!("Git 命令执行超时: git {}", args.join(" "))),
        Ok(Err(error)) => Err(error),
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => {
            if stderr.is_empty() {
                Err(format!(
                    "Git 命令失败: git {}（退出码 {:?}）",
                    args.join(" "),
                    status.code()
                ))
            } else {
                Err(stderr)
            }
        }
    }
}

async fn run_git_nul_fields<F>(
    repo_root: &str,
    args: &[&str],
    timeout_ms: u64,
    on_field: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String> + Send,
{
    run_git_delimited_fields(repo_root, args, timeout_ms, 0, on_field).await
}

async fn run_git_newline_records<F>(
    repo_root: &str,
    args: &[&str],
    timeout_ms: u64,
    on_record: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String> + Send,
{
    run_git_delimited_fields(repo_root, args, timeout_ms, b'\n', on_record).await
}

fn normalize_git_content_oid(value: &str) -> Result<String, String> {
    let oid = value.trim().to_ascii_lowercase();
    if !matches!(oid.len(), 40 | 64)
        || !oid
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Git hash-object 返回了无效对象 OID。".to_string());
    }
    Ok(oid)
}

async fn hash_git_command_stdout(
    repo_root: &str,
    source_args: &[&str],
    timeout_ms: u64,
) -> Result<String, String> {
    let mut source_command = new_git_command(repo_root, source_args);
    let mut source = source_command
        .spawn()
        .map_err(|error| format!("无法执行 Git digest source 命令: {}", error))?;
    let mut source_stdout = source
        .stdout
        .take()
        .ok_or_else(|| "无法读取 Git digest source 标准输出。".to_string())?;
    let source_stderr = source
        .stderr
        .take()
        .ok_or_else(|| "无法读取 Git digest source 错误输出。".to_string())?;

    let mut hash_command = new_git_command(repo_root, &["hash-object", "--stdin"]);
    hash_command.stdin(Stdio::piped());
    let mut hash = hash_command
        .spawn()
        .map_err(|error| format!("无法启动 git hash-object --stdin: {}", error))?;
    let mut hash_stdin = hash
        .stdin
        .take()
        .ok_or_else(|| "无法写入 git hash-object 标准输入。".to_string())?;
    let hash_stdout = hash
        .stdout
        .take()
        .ok_or_else(|| "无法读取 git hash-object 标准输出。".to_string())?;
    let hash_stderr = hash
        .stderr
        .take()
        .ok_or_else(|| "无法读取 git hash-object 错误输出。".to_string())?;

    let source_stderr_task = tokio::spawn(read_bounded_git_stderr(source_stderr));
    let hash_stderr_task = tokio::spawn(read_bounded_git_stderr(hash_stderr));
    let hash_stdout_task = tokio::spawn(read_bounded_git_stdout(
        hash_stdout,
        GIT_STREAM_HASH_STDOUT_MAX_BYTES,
    ));

    let execution = async {
        tokio::io::copy(&mut source_stdout, &mut hash_stdin)
            .await
            .map_err(|error| format!("向 git hash-object 流式写入失败: {}", error))?;
        hash_stdin
            .shutdown()
            .await
            .map_err(|error| format!("关闭 git hash-object 标准输入失败: {}", error))?;
        drop(hash_stdin);
        let source_status = source
            .wait()
            .await
            .map_err(|error| format!("等待 Git digest source 结束失败: {}", error))?;
        let hash_status = hash
            .wait()
            .await
            .map_err(|error| format!("等待 git hash-object 结束失败: {}", error))?;
        Ok::<_, String>((source_status, hash_status))
    };

    let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms), execution).await;
    if outcome.is_err() || matches!(&outcome, Ok(Err(_))) {
        let _ = source.kill().await;
        let _ = source.wait().await;
        let _ = hash.kill().await;
        let _ = hash.wait().await;
    }

    let source_stderr = source_stderr_task.await.unwrap_or_default();
    let hash_stderr = hash_stderr_task.await.unwrap_or_default();
    let hash_stdout = hash_stdout_task
        .await
        .map_err(|error| format!("读取 git hash-object 结果任务失败: {}", error))??;

    let (source_status, hash_status) = match outcome {
        Err(_) => {
            return Err(format!(
                "Git digest 计算超时: git {} | git hash-object --stdin",
                source_args.join(" ")
            ));
        }
        Ok(Err(error)) => return Err(error),
        Ok(Ok(statuses)) => statuses,
    };

    if !source_status.success() {
        return Err(if source_stderr.is_empty() {
            format!(
                "Git digest source 命令失败: git {}（退出码 {:?}）",
                source_args.join(" "),
                source_status.code()
            )
        } else {
            source_stderr
        });
    }
    if !hash_status.success() {
        return Err(if hash_stderr.is_empty() {
            format!(
                "git hash-object --stdin 失败（退出码 {:?}）",
                hash_status.code()
            )
        } else {
            hash_stderr
        });
    }

    normalize_git_content_oid(&hash_stdout)
}
