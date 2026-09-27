use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUiError {
    pub code: String,
    pub title: String,
    pub message: String,
    pub retryable: bool,
    pub provider_status: Option<u16>,
    pub request_id: Option<String>,
}

impl AiUiError {
    pub fn new(
        code: impl Into<String>,
        title: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            title: title.into(),
            message: message.into(),
            retryable,
            provider_status: None,
            request_id: None,
        }
    }

    pub fn with_provider_status(mut self, status: u16) -> Self {
        self.provider_status = Some(status);
        self
    }

    pub fn with_request_id(mut self, request_id: impl ToString) -> Self {
        self.request_id = Some(request_id.to_string());
        self
    }

    pub fn cancelled(request_id: impl ToString) -> Self {
        Self::new("AI_CANCELLED", "请求已取消", "AI 请求已取消。", true).with_request_id(request_id)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("AI_INTERNAL", "AI 内部错误", message, false)
    }
}

impl std::fmt::Display for AiUiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AiUiError {}
