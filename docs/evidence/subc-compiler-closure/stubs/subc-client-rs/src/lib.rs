
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use subc_protocol::manifest::ModuleManifest;
use subc_protocol::{BindIdentity, ErrorBody, ModuleHelloAckBody, RouteTarget};

pub use async_trait::async_trait;

#[derive(Debug)]
pub enum HandlerOutcome {
    Response(Vec<u8>),
    Error { code: String, message: String },
    ErrorWithDetail { code: String },
    Streamed,
}

#[derive(Debug, PartialEq)]
pub enum HealthStatus {
    Ok,
    Degraded,
}

pub struct HealthReport {
    pub status: HealthStatus,
    pub detail: Option<String>,
    pub metrics: Option<Value>,
}

pub struct RouteHandle {
    pub channel: u16,
}

pub struct RouteBindRequest {
    pub handle: RouteHandle,
    pub identity: BindIdentity,
}

pub struct BindDecision {
    _private: (),
}

impl BindDecision {
    pub fn accept() -> Self {
        unimplemented!("compile-closure stub")
    }
}

pub struct RequestCtx {
    _private: (),
}

impl RequestCtx {
    pub fn route_handle(&self) -> RouteHandle {
        unimplemented!("compile-closure stub")
    }
}

#[async_trait]
pub trait ModuleHandler: Send + Sync + 'static {
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody);
    async fn health(&self) -> HealthReport;
    async fn on_bind(&self, req: &RouteBindRequest) -> BindDecision;
    async fn on_route_gone(&self, handle: &RouteHandle);
    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome;
}

#[derive(Debug)]
pub struct ServeError {
    _private: (),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

impl std::error::Error for ServeError {}

pub async fn serve_with<H: ModuleHandler>(
    _connection_file: &Path,
    _manifest: ModuleManifest,
    _handler: H,
) -> Result<(), ServeError> {
    unimplemented!("compile-closure stub")
}

#[derive(Default)]
pub struct RetryBackoff {
    pub base: Duration,
    pub cap: Duration,
    pub max_attempts: u32,
}

pub struct ConsumerOptions {
    pub handshake_timeout: Duration,
    pub call_timeout: Duration,
    pub reconnect_backoff: RetryBackoff,
    pub restored_debounce: Duration,
}

#[derive(Default)]
pub struct CallOptions {
    pub timeout: Duration,
    pub route_retry: RetryBackoff,
    pub route_retry_deadline: Duration,
}

/// Row: `CloseRouteOptions::default()`.
#[derive(Default)]
pub struct CloseRouteOptions {
    _private: (),
}

#[derive(Debug)]
pub enum CallError {
    Module(ErrorBody),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}


#[derive(Debug)]
pub struct ConnectError {
    _private: (),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}


/// `close_route`, `close`).
pub struct SubcConsumer {
    _private: (),
}

impl SubcConsumer {
    pub async fn connect(
        _connection_file: &Path,
        _options: ConsumerOptions,
    ) -> Result<Self, ConnectError> {
        unimplemented!("compile-closure stub")
    }

    pub async fn call(
        &self,
        _target: RouteTarget,
        _identity: BindIdentity,
        _body: Vec<u8>,
        _options: CallOptions,
    ) -> Result<Vec<u8>, CallError> {
        unimplemented!("compile-closure stub")
    }

    /// CloseRouteOptions)`.
    pub async fn close_route(
        &self,
        _target: RouteTarget,
        _identity: BindIdentity,
        _options: CloseRouteOptions,
    ) {
        unimplemented!("compile-closure stub")
    }

    pub async fn close(&self) {
        unimplemented!("compile-closure stub")
    }
}
