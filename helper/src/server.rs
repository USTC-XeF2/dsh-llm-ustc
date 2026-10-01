use crate::config::{StartupConfig, TARGET_HOST, TunnelConfig};
use crate::tunnel::{self, TunnelHandle};
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use serde_json::json;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

const SESSION_HEADER: &str = "x-dsh-ustc-session";
const DIRECT_TIMEOUT: Duration = Duration::from_secs(3);
const IWAN_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    tunnel_config: Option<TunnelConfig>,
    tunnel: Mutex<TunnelSlot>,
    recovery_seconds: u64,
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
        if let Some(tunnel) = &config.tunnel {
            tunnel.validate()?;
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
            tunnel_config: config.tunnel,
            tunnel: Mutex::new(TunnelSlot::default()),
            recovery_seconds: config.direct_recovery_seconds.max(30),
        }))
    }

    async fn set_mode(&self, next: RouteMode) {
        let changed = {
            let mut current = self.mode.write().await;
            if *current == next {
                false
            } else {
                *current = next;
                true
            }
        };
        if changed {
            println!(
                "{{\"event\":\"route\",\"iwan\":{}}}",
                next == RouteMode::Iwan
            );
            std::io::stdout().flush().ok();
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
        let config = self.tunnel_config.clone().ok_or_else(|| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "IWAN_LOGIN_REQUIRED",
            message:
                "select an iWAN line before the USTC API can be reached outside the campus network"
                    .into(),
        })?;
        let handle = match tokio::task::spawn_blocking(move || tunnel::start(&config))
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
    Duration::from_millis(rand::random_range(floor_ms..=ceiling_ms))
}

pub(crate) fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/_route", post(refresh_route))
        .fallback(proxy_request)
        .with_state(state)
}

pub(crate) fn start_direct_recovery(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let base = state.recovery_seconds.saturating_mul(1_000);
            let jitter = base / 10;
            let wait_ms =
                rand::random_range(base.saturating_sub(jitter)..=base.saturating_add(jitter));
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            if *state.mode.read().await != RouteMode::Iwan {
                continue;
            }
            if check_upstream(&state.direct).await.is_ok() {
                state.stop_tunnel().await;
                state.set_mode(RouteMode::Direct).await;
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

async fn refresh_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<bool>, ApiError> {
    authenticate(&state, &headers).await?;
    state.stop_tunnel().await;
    state.set_mode(RouteMode::Direct).await;
    match check_upstream(&state.direct).await {
        Ok(()) => Ok(Json(false)),
        Err(error) if fallback_before_request(&error) => {
            let client = state.ensure_tunnel().await?;
            check_upstream(&client).await.map_err(upstream_error)?;
            state.set_mode(RouteMode::Iwan).await;
            Ok(Json(true))
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
    let method = request.method().clone();
    if method == Method::CONNECT {
        return Err(ApiError {
            status: StatusCode::METHOD_NOT_ALLOWED,
            code: "CONNECT_REFUSED",
            message: "CONNECT requests are not accepted".into(),
        });
    }
    let path = upstream_path(request.uri())?;
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
            state.set_mode(RouteMode::Iwan).await;
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

async fn check_upstream(client: &Client) -> Result<(), reqwest::Error> {
    client
        .get("https://api.llm.ustc.edu.cn/v1/models")
        .header("accept", "application/json")
        .send()
        .await
        .map(|_| ())
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
                if state.tunnel_config.is_some() {
                    state.set_mode(RouteMode::Iwan).await;
                }
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

fn upstream_path(uri: &Uri) -> Result<String, ApiError> {
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "ABSOLUTE_URL_REFUSED",
            message: "absolute and authority-form request targets are not accepted".into(),
        });
    }
    Ok(uri
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| "/".into()))
}

fn upstream_error(error: reqwest::Error) -> ApiError {
    eprintln!("USTC upstream transport error: {error:#}");
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "UPSTREAM_TRANSPORT",
        message: if error.is_timeout() {
            "connection timed out".into()
        } else if error.is_connect() {
            "could not connect to api.llm.ustc.edu.cn".into()
        } else if error.is_body() {
            "upstream response stream failed".into()
        } else {
            "USTC API transport failed".into()
        },
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
            tunnel: None,
            direct_recovery_seconds: 300,
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
        for uri in ["/v1/models", "/not-a-proxy"] {
            let response = router(test_state())
                .oneshot(HttpRequest::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
        }
        let route_refresh = router(test_state())
            .oneshot(HttpRequest::post("/_route").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(route_refresh.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_connect_even_with_an_origin_form_target() {
        let response = router(test_state())
            .oneshot(
                HttpRequest::builder()
                    .method(Method::CONNECT)
                    .uri("/v1/models")
                    .header(SESSION_HEADER, "a".repeat(32))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn accepts_any_relative_upstream_path_and_query() {
        let uri: Uri = "/v1/embeddings?model=custom".parse().unwrap();
        assert_eq!(upstream_path(&uri).unwrap(), "/v1/embeddings?model=custom");

        let absolute: Uri = "https://example.com/v1/models".parse().unwrap();
        assert_eq!(
            upstream_path(&absolute).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );

        let authority: Uri = "api.llm.ustc.edu.cn:443".parse().unwrap();
        assert_eq!(
            upstream_path(&authority).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn rejects_non_loopback_local_hosts() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("example.com"));
        assert_eq!(
            validate_host(&headers).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }
}
