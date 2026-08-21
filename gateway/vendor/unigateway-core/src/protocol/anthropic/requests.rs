use std::collections::HashMap;

use serde_json::{Value, json};

use crate::conversion::{UpstreamToolChoiceProtocol, resolve_upstream_tool_choice};
use crate::drivers::DriverEndpointContext;
use crate::error::GatewayError;
use crate::request::openai_messages_to_anthropic_messages;
use crate::request::{
    ClientProtocol, MessageRole, ProxyChatRequest, content_blocks_to_anthropic_request,
    openai_tool_choice_to_anthropic_tool_choice, openai_tools_to_anthropic_tools,
    validate_anthropic_request_messages,
};
use crate::transport::TransportRequest;

pub fn build_chat_request(
    endpoint: &mut DriverEndpointContext,
    request: &ProxyChatRequest,
) -> Result<TransportRequest, GatewayError> {
    let mut system_parts = Vec::new();
    let mut fallback_messages = Vec::new();
    for message in &request.messages {
        match message.role {
            MessageRole::System => {
                let text = message.text_content();
                if !text.is_empty() {
                    system_parts.push(text);
                }
            }
            MessageRole::User | MessageRole::Assistant => {
                fallback_messages.push(json!({
                    "role": anthropic_role(message.role),
                    "content": Value::Array(content_blocks_to_anthropic_request(&message.content)?),
                }));
            }
            MessageRole::Tool => {}
        }
    }

    let fallback_system = request.system.clone().or_else(|| {
        if system_parts.is_empty() {
            None
        } else {
            Some(Value::String(system_parts.join("\n")))
        }
    });
    let (system, messages) = anthropic_chat_messages(request, fallback_system, fallback_messages)?;

    let mut payload = serde_json::Map::from_iter([
        (
            "model".to_string(),
            Value::String(resolved_model(endpoint, &request.model)),
        ),
        ("messages".to_string(), messages),
        (
            "max_tokens".to_string(),
            json!(request.max_tokens.unwrap_or(1024)),
        ),
        ("stream".to_string(), Value::Bool(request.stream)),
    ]);

    if let Some(system) = system {
        payload.insert("system".to_string(), system);
    }
    // Anthropic API forbids specifying both `temperature` and `top_p` in the same
    // request; doing so results in a 400 error. To improve compatibility with clients
    // that send both parameters (e.g. Cherry Studio), we prioritize `temperature` and
    // silently drop `top_p` when both are present.
    match (request.temperature, request.top_p) {
        (Some(temperature), _) => {
            payload.insert("temperature".to_string(), json!(temperature));
        }
        (None, Some(top_p)) => {
            payload.insert("top_p".to_string(), json!(top_p));
        }
        (None, None) => {}
    }
    if let Some(top_k) = request.top_k {
        payload.insert("top_k".to_string(), json!(top_k));
    }
    if let Some(stop_sequences) = request.stop_sequences.clone() {
        payload.insert("stop_sequences".to_string(), stop_sequences);
    }
    if let Some(tools) = anthropic_tools(request)? {
        payload.insert("tools".to_string(), tools);
    }
    if let Some(tool_choice) = anthropic_tool_choice(endpoint, request, payload.get("tools"))? {
        payload.insert("tool_choice".to_string(), tool_choice);
    }
    for (key, value) in request.extra.clone() {
        payload.entry(key).or_insert(value);
    }

    // Defensive: extra fields (e.g. top_p) must not re-introduce a conflict
    // with temperature after the match block above. Anthropic API rejects
    // requests that specify both parameters.
    if payload.contains_key("temperature") && payload.contains_key("top_p") {
        payload.remove("top_p");
    }

    TransportRequest::post_json(
        Some(endpoint.endpoint_id.clone()),
        join_anthropic_url(&endpoint.base_url),
        anthropic_headers(endpoint),
        &Value::Object(payload),
        None,
    )
}

fn anthropic_chat_messages(
    request: &ProxyChatRequest,
    fallback_system: Option<Value>,
    fallback_messages: Vec<Value>,
) -> Result<(Option<Value>, Value), GatewayError> {
    let Some(raw_messages) = request.raw_messages.as_ref() else {
        return Ok((fallback_system, Value::Array(fallback_messages)));
    };

    if is_openai_chat_request(request) {
        return openai_messages_to_anthropic_messages(raw_messages, fallback_system);
    }

    validate_anthropic_request_messages(raw_messages)?;
    Ok((fallback_system, raw_messages.clone()))
}

fn anthropic_tools(request: &ProxyChatRequest) -> Result<Option<Value>, GatewayError> {
    if is_openai_chat_request(request) {
        return openai_tools_to_anthropic_tools(request.tools.clone());
    }

    Ok(request.tools.clone())
}

fn anthropic_tool_choice(
    endpoint: &mut DriverEndpointContext,
    request: &ProxyChatRequest,
    tools: Option<&Value>,
) -> Result<Option<Value>, GatewayError> {
    let converted = if !is_openai_chat_request(request) {
        request.tool_choice.clone()
    } else {
        openai_tool_choice_to_anthropic_tool_choice(request.tool_choice.clone())?
    };

    Ok(apply_anthropic_upstream_tool_choice(
        endpoint, converted, tools,
    ))
}

fn apply_anthropic_upstream_tool_choice(
    endpoint: &mut DriverEndpointContext,
    tool_choice: Option<Value>,
    tools: Option<&Value>,
) -> Option<Value> {
    resolve_upstream_tool_choice(
        &mut endpoint.metadata,
        tool_choice,
        tools,
        &endpoint.capabilities.tool_calling(),
        UpstreamToolChoiceProtocol::Anthropic,
    )
}

fn is_openai_chat_request(request: &ProxyChatRequest) -> bool {
    request.client_protocol() == Some(ClientProtocol::OpenAiChat)
        || request.has_openai_raw_messages()
}

fn anthropic_role(role: MessageRole) -> &'static str {
    match role {
        MessageRole::Assistant => "assistant",
        _ => "user",
    }
}

fn anthropic_headers(endpoint: &DriverEndpointContext) -> HashMap<String, String> {
    HashMap::from([
        (
            "x-api-key".to_string(),
            endpoint.api_key.expose_secret().to_string(),
        ),
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ("content-type".to_string(), "application/json".to_string()),
    ])
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

/// Builds the Anthropic messages endpoint URL.
///
/// The Anthropic API convention is `{base_url}/v1/messages`.  However some
/// providers (e.g. DeepSeek) accept `{base_url}/messages` without the `v1/`
/// segment, while others (e.g. tokenhub) strictly require the `v1/` segment.
///
/// To support both, we check whether the configured `base_url` already ends
/// with `/v1` (or `/v1/`).  If so, we append only `messages`; otherwise we
/// insert the `v1/` segment, matching the behaviour of the official Anthropic
/// SDK.
fn join_anthropic_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{}/messages", trimmed)
    } else {
        format!("{}/v1/messages", trimmed)
    }
}
