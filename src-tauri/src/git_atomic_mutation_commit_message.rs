#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommitCleanupMode {
    Strip { auto_comment_char: Option<u8> },
    Whitespace,
    Verbatim,
    Scissors,
}

async fn read_optional_git_config(repo_path: &str, key: &str) -> Result<Option<String>, String> {
    let args = vec!["config".to_string(), "--get".to_string(), key.to_string()];
    let mut command = new_git_command(repo_path, &args, &[], false);
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| format!("读取 Git config 超时: {}", key))?
    .map_err(|error| format!("读取 Git config 失败（{}）: {}", key, error))?;
    match output.status.code() {
        Some(0) => {
            let value = String::from_utf8(output.stdout)
                .map_err(|_| format!("Git config {} 返回了非 UTF-8 值。", key))?;
            Ok(Some(value.trim().to_string()))
        }
        Some(1) => Ok(None),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!("读取 Git config {} 失败（退出码 {:?}）。", key, output.status.code())
            } else {
                stderr
            })
        }
    }
}

fn parse_effective_comment_config_output(output: &str) -> Result<Option<String>, String> {
    let mut effective = None;
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        let (_, value) = record.split_once('\n').ok_or_else(|| {
            "core.commentChar/core.commentString 返回了无法解析的 NUL-delimited config 记录。"
                .to_string()
        })?;
        // Keep the Git-parsed value byte-for-byte. In particular, `Auto` is
        // magic `auto`, while literal `auto ` (with a trailing space) is not.
        effective = Some(value.to_string());
    }
    Ok(effective)
}

async fn read_effective_comment_config(repo_path: &str) -> Result<Option<String>, String> {
    let args = vec![
        "config".to_string(),
        "-z".to_string(),
        "--get-regexp".to_string(),
        "^core\\.(commentchar|commentstring)$".to_string(),
    ];
    let mut command = new_git_command(repo_path, &args, &[], false);
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| "读取 core.commentChar/core.commentString 超时。".to_string())?
    .map_err(|error| format!("读取 core.commentChar/core.commentString 失败: {}", error))?;
    match output.status.code() {
        Some(0) => {
            let text = String::from_utf8(output.stdout)
                .map_err(|_| "core.commentChar/core.commentString 返回了非 UTF-8 值。".to_string())?;
            parse_effective_comment_config_output(&text)
        }
        Some(1) => Ok(None),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!(
                    "读取 core.commentChar/core.commentString 失败（退出码 {:?}）。",
                    output.status.code()
                )
            } else {
                stderr
            })
        }
    }
}

fn is_magic_auto_comment_config(value: &str) -> bool {
    // Git 2.47.x uses strcasecmp(value, "auto"): case-insensitive, but exact.
    // Do not trim here; `auto ` is a literal multi-character comment string.
    value.eq_ignore_ascii_case("auto")
}

fn select_auto_comment_char(message: &[u8]) -> Result<u8, String> {
    // Keep this candidate order aligned with Git's current
    // builtin/commit.c::adjust_comment_line_char(). The auto value is
    // deprecated upstream, but remains supported before Git 3.0.
    const CANDIDATES: &[u8] = b"#;@!$%^&|:";
    let mut used = [false; 10];
    let mut line_start = true;
    for byte in message {
        if line_start {
            if let Some(index) = CANDIDATES.iter().position(|candidate| candidate == byte) {
                used[index] = true;
            }
        }
        line_start = *byte == b'\n' || *byte == b'\r';
    }
    CANDIDATES
        .iter()
        .zip(used)
        .find_map(|(candidate, used)| (!used).then_some(*candidate))
        .ok_or_else(|| {
            "core.commentChar=auto 无法选择未被当前 commit message 行首使用的 comment character；普通 Commit 已 fail closed。"
                .to_string()
        })
}

async fn resolve_commit_cleanup_mode(
    repo_path: &str,
    initial_message: &[u8],
) -> Result<CommitCleanupMode, String> {
    // Working Changes Commit supplies a message directly and never opens an
    // editor. Git's `commit.cleanup=default` therefore has `whitespace`
    // semantics. Explicit `scissors` also reduces to whitespace because Git
    // truncates at scissors only for an edited message.
    let configured = read_optional_git_config(repo_path, "commit.cleanup").await?;
    match configured.as_deref().unwrap_or("default") {
        "default" | "whitespace" => Ok(CommitCleanupMode::Whitespace),
        "strip" => {
            let comment_config = read_effective_comment_config(repo_path).await?;
            let auto_comment_char = match comment_config.as_deref() {
                Some(value) if is_magic_auto_comment_config(value) => {
                    Some(select_auto_comment_char(initial_message)?)
                }
                _ => None,
            };
            Ok(CommitCleanupMode::Strip { auto_comment_char })
        }
        "verbatim" => Ok(CommitCleanupMode::Verbatim),
        "scissors" => Ok(CommitCleanupMode::Scissors),
        value => Err(format!(
            "不支持的 commit.cleanup 配置值：{}；普通 Commit 已 fail closed。",
            value
        )),
    }
}

async fn finalize_commit_message(
    repo_path: &str,
    hook_message: Vec<u8>,
    cleanup_mode: CommitCleanupMode,
) -> Result<Vec<u8>, String> {
    let cleaned = match cleanup_mode {
        CommitCleanupMode::Verbatim => hook_message,
        CommitCleanupMode::Strip { auto_comment_char } => {
            let mut args = Vec::new();
            if let Some(comment_char) = auto_comment_char {
                args.push("-c".to_string());
                args.push(format!("core.commentChar={}", char::from(comment_char)));
            }
            args.push("stripspace".to_string());
            args.push("--strip-comments".to_string());
            run_git_bytes(repo_path, &args, &[], Some(&hook_message)).await?
        }
        CommitCleanupMode::Whitespace | CommitCleanupMode::Scissors => {
            run_git_bytes(
                repo_path,
                &["stripspace".to_string()],
                &[],
                Some(&hook_message),
            )
            .await?
        }
    };
    if cleaned.is_empty() {
        return Err(
            "Aborting commit due to empty commit message；hook 处理后的 message 经 Git cleanup 后为空，HEAD 未移动。"
                .to_string(),
        );
    }
    Ok(cleaned)
}

fn commit_reflog_reason(final_message: &[u8], initial: bool) -> String {
    let first_line = final_message
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    let subject = String::from_utf8_lossy(first_line).trim().to_string();
    let action = if initial { "commit (initial)" } else { "commit" };
    if subject.is_empty() {
        format!("{}:", action)
    } else {
        format!("{}: {}", action, subject)
    }
}

#[cfg(test)]
mod commit_comment_config_tests {
    use super::{
        is_magic_auto_comment_config, parse_effective_comment_config_output,
    };

    #[test]
    fn magic_auto_is_case_insensitive_but_exact() {
        assert!(is_magic_auto_comment_config("auto"));
        assert!(is_magic_auto_comment_config("Auto"));
        assert!(is_magic_auto_comment_config("AUTO"));
        assert!(!is_magic_auto_comment_config("auto "));
        assert!(!is_magic_auto_comment_config(" auto"));
    }

    #[test]
    fn effective_comment_config_keeps_last_alias_value_without_trimming() {
        let output = "core.commentchar\nAuto\0core.commentstring\nauto \0";
        assert_eq!(
            parse_effective_comment_config_output(output).unwrap(),
            Some("auto ".to_string())
        );
    }
}
