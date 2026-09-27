use crate::ai::errors::AiUiError;
use crate::ai::prompts::connection_test_prompt;
use crate::ai::provider::NormalizedAiEndpoint;
use crate::ai::sanitize::sanitize_provider_error_message;
use crate::ai::schema::{
    AiConnectionTestResult, AiModelListResult, AiProgressEvent, AiProviderConfig,
};
use crate::ai::AI_PROGRESS_EVENT;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::Emitter;

const MAX_AI_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_MODEL_LIST_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_MODEL_COUNT: usize = 2_000;
const MAX_MODEL_ID_CHARS: usize = 256;

fn build_client(config: &AiProviderConfig, request_id: &str) -> Result<reqwest::Client, AiUiError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds))
        .user_agent(format!("GitSync/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| {
            AiUiError::internal(format!("创建 AI HTTP Client 失败: {error}"))
                .with_request_id(request_id)
        })
}

pub async fn test_connection(
    app: &tauri::AppHandle,
    request_id: &str,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
) -> Result<AiConnectionTestResult, AiUiError> {
    emit_progress(
        app,
        request_id,
        "connection-test",
        "running",
        "connecting",
        "正在连接 AI Provider…",
    );
    perform_connection_request(Some(app), request_id, config, endpoint, api_key).await
}

pub async fn list_models(
    app: &tauri::AppHandle,
    request_id: &str,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
) -> Result<AiModelListResult, AiUiError> {
    emit_progress(
        app,
        request_id,
        "model-list",
        "running",
        "fetching-models",
        "正在从 Provider 拉取模型…",
    );
    perform_model_list_request(Some(app), request_id, config, endpoint, api_key).await
}

async fn perform_connection_request(
    app: Option<&tauri::AppHandle>,
    request_id: &str,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
) -> Result<AiConnectionTestResult, AiUiError> {
    let client = build_client(config, request_id)?;
    let payload = json!({
        "model": config.default_model.as_str(),
        "messages": [
            {
                "role": "system",
                "content": "This is a provider connectivity check. Follow the user instruction exactly."
            },
            {
                "role": "user",
                "content": connection_test_prompt()
            }
        ],
        "temperature": 0,
        "stream": false
    });

    let started = Instant::now();
    let response = client
        .post(endpoint.chat_completions_url.clone())
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| map_reqwest_error(error, request_id))?;

    let status = response.status();
    reject_declared_oversize(
        response.content_length(),
        MAX_AI_RESPONSE_BYTES,
        status,
        request_id,
    )?;
    let body = read_bounded_body(response, request_id, MAX_AI_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(map_http_error(status, &body, request_id));
    }

    if let Some(app) = app {
        emit_progress(
            app,
            request_id,
            "connection-test",
            "validating",
            "validating",
            "正在验证模型响应…",
        );
    }

    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 响应格式无效",
            "Provider 未返回有效的 JSON 响应。",
            true,
        )
        .with_request_id(request_id)
    })?;
    let content = extract_message_content(&value).ok_or_else(|| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 响应缺少内容",
            "Provider 响应中未找到可用的模型输出。",
            true,
        )
        .with_request_id(request_id)
    })?;
    if content.trim().is_empty() {
        return Err(AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 返回空内容",
            "模型连接成功，但返回了空内容。",
            true,
        )
        .with_request_id(request_id));
    }

    Ok(AiConnectionTestResult {
        request_id: request_id.to_string(),
        model: config.default_model.clone(),
        provider_host: endpoint.provider_host.clone(),
        latency_ms: started.elapsed().as_millis(),
    })
}

async fn perform_model_list_request(
    app: Option<&tauri::AppHandle>,
    request_id: &str,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
) -> Result<AiModelListResult, AiUiError> {
    let client = build_client(config, request_id)?;
    let response = client
        .get(endpoint.models_url.clone())
        .bearer_auth(api_key)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| map_reqwest_error(error, request_id))?;

    let status = response.status();
    reject_declared_oversize(
        response.content_length(),
        MAX_MODEL_LIST_RESPONSE_BYTES,
        status,
        request_id,
    )?;
    let body = read_bounded_body(response, request_id, MAX_MODEL_LIST_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(map_http_error(status, &body, request_id));
    }

    if let Some(app) = app {
        emit_progress(
            app,
            request_id,
            "model-list",
            "validating",
            "parsing-models",
            "正在整理可用模型…",
        );
    }

    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "模型列表格式无效",
            "Provider 的 models 接口未返回有效 JSON。",
            true,
        )
        .with_request_id(request_id)
    })?;
    let (models, truncated) = extract_model_ids(&value, api_key);
    if models.is_empty() {
        return Err(AiUiError::new(
            "AI_INVALID_RESPONSE",
            "没有可用模型",
            "Provider 的 models 接口没有返回可选择的模型；仍可手动输入模型名称。",
            true,
        )
        .with_request_id(request_id));
    }

    Ok(AiModelListResult {
        request_id: request_id.to_string(),
        provider_host: endpoint.provider_host.clone(),
        models,
        truncated,
    })
}

fn reject_declared_oversize(
    content_length: Option<u64>,
    max_bytes: usize,
    status: StatusCode,
    request_id: &str,
) -> Result<(), AiUiError> {
    if content_length.is_some_and(|length| length > max_bytes as u64) {
        return Err(AiUiError::new(
            "AI_RESPONSE_TOO_LARGE",
            "AI 响应过大",
            "Provider 返回的响应超过安全限制。",
            false,
        )
        .with_provider_status(status.as_u16())
        .with_request_id(request_id));
    }
    Ok(())
}

async fn read_bounded_body(
    mut response: reqwest::Response,
    request_id: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, AiUiError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| map_reqwest_error(error, request_id))?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(AiUiError::new(
                "AI_RESPONSE_TOO_LARGE",
                "AI 响应过大",
                "Provider 返回的响应超过安全限制。",
                false,
            )
            .with_request_id(request_id));
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

fn extract_model_ids(value: &Value, api_key: &str) -> (Vec<String>, bool) {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let raw_count = entries.len();
    let mut models = entries
        .iter()
        .filter_map(|entry| {
            entry.as_str().or_else(|| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| entry.get("model").and_then(Value::as_str))
                    .or_else(|| entry.get("name").and_then(Value::as_str))
            })
        })
        .filter_map(|model| sanitize_model_id(model, api_key))
        .collect::<Vec<_>>();
    models.sort_by_key(|model| model.to_lowercase());
    models.dedup();
    let truncated = raw_count > MAX_MODEL_COUNT || models.len() > MAX_MODEL_COUNT;
    models.truncate(MAX_MODEL_COUNT);
    (models, truncated)
}

fn sanitize_model_id(value: &str, api_key: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_MODEL_ID_CHARS
        || trimmed.chars().any(char::is_control)
        || (!api_key.is_empty() && trimmed.contains(api_key))
    {
        return None;
    }
    let lower = trimmed.to_lowercase();
    if lower.contains("authorization:") || lower.contains("bearer ") {
        return None;
    }
    Some(trimmed.to_string())
}

fn map_reqwest_error(error: reqwest::Error, request_id: &str) -> AiUiError {
    let message = error.to_string();
    let lower = message.to_lowercase();
    if error.is_timeout() {
        return AiUiError::new(
            "AI_TIMEOUT",
            "AI 请求超时",
            "Provider 在配置的超时时间内没有完成响应。",
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
    if error.is_connect() {
        return AiUiError::new(
            "AI_CONNECTION_FAILED",
            "无法连接 AI Provider",
            "请检查 Endpoint、网络和代理设置。",
            true,
        )
        .with_request_id(request_id);
    }
    AiUiError::new(
        "AI_CONNECTION_FAILED",
        "AI 请求失败",
        "与 AI Provider 通信时发生错误。",
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
            "当前 API Key 没有访问该模型或 Endpoint 的权限。",
            false,
        ),
        404 => (
            "AI_MODEL_NOT_FOUND",
            "模型或 Endpoint 不存在",
            "请检查 Endpoint 路径和模型名称。",
            false,
        ),
        408 | 504 => (
            "AI_TIMEOUT",
            "AI 请求超时",
            "Provider 未能及时完成请求。",
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
    let message = provider_message.unwrap_or_else(|| default_message.to_string());
    AiUiError::new(code, title, message, retryable)
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

pub fn emit_progress(
    app: &tauri::AppHandle,
    request_id: &str,
    kind: &str,
    status: &str,
    phase: &str,
    label: &str,
) {
    let _ = app.emit(
        AI_PROGRESS_EVENT,
        AiProgressEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            status: status.to_string(),
            phase: phase.to_string(),
            label: label.to_string(),
            completed_units: None,
            total_units: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{
        extract_message_content, extract_model_ids, perform_connection_request,
        perform_model_list_request, provider_error_message,
    };
    use crate::ai::provider::normalize_endpoint;
    use crate::ai::schema::AiProviderConfig;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve_once(status: &str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 8192];
            let _ = stream.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        format!("http://{address}/v1")
    }

    fn test_config(
        endpoint: String,
    ) -> (AiProviderConfig, crate::ai::provider::NormalizedAiEndpoint) {
        let config = AiProviderConfig {
            endpoint: endpoint.clone(),
            default_model: "mock-model".to_string(),
            timeout_seconds: 5,
            ..AiProviderConfig::default()
        };
        let normalized = normalize_endpoint(&endpoint).unwrap();
        (config, normalized)
    }

    #[tokio::test]
    async fn connects_to_a_local_openai_compatible_server_without_returning_model_output() {
        let body = json!({
            "model": "provider-controlled-model-name",
            "choices": [{ "message": { "content": "OK" } }]
        })
        .to_string();
        let endpoint = serve_once("200 OK", body).await;
        let (config, normalized) = test_config(endpoint);
        let result =
            perform_connection_request(None, "test_success", &config, &normalized, "secret")
                .await
                .unwrap();
        assert_eq!(result.model, "mock-model");
        assert_eq!(result.provider_host, "127.0.0.1");
    }

    #[tokio::test]
    async fn fetches_and_sanitizes_openai_compatible_models() {
        let body = json!({
            "data": [
                { "id": "model-b" },
                { "id": "model-a" },
                { "id": "secret-key-value" }
            ]
        })
        .to_string();
        let endpoint = serve_once("200 OK", body).await;
        let (config, normalized) = test_config(endpoint);
        let result = perform_model_list_request(
            None,
            "test_models",
            &config,
            &normalized,
            "secret-key-value",
        )
        .await
        .unwrap();
        assert_eq!(result.models, vec!["model-a", "model-b"]);
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn classifies_authentication_failures_from_a_local_server() {
        let endpoint = serve_once(
            "401 Unauthorized",
            json!({ "error": { "message": "invalid api key sk-secret-value" } }).to_string(),
        )
        .await;
        let (config, normalized) = test_config(endpoint);
        let error = perform_connection_request(None, "test_auth", &config, &normalized, "secret")
            .await
            .unwrap_err();
        assert_eq!(error.code, "AI_AUTH_FAILED");
        assert_eq!(error.message, "Provider 拒绝了当前 API Key。");
    }

    #[test]
    fn extracts_common_openai_compatible_content_shapes() {
        assert_eq!(
            extract_message_content(&json!({
                "choices": [{ "message": { "content": "OK" } }]
            }))
            .as_deref(),
            Some("OK")
        );
        assert_eq!(
            extract_message_content(&json!({
                "choices": [{ "text": "legacy" }]
            }))
            .as_deref(),
            Some("legacy")
        );
        assert_eq!(
            extract_message_content(&json!({
                "choices": [{ "message": { "content": [{ "type": "text", "text": "array" }] } }]
            }))
            .as_deref(),
            Some("array")
        );
    }

    #[test]
    fn accepts_common_model_list_shapes_and_deduplicates() {
        let (models, truncated) = extract_model_ids(
            &json!({
                "models": ["model-b", { "name": "model-a" }, { "id": "model-a" }]
            }),
            "secret",
        );
        assert_eq!(models, vec!["model-a", "model-b"]);
        assert!(!truncated);
    }

    #[test]
    fn bounds_safe_provider_error_text_and_drops_secret_like_details() {
        let safe = serde_json::to_vec(&json!({ "error": { "message": "bad\nrequest" } })).unwrap();
        assert_eq!(
            provider_error_message(&safe).as_deref(),
            Some("bad request")
        );

        let unsafe_body = serde_json::to_vec(&json!({
            "error": { "message": "invalid token sk-secret-value" }
        }))
        .unwrap();
        assert_eq!(provider_error_message(&unsafe_body), None);
    }
}
