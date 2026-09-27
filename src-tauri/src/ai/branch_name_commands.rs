#[tauri::command]
pub async fn generate_ai_branch_names(
    request: AiBranchNameRequest,
    app: AppHandle,
) -> Result<AiBranchNameResult, AiUiError> {
    let request_id = normalize_request_id(&request.request_id)?;
    let request = AiBranchNameRequest {
        request_id: request_id.clone(),
        repo_path: request.repo_path,
        repo_name: request.repo_name.trim().to_string(),
        task_description: request.task_description.trim().to_string(),
        source_type: request.source_type.trim().to_string(),
        include_repository_context: request.include_repository_context,
    };
    validate_request(&request)?;
    let mut cancellation = register_request(&request_id).await?;
    emit_progress(
        &app,
        &request_id,
        "branch-name",
        "preparing",
        "preparing",
        "正在准备最少必要的 AI 命名输入…",
    );

    let operation = async {
        let stored = load_config(&app).await?;
        let (config, endpoint) = validate_and_normalize_config(stored)
            .map_err(|error| error.with_request_id(&request_id))?;
        let api_key = read_api_key().await?.ok_or_else(|| {
            AiUiError::new(
                "AI_NOT_CONFIGURED",
                "未配置 API Key",
                "请先在 AI 设置中保存 API Key；手动创建分支仍然可用。",
                false,
            )
            .with_request_id(&request_id)
        })?;
        let samples = if request.include_repository_context {
            emit_progress(
                &app,
                &request_id,
                "branch-name",
                "preparing",
                "reading-branch-style",
                "正在读取用户明确允许的有限分支名称样本…",
            );
            read_branch_samples(&request.repo_path)
                .await
                .map_err(|error| error.with_request_id(&request_id))?
        } else {
            Vec::new()
        };
        request_suggestions(&app, &request, &config, &endpoint, &api_key, &samples).await
    };

    let result = tokio::select! {
        _ = &mut cancellation => Err(AiUiError::cancelled(request_id.clone())),
        response = operation => response,
    };
    unregister_request(&request_id).await;
    match &result {
        Ok(_) => emit_progress(
            &app,
            &request_id,
            "branch-name",
            "completed",
            "completed",
            "分支名称建议已生成",
        ),
        Err(error) if error.code == "AI_CANCELLED" => emit_progress(
            &app,
            &request_id,
            "branch-name",
            "cancelled",
            "cancelled",
            "AI 分支命名已取消",
        ),
        Err(error) => emit_progress(
            &app,
            &request_id,
            "branch-name",
            "failed",
            "failed",
            &error.title,
        ),
    }
    result
}

#[tauri::command]
pub async fn cancel_ai_branch_name_request(
    request_id: String,
) -> Result<AiBranchNameCancelResult, AiUiError> {
    let request_id = normalize_request_id(&request_id)?;
    let sender = cancellation_registry().lock().await.remove(&request_id);
    let cancelled = sender
        .map(|sender| sender.send(()).is_ok())
        .unwrap_or(false);
    Ok(AiBranchNameCancelResult {
        request_id,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::{basic_candidate_is_safe, parse_suggestions, strip_json_fence};

    #[test]
    fn strips_markdown_fences_without_accepting_prose() {
        assert_eq!(
            strip_json_fence("```json\n{\"suggestions\":[]}\n```"),
            "{\"suggestions\":[]}"
        );
    }

    #[test]
    fn surrounding_prose_is_not_silently_accepted() {
        assert!(parse_suggestions(
            "Here are names: {\"suggestions\":[]}",
            "request_1",
        )
        .is_err());
    }

    #[test]
    fn rejects_obviously_unsafe_candidates() {
        assert!(basic_candidate_is_safe("feat/branch-name"));
        assert!(!basic_candidate_is_safe("bad branch"));
        assert!(!basic_candidate_is_safe("../escape"));
        assert!(!basic_candidate_is_safe("HEAD"));
    }

    #[test]
    fn deduplicates_candidates_before_returning_them() {
        let parsed = parse_suggestions(
            r#"{"suggestions":[{"name":"fix/example","reason":"one"},{"name":"fix/example","reason":"two"}]}"#,
            "request_1",
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
    }
}
