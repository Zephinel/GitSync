use crate::ai::client::{emit_progress, list_models, test_connection};
use crate::ai::commit_message::generate_commit_message;
use crate::ai::errors::AiUiError;
use crate::ai::provider::{
    load_config, require_default_model, save_config, validate_and_normalize_config,
};
use crate::ai::review_cache::clear_review_cache;
use crate::ai::schema::{
    AiApiKeyStatus, AiCancelResult, AiCommitMessageResult, AiConfigurationStatus,
    AiConnectionTestResult, AiModelListResult, AiProviderConfig,
};
use crate::ai::secrets::{
    clear_api_key as clear_stored_api_key, has_api_key, read_api_key,
    set_api_key as set_stored_api_key,
};
use crate::ai::snapshot::capture_commit_snapshot;
use crate::commands::AppState;
use crate::working_changes::WorkingChangeTarget;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::{oneshot, Mutex};

const MAX_ACTIVE_AI_REQUESTS: usize = 16;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static CANCELLATION_REGISTRY: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    OnceLock::new();

fn cancellation_registry() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    CANCELLATION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalized_request_id(value: String) -> Result<String, AiUiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let count = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        return Ok(format!("ai_{millis}_{count}"));
    }
    if trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
    {
        return Err(AiUiError::new(
            "AI_INTERNAL",
            "请求 ID 无效",
            "AI 请求 ID 包含不受支持的字符或超过长度限制。",
            false,
        ));
    }
    Ok(trimmed.to_string())
}

async fn register_request(request_id: &str) -> Result<oneshot::Receiver<()>, AiUiError> {
    let (sender, receiver) = oneshot::channel();
    let mut registry = cancellation_registry().lock().await;
    if registry.contains_key(request_id) {
        return Err(AiUiError::new(
            "AI_INTERNAL",
            "请求 ID 冲突",
            "相同的 AI 请求正在运行，请重试。",
            true,
        )
        .with_request_id(request_id.to_string()));
    }
    if registry.len() >= MAX_ACTIVE_AI_REQUESTS {
        return Err(AiUiError::new(
            "AI_RATE_LIMITED",
            "AI 请求过多",
            "当前已有过多 AI 请求正在运行，请等待部分请求完成后重试。",
            true,
        )
        .with_request_id(request_id.to_string()));
    }
    registry.insert(request_id.to_string(), sender);
    Ok(receiver)
}

async fn unregister_request(request_id: &str) {
    cancellation_registry().lock().await.remove(request_id);
}

async fn configuration_status(
    app: &tauri::AppHandle,
    config: Option<AiProviderConfig>,
) -> Result<AiConfigurationStatus, AiUiError> {
    let config = match config {
        Some(config) => config,
        None => load_config(app).await?,
    };
    let has_key = has_api_key().await?;
    Ok(AiConfigurationStatus::from_config(config, has_key))
}

async fn load_request_context(
    app: &tauri::AppHandle,
    request_id: &str,
) -> Result<
    (
        AiProviderConfig,
        crate::ai::provider::NormalizedAiEndpoint,
        String,
    ),
    AiUiError,
> {
    let stored_config = load_config(app).await?;
    let (config, endpoint) = validate_and_normalize_config(stored_config)
        .map_err(|error| error.with_request_id(request_id.to_string()))?;
    let api_key = read_api_key().await?.ok_or_else(|| {
        AiUiError::new(
            "AI_NOT_CONFIGURED",
            "未配置 API Key",
            "请先在 AI 设置中保存 API Key。",
            false,
        )
        .with_request_id(request_id.to_string())
    })?;
    Ok((config, endpoint, api_key))
}

fn emit_terminal_progress<T>(
    app: &tauri::AppHandle,
    request_id: &str,
    kind: &str,
    success_label: &str,
    result: &Result<T, AiUiError>,
) {
    match result {
        Ok(_) => emit_progress(
            app,
            request_id,
            kind,
            "completed",
            "completed",
            success_label,
        ),
        Err(error) if error.code == "AI_CANCELLED" => emit_progress(
            app,
            request_id,
            kind,
            "cancelled",
            "cancelled",
            "AI 请求已取消",
        ),
        Err(error) => emit_progress(app, request_id, kind, "failed", "failed", &error.title),
    }
}

fn scope_changed_error(request_id: &str) -> AiUiError {
    AiUiError::new(
        "AI_SCOPE_CHANGED",
        "所选改动已变化",
        "生成期间工作区已发生变化。为避免覆盖不匹配的结果，请重新生成提交信息。",
        true,
    )
    .with_request_id(request_id)
}

#[tauri::command]
pub async fn get_ai_configuration_status(
    app: tauri::AppHandle,
) -> Result<AiConfigurationStatus, AiUiError> {
    configuration_status(&app, None).await
}

#[tauri::command]
pub async fn save_ai_configuration(
    config: AiProviderConfig,
    app: tauri::AppHandle,
) -> Result<AiConfigurationStatus, AiUiError> {
    let saved = save_config(&app, config).await?;
    clear_review_cache().await;
    configuration_status(&app, Some(saved)).await
}

#[tauri::command]
pub async fn set_ai_api_key(api_key: String) -> Result<AiApiKeyStatus, AiUiError> {
    set_stored_api_key(api_key).await?;
    clear_review_cache().await;
    Ok(AiApiKeyStatus { has_api_key: true })
}

#[tauri::command]
pub async fn clear_ai_api_key() -> Result<AiApiKeyStatus, AiUiError> {
    let _ = clear_stored_api_key().await?;
    clear_review_cache().await;
    Ok(AiApiKeyStatus { has_api_key: false })
}

#[tauri::command]
pub async fn test_ai_connection(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<AiConnectionTestResult, AiUiError> {
    let request_id = normalized_request_id(request_id)?;
    let mut cancellation = register_request(&request_id).await?;
    emit_progress(
        &app,
        &request_id,
        "connection-test",
        "preparing",
        "preparing",
        "正在准备 AI 配置…",
    );

    let operation = async {
        let (config, endpoint, api_key) = load_request_context(&app, &request_id).await?;
        require_default_model(&config).map_err(|error| error.with_request_id(&request_id))?;
        test_connection(&app, &request_id, &config, &endpoint, &api_key).await
    };

    let result = tokio::select! {
        _ = &mut cancellation => Err(AiUiError::cancelled(request_id.clone())),
        response = operation => response,
    };
    unregister_request(&request_id).await;
    emit_terminal_progress(
        &app,
        &request_id,
        "connection-test",
        "连接测试完成",
        &result,
    );
    result
}

#[tauri::command]
pub async fn list_ai_models(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<AiModelListResult, AiUiError> {
    let request_id = normalized_request_id(request_id)?;
    let mut cancellation = register_request(&request_id).await?;
    emit_progress(
        &app,
        &request_id,
        "model-list",
        "preparing",
        "preparing",
        "正在准备模型列表请求…",
    );

    let operation = async {
        let (config, endpoint, api_key) = load_request_context(&app, &request_id).await?;
        list_models(&app, &request_id, &config, &endpoint, &api_key).await
    };

    let result = tokio::select! {
        _ = &mut cancellation => Err(AiUiError::cancelled(request_id.clone())),
        response = operation => response,
    };
    unregister_request(&request_id).await;
    emit_terminal_progress(&app, &request_id, "model-list", "模型列表已更新", &result);
    result
}

#[tauri::command]
pub async fn generate_ai_commit_message(
    request_id: String,
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AiCommitMessageResult, AiUiError> {
    let request_id = normalized_request_id(request_id)?;
    let mut cancellation = register_request(&request_id).await?;
    emit_progress(
        &app,
        &request_id,
        "commit-message",
        "preparing",
        "preparing-selection",
        "正在准备所选文件…",
    );

    let operation = async {
        let (config, endpoint, api_key) = load_request_context(&app, &request_id).await?;
        emit_progress(
            &app,
            &request_id,
            "commit-message",
            "preparing",
            "sanitizing",
            "正在读取并过滤所选 Diff…",
        );
        let snapshot =
            capture_commit_snapshot(&repo_path, &files, &state, config.use_recent_commit_style)
                .await
                .map_err(|error| error.with_request_id(&request_id))?;
        let original_fingerprint = snapshot.fingerprint.clone();
        emit_progress(
            &app,
            &request_id,
            "commit-message",
            "preparing",
            "building-prompt",
            "正在构建提交信息输入…",
        );
        let result =
            generate_commit_message(&app, &request_id, &config, &endpoint, &api_key, snapshot)
                .await?;

        emit_progress(
            &app,
            &request_id,
            "commit-message",
            "validating",
            "checking-scope",
            "正在确认所选改动未变化…",
        );
        let current_snapshot = capture_commit_snapshot(&repo_path, &files, &state, false)
            .await
            .map_err(|_| scope_changed_error(&request_id))?;
        if current_snapshot.fingerprint != original_fingerprint {
            return Err(scope_changed_error(&request_id));
        }
        Ok(result)
    };

    let result = tokio::select! {
        _ = &mut cancellation => Err(AiUiError::cancelled(request_id.clone())),
        response = operation => response,
    };
    unregister_request(&request_id).await;
    emit_terminal_progress(
        &app,
        &request_id,
        "commit-message",
        "提交信息已生成",
        &result,
    );
    result
}

#[tauri::command]
pub async fn cancel_ai_request(request_id: String) -> Result<AiCancelResult, AiUiError> {
    let request_id = normalized_request_id(request_id)?;
    let sender = cancellation_registry().lock().await.remove(&request_id);
    let cancelled = sender
        .map(|sender| sender.send(()).is_ok())
        .unwrap_or(false);
    Ok(AiCancelResult {
        request_id,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_ai_request, cancellation_registry, normalized_request_id, register_request,
        scope_changed_error,
    };

    #[test]
    fn validates_request_identifiers() {
        assert_eq!(
            normalized_request_id("review_123-a".to_string()).unwrap(),
            "review_123-a"
        );
        assert!(normalized_request_id("bad request".to_string()).is_err());
        assert!(!normalized_request_id(String::new()).unwrap().is_empty());
    }

    #[test]
    fn reports_scope_changes_with_a_retryable_typed_error() {
        let error = scope_changed_error("req-1");
        assert_eq!(error.code, "AI_SCOPE_CHANGED");
        assert!(error.retryable);
        assert_eq!(error.request_id.as_deref(), Some("req-1"));
    }

    #[tokio::test]
    async fn cancellation_is_idempotent_and_notifies_the_registered_request() {
        let request_id = "ai_test_cancel_registry";
        cancellation_registry().lock().await.remove(request_id);
        let receiver = register_request(request_id).await.unwrap();
        let first = cancel_ai_request(request_id.to_string()).await.unwrap();
        assert!(first.cancelled);
        assert!(receiver.await.is_ok());

        let second = cancel_ai_request(request_id.to_string()).await.unwrap();
        assert!(!second.cancelled);
    }
}
