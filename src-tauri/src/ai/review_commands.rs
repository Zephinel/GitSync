use crate::ai::client::emit_progress;
use crate::ai::errors::AiUiError;
use crate::ai::limits::{MAX_ACTIVE_REVIEW_REQUESTS, MAX_PENDING_REVIEW_PREVIEWS};
use crate::ai::provider::{load_config, validate_and_normalize_config};
use crate::ai::review_pipeline::{
    capture_review_plan, capture_stable_review_plan, execute_review_plan,
};
use crate::ai::schema::{AiCancelResult, AiReviewDelivery, AiReviewScopeDelivery};
use crate::ai::secrets::read_api_key;
use crate::commands::AppState;
use crate::working_changes::WorkingChangeTarget;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::{oneshot, Mutex};

static REVIEW_REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static REVIEW_CANCELLATION_REGISTRY: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    OnceLock::new();
static REVIEW_PREVIEW_REGISTRY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn cancellation_registry() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    REVIEW_CANCELLATION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preview_registry() -> &'static Mutex<HashMap<String, String>> {
    REVIEW_PREVIEW_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preview_key(repo_path: &str, files: &[WorkingChangeTarget], scope_kind: &str) -> String {
    let mut identities = files
        .iter()
        .map(|file| {
            format!(
                "{}\0{}\0{}\0{}\0{}\0{}",
                file.path.trim().replace('\\', "/"),
                file.old_path
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .replace('\\', "/"),
                file.expected_index_code,
                file.expected_worktree_code,
                file.expected_is_untracked,
                file.expected_authority_id,
            )
        })
        .collect::<Vec<_>>();
    identities.sort();
    identities.dedup();
    format!(
        "{}\0{}\0{}",
        repo_path.trim(),
        scope_kind.trim(),
        identities.join("\u{1f}")
    )
}

async fn store_preview_fingerprint(key: String, fingerprint: String) {
    let mut registry = preview_registry().lock().await;
    if registry.len() >= MAX_PENDING_REVIEW_PREVIEWS && !registry.contains_key(&key) {
        registry.clear();
    }
    registry.insert(key, fingerprint);
}

fn normalized_request_id(value: String) -> Result<String, AiUiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let count = REVIEW_REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        return Ok(format!("review_{millis}_{count}"));
    }
    if trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
    {
        return Err(AiUiError::new(
            "AI_INTERNAL",
            "Review 请求 ID 无效",
            "Review 请求 ID 包含不受支持的字符或超过长度限制。",
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
            "Review 请求 ID 冲突",
            "相同的 Review 请求正在运行，请重试。",
            true,
        )
        .with_request_id(request_id));
    }
    if registry.len() >= MAX_ACTIVE_REVIEW_REQUESTS {
        return Err(AiUiError::new(
            "AI_RATE_LIMITED",
            "Review 请求过多",
            "当前已有过多 Review 请求正在运行，请稍后重试。",
            true,
        )
        .with_request_id(request_id));
    }
    registry.insert(request_id.to_string(), sender);
    Ok(receiver)
}

async fn unregister_request(request_id: &str) {
    cancellation_registry().lock().await.remove(request_id);
}

async fn load_request_context(
    app: &tauri::AppHandle,
    request_id: &str,
) -> Result<
    (
        crate::ai::schema::AiProviderConfig,
        crate::ai::provider::NormalizedAiEndpoint,
        String,
    ),
    AiUiError,
> {
    let stored_config = load_config(app).await?;
    let (config, endpoint) = validate_and_normalize_config(stored_config)
        .map_err(|error| error.with_request_id(request_id))?;
    let api_key = read_api_key().await?.ok_or_else(|| {
        AiUiError::new(
            "AI_NOT_CONFIGURED",
            "未配置 API Key",
            "请先在 AI 设置中保存 API Key。",
            false,
        )
        .with_request_id(request_id)
    })?;
    Ok((config, endpoint, api_key))
}

fn emit_terminal_progress(
    app: &tauri::AppHandle,
    request_id: &str,
    result: &Result<AiReviewDelivery, AiUiError>,
) {
    match result {
        Ok(delivery) => emit_progress(
            app,
            request_id,
            "review",
            "completed",
            if delivery.cache_hit {
                "cache-hit"
            } else if delivery.partial_success {
                "partial-success"
            } else {
                "completed"
            },
            if delivery.cache_hit {
                "已复用缓存的 AI Review"
            } else if delivery.partial_success {
                "AI Review 已部分完成"
            } else {
                "AI Review 已完成"
            },
        ),
        Err(error) if error.code == "AI_CANCELLED" => emit_progress(
            app,
            request_id,
            "review",
            "cancelled",
            "cancelled",
            "AI Review 已取消",
        ),
        Err(error) => emit_progress(app, request_id, "review", "failed", "failed", &error.title),
    }
}

fn preview_changed_error(request_id: &str) -> AiUiError {
    AiUiError::new(
        "AI_SCOPE_CHANGED",
        "Review 输入已变化",
        "发送前确认之后，所选改动发生了变化。请重新确认 Review 输入范围。",
        true,
    )
    .with_request_id(request_id)
}

#[tauri::command]
pub async fn preview_ai_review_scope(
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    scope_kind: String,
    state: State<'_, AppState>,
) -> Result<AiReviewScopeDelivery, AiUiError> {
    let plan = capture_stable_review_plan(&repo_path, &files, &scope_kind, &state).await?;
    store_preview_fingerprint(
        preview_key(&repo_path, &files, &scope_kind),
        plan.fingerprint.clone(),
    )
    .await;
    Ok(plan.preview())
}

#[tauri::command]
pub async fn run_ai_review(
    request_id: String,
    repo_path: String,
    files: Vec<WorkingChangeTarget>,
    scope_kind: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AiReviewDelivery, AiUiError> {
    let request_id = normalized_request_id(request_id)?;
    let confirmed_fingerprint = preview_registry()
        .lock()
        .await
        .remove(&preview_key(&repo_path, &files, &scope_kind))
        .ok_or_else(|| preview_changed_error(&request_id))?;
    let mut cancellation = register_request(&request_id).await?;
    emit_progress(
        &app,
        &request_id,
        "review",
        "preparing",
        "preparing-scope",
        "正在准备 Review 批次…",
    );

    let operation = async {
        let (config, endpoint, api_key) = load_request_context(&app, &request_id).await?;
        emit_progress(
            &app,
            &request_id,
            "review",
            "preparing",
            "sanitizing",
            "正在读取并过滤 Review 输入…",
        );
        let plan = capture_stable_review_plan(&repo_path, &files, &scope_kind, &state)
            .await
            .map_err(|error| error.with_request_id(&request_id))?;
        if plan.fingerprint != confirmed_fingerprint {
            return Err(preview_changed_error(&request_id));
        }
        let original_fingerprint = plan.fingerprint.clone();
        let mut delivery =
            execute_review_plan(&app, &request_id, &config, &endpoint, &api_key, &plan).await?;

        emit_progress(
            &app,
            &request_id,
            "review",
            "validating",
            "checking-scope",
            "正在确认 Review 范围是否变化…",
        );
        match capture_review_plan(&repo_path, &files, &scope_kind, &state).await {
            Ok(current) => {
                delivery.review.current_snapshot_fingerprint = current.fingerprint.clone();
                delivery.review.stale = current.fingerprint != original_fingerprint;
            }
            Err(_) => {
                delivery.review.current_snapshot_fingerprint = "unavailable".to_string();
                delivery.review.stale = true;
            }
        }
        Ok(delivery)
    };

    let result = tokio::select! {
        _ = &mut cancellation => Err(AiUiError::cancelled(request_id.clone())),
        response = operation => response,
    };
    unregister_request(&request_id).await;
    emit_terminal_progress(&app, &request_id, &result);
    result
}

#[tauri::command]
pub async fn cancel_ai_review_request(request_id: String) -> Result<AiCancelResult, AiUiError> {
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
        cancel_ai_review_request, cancellation_registry, normalized_request_id, preview_key,
        register_request, store_preview_fingerprint,
    };
    use crate::ai::limits::MAX_PENDING_REVIEW_PREVIEWS;
    use crate::working_changes::WorkingChangeTarget;

    fn target(path: &str) -> WorkingChangeTarget {
        WorkingChangeTarget {
            path: path.to_string(),
            old_path: None,
            expected_index_code: " ".to_string(),
            expected_worktree_code: "M".to_string(),
            expected_is_untracked: false,
            expected_authority_id: format!("test-authority:{path}"),
        }
    }

    #[test]
    fn validates_review_request_identifiers() {
        assert_eq!(
            normalized_request_id("review_123-a".to_string()).unwrap(),
            "review_123-a"
        );
        assert!(normalized_request_id("bad request".to_string()).is_err());
    }

    #[test]
    fn preview_keys_are_stable_across_target_order() {
        let a = target("a.rs");
        let b = target("b.rs");
        assert_eq!(
            preview_key("/repo", &[a.clone(), b.clone()], "selected"),
            preview_key("/repo", &[b, a], "selected")
        );
    }

    #[test]
    fn preview_keys_bind_the_complete_target_identity() {
        let base = target("a.rs");
        let mut changed_status = base.clone();
        changed_status.expected_worktree_code = "D".to_string();
        let mut changed_authority = base.clone();
        changed_authority.expected_authority_id = "other-authority".to_string();

        assert_ne!(
            preview_key("/repo", &[base.clone()], "selected"),
            preview_key("/repo", &[changed_status], "selected")
        );
        assert_ne!(
            preview_key("/repo", &[base], "selected"),
            preview_key("/repo", &[changed_authority], "selected")
        );
    }

    #[tokio::test]
    async fn pending_preview_registry_remains_bounded() {
        for index in 0..=MAX_PENDING_REVIEW_PREVIEWS {
            store_preview_fingerprint(format!("key-{index}"), format!("fingerprint-{index}")).await;
        }
        assert!(super::preview_registry().lock().await.len() <= MAX_PENDING_REVIEW_PREVIEWS);
    }

    #[tokio::test]
    async fn review_cancellation_is_idempotent() {
        let request_id = "review_test_cancel_registry";
        cancellation_registry().lock().await.remove(request_id);
        let receiver = register_request(request_id).await.unwrap();
        let first = cancel_ai_review_request(request_id.to_string())
            .await
            .unwrap();
        assert!(first.cancelled);
        assert!(receiver.await.is_ok());
        let second = cancel_ai_review_request(request_id.to_string())
            .await
            .unwrap();
        assert!(!second.cancelled);
    }
}
