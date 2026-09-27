const BLOCKING_COMMIT_OPERATION_MARKERS: &[(&str, &str)] = &[
    ("MERGE_HEAD", "merge"),
    ("CHERRY_PICK_HEAD", "cherry-pick"),
    ("REVERT_HEAD", "revert"),
    ("REBASE_HEAD", "rebase"),
    ("rebase-merge", "rebase"),
    ("rebase-apply", "rebase/am"),
    ("sequencer", "sequencer"),
];

fn resolve_git_path_from_output(repo_path: &str, value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Git path authority 返回了空路径。".to_string());
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        Path::new(repo_path).join(path)
    })
}

async fn resolve_git_path(repo_path: &str, name: &str) -> Result<PathBuf, String> {
    let output = run_git_text(
        repo_path,
        &["rev-parse".to_string(), "--git-path".to_string(), name.to_string()],
        &[],
        None,
    )
    .await?;
    resolve_git_path_from_output(repo_path, &output)
}

async fn ensure_normal_commit_operation_state(repo_path: &str) -> Result<(), String> {
    for (marker, label) in BLOCKING_COMMIT_OPERATION_MARKERS {
        let path = resolve_git_path(repo_path, marker).await?;
        match tokio::fs::symlink_metadata(&path).await {
            Ok(_) => {
                return Err(format!(
                    "普通 Working Changes Commit 已拒绝：仓库存在进行中的 Git {} 状态（{}）。请使用对应的 Continue / Skip / Abort lifecycle 完成或取消该操作。",
                    label, marker
                ));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "无法确认 Git operation-state authority（{}）: {}",
                    marker, error
                ));
            }
        }
    }
    Ok(())
}

struct RealIndexLockGuard {
    lock_path: PathBuf,
    file: Option<std::fs::File>,
}

impl RealIndexLockGuard {
    async fn acquire(repo_path: &str) -> Result<Self, String> {
        let index_path = resolve_git_path(repo_path, "index").await?;
        let lock_path = PathBuf::from(format!("{}.lock", index_path.to_string_lossy()));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .map_err(|error| {
                format!(
                    "无法取得 real index lock；外部 Git 操作可能正在进行，本次 Commit 未开始（{}）: {}",
                    lock_path.display(), error
                )
            })?;
        Ok(Self {
            lock_path,
            file: Some(file),
        })
    }

    fn release(mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

impl Drop for RealIndexLockGuard {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

fn hook_envs(index_envs: &[(String, String)]) -> Vec<(String, String)> {
    let mut envs = index_envs.to_vec();
    envs.push(("GIT_EDITOR".to_string(), ":".to_string()));
    envs
}

async fn run_commit_hook(
    repo_path: &str,
    hook_name: &str,
    hook_args: &[String],
    envs: &[(String, String)],
) -> Result<(), String> {
    let mut args = vec![
        "hook".to_string(),
        "run".to_string(),
        "--ignore-missing".to_string(),
        hook_name.to_string(),
    ];
    if !hook_args.is_empty() {
        args.push("--".to_string());
        args.extend(hook_args.iter().cloned());
    }
    run_git_bytes(repo_path, &args, envs, None)
        .await
        .map(|_| ())
        .map_err(|error| format!("{} hook 拒绝或执行失败；HEAD 未移动: {}", hook_name, error))
}

async fn run_pre_publish_commit_hooks(
    repo_path: &str,
    message: &str,
    index_envs: &[(String, String)],
) -> Result<Vec<u8>, String> {
    let envs = hook_envs(index_envs);
    run_commit_hook(repo_path, "pre-commit", &[], &envs).await?;

    let git_dir = resolve_git_dir(repo_path).await?;
    let message_path = unique_temp_path(&git_dir, "commit-message");
    let result = async {
        tokio::fs::write(&message_path, message.as_bytes())
            .await
            .map_err(|error| format!("写入 atomic commit message 临时文件失败: {}", error))?;
        let message_arg = message_path.to_string_lossy().to_string();
        run_commit_hook(
            repo_path,
            "prepare-commit-msg",
            &[message_arg.clone(), "message".to_string()],
            &envs,
        )
        .await?;
        run_commit_hook(repo_path, "commit-msg", &[message_arg], &envs).await?;
        tokio::fs::read(&message_path)
            .await
            .map_err(|error| format!("读取 hook 处理后的 commit message 失败: {}", error))
    }
    .await;
    let _ = tokio::fs::remove_file(&message_path).await;
    result
}

async fn run_post_commit_hook_best_effort(repo_path: &str) {
    let _ = run_commit_hook(repo_path, "post-commit", &[], &[]).await;
}
