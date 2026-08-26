//! Model-free, open-loop `embed.query` benchmark.
//!
//! Every request keeps its absolute scheduled time through completion, so
//! scheduler lag and overload remain in the reported latency distribution.
//! The sender paces each request with a coarse sleep followed by a spin to
//! the exact deadline: tokio's timer rounds wakes up to whole-millisecond
//! ticks, so an uncompensated `sleep_until` would add a per-run constant
//! offset of up to a full tick to every latency sample and collapse
//! sub-millisecond intervals into per-tick bursts. A run whose observed
//! send lag ever reaches one arrival interval fails instead of publishing
//! a schedule it did not deliver.

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
/// Bound on host startup: connection-file publication must appear within
/// this window. Distinct from `DRAIN_BUDGET`, which bounds post-send
/// response drain; the two are equal by coincidence, not by meaning.
const STARTUP_BUDGET: Duration = Duration::from_secs(10);
/// How far ahead of each scheduled send the coarse timer wait targets.
/// Tokio timer wakes are quantized to whole-millisecond ticks, so the
/// task sleeps to `scheduled - PACING_SLACK` and spins the remainder;
/// one tick of slack absorbs the worst-case round-up, the second covers
/// wake jitter.
const PACING_SLACK: Duration = Duration::from_millis(2);
/// Largest fraction of offered requests (per mille) that may miss the
/// latency distribution before the run is unpublishable. Percentiles are
/// computed over completions only, so every shed or timed-out request
/// censors a sample that would have occupied the tail; two arms can only
/// be differenced when both censor at most this negligibly.
const MAX_CENSORED_PER_MILLE: u128 = 10;
/// Lane fingerprint every request pins; responses must echo it exactly.
const FINGERPRINT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/// Text every measured request embeds; the response must carry its digest
/// as `content_sha256`.
const QUERY_TEXT: &str = "model-free benchmark query";

#[derive(Clone, Copy)]
struct Opts {
    rate: u64,
    seconds: u64,
    /// Exact nanosecond arrival interval derived from `rate` during option
    /// validation, so scheduling reuses the already-validated value.
    interval_ns: u64,
}

fn parse_opts() -> Result<Opts, String> {
    let mut opts = Opts {
        rate: 100,
        seconds: 5,
        interval_ns: 0,
    };
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--rate" => opts.rate = value.parse().map_err(|_| "invalid rate".to_owned())?,
            "--seconds" => {
                opts.seconds = value.parse().map_err(|_| "invalid seconds".to_owned())?
            }
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    if opts.seconds == 0 {
        return Err("seconds must be nonzero".to_owned());
    }
    opts.interval_ns = perf_measurement::open_loop_interval_ns(opts.rate)?;
    opts.rate
        .checked_mul(opts.seconds)
        .filter(|count| *count > 0)
        .ok_or_else(|| "offered request count is zero or overflows".to_owned())?;
    Ok(opts)
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
        fingerprint: FINGERPRINT.to_owned(),
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

/// Cancels the wrapped token when dropped. Declared after `data_root` in
/// `run`, so on any exit path — including each early `return Err` — drop
/// order requests host shutdown ahead of the `TempDir` removal of the
/// directory the host writes.
struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

async fn wait_for_publication(
    publication: &std::path::Path,
    host: &tokio::task::JoinHandle<Result<(), mc_host::HostError>>,
) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_BUDGET;
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

async fn run(opts: Opts) -> Result<serde_json::Value, String> {
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
    let _shutdown_guard = CancelOnDrop(shutdown.clone());
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
    let warmup_body = serde_json::to_vec(&serde_json::json!({
        "method": "embed.query",
        "params": {
            "model": "synapse-perf-zero-delay",
            "required_fingerprint": FINGERPRINT,
            "required_epoch": 1,
            "allow_equivalent": false,
            "accept_declared": false,
            "text": "warmup"
        }
    }))
    .map_err(|error| format!("serialize warmup request: {error}"))?;
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
    // The warmup body is network input: parse it fallibly so a malformed
    // response fails the run with a message instead of a panic.
    let warmup_json: serde_json::Value = serde_json::from_slice(&warmup.body)
        .map_err(|error| format!("warmup response JSON: {error}"))?;
    if warmup.ty != raw_client::TY_RESPONSE || warmup_json["result"]["done"] != true {
        return Err(format!("warmup request failed: {warmup_json}"));
    }
    let stream = client.into_stream();
    stream
        .set_nodelay(true)
        .map_err(|error| format!("set TCP_NODELAY: {error}"))?;
    let (mut reader, mut writer) = stream.into_split();

    let interval_ns = opts.interval_ns;
    let offered = opts
        .rate
        .checked_mul(opts.seconds)
        .ok_or_else(|| "offered request count overflows".to_owned())?;
    let request = serde_json::to_vec(&serde_json::json!({
        "method": "embed.query",
        "params": {
            "model": "synapse-perf-zero-delay",
            "required_fingerprint": FINGERPRINT,
            "required_epoch": 1,
            "allow_equivalent": false,
            "accept_declared": false,
            "text": QUERY_TEXT
        }
    }))
    .map_err(|error| format!("serialize request: {error}"))?;
    let request_len = u32::try_from(request.len()).map_err(|_| "request too large".to_owned())?;
    let expected_sha256 = perf_measurement::sha256_hex(QUERY_TEXT.as_bytes());
    // Every count-proportional allocation precedes schedule selection: an
    // O(offered) map population after `start` is fixed would eat the 25 ms
    // lead-in on large runs and turn the first deadlines into a catch-up
    // burst that measures client setup instead of the configured arrival
    // process. The map stores slot indexes; absolute deadlines derive from
    // `start` at resolution time.
    let mut pending = HashMap::with_capacity(offered as usize);
    for slot in 0..offered {
        pending.insert(1_000_000 + slot, slot);
    }
    let mut responses: Vec<Vec<u8>> = Vec::with_capacity(offered as usize);
    let mut errors: Vec<Vec<u8>> = Vec::new();
    let mut latencies_ns = Vec::with_capacity(offered as usize);

    let start = Instant::now() + Duration::from_millis(25);
    let mut sender = tokio::spawn(async move {
        let mut send_lag_max_ns = 0u64;
        let mut missed_slots = 0u64;
        for slot in 0..offered {
            let scheduled = start + Duration::from_nanos(slot * interval_ns);
            // Two-stage pacing. A bare `sleep_until(scheduled)` fires up to
            // a whole timer tick late (tokio rounds wakes up to 1 ms), which
            // books a per-run constant offset into every latency sample and
            // collapses sub-tick intervals into per-tick bursts. The coarse
            // sleep lands slack-early; the spin covers the remainder
            // exactly. The spin occupies one worker thread, which is the
            // load generator's job; the reader drains on another worker.
            tokio::time::sleep_until((scheduled - PACING_SLACK).into()).await;
            let mut now = Instant::now();
            while now < scheduled {
                std::hint::spin_loop();
                now = Instant::now();
            }
            // Send lag is load-generator debt, never host latency: a slot
            // that starts one full interval late means the delivered
            // arrival process no longer matches the requested rate label.
            let lag_ns =
                u64::try_from(now.duration_since(scheduled).as_nanos()).unwrap_or(u64::MAX);
            send_lag_max_ns = send_lag_max_ns.max(lag_ns);
            if lag_ns >= interval_ns {
                missed_slots += 1;
            }
            let corr = 1_000_000 + slot;
            let mut frame = raw_client::header(
                request_len,
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
        Ok::<_, String>((writer, send_lag_max_ns, missed_slots))
    });

    let drain_deadline = start + Duration::from_secs(opts.seconds) + DRAIN_BUDGET;
    let mut unresolved = 0u64;
    while !pending.is_empty() {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            unresolved = pending.len() as u64;
            break;
        }
        let frame = match tokio::time::timeout(remaining, read_frame(&mut reader)).await {
            Ok(frame) => frame?,
            Err(_) => {
                unresolved = pending.len() as u64;
                break;
            }
        };
        // Completion is the arrival of the terminal's last byte, so the
        // timestamp is captured before any body work. The loop performs
        // header checks only; JSON parsing between consecutive reads would
        // delay frames already buffered by TCP and book that delay against
        // their requests, so body validation is deferred past the drain
        // loop.
        let received = Instant::now();
        if matches!(
            frame.ty,
            raw_client::TY_PING | raw_client::TY_PUSH | raw_client::TY_GOODBYE
        ) {
            if let Some(violation) = raw_client::connection_frame_violation(&frame) {
                return Err(violation);
            }
            // A goodbye addressed to this route (or the whole connection)
            // is the host tearing down while requests are outstanding:
            // fail the run as connection loss instead of misreporting it
            // as a route-identity violation. A goodbye for another route
            // is skippable like ping and push.
            if frame.ty == raw_client::TY_GOODBYE
                && ((frame.channel, frame.epoch) == (channel, epoch)
                    || (frame.channel == 0 && frame.epoch == 0))
            {
                return Err(format!(
                    "host sent goodbye with {} requests unresolved",
                    pending.len()
                ));
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
        let slot = pending
            .remove(&frame.corr)
            .ok_or_else(|| format!("terminal for unknown correlation {}", frame.corr))?;
        // Both terminal kinds carry JSON bodies the host emits with its
        // terminal flag shape (non-binary, last, Interactive priority); any
        // other flags are a wire regression that must not produce
        // publishable accounting.
        if frame.flags != raw_client::FLAGS_RESPONSE_TEXT_LAST {
            return Err(format!(
                "terminal frame type {} with unexpected flags {:#04x}",
                frame.ty, frame.flags
            ));
        }
        match frame.ty {
            raw_client::TY_RESPONSE => {
                let scheduled = start + Duration::from_nanos(slot * interval_ns);
                latencies_ns.push(
                    u64::try_from(received.duration_since(scheduled).as_nanos())
                        .unwrap_or(u64::MAX),
                );
                responses.push(frame.body);
            }
            raw_client::TY_ERROR => errors.push(frame.body),
            other => return Err(format!("unexpected terminal frame type {other}")),
        }
    }
    // The join is bounded: once the reader stops consuming, a sender parked
    // in `write_all` against peer backpressure has nothing left to unblock
    // it, and an unbounded await would keep an overload run alive
    // indefinitely past the drain deadline.
    let (_writer, send_lag_max_ns, missed_slots) =
        match tokio::time::timeout(DRAIN_BUDGET, &mut sender).await {
            Ok(joined) => joined.map_err(|error| format!("sender task: {error}"))??,
            Err(_) => {
                sender.abort();
                return Err(format!(
                    "sender still blocked {}s after the drain deadline with {} requests unresolved",
                    DRAIN_BUDGET.as_secs(),
                    pending.len()
                ));
            }
        };
    if missed_slots != 0 {
        // The delivered arrival process fell at least one full interval
        // behind the requested schedule; the run would carry the requested
        // `rate_per_sec` label for traffic it never generated.
        return Err(format!(
            "sender missed {missed_slots} of {offered} slots (max send lag {send_lag_max_ns} ns \
             >= interval {interval_ns} ns); the run did not deliver the requested rate"
        ));
    }
    let completed = responses.len() as u64;
    // The full embed.query contract for every completion, checked after the
    // drain loop so validation cost stays out of the recorded latencies: a
    // regression in any echoed lane field or in the vector payload fails
    // the run rather than publishing latency numbers for incorrect work.
    for body in &responses {
        let body: serde_json::Value =
            serde_json::from_slice(body).map_err(|error| format!("response JSON: {error}"))?;
        let result = &body["result"];
        let vector_ok = result["vectors"][0]["vector"]
            .as_array()
            .is_some_and(|values| {
                values.len() == 8
                    && values[0].as_f64() == Some(1.0)
                    && values[1..].iter().all(|value| value.as_f64() == Some(0.0))
            });
        if result["done"] != true
            || result["model"] != "synapse-perf-zero-delay"
            || result["fingerprint"] != FINGERPRINT
            || result["table_epoch"] != 1
            || result["dims"] != 8
            || result["vectors"].as_array().map(Vec::len) != Some(1)
            || result["vectors"][0]["id"] != "query"
            || result["vectors"][0]["content_sha256"].as_str() != Some(expected_sha256.as_str())
            || !vector_ok
        {
            return Err(format!("invalid embed.query response: {body}"));
        }
    }
    let mut rejected = 0u64;
    let mut timed_out = 0u64;
    for body in &errors {
        // The error body is network input: a malformed one must fail the
        // run gracefully (keeping the evidence trail), never panic the
        // process.
        let code = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value["code"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "unparsable".to_owned());
        match code.as_str() {
            "timeout" => timed_out += 1,
            // Admission rejection is the one expected shedding outcome; any
            // other code is a functional failure, and counting it as
            // `rejected` would let a broken host keep a publishable
            // baseline.
            "queue_full" => rejected += 1,
            _ => {
                return Err(format!(
                    "unexpected error terminal (code {code}): {}",
                    String::from_utf8_lossy(body)
                ))
            }
        }
    }
    if unresolved != 0 {
        // No host terminal arrived for these requests — the cause is a
        // dropped response, a transport failure, or a request the lagging
        // sender never wrote, never a host-reported timeout. Publishing a
        // baseline from such a run would present broken accounting as exact.
        return Err(format!(
            "{unresolved} requests unresolved at the drain deadline: offered={offered} \
             completed={completed} rejected={rejected} timed_out={timed_out}"
        ));
    }

    let in_flight = pending.len() as u64;
    if offered != completed + rejected + timed_out + in_flight || in_flight != 0 {
        return Err(format!(
            "accounting mismatch: offered={offered} completed={completed} rejected={rejected} \
             timed_out={timed_out} in_flight={in_flight}"
        ));
    }
    if completed == 0 {
        return Err("run completed no successful requests".to_owned());
    }
    // Percentiles cover completions only, so every rejected or timed-out
    // request censors a sample that would have occupied the tail; the
    // censored fraction the host sheds under load is exactly the traffic a
    // slower arm sheds more of, which can flip the sign of a cross-arm
    // percentile comparison. Cap censoring rather than publish
    // success-only percentiles as if they described the offered load.
    let censored = offered - completed;
    if u128::from(censored) * 1000 > u128::from(offered) * MAX_CENSORED_PER_MILLE {
        return Err(format!(
            "{censored} of {offered} requests have no latency sample \
             (rejected={rejected} timed_out={timed_out}); censoring exceeds \
             {MAX_CENSORED_PER_MILLE}/1000, so success-only percentiles are not publishable"
        ));
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
        "rate_per_sec": opts.rate,
        "seconds": opts.seconds,
        "offered": offered,
        "completed": completed,
        "rejected": rejected,
        "timed_out": timed_out,
        "in_flight": in_flight,
        "send_lag_max_ns": send_lag_max_ns,
        "latency_samples": completed,
        "throughput_per_sec": completed as f64 / opts.seconds as f64,
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
