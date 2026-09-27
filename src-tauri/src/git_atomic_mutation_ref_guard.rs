use tokio::io::AsyncBufReadExt;

struct ExpectedHeadRefGuard {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::io::BufReader<tokio::process::ChildStdout>>,
}

impl ExpectedHeadRefGuard {
    async fn acquire(repo_path: &str, expected_head: Option<&str>) -> Result<Self, String> {
        let expected = match expected_head.filter(|value| !value.is_empty()) {
            Some(head) => head.to_string(),
            None => object_zero_oid(repo_path).await?,
        };
        let args = vec!["update-ref".to_string(), "--stdin".to_string()];
        let mut command = new_git_command(repo_path, &args, &[], true);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 expected-HEAD ref transaction: {}", error))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "expected-HEAD ref transaction stdin 不可用。".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "expected-HEAD ref transaction stdout 不可用。".to_string())?;
        let mut stdout = tokio::io::BufReader::new(stdout);

        stdin
            .write_all(b"start\n")
            .await
            .map_err(|error| format!("启动 expected-HEAD ref transaction 失败: {}", error))?;
        stdin.flush().await.ok();
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
            stdout.read_line(&mut line),
        )
        .await
        .map_err(|_| "等待 expected-HEAD ref transaction start 超时。".to_string())?
        .map_err(|error| format!("读取 expected-HEAD transaction start 失败: {}", error))?;
        if line.trim() != "start: ok" {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!("无法启动 expected-HEAD ref transaction: {}", line.trim()));
        }

        let commands = format!("verify HEAD {}\nprepare\n", expected);
        stdin
            .write_all(commands.as_bytes())
            .await
            .map_err(|error| format!("写入 expected-HEAD verify/prepare 失败: {}", error))?;
        stdin.flush().await.ok();
        line.clear();
        let read = tokio::time::timeout(
            Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
            stdout.read_line(&mut line),
        )
        .await
        .map_err(|_| "等待 expected-HEAD ref transaction prepare 超时。".to_string())?
        .map_err(|error| format!("读取 expected-HEAD transaction prepare 失败: {}", error))?;
        if read == 0 || line.trim() != "prepare: ok" {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!(
                "expected HEAD 已变化或无法取得 ref lock；mutation 未开始: {}",
                line.trim()
            ));
        }
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
        })
    }

    async fn release(mut self) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .take()
            .ok_or_else(|| "expected-HEAD ref transaction stdin 不可用。".to_string())?;
        stdin
            .write_all(b"abort\n")
            .await
            .map_err(|error| format!("释放 expected-HEAD ref lock 失败: {}", error))?;
        stdin.flush().await.ok();
        let _ = stdin.shutdown().await;

        let mut stdout = self
            .stdout
            .take()
            .ok_or_else(|| "expected-HEAD ref transaction stdout 不可用。".to_string())?;
        let mut line = String::new();
        let read = tokio::time::timeout(
            Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
            stdout.read_line(&mut line),
        )
        .await
        .map_err(|_| "等待 expected-HEAD ref transaction abort 超时。".to_string())?
        .map_err(|error| format!("读取 expected-HEAD transaction abort 失败: {}", error))?;
        if read == 0 || line.trim() != "abort: ok" {
            return Err(format!(
                "释放 expected-HEAD ref transaction 失败: {}",
                line.trim()
            ));
        }
        drop(stdout);
        drop(stdin);

        let status = tokio::time::timeout(
            Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
            self.child.wait(),
        )
        .await
        .map_err(|_| "等待 expected-HEAD ref transaction 释放超时。".to_string())?
        .map_err(|error| format!("等待 expected-HEAD ref transaction 退出失败: {}", error))?;
        if !status.success() {
            return Err(format!(
                "expected-HEAD ref transaction 异常退出（{:?}）",
                status.code()
            ));
        }
        Ok(())
    }
}

async fn finish_with_expected_head_guard<T>(
    guard: ExpectedHeadRefGuard,
    result: Result<T, String>,
) -> Result<T, String> {
    let release = guard.release().await;
    finish_mutation_after_guard_release(result, release)
}

fn finish_mutation_after_guard_release<T>(
    result: Result<T, String>,
    release: Result<(), String>,
) -> Result<T, String> {
    match result {
        Err(error) => Err(error),
        Ok(value) => {
            if let Err(error) = release {
                // The mutation has already completed. `kill_on_drop` on the
                // guard's child still cleans up a failed release path, so a
                // cleanup failure must not be reported as a failed mutation.
                tracing::warn!(
                    "expected-HEAD ref transaction cleanup failed after successful mutation: {}",
                    error
                );
            }
            Ok(value)
        }
    }
}


pub async fn unstage_verified_entry_ref_guarded(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
) -> Result<(), String> {
    let guard = ExpectedHeadRefGuard::acquire(repo_path, expected_head).await?;
    let result = unstage_verified_entry(
        repo_path,
        path,
        old_path,
        expected_authority_id,
        expected_head,
    )
    .await;
    finish_with_expected_head_guard(guard, result).await
}

pub async fn discard_verified_entry_ref_guarded(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
) -> Result<AtomicDiscardResult, String> {
    let guard = ExpectedHeadRefGuard::acquire(repo_path, expected_head).await?;
    let result = discard_verified_entry(
        repo_path,
        path,
        old_path,
        expected_authority_id,
        expected_head,
    )
    .await;
    finish_with_expected_head_guard(guard, result).await
}

pub async fn discard_worktree_verified_entry_ref_guarded(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
) -> Result<AtomicDiscardResult, String> {
    let guard = ExpectedHeadRefGuard::acquire(repo_path, expected_head).await?;
    let result = discard_worktree_verified_entry(
        repo_path,
        path,
        old_path,
        expected_authority_id,
    )
    .await;
    finish_with_expected_head_guard(guard, result).await
}
