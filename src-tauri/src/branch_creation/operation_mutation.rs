async fn reflog_proves_creation(
    repo_path: &str,
    branch_name: &str,
    request_id: &str,
) -> Result<bool, String> {
    let full_ref = format!("refs/heads/{}", branch_name);
    let output = run_git_output(
        repo_path,
        &[
            "reflog",
            "show",
            "--format=%gs",
            "-n",
            "1",
            full_ref.as_str(),
        ],
        GIT_META_TIMEOUT_MS,
    )
    .await?;
    let marker = format!("GitSync branch-create {}", request_id);
    Ok(output.success && output.stdout.trim() == marker)
}

async fn reconcile_local_creation(
    repo_path: &str,
    signature: &BranchCreationOperationSignature,
    request_id: &str,
) -> Result<String, String> {
    let local_ref = format!("refs/heads/{}", signature.branch_name);
    let actual = resolve_ref(repo_path, local_ref.as_str()).await?;
    match actual {
        None => Ok("absent".to_string()),
        Some(hash)
            if hash == signature.source_commit
                && reflog_proves_creation(repo_path, &signature.branch_name, request_id).await? =>
        {
            Ok("created".to_string())
        }
        Some(_) => Ok("unknown".to_string()),
    }
}

async fn create_local_branch_atomically(
    repo_path: &str,
    signature: &BranchCreationOperationSignature,
    request_id: &str,
) -> Result<String, String> {
    let local_ref = format!("refs/heads/{}", signature.branch_name);
    let input = format!(
        "start\nverify {} {}\ncreate {} {}\nprepare\ncommit\n",
        signature.source_ref, signature.source_commit, local_ref, signature.source_commit
    );
    let message = format!("GitSync branch-create {}", request_id);
    let output = run_git_with_input(
        repo_path,
        &["update-ref", "--stdin", "--create-reflog", "-m", message.as_str()],
        input.as_str(),
        GIT_UPDATE_TIMEOUT_MS,
    )
    .await;

    match output {
        Ok(result) if result.success => Ok("created".to_string()),
        Ok(result) => {
            let reconciled = reconcile_local_creation(repo_path, signature, request_id).await?;
            if reconciled == "created" {
                Ok("created".to_string())
            } else if reconciled == "unknown" {
                Ok("unknown".to_string())
            } else {
                let detail = if result.stderr.is_empty() {
                    result.stdout
                } else {
                    result.stderr
                };
                Err(if detail.is_empty() {
                    "本地分支创建失败；来源或目标引用可能已经变化。".to_string()
                } else {
                    format!("本地分支创建失败: {}", detail)
                })
            }
        }
        Err(_) => reconcile_local_creation(repo_path, signature, request_id).await,
    }
}

async fn switch_to_created_branch(
    repo_path: &str,
    branch_name: &str,
) -> Result<(), String> {
    let output = run_git_mutation_output(
        repo_path,
        &["switch", "--", branch_name],
        GIT_SWITCH_TIMEOUT_MS,
    )
    .await?;
    if output.success {
        Ok(())
    } else {
        let detail = if output.stderr.is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        Err(if detail.is_empty() {
            "新分支已经创建，但切换没有成功。当前未提交修改保持原状。".to_string()
        } else {
            format!("新分支已经创建，但切换没有成功: {}", detail)
        })
    }
}

fn push_created_new_branch(output: &GitCommandOutput) -> bool {
    if !output.success {
        return false;
    }
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .any(|line| {
            let normalized = line.trim_start();
            normalized.starts_with('*') && normalized.contains("refs/heads/")
        })
}

async fn publish_new_branch(
    repo_path: &str,
    remote: &str,
    branch_name: &str,
    expected_commit: &str,
) -> Result<String, String> {
    if ls_remote_branch(repo_path, remote, branch_name).await?.is_some() {
        return Ok("conflict".to_string());
    }
    let refspec = format!(
        "refs/heads/{}:refs/heads/{}",
        branch_name, branch_name
    );
    let output = run_git_mutation_output(
        repo_path,
        &["push", "--porcelain", remote, refspec.as_str()],
        GIT_PUSH_TIMEOUT_MS,
    )
    .await;

    match output {
        Ok(result) if push_created_new_branch(&result) => Ok("created".to_string()),
        Ok(_) | Err(_) => match ls_remote_branch(repo_path, remote, branch_name).await {
            Ok(None) => Ok("failed".to_string()),
            Ok(Some(hash)) if hash == expected_commit => Ok("unknown".to_string()),
            Ok(Some(_)) => Ok("conflict".to_string()),
            Err(_) => Ok("unknown".to_string()),
        },
    }
}

async fn configured_upstream(repo_path: &str, branch_name: &str) -> Result<Option<String>, String> {
    read_upstream(repo_path, branch_name).await
}

async fn configure_tracking(
    repo_path: &str,
    remote: &str,
    branch_name: &str,
) -> Result<(), String> {
    // A successful explicit push does not guarantee every Git configuration has already
    // materialized the corresponding remote-tracking ref. Refresh exactly the new branch
    // before binding upstream so a tracking-only retry can make deterministic progress.
    fetch_remote_branch(repo_path, remote, branch_name)
        .await
        .map_err(|error| {
            format!(
                "远端分支已经创建，但刷新 {}/{} 失败，尚未建立远端关系: {}",
                remote, branch_name, error
            )
        })?;
    let upstream = format!("{}/{}", remote, branch_name);
    let output = run_git_mutation_output(
        repo_path,
        &[
            "branch",
            "--set-upstream-to",
            upstream.as_str(),
            "--",
            branch_name,
        ],
        GIT_UPDATE_TIMEOUT_MS,
    )
    .await?;
    if output.success {
        Ok(())
    } else {
        Err(format!(
            "远端分支已经创建，但未能为本地 {} 建立自己的远端关系。",
            branch_name
        ))
    }
}
