use serde_json::{Value, json};

use crate::conversion::{
    UpstreamToolChoiceProtocol, normalize_proxy_responses_request, resolve_upstream_tool_choice,
};
use crate::drivers::DriverEndpointContext;
use crate::error::GatewayError;
use crate::request::{
    ContentBlock, Message, MessageRole, ProxyChatRequest, ProxyEmbeddingsRequest,
    ProxyResponsesRequest, anthropic_messages_to_openai_messages,
    anthropic_tool_choice_to_openai_tool_choice, anthropic_tools_to_openai_tools,
};
use crate::transport::TransportRequest;
use std::collections::HashMap;

pub fn build_chat_request(
    endpoint: &mut DriverEndpointContext,
    request: &ProxyChatRequest,
) -> Result<TransportRequest, GatewayError> {
    let mut payload = serde_json::Map::from_iter([
        (
            "model".to_string(),
            Value::String(resolved_model(endpoint, &request.model)),
        ),
        (
            "messages".to_string(),
            Value::Array(openai_chat_messages(request)?),
        ),
        ("stream".to_string(), Value::Bool(request.stream)),
    ]);

    if let Some(temperature) = request.temperature {
        payload.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        payload.insert("top_p".to_string(), json!(top_p));
    }
    if let Some(top_k) = request.top_k {
        payload.insert("top_k".to_string(), json!(top_k));
    }
    apply_openai_chat_output_token_limit(&mut payload, request);
    if let Some(stop) = request.stop_sequences.clone() {
        payload.insert("stop".to_string(), stop);
    }
    if let Some(tools) = anthropic_tools_to_openai_tools(request.tools.clone()) {
        payload.insert("tools".to_string(), tools);
    }
    let openai_tools = payload.get("tools");
    let openai_tool_choice =
        anthropic_tool_choice_to_openai_tool_choice(request.tool_choice.clone())?;
    if let Some(tool_choice) =
        apply_openai_upstream_tool_choice(endpoint, openai_tool_choice, openai_tools)
    {
        payload.insert("tool_choice".to_string(), tool_choice);
    }

    let is_claude = request.model.to_lowercase().contains("claude");
    let is_xml_think = request
        .metadata
        .get("unigateway.reasoning_text_encoding")
        .map(|s| s.as_str())
        == Some("xml_think_tag");

    let has_explicit_thinking = request.extra.contains_key("thinking")
        || request.extra.contains_key("enable_thinking")
        || request.extra.contains_key("reasoning");

    if is_claude && is_xml_think && !has_explicit_thinking {
        let max_tokens = request.max_tokens.unwrap_or(4096);
        if max_tokens > 1024 {
            let budget_tokens = (max_tokens / 2).max(1024);
            payload.insert(
                "thinking".to_string(),
                json!({
                    "type": "enabled",
                    "budget_tokens": budget_tokens
                }),
            );
            if request.max_tokens.is_none() {
                payload.insert("max_tokens".to_string(), json!(max_tokens));
            }
        }
    }

    for (key, value) in request.extra.clone() {
        if key == "max_tokens" && request.extra.contains_key("max_completion_tokens") {
            continue;
        }
        if is_anthropic_only_extra_key(&key) {
            continue;
        }
        payload.entry(key).or_insert(value);
    }

    TransportRequest::post_json(
        Some(endpoint.endpoint_id.clone()),
        join_url(&endpoint.base_url, "chat/completions"),
        openai_headers(endpoint),
        &Value::Object(payload),
        None,
    )
}

/// Keys that originate from Anthropic's API spec and have no equivalent
/// meaning in the OpenAI Chat Completions schema.  When an Anthropic-protocol
/// client (e.g. Claude Code) sends a request that gets translated to an
/// OpenAI upstream, these fields must be stripped — otherwise strict OpenAI
/// endpoints (e.g. tokenhub) reject the payload with HTTP 400.
fn is_anthropic_only_extra_key(key: &str) -> bool {
    matches!(
        key,
        "thinking"
            | "enable_thinking"
            | "service_tier"
            | "anthropic_version"
            | "anthropic_beta"
    ) || key.starts_with("anthropic_")
}

fn openai_chat_messages(request: &ProxyChatRequest) -> Result<Vec<Value>, GatewayError> {
    if let Some(raw_messages) = request.raw_messages.as_ref() {
        // Check if raw_messages are in OpenAI format (preserved from client)
        if request.has_openai_raw_messages() {
            if let Some(messages_array) = raw_messages.as_array() {
                return Ok(messages_array.clone());
            }
            return Err(GatewayError::InvalidRequest(
                "openai raw_messages must be an array".to_string(),
            ));
        }
        // Otherwise, treat as Anthropic format and convert
        let mut messages = anthropic_messages_to_openai_messages(raw_messages)?;
        if let Some(system) = request.system.as_ref().and_then(Value::as_str) {
            messages.insert(
                0,
                json!({
                    "role": "system",
                    "content": system,
                }),
            );
        }
        return Ok(messages);
    }

    request.messages.iter().map(openai_chat_message).collect()
}

fn openai_chat_message(message: &Message) -> Result<Value, GatewayError> {
    let mut object = serde_json::Map::from_iter([(
        "role".to_string(),
        Value::String(openai_role(message.role).to_string()),
    )]);

    if message.role == MessageRole::Tool
        && let Some(ContentBlock::ToolResult {
            tool_use_id,
            content,
        }) = message
            .content
            .iter()
            .find(|block| matches!(block, ContentBlock::ToolResult { .. }))
    {
        object.insert(
            "tool_call_id".to_string(),
            Value::String(tool_use_id.clone()),
        );
        object.insert("content".to_string(), content.clone());
        return Ok(Value::Object(object));
    }

    object.insert("content".to_string(), openai_message_content(message));

    let thinking = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Thinking { thinking, .. } if !thinking.is_empty() => {
                Some(thinking.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !thinking.is_empty() {
        object.insert("reasoning_content".to_string(), Value::String(thinking));
    }

    let tool_calls = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => {
                let arguments = serde_json::to_string(input).ok()?;
                Some(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    }
                }))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if !tool_calls.is_empty() {
        object.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }

    Ok(Value::Object(object))
}

fn openai_message_content(message: &Message) -> Value {
    let content_blocks = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({
                "type": "text",
                "text": text,
            })),
            ContentBlock::Image { source, detail } => {
                let mut image_block = openai_image_content_block(source, detail.as_deref());
                if image_block.is_null() {
                    None
                } else {
                    Some(std::mem::take(&mut image_block))
                }
            }
            _ => None,
        })
        .collect::<Vec<_>>();

    match content_blocks.as_slice() {
        [] => Value::String(String::new()),
        [single] if single.get("type").and_then(Value::as_str) == Some("text") => single
            .get("text")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
        _ => Value::Array(content_blocks),
    }
}

fn openai_image_content_block(source: &Value, detail: Option<&str>) -> Value {
    match source.get("type").and_then(Value::as_str) {
        Some("url") => {
            let Some(url) = source.get("url").and_then(Value::as_str) else {
                return Value::Null;
            };
            let mut image_url =
                serde_json::Map::from_iter([("url".to_string(), Value::String(url.to_string()))]);
            if let Some(detail) = detail {
                image_url.insert("detail".to_string(), Value::String(detail.to_string()));
            }
            Value::Object(serde_json::Map::from_iter([
                ("type".to_string(), Value::String("image_url".to_string())),
                ("image_url".to_string(), Value::Object(image_url)),
            ]))
        }
        Some("base64") => {
            let Some(media_type) = source.get("media_type").and_then(Value::as_str) else {
                return Value::Null;
            };
            let Some(data) = source.get("data").and_then(Value::as_str) else {
                return Value::Null;
            };
            let data_url = format!("data:{media_type};base64,{data}");
            let mut image_url =
                serde_json::Map::from_iter([("url".to_string(), Value::String(data_url))]);
            if let Some(detail) = detail {
                image_url.insert("detail".to_string(), Value::String(detail.to_string()));
            }
            Value::Object(serde_json::Map::from_iter([
                ("type".to_string(), Value::String("image_url".to_string())),
                ("image_url".to_string(), Value::Object(image_url)),
            ]))
        }
        Some("file") => {
            let Some(file_id) = source.get("file_id").and_then(Value::as_str) else {
                return Value::Null;
            };
            let mut object = serde_json::Map::from_iter([
                ("type".to_string(), Value::String("input_image".to_string())),
                ("file_id".to_string(), Value::String(file_id.to_string())),
            ]);
            if let Some(detail) = detail {
                object.insert("detail".to_string(), Value::String(detail.to_string()));
            }
            Value::Object(object)
        }
        _ => Value::Null,
    }
}

pub fn build_responses_request(
    endpoint: &mut DriverEndpointContext,
    request: &ProxyResponsesRequest,
) -> Result<TransportRequest, GatewayError> {
    let mut request = request.clone();
    normalize_proxy_responses_request(&mut request);

    let mut payload = serde_json::Map::from_iter([
        (
            "model".to_string(),
            Value::String(resolved_model(endpoint, &request.model)),
        ),
        ("stream".to_string(), Value::Bool(request.stream)),
    ]);

    if let Some(input) = request.input.clone() {
        payload.insert("input".to_string(), input);
    }
    if let Some(instructions) = request.instructions.clone() {
        payload.insert("instructions".to_string(), Value::String(instructions));
    }
    if let Some(temperature) = request.temperature {
        payload.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        payload.insert("top_p".to_string(), json!(top_p));
    }
    if let Some(max_output_tokens) = request.max_output_tokens {
        payload.insert("max_output_tokens".to_string(), json!(max_output_tokens));
    }
    if let Some(tools) = request.tools.clone() {
        payload.insert("tools".to_string(), tools);
    }
    if let Some(tool_choice) = apply_openai_upstream_tool_choice(
        endpoint,
        request.tool_choice.clone(),
        payload.get("tools"),
    ) {
        payload.insert("tool_choice".to_string(), tool_choice);
    }
    if let Some(previous_response_id) = request.previous_response_id.clone() {
        payload.insert(
            "previous_response_id".to_string(),
            Value::String(previous_response_id),
        );
    }
    if let Some(reasoning) = request.reasoning.clone() {
        payload.insert("reasoning".to_string(), reasoning);
    }
    if let Some(request_metadata) = request.request_metadata.clone() {
        payload.insert("metadata".to_string(), request_metadata);
    }
    for (key, value) in request.extra.clone() {
        if is_anthropic_only_extra_key(&key) {
            continue;
        }
        payload.entry(key).or_insert(value);
    }

    TransportRequest::post_json(
        Some(endpoint.endpoint_id.clone()),
        join_url(&endpoint.base_url, "responses"),
        openai_headers(endpoint),
        &Value::Object(payload),
        None,
    )
}

pub fn build_embeddings_request(
    endpoint: &DriverEndpointContext,
    request: &ProxyEmbeddingsRequest,
) -> Result<TransportRequest, GatewayError> {
    let mut payload = serde_json::Map::from_iter([
        (
            "model".to_string(),
            Value::String(resolved_model(endpoint, &request.model)),
        ),
        ("input".to_string(), json!(request.input)),
    ]);

    if let Some(encoding_format) = request.encoding_format.clone() {
        payload.insert(
            "encoding_format".to_string(),
            Value::String(encoding_format),
        );
    }

    TransportRequest::post_json(
        Some(endpoint.endpoint_id.clone()),
        join_url(&endpoint.base_url, "embeddings"),
        openai_headers(endpoint),
        &Value::Object(payload),
        None,
    )
}

fn openai_headers(endpoint: &DriverEndpointContext) -> HashMap<String, String> {
    let mut headers = HashMap::from([
        (
            "authorization".to_string(),
            format!("Bearer {}", endpoint.api_key.expose_secret()),
        ),
        ("content-type".to_string(), "application/json".to_string()),
    ]);

    for (key, value) in &endpoint.metadata {
        let Some(header_name) = key.strip_prefix("http_header.") else {
            continue;
        };
        if !value.is_empty() {
            headers.insert(header_name.to_string(), value.clone());
        }
    }

    headers
}

fn resolved_model(endpoint: &DriverEndpointContext, requested_model: &str) -> String {
    endpoint
        .model_policy
        .model_mapping
        .get(requested_model)
        .cloned()
        .or_else(|| endpoint.model_policy.default_model.clone())
        .unwrap_or_else(|| requested_model.to_string())
}

fn apply_openai_chat_output_token_limit(
    payload: &mut serde_json::Map<String, Value>,
    request: &ProxyChatRequest,
) {
    if request.extra.contains_key("max_completion_tokens") {
        return;
    }

    if let Some(max_tokens) = request.max_tokens {
        payload.insert("max_tokens".to_string(), json!(max_tokens));
    }
}

fn openai_role(role: MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

fn join_url(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path)
}

fn apply_openai_upstream_tool_choice(
    endpoint: &mut DriverEndpointContext,
    tool_choice: Option<Value>,
    tools: Option<&Value>,
) -> Option<Value> {
    resolve_upstream_tool_choice(
        &mut endpoint.metadata,
        tool_choice,
        tools,
        &endpoint.capabilities.tool_calling(),
        UpstreamToolChoiceProtocol::OpenAi,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::{ClientProtocol, Message, MessageRole, ProxyChatRequest};
    use std::collections::HashMap;

    #[test]
    fn openai_chat_messages_preserves_tool_call_structure() {
        let tool_call = json!({
            "id": "call_123",
            "type": "function",
            "function": {
                "name": "get_weather",
                "arguments": "{\"location\": \"San Francisco\"}"
            }
        });

        let raw_messages = json!([
            {
                "role": "user",
                "content": "What's the weather?"
            },
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [tool_call]
            },
            {
                "role": "tool",
                "tool_call_id": "call_123",
                "content": "Sunny and 75°F"
            }
        ]);

        let mut request = ProxyChatRequest {
            model: "gpt-5.5".to_string(),
            messages: vec![
                Message::text(MessageRole::User, "What's the weather?"),
                Message::text(MessageRole::Assistant, ""),
                Message::text(MessageRole::Tool, "Sunny and 75°F"),
            ],
            raw_messages: Some(raw_messages),
            metadata: HashMap::new(),
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: None,
            stop_sequences: None,
            stream: false,
            system: None,
            tools: None,
            tool_choice: None,
            extra: HashMap::new(),
        };
        request.set_client_protocol(ClientProtocol::OpenAiChat);
        request.mark_openai_raw_messages();

        let messages = openai_chat_messages(&request).expect("messages");
        assert_eq!(messages.len(), 3);

        // Verify tool_calls are preserved
        let assistant_msg = &messages[1];
        assert_eq!(
            assistant_msg.get("role").and_then(Value::as_str),
            Some("assistant")
        );
        assert!(assistant_msg.get("tool_calls").is_some());

        // Verify tool_call_id is preserved
        let tool_msg = &messages[2];
        assert_eq!(tool_msg.get("role").and_then(Value::as_str), Some("tool"));
        assert_eq!(
            tool_msg.get("tool_call_id").and_then(Value::as_str),
            Some("call_123")
        );
    }

    #[test]
    fn openai_chat_messages_falls_back_to_flattened_when_no_raw() {
        let request = ProxyChatRequest {
            model: "gpt-4".to_string(),
            messages: vec![Message::text(MessageRole::User, "Hello")],
            raw_messages: None,
            metadata: HashMap::new(),
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: None,
            stop_sequences: None,
            stream: false,
            system: None,
            tools: None,
            tool_choice: None,
            extra: HashMap::new(),
        };

        let messages = openai_chat_messages(&request).expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].get("role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            messages[0].get("content").and_then(Value::as_str),
            Some("Hello")
        );
    }

    #[test]
    fn openai_chat_messages_preserves_structured_text_blocks() {
        let request = ProxyChatRequest {
            model: "gpt-4".to_string(),
            messages: vec![Message::from_blocks(
                MessageRole::Assistant,
                vec![
                    ContentBlock::Thinking {
                        thinking: "reasoning".to_string(),
                        signature: Some("real-signature".to_string()),
                    },
                    ContentBlock::Text {
                        text: "answer".to_string(),
                    },
                    ContentBlock::Text {
                        text: "answer".to_string(),
                    },
                    ContentBlock::ToolUse {
                        id: "call_1".to_string(),
                        name: "search".to_string(),
                        input: json!({"query": "rust"}),
                    },
                ],
            )],
            raw_messages: None,
            metadata: HashMap::new(),
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: None,
            stop_sequences: None,
            stream: false,
            system: None,
            tools: None,
            tool_choice: None,
            extra: HashMap::new(),
        };

        let messages = openai_chat_messages(&request).expect("messages");
        assert_eq!(
            messages[0]
                .get("content")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            messages[0]
                .pointer("/content/0/text")
                .and_then(Value::as_str),
            Some("answer")
        );
        assert_eq!(
            messages[0]
                .pointer("/content/1/text")
                .and_then(Value::as_str),
            Some("answer")
        );
        assert_eq!(
            messages[0].get("reasoning_content").and_then(Value::as_str),
            Some("reasoning")
        );
        assert_eq!(
            messages[0]
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }
}
