use crate::ai::client::emit_progress;
use crate::ai::errors::AiUiError;
use crate::ai::provider::{load_config, validate_and_normalize_config, NormalizedAiEndpoint};
use crate::ai::sanitize::sanitize_provider_error_message;
use crate::ai::schema::{AiOutputLanguage, AiProviderConfig};
use crate::ai::secrets::read_api_key;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

const MAX_ACTIVE_BRANCH_NAME_REQUESTS: usize = 8;
const MAX_TASK_DESCRIPTION_CHARS: usize = 4_000;
const MAX_REPOSITORY_NAME_CHARS: usize = 160;
const MAX_BRANCH_SAMPLE_COUNT: usize = 12;
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const GIT_CONTEXT_TIMEOUT_MS: u64 = 4_000;

static CANCELLATION_REGISTRY: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    OnceLock::new();

include!("branch_name_request.rs");
include!("branch_name_prompt.rs");
include!("branch_name_http.rs");
include!("branch_name_commands.rs");
