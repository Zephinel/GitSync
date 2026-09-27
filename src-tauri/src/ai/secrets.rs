use crate::ai::errors::AiUiError;

pub const AI_KEYRING_SERVICE: &str = "GitSync.AI";
pub const AI_KEYRING_ACCOUNT: &str = "default-provider-api-key";

fn keyring_entry() -> Result<keyring::Entry, AiUiError> {
    keyring::Entry::new(AI_KEYRING_SERVICE, AI_KEYRING_ACCOUNT).map_err(|error| {
        AiUiError::new(
            "AI_KEYCHAIN_READ_FAILED",
            "无法访问系统凭据存储",
            format!("无法初始化系统 Keychain: {error}"),
            true,
        )
    })
}

fn is_missing_entry(error: &keyring::Error) -> bool {
    matches!(error, keyring::Error::NoEntry)
}

pub async fn read_api_key() -> Result<Option<String>, AiUiError> {
    tokio::task::spawn_blocking(|| {
        let entry = keyring_entry()?;
        match entry.get_password() {
            Ok(secret) if !secret.trim().is_empty() => Ok(Some(secret)),
            Ok(_) => Ok(None),
            Err(error) if is_missing_entry(&error) => Ok(None),
            Err(error) => Err(AiUiError::new(
                "AI_KEYCHAIN_READ_FAILED",
                "读取 API Key 失败",
                format!("系统凭据存储返回错误: {error}"),
                true,
            )),
        }
    })
    .await
    .map_err(|error| AiUiError::internal(format!("Keychain 任务失败: {error}")))?
}

pub async fn has_api_key() -> Result<bool, AiUiError> {
    Ok(read_api_key().await?.is_some())
}

pub async fn set_api_key(api_key: String) -> Result<(), AiUiError> {
    let normalized = api_key.trim().to_string();
    if normalized.is_empty() {
        return Err(AiUiError::new(
            "AI_AUTH_FAILED",
            "API Key 为空",
            "请输入有效的 API Key。",
            false,
        ));
    }
    if normalized.len() > 16 * 1024 {
        return Err(AiUiError::new(
            "AI_AUTH_FAILED",
            "API Key 过长",
            "API Key 超过允许长度。",
            false,
        ));
    }

    tokio::task::spawn_blocking(move || {
        let entry = keyring_entry()?;
        entry.set_password(&normalized).map_err(|error| {
            AiUiError::new(
                "AI_KEYCHAIN_READ_FAILED",
                "保存 API Key 失败",
                format!("系统凭据存储返回错误: {error}"),
                true,
            )
        })
    })
    .await
    .map_err(|error| AiUiError::internal(format!("Keychain 任务失败: {error}")))?
}

pub async fn clear_api_key() -> Result<bool, AiUiError> {
    tokio::task::spawn_blocking(|| {
        let entry = keyring_entry()?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(error) if is_missing_entry(&error) => Ok(false),
            Err(error) => Err(AiUiError::new(
                "AI_KEYCHAIN_READ_FAILED",
                "清除 API Key 失败",
                format!("系统凭据存储返回错误: {error}"),
                true,
            )),
        }
    })
    .await
    .map_err(|error| AiUiError::internal(format!("Keychain 任务失败: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::{is_missing_entry, AI_KEYRING_ACCOUNT, AI_KEYRING_SERVICE};

    #[test]
    fn keyring_identifiers_are_stable_and_nonempty() {
        assert_eq!(AI_KEYRING_SERVICE, "GitSync.AI");
        assert_eq!(AI_KEYRING_ACCOUNT, "default-provider-api-key");
    }

    #[test]
    fn classifies_only_the_no_entry_variant_as_missing() {
        assert!(is_missing_entry(&keyring::Error::NoEntry));
        assert!(!is_missing_entry(&keyring::Error::Invalid(
            "account".to_string(),
            "invalid".to_string()
        )));
    }
}
