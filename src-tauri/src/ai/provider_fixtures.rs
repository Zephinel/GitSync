use serde_json::{json, Value};

fn extract_chat_content(value: &Value) -> Option<String> {
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

fn extract_models(value: &Value) -> Vec<String> {
    value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str().or_else(|| {
                item.get("id")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("model").and_then(Value::as_str))
                    .or_else(|| item.get("name").and_then(Value::as_str))
            })
        })
        .map(str::to_string)
        .collect()
}

fn extract_error(value: &Value) -> Option<&str> {
    value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
}

#[test]
fn accepts_openai_chat_completion_contract() {
    let fixture = json!({
        "id": "chatcmpl-1",
        "choices": [{
            "message": { "role": "assistant", "content": "{\"summary\":\"ok\"}" },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        extract_chat_content(&fixture).as_deref(),
        Some("{\"summary\":\"ok\"}")
    );
}

#[test]
fn accepts_openrouter_content_part_contract() {
    let fixture = json!({
        "choices": [{
            "message": {
                "content": [
                    { "type": "text", "text": "{\"summary\":" },
                    { "type": "text", "text": "\"ok\"}" }
                ]
            }
        }]
    });
    assert_eq!(
        extract_chat_content(&fixture).as_deref(),
        Some("{\"summary\":\"ok\"}")
    );
}

#[test]
fn accepts_deepseek_message_content_with_reasoning_metadata() {
    let fixture = json!({
        "choices": [{
            "message": {
                "reasoning_content": "private chain not consumed",
                "content": "{\"summary\":\"ok\"}"
            }
        }]
    });
    assert_eq!(
        extract_chat_content(&fixture).as_deref(),
        Some("{\"summary\":\"ok\"}")
    );
}

#[test]
fn accepts_local_legacy_text_contract() {
    let fixture = json!({
        "choices": [{ "text": "legacy response" }]
    });
    assert_eq!(
        extract_chat_content(&fixture).as_deref(),
        Some("legacy response")
    );
}

#[test]
fn accepts_models_contract_variants() {
    assert_eq!(
        extract_models(&json!({ "data": [{ "id": "gpt-example" }] })),
        vec!["gpt-example"]
    );
    assert_eq!(
        extract_models(&json!({ "models": [{ "name": "local-example" }] })),
        vec!["local-example"]
    );
}

#[test]
fn accepts_common_error_envelopes_for_later_sanitization() {
    assert_eq!(
        extract_error(&json!({ "error": { "message": "rate limited" } })),
        Some("rate limited")
    );
    assert_eq!(
        extract_error(&json!({ "message": "local server error" })),
        Some("local server error")
    );
}
