//! Shared harness for `mc-host` conformance tests: a scriptable linked handler
//! and a real-loopback host launcher.

#![allow(dead_code)]

pub mod broca;
pub mod raw_client;
pub mod synapse;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HealthStatus, HostConfig,
    HostError, HostLimits, InitError, ManifestSnapshot, McHostHandler, PrimaryComponent,
    RequestCtx, RequestOutcome, ResourceDeclaration, RouteHandle, RouteIdentity, RouteTarget,
    SecondaryComponent, ShutdownError,
};

use raw_client::Discovered;

pub const LINKED_MODULE_ID: &str = "magic-context";
pub const MODULE_VERSION: &str = "0.1.0-test";

/// Canary values: if any of these reach a diagnostic sink, redaction failed.
pub const CANARY_SESSION: &str = "CANARY-SESSION-9d3f";
pub const CANARY_BODY: &[u8] = b"CANARY-BODY-51ab";

fn output_error() -> RequestOutcome {
    RequestOutcome::Error {
        code: "internal_error".to_owned(),
        message: "test handler could not reserve output".to_owned(),
    }
}

async fn response_from_slice(ctx: &RequestCtx, bytes: &[u8], binary: bool) -> RequestOutcome {
    let Ok(mut body) = ctx.reserve_output(bytes.len()).await else {
        return output_error();
    };
    body.extend_from_slice(bytes)
        .expect("reservation matches response length");
    RequestOutcome::Response { body, binary }
}

async fn zero_response(ctx: &RequestCtx, len: usize) -> RequestOutcome {
    let Ok(mut body) = ctx.reserve_output(len).await else {
        return output_error();
    };
    body.resize(len, 0)
        .expect("reservation matches response length");
    RequestOutcome::Response {
        body,
        binary: false,
    }
}

async fn json_output(
    ctx: &RequestCtx,
    value: &serde_json::Value,
) -> Result<mc_host::OutputBuffer, mc_host::StreamClosed> {
    let mut body = ctx.reserve_output(256).await?;
    serde_json::to_writer(&mut body, value).map_err(|_| mc_host::StreamClosed)?;
    Ok(body)
}

async fn json_response(ctx: &RequestCtx, value: serde_json::Value) -> RequestOutcome {
    match json_output(ctx, &value).await {
        Ok(body) => RequestOutcome::Response {
            body,
            binary: false,
        },
        Err(_) => output_error(),
    }
}

/// Everything the handler observed, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Initialized,
    Bind(RouteHandle, String),
    Request(RouteHandle),
    RouteGone(RouteHandle),
    Health,
    Shutdown,
    HandlerDropped,
}

/// How the handler should answer `bind`.
#[derive(Debug, Clone)]
pub enum BindPolicy {
    AcceptAll,
    /// Reject when the session equals this value.
    RejectSession {
        session: String,
        code: String,
        message: String,
    },
    /// Block until released, so a close can race an in-flight bind.
    BlockUntilReleased,
    Panic,
    Hang,
}

struct Inner {
    events: Mutex<Vec<Event>>,
    identities: Mutex<Vec<(RouteHandle, RouteIdentity)>>,
    dispatches: AtomicUsize,
    output_reservations: AtomicUsize,
    bind_policy: Mutex<BindPolicy>,
    bind_gate: tokio::sync::Semaphore,
    completion_gate: tokio::sync::Semaphore,
    health: Mutex<HealthReport>,
    init_result: Mutex<Result<(), String>>,
    block_init: Mutex<bool>,
    init_gate: tokio::sync::Semaphore,
    hang_route_gone: Mutex<bool>,
    block_route_gone: Mutex<bool>,
    route_gone_gate: tokio::sync::Semaphore,
    panic_route_gone: Mutex<bool>,
    block_shutdown: Mutex<bool>,
    shutdown_gate: tokio::sync::Semaphore,
    block_runtime_drop: AtomicBool,
    runtime_drop_started: AtomicBool,
    runtime_drop_gate: (Mutex<bool>, Condvar),
}

/// Scriptable linked handler. Per-request behavior is chosen by the request
/// body, so the raw client drives it directly over the wire.
pub struct TestHandler {
    inner: Arc<Inner>,
    record_runtime_drop: bool,
}

impl Clone for TestHandler {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            record_runtime_drop: false,
        }
    }
}

impl TestHandler {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                events: Mutex::new(Vec::new()),
                identities: Mutex::new(Vec::new()),
                dispatches: AtomicUsize::new(0),
                output_reservations: AtomicUsize::new(0),
                bind_policy: Mutex::new(BindPolicy::AcceptAll),
                bind_gate: tokio::sync::Semaphore::new(0),
                completion_gate: tokio::sync::Semaphore::new(0),
                health: Mutex::new(HealthReport::ok()),
                init_result: Mutex::new(Ok(())),
                block_init: Mutex::new(false),
                init_gate: tokio::sync::Semaphore::new(0),
                hang_route_gone: Mutex::new(false),
                block_route_gone: Mutex::new(false),
                route_gone_gate: tokio::sync::Semaphore::new(0),
                panic_route_gone: Mutex::new(false),
                block_shutdown: Mutex::new(false),
                shutdown_gate: tokio::sync::Semaphore::new(0),
                block_runtime_drop: AtomicBool::new(false),
                runtime_drop_started: AtomicBool::new(false),
                runtime_drop_gate: (Mutex::new(false), Condvar::new()),
            }),
            record_runtime_drop: false,
        }
    }

    fn runtime_clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            record_runtime_drop: true,
        }
    }

    pub fn events(&self) -> Vec<Event> {
        self.inner.events.lock().expect("events lock").clone()
    }

    pub fn dispatch_count(&self) -> usize {
        self.inner.dispatches.load(Ordering::SeqCst)
    }

    pub fn output_reservation_count(&self) -> usize {
        self.inner.output_reservations.load(Ordering::SeqCst)
    }

    pub fn binds(&self) -> Vec<RouteHandle> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::Bind(handle, _) => Some(handle),
                _ => None,
            })
            .collect()
    }

    pub fn identities(&self) -> Vec<(RouteHandle, RouteIdentity)> {
        self.inner
            .identities
            .lock()
            .expect("identities lock")
            .clone()
    }

    pub fn route_gones(&self) -> Vec<RouteHandle> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::RouteGone(handle) => Some(handle),
                _ => None,
            })
            .collect()
    }

    pub fn handler_dropped(&self) -> bool {
        self.events().contains(&Event::HandlerDropped)
    }

    pub fn block_handler_drop(&self) {
        self.inner.block_runtime_drop.store(true, Ordering::SeqCst);
    }

    pub fn handler_drop_started(&self) -> bool {
        self.inner.runtime_drop_started.load(Ordering::SeqCst)
    }

    pub fn release_handler_drop(&self) {
        let (lock, ready) = &self.inner.runtime_drop_gate;
        *lock.lock().expect("drop gate lock") = true;
        ready.notify_all();
    }

    pub fn set_bind_policy(&self, policy: BindPolicy) {
        *self.inner.bind_policy.lock().expect("policy lock") = policy;
    }

    pub fn release_bind(&self) {
        self.inner.bind_gate.add_permits(1);
    }

    pub fn release_completion(&self) {
        self.inner.completion_gate.add_permits(1);
    }

    pub fn set_health(&self, status: HealthStatus, detail: Option<&str>) {
        *self.inner.health.lock().expect("health lock") = HealthReport {
            status,
            detail: detail.map(str::to_owned),
            metrics: None,
        };
    }

    pub fn fail_init(&self, message: &str) {
        *self.inner.init_result.lock().expect("init lock") = Err(message.to_owned());
    }

    pub fn block_init(&self) {
        *self.inner.block_init.lock().expect("init block lock") = true;
    }

    pub fn release_init(&self) {
        self.inner.init_gate.add_permits(1);
    }

    pub fn hang_route_gone(&self) {
        *self.inner.hang_route_gone.lock().expect("hang lock") = true;
    }

    pub fn block_route_gone(&self) {
        *self.inner.block_route_gone.lock().expect("block lock") = true;
    }

    pub fn release_route_gone(&self) {
        self.inner.route_gone_gate.add_permits(1);
    }

    pub fn panic_route_gone(&self) {
        *self.inner.panic_route_gone.lock().expect("panic lock") = true;
    }

    pub fn block_shutdown(&self) {
        *self
            .inner
            .block_shutdown
            .lock()
            .expect("shutdown block lock") = true;
    }

    pub fn release_shutdown(&self) {
        self.inner.shutdown_gate.add_permits(1);
    }

    fn push(&self, event: Event) {
        self.inner.events.lock().expect("events lock").push(event);
    }
}

impl Default for TestHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TestHandler {
    fn drop(&mut self) {
        if self.record_runtime_drop {
            self.inner
                .runtime_drop_started
                .store(true, Ordering::SeqCst);
            if self.inner.block_runtime_drop.load(Ordering::SeqCst) {
                let (lock, ready) = &self.inner.runtime_drop_gate;
                let mut released = lock.lock().expect("drop gate lock");
                while !*released {
                    released = ready.wait(released).expect("drop gate wait");
                }
            }
            self.push(Event::HandlerDropped);
        }
    }
}

impl McHostHandler for TestHandler {
    fn manifests(&self) -> Vec<ManifestSnapshot> {
        vec![ManifestSnapshot {
            module_id: LINKED_MODULE_ID.to_owned(),
            module_version: MODULE_VERSION.to_owned(),
            provides: vec![serde_json::json!({
                "role": "tool_provider",
                "tools": [{
                    "name": "ctx_reduce",
                    "execution_mode": "pure",
                    "schema": {"type": "object"}
                }],
                "identity_scope": ["session", "project"],
                "concurrency": "module_managed",
                "emits_push": false,
                "sub_supervises": false,
                "forward_compatible_extra": {"nested": true}
            })],
            control_ops: vec!["health.check".to_owned()],
        }]
    }

    async fn initialize(&self, _init: mc_host::HostInit) -> Result<(), InitError> {
        if *self.inner.block_init.lock().expect("init block lock") {
            let _permit = self
                .inner
                .init_gate
                .acquire()
                .await
                .expect("init gate remains open");
        }
        let outcome = self.inner.init_result.lock().expect("init lock").clone();
        match outcome {
            Ok(()) => {
                self.push(Event::Initialized);
                Ok(())
            }
            Err(message) => Err(InitError(message)),
        }
    }

    async fn bind(
        &self,
        route: RouteHandle,
        _target: RouteTarget,
        identity: RouteIdentity,
    ) -> BindOutcome {
        self.inner
            .identities
            .lock()
            .expect("identities lock")
            .push((route, identity.clone()));
        self.push(Event::Bind(route, identity.session.clone()));
        let policy = self.inner.bind_policy.lock().expect("policy lock").clone();
        match policy {
            BindPolicy::AcceptAll => BindOutcome::Accept,
            BindPolicy::RejectSession {
                session,
                code,
                message,
            } => {
                if identity.session == session {
                    BindOutcome::Reject { code, message }
                } else {
                    BindOutcome::Accept
                }
            }
            BindPolicy::BlockUntilReleased => {
                let _permit = self
                    .inner
                    .bind_gate
                    .acquire()
                    .await
                    .expect("bind gate is never closed");
                BindOutcome::Accept
            }
            BindPolicy::Panic => panic!("bind panic"),
            BindPolicy::Hang => {
                std::future::pending::<()>().await;
                unreachable!("pending bind never resolves")
            }
        }
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        self.inner.dispatches.fetch_add(1, Ordering::SeqCst);
        self.push(Event::Request(ctx.route));

        let request: serde_json::Value =
            serde_json::from_slice(&ctx.body).unwrap_or(serde_json::Value::Null);
        let mode = request["mode"].as_str().unwrap_or("echo");

        match mode {
            "echo" => response_from_slice(&ctx, &ctx.body, ctx.binary).await,
            "len" => {
                json_response(&ctx, serde_json::json!({"received_bytes": ctx.body.len()})).await
            }
            "response_bytes" => {
                zero_response(&ctx, request["bytes"].as_u64().unwrap_or(1) as usize).await
            }
            "reserve_then_await_completion" => {
                let len = request["bytes"].as_u64().unwrap_or(1) as usize;
                let Ok(mut body) = ctx.reserve_output(len).await else {
                    return output_error();
                };
                self.inner
                    .output_reservations
                    .fetch_add(1, Ordering::SeqCst);
                self.inner
                    .completion_gate
                    .acquire()
                    .await
                    .expect("completion gate remains open")
                    .forget();
                body.resize(len, 0)
                    .expect("reservation matches response length");
                RequestOutcome::Response {
                    body,
                    binary: false,
                }
            }
            "oversize_response" => {
                let _ = ctx.reserve_output(64 * 1024 * 1024 + 1).await;
                output_error()
            }
            "oversize_stream" => {
                let _ = ctx.reserve_output(64 * 1024 * 1024 + 1).await;
                output_error()
            }
            "error" => RequestOutcome::Error {
                code: request["code"].as_str().unwrap_or("app_error").to_owned(),
                message: request["message"].as_str().unwrap_or("failed").to_owned(),
            },
            "stream" => {
                let items = request["items"].as_u64().unwrap_or(3);
                for index in 0..items {
                    let Ok(item) = json_output(&ctx, &serde_json::json!({"item": index})).await
                    else {
                        return RequestOutcome::Streamed;
                    };
                    if ctx.stream(item, false).await.is_err() {
                        return RequestOutcome::Streamed;
                    }
                }
                RequestOutcome::Streamed
            }
            "stream_then_hang" => {
                let items = request["items"].as_u64().unwrap_or(1);
                for index in 0..items {
                    if let Ok(item) = json_output(&ctx, &serde_json::json!({"item": index})).await {
                        let _ = ctx.stream(item, false).await;
                    }
                }
                std::future::pending::<()>().await;
                unreachable!("pending never resolves")
            }
            "await_cancel" => {
                ctx.cancelled().await;
                response_from_slice(&ctx, b"observed-cancel", false).await
            }
            "await_completion" => {
                // `forget` keeps the permit consumed: each dispatch must be
                // individually released via `release_completion`, or the
                // returned permit would let later iterations complete without
                // racing the release.
                self.inner
                    .completion_gate
                    .acquire()
                    .await
                    .expect("completion gate remains open")
                    .forget();
                response_from_slice(&ctx, b"completed", false).await
            }
            "hang" => {
                std::future::pending::<()>().await;
                unreachable!("pending never resolves")
            }
            "slow" => {
                let ms = request["ms"].as_u64().unwrap_or(50);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                response_from_slice(&ctx, b"slow-done", false).await
            }
            "panic" => panic!("{}", String::from_utf8_lossy(CANARY_BODY)),
            other => RequestOutcome::Error {
                code: "unknown_mode".to_owned(),
                message: format!("unsupported test mode {other}"),
            },
        }
    }

    async fn route_gone(&self, route: RouteHandle) {
        if *self.inner.panic_route_gone.lock().expect("panic lock") {
            panic!("route_gone panic for {route:?}");
        }
        if *self.inner.hang_route_gone.lock().expect("hang lock") {
            std::future::pending::<()>().await;
        }
        if *self.inner.block_route_gone.lock().expect("block lock") {
            let _permit = self
                .inner
                .route_gone_gate
                .acquire()
                .await
                .expect("route-gone gate remains open");
        }
        self.push(Event::RouteGone(route));
    }

    async fn health(&self) -> HealthReport {
        self.push(Event::Health);
        self.inner.health.lock().expect("health lock").clone()
    }

    async fn shutdown(&self) {
        if *self
            .inner
            .block_shutdown
            .lock()
            .expect("shutdown block lock")
        {
            let _permit = self
                .inner
                .shutdown_gate
                .acquire()
                .await
                .expect("shutdown gate remains open");
        }
        self.push(Event::Shutdown);
    }
}

pub struct TestHost {
    pub handler: TestHandler,
    pub info: Discovered,
    pub data_root: tempfile::TempDir,
    publication: PathBuf,
    shutdown: CancellationToken,
    join: Option<tokio::task::JoinHandle<Result<(), HostError>>>,
}

impl TestHost {
    /// Starts a host with test-sized limits and waits for its publication.
    pub async fn start() -> Self {
        Self::start_with(|_config| {}).await
    }

    /// Starts a host after applying `tweak` to the configuration.
    pub async fn start_with(tweak: impl FnOnce(&mut HostConfig)) -> Self {
        Self::try_start_with(TestHandler::new(), tweak)
            .await
            .expect("host must publish")
    }

    /// Starts `handler`, returning the harness once the publication appears.
    pub async fn try_start_with(
        handler: TestHandler,
        tweak: impl FnOnce(&mut HostConfig),
    ) -> Result<Self, HostError> {
        let data_root = tempfile::tempdir().expect("temp data root");
        let mut config = HostConfig {
            data_dir: Some(data_root.path().to_path_buf()),
            daemon_ver: "mc-host/test".to_owned(),
            limits: HostLimits {
                // Small but still interoperable: one 64 MiB frame must fit.
                max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES * 2,
                ..Default::default()
            },
            ..Default::default()
        };
        config.timing.auth_deadline = Duration::from_secs(2);
        config.timing.frame_deadline = Duration::from_secs(5);
        config.timing.shutdown_deadline = Duration::from_secs(5);
        config.timing.route_close_budget = Duration::from_secs(2);
        config.timing.lifecycle_callback_deadline = Duration::from_secs(2);
        tweak(&mut config);

        // A tweak may redirect the data root, so the publication path has to
        // come from the effective configuration.
        let publication = connection_file(
            config
                .data_dir
                .as_deref()
                .expect("the harness always configures a data root"),
        );

        let shutdown = CancellationToken::new();
        let run_handler = handler.runtime_clone();
        let run_shutdown = shutdown.clone();
        let join =
            tokio::spawn(async move { mc_host::run(run_handler, config, run_shutdown).await });

        // A predecessor may already have published at this path, so a
        // pre-existing snapshot must not be mistaken for this host's own.
        let existing = std::fs::read(&publication).ok();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            // If `join` has finished, return its error before accepting a stale
            // publication.
            if join.is_finished() {
                return Err(join
                    .await
                    .expect("run task joins")
                    .expect_err("run returned success without publishing"));
            }
            match std::fs::read(&publication) {
                Ok(bytes) if Some(&bytes) != existing.as_ref() => break,
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                shutdown.cancel();
                panic!("host did not publish within its startup budget");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let info = raw_client::discover(&publication).expect("publication must validate");
        Ok(Self {
            handler,
            info,
            data_root,
            publication,
            shutdown,
            join: Some(join),
        })
    }

    pub fn publication_path(&self) -> PathBuf {
        self.publication.clone()
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.publication
            .parent()
            .expect("a publication always sits in a runtime directory")
            .to_path_buf()
    }

    pub async fn client(&self) -> raw_client::RawClient {
        raw_client::RawClient::connect(&self.info)
            .await
            .expect("authenticated connection")
    }

    /// Signals shutdown and returns the runtime's result.
    pub async fn shutdown(mut self) -> Result<(), HostError> {
        self.shutdown.cancel();
        let join = self.join.take().expect("host runs once");
        tokio::time::timeout(Duration::from_secs(20), join)
            .await
            .expect("host must finish within its shutdown budget")
            .expect("run task joins")
    }

    /// Signals shutdown and expects a graceful result.
    pub async fn shutdown_gracefully(self) {
        let handler = self.handler.clone();
        self.shutdown().await.expect("graceful shutdown");
        assert!(
            handler.handler_dropped(),
            "the runtime must drop the handler before returning"
        );
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        // A test that panics mid-way must not leave a host holding the lock.
        self.shutdown.cancel();
    }
}

pub fn connection_file(data_root: &Path) -> PathBuf {
    data_root
        .join("cortexkit")
        .join("run")
        .join(mc_host::CONNECTION_FILE_NAME)
}

/// Body for the handler's echo mode.
pub fn echo_body(payload: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"mode": "echo", "payload": payload}))
        .expect("body serializes")
}

pub fn mode_body(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).expect("body serializes")
}

/// Minimal scriptable composite child for three-component hosts. Per-request
/// behavior is chosen by the request body, like [`TestHandler`]: mode `hang`
/// parks the handler task forever (holding its pending and task permits, the
/// capacity-isolation fixture); anything else answers `{"served_by": id}`.
#[derive(Clone)]
pub struct StubComponent {
    id: &'static str,
    role: &'static str,
    resources: ResourceDeclaration,
    dispatches: Arc<AtomicUsize>,
}

impl StubComponent {
    pub fn new(id: &'static str, role: &'static str) -> Self {
        Self {
            id,
            role,
            resources: ResourceDeclaration::default(),
            dispatches: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn with_resources(mut self, resources: ResourceDeclaration) -> Self {
        self.resources = resources;
        self
    }

    pub fn dispatch_count(&self) -> usize {
        self.dispatches.load(Ordering::SeqCst)
    }
}

impl CompositeComponent for StubComponent {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: self.id.to_owned(),
            module_version: "0.0.1".to_owned(),
            provides: vec![serde_json::json!({"role": self.role})],
            control_ops: Vec::new(),
        }
    }

    fn resources(&self) -> ResourceDeclaration {
        self.resources
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        let request: serde_json::Value =
            serde_json::from_slice(&ctx.body).unwrap_or(serde_json::Value::Null);
        if request["mode"].as_str() == Some("hang") {
            std::future::pending::<()>().await;
            unreachable!("pending never resolves")
        }
        json_response(&ctx, serde_json::json!({"served_by": self.id})).await
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl PrimaryComponent for StubComponent {
    async fn initialize(&self, _init: mc_host::HostInit) -> Result<(), InitError> {
        Ok(())
    }
}

impl SecondaryComponent for StubComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

/// The direct profile's three stub children in catalog order, for tests
/// whose subject is the host runtime rather than any one component.
pub fn stub_trio() -> (StubComponent, StubComponent, StubComponent) {
    (
        StubComponent::new("magic-context", "tool_provider"),
        StubComponent::new("synapse", "management_surface"),
        StubComponent::new("broca", "management_surface"),
    )
}

/// Real-loopback host over an arbitrary linked handler, for three-child
/// composite tests that [`TestHost`]'s fixed [`TestHandler`] cannot express.
pub struct CompositeTestHost {
    pub info: Discovered,
    shutdown: CancellationToken,
    join: Option<tokio::task::JoinHandle<Result<(), HostError>>>,
    _data_root: tempfile::TempDir,
}

impl CompositeTestHost {
    /// Starts `handler`, returning the harness once the publication appears
    /// or the runtime's startup error otherwise.
    pub async fn try_start<H: McHostHandler>(
        handler: H,
        tweak: impl FnOnce(&mut HostConfig),
    ) -> Result<Self, HostError> {
        let data_root = tempfile::tempdir().expect("temp data root");
        let mut config = HostConfig {
            data_dir: Some(data_root.path().to_path_buf()),
            daemon_ver: "mc-host/test".to_owned(),
            limits: HostLimits {
                max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES * 2,
                ..Default::default()
            },
            ..Default::default()
        };
        config.timing.frame_deadline = Duration::from_secs(5);
        config.timing.shutdown_deadline = Duration::from_secs(5);
        config.timing.route_close_budget = Duration::from_secs(2);
        config.timing.lifecycle_callback_deadline = Duration::from_secs(2);
        tweak(&mut config);

        let publication = connection_file(
            config
                .data_dir
                .as_deref()
                .expect("the harness always configures a data root"),
        );
        let shutdown = CancellationToken::new();
        let run_shutdown = shutdown.clone();
        let join = tokio::spawn(async move { mc_host::run(handler, config, run_shutdown).await });

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if join.is_finished() {
                return Err(join
                    .await
                    .expect("run task joins")
                    .expect_err("run returned success without publishing"));
            }
            if std::fs::read(&publication).is_ok() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                shutdown.cancel();
                panic!("host did not publish within its startup budget");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let info = raw_client::discover(&publication).expect("publication must validate");
        Ok(Self {
            info,
            shutdown,
            join: Some(join),
            _data_root: data_root,
        })
    }

    pub async fn start<H: McHostHandler>(handler: H, tweak: impl FnOnce(&mut HostConfig)) -> Self {
        Self::try_start(handler, tweak)
            .await
            .expect("host must publish")
    }

    pub async fn client(&self) -> raw_client::RawClient {
        raw_client::RawClient::connect(&self.info)
            .await
            .expect("authenticated connection")
    }

    pub async fn shutdown(mut self) -> Result<(), HostError> {
        self.shutdown.cancel();
        let join = self.join.take().expect("host runs once");
        tokio::time::timeout(Duration::from_secs(20), join)
            .await
            .expect("host must finish within its shutdown budget")
            .expect("run task joins")
    }
}

impl Drop for CompositeTestHost {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

/// Asserts every catalog module's `control_ops` equals `expected` exactly, so
/// an unimplemented operation such as `wake.create` can never be advertised
/// (protocol AE10) and TypeScript wake-plane probing stays fail-open.
pub fn assert_control_ops(modules: &serde_json::Value, expected: &[&str]) {
    let modules = modules.as_array().expect("modules array");
    assert!(!modules.is_empty(), "catalog returned no modules");
    let expected = serde_json::json!(expected);
    for module in modules {
        assert_eq!(
            module["control_ops"], expected,
            "{} control_ops must list implemented operations only",
            module["module_id"]
        );
    }
}
