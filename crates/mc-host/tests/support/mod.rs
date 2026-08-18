//! Shared harness for `mc-host` conformance tests: a scriptable linked handler
//! and a real-loopback host launcher.

#![allow(dead_code)]

pub mod raw_client;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mc_host::{
    BindOutcome, CancellationToken, HealthReport, HealthStatus, HostConfig, HostError, HostLimits,
    InitError, ManifestSnapshot, McHostHandler, RequestCtx, RequestOutcome, RouteHandle,
    RouteIdentity,
};

use raw_client::Discovered;

pub const LINKED_MODULE_ID: &str = "magic-context";
pub const MODULE_VERSION: &str = "0.1.0-test";

/// Canary values: if any of these reach a diagnostic sink, redaction failed.
pub const CANARY_SESSION: &str = "CANARY-SESSION-9d3f";
pub const CANARY_BODY: &[u8] = b"CANARY-BODY-51ab";

/// Everything the handler observed, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Initialized,
    Bind(RouteHandle, String),
    Request(RouteHandle),
    RouteGone(RouteHandle),
    Health,
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
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
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
        }
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

    async fn bind(&self, route: RouteHandle, identity: RouteIdentity) -> BindOutcome {
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
            "echo" => RequestOutcome::Response {
                body: ctx.body.clone(),
                binary: ctx.binary,
            },
            "len" => RequestOutcome::Response {
                body: serde_json::to_vec(&serde_json::json!({"received_bytes": ctx.body.len()}))
                    .expect("length reply serializes"),
                binary: false,
            },
            "response_bytes" => RequestOutcome::Response {
                body: vec![0; request["bytes"].as_u64().unwrap_or(1) as usize],
                binary: false,
            },
            "oversize_response" => RequestOutcome::Response {
                body: vec![0; 64 * 1024 * 1024 + 1],
                binary: false,
            },
            "oversize_stream" => {
                let rejected = ctx
                    .stream(vec![0; 64 * 1024 * 1024 + 1], true)
                    .await
                    .is_err();
                RequestOutcome::Response {
                    body: serde_json::to_vec(&serde_json::json!({"stream_rejected": rejected}))
                        .expect("stream result serializes"),
                    binary: false,
                }
            }
            "error" => RequestOutcome::Error {
                code: request["code"].as_str().unwrap_or("app_error").to_owned(),
                message: request["message"].as_str().unwrap_or("failed").to_owned(),
            },
            "stream" => {
                let items = request["items"].as_u64().unwrap_or(3);
                for index in 0..items {
                    let item = serde_json::to_vec(&serde_json::json!({"item": index}))
                        .expect("stream item serializes");
                    if ctx.stream(item, false).await.is_err() {
                        return RequestOutcome::Streamed;
                    }
                }
                RequestOutcome::Streamed
            }
            "stream_then_hang" => {
                let items = request["items"].as_u64().unwrap_or(1);
                for index in 0..items {
                    let item = serde_json::to_vec(&serde_json::json!({"item": index}))
                        .expect("stream item serializes");
                    let _ = ctx.stream(item, false).await;
                }
                std::future::pending::<()>().await;
                unreachable!("pending never resolves")
            }
            "await_cancel" => {
                ctx.cancelled().await;
                RequestOutcome::Response {
                    body: b"observed-cancel".to_vec(),
                    binary: false,
                }
            }
            "await_completion" => {
                let _permit = self
                    .inner
                    .completion_gate
                    .acquire()
                    .await
                    .expect("completion gate remains open");
                RequestOutcome::Response {
                    body: b"completed".to_vec(),
                    binary: false,
                }
            }
            "hang" => {
                std::future::pending::<()>().await;
                unreachable!("pending never resolves")
            }
            "slow" => {
                let ms = request["ms"].as_u64().unwrap_or(50);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                RequestOutcome::Response {
                    body: b"slow-done".to_vec(),
                    binary: false,
                }
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
