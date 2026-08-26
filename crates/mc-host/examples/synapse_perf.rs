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
    LogicalRecord, SynapseMethod, SynapseVariant,
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
const FINGERPRINT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MODEL: &str = "synapse-perf-tiny";
const QUERY_TEXT: &str = "model-free benchmark query";

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
    Open { rate: u64, interval_ns: u64 },
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
        (Some(rate), None) => Load::Open {
            rate,
            interval_ns: perf_measurement::open_loop_interval_ns(rate)?,
        },
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
            variant_name(variant)
        ));
    }
    if !variant.needs_waiting_queries() && max_waiting_queries != 0 {
        return Err(format!(
            "variant {} requires --max-waiting-queries 0",
            variant_name(variant)
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

fn variant_name(variant: SynapseVariant) -> &'static str {
    match variant {
        SynapseVariant::Baseline => "baseline",
        SynapseVariant::HygieneOnly => "hygiene-only",
        SynapseVariant::A => "a",
        SynapseVariant::B => "b",
        SynapseVariant::C => "c",
        SynapseVariant::APlusC => "a+c",
    }
}

fn parse<T: std::str::FromStr>(value: &str, name: &str) -> Result<T, String> {
    value.parse().map_err(|_| format!("invalid {name}"))
}

struct DelayEngine {
    delay: Duration,
    service_ns: Arc<StdMutex<Vec<u64>>>,
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
        self.service_ns
            .lock()
            .expect("service samples")
            .push(elapsed);
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
    next_corr: AtomicU64,
    channel: u16,
    epoch: u32,
    origin: Instant,
    reader_error: Mutex<Option<String>>,
}

enum WireCallError {
    Timeout { sent_ns: u64, terminal_ns: u64 },
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
            next_corr: AtomicU64::new(1_000_000),
            channel,
            epoch,
            origin,
            reader_error: Mutex::new(None),
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

    async fn call(&self, body: Vec<u8>, budget: Duration) -> Result<WireReply, WireCallError> {
        if let Some(error) = self.reader_error.lock().await.clone() {
            return Err(WireCallError::Transport(error));
        }
        let corr = self.next_corr.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(corr, tx);
        let sent_ns = {
            let mut writer = self.writer.lock().await;
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
            sent_ns
        };
        match tokio::time::timeout(budget, rx).await {
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
                self.pending.lock().await.remove(&corr);
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
        let sender = wire
            .pending
            .lock()
            .await
            .remove(&frame.corr)
            .ok_or_else(|| format!("terminal for unknown correlation {}", frame.corr))?;
        let _ = sender.send((frame, received_ns));
    }
}

#[derive(Clone)]
struct RunContext {
    wire: Arc<RoutedWire>,
    attempts: Arc<Mutex<Vec<AttemptRecord>>>,
    next_attempt: Arc<AtomicU64>,
    fatal_errors: Arc<Mutex<Vec<String>>>,
    opts: Opts,
}

impl RunContext {
    async fn record_call(
        &self,
        logical_id: u64,
        method: SynapseMethod,
        body: Vec<u8>,
        deadline: Instant,
    ) -> Result<(WireReply, serde_json::Value), String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let attempt_id = self.next_attempt.fetch_add(1, Ordering::Relaxed);
        let result = self.wire.call(body, remaining).await;
        match result {
            Ok(reply) => {
                let json: serde_json::Value = serde_json::from_slice(&reply.frame.body)
                    .map_err(|error| format!("response JSON: {error}"))?;
                let code = json["code"].as_str().map(str::to_owned);
                let retry_after_ms = json["retry_after_ms"].as_u64();
                let disposition = if method == SynapseMethod::Result {
                    AttemptDisposition::Poll
                } else if reply.frame.ty == raw_client::TY_ERROR
                    && code.as_deref() == Some("queue_full")
                {
                    AttemptDisposition::RetryableRejection
                } else if reply.frame.ty == raw_client::TY_ERROR
                    && code.as_deref() == Some("timeout")
                {
                    AttemptDisposition::Timeout
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
                });
                Ok((reply, json))
            }
            Err(WireCallError::Timeout {
                sent_ns,
                terminal_ns,
            }) => {
                self.attempts.lock().await.push(AttemptRecord {
                    logical_id,
                    attempt_id,
                    method,
                    disposition: if method == SynapseMethod::Result {
                        AttemptDisposition::Poll
                    } else {
                        AttemptDisposition::Timeout
                    },
                    code: Some("attempt_timeout".to_owned()),
                    retry_after_ms: None,
                    actual_send_ns: sent_ns,
                    terminal_ns,
                    latency_ns: terminal_ns.saturating_sub(sent_ns),
                });
                Err("attempt timeout".to_owned())
            }
            Err(WireCallError::Transport(error)) => Err(error),
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
    }
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
        params["deadline_ms"] = u64::try_from(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
        .into();
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
            Err(error) if error == "attempt timeout" => {
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
                    first_send.unwrap_or(now),
                    now,
                    LogicalDisposition::TimedOut,
                    Some("attempt_timeout".to_owned()),
                    u64::from(attempts),
                    0,
                ));
            }
            Err(error) => return Err(error),
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
    let mut rng = DeterministicRng::new(ctx.opts.seed ^ logical_id.rotate_left(17));
    let mut first_send = None;
    let mut batch_attempts = 0u64;
    let (job_id, served_poll_cap) = loop {
        batch_attempts += 1;
        let (reply, json) = match ctx
            .record_call(logical_id, SynapseMethod::Batch, body.clone(), deadline)
            .await
        {
            Ok(value) => value,
            Err(error) if error == "attempt timeout" => {
                if batch_attempts < u64::from(MAX_TOTAL_ATTEMPTS) {
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
                    first_send.unwrap_or(now),
                    now,
                    LogicalDisposition::TimedOut,
                    Some("attempt_timeout".to_owned()),
                    batch_attempts,
                    0,
                ));
            }
            Err(error) => return Err(error),
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
        if code != "queue_full" {
            return Err(format!("unexpected embed.batch error: {json}"));
        }
        if batch_attempts == u64::from(MAX_TOTAL_ATTEMPTS) {
            return Ok(terminal_record(
                logical_id,
                scheduled_start_ns,
                first_send.expect("set above"),
                reply.received_ns,
                LogicalDisposition::Rejected,
                Some(code.to_owned()),
                batch_attempts,
                0,
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
                batch_attempts,
                0,
            ));
        }
        tokio::time::sleep(delay).await;
    };

    let mut cursor = serde_json::Value::Null;
    let mut polls = 0u64;
    let mut collected = Vec::with_capacity(items.len());
    let mut poll_delay_ms = if let Some(delay) = ctx.opts.variant.initial_poll_delay_ms(&mut rng) {
        tokio::time::sleep(Duration::from_secs_f64(delay / 1_000.0)).await;
        delay
    } else {
        0.0
    };
    loop {
        let mut poll_attempt = 0u32;
        let (reply, json) = loop {
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
                    if !retryable || poll_attempt == MAX_TOTAL_ATTEMPTS {
                        break (reply, json);
                    }
                    let base = json["retry_after_ms"].as_u64().unwrap_or(100);
                    let delay = Duration::from_secs_f64(rng.retry_delay_ms(base) / 1_000.0);
                    if Instant::now() + delay >= deadline {
                        break (reply, json);
                    }
                    tokio::time::sleep(delay).await;
                }
                Err(error) if error == "attempt timeout" => {
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
                        Some("attempt_timeout".to_owned()),
                        batch_attempts + polls,
                        polls,
                    ));
                }
                Err(error) => return Err(error),
            }
        };
        if reply.frame.ty == raw_client::TY_ERROR {
            let code = json["code"].as_str().unwrap_or("unparsable");
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
                    return Err("batch result did not preserve every item exactly once".to_owned());
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
            continue;
        }
        let served_delay = result["retry_after_ms"].as_u64().unwrap_or(served_poll_cap);
        poll_delay_ms = ctx
            .opts
            .variant
            .pending_poll_delay_ms(poll_delay_ms, served_delay);
        tokio::time::sleep(Duration::from_secs_f64(poll_delay_ms / 1_000.0)).await;
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
    Ok(())
}

async fn run_load(ctx: RunContext) -> (Vec<LogicalRecord>, u64, u64) {
    match ctx.opts.load {
        Load::Open { rate, interval_ns } => {
            let offered = rate * ctx.opts.seconds;
            let start = Instant::now() + Duration::from_millis(25);
            let mut tasks = tokio::task::JoinSet::new();
            let mut send_lag_max_ns = 0;
            let mut missed_slots = 0;
            for slot in 0..offered {
                let scheduled = start + Duration::from_nanos(slot * interval_ns);
                tokio::time::sleep_until((scheduled - PACING_SLACK).into()).await;
                let mut now = Instant::now();
                while now < scheduled {
                    std::hint::spin_loop();
                    now = Instant::now();
                }
                let lag =
                    u64::try_from(now.duration_since(scheduled).as_nanos()).unwrap_or(u64::MAX);
                send_lag_max_ns = send_lag_max_ns.max(lag);
                if lag >= interval_ns {
                    missed_slots += 1;
                }
                let scheduled_ns = ctx.wire.elapsed_ns().saturating_sub(lag);
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
            (records, send_lag_max_ns, missed_slots)
        }
        Load::Closed { concurrency } => {
            let end = Instant::now() + Duration::from_secs(ctx.opts.seconds);
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
            (records, 0, 0)
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
    ledger: perf_measurement::SynapseLedgerSummary,
    attempt_latency: Option<LatencySummary>,
    logical_latency: Option<LatencySummary>,
    permit_wait: Option<SignedSummary>,
    poll_distribution: Option<CountSummary>,
    service_time: Option<LatencySummary>,
    service_time_mean_ns: Option<f64>,
    service_time_cv: Option<f64>,
    send_lag_max_ns: u64,
    missed_slots: u64,
    censored_per_mille: f64,
    task_deltas: Vec<process_resources::TaskDelta>,
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
) -> Result<(Vec<LogicalRecord>, Vec<AttemptRecord>, Vec<u64>, Summary), String> {
    let data_root = tempfile::tempdir().map_err(|error| format!("temporary data root: {error}"))?;
    let service_ns = Arc::new(StdMutex::new(Vec::new()));
    let engine = Arc::new(DelayEngine {
        delay: Duration::from_millis(opts.engine_delay_ms),
        service_ns: Arc::clone(&service_ns),
    });
    let mut limits = SynapseLimits {
        max_waiting_queries: opts.max_waiting_queries,
        query_retry_after_ms: opts.query_retry_after_ms,
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

    let origin = Instant::now();
    let wire = RoutedWire::connect(&publication, origin).await?;
    let ctx = RunContext {
        wire,
        attempts: Arc::new(Mutex::new(Vec::new())),
        next_attempt: Arc::new(AtomicU64::new(1)),
        fatal_errors: Arc::new(Mutex::new(Vec::new())),
        opts,
    };
    warm(&ctx).await?;
    service_ns.lock().expect("service samples").clear();
    let task_before =
        process_resources::observe_tasks(std::process::id()).map_err(|error| error.to_string())?;
    let (logical, send_lag_max_ns, missed_slots) = run_load(ctx.clone()).await;
    let task_after =
        process_resources::observe_tasks(std::process::id()).map_err(|error| error.to_string())?;
    let task_deltas = process_resources::task_deltas(&task_before, &task_after);
    let attempts = ctx.attempts.lock().await.clone();
    let fatal_errors = ctx.fatal_errors.lock().await.clone();
    let ledger = perf_measurement::validate_synapse_ledgers(&logical, &attempts);
    let attempt_latency =
        LatencySummary::from_unsorted(attempts.iter().map(|attempt| attempt.latency_ns).collect());
    let logical_latency =
        LatencySummary::from_unsorted(logical.iter().map(|request| request.latency_ns).collect());
    let permit_wait = SignedSummary::from_unsorted(
        attempts
            .iter()
            .filter(|attempt| attempt.method == SynapseMethod::Query)
            .map(|attempt| {
                let residual = i128::from(attempt.latency_ns)
                    - i128::from(opts.engine_delay_ms.saturating_mul(1_000_000))
                    - i128::from(opts.transport_floor_ns);
                residual.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
            })
            .collect(),
    );
    let poll_distribution =
        CountSummary::from_unsorted(logical.iter().map(|request| request.polls).collect());
    let service_samples = service_ns.lock().expect("service samples").clone();
    let service_time = LatencySummary::from_unsorted(service_samples.clone());
    let service_time_mean_ns = mean(&service_samples);
    let service_time_cv = coefficient_of_variation(&service_samples);
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
        ledger,
        attempt_latency,
        logical_latency,
        permit_wait,
        poll_distribution,
        service_time,
        service_time_mean_ns,
        service_time_cv,
        send_lag_max_ns,
        missed_slots,
        censored_per_mille,
        task_deltas,
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

fn emit(
    logical: &[LogicalRecord],
    attempts: &[AttemptRecord],
    service_samples: &[u64],
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
    for (index, service_ns) in service_samples.iter().enumerate() {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "kind": "synapse_perf_service",
                "variant": summary.variant,
                "arm": summary.arm,
                "load": summary.load,
                "seed": summary.seed,
                "index": index,
                "service_ns": service_ns
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
            if !summary.ledger.valid
                || !summary.fatal_errors.is_empty()
                || summary.missed_slots != 0
                || censoring_invalid
            {
                eprintln!(
                    "synapse_perf failed: invalid repetition (ledger={}, fatal={}, missed_slots={}, censored_per_mille={:.3})",
                    summary.ledger.valid,
                    summary.fatal_errors.len(),
                    summary.missed_slots,
                    summary.censored_per_mille
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

    fn logical(disposition: LogicalDisposition) -> LogicalRecord {
        terminal_record(1, None, 0, 1, disposition, None, 0, 0)
    }

    #[test]
    fn terminal_rejection_is_not_censoring() {
        let ledger = perf_measurement::validate_synapse_ledgers(
            &[logical(LogicalDisposition::Rejected)],
            &[],
        );

        assert!(ledger.valid);
        assert_eq!(censored_count(&ledger), 0);
    }

    #[test]
    fn timeout_and_in_flight_are_censoring() {
        let ledger = perf_measurement::validate_synapse_ledgers(
            &[
                logical(LogicalDisposition::TimedOut),
                logical(LogicalDisposition::InFlight),
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
