fn language_instruction(language: AiOutputLanguage) -> &'static str {
    match language {
        AiOutputLanguage::ZhCn => "理由使用简体中文。",
        AiOutputLanguage::En => "Write reasons in English.",
        AiOutputLanguage::Auto => "理由语言跟随用户的任务描述。",
    }
}

fn build_prompt(
    request: &AiBranchNameRequest,
    config: &AiProviderConfig,
    branch_samples: &[String],
) -> (String, String) {
    let system = format!(
        "You are an optional Git branch naming assistant. Return only strict JSON. \
You may suggest names, but you must never choose a Git source, switch policy, publish policy, remote, or execute any repository operation. \
Return 3 to 5 unique candidates in this exact shape: \
{{\"suggestions\":[{{\"name\":\"type/short-kebab-slug\",\"reason\":\"brief reason\"}}]}}. \
Names must be concise Git branch names, avoid spaces, backslashes, repeated slashes, leading slash, trailing slash, '..', '@{{', and the literal HEAD. \
Use a sensible prefix such as feat, fix, docs, refactor, test, chore, perf, or build only when it fits. {}",
        language_instruction(config.output_language)
    );

    let context_section = if branch_samples.is_empty() {
        "No repository branch samples were provided. Do not invent or claim a repository-specific convention."
            .to_string()
    } else {
        format!(
            "The user explicitly allowed these limited branch-name samples only: {}. Infer style conservatively; do not echo unrelated names.",
            branch_samples.join(", ")
        )
    };
    let user = format!(
        "Repository display name: {}\nTask description: {}\nBroad source type: {}\n{}\nGenerate branch name suggestions only.",
        request.repo_name.trim(),
        request.task_description.trim(),
        request.source_type.trim(),
        context_section
    );
    (system, user)
}

fn basic_candidate_is_safe(value: &str) -> bool {
    let name = value.trim();
    !name.is_empty()
        && name != "HEAD"
        && name.len() <= 240
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.contains(char::is_whitespace)
        && !name.contains('\\')
        && !name.contains("//")
        && !name.contains("..")
        && !name.contains("@{")
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

fn strip_json_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(body) = trimmed
        .strip_prefix("```json\n")
        .and_then(|value| value.strip_suffix("\n```"))
    {
        return body.trim();
    }
    if let Some(body) = trimmed
        .strip_prefix("```\n")
        .and_then(|value| value.strip_suffix("\n```"))
    {
        return body.trim();
    }
    trimmed
}

fn parse_suggestions(raw: &str, request_id: &str) -> Result<Vec<AiBranchNameSuggestion>, AiUiError> {
    let value: Value = serde_json::from_str(strip_json_fence(raw)).map_err(|_| {
        AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI 建议格式无效",
            "Provider 未返回可验证的分支名称 JSON。",
            true,
        )
        .with_request_id(request_id)
    })?;
    let items = value
        .get("suggestions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AiUiError::new(
                "AI_INVALID_RESPONSE",
                "AI 建议缺失",
                "Provider 响应中没有分支名称建议。",
                true,
            )
            .with_request_id(request_id)
        })?;

    let mut seen = HashSet::new();
    let suggestions = items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim().to_string();
            let reason = item
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("AI 命名建议")
                .trim()
                .chars()
                .take(240)
                .collect::<String>();
            (basic_candidate_is_safe(&name) && seen.insert(name.clone())).then_some(
                AiBranchNameSuggestion {
                    name,
                    reason,
                },
            )
        })
        .take(5)
        .collect::<Vec<_>>();
    if suggestions.is_empty() {
        return Err(AiUiError::new(
            "AI_INVALID_RESPONSE",
            "没有有效建议",
            "AI 返回的候选名称全部无效或重复；请修改任务描述后重试，或直接手动输入。",
            true,
        )
        .with_request_id(request_id));
    }
    Ok(suggestions)
}
