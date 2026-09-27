async fn request_suggestions(
    app: &AppHandle,
    request: &AiBranchNameRequest,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
    samples: &[String],
) -> Result<AiBranchNameResult, AiUiError> {
    let model = config.default_model.trim();
    if model.is_empty() {
        return Err(AiUiError::new(
            "AI_MODEL_NOT_FOUND",
            "未配置默认模型",
            "请先在 AI 设置中选择默认模型。",
            false,
        )
        .with_request_id(&request.request_id));
    }
    let (system_prompt, user_prompt) = build_prompt(request, config, samples);
    emit_progress(
        app,
        &request.request_id,
        "branch-name",
        "running",
        "generating",
        "正在生成分支名称建议…",
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds))
        .user_agent(format!("GitSync/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| {
            AiUiError::internal("无法创建 AI HTTP Client。")
                .with_request_id(&request.request_id)
        })?;
    let payload = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": 0.25,
        "max_tokens": 700,
        "stream": false
    });
    let response = client
        .post(endpoint.chat_completions_url.clone())
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| map_reqwest_error(error, &request.request_id))?;
    let status = response.status();
    let body = read_bounded_body(response, &request.request_id).await?;
    if !status.is_success() {
        return Err(map_http_error(status, &body, &request.request_id));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 响应格式无效",
            "Provider 未返回有效 JSON。",
            true,
        )
        .with_request_id(&request.request_id)
    })?;
    let content = extract_message_content(&value).ok_or_else(|| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 响应缺少建议",
            "Provider 响应中没有可用文本。",
            true,
        )
        .with_request_id(&request.request_id)
    })?;
    emit_progress(
        app,
        &request.request_id,
        "branch-name",
        "validating",
        "validating",
        "正在验证 AI 候选格式…",
    );
    let suggestions = parse_suggestions(&content, &request.request_id)?;
    Ok(AiBranchNameResult {
        request_id: request.request_id.clone(),
        model: model.to_string(),
        provider_host: endpoint.provider_host.clone(),
        suggestions,
        used_repository_context: request.include_repository_context,
        branch_sample_count: samples.len(),
    })
}
