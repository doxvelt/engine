mod cli_host;
mod episode_api;
mod generation;
mod historical;
mod native;
mod reverie;
mod routes;
mod stage;
mod workspace;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
    sync::{oneshot, watch},
};

const BODY_LIMIT: usize = 1_000_000;
const PROTOCOL: u32 = 1;

fn publish(message: Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &message)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

#[derive(Clone)]
struct Bridge {
    sequence: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    database: Arc<Mutex<String>>,
}
impl Default for Bridge {
    fn default() -> Self {
        Self {
            sequence: Arc::new(AtomicU64::new(0)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            database: Arc::new(Mutex::new(".doxvelt/runtime.sqlite".into())),
        }
    }
}
struct PendingCall {
    id: String,
    bridge: Bridge,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        if self
            .bridge
            .pending
            .lock()
            .unwrap()
            .remove(&self.id)
            .is_some()
        {
            let _ = publish(json!({"cancelCall": self.id}));
        }
    }
}
impl Bridge {
    async fn execute(&self, operation: routes::Operation) -> Reply {
        if episode_api::handles(&operation.operation) {
            let database = self.database.lock().unwrap().clone();
            return episode_api::execute(self, operation, &database).await;
        }
        if stage::handles(&operation.operation) {
            let database = self.database.lock().unwrap().clone();
            return stage::execute(self, operation, &database).await;
        }
        if generation::handles(&operation.operation) {
            let database = self.database.lock().unwrap().clone();
            return generation::execute(self, operation, database).await;
        }
        if native::handles(&operation.operation) {
            let database = self.database.lock().unwrap().clone();
            return match tokio::task::spawn_blocking(move || {
                native::execute(operation, std::path::Path::new(&database))
            })
            .await
            {
                Ok(Ok(result)) => Reply::ok(result),
                Ok(Err(error)) => Reply::error(
                    match error.code {
                        doxvelt_engine::error::ErrorCode::Invalid => 400,
                        doxvelt_engine::error::ErrorCode::NotFound => 404,
                        doxvelt_engine::error::ErrorCode::Conflict
                        | doxvelt_engine::error::ErrorCode::CommandConflict
                        | doxvelt_engine::error::ErrorCode::MemoryJobConflict => 409,
                        doxvelt_engine::error::ErrorCode::Internal => 500,
                    },
                    &error.message,
                ),
                Err(_) => Reply::error(500, "Native application operation failed."),
            };
        }
        Reply::error(
            404,
            &format!(
                "Unsupported application operation: {}.",
                operation.operation
            ),
        )
    }
    async fn call(&self, method: &str, params: Value) -> Result<Value, HostError> {
        let id = format!(
            "host-call-{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), send);
        let _pending = PendingCall {
            id: id.clone(),
            bridge: self.clone(),
        };
        if publish(json!({"callId": id, "method": method, "params": params})).is_err() {
            return Err(HostError {
                status: 503,
                message: "Application host is unavailable.".into(),
            });
        }
        match receive.await {
            Ok(value) if value.get("error").is_none() => Ok(value["result"].clone()),
            Ok(value) => Err(HostError {
                status: value["error"]["status"]
                    .as_u64()
                    .filter(|s| [400, 404, 409, 503].contains(s))
                    .unwrap_or(503) as u16,
                message: value["error"]["message"]
                    .as_str()
                    .unwrap_or("Application host could not complete the operation.")
                    .into(),
            }),
            _ => Err(HostError {
                status: 503,
                message: "Application host could not complete the operation.".into(),
            }),
        }
    }
}
struct HostError {
    status: u16,
    message: String,
}
impl From<doxvelt_engine::error::EngineError> for HostError {
    fn from(error: doxvelt_engine::error::EngineError) -> Self {
        use doxvelt_engine::error::ErrorCode;
        Self {
            status: match error.code {
                ErrorCode::Invalid => 400,
                ErrorCode::NotFound => 404,
                ErrorCode::Conflict | ErrorCode::CommandConflict | ErrorCode::MemoryJobConflict => {
                    409
                }
                ErrorCode::Internal => 500,
            },
            message: error.message,
        }
    }
}

#[derive(Clone)]
struct App {
    bridge: Bridge,
    origins: Arc<Vec<String>>,
    connections: watch::Sender<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Reply {
    status: u16,
    body: Value,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}
impl Reply {
    fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            body: json!({"error": message}),
            headers: BTreeMap::new(),
        }
    }
    fn ok(body: Value) -> Self {
        Self {
            status: 200,
            body,
            headers: BTreeMap::new(),
        }
    }
    fn response(self) -> Response {
        let mut response = (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::BAD_GATEWAY),
            axum::Json(self.body),
        )
            .into_response();
        if self.status == 204 {
            *response.body_mut() = Body::empty();
        }
        for (key, value) in self.headers {
            if let (Ok(key), Ok(value)) = (key.parse::<axum::http::HeaderName>(), value.parse()) {
                response.headers_mut().insert(key, value);
            }
        }
        response
    }
}

fn boundary(
    method: &str,
    headers: &BTreeMap<String, String>,
    origins: &[String],
) -> Result<BTreeMap<String, String>, Reply> {
    let mut result = BTreeMap::from([
        ("vary".into(), "Origin".into()),
        (
            "access-control-allow-methods".into(),
            "GET,POST,OPTIONS".into(),
        ),
        ("access-control-allow-headers".into(), "content-type".into()),
    ]);
    if let Some(origin) = headers.get("origin") {
        if !origins.contains(origin) {
            return Err(Reply::error(
                403,
                &format!("Origin is not allowed: {origin}"),
            ));
        }
        result.insert("access-control-allow-origin".into(), origin.clone());
    }
    if ["POST", "PUT", "PATCH", "DELETE"].contains(&method)
        && !headers.get("content-type").is_some_and(|t| {
            t.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
    {
        return Err(Reply::error(
            415,
            "State-changing requests require Content-Type: application/json.",
        ));
    }
    Ok(result)
}

async fn dispatch(
    app: &App,
    method: &str,
    target: &str,
    headers: BTreeMap<String, String>,
    bytes: &[u8],
) -> Reply {
    let cors = match boundary(method, &headers, &app.origins) {
        Ok(cors) => cors,
        Err(mut reply) => {
            reply.headers.insert("vary".into(), "Origin".into());
            return reply;
        }
    };
    let mut reply = if method == "OPTIONS" {
        Reply {
            status: 204,
            body: Value::Null,
            headers: BTreeMap::new(),
        }
    } else if bytes.len() > BODY_LIMIT {
        Reply::error(413, "Body too large.")
    } else {
        let body = if bytes.is_empty() {
            Ok(serde_json::Map::new())
        } else {
            serde_json::from_slice::<serde_json::Map<String, Value>>(bytes)
        };
        match body {
            Err(_) => Reply::error(400, "Invalid JSON: body must be an object."),
            Ok(body) => match routes::resolve(method, target, body) {
                Err((status, message)) => Reply::error(status, &message),
                Ok(op) if op.operation == "health" => Reply::ok(json!({"ok": true})),
                Ok(op) => {
                    let mut disconnected = app.connections.subscribe();
                    tokio::select! {
                        reply = app.bridge.execute(op) => reply,
                        _ = disconnected.changed() => Reply::error(503, "API connection closed."),
                    }
                }
            },
        }
    };
    reply.headers.extend(cors);
    reply
}

fn header_values(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(key, value)| {
            (
                key.as_str().to_owned(),
                value.to_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}
async fn http_request(State(app): State<App>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let method = parts.method.as_str();
    let headers = header_values(&parts.headers);
    // Reject the boundary before buffering an untrusted body.
    if let Err(reply) = boundary(method, &headers, &app.origins) {
        return reply.response();
    }
    match to_bytes(body, BODY_LIMIT).await {
        Ok(bytes) => dispatch(&app, method, &parts.uri.to_string(), headers, &bytes)
            .await
            .response(),
        Err(_) => {
            let mut reply = Reply::error(413, "Body too large.");
            if let Ok(cors) = boundary(method, &headers, &app.origins) {
                reply.headers = cors;
            }
            reply.response()
        }
    }
}

#[tokio::main(worker_threads = 2)]
async fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("doxvelt-api {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if !std::env::args().any(|arg| arg == "--stdio") {
        eprintln!("Run through the Doxvelt host, or use --stdio (native host protocol 1).");
        std::process::exit(2);
    }
    if let Err(error) = run().await {
        eprintln!("Doxvelt API stopped: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let bridge = Bridge::default();
    let (stopping, _) = watch::channel(false);
    let (connections, _) = watch::channel(0_u64);
    let listener = Arc::new(tokio::sync::Mutex::new(None::<tokio::task::JoinHandle<()>>));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => {
                publish(
                    json!({"error": {"code": "INVALID_JSON", "message": "Expected a protocol envelope."}}),
                )?;
                continue;
            }
        };
        if let Some(id) = message["callId"].as_str() {
            if let Some(send) = bridge.pending.lock().unwrap().remove(id) {
                let _ = send.send(message);
            }
            continue;
        }
        let id = message["id"].clone();
        if !id.is_u64() {
            publish(
                json!({"id": id, "error": {"code": "INVALID_REQUEST", "message": "A numeric request id is required."}}),
            )?;
            continue;
        }
        let app_bridge = bridge.clone();
        let listener = listener.clone();
        let stopping = stopping.clone();
        let connections = connections.clone();
        tokio::spawn(async move {
            let params = &message["params"];
            if let Some(database) = params
                .get("database")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                *app_bridge.database.lock().unwrap() = database.to_owned();
            }
            let origins: Vec<String> = params
                .get("allowedOrigins")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_else(|| {
                    vec![
                        "http://localhost:3000".into(),
                        "http://127.0.0.1:3000".into(),
                    ]
                });
            let app = App {
                bridge: app_bridge,
                origins: Arc::new(origins),
                connections: connections.clone(),
            };
            let result = match message["method"].as_str().unwrap_or("") {
                "ping" => Ok(json!({"protocol": PROTOCOL, "version": env!("CARGO_PKG_VERSION")})),
                "workspace" => Ok(serde_json::to_value(
                    workspace::execute(params.clone(), connections.subscribe()).await,
                )
                .unwrap()),
                "cli" => Ok(serde_json::to_value(
                    cli_host::execute(&app.bridge, params.clone(), connections.subscribe()).await,
                )
                .unwrap()),
                "episode" => {
                    let database = app.bridge.database.lock().unwrap().clone();
                    let mut abort = connections.subscribe();
                    let reply = tokio::select! {reply=episode_api::execute_private(&app.bridge,&database,params.clone())=>reply,_=abort.changed()=>Reply::error(503,"Episode operation was cancelled.")};
                    Ok(serde_json::to_value(reply).unwrap())
                }
                "request" => {
                    let method = params["method"].as_str().unwrap_or("GET");
                    let target = params["target"].as_str().unwrap_or("/");
                    let headers =
                        serde_json::from_value(params["headers"].clone()).unwrap_or_default();
                    let body = params["body"].as_str().unwrap_or("");
                    Ok(serde_json::to_value(
                        dispatch(&app, method, target, headers, body.as_bytes()).await,
                    )
                    .unwrap())
                }
                "listen" => {
                    let mut task = listener.lock().await;
                    if task.is_some() {
                        Err("API is already listening.".to_owned())
                    } else {
                        let host = params["host"].as_str().unwrap_or("127.0.0.1");
                        let port = params["port"].as_u64().unwrap_or(0);
                        if port > 65535 {
                            Err("Invalid API port.".to_owned())
                        } else {
                            match TcpListener::bind((host, port as u16)).await {
                                Err(error) => Err(format!("API could not listen: {error}")),
                                Ok(socket) => {
                                    let address = socket.local_addr().unwrap();
                                    let mut stop = stopping.subscribe();
                                    *task = Some(tokio::spawn(async move {
                                        let shutdown = async move {
                                            while !*stop.borrow() {
                                                if stop.changed().await.is_err() {
                                                    break;
                                                }
                                            }
                                        };
                                        if let Err(error) = axum::serve(
                                            socket,
                                            Router::new()
                                                .fallback(any(http_request))
                                                .with_state(app),
                                        )
                                        .with_graceful_shutdown(shutdown)
                                        .await
                                        {
                                            eprintln!("API listener failed: {error}");
                                        }
                                    }));
                                    Ok(
                                        json!({"address": address.ip().to_string(), "port": address.port(), "family": if address.is_ipv4() {"IPv4"} else {"IPv6"}}),
                                    )
                                }
                            }
                        }
                    }
                }
                "abort" => {
                    connections.send_modify(|generation| *generation += 1);
                    Ok(Value::Null)
                }
                "close" => {
                    let _ = stopping.send(true);
                    if let Some(task) = listener.lock().await.take() {
                        let _ = task.await;
                    }
                    Ok(Value::Null)
                }
                _ => Err("Unknown native host method.".to_owned()),
            };
            let reply = match result {
                Ok(value) => json!({"id": id, "result": value}),
                Err(message) => {
                    json!({"id": id, "error": {"code": "HOST_ERROR", "message": message}})
                }
            };
            let _ = publish(reply);
        });
    }
    let _ = stopping.send(true);
    // EOF means the application host is gone. No operation may wait for callbacks.
    bridge.pending.lock().unwrap().clear();
    if let Some(task) = listener.lock().await.take() {
        let _ = task.await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> App {
        App {
            bridge: Bridge::default(),
            origins: Arc::new(vec!["http://localhost:3000".into()]),
            connections: watch::channel(0).0,
        }
    }

    #[tokio::test]
    async fn health_and_preflight_need_no_application_callback() {
        let app = app();
        let health = dispatch(&app, "GET", "/health", BTreeMap::new(), b"").await;
        assert_eq!(health.status, 200);
        assert_eq!(health.body, json!({"ok": true}));
        let preflight = dispatch(
            &app,
            "OPTIONS",
            "/simulations",
            BTreeMap::from([("origin".into(), "http://localhost:3000".into())]),
            b"",
        )
        .await;
        assert_eq!(preflight.status, 204);
        assert_eq!(
            preflight
                .headers
                .get("access-control-allow-origin")
                .unwrap(),
            "http://localhost:3000"
        );
        assert!(app.bridge.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_requests_never_dispatch_application_operations() {
        let app = app();
        let json_headers = BTreeMap::from([("content-type".into(), "application/json".into())]);
        assert_eq!(
            dispatch(&app, "POST", "/simulations/start", BTreeMap::new(), b"{}")
                .await
                .status,
            415
        );
        for body in [
            b"[]".as_slice(),
            b"null",
            b"{bad",
            b"{\"ownerScope\":\"other\"}",
        ] {
            assert_eq!(
                dispatch(
                    &app,
                    "POST",
                    "/simulations/start",
                    json_headers.clone(),
                    body
                )
                .await
                .status,
                400
            );
        }
        assert_eq!(
            dispatch(
                &app,
                "POST",
                "/simulations/start",
                json_headers,
                &vec![b'x'; BODY_LIMIT + 1]
            )
            .await
            .status,
            413
        );
        assert_eq!(
            dispatch(
                &app,
                "GET",
                "/health",
                BTreeMap::from([("origin".into(), "https://untrusted.invalid".into()),]),
                b""
            )
            .await
            .status,
            403
        );
        assert!(app.bridge.pending.lock().unwrap().is_empty());
    }
}
