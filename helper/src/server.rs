use crate::config::{IwanConfig, PublicServer, StartupConfig, TARGET_HOST};
use crate::oidc::{OidcBegin, OidcTransactions};
use crate::tunnel::{self, TunnelHandle};
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

const SESSION_HEADER: &str = "x-dsh-ustc-session";
const DIRECT_TIMEOUT: Duration = Duration::from_secs(3);
const IWAN_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum RouteMode {
    Direct,
    Iwan,
}

struct TunnelState {
    handle: TunnelHandle,
    client: Client,
    started_at: Instant,
}

#[derive(Default)]
struct TunnelSlot {
    current: Option<TunnelState>,
    consecutive_failures: u32,
}

pub(crate) struct AppState {
    session_token: String,
    direct: Client,
    mode: RwLock<RouteMode>,
    iwan_config: RwLock<Option<IwanConfig>>,
    selected_server_id: RwLock<Option<String>>,
    tunnel: Mutex<TunnelSlot>,
    oidc: OidcTransactions,
    reprobe_seconds: u64,
    last_authorization: RwLock<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusSnapshot {
    protocol: &'static str,
    target: &'static str,
    route: RouteMode,
    iwan_configured: bool,
    selected_server_id: Option<String>,
    tunnel_running: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcCompleteRequest {
    callback_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OidcCompleteResponse {
    servers: Vec<PublicServer>,
    iwan_config: IwanConfig,
}

#[derive(Clone, Debug, Serialize)]
struct ModelEntry {
    id: String,
    name: String,
}

struct ProbeHttp {
    status: StatusCode,
    models: Option<Vec<ModelEntry>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectRequest {
    server_id: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

impl ApiError {
    fn internal(code: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code,
            message: error.to_string(),
        }
    }
}

impl AppState {
    pub(crate) fn new(config: StartupConfig) -> anyhow::Result<Arc<Self>> {
        if config.session_token.len() < 32 {
            anyhow::bail!("session token must contain at least 32 characters");
        }
        if let Some(iwan) = &config.iwan_config {
            iwan.validate()?;
        }
        let direct = Client::builder()
            .no_proxy()
            .https_only(true)
            .connect_timeout(DIRECT_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(30))
            .build()?;
        Ok(Arc::new(Self {
            session_token: config.session_token,
            direct,
            mode: RwLock::new(RouteMode::Direct),
            iwan_config: RwLock::new(config.iwan_config),
            selected_server_id: RwLock::new(config.selected_server_id),
            tunnel: Mutex::new(TunnelSlot::default()),
            oidc: OidcTransactions::default(),
            reprobe_seconds: config.direct_reprobe_seconds.max(30),
            last_authorization: RwLock::new(None),
        }))
    }

    async fn snapshot(&self) -> StatusSnapshot {
        let tunnel_running = self
            .tunnel
            .lock()
            .await
            .current
            .as_ref()
            .is_some_and(|state| !state.handle.is_finished());
        StatusSnapshot {
            protocol: "v1",
            target: "api.llm.ustc.edu.cn:443",
            route: *self.mode.read().await,
            iwan_configured: self.iwan_config.read().await.is_some(),
            selected_server_id: self.selected_server_id.read().await.clone(),
            tunnel_running,
        }
    }

    async fn ensure_tunnel(&self) -> Result<Client, ApiError> {
        let mut slot = self.tunnel.lock().await;
        if slot
            .current
            .as_ref()
            .is_some_and(|state| !state.handle.is_finished())
        {
            return Ok(slot
                .current
                .as_ref()
                .expect("checked tunnel state")
                .client
                .clone());
        }
        if let Some(failed) = slot.current.take() {
            if failed.started_at.elapsed() >= Duration::from_secs(60) {
                slot.consecutive_failures = 0;
            }
            slot.consecutive_failures = slot.consecutive_failures.saturating_add(1);
        }
        if slot.consecutive_failures > 0 {
            tokio::time::sleep(reconnect_delay(slot.consecutive_failures)).await;
        }
        let config = self.iwan_config.read().await.clone().ok_or_else(|| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "IWAN_LOGIN_REQUIRED",
            message: "iWAN login is required before the USTC API can be reached outside the campus network".into(),
        })?;
        let selected = self
            .selected_server_id
            .read()
            .await
            .clone()
            .ok_or_else(|| ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "IWAN_LINE_REQUIRED",
                message: "select an iWAN line in the USTC provider settings".into(),
            })?;
        let handle = match tokio::task::spawn_blocking(move || tunnel::start(&config, &selected))
            .await
            .map_err(|error| ApiError::internal("IWAN_START_FAILED", error))?
        {
            Ok(handle) => handle,
            Err(error) => {
                slot.consecutive_failures = slot.consecutive_failures.saturating_add(1);
                return Err(ApiError::internal("IWAN_START_FAILED", error));
            }
        };
        let proxy = Proxy::all(format!("socks5h://{}", handle.address))
            .map_err(|error| ApiError::internal("IWAN_START_FAILED", error))?;
        let client = Client::builder()
            .no_proxy()
            .https_only(true)
            .proxy(proxy)
            .connect_timeout(IWAN_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| ApiError::internal("IWAN_START_FAILED", error))?;
        slot.current = Some(TunnelState {
            handle,
            client: client.clone(),
            started_at: Instant::now(),
        });
        Ok(client)
    }

    async fn stop_tunnel(&self) {
        let mut slot = self.tunnel.lock().await;
        slot.current.take();
        slot.consecutive_failures = 0;
    }

    async fn invalidate_tunnel(&self) {
        let mut slot = self.tunnel.lock().await;
        slot.current.take();
        slot.consecutive_failures = slot.consecutive_failures.saturating_add(1);
    }
}

fn reconnect_delay(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(5);
    let ceiling_ms = (1_000u64 << exponent).min(30_000);
    let floor_ms = ceiling_ms.saturating_mul(3) / 4;
    Duration::from_millis(rand::Rng::gen_range(
        &mut rand::thread_rng(),
        floor_ms..=ceiling_ms,
    ))
}

pub(crate) fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/models", any(proxy_request))
        .route("/v1/chat/completions", any(proxy_request))
        .route("/_control/status", get(status))
        .route("/_control/servers", get(servers))
        .route("/_control/oidc/begin", post(oidc_begin))
        .route("/_control/oidc/complete", post(oidc_complete))
        .route("/_control/select", post(select_server))
        .fallback(reject)
        .with_state(state)
}

pub(crate) fn start_reprobe(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let base = state.reprobe_seconds.saturating_mul(1_000);
            let jitter = base / 10;
            let wait_ms = rand::Rng::gen_range(
                &mut rand::thread_rng(),
                base.saturating_sub(jitter)..=base.saturating_add(jitter),
            );
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            if *state.mode.read().await != RouteMode::Iwan {
                continue;
            }
            let authorization = state.last_authorization.read().await.clone();
            let probe = probe_models(&state.direct, authorization.as_deref()).await;
            if let Ok(probe) = probe {
                *state.mode.write().await = RouteMode::Direct;
                state.stop_tunnel().await;
                if probe.status == StatusCode::OK
                    && let Some(models) = probe.models
                {
                    emit_models(&models);
                }
            }
        }
    });
}

async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let supplied = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok());
    if supplied != Some(state.session_token.as_str()) {
        return Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            code: "INVALID_SESSION",
            message: "invalid helper session".into(),
        });
    }
    Ok(())
}

async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<StatusSnapshot>, ApiError> {
    authenticate(&state, &headers).await?;
    Ok(Json(state.snapshot().await))
}

async fn servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<PublicServer>>, ApiError> {
    authenticate(&state, &headers).await?;
    Ok(Json(
        state
            .iwan_config
            .read()
            .await
            .as_ref()
            .map(IwanConfig::public_servers)
            .unwrap_or_default(),
    ))
}

async fn oidc_begin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<OidcBegin>, ApiError> {
    authenticate(&state, &headers).await?;
    Ok(Json(state.oidc.begin().await))
}

async fn oidc_complete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<OidcCompleteRequest>,
) -> Result<Json<OidcCompleteResponse>, ApiError> {
    authenticate(&state, &headers).await?;
    let config = state
        .oidc
        .complete(&state.direct, &request.callback_url)
        .await
        .map_err(|error| ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "OIDC_FAILED",
            message: error.to_string(),
        })?;
    let response = OidcCompleteResponse {
        servers: config.public_servers(),
        iwan_config: config.clone(),
    };
    *state.iwan_config.write().await = Some(config);
    Ok(Json(response))
}

async fn select_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SelectRequest>,
) -> Result<Json<Value>, ApiError> {
    authenticate(&state, &headers).await?;
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if authorization.is_some() {
        *state.last_authorization.write().await = authorization.clone();
    }
    let exists = state
        .iwan_config
        .read()
        .await
        .as_ref()
        .is_some_and(|config| {
            config
                .servers
                .iter()
                .any(|server| server.id == request.server_id)
        });
    if !exists {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "UNKNOWN_LINE",
            message: "selected iWAN line is unavailable".into(),
        });
    }
    *state.selected_server_id.write().await = Some(request.server_id);
    state.stop_tunnel().await;
    *state.mode.write().await = RouteMode::Direct;
    let direct = probe_models(&state.direct, authorization.as_deref()).await;
    match direct {
        Ok(response) => {
            if let Some(models) = response.models {
                emit_models(&models);
            }
            Ok(Json(json!({ "selected": true, "route": "direct" })))
        }
        Err(error) if fallback_before_request(&error) => {
            let client = state.ensure_tunnel().await?;
            let response = probe_models(&client, authorization.as_deref())
                .await
                .map_err(upstream_error)?;
            *state.mode.write().await = RouteMode::Iwan;
            if let Some(models) = response.models {
                emit_models(&models);
            }
            Ok(Json(json!({ "selected": true, "route": "iwan" })))
        }
        Err(error) => Err(upstream_error(error)),
    }
}

async fn proxy_request(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Result<Response, ApiError> {
    authenticate(&state, request.headers()).await?;
    validate_host(request.headers())?;
    if let Some(value) = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
    {
        *state.last_authorization.write().await = Some(value.to_owned());
    }
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if request.uri().scheme().is_some() || request.uri().authority().is_some() {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "ABSOLUTE_URL_REFUSED",
            message: "absolute request targets are not accepted".into(),
        });
    }
    if !matches!(
        (method.clone(), path.as_str()),
        (Method::GET, "/v1/models") | (Method::POST, "/v1/chat/completions")
    ) {
        return Err(ApiError {
            status: StatusCode::METHOD_NOT_ALLOWED,
            code: "METHOD_NOT_ALLOWED",
            message: "method is not allowed".into(),
        });
    }
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 32 * 1024 * 1024)
        .await
        .map_err(|error| ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "INVALID_BODY",
            message: error.to_string(),
        })?;
    let upstream_headers = upstream_headers(&parts.headers)?;
    let mode = *state.mode.read().await;
    if mode == RouteMode::Iwan {
        let client = state.ensure_tunnel().await?;
        match send(
            &state,
            &client,
            RouteMode::Iwan,
            method.clone(),
            &path,
            upstream_headers.clone(),
            bytes.clone(),
        )
        .await
        {
            Ok(response) => return Ok(response),
            Err(error) if fallback_before_request(&error) => {
                state.invalidate_tunnel().await;
                let client = state.ensure_tunnel().await?;
                return send(
                    &state,
                    &client,
                    RouteMode::Iwan,
                    method,
                    &path,
                    upstream_headers,
                    bytes,
                )
                .await
                .map_err(upstream_error);
            }
            Err(error) => return Err(upstream_error(error)),
        }
    }
    match send(
        &state,
        &state.direct,
        RouteMode::Direct,
        method.clone(),
        &path,
        upstream_headers.clone(),
        bytes.clone(),
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(error) if fallback_before_request(&error) => {
            let client = state.ensure_tunnel().await?;
            *state.mode.write().await = RouteMode::Iwan;
            send(
                &state,
                &client,
                RouteMode::Iwan,
                method,
                &path,
                upstream_headers,
                bytes,
            )
            .await
            .map_err(upstream_error)
        }
        Err(error) => Err(upstream_error(error)),
    }
}

fn fallback_before_request(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout()
}

async fn probe_models(
    client: &Client,
    authorization: Option<&str>,
) -> Result<ProbeHttp, reqwest::Error> {
    let mut request = client
        .get("https://api.llm.ustc.edu.cn/v1/models")
        .header("accept", "application/json");
    if let Some(value) = authorization {
        request = request.header("authorization", value);
    }
    let response = request.send().await?;
    let status = response.status();
    let models = if status == StatusCode::OK {
        response
            .bytes()
            .await
            .ok()
            .and_then(|bytes| parse_models(&bytes))
    } else {
        None
    };
    Ok(ProbeHttp { status, models })
}

fn parse_models(bytes: &[u8]) -> Option<Vec<ModelEntry>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let data = value.get("data")?.as_array()?;
    let mut seen = HashSet::new();
    let models = data
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim();
            if id.is_empty() || id.len() > 256 || !seen.insert(id.to_owned()) {
                return None;
            }
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            Some(ModelEntry {
                id: id.to_owned(),
                name: name.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    (!models.is_empty()).then_some(models)
}

fn emit_models(models: &[ModelEntry]) {
    if let Ok(line) = serde_json::to_string(&json!({ "event": "models", "models": models })) {
        println!("{line}");
        std::io::stdout().flush().ok();
    }
}

async fn send(
    state: &Arc<AppState>,
    client: &Client,
    route: RouteMode,
    method: Method,
    path: &str,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, reqwest::Error> {
    let response = client
        .request(method, format!("https://{TARGET_HOST}{path}"))
        .headers(headers)
        .body(body)
        .send()
        .await?;
    let status = response.status();
    let headers = response_headers(response.headers());
    let route_state = state.clone();
    let stream = response.bytes_stream().map(move |item| {
        if item.is_err() && route == RouteMode::Direct {
            let state = route_state.clone();
            tokio::spawn(async move {
                *state.mode.write().await = RouteMode::Iwan;
            });
        }
        item
    });
    let mut outgoing = Response::new(Body::from_stream(stream));
    *outgoing.status_mut() = status;
    *outgoing.headers_mut() = headers;
    outgoing.headers_mut().insert(
        "x-dsh-ustc-route",
        HeaderValue::from_static(match route {
            RouteMode::Direct => "direct",
            RouteMode::Iwan => "iwan",
        }),
    );
    Ok(outgoing)
}

fn upstream_headers(headers: &HeaderMap) -> Result<HeaderMap, ApiError> {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        if name == SESSION_HEADER
            || matches!(
                name.as_str(),
                "host" | "connection" | "proxy-connection" | "content-length" | "transfer-encoding"
            )
        {
            continue;
        }
        result.append(name.clone(), value.clone());
    }
    result.insert(
        HeaderName::from_static("host"),
        HeaderValue::from_static(TARGET_HOST),
    );
    Ok(result)
}

fn response_headers(headers: &HeaderMap) -> HeaderMap {
    let mut blocked = vec![
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
    ];
    for value in headers.get_all("connection") {
        if let Ok(value) = value.to_str() {
            blocked.extend(
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty()),
            );
        }
    }
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        if !blocked
            .iter()
            .any(|blocked| name.as_str().eq_ignore_ascii_case(blocked))
        {
            result.append(name.clone(), value.clone());
        }
    }
    result
}

fn validate_host(headers: &HeaderMap) -> Result<(), ApiError> {
    if let Some(host) = headers.get("host").and_then(|value| value.to_str().ok()) {
        let lower = host.to_ascii_lowercase();
        if !(lower.starts_with("127.0.0.1:") || lower.starts_with("[::1]:") || lower == "localhost")
        {
            return Err(ApiError {
                status: StatusCode::BAD_REQUEST,
                code: "INVALID_HOST",
                message: "helper accepts loopback Host headers only".into(),
            });
        }
    }
    Ok(())
}

async fn reject(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authenticate(&state, &headers).await?;
    Err(ApiError {
        status: StatusCode::NOT_FOUND,
        code: "FIXED_TARGET_ONLY",
        message: "this helper only serves the USTC LLM API and its private control protocol".into(),
    })
}

fn upstream_error(error: reqwest::Error) -> ApiError {
    eprintln!("USTC upstream transport error: {error:#}");
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "UPSTREAM_TRANSPORT",
        message: public_transport_error(&error),
    }
}

fn public_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "connection timed out".into()
    } else if error.is_connect() {
        "could not connect to api.llm.ustc.edu.cn".into()
    } else if error.is_body() {
        "upstream response stream failed".into()
    } else {
        "USTC API transport failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn test_state() -> Arc<AppState> {
        AppState::new(StartupConfig {
            session_token: "a".repeat(32),
            iwan_config: None,
            selected_server_id: None,
            direct_reprobe_seconds: 300,
        })
        .unwrap()
    }

    #[test]
    fn strips_session_and_hop_headers() {
        let mut input = HeaderMap::new();
        input.insert(SESSION_HEADER, HeaderValue::from_static("secret"));
        input.insert("connection", HeaderValue::from_static("close"));
        input.insert("authorization", HeaderValue::from_static("Bearer key"));
        let output = upstream_headers(&input).unwrap();
        assert!(output.get(SESSION_HEADER).is_none());
        assert!(output.get("connection").is_none());
        assert_eq!(output.get("authorization").unwrap(), "Bearer key");
        assert_eq!(output.get("host").unwrap(), TARGET_HOST);
    }

    #[test]
    fn strips_response_hop_headers_and_connection_extensions() {
        let mut input = HeaderMap::new();
        input.insert(
            "connection",
            HeaderValue::from_static("x-private, keep-alive"),
        );
        input.insert("x-private", HeaderValue::from_static("secret"));
        input.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        input.insert(
            "content-type",
            HeaderValue::from_static("text/event-stream"),
        );
        let output = response_headers(&input);
        assert!(output.get("connection").is_none());
        assert!(output.get("x-private").is_none());
        assert!(output.get("transfer-encoding").is_none());
        assert_eq!(output.get("content-type").unwrap(), "text/event-stream");
    }

    #[tokio::test]
    async fn every_local_route_requires_the_session_token() {
        for uri in [
            "/_control/status",
            "/_control/diagnose",
            "/v1/models",
            "/not-a-proxy",
        ] {
            let response = router(test_state())
                .oneshot(HttpRequest::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
        }
    }

    #[tokio::test]
    async fn rejects_unknown_paths_and_wrong_data_plane_methods() {
        let unknown = router(test_state())
            .oneshot(
                HttpRequest::get("/https://example.com/")
                    .header(SESSION_HEADER, "a".repeat(32))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        let removed_diagnostics = router(test_state())
            .oneshot(
                HttpRequest::post("/_control/diagnose")
                    .header(SESSION_HEADER, "a".repeat(32))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(removed_diagnostics.status(), StatusCode::NOT_FOUND);

        let wrong_method = router(test_state())
            .oneshot(
                HttpRequest::put("/v1/models")
                    .header(SESSION_HEADER, "a".repeat(32))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
