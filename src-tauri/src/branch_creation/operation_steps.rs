async fn execute_pending_steps(
    repo_path: &str,
    journal_path_value: &Path,
    journal: &mut BranchCreationJournal,
    allow_switch_attempt: bool,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let signature = journal.signature.clone();

    if journal.local_state == "pending" {
        clear_step_error(journal, "local");
        emit_operation_progress(
            app,
            &journal.request_id,
            "running",
            "creating-local",
            "正在从已确认的提交创建本地分支…",
        );
        match create_local_branch_atomically(repo_path, &signature, &journal.request_id).await {
            Ok(state) if state == "created" => {
                journal.local_state = "created".to_string();
                clear_step_error(journal, "local");
                persist_journal(journal_path_value, journal)?;
            }
            Ok(_) => {
                journal.local_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "local",
                    "无法证明同名本地分支由本次操作创建；已停止后续步骤，避免误认或覆盖。",
                );
                persist_journal(journal_path_value, journal)?;
                return Ok(());
            }
            Err(error) => {
                journal.local_state = "failed".to_string();
                set_step_error(journal, "local", error);
                persist_journal(journal_path_value, journal)?;
                return Ok(());
            }
        }
    }

    if journal.local_state != "created" {
        return Ok(());
    }

    if signature.switch_after_create
        && allow_switch_attempt
        && journal.switch_state.starts_with("pending")
    {
        clear_step_error(journal, "switch");
        emit_operation_progress(
            app,
            &journal.request_id,
            "running",
            "switching",
            "本地分支已创建，正在按用户选择切换…",
        );
        match switch_to_created_branch(repo_path, &signature.branch_name).await {
            Ok(()) => {
                journal.switch_state = "switched".to_string();
                clear_step_error(journal, "switch");
            }
            Err(error) => match current_branch(repo_path).await {
                Ok(Some(current)) if current == signature.branch_name => {
                    journal.switch_state = "switched".to_string();
                    clear_step_error(journal, "switch");
                    journal.warnings.push(
                        "切换命令的直接结果不可用，但仓库当前已在新分支；已按真实状态确认切换完成。"
                            .to_string(),
                    );
                }
                Ok(_) => {
                    journal.switch_state = "failed".to_string();
                    set_step_error(journal, "switch", error);
                }
                Err(reconcile_error) => {
                    journal.switch_state = "unknown".to_string();
                    set_step_error(
                        journal,
                        "switch",
                        format!(
                            "{}；并且无法确认当前实际分支: {}",
                            error, reconcile_error
                        ),
                    );
                }
            },
        }
        persist_journal(journal_path_value, journal)?;
    } else if !signature.switch_after_create {
        journal.switch_state = "not-requested".to_string();
        clear_step_error(journal, "switch");
    }

    if !signature.publish {
        journal.remote_state = "not-requested".to_string();
        journal.tracking_state = "not-requested".to_string();
        clear_step_error(journal, "publish");
        clear_step_error(journal, "tracking");
        persist_journal(journal_path_value, journal)?;
        return Ok(());
    }

    let remote = signature
        .target_remote
        .as_deref()
        .ok_or_else(|| "发布操作缺少目标远端。".to_string())?;

    if matches!(journal.remote_state.as_str(), "pending" | "failed") {
        clear_step_error(journal, "publish");
        emit_operation_progress(
            app,
            &journal.request_id,
            "running",
            "publishing",
            "正在确认远端同名分支并发布新分支…",
        );
        match publish_new_branch(
            repo_path,
            remote,
            &signature.branch_name,
            &signature.source_commit,
        )
        .await
        {
            Ok(state) if state == "created" => {
                journal.remote_state = "created".to_string();
                clear_step_error(journal, "publish");
            }
            Ok(state) if state == "failed" => {
                journal.remote_state = "failed".to_string();
                set_step_error(
                    journal,
                    "publish",
                    format!("本地分支已经创建，但发布到远端 {} 尚未完成。", remote),
                );
            }
            Ok(state) if state == "conflict" => {
                journal.remote_state = "conflict".to_string();
                set_step_error(
                    journal,
                    "publish",
                    format!(
                        "远端 {}/{} 已由其他操作创建；不会覆盖或接管。",
                        remote, signature.branch_name
                    ),
                );
            }
            Ok(_) => {
                journal.remote_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "publish",
                    format!(
                        "无法确认远端 {}/{} 是否由本次发布创建；请先刷新真实状态，不能盲目重试。",
                        remote, signature.branch_name
                    ),
                );
            }
            Err(error) => {
                journal.remote_state = "unknown".to_string();
                set_step_error(journal, "publish", error);
            }
        }
        persist_journal(journal_path_value, journal)?;
    }

    if journal.remote_state == "created" && journal.tracking_state != "configured" {
        clear_step_error(journal, "tracking");
        emit_operation_progress(
            app,
            &journal.request_id,
            "running",
            "configuring-tracking",
            "远端分支已创建，正在建立新分支自己的远端关系…",
        );
        let expected_upstream = format!("{}/{}", remote, signature.branch_name);
        match configured_upstream(repo_path, &signature.branch_name).await {
            Ok(Some(current)) if current == expected_upstream => {
                journal.tracking_state = "configured".to_string();
                clear_step_error(journal, "tracking");
            }
            Ok(_) => match configure_tracking(repo_path, remote, &signature.branch_name).await {
                Ok(()) => {
                    journal.tracking_state = "configured".to_string();
                    clear_step_error(journal, "tracking");
                }
                Err(error) => match configured_upstream(repo_path, &signature.branch_name).await {
                    Ok(Some(current)) if current == expected_upstream => {
                        journal.tracking_state = "configured".to_string();
                        clear_step_error(journal, "tracking");
                        journal.warnings.push(
                            "远端关系命令的直接结果不可用，但当前 upstream 已与目标一致；已按真实状态确认完成。"
                                .to_string(),
                        );
                    }
                    Ok(_) => {
                        journal.tracking_state = "failed".to_string();
                        set_step_error(journal, "tracking", error);
                    }
                    Err(reconcile_error) => {
                        journal.tracking_state = "unknown".to_string();
                        set_step_error(
                            journal,
                            "tracking",
                            format!(
                                "{}；并且无法确认当前 upstream: {}",
                                error, reconcile_error
                            ),
                        );
                    }
                },
            },
            Err(error) => {
                journal.tracking_state = "unknown".to_string();
                set_step_error(
                    journal,
                    "tracking",
                    format!(
                        "远端分支已经创建，但无法确认新分支当前的远端关系: {}",
                        error
                    ),
                );
            }
        }
        persist_journal(journal_path_value, journal)?;
    }

    Ok(())
}
