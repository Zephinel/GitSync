fn cancellation_registry() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    CANCELLATION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBranchNameRequest {
    pub request_id: String,
    pub repo_path: String,
    pub repo_name: String,
    pub task_description: String,
    pub source_type: String,
    #[serde(default)]
    pub include_repository_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiBranchNameSuggestion {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBranchNameResult {
    pub request_id: String,
    pub model: String,
    pub provider_host: String,
    pub suggestions: Vec<AiBranchNameSuggestion>,
    pub used_repository_context: bool,
    pub branch_sample_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBranchNameCancelResult {
    pub request_id: String,
    pub cancelled: bool,
}

fn normalize_request_id(value: &str) -> Result<String, AiUiError> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(AiUiError::new(
            "AI_INTERNAL",
            "请求 ID 无效",
            "AI 分支命名请求 ID 包含不受支持的字符或超过长度限制。",
            false,
        ));
    }
    Ok(normalized.to_string())
}

async fn register_request(request_id: &str) -> Result<oneshot::Receiver<()>, AiUiError> {
    let (sender, receiver) = oneshot::channel();
    let mut registry = cancellation_registry().lock().await;
    if registry.contains_key(request_id) {
        return Err(AiUiError::new(
            "AI_INTERNAL",
            "请求 ID 冲突",
            "相同的 AI 分支命名请求正在运行，请稍后重试。",
            true,
        )
        .with_request_id(request_id));
    }
    if registry.len() >= MAX_ACTIVE_BRANCH_NAME_REQUESTS {
        return Err(AiUiError::new(
            "AI_RATE_LIMITED",
            "AI 请求过多",
            "当前已有过多分支命名请求正在运行，请等待部分请求结束后重试。",
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

fn validate_request(request: &AiBranchNameRequest) -> Result<(), AiUiError> {
    let task = request.task_description.trim();
    if task.len() < 3 {
        return Err(AiUiError::new(
            "AI_INVALID_INPUT",
            "任务描述不足",
            "请先填写至少 3 个字符的任务描述，再请求 AI 分支名建议。",
            false,
        )
        .with_request_id(&request.request_id));
    }
    if task.chars().count() > MAX_TASK_DESCRIPTION_CHARS {
        return Err(AiUiError::new(
            "AI_INVALID_INPUT",
            "任务描述过长",
            format!("任务描述最多允许 {} 个字符。", MAX_TASK_DESCRIPTION_CHARS),
            false,
        )
        .with_request_id(&request.request_id));
    }
    if request.repo_name.chars().count() > MAX_REPOSITORY_NAME_CHARS {
        return Err(AiUiError::new(
            "AI_INVALID_INPUT",
            "仓库名称过长",
            "仓库显示名称超过允许长度。",
            false,
        )
        .with_request_id(&request.request_id));
    }
    Ok(())
}

fn new_git_command(repo_path: &str, args: &[&str]) -> Command {
    crate::git_command::new_read_only_async_command(repo_path, args)
}

async fn read_branch_samples(repo_path: &str) -> Result<Vec<String>, AiUiError> {
    if repo_path.trim().is_empty() || !Path::new(repo_path.trim()).is_dir() {
        return Err(AiUiError::new(
            "AI_INVALID_INPUT",
            "仓库上下文不可用",
            "无法读取用户明确允许的仓库命名样本。",
            true,
        ));
    }
    let mut command = new_git_command(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_CONTEXT_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| {
        AiUiError::new(
            "AI_CONTEXT_FAILED",
            "仓库上下文读取超时",
            "读取有限分支命名样本超时；可以关闭仓库上下文后重试。",
            true,
        )
    })?
    .map_err(|_| {
        AiUiError::new(
            "AI_CONTEXT_FAILED",
            "仓库上下文读取失败",
            "无法读取有限分支命名样本；可以关闭仓库上下文后重试。",
            true,
        )
    })?;
    if !output.status.success() {
        return Err(AiUiError::new(
            "AI_CONTEXT_FAILED",
            "仓库上下文读取失败",
            "Git 无法提供分支命名样本；可以关闭仓库上下文后重试。",
            true,
        ));
    }

    let mut seen = HashSet::new();
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && !value.ends_with("/HEAD")
                && value.chars().count() <= 120
                && seen.insert(value.to_string())
        })
        .take(MAX_BRANCH_SAMPLE_COUNT)
        .map(str::to_string)
        .collect())
}
