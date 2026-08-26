//! Model-free, open-loop `embed.query` benchmark.
//!
//! Every request keeps its absolute scheduled time through completion, so
//! scheduler lag and overload remain in the reported successful-response
//! latency distribution. Throughput and latency include admitted successes
//! only; rejected outcomes are reported separately.

#[path = "../tests/support/perf_measurement.rs"]
mod perf_measurement;

#[path = "../tests/support/raw_client.rs"]
mod raw_client;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mc_host::synapse::inference::InferenceError;
use mc_host::synapse::{
    EmbeddingEngine, LaneInfo, SynapseComponent, SynapseLimits, SYNAPSE_MODULE_ID,
};
use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HostConfig, HostInit,
    InitError, ManifestSnapshot, PrimaryComponent, RequestCtx, RequestOutcome, RouteHandle,
    RouteIdentity, SecondaryComponent, ShutdownError, StaticComposite,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const ROOT: &str = "/workspace/synapse-perf";
const DRAIN_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct Plan {
    rate: u64,
    seconds: u64,
    interval_ns: u64,
    offered: u64,
    offered_capacity: usize,
}

impl Plan {
    fn new(rate: u64, seconds: u64) -> Result<Self, String> {
        let interval_ns = perf_measurement::open_loop_interval_ns(rate)?;
        let offered = rate
            .checked_mul(seconds)
            .filter(|count| *count > 0)
            .ok_or_else(|| "offered request count is zero or overflows".to_owned())?;
        offered
            .checked_add(1_000_000)
            .ok_or_else(|| "correlation range overflows".to_owned())?;
        let offered_capacity = usize::try_from(offered)
            .map_err(|_| "offered request count exceeds addressable capacity".to_owned())?;
        Ok(Self {
            rate,
            seconds,
            interval_ns,
            offered,
            offered_capacity,
        })
    }

    fn schedule(self) -> Result<Schedule, String> {
        let start = Instant::now()
            .checked_add(Duration::from_millis(25))
            .ok_or_else(|| "benchmark start instant overflows".to_owned())?;
        let send_end = start
            .checked_add(Duration::from_secs(self.seconds))
            .ok_or_else(|| "benchmark send deadline overflows".to_owned())?;
        let drain_deadline = send_end
            .checked_add(DRAIN_BUDGET)
            .ok_or_else(|| "benchmark drain deadline overflows".to_owned())?;
        let schedule = Schedule {
            start,
            drain_deadline,
            interval_ns: self.interval_ns,
        };
        schedule.scheduled(self.offered - 1)?;
        Ok(schedule)
    }
}

#[derive(Clone, Copy)]
struct Schedule {
    start: Instant,
    drain_deadline: Instant,
    interval_ns: u64,
}

impl Schedule {
    fn scheduled(self, slot: u64) -> Result<Instant, String> {
        let offset_ns = slot
            .checked_mul(self.interval_ns)
            .ok_or_else(|| "scheduled offset overflows".to_owned())?;
        self.start
            .checked_add(Duration::from_nanos(offset_ns))
            .ok_or_else(|| "scheduled instant overflows".to_owned())
    }
}

fn parse_opts() -> Result<Plan, String> {
    let mut rate = 100;
    let mut seconds = 5;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--rate" => rate = value.parse().map_err(|_| "invalid rate".to_owned())?,
            "--seconds" => seconds = value.parse().map_err(|_| "invalid seconds".to_owned())?,
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    if seconds == 0 {
        return Err("seconds must be nonzero".to_owned());
    }
    Plan::new(rate, seconds)
}

fn request_body(text: &str) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&serde_json::json!({
        "method": "embed.query",
        "params": {
            "model": "synapse-perf-zero-delay",
            "required_fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "required_epoch": 1,
            "allow_equivalent": false,
            "accept_declared": false,
            "text": text
        }
    }))
    .map_err(|error| format!("serialize request: {error}"))
}

struct ZeroDelayEngine;

impl EmbeddingEngine for ZeroDelayEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        Ok(texts
            .iter()
            .map(|_| vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
            .collect())
    }
}

fn lane() -> LaneInfo {
    LaneInfo {
        model: "synapse-perf-zero-delay".to_owned(),
        fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
        table_epoch: 1,
        dims: 8,
        max_tokens: 512,
        max_text_bytes: 1024,
        provenance: serde_json::json!({"source": "inline zero-delay engine"}),
        recommended_rows: 16,
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
            return RequestOutcome::Error {
                code: "internal_error".to_owned(),
                message: "output reservation failed".to_owned(),
            };
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
        RequestOutcome::Error {
            code: "internal_error".to_owned(),
            message: "unreachable: broca binds are rejected".to_owned(),
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

impl SecondaryComponent for PlaceholderBroca {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<raw_client::RawFrame, String> {
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
    Ok(frame)
}

async fn wait_for_publication(
    publication: &std::path::Path,
    host: &tokio::task::JoinHandle<Result<(), mc_host::HostError>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if publication.is_file() {
            return Ok(());
        }
        if host.is_finished() {
            return Err("host exited before publishing".to_owned());
        }
        if Instant::now() >= deadline {
            return Err("host did not publish within startup budget".to_owned());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn run(plan: Plan) -> Result<serde_json::Value, String> {
    let data_root = tempfile::tempdir().map_err(|error| format!("temporary data root: {error}"))?;
    let synapse = SynapseComponent::ready_with_engine(
        lane(),
        Arc::new(ZeroDelayEngine),
        SynapseLimits::default(),
    );
    let composite = StaticComposite::new(PerfPrimary, synapse, PlaceholderBroca)
        .map_err(|error| format!("compose host: {error}"))?;
    let config = HostConfig {
        data_dir: Some(data_root.path().to_path_buf()),
        daemon_ver: "mc-host/synapse-perf".to_owned(),
        ..Default::default()
    };
    let publication = data_root
        .path()
        .join("cortexkit")
        .join("run")
        .join(mc_host::CONNECTION_FILE_NAME);
    let shutdown = CancellationToken::new();
    let run_shutdown = shutdown.clone();
    let host = tokio::spawn(mc_host::run(composite, config, run_shutdown));
    wait_for_publication(&publication, &host).await?;

    let info = raw_client::discover(&publication)?;
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
    let warmup_body = request_body("warmup")?;
    let warmup_corr = client.next_corr();
    client
        .send_frame(
            raw_client::TY_REQUEST,
            raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            warmup_corr,
            &warmup_body,
        )
        .await
        .map_err(|error| format!("send warmup request: {error}"))?;
    let (_, warmup) = client
        .frames_until_corr(warmup_corr, Duration::from_secs(5))
        .await?;
    if warmup.ty != raw_client::TY_RESPONSE || warmup.json()["result"]["done"] != true {
        return Err(format!("warmup request failed: {:?}", warmup.json()));
    }
    let stream = client.into_stream();
    stream
        .set_nodelay(true)
        .map_err(|error| format!("set TCP_NODELAY: {error}"))?;
    let (mut reader, mut writer) = stream.into_split();

    let schedule = plan.schedule()?;
    let mut pending = HashMap::with_capacity(plan.offered_capacity);
    for slot in 0..plan.offered {
        pending.insert(1_000_000 + slot, schedule.scheduled(slot)?);
    }

    let request = request_body("model-free benchmark query")?;
    let sender = tokio::spawn(async move {
        for slot in 0..plan.offered {
            let scheduled = schedule.scheduled(slot)?;
            tokio::time::sleep_until(scheduled.into()).await;
            let corr = 1_000_000 + slot;
            let mut frame = raw_client::header(
                u32::try_from(request.len()).map_err(|_| "request too large".to_owned())?,
                raw_client::TY_REQUEST,
                raw_client::FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
            );
            frame.extend_from_slice(&request);
            writer
                .write_all(&frame)
                .await
                .map_err(|error| format!("send correlation {corr}: {error}"))?;
        }
        Ok::<_, String>(writer)
    });

    let mut completed = 0u64;
    let mut rejected = 0u64;
    let mut timed_out = 0u64;
    let mut latencies_ns = Vec::with_capacity(plan.offered_capacity);
    while !pending.is_empty() {
        let remaining = schedule
            .drain_deadline
            .saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let frame = match tokio::time::timeout(remaining, read_frame(&mut reader)).await {
            Ok(frame) => frame?,
            Err(_) => {
                break;
            }
        };
        if matches!(frame.ty, raw_client::TY_PING | raw_client::TY_PUSH) {
            if let Some(violation) = raw_client::connection_frame_violation(&frame) {
                return Err(violation);
            }
            continue;
        }
        if frame.ver != raw_client::WIRE_VERSION || frame.channel != channel || frame.epoch != epoch
        {
            return Err(format!(
                "terminal has wrong route identity {}/{}/v{}",
                frame.channel, frame.epoch, frame.ver
            ));
        }
        let scheduled = pending
            .remove(&frame.corr)
            .ok_or_else(|| format!("terminal for unknown correlation {}", frame.corr))?;
        match frame.ty {
            raw_client::TY_RESPONSE => {
                let body: serde_json::Value = serde_json::from_slice(&frame.body)
                    .map_err(|error| format!("response JSON: {error}"))?;
                if body["result"]["done"] != true {
                    return Err(format!("invalid embed.query response: {body}"));
                }
                completed += 1;
                latencies_ns.push(
                    u64::try_from(Instant::now().duration_since(scheduled).as_nanos())
                        .unwrap_or(u64::MAX),
                );
            }
            raw_client::TY_ERROR => {
                let code = frame.error_code();
                if code == "timeout" {
                    timed_out += 1;
                } else {
                    rejected += 1;
                }
            }
            other => return Err(format!("unexpected terminal frame type {other}")),
        }
    }
    let _writer = sender
        .await
        .map_err(|error| format!("sender task: {error}"))??;

    let in_flight = pending.len() as u64;
    if in_flight != 0 {
        return Err(format!(
            "accounting incomplete after drain: offered={} completed={completed} \
             rejected={rejected} timed_out={timed_out} in_flight={in_flight}",
            plan.offered
        ));
    }
    if plan.offered != completed + rejected + timed_out {
        return Err(format!(
            "accounting mismatch: offered={} completed={completed} rejected={rejected} \
             timed_out={timed_out}",
            plan.offered
        ));
    }
    if completed == 0 {
        return Err("run completed no successful requests".to_owned());
    }
    latencies_ns.sort_unstable();
    let p50_ns = perf_measurement::nearest_rank(&latencies_ns, 50.0).expect("nonempty samples");
    let p95_ns = perf_measurement::nearest_rank(&latencies_ns, 95.0).expect("nonempty samples");
    let p99_ns = perf_measurement::nearest_rank(&latencies_ns, 99.0).expect("nonempty samples");
    if !(p50_ns <= p95_ns && p95_ns <= p99_ns) {
        return Err("percentiles are not monotone".to_owned());
    }

    drop(reader);
    shutdown.cancel();
    match host.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(format!("host shutdown: {error}")),
        Err(error) => return Err(format!("host task: {error}")),
    }

    Ok(serde_json::json!({
        "kind": "synapse_perf_result",
        "loop": "open",
        "engine": "inline_zero_delay",
        "rate_per_sec": plan.rate,
        "seconds": plan.seconds,
        "offered": plan.offered,
        "completed": completed,
        "rejected": rejected,
        "timed_out": timed_out,
        "in_flight": in_flight,
        "throughput_per_sec": completed as f64 / plan.seconds as f64,
        "p50_ns": p50_ns,
        "p95_ns": p95_ns,
        "p99_ns": p99_ns
    }))
}

#[tokio::main]
async fn main() {
    let result = match parse_opts() {
        Ok(opts) => run(opts).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("synapse_perf failed: {error}");
            std::process::exit(1);
        }
    }
}
