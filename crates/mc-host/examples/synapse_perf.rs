//! Hermetic Synapse query/batch load generator.
//!
//! Open-loop work keeps absolute scheduled-send timestamps. Closed-loop work
//! holds fixed concurrency. Every wire call and caller-level operation is
//! retained as NDJSON before the validated summary.

#[path = "../tests/support/perf_measurement.rs"]
mod perf_measurement;
#[path = "../tests/support/process_resources.rs"]
#[allow(dead_code)]
mod process_resources;
#[path = "../tests/support/raw_client.rs"]
mod raw_client;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use mc_host::synapse::inference::InferenceError;
use mc_host::synapse::jobs::BatchItem;
use mc_host::synapse::{
    EmbeddingEngine, LaneInfo, SynapseComponent, SynapseLimits, SYNAPSE_MODULE_ID,
};
use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HostConfig, HostInit,
    InitError, ManifestSnapshot, PrimaryComponent, RequestCtx, RequestOutcome, RouteHandle,
    RouteIdentity, SecondaryComponent, ShutdownError, StaticComposite,
};
use perf_measurement::{
    AttemptDisposition, AttemptRecord, DeterministicRng, LatencySummary, LogicalDisposition,
    LogicalRecord, ServiceSample, SynapseMethod, SynapseVariant, WindowClass,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};

const ROOT: &str = "/workspace/synapse-perf";
const STARTUP_BUDGET: Duration = Duration::from_secs(10);
const DRAIN_BUDGET: Duration = Duration::from_secs(10);
const PACING_SLACK: Duration = Duration::from_millis(2);
const MAX_CENSORED_PER_MILLE: u128 = 10;
const MAX_TOTAL_ATTEMPTS: u32 = 4;
const QUERY_DEADLINE: Duration = Duration::from_secs(3);
const BATCH_DEADLINE: Duration = Duration::from_secs(120);
/// Validity ceiling on any single logical request's pending-poll count.
/// The densest legal schedule polls at the busy-poll floor
/// (`perf_measurement::POLL_MIN_DELAY_MS`) for the entire batch deadline,
/// plus slack for the jittered fast-first poll and cursored page reads. A
/// max above this means the poll policy regressed (for example a delay
/// collapsed to zero) and the repetition's amplification numbers cannot be
/// trusted, so the run is invalidated.
const MAX_POLLS_PER_LOGICAL: u64 =
    BATCH_DEADLINE.as_millis() as u64 / perf_measurement::POLL_MIN_DELAY_MS + 64;
const FINGERPRINT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MODEL: &str = "synapse-perf-tiny";
const QUERY_TEXT: &str = "model-free benchmark query";
/// Shared queued-request byte budget for every cell (see `run`).
const HARNESS_QUEUED_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum BatchShape {
    OneBy16,
    FourBy16Paged,
    OneBy64,
}

impl BatchShape {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "1x16" => Ok(Self::OneBy16),
            "4x16-paged" => Ok(Self::FourBy16Paged),
            "1x64" => Ok(Self::OneBy64),
            _ => Err("batch shape must be one of 1x16, 4x16-paged, 1x64".to_owned()),
        }
    }

    fn item_count(self) -> usize {
        match self {
            Self::OneBy16 => 16,
            Self::FourBy16Paged | Self::OneBy64 => 64,
        }
    }

    fn page_vectors(self) -> usize {
        match self {
            Self::OneBy16 | Self::FourBy16Paged => 16,
            Self::OneBy64 => 64,
        }
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(tag = "kind", content = "shape", rename_all = "snake_case")]
enum Arm {
    Query,
    Batch(BatchShape),
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Load {
    Open { rate: u64 },
    Closed { concurrency: usize },
}

#[derive(Clone, Copy, Debug)]
struct Opts {
    variant: SynapseVariant,
    arm: Arm,
    load: Load,
    seconds: u64,
    engine_delay_ms: u64,
    max_waiting_queries: usize,
    query_retry_after_ms: u64,
    seed: u64,
    transport_floor_ns: u64,
}

fn parse_opts() -> Result<Opts, String> {
    parse_opts_from(std::env::args().skip(1))
}

fn parse_opts_from(args: impl IntoIterator<Item = String>) -> Result<Opts, String> {
    let mut variant = None;
    let mut arm = None;
    let mut batch_shape = None;
    let mut rate = None;
    let mut concurrency = None;
    let mut seconds = 1;
    let mut engine_delay_ms = 0;
    let mut max_waiting_queries = 0;
    let mut query_retry_after_ms = 50;
    let mut seed = 1;
    let mut transport_floor_ns = 0;
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--variant" => variant = Some(SynapseVariant::parse(&value)?),
            "--arm" => arm = Some(value),
            "--batch-shape" => batch_shape = Some(BatchShape::parse(&value)?),
            "--rate" => rate = Some(parse(&value, "rate")?),
            "--concurrency" => concurrency = Some(parse(&value, "concurrency")?),
            "--seconds" => seconds = parse(&value, "seconds")?,
            "--engine-delay-ms" => engine_delay_ms = parse(&value, "engine delay")?,
            "--max-waiting-queries" => max_waiting_queries = parse(&value, "max waiting queries")?,
            "--query-retry-after-ms" => query_retry_after_ms = parse(&value, "query retry after")?,
            "--seed" => seed = parse(&value, "seed")?,
            "--transport-floor-ns" => transport_floor_ns = parse(&value, "transport floor")?,
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    let arm = match (arm.as_deref(), batch_shape) {
        (Some("query"), None) => Arm::Query,
        (Some("query"), Some(_)) => return Err("query arm rejects --batch-shape".to_owned()),
        (Some("batch"), Some(shape)) => Arm::Batch(shape),
        (Some("batch"), None) => return Err("batch arm requires --batch-shape".to_owned()),
        (Some(other), _) => return Err(format!("arm must be query or batch, got {other}")),
        (None, _) => return Err("--arm query|batch is required".to_owned()),
    };
    let variant = variant.ok_or_else(|| "--variant is required".to_owned())?;
    let load = match (rate, concurrency) {
        (Some(rate), None) => {
            perf_measurement::validate_open_loop_rate(rate)?;
            Load::Open { rate }
        }
        (None, Some(concurrency)) if concurrency > 0 => Load::Closed { concurrency },
        (None, Some(_)) => return Err("concurrency must be nonzero".to_owned()),
        (Some(_), Some(_)) => return Err("--rate and --concurrency are contradictory".to_owned()),
        (None, None) => return Err("exactly one of --rate or --concurrency is required".to_owned()),
    };
    if seconds == 0 {
        return Err("seconds must be nonzero".to_owned());
    }
    if query_retry_after_ms == 0 {
        return Err("query retry after must be nonzero".to_owned());
    }
    if variant.needs_waiting_queries() && max_waiting_queries == 0 {
        return Err(format!(
            "variant {} requires --max-waiting-queries greater than zero",
            variant.as_str()
        ));
    }
    if !variant.needs_waiting_queries() && max_waiting_queries != 0 {
        return Err(format!(
            "variant {} requires --max-waiting-queries 0",
            variant.as_str()
        ));
    }
    if requires_build_id(variant) && HOST_BUILD_ID.is_none() {
        return Err(format!(
            "variant {} is defined as pre-change host code, which this binary \
             cannot select at run time: rebuild the harness at the pinned \
             pre-change commit with MC_HOST_PERF_BUILD_ID set, so the emitted \
             evidence names the host it ran against",
            variant.as_str()
        ));
    }
    if let Load::Open { rate, .. } = load {
        rate.checked_mul(seconds)
            .filter(|count| *count > 0)
            .ok_or_else(|| "offered request count is zero or overflows".to_owned())?;
    }
    Ok(Opts {
        variant,
        arm,
        load,
        seconds,
        engine_delay_ms,
        max_waiting_queries,
        query_retry_after_ms,
        seed,
        transport_floor_ns,
    })
}

/// Identity of the build this binary was compiled from, supplied by the
/// collection script as `MC_HOST_PERF_BUILD_ID`.
///
/// Read at compile time, not run time, because the thing it identifies is the
/// artifact: the `--variant` axis selects client retry and poll policy plus
/// admission configuration, and cannot select a different host implementation.
/// A pre-change host is therefore a different binary, and this is the only field
/// in the evidence that distinguishes one from another.
const HOST_BUILD_ID: Option<&str> = option_env!("MC_HOST_PERF_BUILD_ID");

/// Variants whose meaning depends on which host build ran them.
///
/// `baseline` and `hygiene-only` are defined by the contract as pre-change host
/// code, which this binary cannot select at run time. Emitting such a cell from
/// an unidentified build produces evidence that looks like a host comparison but
/// is not one, so the run is refused rather than left for a reader to catch.
fn requires_build_id(variant: SynapseVariant) -> bool {
    matches!(
        variant,
        SynapseVariant::Baseline | SynapseVariant::HygieneOnly
    )
}

fn parse<T: std::str::FromStr>(value: &str, name: &str) -> Result<T, String> {
    value.parse().map_err(|_| format!("invalid {name}"))
}

struct DelayEngine {
    delay: Duration,
    /// Shared with the wire clock so a service sample's start instant is
    /// directly comparable to the hold window's boundaries.
    origin: Instant,
    service: Arc<StdMutex<Vec<ServiceSample>>>,
}

impl EmbeddingEngine for DelayEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        let start = Instant::now();
        std::thread::sleep(self.delay);
        let vectors = texts
            .iter()
            .map(|_| vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
            .collect();
        let elapsed = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
        let started_ns = u64::try_from(start.saturating_duration_since(self.origin).as_nanos())
            .unwrap_or(u64::MAX);
        self.service
            .lock()
            .expect("service samples")
            .push(ServiceSample {
                started_ns,
                service_ns: elapsed,
                // Classified once the hold window's boundaries are known.
                window: WindowClass::Measured,
            });
        Ok(vectors)
    }
}

fn lane() -> LaneInfo {
    LaneInfo {
        model: MODEL.to_owned(),
        fingerprint: FINGERPRINT.to_owned(),
        table_epoch: 1,
        dims: 8,
        max_tokens: 512,
        max_text_bytes: 1024,
        provenance: serde_json::json!({"source": "inline delayed engine"}),
        recommended_rows: 64,
        recommended_token_budget: 8192,
    }
}

struct PerfPrimary;

impl CompositeComponent for PerfPrimary {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "magic-context".to_owned(),
            module_version: env!("CARGO_PKG_VERSION").to_owned(),
            provides: vec![serde_json::json!({"role": "tool_provider"})],
            control_ops: Vec::new(),
        }
    }
    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }
    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        let Ok(mut body) = ctx.reserve_output(ctx.body.len()).await else {
            return RequestOutcome::error("internal_error", "output reservation failed");
        };
        body.extend_from_slice(&ctx.body)
            .expect("reservation matches request length");
        RequestOutcome::Response {
            body,
            binary: ctx.binary,
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

impl PrimaryComponent for PerfPrimary {
    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        Ok(())
    }
}

struct PlaceholderBroca;

impl CompositeComponent for PlaceholderBroca {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "broca".to_owned(),
            module_version: env!("CARGO_PKG_VERSION").to_owned(),
            provides: vec![serde_json::json!({"role": "management_surface"})],
            control_ops: Vec::new(),
        }
    }
    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Reject {
            code: "artifact_invalid".to_owned(),
            message: "broca is unavailable in the perf host".to_owned(),
        }
    }
    async fn handle(&self, _ctx: RequestCtx) -> RequestOutcome {
        RequestOutcome::error("internal_error", "unreachable")
    }
    async fn route_gone(&self, _route: RouteHandle) {}
    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }
    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl SecondaryComponent for PlaceholderBroca {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

struct HostThread {
    shutdown: CancellationToken,
    done: std::sync::mpsc::Receiver<Result<(), String>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl HostThread {
    fn start(component: SynapseComponent, data_dir: std::path::PathBuf) -> Result<Self, String> {
        let composite = StaticComposite::new(PerfPrimary, component, PlaceholderBroca)
            .map_err(|error| format!("compose host: {error}"))?;
        let shutdown = CancellationToken::new();
        let run_shutdown = shutdown.clone();
        let (tx, done) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("host-main".to_owned())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_name("host-runtime")
                    .build()
                    .map_err(|error| format!("host runtime: {error}"))
                    .and_then(|runtime| {
                        runtime
                            .block_on(mc_host::run(
                                composite,
                                HostConfig {
                                    data_dir: Some(data_dir),
                                    daemon_ver: "mc-host/synapse-perf".to_owned(),
                                    ..Default::default()
                                },
                                run_shutdown,
                            ))
                            .map_err(|error| format!("host: {error}"))
                    });
                let _ = tx.send(result);
            })
            .map_err(|error| format!("host thread: {error}"))?;
        Ok(Self {
            shutdown,
            done,
            thread: Some(thread),
        })
    }

    fn check_running(&self) -> Result<(), String> {
        match self.done.try_recv() {
            Ok(result) => result.and_then(|()| Err("host exited before shutdown".to_owned())),
            Err(std::sync::mpsc::TryRecvError::Empty) => Ok(()),
            Err(error) => Err(format!("host completion channel: {error}")),
        }
    }

    fn shutdown(mut self) -> Result<(), String> {
        self.shutdown.cancel();
        let result = self
            .done
            .recv_timeout(DRAIN_BUDGET)
            .map_err(|error| format!("host shutdown wait: {error}"))?;
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "host thread panicked".to_owned())?;
        }
        result
    }
}

struct WireReply {
    frame: raw_client::RawFrame,
    sent_ns: u64,
    received_ns: u64,
}

struct RoutedWire {
    writer: Mutex<WriteHalf<TcpStream>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<(raw_client::RawFrame, u64)>>>,
    /// Correlations whose caller gave up (attempt timeout) but whose
    /// terminal may still arrive. Without this, a late terminal looks
    /// like an unknown correlation, poisons `reader_error`, and kills
    /// every other in-flight call in the repetition.
    ///
    /// Never evicted, only consumed when its late terminal arrives. A cap with
    /// FIFO eviction cannot be sized safely: the harness accepts rates where a
    /// single saturated cell times out more calls than any fixed bound, and
    /// evicting a still-live entry converts an expected late reply into a fatal
    /// unknown correlation that poisons the wire for every unrelated request.
    /// Residency is therefore bounded by the calls that genuinely never receive
    /// a terminal, at one `u64` each.
    ///
    /// Ordering protocol, which both sides must follow so a live
    /// correlation is never absent from both maps at once: the giving-up
    /// caller inserts here *before* removing its `pending` entry, and the
    /// reader checks `pending` *before* checking here.
    tombstones: Mutex<std::collections::BTreeSet<u64>>,
    next_corr: AtomicU64,
    channel: u16,
    epoch: u32,
    origin: Instant,
    reader_error: Mutex<Option<String>>,
    /// Frames whose write completed after the caller's deadline.
    ///
    /// `write_all` is not cancel-safe, so a frame that starts just inside the
    /// deadline is always finished rather than abandoned mid-stream. That work
    /// still reaches the host after the deadline the harness recorded as
    /// expired, which perturbs later load, so it is counted and invalidates the
    /// repetition rather than being silently tolerated.
    overdeadline_writes: AtomicU64,
}

enum WireCallError {
    Timeout {
        sent_ns: u64,
        terminal_ns: u64,
    },
    /// The deadline lapsed before any byte reached the socket, so there is no
    /// send instant and no attempt to record.
    ///
    /// Distinct from [`WireCallError::Timeout`] because reporting a call that
    /// never reached the wire as a timed-out attempt would anchor a logical
    /// request's latency at a send that did not happen and add a phantom row to
    /// the attempt ledger. Carries nothing: with no send there is no interval to
    /// report, and the caller stamps its own terminal instant.
    ExpiredBeforeSend,
    Transport(String),
}

impl RoutedWire {
    async fn connect(publication: &std::path::Path, origin: Instant) -> Result<Arc<Self>, String> {
        let info = raw_client::discover(publication)?;
        let mut client = raw_client::RawClient::connect(&info).await?;
        let (channel, epoch) = client
            .route_open_target(
                "management_surface",
                SYNAPSE_MODULE_ID,
                ROOT,
                "synapse-perf",
                "run",
            )
            .await?;
        let stream = client.into_stream();
        stream
            .set_nodelay(true)
            .map_err(|error| format!("set TCP_NODELAY: {error}"))?;
        let (reader, writer) = tokio::io::split(stream);
        let wire = Arc::new(Self {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            tombstones: Mutex::new(std::collections::BTreeSet::new()),
            next_corr: AtomicU64::new(1_000_000),
            channel,
            epoch,
            origin,
            reader_error: Mutex::new(None),
            overdeadline_writes: AtomicU64::new(0),
        });
        let reader_wire = Arc::clone(&wire);
        tokio::spawn(async move {
            if let Err(error) = read_terminals(reader, Arc::clone(&reader_wire)).await {
                *reader_wire.reader_error.lock().await = Some(error);
                reader_wire.pending.lock().await.clear();
            }
        });
        Ok(wire)
    }

    fn elapsed_ns(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_nanos()).unwrap_or(u64::MAX)
    }

    /// The zero of the wire clock, so a consumer outside the wire can place its
    /// own observations on the same axis as recorded sends and terminals.
    fn origin(&self) -> Instant {
        self.origin
    }

    fn overdeadline_writes(&self) -> u64 {
        self.overdeadline_writes.load(Ordering::Relaxed)
    }

    /// Position of `at` on the same wire clock [`Self::elapsed_ns`] reports,
    /// so a scheduled instant and a recorded send are directly comparable.
    fn ns_at(&self, at: Instant) -> u64 {
        u64::try_from(at.saturating_duration_since(self.origin).as_nanos()).unwrap_or(u64::MAX)
    }

    /// Takes the caller's absolute deadline, not a duration.
    ///
    /// Waiting for the shared writer is time the caller's deadline is spending.
    /// Computing a budget outside this function and arming the timer only after
    /// the write hands every contended call an effective budget larger than its
    /// deadline, and a stalled writer an unbounded one — so attempts could
    /// succeed after their logical deadline, which is exactly the evidence a
    /// tail study cannot afford to get wrong.
    ///
    /// The write itself is deliberately *not* interruptible. `write_all` is not
    /// cancel-safe: dropping it mid-frame leaves a partial request on the shared
    /// connection and desynchronizes framing for every other in-flight logical
    /// request, which no later call can recover from. Instead the wait for the
    /// writer is bounded and the deadline is re-tested while the lock is held,
    /// so an expired call never starts a write; once a frame is started it is
    /// finished.
    async fn call(&self, body: Vec<u8>, deadline: Instant) -> Result<WireReply, WireCallError> {
        if let Some(error) = self.reader_error.lock().await.clone() {
            return Err(WireCallError::Transport(error));
        }
        // The host retires the generation on any non-increasing Request
        // correlation (connection.rs read-loop watermark), so allocation and
        // socket write must be atomic: allocating outside the writer lock
        // lets two tasks write in inverted correlation order under load.
        let (corr, rx, sent_ns) = {
            let Ok(writer) = tokio::time::timeout_at(deadline.into(), self.writer.lock()).await
            else {
                return Err(WireCallError::ExpiredBeforeSend);
            };
            let mut writer = writer;
            // The timer above can lose its own race: the lock may be granted at
            // or after the deadline without the timeout arm being polled first.
            // Re-testing here is what guarantees no frame is written past the
            // deadline.
            if Instant::now() >= deadline {
                return Err(WireCallError::ExpiredBeforeSend);
            }
            let corr = self.next_corr.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = oneshot::channel();
            self.pending.lock().await.insert(corr, tx);
            let sent_ns = self.elapsed_ns();
            let mut frame = raw_client::header(
                u32::try_from(body.len())
                    .map_err(|_| WireCallError::Transport("request too large".to_owned()))?,
                raw_client::TY_REQUEST,
                raw_client::FLAGS_INTERACTIVE,
                self.channel,
                self.epoch,
                corr,
            );
            frame.extend_from_slice(&body);
            if let Err(error) = writer.write_all(&frame).await {
                self.pending.lock().await.remove(&corr);
                return Err(WireCallError::Transport(format!(
                    "send correlation {corr}: {error}"
                )));
            }
            // Socket backpressure can hold this write past the deadline it
            // started inside. Abandoning it is not an option — a partial frame
            // desynchronizes the shared connection for every other in-flight
            // request — so the crossing is recorded instead. The host executes
            // work the harness has already accounted as expired, which perturbs
            // later load, so a repetition that does this is not admissible.
            if Instant::now() >= deadline {
                self.overdeadline_writes.fetch_add(1, Ordering::Relaxed);
            }
            (corr, rx, sent_ns)
        };
        match tokio::time::timeout_at(deadline.into(), rx).await {
            Ok(Ok((frame, received_ns))) => Ok(WireReply {
                frame,
                sent_ns,
                received_ns,
            }),
            Ok(Err(_)) => Err(WireCallError::Transport(
                self.reader_error
                    .lock()
                    .await
                    .clone()
                    .unwrap_or_else(|| "connection closed while awaiting reply".to_owned()),
            )),
            Err(_) => {
                // Install the tombstone *before* dropping the pending entry.
                // The reader looks up `pending` first and only then consults
                // the tombstones, so this order keeps `corr` present in
                // `pending ∪ tombstones` at every instant. Removing from
                // `pending` first opens a window in which a reader running
                // concurrently finds neither, reports an unknown correlation,
                // and poisons the shared connection for every other in-flight
                // logical request over an expected late terminal.
                self.tombstones.lock().await.insert(corr);
                // A terminal that already consumed the sender leaves this
                // tombstone unclaimed. That residue is bounded by the calls
                // that never receive a terminal at all, which is why nothing is
                // evicted: an eviction cannot tell a stale entry from a live
                // one, and getting it wrong poisons the whole wire.
                self.pending.lock().await.remove(&corr);
                // The reader can fail between this call's health check and its
                // `pending` insert, leaving a sender nothing will ever settle.
                // That expires as an ordinary attempt timeout, so without this
                // re-check a disconnected wire is indistinguishable from
                // workload censoring — and if it is the last call of the
                // repetition, nothing else ever observes the stored error.
                if let Some(error) = self.reader_error.lock().await.clone() {
                    return Err(WireCallError::Transport(error));
                }
                Err(WireCallError::Timeout {
                    sent_ns,
                    terminal_ns: self.elapsed_ns(),
                })
            }
        }
    }
}

async fn read_terminals(
    mut reader: ReadHalf<TcpStream>,
    wire: Arc<RoutedWire>,
) -> Result<(), String> {
    loop {
        let mut header = [0u8; raw_client::HEADER_LEN];
        reader
            .read_exact(&mut header)
            .await
            .map_err(|error| format!("frame header: {error}"))?;
        let mut frame = raw_client::decode_header(&header);
        if frame.len > perf_measurement::MAX_BODY_LEN {
            return Err(format!("response body {} exceeds cap", frame.len));
        }
        frame.body.resize(frame.len as usize, 0);
        reader
            .read_exact(&mut frame.body)
            .await
            .map_err(|error| format!("frame body: {error}"))?;
        let received_ns = wire.elapsed_ns();
        if matches!(
            frame.ty,
            raw_client::TY_PING | raw_client::TY_PUSH | raw_client::TY_GOODBYE
        ) {
            if let Some(error) = raw_client::connection_frame_violation(&frame) {
                return Err(error);
            }
            continue;
        }
        if frame.ver != raw_client::WIRE_VERSION
            || frame.channel != wire.channel
            || frame.epoch != wire.epoch
            || frame.flags != raw_client::FLAGS_RESPONSE_TEXT_LAST
        {
            return Err("terminal frame violates route or flag contract".to_owned());
        }
        let sender = wire.pending.lock().await.remove(&frame.corr);
        let Some(sender) = sender else {
            // A terminal for a correlation whose caller already timed out
            // is expected wire traffic, not corruption: consume the
            // tombstone and discard the frame silently.
            if wire.tombstones.lock().await.remove(&frame.corr) {
                continue;
            }
            return Err(format!("terminal for unknown correlation {}", frame.corr));
        };
        let _ = sender.send((frame, received_ns));
    }
}

#[derive(Clone)]
struct RunContext {
    wire: Arc<RoutedWire>,
    attempts: Arc<Mutex<Vec<AttemptRecord>>>,
    next_attempt: Arc<AtomicU64>,
    fatal_errors: Arc<Mutex<Vec<String>>>,
    connection_loss: Arc<AtomicU64>,
    opts: Opts,
}

/// Outcome of a recorded wire call that the caller has to tell apart.
///
/// The timeout arm carries the send timestamp the attempt ledger recorded
/// rather than a sentinel string. A logical request's latency starts at its
/// first wire send, so a first attempt that times out must still supply that
/// instant: substituting the timeout instant reports a terminal timeout as
/// near-zero logical latency, and letting a later retry set the anchor instead
/// omits both the first attempt and the retry delay.
enum CallError {
    Timeout {
        sent_ns: u64,
    },
    /// The deadline was already spent, so nothing reached the wire and no
    /// attempt was recorded. The caller terminates the logical request as timed
    /// out without anchoring a send that never happened.
    Expired,
    /// Transport loss or an unparsable response. The caller cannot act on it.
    Fatal(String),
}

impl RunContext {
    async fn record_call(
        &self,
        logical_id: u64,
        method: SynapseMethod,
        body: Vec<u8>,
        deadline: Instant,
    ) -> Result<(WireReply, serde_json::Value), CallError> {
        // The absolute deadline goes all the way down: `RoutedWire::call` bounds
        // writer acquisition and reply receipt against it, so no part of the
        // call runs on a budget the caller's deadline has already spent.
        let result = self.wire.call(body, deadline).await;
        // Allocated only for a call that reached the wire, so a refused call
        // leaves no gap-filling id behind and, more importantly, no row.
        let next_attempt_id = || self.next_attempt.fetch_add(1, Ordering::Relaxed);
        match result {
            Ok(reply) => {
                let attempt_id = next_attempt_id();
                let json: serde_json::Value = serde_json::from_slice(&reply.frame.body)
                    .map_err(|error| CallError::Fatal(format!("response JSON: {error}")))?;
                let code = json["code"].as_str().map(str::to_owned);
                // Error envelopes carry the hint at the top level; a served
                // batch descriptor and a pending poll reply carry it under
                // `result`. Recording only the former leaves the ledger
                // unable to audit whether the poll schedule honored the cap
                // the host actually served.
                let retry_after_ms = json["retry_after_ms"]
                    .as_u64()
                    .or_else(|| json["result"]["retry_after_ms"].as_u64());
                let is_error = reply.frame.ty == raw_client::TY_ERROR;
                let disposition = if method == SynapseMethod::Result {
                    AttemptDisposition::Poll
                } else if is_error
                    && matches!(code.as_deref(), Some("queue_full" | "module_restarted"))
                {
                    AttemptDisposition::RetryableRejection
                } else if is_error && code.as_deref() == Some("timeout") {
                    AttemptDisposition::Timeout
                } else if is_error {
                    // Any other error terminal is outside the client policy's
                    // vocabulary. The caller turns it into a harness error and
                    // invalidates the repetition, so the retained attempt row
                    // must not claim a successful wire call.
                    AttemptDisposition::Failure
                } else {
                    AttemptDisposition::Success
                };
                self.attempts.lock().await.push(AttemptRecord {
                    logical_id,
                    attempt_id,
                    method,
                    disposition,
                    code,
                    retry_after_ms,
                    actual_send_ns: reply.sent_ns,
                    terminal_ns: reply.received_ns,
                    latency_ns: reply.received_ns.saturating_sub(reply.sent_ns),
                    // Stamped from the owning logical request once the hold
                    // window's boundaries are known.
                    window: WindowClass::Measured,
                });
                Ok((reply, json))
            }
            Err(WireCallError::Timeout {
                sent_ns,
                terminal_ns,
            }) => {
                let attempt_id = next_attempt_id();
                self.attempts.lock().await.push(AttemptRecord {
                    logical_id,
                    attempt_id,
                    method,
                    disposition: if method == SynapseMethod::Result {
                        AttemptDisposition::Poll
                    } else {
                        AttemptDisposition::Timeout
                    },
                    code: Some(perf_measurement::ATTEMPT_TIMEOUT_CODE.to_owned()),
                    retry_after_ms: None,
                    actual_send_ns: sent_ns,
                    terminal_ns,
                    latency_ns: terminal_ns.saturating_sub(sent_ns),
                    window: WindowClass::Measured,
                });
                Err(CallError::Timeout { sent_ns })
            }
            Err(WireCallError::ExpiredBeforeSend) => Err(CallError::Expired),
            Err(WireCallError::Transport(error)) => Err(CallError::Fatal(error)),
        }
    }
}

fn request(method: &str, params: serde_json::Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&serde_json::json!({"method": method, "params": params}))
        .map_err(|error| format!("serialize {method}: {error}"))
}

fn constraints() -> serde_json::Value {
    serde_json::json!({
        "model": MODEL,
        "required_fingerprint": FINGERPRINT,
        "required_epoch": 1,
        "allow_equivalent": false,
        "accept_declared": false
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "arguments are the complete immutable logical-ledger row"
)]
fn terminal_record(
    logical_id: u64,
    scheduled_start_ns: Option<u64>,
    first_send_ns: u64,
    terminal_ns: u64,
    disposition: LogicalDisposition,
    code: Option<String>,
    attempts: u64,
    polls: u64,
) -> LogicalRecord {
    LogicalRecord {
        logical_id,
        scheduled_start_ns,
        actual_first_send_ns: first_send_ns,
        terminal_ns,
        latency_ns: terminal_ns.saturating_sub(scheduled_start_ns.unwrap_or(first_send_ns)),
        disposition,
        terminal_code: code,
        attempts,
        polls,
        // Stamped once the hold window's boundaries are known.
        window: WindowClass::Measured,
    }
}

/// True when a harness error is a lost shared wire rather than a harness
/// defect: reader-loop frame failures (early EOF), send failures on the
/// write half, and callers that observed the reader's stored error. The
/// harness's single connection cannot reconnect mid-run, so these remain
/// fatal, but the summary counts them separately from real harness bugs.
fn is_connection_loss(error: &str) -> bool {
    error.contains("frame header: ")
        || error.contains("frame body: ")
        || error.contains("send correlation ")
        || error.contains("connection closed while awaiting reply")
        || error.to_ascii_lowercase().contains("broken pipe")
}

async fn execute_query(
    ctx: &RunContext,
    logical_id: u64,
    scheduled_start_ns: Option<u64>,
) -> Result<LogicalRecord, String> {
    let deadline = Instant::now() + QUERY_DEADLINE;
    let mut rng = DeterministicRng::new(ctx.opts.seed ^ logical_id);
    let mut first_send = None;
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        let mut params = constraints();
        params["text"] = QUERY_TEXT.into();
        // Mirrors the plugin's pre-attempt guard: a remaining budget under
        // one millisecond truncates to the out-of-contract `deadline_ms: 0`
        // (`parse_query` rejects zero), so it is an exhausted deadline, not
        // a sendable attempt.
        let remaining_ms = u64::try_from(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .unwrap_or(u64::MAX);
        if remaining_ms == 0 {
            let now = ctx.wire.elapsed_ns();
            return Ok(terminal_record(
                logical_id,
                scheduled_start_ns,
                first_send.unwrap_or(now),
                now,
                LogicalDisposition::TimedOut,
                Some("timeout".to_owned()),
                u64::from(attempts.saturating_sub(1)),
                0,
            ));
        }
        params["deadline_ms"] = remaining_ms.into();
        let (reply, json) = match ctx
            .record_call(
                logical_id,
                SynapseMethod::Query,
                request("embed.query", params)?,
                deadline,
            )
            .await
        {
            Ok(value) => value,
            Err(CallError::Timeout { sent_ns }) => {
                // The attempt reached the wire, so it anchors this request's
                // latency whether or not a retry follows.
                first_send.get_or_insert(sent_ns);
                let may_retry = ctx
                    .opts
                    .variant
                    .query_attempt_limit()
                    .is_none_or(|limit| attempts < limit);
                if may_retry {
                    let delay = Duration::from_secs_f64(
                        ctx.opts.variant.query_retry_delay_ms(None, &mut rng) / 1_000.0,
                    );
                    if Instant::now() + delay < deadline {
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                }
                let now = ctx.wire.elapsed_ns();
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.expect("the timed-out attempt recorded its send"),
                    now,
                    LogicalDisposition::TimedOut,
                    Some(perf_measurement::ATTEMPT_TIMEOUT_CODE.to_owned()),
                    u64::from(attempts),
                    0,
                ));
            }
            // Nothing reached the wire, so no send to anchor and no attempt to
            // count: the same terminal the pre-attempt guard above produces.
            Err(CallError::Expired) => {
                let now = ctx.wire.elapsed_ns();
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.unwrap_or(now),
                    now,
                    LogicalDisposition::TimedOut,
                    Some("timeout".to_owned()),
                    u64::from(attempts.saturating_sub(1)),
                    0,
                ));
            }
            Err(CallError::Fatal(error)) => return Err(error),
        };
        first_send.get_or_insert(reply.sent_ns);
        if reply.frame.ty == raw_client::TY_RESPONSE {
            validate_vectors(&json, 1)?;
            return Ok(terminal_record(
                logical_id,
                scheduled_start_ns,
                first_send.expect("set above"),
                reply.received_ns,
                LogicalDisposition::Completed,
                None,
                u64::from(attempts),
                0,
            ));
        }
        let code = json["code"].as_str().unwrap_or("unparsable");
        if code == "timeout" {
            return Ok(terminal_record(
                logical_id,
                scheduled_start_ns,
                first_send.expect("set above"),
                reply.received_ns,
                LogicalDisposition::TimedOut,
                Some(code.to_owned()),
                u64::from(attempts),
                0,
            ));
        }
        if code != "queue_full" {
            return Err(format!("unexpected embed.query error: {json}"));
        }
        if ctx
            .opts
            .variant
            .query_attempt_limit()
            .is_some_and(|limit| attempts >= limit)
        {
            return Ok(terminal_record(
                logical_id,
                scheduled_start_ns,
                first_send.expect("set above"),
                reply.received_ns,
                LogicalDisposition::Rejected,
                Some(code.to_owned()),
                u64::from(attempts),
                0,
            ));
        }
        let delay = Duration::from_secs_f64(
            ctx.opts
                .variant
                .query_retry_delay_ms(json["retry_after_ms"].as_u64(), &mut rng)
                / 1_000.0,
        );
        if Instant::now() + delay >= deadline {
            return Ok(terminal_record(
                logical_id,
                scheduled_start_ns,
                first_send.expect("set above"),
                reply.received_ns,
                LogicalDisposition::Rejected,
                Some(code.to_owned()),
                u64::from(attempts),
                0,
            ));
        }
        tokio::time::sleep(delay).await;
    }
}

fn batch_items(logical_id: u64, shape: BatchShape) -> Vec<BatchItem> {
    (0..shape.item_count())
        .map(|index| {
            let text = format!("batch {logical_id} item {index}");
            BatchItem {
                id: format!("{logical_id}:{index}"),
                content_sha256: perf_measurement::sha256_hex(text.as_bytes()),
                text,
            }
        })
        .collect()
}

async fn execute_batch(
    ctx: &RunContext,
    logical_id: u64,
    scheduled_start_ns: Option<u64>,
    shape: BatchShape,
) -> Result<LogicalRecord, String> {
    let deadline = Instant::now() + BATCH_DEADLINE;
    let items = batch_items(logical_id, shape);
    let request_key = mc_host::synapse::protocol::canonical_request_key(&lane(), &items);
    let mut params = constraints();
    params["request_key"] = request_key.clone().into();
    params["items"] = items
        .iter()
        .map(|item| {
            serde_json::json!({
                "id": item.id,
                "text": item.text,
                "content_sha256": item.content_sha256
            })
        })
        .collect::<Vec<_>>()
        .into();
    let body = request("embed.batch", params)?;
    // Served pages are checked against the request's own item identities, so
    // the lookup is built once per logical request rather than per page.
    let expected_items: std::collections::BTreeMap<&str, &str> = items
        .iter()
        .map(|item| (item.id.as_str(), item.content_sha256.as_str()))
        .collect();
    let mut rng = DeterministicRng::new(ctx.opts.seed ^ logical_id.rotate_left(17));
    let mut first_send = None;
    let mut batch_attempts = 0u64;
    let mut polls = 0u64;
    // One-resubmission budget for `module_restarted`, mirroring the plugin
    // policy (embedding-synapse.ts): a host restart evicts every in-flight
    // job, the first `module_restarted` on a logical request resubmits the
    // batch once, and a second is terminal for that logical request.
    let mut restart_used = false;
    // The outer loop reruns submit-then-poll when a host restart evicts the
    // job: the resubmitted batch keeps the same logical request, deadline,
    // and accumulating attempt/poll counters. Submit retries are gated on a
    // per-submission counter that resets on each resubmission, mirroring the
    // plugin's fresh callWithRetry budget per submission; `batch_attempts`
    // stays cumulative because it feeds the attempt ledger.
    'logical: loop {
        let mut submit_attempts = 0u32;
        let (job_id, served_poll_cap) = loop {
            // Mirrors the query loop's pre-attempt guard above and the plugin's
            // per-attempt remaining-budget check. Testing the deadline before a
            // retry sleep is not sufficient: the timer can wake after it under
            // saturation, and `record_call` would then hand `RoutedWire::call` a
            // zero budget, which writes its frame before timing out the
            // receiver. The harness would put a post-deadline submission on the
            // wire and record the attempt it created.
            if Instant::now() >= deadline {
                let now = ctx.wire.elapsed_ns();
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.unwrap_or(now),
                    now,
                    LogicalDisposition::TimedOut,
                    Some("timeout".to_owned()),
                    batch_attempts + polls,
                    polls,
                ));
            }
            batch_attempts += 1;
            submit_attempts += 1;
            let (reply, json) = match ctx
                .record_call(logical_id, SynapseMethod::Batch, body.clone(), deadline)
                .await
            {
                Ok(value) => value,
                Err(CallError::Timeout { sent_ns }) => {
                    // The submission reached the wire, so it anchors this
                    // request's latency even when a resubmission follows.
                    first_send.get_or_insert(sent_ns);
                    if submit_attempts < MAX_TOTAL_ATTEMPTS {
                        let delay = Duration::from_secs_f64(rng.retry_delay_ms(100) / 1_000.0);
                        if Instant::now() + delay < deadline {
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                    }
                    let now = ctx.wire.elapsed_ns();
                    return Ok(terminal_record(
                        logical_id,
                        scheduled_start_ns,
                        first_send.expect("the timed-out submission recorded its send"),
                        now,
                        LogicalDisposition::TimedOut,
                        Some(perf_measurement::ATTEMPT_TIMEOUT_CODE.to_owned()),
                        batch_attempts + polls,
                        polls,
                    ));
                }
                Err(CallError::Expired) => {
                    let now = ctx.wire.elapsed_ns();
                    return Ok(terminal_record(
                        logical_id,
                        scheduled_start_ns,
                        first_send.unwrap_or(now),
                        now,
                        LogicalDisposition::TimedOut,
                        Some("timeout".to_owned()),
                        batch_attempts.saturating_sub(1) + polls,
                        polls,
                    ));
                }
                Err(CallError::Fatal(error)) => return Err(error),
            };
            first_send.get_or_insert(reply.sent_ns);
            if reply.frame.ty == raw_client::TY_RESPONSE {
                let result = &json["result"];
                let job_id = result["job_id"]
                    .as_str()
                    .ok_or_else(|| format!("batch descriptor omitted job_id: {json}"))?
                    .to_owned();
                break (job_id, result["retry_after_ms"].as_u64().unwrap_or(50));
            }
            let code = json["code"].as_str().unwrap_or("unparsable");
            if code == "module_restarted" {
                if !std::mem::replace(&mut restart_used, true) {
                    // A resubmission is a new submission: restart the outer
                    // loop so the per-submission retry budget resets.
                    continue 'logical;
                }
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.expect("set above"),
                    reply.received_ns,
                    LogicalDisposition::Rejected,
                    Some(code.to_owned()),
                    batch_attempts + polls,
                    polls,
                ));
            }
            if code != "queue_full" {
                return Err(format!("unexpected embed.batch error: {json}"));
            }
            // Mirrors the plugin's split budgets: `queue_full` is a
            // deadline-bounded wait with the shared safety cap, while other
            // transients keep the four-attempt budget.
            if submit_attempts >= perf_measurement::QUEUE_FULL_MAX_ATTEMPTS {
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.expect("set above"),
                    reply.received_ns,
                    LogicalDisposition::Rejected,
                    Some(code.to_owned()),
                    batch_attempts + polls,
                    polls,
                ));
            }
            let base = json["retry_after_ms"].as_u64().unwrap_or(100);
            let delay = Duration::from_secs_f64(rng.retry_delay_ms(base) / 1_000.0);
            if Instant::now() + delay >= deadline {
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.expect("set above"),
                    reply.received_ns,
                    LogicalDisposition::Rejected,
                    Some(code.to_owned()),
                    batch_attempts + polls,
                    polls,
                ));
            }
            tokio::time::sleep(delay).await;
        };

        let mut cursor = serde_json::Value::Null;
        let mut collected = Vec::with_capacity(items.len());
        // The first `embed.result` goes out immediately in every arm,
        // mirroring the plugin; fast arms seed the pending ladder with the
        // jittered fast-first delay, consumed by the first pending reply.
        let mut poll_ladder_ms = ctx
            .opts
            .variant
            .initial_pending_delay_ms(&mut rng)
            .unwrap_or(0.0);
        loop {
            let mut poll_attempt = 0u32;
            let (reply, json) = loop {
                // Same pre-send guard as the submission loop: a late-waking
                // poll or pending-ladder timer must not turn into a
                // zero-budget `embed.result` that still reaches the wire.
                if Instant::now() >= deadline {
                    let now = ctx.wire.elapsed_ns();
                    return Ok(terminal_record(
                        logical_id,
                        scheduled_start_ns,
                        first_send.unwrap_or(now),
                        now,
                        LogicalDisposition::TimedOut,
                        Some("timeout".to_owned()),
                        batch_attempts + polls,
                        polls,
                    ));
                }
                let mut poll = constraints();
                poll["job_id"] = job_id.clone().into();
                poll["request_key"] = request_key.clone().into();
                poll["cursor"] = cursor.clone();
                let result = ctx
                    .record_call(
                        logical_id,
                        SynapseMethod::Result,
                        request("embed.result", poll)?,
                        deadline,
                    )
                    .await;
                polls += 1;
                poll_attempt += 1;
                match result {
                    Ok((reply, json)) => {
                        let code = json["code"].as_str();
                        let retryable = reply.frame.ty == raw_client::TY_ERROR
                            && matches!(code, Some("queue_full" | "timeout"));
                        // Mirrors the plugin's split budgets: `queue_full`
                        // waits for a slot under the shared deadline-bounded
                        // cap; other transients keep four attempts.
                        let attempt_cap = if code == Some("queue_full") {
                            perf_measurement::QUEUE_FULL_MAX_ATTEMPTS
                        } else {
                            MAX_TOTAL_ATTEMPTS
                        };
                        if !retryable || poll_attempt >= attempt_cap {
                            break (reply, json);
                        }
                        let base = json["retry_after_ms"].as_u64().unwrap_or(100);
                        let delay = Duration::from_secs_f64(rng.retry_delay_ms(base) / 1_000.0);
                        if Instant::now() + delay >= deadline {
                            break (reply, json);
                        }
                        tokio::time::sleep(delay).await;
                    }
                    Err(CallError::Timeout { .. }) => {
                        // `first_send` is already anchored by the submission
                        // that produced this job, so the poll's own send adds
                        // nothing to the logical latency window.
                        if poll_attempt < MAX_TOTAL_ATTEMPTS {
                            let delay = Duration::from_secs_f64(rng.retry_delay_ms(100) / 1_000.0);
                            if Instant::now() + delay < deadline {
                                tokio::time::sleep(delay).await;
                                continue;
                            }
                        }
                        let now = ctx.wire.elapsed_ns();
                        return Ok(terminal_record(
                            logical_id,
                            scheduled_start_ns,
                            first_send.expect("batch sent"),
                            now,
                            LogicalDisposition::TimedOut,
                            Some(perf_measurement::ATTEMPT_TIMEOUT_CODE.to_owned()),
                            batch_attempts + polls,
                            polls,
                        ));
                    }
                    Err(CallError::Expired) => {
                        let now = ctx.wire.elapsed_ns();
                        let polls = polls.saturating_sub(1);
                        return Ok(terminal_record(
                            logical_id,
                            scheduled_start_ns,
                            first_send.expect("batch sent"),
                            now,
                            LogicalDisposition::TimedOut,
                            Some("timeout".to_owned()),
                            batch_attempts + polls,
                            polls,
                        ));
                    }
                    Err(CallError::Fatal(error)) => return Err(error),
                }
            };
            if reply.frame.ty == raw_client::TY_ERROR {
                let code = json["code"].as_str().unwrap_or("unparsable");
                if code == "module_restarted" {
                    if !std::mem::replace(&mut restart_used, true) {
                        continue 'logical;
                    }
                    return Ok(terminal_record(
                        logical_id,
                        scheduled_start_ns,
                        first_send.expect("batch sent"),
                        reply.received_ns,
                        LogicalDisposition::Rejected,
                        Some(code.to_owned()),
                        batch_attempts + polls,
                        polls,
                    ));
                }
                let disposition = if code == "timeout" {
                    LogicalDisposition::TimedOut
                } else if code == "queue_full" {
                    LogicalDisposition::Rejected
                } else {
                    return Err(format!("unexpected embed.result error {code}: {json}"));
                };
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.expect("batch sent"),
                    reply.received_ns,
                    disposition,
                    Some(code.to_owned()),
                    batch_attempts + polls,
                    polls,
                ));
            }
            let result = &json["result"];
            if let Some(vectors) = result["vectors"].as_array() {
                validate_batch_page(&json, &expected_items)?;
                for vector in vectors {
                    collected.push(
                        vector["id"]
                            .as_str()
                            .ok_or_else(|| format!("vector omitted id: {json}"))?
                            .to_owned(),
                    );
                }
                if result["done"] == true {
                    let expected: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
                    if collected != expected {
                        return Err(
                            "batch result did not preserve every item exactly once".to_owned()
                        );
                    }
                    return Ok(terminal_record(
                        logical_id,
                        scheduled_start_ns,
                        first_send.expect("batch sent"),
                        reply.received_ns,
                        LogicalDisposition::Completed,
                        None,
                        batch_attempts + polls,
                        polls,
                    ));
                }
                cursor = result["next_cursor"].clone();
                if !cursor.is_string() {
                    return Err(format!("non-final page omitted cursor: {json}"));
                }
                // Paged fetches carry no pending delay, so this is the only
                // place the page loop can observe an exhausted deadline. The
                // pending path below clamps its sleep and stops here for the
                // same reason: `record_call` would otherwise enter with a zero
                // budget and `RoutedWire::call` writes before its receiver
                // expires, emitting and recording a post-deadline poll that
                // inflates amplification and host load in slow cells.
                if Instant::now() >= deadline {
                    let now = ctx.wire.elapsed_ns();
                    return Ok(terminal_record(
                        logical_id,
                        scheduled_start_ns,
                        first_send.expect("batch sent"),
                        now,
                        LogicalDisposition::TimedOut,
                        Some("timeout".to_owned()),
                        batch_attempts + polls,
                        polls,
                    ));
                }
                continue;
            }
            let served_delay = result["retry_after_ms"].as_u64().unwrap_or(served_poll_cap);
            let delay_ms = ctx
                .opts
                .variant
                .pending_poll_delay_ms(&mut poll_ladder_ms, served_delay);
            // Mirrors the plugin's `pendingPollDelay`, which clamps every
            // pending wait to the remaining budget. An unclamped sleep
            // crosses the logical deadline, and the next iteration still
            // enters `record_call`: `RoutedWire::call` writes the request
            // before its zero-budget receiver expires, so the harness both
            // sends and records a post-deadline poll. That inflates poll
            // amplification and host load in precisely the slow cells this
            // benchmark is measuring.
            let remaining = deadline.saturating_duration_since(Instant::now());
            tokio::time::sleep(Duration::from_secs_f64(delay_ms / 1_000.0).min(remaining)).await;
            if Instant::now() >= deadline {
                let now = ctx.wire.elapsed_ns();
                return Ok(terminal_record(
                    logical_id,
                    scheduled_start_ns,
                    first_send.expect("batch sent"),
                    now,
                    LogicalDisposition::TimedOut,
                    Some("timeout".to_owned()),
                    batch_attempts + polls,
                    polls,
                ));
            }
        }
    }
}

fn validate_vectors(json: &serde_json::Value, expected: usize) -> Result<(), String> {
    let result = &json["result"];
    let vectors = result["vectors"]
        .as_array()
        .ok_or_else(|| format!("response omitted vectors: {json}"))?;
    if result["done"] != true
        || result["model"] != MODEL
        || result["fingerprint"] != FINGERPRINT
        || result["table_epoch"] != 1
        || result["dims"] != 8
        || vectors.len() != expected
        || vectors.iter().any(|item| {
            item["vector"]
                .as_array()
                .is_none_or(|vector| vector.len() != 8 || vector[0].as_f64() != Some(1.0))
        })
    {
        return Err(format!("invalid vector response: {json}"));
    }
    Ok(())
}

/// Validates one `embed.result` page's lane identity and vector payload.
///
/// The query arm gates every reply through [`validate_vectors`]. Without the
/// same gate on the batch arm, a host or engine regression that returns the
/// expected item ids alongside corrupted vectors, a mismatched content hash,
/// or the wrong lane identity still reaches `LogicalDisposition::Completed`
/// and contributes to the completed rate and the latency summaries. `done` is
/// not checked here because it is a paging state, not a payload property: the
/// caller distinguishes a final page from a continuation.
fn validate_batch_page(
    json: &serde_json::Value,
    expected: &std::collections::BTreeMap<&str, &str>,
) -> Result<(), String> {
    let result = &json["result"];
    if result["model"] != MODEL
        || result["fingerprint"] != FINGERPRINT
        || result["table_epoch"] != 1
        || result["dims"] != 8
    {
        return Err(format!(
            "batch page carries the wrong lane identity: {json}"
        ));
    }
    let vectors = result["vectors"]
        .as_array()
        .ok_or_else(|| format!("batch page omitted vectors: {json}"))?;
    for item in vectors {
        let id = item["id"]
            .as_str()
            .ok_or_else(|| format!("vector omitted id: {json}"))?;
        let served_sha = item["content_sha256"]
            .as_str()
            .ok_or_else(|| format!("vector {id} omitted content_sha256: {json}"))?;
        match expected.get(id) {
            // An unrequested id is caught here rather than by the exactly-once
            // comparison, which only sees the collected order.
            None => return Err(format!("batch page returned unrequested id {id}: {json}")),
            Some(want) if *want != served_sha => {
                return Err(format!(
                    "vector {id} content_sha256 does not match its request"
                ));
            }
            Some(_) => {}
        }
        // The engine serves one golden vector for every text, so a payload
        // that drifts from it is a regression rather than input variation.
        let vector = item["vector"]
            .as_array()
            .ok_or_else(|| format!("vector {id} omitted its payload: {json}"))?;
        if vector.len() != 8 || vector[0].as_f64() != Some(1.0) {
            return Err(format!(
                "vector {id} payload is not the golden vector: {json}"
            ));
        }
        // A JSON non-finite arrives as a non-number, so a component that is
        // neither integral nor floating point never reaches the ledger.
        if vector.iter().any(|value| value.as_f64().is_none()) {
            return Err(format!(
                "vector {id} carries a non-finite component: {json}"
            ));
        }
    }
    Ok(())
}

async fn execute(
    ctx: &RunContext,
    logical_id: u64,
    scheduled_start_ns: Option<u64>,
) -> LogicalRecord {
    let result = match ctx.opts.arm {
        Arm::Query => execute_query(ctx, logical_id, scheduled_start_ns).await,
        Arm::Batch(shape) => execute_batch(ctx, logical_id, scheduled_start_ns, shape).await,
    };
    match result {
        Ok(record) => record,
        Err(error) => {
            if is_connection_loss(&error) {
                ctx.connection_loss.fetch_add(1, Ordering::Relaxed);
            }
            ctx.fatal_errors
                .lock()
                .await
                .push(format!("logical {logical_id}: {error}"));
            let now = ctx.wire.elapsed_ns();
            let owned = ctx
                .attempts
                .lock()
                .await
                .iter()
                .filter(|attempt| attempt.logical_id == logical_id)
                .count() as u64;
            terminal_record(
                logical_id,
                scheduled_start_ns,
                now,
                now,
                LogicalDisposition::InFlight,
                Some("harness_error".to_owned()),
                owned,
                0,
            )
        }
    }
}

async fn warm(ctx: &RunContext) -> Result<(), String> {
    let record = execute(ctx, 0, None).await;
    if record.disposition != LogicalDisposition::Completed {
        return Err(format!("warmup did not complete: {record:?}"));
    }
    ctx.attempts.lock().await.clear();
    ctx.fatal_errors.lock().await.clear();
    ctx.connection_loss.store(0, Ordering::Relaxed);
    Ok(())
}

/// One repetition's load-generation result.
///
/// Grouped rather than returned as a widening tuple because every field is
/// derived from the same generator run and the window is what makes the other
/// two interpretable.
struct LoadOutcome {
    records: Vec<LogicalRecord>,
    send_lag_max_ns: u64,
    missed_slots: u64,
    window: perf_measurement::HoldWindow,
    /// `None` when a boundary observation failed; the reason is recorded in the
    /// run's fatal errors, which already invalidate the repetition.
    task_window: Option<TaskWindow>,
}

/// Task counter evidence for one repetition's measured window.
///
/// The deltas and the span they cover travel together: a delta whose interval
/// is unknown cannot support the resource-shift claim, so they are one value
/// rather than two independently-optional fields that could disagree.
struct TaskWindow {
    deltas: Vec<process_resources::TaskDelta>,
    /// The instants the two observations actually landed on. A saturated
    /// harness can overshoot a boundary, so the covered span is reported rather
    /// than assumed to equal the frozen boundaries exactly.
    observed_start_ns: u64,
    observed_end_ns: u64,
}

/// Observes the process task counters at the measured window's own boundaries.
///
/// Snapshots taken around the whole generate-and-drain interval would charge
/// the discarded warmup prefix and any post-window drain to the comparison,
/// and an overloaded cell drains for longer than its control — so the extra
/// accounting time is itself correlated with the treatment. Sampling at
/// `warmup_end` and `end` keeps the CPU and context-switch deltas on the same
/// span as every other estimate.
///
/// Returns the deltas and the instants the observations landed on. A failed
/// observation yields the error text instead: the counters are evidence for
/// the resource-shift claim, so a missing sample must invalidate that claim
/// rather than silently degrade to a wider span.
async fn observe_task_window(
    origin: Instant,
    warmup_end: Instant,
    end: Instant,
) -> Result<TaskWindow, String> {
    let pid = std::process::id();
    let ns_since = |at: Instant| -> u64 {
        u64::try_from(at.saturating_duration_since(origin).as_nanos()).unwrap_or(u64::MAX)
    };
    tokio::time::sleep_until(warmup_end.into()).await;
    let observed_start = Instant::now();
    let before = process_resources::observe_tasks(pid)
        .map_err(|error| format!("task counters at the warmup boundary: {error}"))?;
    tokio::time::sleep_until(end.into()).await;
    let observed_end = Instant::now();
    let after = process_resources::observe_tasks(pid)
        .map_err(|error| format!("task counters at the window end: {error}"))?;
    Ok(TaskWindow {
        deltas: process_resources::task_deltas(&before, &after),
        observed_start_ns: ns_since(observed_start),
        observed_end_ns: ns_since(observed_end),
    })
}

/// Open-loop validity gate measured at the wire rather than at the pacer.
///
/// The pacer's wake-up delay is only part of a slot's lateness: once the pacer
/// spawns the request, the task can still wait on the runtime's queue or the
/// shared writer before its first byte reaches the socket. Sampling the lag
/// before the spawn therefore lets a saturated, no-longer-open-loop repetition
/// pass with zero missed slots and silently corrupt the tail comparison. A slot
/// is missed when its recorded first send lands a full slot gap or more after
/// its intended start.
fn open_loop_send_lag(records: &[LogicalRecord], rate: u64) -> (u64, u64) {
    let mut send_lag_max_ns = 0;
    let mut missed_slots = 0;
    for record in records {
        let Some(scheduled_ns) = record.scheduled_start_ns else {
            continue;
        };
        let lag_ns = record.actual_first_send_ns.saturating_sub(scheduled_ns);
        send_lag_max_ns = send_lag_max_ns.max(lag_ns);
        let slot = record.logical_id.saturating_sub(1);
        let slot_gap_ns = perf_measurement::open_loop_offset_ns(slot + 1, rate)
            .saturating_sub(perf_measurement::open_loop_offset_ns(slot, rate));
        if slot_gap_ns != 0 && lag_ns >= slot_gap_ns {
            missed_slots += 1;
        }
    }
    (send_lag_max_ns, missed_slots)
}

/// The two boundary instants of `window` on the caller's clock.
///
/// Derived from the window rather than recomputed from `seconds` so the
/// observation boundaries cannot drift from the boundaries every estimate is
/// partitioned by.
fn window_boundaries(window: &perf_measurement::HoldWindow, start: Instant) -> (Instant, Instant) {
    (
        start + Duration::from_nanos(window.warmup_end_ns.saturating_sub(window.start_ns)),
        start + Duration::from_nanos(window.end_ns.saturating_sub(window.start_ns)),
    )
}

/// Collects the boundary observation, recording any failure as a fatal error.
///
/// A lost or failed observation leaves the deltas absent instead of widening
/// their span: the resource-shift comparison is only meaningful over the
/// measured window, so no sample is better than a sample covering a different
/// interval in each arm.
async fn join_task_window(
    ctx: &RunContext,
    observed: tokio::task::JoinHandle<Result<TaskWindow, String>>,
) -> Option<TaskWindow> {
    let error = match observed.await {
        Ok(Ok(window)) => return Some(window),
        Ok(Err(error)) => error,
        Err(error) => format!("task counter observer: {error}"),
    };
    ctx.fatal_errors.lock().await.push(error);
    None
}

async fn run_load(ctx: RunContext) -> LoadOutcome {
    match ctx.opts.load {
        Load::Open { rate } => {
            let offered = rate * ctx.opts.seconds;
            let start = Instant::now() + Duration::from_millis(25);
            let start_ns = ctx.wire.ns_at(start);
            let window = perf_measurement::HoldWindow::new(start_ns, ctx.opts.seconds);
            let (warmup_end, end) = window_boundaries(&window, start);
            let tasks_observed =
                tokio::spawn(observe_task_window(ctx.wire.origin(), warmup_end, end));
            let mut tasks = tokio::task::JoinSet::new();
            for slot in 0..offered {
                let offset_ns = perf_measurement::open_loop_offset_ns(slot, rate);
                let scheduled = start + Duration::from_nanos(offset_ns);
                // A slot's own spacing is the gap to the next slot; exact for
                // every rate rather than a global constant.
                let slot_gap_ns = perf_measurement::open_loop_offset_ns(slot + 1, rate) - offset_ns;
                // The spin window is bounded by half the slot gap so the
                // pacer can never busy-spin continuously at high rates: an
                // unbounded spin per sub-slack slot would saturate a worker
                // core in the same process as the host under test and
                // inflate the tails this harness measures.
                let slack = PACING_SLACK.min(Duration::from_nanos(slot_gap_ns / 2));
                tokio::time::sleep_until((scheduled - slack).into()).await;
                while Instant::now() < scheduled {
                    std::hint::spin_loop();
                }
                // The intended schedule, not a reconstruction from the pacer's
                // observed lag. The frozen offered rate is defined by intended
                // starts, and comparing the recorded first send against this
                // value is what makes the validity gate sensitive to time the
                // request spent queued after the pacer released it.
                let scheduled_ns = start_ns.saturating_add(offset_ns);
                let task_ctx = ctx.clone();
                tasks.spawn(async move { execute(&task_ctx, slot + 1, Some(scheduled_ns)).await });
            }
            let mut records = Vec::with_capacity(offered as usize);
            while let Some(result) = tasks.join_next().await {
                match result {
                    Ok(record) => records.push(record),
                    Err(error) => ctx
                        .fatal_errors
                        .lock()
                        .await
                        .push(format!("load task: {error}")),
                }
            }
            records.sort_by_key(|record| record.logical_id);
            let (send_lag_max_ns, missed_slots) = open_loop_send_lag(&records, rate);
            let task_window = join_task_window(&ctx, tasks_observed).await;
            LoadOutcome {
                records,
                send_lag_max_ns,
                missed_slots,
                window,
                task_window,
            }
        }
        Load::Closed { concurrency } => {
            let start = Instant::now();
            let start_ns = ctx.wire.ns_at(start);
            let window = perf_measurement::HoldWindow::new(start_ns, ctx.opts.seconds);
            let (warmup_end, end) = window_boundaries(&window, start);
            let tasks_observed =
                tokio::spawn(observe_task_window(ctx.wire.origin(), warmup_end, end));
            let next_id = Arc::new(AtomicU64::new(1));
            let mut workers = tokio::task::JoinSet::new();
            for _ in 0..concurrency {
                let worker_ctx = ctx.clone();
                let next_id = Arc::clone(&next_id);
                workers.spawn(async move {
                    let mut records = Vec::new();
                    while Instant::now() < end {
                        let id = next_id.fetch_add(1, Ordering::Relaxed);
                        records.push(execute(&worker_ctx, id, None).await);
                    }
                    records
                });
            }
            let mut records = Vec::new();
            while let Some(result) = workers.join_next().await {
                match result {
                    Ok(mut worker) => records.append(&mut worker),
                    Err(error) => ctx
                        .fatal_errors
                        .lock()
                        .await
                        .push(format!("worker: {error}")),
                }
            }
            records.sort_by_key(|record| record.logical_id);
            let task_window = join_task_window(&ctx, tasks_observed).await;
            LoadOutcome {
                records,
                // Closed-loop work has no schedule to fall behind.
                send_lag_max_ns: 0,
                missed_slots: 0,
                window,
                task_window,
            }
        }
    }
}

#[derive(serde::Serialize)]
struct Summary {
    kind: &'static str,
    variant: SynapseVariant,
    arm: Arm,
    load: Load,
    seconds: u64,
    seed: u64,
    engine_delay_ms: u64,
    max_waiting_queries: usize,
    query_retry_after_ms: u64,
    /// Subtracted from every permit-wait sample, so two runs with otherwise
    /// identical emitted configuration derive different wait distributions
    /// when it differs. Emitted with the other treatment inputs to keep that
    /// subtraction reproducible from the summary alone.
    transport_floor_ns: u64,
    /// See [`HOST_BUILD_ID`]. `null` for an unidentified build, which the
    /// contract admits only for variants that vary client policy alone.
    host_build_id: Option<&'static str>,
    ledger: perf_measurement::SynapseLedgerSummary,
    attempt_latency: Option<LatencySummary>,
    logical_latency: Option<LatencySummary>,
    permit_wait: Option<SignedSummary>,
    poll_distribution: Option<CountSummary>,
    service_time: Option<LatencySummary>,
    service_time_mean_ns: Option<f64>,
    service_time_cv: Option<f64>,
    /// Engine calls the service estimates above are built from, and those the
    /// window classification held out. Emitted so a reader can tell a cell with
    /// few in-window engine calls from one whose samples were discarded.
    service_measured_samples: u64,
    service_excluded_samples: u64,
    send_lag_max_ns: u64,
    missed_slots: u64,
    /// Frozen hold window on the wire clock. Emitted so both discards and the
    /// in-flight censoring below are re-derivable from raw evidence.
    hold_window_start_ns: u64,
    warmup_end_ns: u64,
    hold_window_end_ns: u64,
    /// Rows held out of every estimate above as the window's warmup prefix.
    /// They stay in raw evidence with `window: "warmup"`.
    warmup_offered: u64,
    warmup_attempts: u64,
    /// Rows held out because they opened at or after the window end: a
    /// closed-loop worker that passed the boundary test but did not reach the
    /// wire until the window had closed. They stay in raw evidence with
    /// `window: "after_window"`.
    after_window_offered: u64,
    after_window_attempts: u64,
    censored_per_mille: f64,
    /// Task counter deltas over the measured window, absent when a boundary
    /// observation failed. The instants the two observations landed on are
    /// emitted alongside so the covered span is auditable rather than assumed
    /// to equal `[warmup_end_ns, hold_window_end_ns]` exactly.
    task_deltas: Option<Vec<process_resources::TaskDelta>>,
    task_window_start_ns: Option<u64>,
    task_window_end_ns: Option<u64>,
    /// Transport-loss failures on the single shared wire. A subset of
    /// `fatal_errors` (still part of the fatal gate), counted separately
    /// so analysis can distinguish connection loss from harness defects.
    connection_loss_errors: u64,
    /// Frames whose write finished after the caller's deadline. See
    /// [`RoutedWire::overdeadline_writes`]: any nonzero value means the host ran
    /// work the harness had already accounted as expired, so the repetition is
    /// inadmissible.
    overdeadline_writes: u64,
    fatal_errors: Vec<String>,
}

#[derive(serde::Serialize)]
struct SignedSummary {
    count: u64,
    p50_ns: i64,
    p90_ns: i64,
    p95_ns: i64,
    p99_ns: i64,
    max_ns: i64,
}

#[derive(serde::Serialize)]
struct CountSummary {
    count: u64,
    p50: u64,
    p90: u64,
    p95: u64,
    p99: u64,
    max: u64,
}

impl CountSummary {
    fn from_unsorted(mut samples: Vec<u64>) -> Option<Self> {
        samples.sort_unstable();
        Some(Self {
            count: samples.len() as u64,
            p50: perf_measurement::nearest_rank(&samples, 50.0)?,
            p90: perf_measurement::nearest_rank(&samples, 90.0)?,
            p95: perf_measurement::nearest_rank(&samples, 95.0)?,
            p99: perf_measurement::nearest_rank(&samples, 99.0)?,
            max: *samples.last()?,
        })
    }
}

impl SignedSummary {
    fn from_unsorted(mut samples: Vec<i64>) -> Option<Self> {
        if samples.is_empty() {
            return None;
        }
        samples.sort_unstable();
        let rank = |percentile: usize| {
            let index = (samples.len() * percentile).div_ceil(100).max(1) - 1;
            samples[index]
        };
        Some(Self {
            count: samples.len() as u64,
            p50_ns: rank(50),
            p90_ns: rank(90),
            p95_ns: rank(95),
            p99_ns: rank(99),
            max_ns: *samples.last()?,
        })
    }
}

async fn run(
    opts: Opts,
) -> Result<
    (
        Vec<LogicalRecord>,
        Vec<AttemptRecord>,
        Vec<ServiceSample>,
        Summary,
    ),
    String,
> {
    let data_root = tempfile::tempdir().map_err(|error| format!("temporary data root: {error}"))?;
    // One origin for the engine and the wire: service samples and logical rows
    // are only comparable to the hold window if they share a clock. Taken
    // before the host starts so the engine, which is built first, can hold it;
    // every timestamp is window-relative, so the extra startup offset is common
    // to all of them and cancels. Shadowing this with a second `Instant::now()`
    // for the wire would put service samples and window boundaries on different
    // zeros, shifting every service classification by the startup interval.
    let origin = Instant::now();
    let service = Arc::new(StdMutex::new(Vec::new()));
    let engine = Arc::new(DelayEngine {
        delay: Duration::from_millis(opts.engine_delay_ms),
        origin,
        service: Arc::clone(&service),
    });
    let mut limits = SynapseLimits {
        max_waiting_queries: opts.max_waiting_queries,
        query_retry_after_ms: opts.query_retry_after_ms,
        // Uniform across every variant arm so admission-treatment cells stay
        // comparable: startup validation charges (waiters + queued jobs +
        // queued bytes) against one resident budget, and the default 64 MiB
        // queued-byte budget leaves no room for any waiting query. The
        // benchmark's batch payloads are far below this bound.
        max_queued_request_bytes: HARNESS_QUEUED_REQUEST_BYTES,
        ..Default::default()
    };
    if let Arm::Batch(shape) = opts.arm {
        limits.max_page_vectors = shape.page_vectors();
    }
    let component = SynapseComponent::ready_with_engine(lane(), engine, limits)
        .map_err(|error| format!("validate Synapse limits: {error}"))?;
    let host = HostThread::start(component, data_root.path().to_path_buf())?;
    let publication = data_root
        .path()
        .join("cortexkit")
        .join("run")
        .join(mc_host::CONNECTION_FILE_NAME);
    let startup_deadline = Instant::now() + STARTUP_BUDGET;
    while !publication.is_file() {
        host.check_running()?;
        if Instant::now() >= startup_deadline {
            return Err("host did not publish within startup budget".to_owned());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let wire = RoutedWire::connect(&publication, origin).await?;
    let ctx = RunContext {
        wire,
        attempts: Arc::new(Mutex::new(Vec::new())),
        next_attempt: Arc::new(AtomicU64::new(1)),
        fatal_errors: Arc::new(Mutex::new(Vec::new())),
        connection_loss: Arc::new(AtomicU64::new(0)),
        opts,
    };
    warm(&ctx).await?;
    service.lock().expect("service samples").clear();
    let load = run_load(ctx.clone()).await;
    let LoadOutcome {
        mut records,
        send_lag_max_ns,
        missed_slots,
        window,
        task_window,
    } = load;
    let mut attempts = ctx.attempts.lock().await.clone();
    // Apply the frozen window before anything is estimated: classify every row
    // against the boundaries and censor requests the window closed on.
    window.stamp(&mut records, &mut attempts);
    let logical = records;
    // Raw evidence keeps every row; only the measured set feeds the ledger, the
    // rates, and the percentiles.
    let (logical_estimates, logical_excluded) =
        perf_measurement::partition_measured(&logical, |record| record.window);
    let (attempt_estimates, attempt_excluded) =
        perf_measurement::partition_measured(&attempts, |attempt| attempt.window);
    let fatal_errors = ctx.fatal_errors.lock().await.clone();
    let connection_loss_errors = ctx.connection_loss.load(Ordering::Relaxed);
    let ledger = perf_measurement::validate_synapse_ledgers(&logical_estimates, &attempt_estimates);
    let attempt_latency = LatencySummary::from_unsorted(
        attempt_estimates
            .iter()
            .map(|attempt| attempt.latency_ns)
            .collect(),
    );
    // Percentiles describe requests that reached a terminal outcome inside the
    // window. A censored row's `latency_ns` runs to whenever it actually
    // settled — seconds or minutes past the boundary for an overloaded cell —
    // so admitting it would let the tail be dominated by durations the ledger
    // simultaneously declares right-censored, and the contamination would grow
    // with the treatment. The censoring rate reports what this excludes, so the
    // pair stays interpretable: percentiles over answered requests, plus the
    // fraction that went unanswered.
    let logical_latency = LatencySummary::from_unsorted(
        logical_estimates
            .iter()
            .filter(|request| !is_censored(request.disposition))
            .map(|request| request.latency_ns)
            .collect(),
    );
    // Permit wait is only meaningful for attempts the engine actually
    // served: a rejected or timed-out query attempt did no engine work,
    // so subtracting the engine delay from it produces a hugely negative
    // residual that is scheduler noise, not permit queueing. The type
    // stays signed and unclamped so genuine timer-resolution negatives
    // on successful attempts remain visible.
    let permit_wait = SignedSummary::from_unsorted(
        attempt_estimates
            .iter()
            .filter(|attempt| {
                attempt.method == SynapseMethod::Query
                    && attempt.disposition == AttemptDisposition::Success
            })
            .map(|attempt| {
                let residual = i128::from(attempt.latency_ns)
                    - i128::from(opts.engine_delay_ms.saturating_mul(1_000_000))
                    - i128::from(opts.transport_floor_ns);
                residual.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
            })
            .collect(),
    );
    let poll_distribution = CountSummary::from_unsorted(
        logical_estimates
            .iter()
            .map(|request| request.polls)
            .collect(),
    );
    // Service samples carry their own start instant, so the same window
    // classification that partitions logical rows partitions them. Without it
    // the engine calls made under the discarded warmup prefix — and those
    // drained after the boundary — would enter mean S, CV, and the service
    // percentiles that the capacity estimate is built on, while the logical and
    // attempt ledgers excluded that very cohort.
    let mut service_samples = service.lock().expect("service samples").clone();
    for sample in &mut service_samples {
        sample.window = window.classify(sample.started_ns);
    }
    let service_measured: Vec<u64> = service_samples
        .iter()
        .filter(|sample| sample.window.is_measured())
        .map(|sample| sample.service_ns)
        .collect();
    let service_time = LatencySummary::from_unsorted(service_measured.clone());
    let service_time_mean_ns = mean(&service_measured);
    let service_time_cv = coefficient_of_variation(&service_measured);
    let censored = censored_count(&ledger);
    let censored_per_mille = if ledger.offered == 0 {
        0.0
    } else {
        censored as f64 * 1_000.0 / ledger.offered as f64
    };
    let summary = Summary {
        kind: "synapse_perf_summary",
        variant: opts.variant,
        arm: opts.arm,
        load: opts.load,
        seconds: opts.seconds,
        seed: opts.seed,
        engine_delay_ms: opts.engine_delay_ms,
        max_waiting_queries: opts.max_waiting_queries,
        query_retry_after_ms: opts.query_retry_after_ms,
        transport_floor_ns: opts.transport_floor_ns,
        host_build_id: HOST_BUILD_ID,
        ledger,
        attempt_latency,
        logical_latency,
        permit_wait,
        poll_distribution,
        service_time,
        service_time_mean_ns,
        service_time_cv,
        service_measured_samples: service_measured.len() as u64,
        service_excluded_samples: (service_samples.len() - service_measured.len()) as u64,
        send_lag_max_ns,
        missed_slots,
        hold_window_start_ns: window.start_ns,
        warmup_end_ns: window.warmup_end_ns,
        hold_window_end_ns: window.end_ns,
        warmup_offered: perf_measurement::count_class(
            &logical_excluded,
            WindowClass::Warmup,
            |record| record.window,
        ),
        warmup_attempts: perf_measurement::count_class(
            &attempt_excluded,
            WindowClass::Warmup,
            |attempt| attempt.window,
        ),
        after_window_offered: perf_measurement::count_class(
            &logical_excluded,
            WindowClass::AfterWindow,
            |record| record.window,
        ),
        after_window_attempts: perf_measurement::count_class(
            &attempt_excluded,
            WindowClass::AfterWindow,
            |attempt| attempt.window,
        ),
        censored_per_mille,
        task_deltas: task_window.as_ref().map(|window| window.deltas.clone()),
        task_window_start_ns: task_window.as_ref().map(|window| window.observed_start_ns),
        task_window_end_ns: task_window.as_ref().map(|window| window.observed_end_ns),
        connection_loss_errors,
        overdeadline_writes: ctx.wire.overdeadline_writes(),
        fatal_errors,
    };
    drop(ctx);
    host.shutdown()?;
    Ok((logical, attempts, service_samples, summary))
}

fn mean(samples: &[u64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    Some(samples.iter().map(|value| *value as f64).sum::<f64>() / samples.len() as f64)
}

fn coefficient_of_variation(samples: &[u64]) -> Option<f64> {
    let mean = mean(samples)?;
    if mean == 0.0 {
        return Some(0.0);
    }
    let variance = samples
        .iter()
        .map(|value| (*value as f64 - mean).powi(2))
        .sum::<f64>()
        / samples.len() as f64;
    Some(variance.sqrt() / mean)
}

fn censored_count(ledger: &perf_measurement::SynapseLedgerSummary) -> u64 {
    ledger.timed_out.saturating_add(ledger.in_flight)
}

/// The two dispositions the censoring rate counts, and therefore the two the
/// latency percentiles exclude. A timeout's duration is truncated at the
/// deadline and an in-flight row's runs past the window, so both are
/// right-censored observations rather than measured request latencies; keeping
/// one definition means the reported rate always describes exactly the rows the
/// percentiles omit.
fn is_censored(disposition: LogicalDisposition) -> bool {
    matches!(
        disposition,
        LogicalDisposition::TimedOut | LogicalDisposition::InFlight
    )
}

fn emit(
    logical: &[LogicalRecord],
    attempts: &[AttemptRecord],
    service_samples: &[ServiceSample],
    summary: &Summary,
) -> Result<(), String> {
    for record in logical {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "kind": "synapse_perf_logical",
                "variant": summary.variant,
                "arm": summary.arm,
                "load": summary.load,
                "seed": summary.seed,
                "record": record
            }))
            .map_err(|error| error.to_string())?
        );
    }
    for record in attempts {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "kind": "synapse_perf_attempt",
                "variant": summary.variant,
                "arm": summary.arm,
                "load": summary.load,
                "seed": summary.seed,
                "record": record
            }))
            .map_err(|error| error.to_string())?
        );
    }
    for (index, sample) in service_samples.iter().enumerate() {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "kind": "synapse_perf_service",
                "variant": summary.variant,
                "arm": summary.arm,
                "load": summary.load,
                "seed": summary.seed,
                "index": index,
                "sample": sample
            }))
            .map_err(|error| error.to_string())?
        );
    }
    println!(
        "{}",
        serde_json::to_string(summary).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn main() {
    let opts = match parse_opts() {
        Ok(opts) => opts,
        Err(error) => {
            eprintln!("synapse_perf failed: {error}");
            std::process::exit(1);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("generator")
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("synapse_perf failed: generator runtime: {error}");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(run(opts));
    match result {
        Ok((logical, attempts, service_samples, summary)) => {
            if let Err(error) = emit(&logical, &attempts, &service_samples, &summary) {
                eprintln!("synapse_perf failed: emit: {error}");
                std::process::exit(1);
            }
            let censored = censored_count(&summary.ledger);
            let censoring_invalid = u128::from(censored) * 1_000
                > u128::from(summary.ledger.offered) * MAX_CENSORED_PER_MILLE;
            let poll_ceiling_exceeded = summary
                .poll_distribution
                .as_ref()
                .is_some_and(|polls| polls.max > MAX_POLLS_PER_LOGICAL);
            // An empty measured window is internally consistent — the ledger
            // balances, censoring divides to zero, and no missed-slot gate
            // applies to closed loop — so nothing above rejects it. A cell with
            // no measured request carries no estimate at all and must not be
            // consumable as admissible evidence. A closed-loop repetition
            // reaches this state whenever every request it opened fell in the
            // warmup prefix or spanned the whole hold.
            let empty_window = summary.ledger.offered == 0
                || summary.logical_latency.is_none()
                || summary.service_time.is_none();
            if !summary.ledger.valid
                || !summary.fatal_errors.is_empty()
                || summary.missed_slots != 0
                || censoring_invalid
                || poll_ceiling_exceeded
                || summary.overdeadline_writes != 0
                || empty_window
            {
                eprintln!(
                    "synapse_perf failed: invalid repetition (ledger={}, fatal={}, missed_slots={}, censored_per_mille={:.3}, poll_max={} vs ceiling {}, overdeadline_writes={}, measured_offered={})",
                    summary.ledger.valid,
                    summary.fatal_errors.len(),
                    summary.missed_slots,
                    summary.censored_per_mille,
                    summary
                        .poll_distribution
                        .as_ref()
                        .map_or(0, |polls| polls.max),
                    MAX_POLLS_PER_LOGICAL,
                    summary.overdeadline_writes,
                    summary.ledger.offered
                );
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("synapse_perf failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn logical(logical_id: u64, disposition: LogicalDisposition) -> LogicalRecord {
        terminal_record(logical_id, None, 0, 1, disposition, None, 0, 0)
    }

    #[test]
    fn terminal_rejection_is_not_censoring() {
        let ledger = perf_measurement::validate_synapse_ledgers(
            &[logical(1, LogicalDisposition::Rejected)],
            &[],
        );

        assert!(ledger.valid);
        assert_eq!(censored_count(&ledger), 0);
    }

    #[test]
    fn timeout_and_in_flight_are_censoring() {
        let ledger = perf_measurement::validate_synapse_ledgers(
            &[
                logical(1, LogicalDisposition::TimedOut),
                logical(2, LogicalDisposition::InFlight),
            ],
            &[],
        );

        assert!(ledger.valid);
        assert_eq!(censored_count(&ledger), 2);
    }

    #[test]
    fn service_time_mean_retains_raw_sample_mean() {
        assert_eq!(mean(&[10, 20, 30]), Some(20.0));
        assert_eq!(mean(&[]), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn call_writes_strictly_increasing_correlations_under_concurrency() {
        // The host retires the generation on any non-increasing Request
        // correlation, so allocation and socket write must be atomic under
        // the writer lock. This drives many concurrent callers through one
        // wire and decodes the request headers server-side: hoisting the
        // fetch_add outside the writer lock lets two tasks write inverted
        // correlations, which this assertion catches.
        const CALLERS: usize = 256;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut corrs = Vec::with_capacity(CALLERS);
            for _ in 0..CALLERS {
                let mut header = [0u8; raw_client::HEADER_LEN];
                stream
                    .read_exact(&mut header)
                    .await
                    .expect("request header");
                let frame = raw_client::decode_header(&header);
                let mut body = vec![0u8; frame.len as usize];
                stream.read_exact(&mut body).await.expect("request body");
                corrs.push(frame.corr);
            }
            corrs
        });
        let stream = TcpStream::connect(addr).await.expect("connect loopback");
        let (_reader, writer) = tokio::io::split(stream);
        let wire = Arc::new(RoutedWire {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            tombstones: Mutex::new(std::collections::BTreeSet::new()),
            next_corr: AtomicU64::new(1),
            channel: 7,
            epoch: 3,
            origin: Instant::now(),
            reader_error: Mutex::new(None),
            overdeadline_writes: AtomicU64::new(0),
        });
        let mut callers = tokio::task::JoinSet::new();
        for _ in 0..CALLERS {
            let wire = Arc::clone(&wire);
            callers.spawn(async move {
                // The server never replies, so every call resolves as an
                // attempt timeout after its write; only the write order
                // matters here. One second is microseconds of loopback writes
                // away from being generous for 256 contending writers, so the
                // test still exercises write ordering rather than the pre-send
                // refusal, and it is also how long the reply wait takes to
                // expire.
                let deadline = Instant::now() + Duration::from_secs(1);
                match wire.call(b"{}".to_vec(), deadline).await {
                    Err(WireCallError::Timeout { .. }) => {}
                    Err(WireCallError::ExpiredBeforeSend) => {
                        panic!("the deadline expired before a small loopback write completed")
                    }
                    Err(WireCallError::Transport(error)) => panic!("transport error: {error}"),
                    Ok(_) => panic!("no reply was sent"),
                }
            });
        }
        while let Some(result) = callers.join_next().await {
            result.expect("caller task");
        }
        let corrs = server.await.expect("server task");
        assert_eq!(corrs.len(), CALLERS);
        for pair in corrs.windows(2) {
            assert!(
                pair[0] < pair[1],
                "correlations left the writer in inverted order: {} then {}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn terminal_module_restarted_rejection_keeps_ledgers_valid() {
        // One submit, one poll that answered module_restarted, one
        // resubmission, then a terminal module_restarted poll: four owned
        // attempts, disposition Rejected.
        let record = terminal_record(
            7,
            None,
            0,
            4,
            LogicalDisposition::Rejected,
            Some("module_restarted".to_owned()),
            4,
            2,
        );
        let attempt = |attempt_id, method, disposition, code: Option<&str>| AttemptRecord {
            logical_id: 7,
            attempt_id,
            method,
            disposition,
            code: code.map(str::to_owned),
            retry_after_ms: None,
            actual_send_ns: attempt_id,
            terminal_ns: attempt_id + 1,
            latency_ns: 1,
            window: WindowClass::Measured,
        };
        let attempts = [
            attempt(1, SynapseMethod::Batch, AttemptDisposition::Success, None),
            attempt(
                2,
                SynapseMethod::Result,
                AttemptDisposition::Poll,
                Some("module_restarted"),
            ),
            attempt(3, SynapseMethod::Batch, AttemptDisposition::Success, None),
            attempt(
                4,
                SynapseMethod::Result,
                AttemptDisposition::Poll,
                Some("module_restarted"),
            ),
        ];
        let ledger = perf_measurement::validate_synapse_ledgers(&[record], &attempts);

        assert!(ledger.valid, "{:?}", ledger.errors);
        assert_eq!(censored_count(&ledger), 0);
        // module_restarted attempts are admitted work — only queue_full is
        // an admission rejection — and they are not timeouts, so both
        // submissions and both restarted polls count as admitted and the
        // timeout breakdown stays empty.
        assert_eq!(ledger.admitted_by_method["embed.batch"], 2);
        assert_eq!(ledger.admitted_by_method["embed.result"], 2);
        assert!(ledger.rejected_by_method_code.is_empty());
        assert!(ledger.timed_out_by_method_code.is_empty());
    }

    #[test]
    fn connection_loss_strings_classify_as_connection_loss() {
        assert!(is_connection_loss("frame header: early eof"));
        assert!(is_connection_loss("frame body: unexpected end of file"));
        assert!(is_connection_loss(
            "send correlation 42: Broken pipe (os error 32)"
        ));
        assert!(is_connection_loss("connection closed while awaiting reply"));
        assert!(is_connection_loss("Broken pipe (os error 32)"));

        assert!(!is_connection_loss(
            "unexpected embed.result error schema_violation: {}"
        ));
        assert!(!is_connection_loss("response JSON: expected value"));
        assert!(!is_connection_loss(
            "batch result did not preserve every item exactly once"
        ));
    }

    #[test]
    fn variant_is_required_and_waiter_combinations_are_typed() {
        assert_eq!(
            parse_opts_from(args(&["--arm", "query", "--concurrency", "1"]))
                .expect_err("missing variant"),
            "--variant is required"
        );
        assert!(parse_opts_from(args(&[
            "--variant",
            "a",
            "--arm",
            "query",
            "--concurrency",
            "1"
        ]))
        .expect_err("A needs K")
        .contains("greater than zero"));
        assert!(parse_opts_from(args(&[
            "--variant",
            "b",
            "--arm",
            "query",
            "--concurrency",
            "1",
            "--max-waiting-queries",
            "1"
        ]))
        .expect_err("B is a loss arm")
        .contains("requires --max-waiting-queries 0"));

        // `baseline` and `hygiene-only` claim pre-change host code, which this
        // binary cannot select at run time. Without a build id the emitted cell
        // would look like a host comparison while running the changed host, so
        // the run is refused. Guarded on the constant because a collection build
        // legitimately sets it.
        if HOST_BUILD_ID.is_none() {
            for variant in ["baseline", "hygiene-only"] {
                assert!(
                    parse_opts_from(args(&[
                        "--variant",
                        variant,
                        "--arm",
                        "query",
                        "--concurrency",
                        "1",
                    ]))
                    .expect_err("pre-change variants need an identified build")
                    .contains("pre-change host code"),
                    "{variant} was accepted from an unidentified build"
                );
            }
        }

        let a = parse_opts_from(args(&[
            "--variant",
            "a+c",
            "--arm",
            "query",
            "--concurrency",
            "1",
            "--max-waiting-queries",
            "2",
        ]))
        .expect("A+C with finite K");
        assert_eq!(a.variant, SynapseVariant::APlusC);
        assert_eq!(a.max_waiting_queries, 2);
    }
}
