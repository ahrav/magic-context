//! U6 authenticated round-trip proof (R25, AE15): the REAL `HistorianProducer`
//! and the REAL module classify path complete LLM round trips against a real
//! in-process `mc-host` — three-child static composite, HMAC handshake, wire-v2
//! framing, and the Broca run supervisor — with a deterministic backend instead
//! of a subprocess (R14). The two round trips collectively select both
//! harnesses: historian under `opencode`, classify under `pi`.
//!
//! Hermetic by construction: loopback only, temp data directories, no provider
//! credentials, no `packages/e2e-tests` involvement (R27).

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use mc_host::broca::backend::{
    BackendError, BackendEvent, BackendFuture, BackendRequest, BackendTerminal,
    ErrorClass as BackendErrorClass, EventSink, FinishReason, LlmExecutionBackend,
};
use mc_host::broca::supervisor::{SessionKey, Supervisor};
use mc_host::broca::BrocaComponent;
use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HostConfig, HostError,
    HostInit, HostLimits, InitError, ManifestSnapshot, PrimaryComponent, RequestCtx,
    RequestOutcome, RouteHandle, RouteIdentity, SecondaryComponent, ShutdownError, StaticComposite,
};

use mc_module::classify::attempt_child_session_id;
use mc_module::historian::{
    reattach_historian_producer, HistorianReattachOutcome, HistorianReattachRequest,
};
use mc_module::historian_producer::{
    ErrorClass, HistorianProducer, HistorianProducerConfig, HistorianProducerError, RunState,
};
use mc_module::historian_validate::{HistorianChunk, ValidateOptions};
use mc_module::McHandler;

use mc_store::{
    CompartmentSetGeneration, HistorianChunkRange, HistorianDurableState, HistorianPhase,
    InsertMemoryInput, McStore,
};

use subc_control::{ClientControlRequest, ClientControlResponse};
use subc_protocol::{BindIdentity, Flags, Frame, FrameType, Priority, RouteTarget};
use subc_transport::{authenticate_client, connection_file, read_frame, write_frame};

const BUDGET: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Deterministic backend. Reimplemented here rather than shared with mc-host's
// `tests/support` because Cargo compiles test-support modules per crate; the
// public `LlmExecutionBackend` contract (R14) is exactly the seam that makes
// this cheap.
// ---------------------------------------------------------------------------

type RunFn = dyn Fn(BackendRequest, EventSink, CancellationToken) -> BackendFuture + Send + Sync;

/// One backend invocation as the supervisor delivered it, retained so tests
/// can prove harness propagation, model order, and per-attempt sessions.
#[derive(Debug, Clone)]
struct SeenRun {
    session: String,
    provider: String,
    model: String,
    harness: &'static str,
}

struct ScriptedBackend {
    starts: AtomicUsize,
    seen: Mutex<Vec<SeenRun>>,
    run: Box<RunFn>,
}

impl ScriptedBackend {
    fn with_behavior(
        run: impl Fn(BackendRequest, EventSink, CancellationToken) -> BackendFuture
            + Send
            + Sync
            + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            starts: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
            run: Box::new(run),
        })
    }

    fn starts(&self) -> usize {
        self.starts.load(Ordering::SeqCst)
    }

    fn seen(&self) -> Vec<SeenRun> {
        self.seen.lock().expect("seen mutex").clone()
    }

    /// Emits `manifest` and completes, except for models containing `flaky`,
    /// which fail with a classified transient error carrying retry metadata —
    /// the AE13 transient fixture the classify fallback tests consume.
    fn classify_manifest(manifest: String) -> Arc<Self> {
        Self::with_behavior(move |request, events, _cancel| {
            let manifest = manifest.clone();
            Box::pin(async move {
                if request.model.contains("flaky") {
                    return BackendTerminal::Failed(BackendError {
                        class: BackendErrorClass::Transient,
                        message: "provider rate limited".to_owned(),
                        retry_after_secs: Some(7),
                        provider_code: Some("rate_limited".to_owned()),
                    });
                }
                events.emit(BackendEvent::AssistantText {
                    text: manifest,
                    finish_reason: None,
                });
                BackendTerminal::Completed {
                    finish_reason: FinishReason::Completed,
                }
            })
        })
    }

    /// Every run parks on the returned gate and deliberately ignores its
    /// cancel token, which is what keeps `run.cancel` settlement blocked for
    /// the reserved-capacity saturation test; release the gate before host
    /// shutdown so the drain stays bounded.
    fn stuck_until_gate() -> (Arc<Self>, Arc<tokio::sync::Semaphore>) {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let run_gate = Arc::clone(&gate);
        let backend = Self::with_behavior(move |_request, _events, _cancel| {
            let gate = Arc::clone(&run_gate);
            Box::pin(async move {
                gate.acquire().await.expect("gate stays open").forget();
                BackendTerminal::Completed {
                    finish_reason: FinishReason::Completed,
                }
            })
        });
        (backend, gate)
    }
}

impl LlmExecutionBackend for ScriptedBackend {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().expect("seen mutex").push(SeenRun {
            session: request.session.clone(),
            provider: request.provider.clone(),
            model: request.model.clone(),
            harness: request.harness.as_str(),
        });
        (self.run)(request, events, cancel)
    }
}

// ---------------------------------------------------------------------------
// Real-loopback three-child host: a minimal echo `magic-context` primary, a
// stub `synapse` secondary, and the REAL BrocaComponent under test.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct FixedComponent {
    id: &'static str,
    role: &'static str,
}

impl CompositeComponent for FixedComponent {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: self.id.to_owned(),
            module_version: "0.0.1-roundtrip".to_owned(),
            provides: vec![json!({"role": self.role})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        let body = serde_json::to_vec(&json!({"served_by": self.id})).expect("body serializes");
        let Ok(mut output) = ctx.reserve_output(body.len()).await else {
            return RequestOutcome::Error {
                code: "internal_error".to_owned(),
                message: "echo output reservation failed".to_owned(),
            };
        };
        output
            .extend_from_slice(&body)
            .expect("reservation matches body length");
        RequestOutcome::Response {
            body: output,
            binary: false,
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl PrimaryComponent for FixedComponent {
    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        Ok(())
    }
}

impl SecondaryComponent for FixedComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

struct RoundTripHost {
    connection_file: PathBuf,
    supervisor: Arc<Supervisor>,
    routes: Arc<Mutex<HashMap<RouteHandle, SessionKey>>>,
    shutdown: CancellationToken,
    join: Option<tokio::task::JoinHandle<Result<(), HostError>>>,
}

impl RoundTripHost {
    /// Starts a host at `data_root` and waits for its publication. The data
    /// root is caller-owned so the restart test can run two incarnations over
    /// one directory and prove Broca state never survives an incarnation
    /// (R11).
    async fn start(backend: Arc<dyn LlmExecutionBackend>, data_root: &Path) -> Self {
        let broca = BrocaComponent::new(backend);
        let supervisor = broca.supervisor();
        let routes = broca.route_index();
        let composite = StaticComposite::new(
            FixedComponent {
                id: "magic-context",
                role: "tool_provider",
            },
            FixedComponent {
                id: "synapse",
                role: "management_surface",
            },
            broca,
        )
        .expect("distinct component ids");

        let mut config = HostConfig {
            data_dir: Some(data_root.to_path_buf()),
            daemon_ver: "mc-host/broca-roundtrip".to_owned(),
            limits: HostLimits {
                // Small but interoperable: one 64 MiB frame must still fit
                // beside the production Broca component's declared retained
                // reservation.
                max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES * 2
                    + mc_host::broca::config::DECLARED_RETAINED_RESIDENT_BYTES,
                ..Default::default()
            },
            ..Default::default()
        };
        config.timing.shutdown_deadline = Duration::from_secs(5);
        config.timing.route_close_budget = Duration::from_secs(2);
        config.timing.lifecycle_callback_deadline = Duration::from_secs(3);

        let publication = data_root
            .join("cortexkit")
            .join("run")
            .join(mc_host::CONNECTION_FILE_NAME);
        let shutdown = CancellationToken::new();
        let run_shutdown = shutdown.clone();
        let join = tokio::spawn(async move { mc_host::run(composite, config, run_shutdown).await });

        // A restart over the same data_dir republished at the same path, so a
        // stale predecessor snapshot must not be mistaken for this host's own.
        let existing = std::fs::read(&publication).ok();
        let deadline = tokio::time::Instant::now() + BUDGET;
        loop {
            if join.is_finished() {
                panic!(
                    "host exited before publishing: {:?}",
                    join.await.expect("run task joins")
                );
            }
            match std::fs::read(&publication) {
                Ok(bytes) if Some(&bytes) != existing.as_ref() => break,
                _ => {}
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "host did not publish in time"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        Self {
            connection_file: publication,
            supervisor,
            routes,
            shutdown,
            join: Some(join),
        }
    }

    async fn shutdown(
        mut self,
    ) -> (
        Arc<Supervisor>,
        Arc<Mutex<HashMap<RouteHandle, SessionKey>>>,
    ) {
        self.shutdown.cancel();
        let join = self.join.take().expect("host runs once");
        tokio::time::timeout(Duration::from_secs(20), join)
            .await
            .expect("host finishes within its shutdown budget")
            .expect("run task joins")
            .expect("graceful shutdown");
        (Arc::clone(&self.supervisor), Arc::clone(&self.routes))
    }
}

impl Drop for RoundTripHost {
    fn drop(&mut self) {
        // A panicking test must not leave a host holding the instance lock.
        self.shutdown.cancel();
    }
}

/// The U6 teardown contract: after host shutdown, zero active runs, backend
/// (subprocess-permit) holds, subscribers, retained bytes, sessions, and
/// route mappings remain.
fn assert_supervisor_drained(
    supervisor: &Supervisor,
    routes: &Arc<Mutex<HashMap<RouteHandle, SessionKey>>>,
) {
    let metrics = supervisor.metrics();
    assert_eq!(metrics.live_runs, 0, "no active runs after shutdown");
    assert_eq!(metrics.sessions, 0, "no retained sessions after shutdown");
    assert_eq!(metrics.tombstones, 0, "no tombstones after shutdown");
    assert_eq!(metrics.free_command_permits, 32);
    assert_eq!(metrics.free_run_slots, 32);
    assert_eq!(metrics.free_subscriber_permits, 64);
    assert_eq!(metrics.free_backend_permits, 8, "all backend permits home");
    assert_eq!(
        metrics.retained_bytes_available, metrics.retained_bytes_capacity,
        "every retained-byte charge released"
    );
    assert!(
        routes.lock().expect("route index mutex").is_empty(),
        "no route mappings after shutdown"
    );
}

async fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Production defaults wait minutes on runs and reconnects; every failure
/// mode this suite exercises must instead surface within the test budget.
fn producer_config(
    connection_file: &Path,
    project_root: &Path,
    harness: &str,
) -> HistorianProducerConfig {
    HistorianProducerConfig {
        handshake_timeout: Duration::from_secs(5),
        request_timeout: BUDGET,
        await_timeout: BUDGET,
        ..HistorianProducerConfig::new(connection_file, project_root, harness)
    }
}

fn store_descriptor(dir: &Path) -> cortexkit_store_types::StorageDescriptor {
    cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context-roundtrip".to_owned(),
        storage_namespace: "mc_cache".to_owned(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    }
}

/// Walks the memories-domain authority to MODULE and binds the route root,
/// mirroring the production drain flow so classify's authority checks see
/// legitimate rows rather than hand-poked state.
fn activate_module_authority(store: &McStore, context: &str, project: &str, route_root: &str) {
    let preparing = store
        .authority_begin_prepare(context, project, "memories")
        .expect("authority prepare");
    let checksum = store
        .authority_seed_checksum(context, project, "memories")
        .expect("authority checksum");
    store
        .authority_verify_prepare(
            context,
            project,
            "memories",
            preparing.generation,
            &checksum,
            &checksum,
        )
        .expect("authority verify");
    let module = store
        .authority_ack_prepare(context, project, "memories", preparing.generation)
        .expect("authority ack");
    assert_eq!(module.state, "MODULE");
    store
        .bind_authority_route(context, project, route_root)
        .expect("authority route bind");
}

fn seed_memory(store: &McStore, project: &str, content: &str) -> (i64, String) {
    let id = store
        .insert_memory(InsertMemoryInput {
            project_path: project,
            route_project_root: None,
            category: "PROJECT_RULES",
            content,
            source_session_id: Some(project),
            source_type: Some("test"),
            importance: Some(50),
            expires_at: None,
            metadata_json: None,
            now_ms: 1,
        })
        .expect("memory inserted");
    let hash = store
        .get_memory_full(id)
        .expect("memory readable")
        .expect("memory present")
        .normalized_hash;
    (id, hash)
}

/// The attribute scan a real consumer would run over the deterministic
/// manifest — the Rust test plays the TypeScript role here (KTD10), so rows
/// are built from the manifest text instead of from the fixture inputs.
fn parse_classify_manifest(text: &str) -> Vec<(i64, i64, String, bool)> {
    let attr = |fragment: &str, name: &str| -> String {
        let key = format!("{name}=\"");
        let start = fragment.find(&key).expect("attribute present") + key.len();
        let end = fragment[start..].find('"').expect("attribute closed") + start;
        fragment[start..end].to_owned()
    };
    text.split("<memory ")
        .skip(1)
        .map(|fragment| {
            (
                attr(fragment, "id").parse().expect("id numeric"),
                attr(fragment, "importance")
                    .parse()
                    .expect("importance numeric"),
                attr(fragment, "scope"),
                attr(fragment, "shareable") == "true",
            )
        })
        .collect()
}

fn response_json(outcome: subc_client_rs::HandlerOutcome) -> Value {
    match outcome {
        subc_client_rs::HandlerOutcome::Response(bytes) => {
            serde_json::from_slice(&bytes).expect("response is JSON")
        }
        other => panic!("expected a response, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Raw authenticated wire client for the scenarios `HistorianProducer` cannot
// express (tool-provider echo, unread concurrent frames). Built on the same
// production `subc-transport` client primitives the producer itself uses, so
// it adds no second framing implementation.
// ---------------------------------------------------------------------------

struct RawWire {
    stream: TcpStream,
    next_corr: u64,
}

impl RawWire {
    async fn connect(connection_path: &Path) -> Self {
        let conn = connection_file::read(connection_path).expect("publication validates");
        let endpoint = conn.endpoints.first().expect("published endpoint");
        let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
            .await
            .expect("loopback connect");
        authenticate_client(&mut stream, &conn, Duration::from_secs(5))
            .await
            .expect("authenticated handshake");
        Self {
            stream,
            next_corr: 0,
        }
    }

    async fn send_request(&mut self, channel: u16, epoch: u32, body: Value) -> u64 {
        self.next_corr += 1;
        let frame = Frame::build(
            FrameType::Request,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            self.next_corr,
            serde_json::to_vec(&body).expect("body serializes"),
        )
        .expect("frame builds");
        write_frame(&mut self.stream, &frame)
            .await
            .expect("frame writes");
        self.next_corr
    }

    /// Reads frames until one matches, discarding everything else — the
    /// discard path is what drains unread stream data during saturation.
    async fn frame_for(&mut self, channel: u16, epoch: u32, corr: u64) -> Frame {
        tokio::time::timeout(BUDGET, async {
            loop {
                let frame = read_frame(&mut self.stream)
                    .await
                    .expect("frame reads")
                    .expect("connection stays open");
                if frame.header.channel == channel
                    && frame.header.epoch == epoch
                    && frame.header.corr == corr
                    && frame.header.ty != FrameType::Ping
                {
                    return frame;
                }
            }
        })
        .await
        .expect("terminal frame within budget")
    }

    async fn route_open(
        &mut self,
        target: RouteTarget,
        project_root: &Path,
        harness: &str,
        session: &str,
    ) -> (u16, u32) {
        let request = ClientControlRequest::RouteOpen {
            target,
            identity: BindIdentity {
                project_root: project_root.to_path_buf(),
                harness: harness.to_owned(),
                session: session.to_owned(),
            },
            consumer_identity: None,
            consumer_capabilities: None,
            admission_facts: None,
        };
        let corr = self
            .send_request(
                0,
                0,
                serde_json::to_value(&request).expect("control encodes"),
            )
            .await;
        let frame = self.frame_for(0, 0, corr).await;
        assert_eq!(frame.header.ty, FrameType::Response, "route.open succeeds");
        let response: ClientControlResponse =
            serde_json::from_slice(&frame.body).expect("control response decodes");
        match response {
            ClientControlResponse::RouteOpen {
                route_channel,
                route_epoch,
            } => (route_channel, route_epoch),
            other => panic!("unexpected control response {other:?}"),
        }
    }
}

fn error_code(frame: &Frame) -> String {
    let body: Value = serde_json::from_slice(&frame.body).expect("error body is JSON");
    body["code"]
        .as_str()
        .expect("error body carries a code")
        .to_owned()
}

// ---------------------------------------------------------------------------
// Historian round trip (harness: opencode).
// ---------------------------------------------------------------------------

/// The authenticated historian round trip: one deterministic run, ordered
/// replay preserved across a redrain, a length-cap unit whose finish metadata
/// survives to `ProducerOutput`, both routes closed, and no retained
/// subscriber (R25, AE15, AE13).
#[tokio::test]
async fn historian_round_trip_preserves_replay_and_releases_routes() {
    let data_root = tempfile::tempdir().expect("temp data root");
    let project = tempfile::tempdir().expect("temp project root");
    let backend = ScriptedBackend::with_behavior(|_request, events, _cancel| {
        Box::pin(async move {
            events.emit(BackendEvent::AssistantText {
                text: "compartment doc ".to_owned(),
                finish_reason: None,
            });
            // A step-level length-class reason with a completed terminal is
            // the AE13 length-cap fixture: truncation must reach producer
            // policy without becoming a provider error.
            events.emit(BackendEvent::AssistantText {
                text: "cut mid-document".to_owned(),
                finish_reason: Some(FinishReason::MaxOutputTokens),
            });
            BackendTerminal::Completed {
                finish_reason: FinishReason::Completed,
            }
        })
    });
    let host = RoundTripHost::start(Arc::clone(&backend) as Arc<_>, data_root.path()).await;
    let routes = Arc::clone(&host.routes);
    let supervisor = Arc::clone(&host.supervisor);

    let mut producer = HistorianProducer::connect(producer_config(
        &host.connection_file,
        project.path(),
        "opencode",
    ))
    .await
    .expect("producer authenticates");
    assert_eq!(
        backend.starts(),
        0,
        "authentication alone must start nothing"
    );

    let handle = producer
        .start(
            "mc-historian:roundtrip",
            "historian system role",
            "summarize this chunk",
            "test/historian-model",
        )
        .await
        .expect("session.send admits one run");
    let output = producer
        .await_output(&handle.run_id)
        .await
        .expect("subscription drains to the terminal");
    assert_eq!(output.text, "compartment doc cut mid-document");
    assert!(
        output.length_capped,
        "the length-class finish reason must survive replay"
    );
    assert_eq!(backend.starts(), 1, "exactly one deterministic run started");

    // Reattach-style redrain from `start`: retained replay is ordered and
    // byte-identical, and it must not start a second backend (R8, R9).
    let redrained = producer
        .redrain_output(&handle.run_id)
        .await
        .expect("redrain replays the retained run");
    assert_eq!(redrained, output);
    assert_eq!(backend.starts(), 1);

    assert_eq!(
        producer
            .status(&handle.run_id)
            .await
            .expect("status settles"),
        RunState::Terminal
    );
    assert_eq!(
        backend.seen()[0].harness,
        "opencode",
        "the route-bound harness reaches the backend"
    );

    producer.close().await.expect("both routes close");
    // Route teardown is asynchronous host-side; the bind-time mappings must
    // still drain to zero once the goodbyes are processed.
    wait_until(
        || routes.lock().expect("route index mutex").is_empty(),
        "both producer routes to close",
    )
    .await;
    assert_eq!(
        supervisor.metrics().free_subscriber_permits,
        64,
        "no retained subscriber after the round trip"
    );

    let (supervisor, routes) = host.shutdown().await;
    assert_supervisor_drained(&supervisor, &routes);
}

// ---------------------------------------------------------------------------
// Classify round trip (harness: pi).
// ---------------------------------------------------------------------------

struct ClassifyRig {
    store: Arc<McStore>,
    handler: McHandler,
    generation: u64,
    _store_dir: tempfile::TempDir,
}

const CLASSIFY_PROJECT: &str = "git:roundtrip";
const CLASSIFY_CONTEXT: &str = "ctx-roundtrip";
const CLASSIFY_CHANNEL: u16 = 7;

/// One module-side classify fixture: a seeded store with MODULE memories
/// authority for `route_root`, and a real `McHandler` whose producer factory
/// points at the live host's connection file.
fn classify_rig(connection: &Path, route_root: &Path) -> ClassifyRig {
    let store_dir = tempfile::tempdir().expect("temp store dir");
    let store = Arc::new(McStore::open(&store_descriptor(store_dir.path())).expect("store opens"));
    let route_root_key = route_root.to_string_lossy().into_owned();
    activate_module_authority(&store, CLASSIFY_CONTEXT, CLASSIFY_PROJECT, &route_root_key);
    let generation = store
        .authority_status(CLASSIFY_CONTEXT, CLASSIFY_PROJECT, "memories")
        .expect("authority readable")
        .expect("authority present")
        .generation;

    let handler = McHandler::new_with_connection_file(Some(connection.to_path_buf()));
    handler.install_store_for_integration(Arc::clone(&store));
    handler.bind_route_for_integration(CLASSIFY_CHANNEL, route_root, "pi", "dreamer-parent");
    ClassifyRig {
        store,
        handler,
        generation,
        _store_dir: store_dir,
    }
}

fn dreamer_request(rig: &ClassifyRig, command_id: &str, items: Value, model_chain: Value) -> Value {
    json!({
        "method": "dreamer.run_task",
        "v": 1,
        "session_id": "dreamer-parent",
        "task": "classify",
        "command_id": command_id,
        "authority_generation": rig.generation,
        "payload": {
            "prompt_body": "<pool/>",
            "items": items,
            "model_chain": model_chain,
            // The live chunk-slice remainder TypeScript now owns (R24); any
            // deterministic completion lands far inside it.
            "timeout_ms": 60_000,
        },
    })
}

/// The authenticated classify round trip under the OTHER harness (`pi`): the
/// explicit TypeScript-owned model order reaches the backend, exactly the
/// seeded IDs are validated and applied, and every attempt session is deleted
/// (R25, AE14, AE15).
#[tokio::test]
async fn classify_round_trip_applies_seeded_ids_and_deletes_attempt_sessions() {
    let data_root = tempfile::tempdir().expect("temp data root");
    let project = tempfile::tempdir().expect("temp project root");

    let store_dir = tempfile::tempdir().expect("temp store dir");
    let store = Arc::new(McStore::open(&store_descriptor(store_dir.path())).expect("store opens"));
    let route_root_key = project.path().to_string_lossy().into_owned();
    activate_module_authority(&store, CLASSIFY_CONTEXT, CLASSIFY_PROJECT, &route_root_key);
    let (rule_id, rule_hash) = seed_memory(&store, CLASSIFY_PROJECT, "always run the linter");
    let (fact_id, fact_hash) = seed_memory(&store, CLASSIFY_PROJECT, "the API speaks JSON");
    let generation = store
        .authority_status(CLASSIFY_CONTEXT, CLASSIFY_PROJECT, "memories")
        .expect("authority readable")
        .expect("authority present")
        .generation;

    let manifest = format!(
        "<classify><memory id=\"{rule_id}\" importance=\"81\" scope=\"project\" shareable=\"true\"/>\
         <memory id=\"{fact_id}\" importance=\"17\" scope=\"universe\" shareable=\"false\"/></classify>"
    );
    let backend = ScriptedBackend::classify_manifest(manifest.clone());
    let host = RoundTripHost::start(Arc::clone(&backend) as Arc<_>, data_root.path()).await;

    let handler = McHandler::new_with_connection_file(Some(host.connection_file.clone()));
    handler.install_store_for_integration(Arc::clone(&store));
    handler.bind_route_for_integration(CLASSIFY_CHANNEL, project.path(), "pi", "dreamer-parent");
    let rig = ClassifyRig {
        store: Arc::clone(&store),
        handler,
        generation,
        _store_dir: store_dir,
    };

    let response = response_json(
        rig.handler
            .dispatch_value_for_integration(
                CLASSIFY_CHANNEL,
                dreamer_request(
                    &rig,
                    "rt-classify",
                    json!([rule_id, fact_id]),
                    json!([
                        "prov-one/classifier-primary",
                        "prov-two/classifier-fallback"
                    ]),
                ),
            )
            .await,
    );
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["manifest_text"], json!(manifest));
    assert_eq!(response["diagnostics"]["attempts"], json!(1));
    assert_eq!(
        response["diagnostics"]["model"],
        json!("prov-one/classifier-primary"),
        "the first usable model of the explicit request chain wins"
    );

    // The backend saw exactly the TypeScript-owned order head, the derived
    // attempt-0 child session, and the route-bound `pi` harness (KTD9-KTD10).
    let seen = backend.seen();
    assert_eq!(seen.len(), 1);
    let child_session = attempt_child_session_id(
        CLASSIFY_PROJECT,
        "dreamer-parent",
        "rt-classify",
        0,
        "prov-one/classifier-primary",
    );
    assert_eq!(seen[0].session, child_session);
    assert_eq!(seen[0].provider, "prov-one");
    assert_eq!(seen[0].model, "classifier-primary");
    assert_eq!(seen[0].harness, "pi");
    assert_eq!(
        response["diagnostics"]["child_session_id"],
        json!(child_session)
    );

    // Play the TypeScript role: rows come from the returned manifest, then
    // apply through the module's own facade surface.
    let rows: Vec<Value> = parse_classify_manifest(
        response["manifest_text"]
            .as_str()
            .expect("manifest is text"),
    )
    .into_iter()
    .map(|(id, importance, scope, shareable)| {
        let hash = if id == rule_id {
            &rule_hash
        } else {
            &fact_hash
        };
        json!({
            "memory_id": id,
            "content_hash_at_prompt": hash,
            "importance": importance,
            "scope": scope,
            "shareable": shareable,
        })
    })
    .collect();
    let applied = response_json(
        rig.handler
            .dispatch_value_for_integration(
                CLASSIFY_CHANNEL,
                json!({
                    "name": "memory.set_classification",
                    "arguments": {
                        "memory_project": CLASSIFY_PROJECT,
                        "context_store_uuid": CLASSIFY_CONTEXT,
                        "authority_generation": rig.generation,
                        "rows": rows,
                    },
                }),
            )
            .await,
    );
    assert_eq!(applied["accepted"], json!([rule_id, fact_id]));
    assert_eq!(applied["rejected"], json!([]));
    let rule = rig
        .store
        .get_memory_full(rule_id)
        .expect("memory readable")
        .expect("memory present");
    assert_eq!(rule.importance, Some(81));
    assert_eq!(rule.scope, "project");
    assert_eq!(rule.shareable, 1);
    let fact = rig
        .store
        .get_memory_full(fact_id)
        .expect("memory readable")
        .expect("memory present");
    assert_eq!(fact.importance, Some(17));
    assert_eq!(fact.scope, "universe");
    assert_eq!(fact.shareable, 0);

    // Attempt-session deletion proof over the wire: the child session is
    // already a tombstone, so a repeated delete is a side-effect-free success
    // (R10, AE7) rather than a purge of anything live.
    let metrics = host.supervisor.metrics();
    assert_eq!(metrics.live_runs, 0, "the attempt run was purged");
    assert_eq!(metrics.tombstones, 1, "delete left its bounded tombstone");
    let mut prober =
        HistorianProducer::connect(producer_config(&host.connection_file, project.path(), "pi"))
            .await
            .expect("prober authenticates");
    prober
        .purge_session(&child_session)
        .await
        .expect("repeated session.delete is idempotent");
    assert_eq!(backend.starts(), 1, "the probe started no new backend");

    let (supervisor, routes) = host.shutdown().await;
    assert_supervisor_drained(&supervisor, &routes);
}

/// A transient first classify model advances to a DISTINCT second attempt
/// session and its retry metadata survives the real wire: typed on the
/// producer error, bounded provider text in the dreamer failure diagnostics
/// (AE13, R18, R22).
#[tokio::test]
async fn transient_first_model_advances_session_and_keeps_retry_metadata() {
    let data_root = tempfile::tempdir().expect("temp data root");
    let project = tempfile::tempdir().expect("temp project root");
    let manifest = "<classify></classify>".to_owned();
    let backend = ScriptedBackend::classify_manifest(manifest.clone());
    let host = RoundTripHost::start(Arc::clone(&backend) as Arc<_>, data_root.path()).await;
    let rig = classify_rig(&host.connection_file, project.path());

    let response = response_json(
        rig.handler
            .dispatch_value_for_integration(
                CLASSIFY_CHANNEL,
                dreamer_request(
                    &rig,
                    "rt-fallback",
                    json!([]),
                    json!(["prov/flaky-classifier", "prov/steady-classifier"]),
                ),
            )
            .await,
    );
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["diagnostics"]["attempts"], json!(2));
    assert_eq!(
        response["diagnostics"]["model"],
        json!("prov/steady-classifier")
    );
    let seen = backend.seen();
    assert_eq!(seen.len(), 2, "one backend run per attempt");
    assert_eq!(
        seen[0].session,
        attempt_child_session_id(
            CLASSIFY_PROJECT,
            "dreamer-parent",
            "rt-fallback",
            0,
            "prov/flaky-classifier"
        )
    );
    assert_eq!(
        seen[1].session,
        attempt_child_session_id(
            CLASSIFY_PROJECT,
            "dreamer-parent",
            "rt-fallback",
            1,
            "prov/steady-classifier"
        )
    );
    assert_ne!(seen[0].session, seen[1].session);

    // Exhausting a transient-only chain keeps the bounded provider message in
    // the dreamer failure diagnostics instead of swallowing it.
    let failure = rig
        .handler
        .dispatch_value_for_integration(
            CLASSIFY_CHANNEL,
            dreamer_request(
                &rig,
                "rt-transient-only",
                json!([]),
                json!(["prov/flaky-classifier"]),
            ),
        )
        .await;
    match failure {
        subc_client_rs::HandlerOutcome::Error { code, message } => {
            assert_eq!(code, "dreamer_run_failed");
            assert!(
                message.contains("provider rate limited"),
                "provider diagnostics must survive: {message}"
            );
        }
        other => panic!("expected dreamer_run_failed, got {other:?}"),
    }

    // The typed retry metadata itself is producer-visible over the same wire:
    // class and retry delay ride the classified error terminal (R18).
    let mut producer =
        HistorianProducer::connect(producer_config(&host.connection_file, project.path(), "pi"))
            .await
            .expect("producer authenticates");
    let handle = producer
        .start("retry-metadata-probe", "", "probe", "prov/flaky-classifier")
        .await
        .expect("send admits the probe run");
    match producer.await_output(&handle.run_id).await {
        Err(HistorianProducerError::RunFailed {
            classification,
            class_field_present,
            detail,
            ..
        }) => {
            assert!(class_field_present);
            let classification = classification.expect("classified terminal");
            assert_eq!(classification.class, ErrorClass::Transient);
            assert_eq!(classification.retry_after_secs, Some(7));
            assert!(detail.contains("provider rate limited"));
        }
        other => panic!("expected a classified run failure, got {other:?}"),
    }
    producer.close().await.expect("probe routes close");

    let (supervisor, routes) = host.shutdown().await;
    assert_supervisor_drained(&supervisor, &routes);
}

// ---------------------------------------------------------------------------
// Host restart: strict missing plus the existing refire transition.
// ---------------------------------------------------------------------------

fn fixed_completion_now_ms() -> i64 {
    2
}

/// Broca run state is process-local (R11, AE8): after a restart over the same
/// data_dir the persisted run ID reports strict `missing`, and the existing
/// durable reattach path turns that into the refire-eligible abandon without
/// any Broca persistence or new backend start.
#[tokio::test]
async fn host_restart_reports_missing_and_reattach_becomes_refire_eligible() {
    let data_root = tempfile::tempdir().expect("temp data root");
    let project = tempfile::tempdir().expect("temp project root");
    let producer_session = "mc-historian:restart".to_owned();

    let first_backend = ScriptedBackend::with_behavior(|_request, events, _cancel| {
        Box::pin(async move {
            events.emit(BackendEvent::AssistantText {
                text: "first incarnation output".to_owned(),
                finish_reason: None,
            });
            BackendTerminal::Completed {
                finish_reason: FinishReason::Completed,
            }
        })
    });
    let host_a = RoundTripHost::start(Arc::clone(&first_backend) as Arc<_>, data_root.path()).await;
    let mut producer = HistorianProducer::connect(producer_config(
        &host_a.connection_file,
        project.path(),
        "opencode",
    ))
    .await
    .expect("producer authenticates");
    let handle = producer
        .start(&producer_session, "", "chunk", "test/historian-model")
        .await
        .expect("send admits the run");
    producer
        .await_output(&handle.run_id)
        .await
        .expect("run completes before the restart");
    producer.close().await.expect("routes close");
    drop(producer);
    host_a.shutdown().await;

    // Fresh incarnation, same data_dir: run identity must not carry over.
    let second_backend = ScriptedBackend::classify_manifest(String::new());
    let host_b =
        RoundTripHost::start(Arc::clone(&second_backend) as Arc<_>, data_root.path()).await;

    let mut prober = HistorianProducer::connect(producer_config(
        &host_b.connection_file,
        project.path(),
        "opencode",
    ))
    .await
    .expect("prober authenticates");
    prober.bind_session(&producer_session);
    match prober.status(&handle.run_id).await.expect("status settles") {
        RunState::Missing { .. } => {}
        other => panic!("a restarted host must report strict missing, got {other:?}"),
    }
    prober.close().await.expect("prober routes close");

    // Seed the durable AwaitingProducer row the crashed process would have
    // left behind, then run the REAL reattach path against the new host.
    let store_dir = tempfile::tempdir().expect("temp store dir");
    let store = McStore::open(&store_descriptor(store_dir.path())).expect("store opens");
    let loaded = store.load("ses").expect("fresh session loads");
    let mut meta = loaded.meta;
    meta.historian = HistorianDurableState {
        state: HistorianPhase::AwaitingProducer,
        firing_seq: 1,
        chunk_range: Some(HistorianChunkRange {
            from_ordinal: 1,
            to_ordinal: 3,
        }),
        chunk_fingerprint: "restart-fp".to_owned(),
        selected_range_identities: Vec::new(),
        producer_session_id: Some(producer_session.clone()),
        producer_run_id: Some(handle.run_id.clone()),
        fired_at_ms: Some(1),
        expected_revert_epoch: 0,
        compartment_set_generation: CompartmentSetGeneration::default(),
        ..HistorianDurableState::default()
    };
    store
        .commit("ses", loaded.row_version, &loaded.core, &meta)
        .expect("seeded state commits");

    let mut reattach_producer = HistorianProducer::connect(producer_config(
        &host_b.connection_file,
        project.path(),
        "opencode",
    ))
    .await
    .expect("reattach producer authenticates");
    let validation_chunk = HistorianChunk {
        start_index: 1,
        end_index: 3,
        lines: Vec::new(),
        present_ordinals: Vec::new(),
        tool_only_ranges: Vec::new(),
        completed_tool_arcs: Vec::new(),
    };
    let boundary_dates = BTreeMap::new();
    let outcome = reattach_historian_producer(
        &mut reattach_producer,
        HistorianReattachRequest {
            store: &store,
            session_id: "ses",
            project_path: "restart-project",
            observed_chunk_fingerprint: "restart-fp",
            validation_chunk: &validation_chunk,
            chunk_transcript: "",
            raw_chunk_messages: "",
            boundary_dates: &boundary_dates,
            prior_compartments: &[],
            validate_options: ValidateOptions::default(),
            publication_floor_ordinal: 0,
            now_ms: 1,
            failure_backoff_at_ms: 60_000,
            completion_now_ms: fixed_completion_now_ms,
            publication_fence: None,
        },
    )
    .await
    .expect("reattach settles");
    assert_eq!(
        outcome,
        HistorianReattachOutcome::RefireEligible { firing_seq: 1 },
        "strict missing must drive the existing abandon/refire transition"
    );
    let reloaded = store.load("ses").expect("seeded session reloads");
    assert_eq!(reloaded.meta.historian.state, HistorianPhase::Idle);
    assert!(
        reloaded.meta.historian.failure_backoff_at_ms.is_some(),
        "abandon must arm the durable backoff that gates the refire"
    );
    assert_eq!(
        second_backend.starts(),
        0,
        "the ledger decides the refire; missing status alone starts nothing (R11)"
    );

    let (supervisor, routes) = host_b.shutdown().await;
    assert_supervisor_drained(&supervisor, &routes);
}

// ---------------------------------------------------------------------------
// Rejected admission: no deterministic backend may ever start.
// ---------------------------------------------------------------------------

/// Length-prefixed auth message, written from the protocol text (§5.2) so the
/// deliberately-failing handshake shares no code with the passing one.
async fn write_auth_message(stream: &mut TcpStream, body: &Value) {
    let bytes = serde_json::to_vec(body).expect("auth message serializes");
    stream
        .write_all(
            &u32::try_from(bytes.len())
                .expect("bounded auth message")
                .to_le_bytes(),
        )
        .await
        .expect("length writes");
    stream.write_all(&bytes).await.expect("auth body writes");
}

async fn read_auth_message(stream: &mut TcpStream) -> Value {
    let mut len_bytes = [0u8; 4];
    stream
        .read_exact(&mut len_bytes)
        .await
        .expect("auth length reads");
    let mut body = vec![0u8; u32::from_le_bytes(len_bytes) as usize];
    stream.read_exact(&mut body).await.expect("auth body reads");
    serde_json::from_slice(&body).expect("auth body is JSON")
}

/// An unauthenticated connection and authenticated binds with an empty root
/// or unsupported harness all fail before admission and start ZERO
/// deterministic backends (R4, AE1).
#[tokio::test]
async fn rejected_connections_and_binds_start_no_backend() {
    let data_root = tempfile::tempdir().expect("temp data root");
    let project = tempfile::tempdir().expect("temp project root");
    let (backend, _gate) = ScriptedBackend::stuck_until_gate();
    let host = RoundTripHost::start(Arc::clone(&backend) as Arc<_>, data_root.path()).await;

    // Unauthenticated: a syntactically valid handshake with a forged client
    // proof (no key knowledge) must be dropped before any route exists.
    let conn = connection_file::read(&host.connection_file).expect("publication validates");
    let endpoint = conn.endpoints.first().expect("published endpoint");
    let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .expect("loopback connect");
    write_auth_message(
        &mut stream,
        &json!({"client_nonce": vec![7u8; 32], "role": "client"}),
    )
    .await;
    let server_message = read_auth_message(&mut stream).await;
    assert!(server_message.get("server_nonce").is_some());
    write_auth_message(&mut stream, &json!({"client_auth": vec![0u8; 32]})).await;
    let mut probe = [0u8; 1];
    let closed = tokio::time::timeout(BUDGET, stream.read(&mut probe))
        .await
        .expect("host reacts to the forged proof");
    assert!(
        matches!(closed, Ok(0) | Err(_)),
        "a forged client proof must close the connection"
    );

    // Authenticated, empty root: rejected at control validation, before any
    // component bind can exist.
    let mut empty_root = HistorianProducer::connect(producer_config(
        &host.connection_file,
        Path::new(""),
        "opencode",
    ))
    .await
    .expect("bearer still authenticates");
    empty_root
        .start("rejected-root", "", "prompt", "test/model")
        .await
        .expect_err("an empty project_root cannot bind");

    // Authenticated, unsupported harness: reaches the Broca bind and is
    // rejected there, untranslated (R4).
    let mut bad_harness = HistorianProducer::connect(producer_config(
        &host.connection_file,
        project.path(),
        "webstorm",
    ))
    .await
    .expect("bearer still authenticates");
    bad_harness
        .start("rejected-harness", "", "prompt", "test/model")
        .await
        .expect_err("an unsupported harness cannot bind");

    assert_eq!(
        backend.starts(),
        0,
        "no rejected connection or bind may start a deterministic backend"
    );
    let (supervisor, routes) = host.shutdown().await;
    assert_supervisor_drained(&supervisor, &routes);
}

// ---------------------------------------------------------------------------
// Reserved-capacity isolation under full Broca saturation.
// ---------------------------------------------------------------------------

/// Exhausted Broca capacity under blocked settlement: the next Broca request
/// is rejected fast while a Magic Context echo still settles on the general
/// class.
#[tokio::test]
async fn saturated_broca_reserves_do_not_block_magic_context_echo() {
    let data_root = tempfile::tempdir().expect("temp data root");
    let project = tempfile::tempdir().expect("temp project root");
    let (backend, gate) = ScriptedBackend::stuck_until_gate();
    let host = RoundTripHost::start(Arc::clone(&backend) as Arc<_>, data_root.path()).await;
    let supervisor = Arc::clone(&host.supervisor);

    let mut wire = RawWire::connect(&host.connection_file).await;
    let (mc_channel, mc_epoch) = wire
        .route_open(
            RouteTarget::ToolProvider {
                module_id: "magic-context".to_owned(),
            },
            project.path(),
            "opencode",
            "echo-session",
        )
        .await;

    // Run 0 is the blocked-cancel target and deliberately gets NO subscribers: `run.cancel` commits the cancellation terminal synchronously before blocking on teardown, which would settle that run's subscribers. commentlint: allow(JUDGE)
    // 62 held subscriptions plus 32 blocked cancels is therefore the real protocol's maximum blocked settlement; the exact 96-permit class boundary is pinned by mc-host's dispatch test with a saturating stub. commentlint: allow(JUDGE)
    let mut broca_routes = Vec::new();
    let mut run_ids = Vec::new();
    for index in 0..32 {
        let session = format!("sat-{index}");
        let route = wire
            .route_open(
                RouteTarget::ManagementSurface {
                    module_id: "broca".to_owned(),
                },
                project.path(),
                "opencode",
                &session,
            )
            .await;
        let corr = wire
            .send_request(
                route.0,
                route.1,
                json!({
                    "method": "session.send",
                    "params": {
                        "prompt": format!("saturation {index}"),
                        "model": {"provider": "test", "model": "gated"},
                        "tools": [],
                        "generation": {"max_output_tokens": 1000, "temperature": 0.1},
                    },
                }),
            )
            .await;
        let frame = wire.frame_for(route.0, route.1, corr).await;
        assert_eq!(frame.header.ty, FrameType::Response);
        let body: Value = serde_json::from_slice(&frame.body).expect("send response is JSON");
        run_ids.push(
            body["run_id"]
                .as_str()
                .expect("send returns run_id")
                .to_owned(),
        );
        broca_routes.push(route);
    }
    // The blocked cancels below target sat-0's run, which must actually hold
    // a backend permit — a queued run's cancel would settle immediately and
    // never pin its command permit. The eight permit holders start
    // concurrently, so the count is awaited rather than asserted: the gate
    // blocks every completion, making eight the settled value.
    wait_until(
        || backend.starts() == 8 && backend.seen().iter().any(|run| run.session == "sat-0"),
        "sat-0 and all eight backend permit holders to start",
    )
    .await;

    // Both subscription positions on every run except the cancel target. commentlint: allow(JUDGE)
    for route in &broca_routes[1..] {
        for _ in 0..2 {
            wire.send_request(
                route.0,
                route.1,
                json!({"method": "session.subscribe", "params": {"from": "start"}}),
            )
            .await;
        }
    }
    wait_until(
        || supervisor.metrics().free_subscriber_permits == 2,
        "all 62 reachable subscriber permits to be held",
    )
    .await;

    // 32 blocked cancels: the backend ignores its cancel token, so each
    // cancel waits on run teardown while holding one command permit.
    for _ in 0..32 {
        wire.send_request(
            broca_routes[0].0,
            broca_routes[0].1,
            json!({"method": "run.cancel", "params": {"run_id": run_ids[0]}}),
        )
        .await;
    }
    wait_until(
        || supervisor.metrics().free_command_permits == 0,
        "all 32 command permits to be held",
    )
    .await;

    // The next Broca request fails fast at its exhausted application cap, never blocking behind the 94 requests stuck in settlement. commentlint: allow(JUDGE)
    let overflow_corr = wire
        .send_request(
            broca_routes[1].0,
            broca_routes[1].1,
            json!({"method": "run.status", "params": {"run_id": run_ids[1]}}),
        )
        .await;
    let overflow = wire
        .frame_for(broca_routes[1].0, broca_routes[1].1, overflow_corr)
        .await;
    assert_eq!(overflow.header.ty, FrameType::Error);
    assert_eq!(error_code(&overflow), "queue_full");

    // The general class is untouched: the echo settles concurrently.
    let echo_corr = wire
        .send_request(mc_channel, mc_epoch, json!({"probe": "echo"}))
        .await;
    let echo = wire.frame_for(mc_channel, mc_epoch, echo_corr).await;
    assert_eq!(echo.header.ty, FrameType::Response);
    let echo_body: Value = serde_json::from_slice(&echo.body).expect("echo body is JSON");
    assert_eq!(echo_body["served_by"], json!("magic-context"));

    // Unblock every gated backend before shutdown so cancels, queued runs,
    // and subscriptions all settle inside the drain budget.
    gate.add_permits(64);
    drop(wire);
    let (supervisor, routes) = host.shutdown().await;
    assert_supervisor_drained(&supervisor, &routes);
}
