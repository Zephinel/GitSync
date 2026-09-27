use crate::ai::client::emit_progress;
use crate::ai::errors::AiUiError;
use crate::ai::prompts::{
    commit_message_system_prompt, commit_message_user_prompt, normalize_generated_commit_message,
};
use crate::ai::provider::NormalizedAiEndpoint;
use crate::ai::sanitize::sanitize_provider_error_message;
use crate::ai::schema::{AiCommitMessageResult, AiProviderConfig};
use crate::ai::snapshot::AiCommitSnapshot;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_COMMIT_RESPONSE_BYTES: usize = 256 * 1024;

pub async fn generate_commit_message(
    app: &tauri::AppHandle,
    request_id: &str,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
    snapshot: AiCommitSnapshot,
) -> Result<AiCommitMessageResult, AiUiError> {
    let model = resolve_commit_model(config)?;
    emit_progress(
        app,
        request_id,
        "commit-message",
        "running",
        "generating",
        "正在生成提交信息…",
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds))
        .user_agent(format!("GitSync/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| internal_error(request_id, "无法创建 AI HTTP Client。"))?;
    let payload = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": commit_message_system_prompt(config)
            },
            {
                "role": "user",
                "content": commit_message_user_prompt(&snapshot)
            }
        ],
        "temperature": 0.2,
        "stream": false
    });

    let response = client
        .post(endpoint.chat_completions_url.clone())
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| map_reqwest_error(error, request_id))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_COMMIT_RESPONSE_BYTES as u64)
    {
        return Err(response_too_large(status, request_id));
    }
    let body = read_bounded_body(response, request_id).await?;
    if !status.is_success() {
        return Err(map_http_error(status, &body, request_id));
    }

    emit_progress(
        app,
        request_id,
        "commit-message",
        "validating",
        "validating",
        "正在验证生成结果…",
    );
    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 响应格式无效",
            "Provider 未返回有效 JSON。",
            true,
        )
        .with_request_id(request_id)
    })?;
    let raw_message = extract_message_content(&value).ok_or_else(|| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 响应缺少提交信息",
            "Provider 响应中没有可用的文本内容。",
            true,
        )
        .with_request_id(request_id)
    })?;
    let message = normalize_generated_commit_message(&raw_message, config.commit_style)
        .map_err(|error| error.with_request_id(request_id))?;

    Ok(AiCommitMessageResult {
        request_id: request_id.to_string(),
        message,
        model: resolve_commit_model(config)?.to_string(),
        provider_host: endpoint.provider_host.clone(),
        selected_file_count: snapshot.selected_file_count,
        included_file_count: snapshot.included_file_count,
        excluded_files: snapshot.excluded_files,
        summary_only_files: snapshot.summary_only_files,
        binary_files: snapshot.binary_files,
        sanitized_bytes: snapshot.sanitized_bytes,
        redacted_line_count: snapshot.redacted_line_count,
        recent_subject_count: snapshot.recent_subjects.len(),
        snapshot_fingerprint: snapshot.fingerprint,
    })
}

fn resolve_commit_model(config: &AiProviderConfig) -> Result<&str, AiUiError> {
    let model = config
        .commit_model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or(config.default_model.as_str())
        .trim();
    if model.is_empty() {
        return Err(AiUiError::new(
            "AI_MODEL_NOT_FOUND",
            "未配置提交信息模型",
            "请先配置默认模型或提交信息独立模型。",
            false,
        ));
    }
    Ok(model)
}

async fn read_bounded_body(
    mut response: reqwest::Response,
    request_id: &str,
) -> Result<Vec<u8>, AiUiError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| map_reqwest_error(error, request_id))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_COMMIT_RESPONSE_BYTES {
            return Err(response_too_large(StatusCode::OK, request_id));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn extract_message_content(value: &Value) -> Option<String> {
    let choice = value.get("choices")?.as_array()?.first()?;
    if let Some(content) = choice
        .get("message")
        .and_then(|message| message.get("content"))
    {
        if let Some(text) = content.as_str() {
            return Some(text.to_string());
        }
        if let Some(parts) = content.as_array() {
            let joined = parts
                .iter()
                .filter_map(|part| {
                    part.as_str()
                        .map(str::to_string)
                        .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
                })
                .collect::<Vec<_>>()
                .join("");
            if !joined.is_empty() {
                return Some(joined);
            }
        }
    }
    choice
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn map_reqwest_error(error: reqwest::Error, request_id: &str) -> AiUiError {
    let lower = error.to_string().to_lowercase();
    if error.is_timeout() {
        return AiUiError::new(
            "AI_TIMEOUT",
            "AI 请求超时",
            "Provider 在配置的超时时间内没有生成提交信息。",
            true,
        )
        .with_request_id(request_id);
    }
    if lower.contains("certificate") || lower.contains("tls") {
        return AiUiError::new(
            "AI_TLS_FAILED",
            "TLS 连接失败",
            "无法验证 AI Provider 的安全连接。",
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
    let provider_message = provider_error_message(body);
    let (code, title, default_message, retryable) = match status.as_u16() {
        401 => (
            "AI_AUTH_FAILED",
            "API Key 无效",
            "Provider 拒绝了当前 API Key。",
            false,
        ),
        403 => (
            "AI_AUTH_FAILED",
            "AI 权限不足",
            "当前 API Key 没有访问提交信息模型的权限。",
            false,
        ),
        404 => (
            "AI_MODEL_NOT_FOUND",
            "模型或 Endpoint 不存在",
            "请检查 Endpoint 和提交信息模型。",
            false,
        ),
        408 | 504 => (
            "AI_TIMEOUT",
            "AI 请求超时",
            "Provider 未能及时完成提交信息生成。",
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
        provider_message.unwrap_or_else(|| default_message.to_string()),
        retryable,
    )
    .with_provider_status(status.as_u16())
    .with_request_id(request_id)
}

fn provider_error_message(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let message = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))?;
    sanitize_provider_error_message(message)
}

fn response_too_large(status: StatusCode, request_id: &str) -> AiUiError {
    AiUiError::new(
        "AI_RESPONSE_TOO_LARGE",
        "AI 响应过大",
        "Provider 返回的提交信息响应超过安全限制。",
        false,
    )
    .with_provider_status(status.as_u16())
    .with_request_id(request_id)
}

fn internal_error(request_id: &str, message: &str) -> AiUiError {
    AiUiError::internal(message).with_request_id(request_id)
}

#[cfg(test)]
mod tests {
    use super::{extract_message_content, resolve_commit_model};
    use crate::ai::schema::AiProviderConfig;
    use serde_json::json;

    #[test]
    fn commit_model_override_precedes_default_model() {
        let config = AiProviderConfig {
            default_model: "default-model".to_string(),
            commit_model: Some("commit-model".to_string()),
            ..AiProviderConfig::default()
        };
        assert_eq!(resolve_commit_model(&config).unwrap(), "commit-model");
    }

    #[test]
    fn extracts_common_openai_compatible_text_shapes() {
        assert_eq!(
            extract_message_content(&json!({
                "choices": [{ "message": { "content": "fix: example" } }]
            }))
            .as_deref(),
            Some("fix: example")
        );
        assert_eq!(
            extract_message_content(&json!({
                "choices": [{ "message": { "content": [{ "text": "feat: array" }] } }]
            }))
            .as_deref(),
            Some("feat: array")
        );
    }
}
