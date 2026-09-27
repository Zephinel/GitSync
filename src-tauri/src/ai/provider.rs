use crate::ai::errors::AiUiError;
use crate::ai::schema::AiProviderConfig;
use reqwest::Url;
use std::path::PathBuf;
use tauri::Manager;

const AI_SETTINGS_FILE: &str = "ai-settings.json";
const MAX_ENDPOINT_LENGTH: usize = 2048;
const MAX_MODEL_LENGTH: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedAiEndpoint {
    pub stored_endpoint: String,
    pub chat_completions_url: Url,
    pub models_url: Url,
    pub provider_host: String,
}

pub fn validate_and_normalize_config(
    config: AiProviderConfig,
) -> Result<(AiProviderConfig, NormalizedAiEndpoint), AiUiError> {
    let mut normalized = config.normalized();
    if normalized.endpoint.is_empty() {
        return Err(AiUiError::new(
            "AI_INVALID_ENDPOINT",
            "Endpoint 无效",
            "请输入 AI Provider Endpoint。",
            false,
        ));
    }
    if normalized.endpoint.len() > MAX_ENDPOINT_LENGTH {
        return Err(AiUiError::new(
            "AI_INVALID_ENDPOINT",
            "Endpoint 过长",
            "AI Provider Endpoint 超过允许长度。",
            false,
        ));
    }
    validate_model_lengths(&normalized)?;

    let endpoint = normalize_endpoint(&normalized.endpoint)?;
    normalized.endpoint = endpoint.stored_endpoint.clone();
    Ok((normalized, endpoint))
}

pub fn require_default_model(config: &AiProviderConfig) -> Result<(), AiUiError> {
    if config.default_model.trim().is_empty() {
        return Err(AiUiError::new(
            "AI_MODEL_NOT_FOUND",
            "未配置模型",
            "请先拉取或输入默认模型。",
            false,
        ));
    }
    Ok(())
}

fn validate_model_lengths(config: &AiProviderConfig) -> Result<(), AiUiError> {
    if config.default_model.len() > MAX_MODEL_LENGTH
        || config
            .review_model
            .as_ref()
            .is_some_and(|model| model.len() > MAX_MODEL_LENGTH)
        || config
            .commit_model
            .as_ref()
            .is_some_and(|model| model.len() > MAX_MODEL_LENGTH)
    {
        return Err(AiUiError::new(
            "AI_MODEL_NOT_FOUND",
            "模型名称过长",
            "模型名称超过允许长度。",
            false,
        ));
    }
    Ok(())
}

fn api_base_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    let without_resource = trimmed
        .strip_suffix("/chat/completions")
        .or_else(|| trimmed.strip_suffix("/models"))
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    if without_resource.is_empty() || without_resource == "/" {
        "/v1".to_string()
    } else {
        without_resource.to_string()
    }
}

pub fn normalize_endpoint(value: &str) -> Result<NormalizedAiEndpoint, AiUiError> {
    let trimmed = value.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).map_err(|_| {
        AiUiError::new(
            "AI_INVALID_ENDPOINT",
            "Endpoint 无效",
            "Endpoint 必须是有效的 HTTP 或 HTTPS URL。",
            false,
        )
    })?;

    if !url.username().is_empty() || url.password().is_some() {
        return Err(AiUiError::new(
            "AI_INVALID_ENDPOINT",
            "Endpoint 包含凭据",
            "请勿在 Endpoint URL 中嵌入用户名、密码或 API Key。",
            false,
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AiUiError::new(
            "AI_INVALID_ENDPOINT",
            "Endpoint 包含额外参数",
            "Endpoint 不应包含查询参数或 URL fragment。",
            false,
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| {
            AiUiError::new(
                "AI_INVALID_ENDPOINT",
                "Endpoint 缺少主机",
                "Endpoint 必须包含有效主机名。",
                false,
            )
        })?
        .to_string();
    let is_loopback = host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    match url.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        "http" => {
            return Err(AiUiError::new(
                "AI_INVALID_ENDPOINT",
                "Endpoint 不安全",
                "非本机 AI Endpoint 必须使用 HTTPS。",
                false,
            ));
        }
        _ => {
            return Err(AiUiError::new(
                "AI_INVALID_ENDPOINT",
                "Endpoint 协议不受支持",
                "AI Endpoint 仅支持 HTTPS；本机服务可使用 HTTP。",
                false,
            ));
        }
    }

    let base_path = api_base_path(url.path());
    let mut chat_completions_url = url.clone();
    chat_completions_url.set_path(&format!("{base_path}/chat/completions"));
    let mut models_url = url;
    models_url.set_path(&format!("{base_path}/models"));

    Ok(NormalizedAiEndpoint {
        stored_endpoint: trimmed.to_string(),
        chat_completions_url,
        models_url,
        provider_host: host,
    })
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, AiUiError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AiUiError::internal(format!("无法读取应用数据目录: {error}")))?;
    Ok(app_data_dir.join(AI_SETTINGS_FILE))
}

pub async fn load_config(app: &tauri::AppHandle) -> Result<AiProviderConfig, AiUiError> {
    let path = settings_path(app)?;
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AiProviderConfig::default())
        }
        Err(error) => return Err(AiUiError::internal(format!("读取 AI 设置失败: {error}"))),
    };
    let config = serde_json::from_slice::<AiProviderConfig>(&bytes).map_err(|_| {
        AiUiError::new(
            "AI_INTERNAL",
            "AI 设置损坏",
            "AI 设置文件无法解析，请重新保存设置。",
            false,
        )
    })?;
    Ok(config.normalized())
}

pub async fn save_config(
    app: &tauri::AppHandle,
    config: AiProviderConfig,
) -> Result<AiProviderConfig, AiUiError> {
    let (normalized, _) = validate_and_normalize_config(config)?;
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AiUiError::internal(format!("创建 AI 设置目录失败: {error}")))?;
    }
    let bytes = serde_json::to_vec_pretty(&normalized)
        .map_err(|error| AiUiError::internal(format!("序列化 AI 设置失败: {error}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| AiUiError::internal(format!("保存 AI 设置失败: {error}")))?;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::{normalize_endpoint, require_default_model, validate_and_normalize_config};
    use crate::ai::schema::AiProviderConfig;

    #[test]
    fn builds_chat_and_models_urls_without_double_appending() {
        let root = normalize_endpoint("https://example.com").unwrap();
        assert_eq!(
            root.chat_completions_url.as_str(),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(root.models_url.as_str(), "https://example.com/v1/models");

        let v1 = normalize_endpoint("https://example.com/v1/").unwrap();
        assert_eq!(
            v1.chat_completions_url.as_str(),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(v1.models_url.as_str(), "https://example.com/v1/models");

        let full = normalize_endpoint("https://example.com/v1/chat/completions").unwrap();
        assert_eq!(
            full.chat_completions_url.as_str(),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(full.models_url.as_str(), "https://example.com/v1/models");
    }

    #[test]
    fn permits_saving_endpoint_before_a_model_is_selected() {
        let config = AiProviderConfig {
            endpoint: "https://example.com/v1".to_string(),
            default_model: String::new(),
            ..AiProviderConfig::default()
        };
        let (saved, _) = validate_and_normalize_config(config).unwrap();
        assert!(saved.default_model.is_empty());
        assert!(require_default_model(&saved).is_err());
    }

    #[test]
    fn permits_loopback_http_and_rejects_remote_http() {
        assert!(normalize_endpoint("http://127.0.0.1:1234/v1").is_ok());
        assert!(normalize_endpoint("http://localhost:1234/v1").is_ok());
        let error = normalize_endpoint("http://example.com/v1").unwrap_err();
        assert_eq!(error.code, "AI_INVALID_ENDPOINT");
    }

    #[test]
    fn rejects_embedded_credentials_and_query_parameters() {
        assert!(normalize_endpoint("https://user:secret@example.com/v1").is_err());
        assert!(normalize_endpoint("https://example.com/v1?token=secret").is_err());
    }
}
