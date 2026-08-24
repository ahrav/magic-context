//! Compile probe: replays every `subc` API shape mc-module uses, against the
//! LATEST PUBLISHED crates. Compiler success == shape-compatible evidence.
#![allow(dead_code, unused_variables)]

use std::{path::Path, path::PathBuf, time::Duration};

use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, CallError, CallOptions, CloseRouteOptions, ConsumerOptions,
    HandlerOutcome, HealthReport, HealthStatus, ModuleHandler, RequestCtx, RetryBackoff,
    RouteBindRequest, RouteHandle, SubcConsumer,
};
use subc_control::{ClientControlRequest, ClientControlResponse, ConsumerIdentity};
use subc_protocol::manifest::{
    Bindings, Concurrency, ConsumerRole, ExecutionMode, IdentityBinding, IdentityScope,
    ModuleManifest, ProviderRole, StorageBinding, StorageKind, StorageScope, Tool, TrustTier,
};
use subc_protocol::{
    BindIdentity, ErrorBody, Flags, Frame, FrameBuildError, FrameType, ModuleHelloAckBody, Priority,
    RouteTarget, PROTOCOL_VERSION, SUBC_LAUNCH_NONCE_ENV, SUBC_MODULE_ID_ENV,
};
use subc_transport::{
    authenticate_client, connection_file, read_frame, write_frame, AuthError, ConnectionFileError,
    FrameIoError,
};
use tokio::net::TcpStream;

// ---- R-PROTO: manifest construction (mc-module lib.rs::manifest) ----
pub fn manifest(module_id: &str) -> ModuleManifest {
    ModuleManifest {
        module_id: module_id.to_string(),
        module_version: "0.1.0".to_string(),
        protocol_ver: PROTOCOL_VERSION,
        trust_tier: TrustTier::FirstParty,
        provides: vec![ProviderRole::ToolProvider {
            tools: module_tools(),
            identity_scope: vec![IdentityScope::Project, IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
            emits_push: false,
            sub_supervises: false,
        }],
        consumes: vec![ConsumerRole::ServiceClient {
            of: vec!["thalamus".to_string()],
        }],
        // DELTA-1 (probe-only line, absent from mc-module's literal):
        scheduled_tasks: Vec::new(),
        bindings: Bindings {
            storage: StorageBinding {
                kind: StorageKind::Sqlite,
                scope: StorageScope::Project,
                owns_schema: true,
            },
            vault_grants: Vec::new(),
            identity: IdentityBinding {
                requires: vec![IdentityScope::Project],
                optional: vec![IdentityScope::Session],
            },
        },
    }
}

fn module_tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "transform".to_string(),
            description: Some("d".to_string()),
            execution_mode: ExecutionMode::Pure,
            schema: json!({ "type": "object" }),
        },
        Tool {
            name: "ctx_memory".to_string(),
            description: Some("d".to_string()),
            execution_mode: ExecutionMode::Mutating,
            schema: json!({ "type": "object" }),
        },
    ]
}

/// mc-module lib.rs:20945 — tool list decoded back off a module response.
pub fn decode_tools(v: Value) -> Result<Vec<Tool>, serde_json::Error> {
    serde_json::from_value::<Vec<Tool>>(v)
}

/// mc-module prompt_surface tests compare execution_mode values.
pub fn execution_mode_eq(a: &Tool, b: &Tool) -> bool {
    a.execution_mode == b.execution_mode
}

// ---- R-CLIENT: provider role (mc-module lib.rs::McHandler) ----
pub struct Handler;

fn resolve_descriptor(storage: Option<&Value>) -> bool {
    storage.is_some()
}

#[async_trait]
impl ModuleHandler for Handler {
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody) {
        let _ = resolve_descriptor(ack.storage.as_ref());
    }

    async fn health(&self) -> HealthReport {
        HealthReport {
            status: HealthStatus::Degraded,
            detail: Some("waiting on storage lease".to_string()),
            metrics: Some(json!({ "lane": "transform" })),
        }
    }

    async fn on_bind(&self, req: &RouteBindRequest) -> subc_client_rs::BindDecision {
        let _root: &PathBuf = &req.identity.project_root;
        let _harness: &String = &req.identity.harness;
        let _session: &String = &req.identity.session;
        let _channel: u16 = req.handle.channel;
        subc_client_rs::BindDecision::accept()
    }

    async fn on_route_gone(&self, handle: &RouteHandle) {
        let _channel: u16 = handle.channel;
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let _channel: u16 = ctx.route_handle().channel;
        dispatch(serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null))
    }
}

fn dispatch(request: Value) -> HandlerOutcome {
    if request.is_null() {
        return HandlerOutcome::Error {
            code: "bad_request".to_string(),
            message: "not json".to_string(),
        };
    }
    HandlerOutcome::Response(b"{}".to_vec())
}

/// mc-module matches all four HandlerOutcome variants (lib.rs:8852, 29106).
pub fn outcome_code(outcome: &HandlerOutcome) -> Option<&str> {
    match outcome {
        HandlerOutcome::Error { code, .. } => Some(code),
        // DELTA-3 (mc-module also has this arm; absent from 0.3.0):
        // HandlerOutcome::ErrorWithDetail { code, .. } => Some(code),
        HandlerOutcome::Response(_) | HandlerOutcome::Streamed => None,
    }
}

pub async fn boot(connection_file: &Path, module_id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = std::env::var(SUBC_MODULE_ID_ENV);
    subc_client_rs::serve_with(connection_file, manifest(module_id), Handler).await?;
    Ok(())
}

// ---- R-CLIENT: consumer role (mc-module session_resolver) ----
fn consumer_options() -> ConsumerOptions {
    ConsumerOptions {
        handshake_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(2),
        reconnect_backoff: RetryBackoff {
            base: Duration::from_millis(25),
            cap: Duration::from_millis(50),
            max_attempts: 1,
        },
        restored_debounce: Duration::from_millis(10),
    }
}

fn call_options() -> CallOptions {
    CallOptions {
        timeout: Duration::from_secs(2),
        route_retry: RetryBackoff {
            base: Duration::from_millis(25),
            cap: Duration::from_millis(50),
            max_attempts: 1,
        },
        route_retry_deadline: Duration::from_secs(2),
        ..CallOptions::default()
    }
}

pub async fn resolve_session(connection_file: &Path, module_id: &str) -> Result<Value, String> {
    let target = RouteTarget::ManagementSurface {
        module_id: module_id.to_string(),
    };
    let identity = BindIdentity {
        project_root: PathBuf::from("/tmp"),
        harness: "claude-code".to_string(),
        session: "tok".to_string(),
    };
    let consumer = SubcConsumer::connect(connection_file, consumer_options())
        .await
        .map_err(|e| e.to_string())?;
    let response = consumer
        .call(
            target.clone(),
            identity.clone(),
            serde_json::to_vec(&json!({ "method": "session.resolve" })).map_err(|e| e.to_string())?,
            call_options(),
        )
        .await;
    consumer
        .close_route(target, identity, CloseRouteOptions::default())
        .await;
    consumer.close().await;
    let bytes = response.map_err(call_error_to_string)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn call_error_to_string(error: CallError) -> String {
    match error {
        CallError::Module(body) if body.code == "session_resolve_timeout" => "timeout".to_string(),
        other => other.to_string(),
    }
}

// ---- R-TRANSPORT + R-CONTROL: the raw producer client (mc-module historian_producer) ----
#[derive(Debug)]
pub enum ProducerError {
    ConnectionFile { path: PathBuf, source: ConnectionFileError },
    NoEndpoint { path: PathBuf },
    Connect { endpoint: String, source: std::io::Error },
    Auth(AuthError),
    FrameIo(FrameIoError),
    FrameBuild(FrameBuildError),
    Subc(ProducerErrorBody),
    UnexpectedStreamEnd,
    TimedOut,
    MissingSession,
    Json(serde_json::Error),
}

impl From<FrameIoError> for ProducerError {
    fn from(e: FrameIoError) -> Self {
        Self::FrameIo(e)
    }
}
impl From<FrameBuildError> for ProducerError {
    fn from(e: FrameBuildError) -> Self {
        Self::FrameBuild(e)
    }
}
impl From<serde_json::Error> for ProducerError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerErrorBody {
    pub code: String,
    pub message: String,
}

impl From<ErrorBody> for ProducerErrorBody {
    fn from(body: ErrorBody) -> Self {
        Self {
            code: body.code,
            message: body.message,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct OpenedRoute {
    channel: u16,
    epoch: u32,
}

pub struct Producer {
    stream: TcpStream,
    next_corr: u64,
    module_id: String,
    session_id: Option<String>,
}

impl Producer {
    pub async fn connect(path: &Path, handshake_timeout: Duration) -> Result<Self, ProducerError> {
        let conn = connection_file::read(path).map_err(|source| ProducerError::ConnectionFile {
            path: path.to_path_buf(),
            source,
        })?;
        let endpoint = conn
            .endpoints
            .first()
            .ok_or_else(|| ProducerError::NoEndpoint { path: path.to_path_buf() })?;
        let endpoint_label = format!("{}:{}", endpoint.host, endpoint.port);
        let mut stream = TcpStream::connect(&endpoint_label)
            .await
            .map_err(|source| ProducerError::Connect { endpoint: endpoint_label, source })?;
        authenticate_client(&mut stream, &conn, handshake_timeout)
            .await
            .map_err(ProducerError::Auth)?;
        Ok(Self {
            stream,
            next_corr: 1,
            module_id: "broca".to_string(),
            session_id: None,
        })
    }

    async fn open_bound_route(&mut self) -> Result<OpenedRoute, ProducerError> {
        let session = self.session_id.clone().ok_or(ProducerError::MissingSession)?;
        let request = ClientControlRequest::RouteOpen {
            target: RouteTarget::ManagementSurface {
                module_id: self.module_id.clone(),
            },
            identity: BindIdentity {
                project_root: PathBuf::from("/tmp"),
                harness: "claude-code".to_string(),
                session,
            },
            consumer_identity: consumer_identity_from_env(),
            consumer_capabilities: None,
            admission_facts: None,
        };
        let corr = self.next_corr();
        let body = serde_json::to_vec(&request)?;
        self.write_frame(FrameType::Request, 0, 0, corr, body).await?;
        let frame = self
            .read_terminal_for(OpenedRoute { channel: 0, epoch: 0 }, corr, Duration::from_secs(2))
            .await?;
        match frame.header.ty {
            FrameType::Response => {
                let response: ClientControlResponse = serde_json::from_slice(&frame.body)?;
                if let ClientControlResponse::RouteOpen { route_channel, route_epoch } = response {
                    return Ok(OpenedRoute { channel: route_channel, epoch: route_epoch });
                }
                Err(ProducerError::UnexpectedStreamEnd)
            }
            FrameType::Error => Err(ProducerError::Subc(error_body(&frame.body))),
            FrameType::StreamData | FrameType::StreamEnd => Err(ProducerError::UnexpectedStreamEnd),
            _ => Err(ProducerError::UnexpectedStreamEnd),
        }
    }

    async fn read_terminal_for(
        &mut self,
        route: OpenedRoute,
        corr: u64,
        timeout: Duration,
    ) -> Result<Frame, ProducerError> {
        match tokio::time::timeout(timeout, async {
            loop {
                let Some(frame) = read_frame(&mut self.stream).await? else {
                    return Err(ProducerError::UnexpectedStreamEnd);
                };
                if frame.header.channel == route.channel
                    && frame.header.epoch == route.epoch
                    && frame.header.corr == corr
                {
                    return Ok(frame);
                }
            }
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(ProducerError::TimedOut),
        }
    }

    async fn write_frame(
        &mut self,
        ty: FrameType,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: Vec<u8>,
    ) -> Result<(), ProducerError> {
        let frame = Frame::build(
            ty,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            body,
        )?;
        write_frame(&mut self.stream, &frame).await?;
        Ok(())
    }

    async fn send_goodbye(&mut self, route: OpenedRoute) -> Result<(), ProducerError> {
        let frame = Frame::build(
            FrameType::Goodbye,
            Flags::new(false, Priority::Interactive, false),
            route.channel,
            route.epoch,
            0,
            Vec::new(),
        )?;
        write_frame(&mut self.stream, &frame).await?;
        Ok(())
    }

    fn next_corr(&mut self) -> u64 {
        let corr = self.next_corr;
        self.next_corr = self.next_corr.saturating_add(1).max(1);
        corr
    }
}

fn consumer_identity_from_env() -> Option<ConsumerIdentity> {
    let module_id = std::env::var(SUBC_MODULE_ID_ENV).unwrap_or_default();
    let launch_nonce = std::env::var(SUBC_LAUNCH_NONCE_ENV).unwrap_or_default();
    (!module_id.is_empty() && !launch_nonce.is_empty()).then_some(ConsumerIdentity {
        module_id,
        launch_nonce,
    })
}

fn error_body(body: &[u8]) -> ProducerErrorBody {
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => ProducerErrorBody {
            code: value
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("producer_error")
                .to_string(),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("producer error")
                .to_string(),
        },
        Err(e) => ProducerErrorBody {
            code: "invalid_error_body".to_string(),
            message: e.to_string(),
        },
    }
}

// ---- attribute-macro re-export used on mc-module's OWN traits (historian.rs) ----
#[subc_client_rs::async_trait]
pub trait ProducerDriver: Send {
    async fn bind_session(&mut self, session_id: &str) -> Result<(), ProducerError>;
}

#[subc_client_rs::async_trait]
impl ProducerDriver for Producer {
    async fn bind_session(&mut self, session_id: &str) -> Result<(), ProducerError> {
        self.session_id = Some(session_id.to_string());
        Ok(())
    }
}
