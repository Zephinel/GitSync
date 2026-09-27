use serde::{Deserialize, Serialize};

pub const DEFAULT_AI_ENDPOINT: &str = "https://api.openai.com/v1";
pub const DEFAULT_AI_TIMEOUT_SECONDS: u64 = 60;
pub const MIN_AI_TIMEOUT_SECONDS: u64 = 5;
pub const MAX_AI_TIMEOUT_SECONDS: u64 = 300;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum AiOutputLanguage {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum AiCommitStyle {
    #[default]
    #[serde(rename = "conventional")]
    Conventional,
    #[serde(rename = "plain")]
    Plain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiProviderConfig {
    pub endpoint: String,
    pub default_model: String,
    pub review_model: Option<String>,
    pub commit_model: Option<String>,
    pub output_language: AiOutputLanguage,
    pub commit_style: AiCommitStyle,
    pub use_recent_commit_style: bool,
    pub timeout_seconds: u64,
}

impl Default for AiProviderConfig {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_AI_ENDPOINT.to_string(),
            default_model: String::new(),
            review_model: None,
            commit_model: None,
            output_language: AiOutputLanguage::Auto,
            commit_style: AiCommitStyle::Conventional,
            use_recent_commit_style: true,
            timeout_seconds: DEFAULT_AI_TIMEOUT_SECONDS,
        }
    }
}

impl AiProviderConfig {
    pub fn normalized(mut self) -> Self {
        self.endpoint = self.endpoint.trim().trim_end_matches('/').to_string();
        self.default_model = self.default_model.trim().to_string();
        self.review_model = normalize_optional_text(self.review_model);
        self.commit_model = normalize_optional_text(self.commit_model);
        self.timeout_seconds = self
            .timeout_seconds
            .clamp(MIN_AI_TIMEOUT_SECONDS, MAX_AI_TIMEOUT_SECONDS);
        self
    }
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigurationStatus {
    pub configured: bool,
    pub has_api_key: bool,
    pub endpoint: String,
    pub default_model: String,
    pub review_model: Option<String>,
    pub commit_model: Option<String>,
    pub output_language: AiOutputLanguage,
    pub commit_style: AiCommitStyle,
    pub use_recent_commit_style: bool,
    pub timeout_seconds: u64,
}

impl AiConfigurationStatus {
    pub fn from_config(config: AiProviderConfig, has_api_key: bool) -> Self {
        let configured = has_api_key
            && !config.endpoint.trim().is_empty()
            && !config.default_model.trim().is_empty();
        Self {
            configured,
            has_api_key,
            endpoint: config.endpoint,
            default_model: config.default_model,
            review_model: config.review_model,
            commit_model: config.commit_model,
            output_language: config.output_language,
            commit_style: config.commit_style,
            use_recent_commit_style: config.use_recent_commit_style,
            timeout_seconds: config.timeout_seconds,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApiKeyStatus {
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub request_id: String,
    pub model: String,
    pub provider_host: String,
    pub latency_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelListResult {
    pub request_id: String,
    pub provider_host: String,
    pub models: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitInputNotice {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitMessageResult {
    pub request_id: String,
    pub message: String,
    pub model: String,
    pub provider_host: String,
    pub selected_file_count: usize,
    pub included_file_count: usize,
    pub excluded_files: Vec<AiCommitInputNotice>,
    pub summary_only_files: Vec<AiCommitInputNotice>,
    pub binary_files: Vec<AiCommitInputNotice>,
    pub sanitized_bytes: usize,
    pub redacted_line_count: u32,
    pub recent_subject_count: usize,
    pub snapshot_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewFinding {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub file: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub explanation: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewBatchFailure {
    pub batch_index: usize,
    pub file_count: usize,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewScopePreview {
    pub scope_kind: String,
    pub scope_label: String,
    pub selected_file_count: usize,
    pub included_file_count: usize,
    pub excluded_files: Vec<AiCommitInputNotice>,
    pub summary_only_files: Vec<AiCommitInputNotice>,
    pub binary_files: Vec<AiCommitInputNotice>,
    pub sanitized_bytes: usize,
    pub redacted_line_count: u32,
    pub snapshot_fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewScopeDelivery {
    #[serde(flatten)]
    pub preview: AiReviewScopePreview,
    pub batch_count: usize,
    pub batch_file_limit: usize,
    pub pipeline_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewResult {
    pub request_id: String,
    pub model: String,
    pub provider_host: String,
    pub summary: String,
    pub overall_risk: String,
    pub findings: Vec<AiReviewFinding>,
    pub positive_notes: Vec<String>,
    pub test_suggestions: Vec<String>,
    pub scope_kind: String,
    pub scope_label: String,
    pub selected_file_count: usize,
    pub included_file_count: usize,
    pub excluded_files: Vec<AiCommitInputNotice>,
    pub summary_only_files: Vec<AiCommitInputNotice>,
    pub binary_files: Vec<AiCommitInputNotice>,
    pub sanitized_bytes: usize,
    pub redacted_line_count: u32,
    pub snapshot_fingerprint: String,
    pub current_snapshot_fingerprint: String,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewDelivery {
    #[serde(flatten)]
    pub review: AiReviewResult,
    pub batch_count: usize,
    pub completed_batch_count: usize,
    pub completed_file_count: usize,
    pub failed_batch_count: usize,
    pub partial_success: bool,
    pub batch_failures: Vec<AiReviewBatchFailure>,
    pub cache_hit: bool,
    pub pipeline_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelResult {
    pub request_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgressEvent {
    pub request_id: String,
    pub kind: String,
    pub status: String,
    pub phase: String,
    pub label: String,
    pub completed_units: Option<u32>,
    pub total_units: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::{
        AiCommitInputNotice, AiCommitStyle, AiOutputLanguage, AiProviderConfig,
        AiReviewBatchFailure, AiReviewFinding, MAX_AI_TIMEOUT_SECONDS,
    };

    #[test]
    fn normalizes_provider_configuration() {
        let normalized = AiProviderConfig {
            endpoint: " https://example.com/v1/ ".to_string(),
            default_model: " model-a ".to_string(),
            review_model: Some("  ".to_string()),
            commit_model: Some(" commit-a ".to_string()),
            output_language: AiOutputLanguage::ZhCn,
            commit_style: AiCommitStyle::Plain,
            use_recent_commit_style: false,
            timeout_seconds: u64::MAX,
        }
        .normalized();

        assert_eq!(normalized.endpoint, "https://example.com/v1");
        assert_eq!(normalized.default_model, "model-a");
        assert_eq!(normalized.review_model, None);
        assert_eq!(normalized.commit_model.as_deref(), Some("commit-a"));
        assert_eq!(normalized.timeout_seconds, MAX_AI_TIMEOUT_SECONDS);
    }

    #[test]
    fn commit_input_notice_is_structurally_comparable() {
        assert_eq!(
            AiCommitInputNotice {
                path: ".env".to_string(),
                reason: "sensitive".to_string(),
            },
            AiCommitInputNotice {
                path: ".env".to_string(),
                reason: "sensitive".to_string(),
            }
        );
    }

    #[test]
    fn review_finding_is_structurally_comparable() {
        let finding = AiReviewFinding {
            id: "finding-1".to_string(),
            severity: "P1".to_string(),
            title: "Example".to_string(),
            file: Some("src/main.rs".to_string()),
            start_line: Some(10),
            end_line: Some(12),
            explanation: "Example finding".to_string(),
            suggestion: None,
        };
        assert_eq!(finding.clone(), finding);
    }

    #[test]
    fn review_batch_failure_is_structurally_comparable() {
        let failure = AiReviewBatchFailure {
            batch_index: 2,
            file_count: 8,
            code: "AI_TIMEOUT".to_string(),
            message: "timeout".to_string(),
            retryable: true,
        };
        assert_eq!(failure.clone(), failure);
    }
}
