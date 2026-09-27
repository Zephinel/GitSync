async fn read_bounded_body(
    mut response: reqwest::Response,
    request_id: &str,
) -> Result<Vec<u8>, AiUiError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(response_too_large(response.status(), request_id));
    }
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| map_reqwest_error(error, request_id))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(response_too_large(status, request_id));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn map_reqwest_error(error: reqwest::Error, request_id: &str) -> AiUiError {
    if error.is_timeout() {
        return AiUiError::new(
            "AI_TIMEOUT",
            "AI 请求超时",
            "Provider 在配置的超时时间内没有返回分支名称建议。",
            true,
        )
        .with_request_id(request_id);
    }
    AiUiError::new(
        "AI_CONNECTION_FAILED",
        if error.is_connect() {
            "无法连接 AI Provider"
        } else {
            "AI 请求失败"
        },
        "请检查 Endpoint、网络和代理设置后重试。",
        true,
    )
    .with_request_id(request_id)
}

fn map_http_error(status: StatusCode, body: &[u8], request_id: &str) -> AiUiError {
    let provider_message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .and_then(sanitize_provider_error_message)
        });
    let (code, title, message, retryable) = match status.as_u16() {
        401 | 403 => (
            "AI_AUTH_FAILED",
            "AI 权限验证失败",
            "当前 API Key 无法访问配置的模型。",
            false,
        ),
        404 => (
            "AI_MODEL_NOT_FOUND",
            "模型或 Endpoint 不存在",
            "请检查 Endpoint 和默认模型。",
            false,
        ),
        408 | 504 => (
            "AI_TIMEOUT",
            "AI 请求超时",
            "Provider 未能及时生成分支名称建议。",
            true,
        ),
        429 => (
            "AI_RATE_LIMITED",
            "AI Provider 限流",
            "请求过于频繁或当前额度不足，请稍后重试。",
            true,
        ),
        500..=599 => (
            "AI_CONNECTION_FAILED",
            "AI Provider 暂时不可用",
            "Provider 返回服务器错误，请稍后重试。",
            true,
        ),
        _ => (
            "AI_CONNECTION_FAILED",
            "AI Provider 拒绝请求",
            "Provider 返回了无法处理的错误。",
            false,
        ),
    };
    AiUiError::new(
        code,
        title,
        provider_message.unwrap_or_else(|| message.to_string()),
        retryable,
    )
    .with_provider_status(status.as_u16())
    .with_request_id(request_id)
}

fn response_too_large(status: StatusCode, request_id: &str) -> AiUiError {
    AiUiError::new(
        "AI_RESPONSE_TOO_LARGE",
        "AI 响应过大",
        "Provider 返回的分支命名响应超过安全限制。",
        false,
    )
    .with_provider_status(status.as_u16())
    .with_request_id(request_id)
}
