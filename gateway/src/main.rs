use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use unigateway_config::core_sync::sync_core_pools;
use unigateway_config::{AuthError, GatewayState, ProviderModelOptions, RuntimeLimitError};
use unigateway_sdk::core::UniGatewayEngine;
use unigateway_sdk::host::{
    HostContext, HostDispatchOutcome, HostDispatchTarget, HostFuture, HostProtocol, HostRequest,
    PoolHost, PoolLookupOutcome, PoolLookupResult, dispatch_request,
};
use unigateway_sdk::protocol::{
    ProtocolResponseBody, anthropic_payload_to_chat_request,
    openai_model_object, openai_payload_to_chat_request, openai_payload_to_embed_request,
};

#[derive(Clone)]
struct AppState {
    gateway: Arc<GatewayState>,
    engine: Arc<UniGatewayEngine>,
    pool_host: Arc<EnginePoolHost>,
    admin_token: Option<String>,
}

struct EnginePoolHost {
    engine: Arc<UniGatewayEngine>,
}

impl PoolHost for EnginePoolHost {
    fn pool_for_service<'a>(
        &'a self,
        service_id: &'a str,
    ) -> HostFuture<'a, PoolLookupResult<PoolLookupOutcome>> {
        let engine = self.engine.clone();
        let service_id = service_id.to_string();
        Box::pin(async move {
            Ok(match engine.get_pool(&service_id).await {
                Some(pool) => PoolLookupOutcome::found(pool),
                None => PoolLookupOutcome::not_found(),
            })
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config_path = config_path_from_env();
    let bind_addr = bind_addr_from_env();
    let admin_token = std::env::var("UNIGATEWAY_ADMIN_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty());

    let gateway = GatewayState::load(&config_path)
        .await
        .with_context(|| format!("load gateway config at {}", config_path.display()))?;

    let engine = Arc::new(
        UniGatewayEngine::builder()
            .with_builtin_http_drivers()
            .build()
            .context("build UniGateway engine")?,
    );

    sync_core_pools(&gateway, engine.as_ref())
        .await
        .context("initial core pool sync")?;

    let (sync_tx, mut sync_rx) = mpsc::unbounded_channel();
    gateway.set_core_sync_notifier(sync_tx).await;

    let gateway_bg = gateway.clone();
    let engine_bg = engine.clone();
    tokio::spawn(async move {
        while sync_rx.recv().await.is_some() {
            if let Err(error) = sync_core_pools(&gateway_bg, &engine_bg).await {
                tracing::warn!(%error, "core pool sync failed");
            }
            if let Err(error) = gateway_bg.persist_if_dirty().await {
                tracing::warn!(%error, "config persist failed");
            }
        }
    });

    let pool_host = Arc::new(EnginePoolHost {
        engine: engine.clone(),
    });

    let state = AppState {
        gateway,
        engine: engine.clone(),
        pool_host,
        admin_token,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/chat/completions", post(openai_chat))
        .route("/v1/messages", post(anthropic_messages))
        .route("/v1/embeddings", post(openai_embeddings))
        .route("/v1/models", get(openai_list_models))
        .route("/v1/models/*model_id", get(openai_get_model))
        .route("/api/admin/modes", get(admin_modes))
        .route(
            "/api/admin/preferences/default-mode",
            post(admin_set_default_mode),
        )
        .route(
            "/api/admin/api-keys",
            post(admin_create_api_key).patch(admin_rebind_api_key),
        )
        .route(
            "/api/admin/providers",
            get(admin_list_providers).post(admin_create_provider),
        )
        .route(
            "/api/admin/providers/:name",
            patch(admin_update_provider).delete(admin_delete_provider),
        )
        .route("/api/admin/reload", post(admin_reload))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("bind {bind_addr}"))?;

    tracing::info!(
        config = %config_path.display(),
        addr = %bind_addr,
        "xensemble-unigateway listening"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve gateway")?;

    Ok(())
}

fn config_path_from_env() -> PathBuf {
    std::env::var("UNIGATEWAY_CONFIG_PATH")
        .or_else(|_| std::env::var("UNIGATEWAY_CONFIG"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("unigateway.toml"))
}

fn bind_addr_from_env() -> SocketAddr {
    std::env::var("UNIGATEWAY_BIND_ADDR")
        .or_else(|_| std::env::var("BIND_ADDR"))
        .unwrap_or_else(|_| "127.0.0.1:8741".to_string())
        .parse()
        .expect("valid UNIGATEWAY_BIND_ADDR")
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("install CTRL+C handler");
    tracing::info!("shutdown signal received");
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "xensemble-unigateway" }))
}

fn extract_gateway_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(value) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(key) = value.strip_prefix("Bearer ") {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn require_admin(headers: &HeaderMap, expected: &Option<String>) -> Result<(), ApiError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let provided = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided == expected {
        Ok(())
    } else {
        Err(ApiError::unauthorized("invalid admin token"))
    }
}

async fn authorize_gateway(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<unigateway_config::GatewayApiKey, ApiError> {
    let raw_key = extract_gateway_key(headers).ok_or_else(|| {
        ApiError::unauthorized("missing gateway API key (Authorization: Bearer or x-api-key)")
    })?;

    let gateway_key = state
        .gateway
        .find_gateway_api_key(&raw_key)
        .await
        .ok_or_else(|| ApiError::unauthorized("invalid gateway API key"))?;

    if gateway_key.is_active == 0 {
        return Err(ApiError::unauthorized("gateway API key is inactive"));
    }

    if let Some(limit) = gateway_key.quota_limit
        && gateway_key.used_quota >= limit
    {
        return Err(ApiError::too_many_requests("gateway API key quota exceeded"));
    }

    state
        .gateway
        .acquire_runtime_limit(&gateway_key)
        .await
        .map_err(runtime_limit_error)?;

    Ok(gateway_key)
}

fn runtime_limit_error(error: RuntimeLimitError) -> ApiError {
    match error {
        RuntimeLimitError::QpsWaitTooLong
        | RuntimeLimitError::TooManyQpsSleepers
        | RuntimeLimitError::QueueDepthExceeded
        | RuntimeLimitError::QueueTimeout => ApiError::too_many_requests("rate limit exceeded"),
        RuntimeLimitError::StateLost => {
            ApiError::internal("gateway rate limiter state lost")
        }
    }
}

async fn dispatch_for_service(
    state: &AppState,
    service_id: &str,
    protocol: HostProtocol,
    hint: Option<&str>,
    request: HostRequest,
    endpoint: &str,
) -> Result<Response, ApiError> {
    let host = HostContext::from_parts(&state.engine, state.pool_host.as_ref());
    let target = HostDispatchTarget::Service(service_id);

    let started = std::time::Instant::now();
    let outcome = dispatch_request(&host, target, protocol, hint, request)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let latency_ms = started.elapsed().as_millis() as i64;
    match outcome {
        HostDispatchOutcome::Response(response) => {
            let (status, body) = response.into_parts();
            state
                .gateway
                .record_stat(endpoint, status.as_u16(), latency_ms)
                .await;
            Ok(match body {
                ProtocolResponseBody::Json(value) => (status, Json(value)).into_response(),
                ProtocolResponseBody::ServerSentEvents(stream) => (
                    status,
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(stream.map(|chunk| -> Result<_, std::io::Error> {
                        match chunk {
                            Ok(bytes) => Ok(bytes),
                            Err(error) => {
                                let error_json = json!({
                                    "error": {
                                        "message": error.to_string(),
                                        "type": "gateway_error",
                                    }
                                });
                                let sse_event = format!("data: {}\n\n", error_json);
                                Ok(sse_event.into_bytes().into())
                            }
                        }
                    })),
                )
                    .into_response(),
            })
        }
        other => {
            if matches!(other, HostDispatchOutcome::PoolNotFound) {
                state.gateway.record_stat(endpoint, 400, latency_ms).await;
                Err(ApiError::bad_request(format!(
                    "service '{service_id}' has no configured providers"
                )))
            } else {
                state.gateway.record_stat(endpoint, 500, latency_ms).await;
                Err(ApiError::internal("unsupported gateway dispatch outcome"))
            }
        }
    }
}

/// Flatten Anthropic `system` array (`[{"type":"text","text":"..."}]`) to a
/// string so the protocol crate's `as_str()`-only handling doesn't drop it.
fn normalize_anthropic_system(mut payload: Value) -> Value {
    if let Some(system) = payload.get("system") {
        if system.is_array() {
            let text: String = system
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|block| {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        block.get("text").and_then(|t| t.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                payload["system"] = Value::String(text);
            }
        }
    }
    payload
}

/// Split a routing target of the form `provider/model` into a provider hint and
/// the upstream model name. When no `/` is present the whole string is used both
/// as the routing hint and the model, keeping provider-name targets working.
fn split_provider_model(raw: &str) -> (String, String) {
    match raw.split_once('/') {
        Some((provider, model)) if !provider.is_empty() && !model.is_empty() => {
            (provider.to_string(), model.to_string())
        }
        _ => (raw.to_string(), raw.to_string()),
    }
}

/// Strip the `anthropic.` discovery prefix the control plane adds to
/// `/v1/models` ids for claude-code (which otherwise filters out non-Anthropic
/// shaped ids). After stripping, the target routes like any other bare or
/// `provider/model` id.
fn strip_model_discovery_prefix(raw: &str) -> &str {
    raw.strip_prefix("anthropic.").unwrap_or(raw)
}

/// Resolve the routing hint for a raw model string.
/// - `provider/model` → the explicit provider hint, but only when that provider
///   is currently bound to the service. A stale prefix from a long-lived agent
///   session (e.g. opencode /model still holding `volcengine-zxs2/...` after the
///   agent's binding switched back to tokenhub-zxs) must not force routing to a
///   provider the agent no longer uses; in that case fall back to the bound
///   provider whose alias matches the model part.
/// - a bare model alias (e.g. `deepseek-v4-flash`) → the bound provider whose
///   `model_mapping` / `default_model` matches the alias, so agents can send
///   plain model names without a provider prefix. Without this, the hint is fed
///   straight into targeting, which only matches endpoint/provider metadata and
///   fails with `no provider matches target '<model>'`.
async fn resolve_provider_hint(state: &AppState, service_id: &str, raw_model: &str) -> String {
    let trimmed = raw_model.trim();
    let models = state.gateway.list_service_models(service_id).await;
    if let Some((provider, model_part)) = trimmed.split_once('/') {
        let provider = provider.trim();
        let model_part = model_part.trim();
        if !provider.is_empty() {
            // Only honor the explicit prefix when that provider is bound.
            if models.iter().any(|m| m.owned_by.eq_ignore_ascii_case(provider)) {
                return provider.to_string();
            }
            // Stale/unbound prefix: fall back to the bound provider matching
            // the model part.
            if !model_part.is_empty() {
                for model in &models {
                    if model.alias == model_part {
                        return model.owned_by.clone();
                    }
                }
            }
        }
    }
    for model in models {
        if model.alias == trimmed {
            return model.owned_by;
        }
    }
    trimmed.to_string()
}

async fn openai_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, ApiError> {
    let gateway_key = authorize_gateway(&state, &headers).await?;
    let service_id = gateway_key.service_id.clone();

    let raw_model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("gpt-4o-mini");
    let (_, default_model) = split_provider_model(raw_model);
    let provider_hint = resolve_provider_hint(&state, &service_id, raw_model).await;

    tracing::info!(%service_id, %raw_model, %default_model, %provider_hint, "openai_chat dispatch");

    let mut request = openai_payload_to_chat_request(&payload, &default_model)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    request.model = default_model.to_string();

    let response = dispatch_for_service(
        &state,
        &service_id,
        HostProtocol::OpenAiChat,
        Some(&provider_hint),
        HostRequest::Chat(request),
        "/v1/chat/completions",
    )
    .await;

    if response.is_ok() {
        state
            .gateway
            .increment_used_quota(&gateway_key.key)
            .await;
        state
            .gateway
            .release_api_key_inflight(&gateway_key.key)
            .await;
    } else {
        state
            .gateway
            .release_api_key_inflight(&gateway_key.key)
            .await;
    }

    response
}

async fn anthropic_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, ApiError> {
    let gateway_key = authorize_gateway(&state, &headers).await?;
    let service_id = gateway_key.service_id.clone();

    let raw_model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("claude-sonnet-4-20250514");
    let raw_model = strip_model_discovery_prefix(raw_model);
    let (_, default_model) = split_provider_model(raw_model);
    let provider_hint = resolve_provider_hint(&state, &service_id, raw_model).await;

    tracing::info!(%service_id, %raw_model, %default_model, %provider_hint, "anthropic_messages dispatch");

    let payload = normalize_anthropic_system(payload);
    let mut request = anthropic_payload_to_chat_request(&payload, &default_model)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    request.model = default_model.to_string();

    let response = dispatch_for_service(
        &state,
        &service_id,
        HostProtocol::AnthropicMessages,
        Some(&provider_hint),
        HostRequest::Chat(request),
        "/v1/messages",
    )
    .await;

    if response.is_ok() {
        state
            .gateway
            .increment_used_quota(&gateway_key.key)
            .await;
    }
    state
        .gateway
        .release_api_key_inflight(&gateway_key.key)
        .await;
    response
}

async fn openai_embeddings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, ApiError> {
    let gateway_key = authorize_gateway(&state, &headers).await?;
    let service_id = gateway_key.service_id.clone();

    let raw_model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("text-embedding-3-small");
    let (_, default_model) = split_provider_model(raw_model);
    let provider_hint = resolve_provider_hint(&state, &service_id, raw_model).await;

    let mut request = openai_payload_to_embed_request(&payload, &default_model)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    request.model = default_model.to_string();

    let response = dispatch_for_service(
        &state,
        &service_id,
        HostProtocol::OpenAiEmbeddings,
        Some(&provider_hint),
        HostRequest::Embeddings(request),
        "/v1/embeddings",
    )
    .await;

    if response.is_ok() {
        state
            .gateway
            .increment_used_quota(&gateway_key.key)
            .await;
    }
    state
        .gateway
        .release_api_key_inflight(&gateway_key.key)
        .await;
    response
}

/// Validate the gateway API key without consuming quota or runtime limits.
/// Metadata endpoints such as `/v1/models` are reads and must not count
/// against per-key request quota or rate limits.
async fn authorize_gateway_readonly(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<unigateway_config::GatewayApiKey, ApiError> {
    let raw_key = extract_gateway_key(headers).ok_or_else(|| {
        ApiError::unauthorized("missing gateway API key (Authorization: Bearer or x-api-key)")
    })?;
    state
        .gateway
        .authorize_readonly(&raw_key)
        .await
        .map_err(|err| match err {
            AuthError::InvalidKey => ApiError::unauthorized("invalid gateway API key"),
            AuthError::InactiveKey => ApiError::unauthorized("gateway API key is inactive"),
        })
}

async fn openai_list_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let gateway_key = authorize_gateway_readonly(&state, &headers).await?;
    let data: Vec<Value> = state
        .gateway
        .list_service_model_ids(&gateway_key.service_id)
        .await
        .iter()
        .map(|(id, owned_by)| openai_model_object(id, owned_by))
        .collect();
    Ok(Json(json!({
        "object": "list",
        "data": data,
    })))
}

async fn openai_get_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(model_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let gateway_key = authorize_gateway_readonly(&state, &headers).await?;
    let entries = state
        .gateway
        .list_service_model_ids(&gateway_key.service_id)
        .await;
    match entries.iter().find(|(id, _)| id == &model_id) {
        Some((id, owned_by)) => Ok(Json(openai_model_object(id, owned_by))),
        None => Err(ApiError::not_found(format!("model '{model_id}' not found"))),
    }
}

async fn admin_modes(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<AdminModesQuery>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    let detailed = query.detailed.unwrap_or(false);
    let modes = state.gateway.list_mode_views().await;
    let data = if detailed {
        json!(modes)
    } else {
        json!(modes.iter().map(|mode| {
            json!({
                "id": mode.id,
                "name": mode.name,
                "routing_strategy": mode.routing_strategy,
                "is_default": mode.is_default,
                "provider_count": mode.providers.len(),
                "provider_names": mode.providers.iter().map(|p| &p.name).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>())
    };
    Ok(Json(AdminResponse::ok(data)))
}

#[derive(Debug, Deserialize)]
struct AdminModesQuery {
    detailed: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SetDefaultModeBody {
    mode_id: String,
}

async fn admin_set_default_mode(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SetDefaultModeBody>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    state
        .gateway
        .set_default_mode(&body.mode_id)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    state.gateway.persist_if_dirty().await.ok();
    Ok(Json(AdminResponse::ok(json!({ "mode_id": body.mode_id }))))
}

#[derive(Debug, Deserialize)]
struct RebindApiKeyBody {
    key: String,
    service_id: String,
}

#[derive(Debug, Deserialize)]
struct CreateApiKeyBody {
    key: String,
    service_id: String,
    quota_limit: Option<i64>,
    qps_limit: Option<f64>,
    concurrency_limit: Option<i64>,
}

async fn admin_create_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateApiKeyBody>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    let key = body.key.trim();
    let service_id = body.service_id.trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("key is required"));
    }
    if service_id.is_empty() {
        return Err(ApiError::bad_request("service_id is required"));
    }
    state
        .gateway
        .create_api_key(
            key,
            service_id,
            body.quota_limit,
            body.qps_limit,
            body.concurrency_limit,
        )
        .await;
    state.gateway.persist_if_dirty().await.ok();
    Ok(Json(AdminResponse::ok(json!({
        "key": key,
        "service_id": service_id,
    }))))
}

async fn admin_rebind_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RebindApiKeyBody>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    state
        .gateway
        .rebind_api_key_service(&body.key, &body.service_id)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    state.gateway.persist_if_dirty().await.ok();
    Ok(Json(AdminResponse::ok(json!({
        "key": body.key,
        "service_id": body.service_id,
    }))))
}

async fn admin_list_providers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    let providers = state.gateway.list_provider_views().await;
    Ok(Json(AdminResponse::ok(json!(providers))))
}

fn build_model_mapping(models: &[String]) -> String {
    let map: HashMap<String, String> = models
        .iter()
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .map(|m| (m.to_string(), m.to_string()))
        .collect();
    if map.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&map).unwrap_or_default()
    }
}

#[derive(Debug, Deserialize)]
struct CreateProviderBody {
    name: String,
    base_url: String,
    api_key: String,
    default_model: Option<String>,
    models: Option<Vec<String>>,
    service_id: Option<String>,
    endpoint_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateProviderBody {
    base_url: Option<String>,
    api_key: Option<String>,
    default_model: Option<String>,
    models: Option<Vec<String>>,
}

/// Auto-detect provider_type from base_url.
/// If the URL path contains "anthropic" or the domain is anthropic.com, use "anthropic".
/// Otherwise default to "openai".
fn detect_provider_type(base_url: &str) -> &'static str {
    let lower = base_url.to_lowercase();
    if lower.contains("/anthropic") || lower.contains("anthropic.com") {
        "anthropic"
    } else {
        "openai"
    }
}

/// Auto-detect endpoint_id from provider_type.
fn endpoint_id_for_type(provider_type: &str) -> &'static str {
    match provider_type {
        "anthropic" => "anthropic",
        _ => "openai",
    }
}

async fn admin_create_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateProviderBody>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;

    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is required"));
    }
    let base_url = body.base_url.trim();
    if base_url.is_empty() {
        return Err(ApiError::bad_request("base_url is required"));
    }
    if body.api_key.trim().is_empty() {
        return Err(ApiError::bad_request("api_key is required"));
    }

    let provider_type = detect_provider_type(base_url);
    let endpoint_id = body.endpoint_id.as_deref().unwrap_or_else(|| endpoint_id_for_type(provider_type));
    let model_mapping_str = body
        .models
        .as_ref()
        .map(|models| build_model_mapping(models.as_slice()));
    let default_model = body
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or_else(|| {
            body.models.as_ref().and_then(|models| {
                models
                    .iter()
                    .map(|m| m.trim())
                    .find(|m| !m.is_empty())
            })
        });
    let provider_id = state
        .gateway
        .create_provider_with_models(
            name,
            provider_type,
            endpoint_id,
            Some(base_url),
            body.api_key.trim(),
            ProviderModelOptions {
                default_model,
                model_mapping: model_mapping_str.as_deref(),
            },
        )
        .await;

    let service_id = body.service_id.as_deref().unwrap_or("default");
    state
        .gateway
        .bind_provider_to_service(service_id, provider_id)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    state.gateway.persist_if_dirty().await.ok();

    Ok(Json(AdminResponse::ok(json!({
        "id": provider_id,
        "name": name,
        "service_id": service_id,
    }))))
}

async fn admin_update_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<UpdateProviderBody>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;

    let model_mapping = body
        .models
        .as_ref()
        .map(|models| build_model_mapping(models.as_slice()));
    let default_model = body
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or_else(|| {
            body.models.as_ref().and_then(|models| {
                models
                    .iter()
                    .map(|m| m.trim())
                    .find(|m| !m.is_empty())
            })
        });

    let detected_type = body.base_url.as_deref().map(|s| detect_provider_type(s.trim()));

    state
        .gateway
        .update_provider_by_name(
            &name,
            body.base_url.as_deref().map(|s| s.trim()),
            body.api_key.as_deref(),
            default_model,
            model_mapping.as_deref(),
            detected_type,
        )
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    state.gateway.persist_if_dirty().await.ok();
    Ok(Json(AdminResponse::ok(json!({ "name": name }))))
}

async fn admin_delete_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    state
        .gateway
        .delete_provider_by_name(&name)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    state.gateway.persist_if_dirty().await.ok();
    Ok(Json(AdminResponse::ok(json!({ "name": name }))))
}

/// Reload the on-disk TOML (merging externally-added services/bindings into
/// memory) and rebuild core pools. This lets the Node control plane push new
/// service bindings without restarting the process, avoiding interruption of
/// in-flight LLM requests.
async fn admin_reload(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminResponse<Value>>, ApiError> {
    require_admin(&headers, &state.admin_token)?;
    state
        .gateway
        .reload_from_disk()
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    sync_core_pools(&state.gateway, state.engine.as_ref())
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(AdminResponse::ok(json!({ "reloaded": true }))))
}

#[derive(Debug, serde::Serialize)]
struct AdminResponse<T> {
    success: bool,
    data: Option<T>,
    error: Option<String>,
}

impl<T: serde::Serialize> AdminResponse<T> {
    fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({
            "error": {
                "message": self.message,
                "type": "gateway_error",
            }
        }));
        (self.status, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unigateway_config::core_sync::sync_core_pools;

    async fn write_provider_toml(path: &std::path::Path) {
        let toml = r#"
[preferences]
default_mode = "default"

[[services]]
id = "default"
name = "Default"
routing_strategy = "round_robin"

[[providers]]
name = "zxs_deepseek"
provider_type = "openai"
endpoint_id = "openai"
base_url = "https://api.deepseek.com/"
api_key = "sk-test"
default_model = "deepseek-v4-flash"
model_mapping = '{"deepseek-v4-flash":"deepseek-v4-flash"}'
is_enabled = true

[[bindings]]
service_id = "default"
provider_name = "zxs_deepseek"
priority = 0

[[api_keys]]
key = "test-key"
service_id = "default"
is_active = true
"#;
        std::fs::write(path, toml).expect("write toml");
    }

    #[tokio::test]
    async fn reload_merges_external_binding_and_rebuilds_pool() {
        let dir = std::env::temp_dir().join(format!("ugw-reload-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("config.toml");
        write_provider_toml(&path).await;

        let gateway = GatewayState::load(&path).await.expect("load");
        let engine = Arc::new(
            UniGatewayEngine::builder()
                .with_builtin_http_drivers()
                .build()
                .expect("engine"),
        );
        sync_core_pools(&gateway, engine.as_ref())
            .await
            .expect("initial sync");

        // External writer (Node control plane) appends a droid service+binding.
        let mut toml = std::fs::read_to_string(&path).expect("read");
        toml.push_str(
            "[[services]]\nid = \"droid\"\nname = \"droid\"\nrouting_strategy = \"round_robin\"\n",
        );
        toml.push_str(
            "[[bindings]]\nservice_id = \"droid\"\nprovider_name = \"zxs_deepseek\"\npriority = 0\n",
        );
        std::fs::write(&path, toml).expect("write external");

        // reload merges droid into memory; rebuild pools so it becomes routable.
        gateway.reload_from_disk().await.expect("reload");
        sync_core_pools(&gateway, engine.as_ref())
            .await
            .expect("re-sync");

        // If the droid binding was merged, sync_core_pools builds a droid pool.
        assert!(
            engine.get_pool("droid").await.is_some(),
            "droid pool built after reload"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_provider_hint_maps_model_alias_to_bound_provider() {
        let dir = std::env::temp_dir().join(format!("ugw-hint-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("config.toml");
        write_provider_toml(&path).await;

        let gateway = GatewayState::load(&path).await.expect("load");
        let engine = Arc::new(
            UniGatewayEngine::builder()
                .with_builtin_http_drivers()
                .build()
                .expect("engine"),
        );
        let pool_host = Arc::new(EnginePoolHost {
            engine: engine.clone(),
        });
        let state = AppState {
            gateway: gateway.clone(),
            engine,
            pool_host,
            admin_token: None,
        };
        // Bare model alias resolves to the bound provider (zxs_deepseek).
        let hint = resolve_provider_hint(&state, "default", "deepseek-v4-flash").await;
        assert_eq!(hint, "zxs_deepseek");

        // Explicit provider/model keeps the provider as the hint.
        let hint = resolve_provider_hint(&state, "default", "zxs_deepseek/deepseek-v4-flash").await;
        assert_eq!(hint, "zxs_deepseek");

        // Unknown model falls back to the raw string.
        let hint = resolve_provider_hint(&state, "default", "some-unknown-model").await;
        assert_eq!(hint, "some-unknown-model");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
