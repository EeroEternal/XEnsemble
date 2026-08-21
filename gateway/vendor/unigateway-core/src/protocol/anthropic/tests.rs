use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::{AnthropicDriver, build_chat_request};
use crate::GatewayError;
use crate::capabilities::EndpointCapabilities;
use crate::drivers::{DriverEndpointContext, ProviderDriver};
use crate::pool::{ModelPolicy, ProviderKind, SecretString};
use crate::request::{
    ClientProtocol, ContentBlock, Message, MessageRole, ProxyChatRequest,
    THINKING_SIGNATURE_PLACEHOLDER_VALUE,
};
use crate::response::ProxySession;
use crate::transport::{
    HttpTransport, StreamingTransportResponse, TransportRequest, TransportResponse,
};

struct MockTransport {
    response: Option<TransportResponse>,
    stream_chunks: Option<Vec<Vec<u8>>>,
    seen: Arc<Mutex<Vec<TransportRequest>>>,
}

impl HttpTransport for MockTransport {
    fn send(
        &self,
        request: TransportRequest,
    ) -> BoxFuture<'static, Result<TransportResponse, crate::GatewayError>> {
        let seen = self.seen.clone();
        let response = self.response.clone().expect("missing non-stream response");
        Box::pin(async move {
            seen.lock().expect("seen lock").push(request);
            Ok(response)
        })
    }

    fn send_stream(
        &self,
        request: TransportRequest,
    ) -> BoxFuture<'static, Result<StreamingTransportResponse, crate::GatewayError>> {
        let seen = self.seen.clone();
        let chunks = self.stream_chunks.clone().expect("missing stream chunks");

        Box::pin(async move {
            seen.lock().expect("seen lock").push(request);
            Ok(StreamingTransportResponse {
                status: 200,
                headers: HashMap::new(),
                stream: Box::pin(futures_util::stream::iter(
                    chunks.into_iter().map(Ok::<Vec<u8>, GatewayError>),
                )),
            })
        })
    }
}

fn endpoint() -> DriverEndpointContext {
    DriverEndpointContext {
        endpoint_id: "anth-1".to_string(),
        provider_kind: ProviderKind::Anthropic,
        base_url: "https://api.anthropic.com/v1/".to_string(),
        api_key: SecretString::new("sk-ant"),
        model_policy: ModelPolicy::default(),
        capabilities: EndpointCapabilities::default(),
        metadata: HashMap::from([("pool_id".to_string(), "beta".to_string())]),
    }
}

fn endpoint_with_base(base_url: &str) -> DriverEndpointContext {
    DriverEndpointContext {
        endpoint_id: "anth-1".to_string(),
        provider_kind: ProviderKind::Anthropic,
        base_url: base_url.to_string(),
        api_key: SecretString::new("sk-ant"),
        model_policy: ModelPolicy::default(),
        capabilities: EndpointCapabilities::default(),
        metadata: HashMap::from([("pool_id".to_string(), "beta".to_string())]),
    }
}

#[test]
fn build_chat_request_url_includes_v1_when_base_url_omits_it() {
    // tokenhub: base_url = https://ai-tokenhub.com/api/anthropic/
    // expected URL: https://ai-tokenhub.com/api/anthropic/v1/messages
    let mut ep = endpoint_with_base("https://ai-tokenhub.com/api/anthropic/");
    let request = build_chat_request(&mut ep, &ProxyChatRequest {
        model: "claude-3-5-sonnet".to_string(),
        messages: vec![Message::text(MessageRole::User, "hi")],
        system: None, tools: None, tool_choice: None, raw_messages: None,
        temperature: None, top_p: None, top_k: None,
        max_tokens: Some(32), stop_sequences: None, stream: false,
        extra: HashMap::new(), metadata: HashMap::new(),
    })
    .expect("request");
    assert_eq!(request.url, "https://ai-tokenhub.com/api/anthropic/v1/messages");
}

#[test]
fn build_chat_request_url_omits_extra_v1_when_base_url_already_has_it() {
    // DeepSeek: base_url = https://api.deepseek.com/anthropic/v1
    // expected URL: https://api.deepseek.com/anthropic/v1/messages (no double v1)
    let mut ep = endpoint_with_base("https://api.deepseek.com/anthropic/v1");
    let request = build_chat_request(&mut ep, &ProxyChatRequest {
        model: "claude-3-5-sonnet".to_string(),
        messages: vec![Message::text(MessageRole::User, "hi")],
        system: None, tools: None, tool_choice: None, raw_messages: None,
        temperature: None, top_p: None, top_k: None,
        max_tokens: Some(32), stop_sequences: None, stream: false,
        extra: HashMap::new(), metadata: HashMap::new(),
    })
    .expect("request");
    assert_eq!(request.url, "https://api.deepseek.com/anthropic/v1/messages");
}

#[test]
fn build_chat_request_moves_system_messages_to_top_level_field() {
    let request = build_chat_request(
        &mut endpoint(),
        &ProxyChatRequest {
            model: "claude-3-5-sonnet".to_string(),
            messages: vec![
                Message::text(MessageRole::System, "be concise"),
                Message::text(MessageRole::User, "hello"),
            ],
            system: None,
            tools: None,
            tool_choice: None,
            raw_messages: None,
            temperature: Some(0.2),
            top_p: None,
            top_k: Some(8),
            max_tokens: None,
            stop_sequences: Some(json!(["DONE", "HALT"])),
            stream: false,
            extra: HashMap::new(),
            metadata: HashMap::new(),
        },
    )
    .expect("anthropic request");

    assert_eq!(request.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(
        request.headers.get("x-api-key").map(String::as_str),
        Some("sk-ant")
    );

    let body: serde_json::Value =
        serde_json::from_slice(&request.body.expect("body")).expect("json body");
    assert_eq!(
        body.get("system").and_then(serde_json::Value::as_str),
        Some("be concise")
    );
    assert_eq!(
        body.get("max_tokens").and_then(serde_json::Value::as_u64),
        Some(1024)
    );
    assert_eq!(
        body.get("top_k").and_then(serde_json::Value::as_u64),
        Some(8)
    );
    assert_eq!(
        body.get("stop_sequences")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len),
        Some(2)
    );
}

#[test]
fn build_chat_request_preserves_structured_image_blocks_without_raw_messages() {
    let request = build_chat_request(
        &mut endpoint(),
        &ProxyChatRequest {
            model: "claude-3-5-sonnet".to_string(),
            messages: vec![Message::from_blocks(
                MessageRole::User,
                vec![
                    ContentBlock::Text {
                        text: "describe this".to_string(),
                    },
                    ContentBlock::Image {
                        source: json!({
                            "type": "url",
                            "url": "https://example.com/a.png"
                        }),
                        detail: Some("high".to_string()),
                    },
                ],
            )],
            system: None,
            tools: None,
            tool_choice: None,
            raw_messages: None,
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: Some(128),
            stop_sequences: None,
            stream: false,
            extra: HashMap::new(),
            metadata: HashMap::new(),
        },
    )
    .expect("anthropic request");

    let body: Value = serde_json::from_slice(&request.body.expect("body")).expect("json body");
    assert_eq!(
        body.pointer("/messages/0/content/0/type")
            .and_then(Value::as_str),
        Some("text")
    );
    assert_eq!(
        body.pointer("/messages/0/content/1/type")
            .and_then(Value::as_str),
        Some("image")
    );
    assert_eq!(
        body.pointer("/messages/0/content/1/source/type")
            .and_then(Value::as_str),
        Some("url")
    );
    assert_eq!(
        body.pointer("/messages/0/content/1/source/url")
            .and_then(Value::as_str),
        Some("https://example.com/a.png")
    );
}

#[test]
fn build_chat_request_converts_openai_raw_messages_to_anthropic_messages() {
    let mut request = ProxyChatRequest {
        model: "claude-3-5-sonnet".to_string(),
        messages: Vec::new(),
        system: None,
        tools: Some(json!([{
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search documents",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"}
                    }
                }
            }
        }])),
        tool_choice: Some(json!({
            "type": "function",
            "function": {"name": "search"}
        })),
        raw_messages: Some(json!([
            {"role": "system", "content": "be precise"},
            {"role": "user", "content": "find rust examples"},
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": "{\"query\":\"rust examples\"}"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "result text"
            }
        ])),
        temperature: None,
        top_p: None,
        top_k: None,
        max_tokens: Some(256),
        stop_sequences: None,
        stream: false,
        extra: HashMap::new(),
        metadata: HashMap::new(),
    };
    request.set_client_protocol(ClientProtocol::OpenAiChat);
    request.mark_openai_raw_messages();

    let request = build_chat_request(&mut endpoint(), &request).expect("anthropic request");

    let body: serde_json::Value =
        serde_json::from_slice(&request.body.expect("body")).expect("json body");
    assert_eq!(
        body.get("system").and_then(serde_json::Value::as_str),
        Some("be precise")
    );

    let messages = body
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .expect("messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[0].get("role").and_then(Value::as_str),
        Some("user")
    );
    assert_eq!(
        messages[0]
            .get("content")
            .and_then(Value::as_array)
            .and_then(|blocks| blocks.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str),
        Some("find rust examples")
    );

    let tool_use = messages[1]
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.first())
        .expect("tool use block");
    assert_eq!(
        tool_use.get("type").and_then(Value::as_str),
        Some("tool_use")
    );
    assert_eq!(tool_use.get("id").and_then(Value::as_str), Some("call_1"));
    assert_eq!(tool_use.get("name").and_then(Value::as_str), Some("search"));
    assert_eq!(
        tool_use
            .get("input")
            .and_then(|input| input.get("query"))
            .and_then(Value::as_str),
        Some("rust examples")
    );

    let tool_result = messages[2]
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.first())
        .expect("tool result block");
    assert_eq!(
        tool_result.get("type").and_then(Value::as_str),
        Some("tool_result")
    );
    assert_eq!(
        tool_result.get("tool_use_id").and_then(Value::as_str),
        Some("call_1")
    );

    let tool = body
        .get("tools")
        .and_then(Value::as_array)
        .and_then(|tools| tools.first())
        .expect("converted tool");
    assert_eq!(tool.get("name").and_then(Value::as_str), Some("search"));
    assert!(tool.get("input_schema").is_some());

    assert_eq!(
        body.get("tool_choice")
            .and_then(|choice| choice.get("type"))
            .and_then(Value::as_str),
        Some("tool")
    );
}

#[test]
fn build_chat_request_preserves_anthropic_raw_messages() {
    let raw_messages = json!([{
        "role": "assistant",
        "content": [{
            "type": "thinking",
            "thinking": "original reasoning",
            "signature": "real-signature"
        }, {
            "type": "text",
            "text": "answer"
        }]
    }]);

    let request = build_chat_request(
        &mut endpoint(),
        &ProxyChatRequest {
            model: "claude-3-5-sonnet".to_string(),
            messages: Vec::new(),
            system: Some(json!("native system")),
            tools: Some(json!([{
                "name": "native_tool",
                "input_schema": {"type": "object", "properties": {}}
            }])),
            tool_choice: Some(json!({"type": "auto"})),
            raw_messages: Some(raw_messages.clone()),
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: Some(256),
            stop_sequences: None,
            stream: false,
            extra: HashMap::new(),
            metadata: HashMap::from([(
                "unigateway.client_protocol".to_string(),
                ClientProtocol::AnthropicMessages
                    .as_metadata_value()
                    .to_string(),
            )]),
        },
    )
    .expect("anthropic request");

    let body: serde_json::Value =
        serde_json::from_slice(&request.body.expect("body")).expect("json body");
    assert_eq!(body.get("messages"), Some(&raw_messages));
    assert_eq!(
        body.pointer("/messages/0/content/0/signature")
            .and_then(Value::as_str),
        Some("real-signature")
    );
    assert_eq!(
        body.pointer("/tools/0/name").and_then(Value::as_str),
        Some("native_tool")
    );
    assert_eq!(
        body.pointer("/tool_choice/type").and_then(Value::as_str),
        Some("auto")
    );
}

#[test]
fn build_chat_request_rejects_placeholder_signature_in_anthropic_raw_messages() {
    let error = build_chat_request(
        &mut endpoint(),
        &ProxyChatRequest {
            model: "claude-3-5-sonnet".to_string(),
            messages: Vec::new(),
            system: None,
            tools: None,
            tool_choice: None,
            raw_messages: Some(json!([{
                "role": "assistant",
                "content": [{
                    "type": "thinking",
                    "thinking": "renderer-only reasoning",
                    "signature": THINKING_SIGNATURE_PLACEHOLDER_VALUE
                }]
            }])),
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: Some(256),
            stop_sequences: None,
            stream: false,
            extra: HashMap::new(),
            metadata: HashMap::from([(
                "unigateway.client_protocol".to_string(),
                ClientProtocol::AnthropicMessages
                    .as_metadata_value()
                    .to_string(),
            )]),
        },
    )
    .expect_err("placeholder signature should be rejected");

    assert!(matches!(error, GatewayError::InvalidRequest(_)));
}

#[test]
fn build_chat_request_merges_anthropic_extra_without_overriding_core_fields() {
    let request = build_chat_request(
        &mut endpoint(),
        &ProxyChatRequest {
            model: "claude-opus-4-6".to_string(),
            messages: vec![crate::request::Message::text(MessageRole::User, "hello")],
            system: None,
            tools: None,
            tool_choice: None,
            raw_messages: None,
            temperature: None,
            top_p: None,
            top_k: None,
            max_tokens: Some(1400),
            stop_sequences: None,
            stream: false,
            extra: HashMap::from([
                (
                    "thinking".to_string(),
                    json!({
                        "type": "enabled",
                        "budget_tokens": 1024,
                        "display": "omitted"
                    }),
                ),
                (
                    "output_config".to_string(),
                    json!({
                        "effort": "medium"
                    }),
                ),
                ("max_tokens".to_string(), json!(999)),
            ]),
            metadata: HashMap::from([(
                "unigateway.client_protocol".to_string(),
                ClientProtocol::AnthropicMessages
                    .as_metadata_value()
                    .to_string(),
            )]),
        },
    )
    .expect("anthropic request");

    let body: serde_json::Value =
        serde_json::from_slice(&request.body.expect("body")).expect("json body");
    assert_eq!(
        body.get("thinking"),
        Some(&json!({
            "type": "enabled",
            "budget_tokens": 1024,
            "display": "omitted"
        }))
    );
    assert_eq!(
        body.get("output_config"),
        Some(&json!({"effort": "medium"}))
    );
    assert_eq!(body.get("max_tokens").and_then(Value::as_u64), Some(1400));
}

#[tokio::test]
async fn anthropic_driver_executes_non_streaming_chat() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let transport = Arc::new(MockTransport {
        response: Some(TransportResponse {
            status: 200,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({
                "model": "claude-3-5-sonnet",
                "content": [{"type": "text", "text": "hello from claude"}],
                "usage": {"input_tokens": 11, "output_tokens": 13}
            }))
            .expect("response body"),
        }),
        stream_chunks: None,
        seen: seen.clone(),
    });
    let driver = AnthropicDriver::new(transport);

    let session = driver
        .execute_chat(
            endpoint(),
            ProxyChatRequest {
                model: "claude-3-5-sonnet".to_string(),
                messages: vec![Message::text(MessageRole::User, "hello")],
                system: None,
                tools: None,
                tool_choice: None,
                raw_messages: None,
                temperature: None,
                top_p: None,
                top_k: None,
                max_tokens: Some(256),
                stop_sequences: None,
                stream: false,
                extra: HashMap::new(),
                metadata: HashMap::new(),
            },
        )
        .await
        .expect("chat result");

    match session {
        ProxySession::Completed(response) => {
            assert_eq!(
                response.response.output_text.as_deref(),
                Some("hello from claude")
            );
            assert_eq!(response.report.selected_endpoint_id, "anth-1");
            assert_eq!(
                response
                    .report
                    .usage
                    .as_ref()
                    .and_then(|usage| usage.total_tokens),
                Some(24)
            );
        }
        ProxySession::Streaming(_) => panic!("expected completed response"),
    }

    assert_eq!(seen.lock().expect("seen lock").len(), 1);
}

#[tokio::test]
async fn anthropic_driver_executes_streaming_chat() {
    let transport = Arc::new(MockTransport {
        response: None,
        stream_chunks: Some(vec![
            b"event: message_start\ndata: {\"type\":\"message_start\",\"model\":\"claude-3-5-sonnet\"}\n\n".to_vec(),
            b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n".to_vec(),
            b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n\n".to_vec(),
            b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec(),
        ]),
        seen: Arc::new(Mutex::new(Vec::new())),
    });
    let driver = AnthropicDriver::new(transport);

    let session = driver
        .execute_chat(
            endpoint(),
            ProxyChatRequest {
                model: "claude-3-5-sonnet".to_string(),
                messages: vec![Message::text(MessageRole::User, "hello")],
                system: None,
                tools: None,
                tool_choice: None,
                raw_messages: None,
                temperature: None,
                top_p: None,
                top_k: None,
                max_tokens: Some(128),
                stop_sequences: None,
                stream: true,
                extra: HashMap::new(),
                metadata: HashMap::new(),
            },
        )
        .await
        .expect("streaming chat session");

    match session {
        ProxySession::Streaming(streaming) => {
            let chunks = streaming
                .stream
                .map(|item| item.expect("chunk"))
                .collect::<Vec<_>>()
                .await;
            assert_eq!(chunks.len(), 4);
            assert_eq!(chunks[1].delta.as_deref(), Some("hello"));

            let completion = streaming
                .completion
                .await
                .expect("completion receiver")
                .expect("completion result");
            assert_eq!(completion.report.request_id, streaming.request_id);
            assert_eq!(completion.response.output_text.as_deref(), Some("hello"));
            assert_eq!(
                completion
                    .report
                    .usage
                    .as_ref()
                    .and_then(|usage| usage.total_tokens),
                Some(15)
            );
        }
        ProxySession::Completed(_) => panic!("expected streaming response"),
    }
}

#[test]
fn build_chat_request_drops_top_p_when_both_temperature_and_top_p_present() {
    // Regression test: even if extra re-introduces top_p, the defensive check
    // after the extra merge must remove it when temperature is also present.
    let request = build_chat_request(
        &mut endpoint(),
        &ProxyChatRequest {
            model: "claude-3-5-sonnet".to_string(),
            messages: vec![Message::text(MessageRole::User, "hello")],
            system: None,
            tools: None,
            tool_choice: None,
            raw_messages: None,
            temperature: Some(0.7),
            top_p: Some(0.9),
            top_k: None,
            max_tokens: Some(1024),
            stop_sequences: None,
            stream: false,
            // Simulate a client that sends both params and extra somehow retains top_p
            extra: HashMap::from([("top_p".to_string(), json!(0.9))]),
            metadata: HashMap::new(),
        },
    )
    .expect("anthropic request");

    let body: serde_json::Value =
        serde_json::from_slice(&request.body.expect("body")).expect("json body");
    assert!(
        body.get("temperature").is_some(),
        "temperature should be present"
    );
    assert!(
        body.get("top_p").is_none(),
        "top_p must be removed when temperature is also present, but got: {}",
        body
    );
}

#[tokio::test]
async fn anthropic_driver_streaming_chat_completion_survives_dropped_stream() {
    let transport = Arc::new(MockTransport {
        response: None,
        stream_chunks: Some(vec![
            b"event: message_start\ndata: {\"type\":\"message_start\",\"model\":\"claude-3-5-sonnet\"}\n\n".to_vec(),
            b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n".to_vec(),
            b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n\n".to_vec(),
            b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec(),
        ]),
        seen: Arc::new(Mutex::new(Vec::new())),
    });
    let driver = AnthropicDriver::new(transport);

    let session = driver
        .execute_chat(
            endpoint(),
            ProxyChatRequest {
                model: "claude-3-5-sonnet".to_string(),
                messages: vec![Message::text(MessageRole::User, "hello")],
                system: None,
                tools: None,
                tool_choice: None,
                raw_messages: None,
                temperature: None,
                top_p: None,
                top_k: None,
                max_tokens: Some(128),
                stop_sequences: None,
                stream: true,
                extra: HashMap::new(),
                metadata: HashMap::new(),
            },
        )
        .await
        .expect("streaming chat session");

    match session {
        ProxySession::Streaming(streaming) => {
            let completion = streaming
                .into_completion()
                .await
                .expect("completion result after dropped stream");
            assert_eq!(completion.response.output_text.as_deref(), Some("hello"));
            assert_eq!(
                completion
                    .report
                    .usage
                    .as_ref()
                    .and_then(|usage| usage.total_tokens),
                Some(15)
            );
        }
        ProxySession::Completed(_) => panic!("expected streaming response"),
    }
}
