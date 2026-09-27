const STEP_ERROR_PREFIX: &str = "[branch-create-step:";

fn step_error_marker(step: &str) -> String {
    format!("{}{}] ", STEP_ERROR_PREFIX, step)
}

fn clear_step_error(journal: &mut BranchCreationJournal, step: &str) {
    let marker = step_error_marker(step);
    journal.errors.retain(|error| !error.starts_with(marker.as_str()));
}

fn set_step_error(journal: &mut BranchCreationJournal, step: &str, message: impl Into<String>) {
    clear_step_error(journal, step);
    journal
        .errors
        .push(format!("{}{}", step_error_marker(step), message.into()));
}

fn display_error(error: &str) -> String {
    if let Some(rest) = error.strip_prefix(STEP_ERROR_PREFIX) {
        if let Some((_, message)) = rest.split_once("] ") {
            return message.to_string();
        }
    }
    error.to_string()
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

/// Reconciles Git state without changing the repository, but may persist the
/// GitSync operation journal; callers therefore require the mutation lease.
async fn reconcile_journal_and_persist_without_repo_mutation(
    repo_path: &str,
    journal_path_value: &Path,
    journal: &mut BranchCreationJournal,
) -> Result<(), String> {
    let signature = journal.signature.clone();
    let previous = serde_json::to_string(journal).unwrap_or_default();

    if matches!(journal.local_state.as_str(), "pending" | "absent" | "created" | "unknown") {
        let previous_local_state = journal.local_state.clone();
        match reconcile_local_creation(repo_path, &signature, journal.request_id.as_str()).await {
            Ok(state) if state == "created" => {
                journal.local_state = "created".to_string();
                clear_step_error(journal, "local");
            }
            Ok(state) if state == "absent" && matches!(previous_local_state.as_str(), "pending" | "absent") => {
                // The durable operation identity exists and the target ref is still absent. This is
                // a provably unstarted local step, not an unknown result. Explicit resume may safely
                // continue because the atomic ref transaction will also verify the source commit.
                journal.local_state = "pending".to_string();
                clear_step_error(journal, "local");
            }
            Ok(_) => {
                journal.local_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "local",
                    "无法证明当前同名本地分支由原请求创建，或原本已确认的分支已经消失；不会覆盖或重新创建。",
                );
            }
            Err(error) => {
                journal.local_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "local",
                    format!("无法确认本地分支是否由原请求创建: {}", error),
                );
            }
        }
    }

    if signature.switch_after_create {
        match current_branch(repo_path).await {
            Ok(Some(current)) if current == signature.branch_name => {
                journal.switch_state = "switched".to_string();
                clear_step_error(journal, "switch");
            }
            Ok(_) if journal.switch_state == "switched" => {
                journal.switch_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "switch",
                    "仓库当前已不在新分支；无法把原切换结果继续视为当前状态。",
                );
            }
            Ok(_) => {}
            Err(error) if journal.switch_state == "switched" => {
                journal.switch_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "switch",
                    format!("无法确认当前实际分支: {}", error),
                );
            }
            Err(_) => {}
        }
    }

    if signature.publish {
        if let Some(remote) = signature.target_remote.as_deref() {
            let remote_state = journal.remote_state.clone();
            match remote_state.as_str() {
                "created" => match ls_remote_branch(repo_path, remote, &signature.branch_name).await {
                    Ok(Some(hash)) if hash == signature.source_commit => {
                        clear_step_error(journal, "publish");
                    }
                    Ok(Some(_)) => {
                        journal.remote_state = "unknown".to_string();
                        set_step_error(
                            journal,
                            "publish",
                            "原操作创建的远端分支当前已指向其他提交；不会覆盖外部变化。",
                        );
                    }
                    Ok(None) => {
                        journal.remote_state = "unknown".to_string();
                        set_step_error(
                            journal,
                            "publish",
                            "原操作曾确认远端分支已创建，但当前远端已不存在；不会自动重新发布。",
                        );
                    }
                    Err(error) => {
                        journal.remote_state = "unknown".to_string();
                        set_step_error(
                            journal,
                            "publish",
                            format!("无法重新确认远端分支: {}", error),
                        );
                    }
                },
                "pending" | "failed" => match ls_remote_branch(repo_path, remote, &signature.branch_name).await {
                    Ok(None) => {}
                    Ok(Some(_)) => {
                        journal.remote_state = "unknown".to_string();
                        set_step_error(
                            journal,
                            "publish",
                            "远端当前存在同名分支，但无法证明它由原请求创建；不会覆盖、接管或重复发布。",
                        );
                    }
                    Err(error) => {
                        journal.remote_state = "unknown".to_string();
                        set_step_error(
                            journal,
                            "publish",
                            format!("无法确认远端同名分支状态，不能安全重试发布: {}", error),
                        );
                    }
                },
                _ => {}
            }

            let expected_upstream = format!("{}/{}", remote, signature.branch_name);
            let tracking_state = journal.tracking_state.clone();
            match configured_upstream(repo_path, &signature.branch_name).await {
                Ok(Some(current)) if current == expected_upstream => {
                    journal.tracking_state = "configured".to_string();
                    clear_step_error(journal, "tracking");
                }
                Ok(_) if tracking_state == "configured" => {
                    journal.tracking_state = "unknown".to_string();
                    set_step_error(
                        journal,
                        "tracking",
                        "新分支当前的 upstream 已不再与原操作目标一致。",
                    );
                }
                Ok(_) => {}
                Err(error) if tracking_state == "configured" => {
                    journal.tracking_state = "unknown".to_string();
                    set_step_error(
                        journal,
                        "tracking",
                        format!("无法重新确认新分支的 upstream: {}", error),
                    );
                }
                Err(_) => {}
            }
        }
    }

    if serde_json::to_string(journal).unwrap_or_default() != previous {
        persist_journal(journal_path_value, journal)?;
    }
    Ok(())
}

async fn build_result(
    repo_path: &str,
    journal: &BranchCreationJournal,
) -> BranchCreationOperationResult {
    let signature = &journal.signature;
    let mut warnings = Vec::new();
    for warning in &journal.warnings {
        push_unique(&mut warnings, warning.clone());
    }
    let current = match current_branch(repo_path).await {
        Ok(value) => value,
        Err(error) => {
            push_unique(&mut warnings, format!("无法读取当前实际分支: {}", error));
            None
        }
    };
    let dirty = match read_worktree_status(repo_path).await {
        Ok((value, _, _)) => value,
        Err(error) => {
            push_unique(&mut warnings, format!("无法重新读取工作区状态: {}", error));
            journal.worktree_was_dirty
        }
    };
    let local_created = journal.local_state == "created";
    let switched_for_completion =
        !signature.switch_after_create || journal.switch_state == "switched";
    let remote_created_for_completion =
        !signature.publish || journal.remote_state == "created";
    let tracking_configured_for_completion =
        !signature.publish || journal.tracking_state == "configured";
    let result_needs_confirmation = journal.local_state == "unknown"
        || journal.switch_state == "unknown"
        || journal.remote_state == "unknown"
        || journal.tracking_state == "unknown";

    let mut completed_steps = Vec::new();
    let mut pending_steps = Vec::new();
    let mut retryable_steps = Vec::new();
    if local_created && signature.switch_after_create && journal.switch_state == "failed" {
        push_unique(
            &mut warnings,
            "本地分支已经保留；可以将当前结果按“只创建”处理，切换失败不会删除分支或未提交修改。"
                .to_string(),
        );
    }

    if local_created {
        completed_steps.push("本地分支已创建".to_string());
    } else {
        pending_steps.push("本地分支尚未确认创建".to_string());
        if journal.local_state == "pending" {
            retryable_steps.push("local".to_string());
        }
    }
    if signature.switch_after_create {
        if journal.switch_state == "switched" {
            completed_steps.push("已切换到新分支".to_string());
        } else {
            pending_steps.push("尚未切换到新分支".to_string());
        }
    }
    if signature.publish {
        if journal.remote_state == "created" {
            completed_steps.push("远端分支已创建".to_string());
        } else {
            pending_steps.push("远端发布尚未完成".to_string());
            if matches!(journal.remote_state.as_str(), "pending" | "failed") && local_created {
                retryable_steps.push("publish".to_string());
            }
        }
        if journal.tracking_state == "configured" {
            completed_steps.push("远端关系已建立".to_string());
        } else {
            pending_steps.push("远端关系尚未完成".to_string());
            if journal.remote_state == "created"
                && matches!(journal.tracking_state.as_str(), "pending" | "failed")
            {
                retryable_steps.push("tracking".to_string());
            }
        }
    }

    let complete = local_created
        && switched_for_completion
        && remote_created_for_completion
        && tracking_configured_for_completion;
    let status = if result_needs_confirmation {
        "unknown"
    } else if complete {
        "complete"
    } else if local_created {
        "partial"
    } else {
        "failed"
    }
    .to_string();

    let message = match status.as_str() {
        "complete" => "分支创建操作已完整完成。".to_string(),
        "partial" => "分支创建已部分完成；已完成步骤会保留，只能重试尚未完成的部分。".to_string(),
        "unknown" => "部分结果无法确认；不会猜测成功，也不会盲目重复执行。".to_string(),
        _ if !retryable_steps.is_empty() => {
            "分支尚未创建，但原操作有可证明未开始的步骤；可以显式继续。".to_string()
        }
        _ => "分支创建未完成。".to_string(),
    };

    let mut errors = Vec::new();
    for error in &journal.errors {
        push_unique(&mut errors, display_error(error));
    }

    BranchCreationOperationResult {
        request_id: journal.request_id.clone(),
        status,
        branch_name: signature.branch_name.clone(),
        source_ref: signature.source_ref.clone(),
        source_commit: signature.source_commit.clone(),
        local_created,
        switched: signature.switch_after_create && journal.switch_state == "switched",
        current_branch: current,
        worktree_was_dirty: journal.worktree_was_dirty,
        worktree_is_dirty: dirty,
        remote_created: signature.publish && journal.remote_state == "created",
        tracking_configured: signature.publish && journal.tracking_state == "configured",
        target_remote: signature.target_remote.clone(),
        completed_steps,
        pending_steps,
        retryable_steps,
        warnings,
        errors,
        result_needs_confirmation,
        message,
    }
}
