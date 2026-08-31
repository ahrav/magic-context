//! This binary drives the perf-harness host over the mandatory ring.
//! docs/perf/mc-host-baseline.md defines the historical benchmark arms;
//! the shared measurement contract lives in
//! `tests/support/perf_measurement.rs`.
//!
//! The sender captures issue time after admission, immediately before frame construction.
//! Closed-loop arms report issue-to-validated-terminal latency.
//! Only `--serial` (`--pipeline 1`) has RTT-valued closed-loop latency.
//! Open-loop arms report scheduled-to-completion, issue-to-completion, and scheduler-lag distributions separately.
//! Open-loop arms preserve the original arrival schedule.
//! Every scheduled request resolves to exactly one terminal outcome.
//! outcome.
//!
//! `--workload json` sends the compact-JSON fixture.
//! `json` validates every echoed terminal body against the fixture bytes.
//! `raw` sends a mode byte plus optional sleep-ms and is not comparable with JSON fixture arms.

#[path = "../tests/support/raw_client.rs"]
mod raw_client;

#[path = "../tests/support/perf_measurement.rs"]
mod perf_measurement;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use perf_measurement::{
    open_loop_offset_ns, validate_open_loop_rate, LatencySummary, Outcome, OutcomeCounts,
    FIXTURE_BODY,
};
use raw_client::{RawClient, FLAGS_INTERACTIVE, TY_ERROR, TY_REQUEST, TY_RESPONSE};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore, TryAcquireError};

const MODULE_ID: &str = "perf-echo";
/// Pending requests become `UnresolvedAtDrain` after the five-second post-send drain.
/// The drain loop terminates after five seconds even when a response is lost.
const DRAIN_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Workload {
    Raw,
    /// `Json` validates terminal bodies against `FIXTURE_BODY` before counting success.
    Json,
}

#[derive(Clone, Debug)]
struct Opts {
    publication: std::path::PathBuf,
    conns: usize,
    payload: usize,
    secs: u64,
    rate: u64,
    pipeline: usize,
    sleep_ms: u32,
    stall_big: usize,
    inflight_cap: usize,
    label: String,
    workload: Workload,
}

fn parse_opts() -> Opts {
    let mut opts = Opts {
        publication: std::path::PathBuf::new(),
        conns: 1,
        payload: 256,
        secs: 20,
        rate: 0,
        pipeline: 32,
        sleep_ms: 0,
        stall_big: 0,
        inflight_cap: 1024,
        label: "run".to_owned(),
        workload: Workload::Raw,
    };
    let mut args = std::env::args().skip(1);
    opts.publication = args
        .next()
        .expect("usage: perf_load <publication> ...")
        .into();
    while let Some(flag) = args.next() {
        if flag == "--serial" {
            opts.pipeline = 1;
            continue;
        }
        let mut value = || args.next().expect("flag value");
        match flag.as_str() {
            "--conns" => opts.conns = value().parse().expect("conns"),
            "--payload" => opts.payload = value().parse().expect("payload"),
            "--secs" => opts.secs = value().parse().expect("secs"),
            "--rate" => opts.rate = value().parse().expect("rate"),
            "--pipeline" => opts.pipeline = value().parse().expect("pipeline"),
            "--sleep-ms" => opts.sleep_ms = value().parse().expect("sleep-ms"),
            "--stall-big" => opts.stall_big = value().parse().expect("stall-big"),
            "--inflight-cap" => opts.inflight_cap = value().parse().expect("cap"),
            "--label" => opts.label = value(),
            "--workload" => {
                opts.workload = match value().as_str() {
                    "raw" => Workload::Raw,
                    "json" => Workload::Json,
                    other => panic!("unknown workload {other}"),
                }
            }
            other => panic!("unknown flag {other}"),
        }
    }
    opts
}

fn body_bytes(opts: &Opts) -> Vec<u8> {
    match opts.workload {
        Workload::Json => FIXTURE_BODY.to_vec(),
        Workload::Raw => {
            let len = opts.payload.max(5);
            let mut body = vec![0u8; len];
            body[0] = if opts.sleep_ms > 0 { 1 } else { 0 };
            body[1..5].copy_from_slice(&opts.sleep_ms.to_le_bytes());
            body
        }
    }
}

struct ConnResult {
    /// Open loop reports issue-to-validated-terminal latency as the issue-based distribution.
    issue_latencies_ns: Vec<u64>,
    /// honest).
    sched_latencies_ns: Vec<u64>,
    /// `issue - scheduled` measures load-generator lag, not server latency.
    sched_lag_ns: Vec<u64>,
    sent: u64,
    measured_scheduled: u64,
    /// Responses resolve requests even before the measurement window opens.
    /// `resolved - measured` reports warmup traffic because window-gated outcome counters exclude it.
    resolved: u64,
    outcomes: OutcomeCounts,
    error_codes: HashMap<String, u64>,
    closed_early: bool,
    /// The reader fails the run when it observes an unsolicited request terminal.
    protocol_violation: Option<String>,
    inflight_full: u64,
}

async fn open_route(
    info: &raw_client::Discovered,
    session: &str,
) -> (tokio::net::UnixStream, u16, u32) {
    let mut client = RawClient::connect(info).await.expect("auth");
    let (channel, epoch) = client
        .route_open(MODULE_ID, "/perf", "perf", session)
        .await
        .expect("route");
    (client.into_stream(), channel, epoch)
}

async fn run_conn(
    conn: (tokio::net::UnixStream, u16, u32),
    idx: usize,
    opts: Opts,
    start: Instant,
    warmup: Duration,
) -> ConnResult {
    let (stream, channel, epoch) = conn;
    let (read_half, mut write_half) = stream.into_split();
    let body = Arc::new(body_bytes(&opts));
    let expect_fixture = opts.workload == Workload::Json;
    // The response-length cap permits raw workload requests with multi-megabyte echoed bodies.
    // `raw` can echo bodies up to the configured payload size.
    // `MAX_BODY_LEN` covers only the fixture and error terminals.
    let max_response_len = u32::try_from(body.len())
        .unwrap_or(u32::MAX)
        .max(perf_measurement::MAX_BODY_LEN);

    let inflight = Arc::new(Semaphore::new(if opts.rate > 0 {
        opts.inflight_cap
    } else {
        opts.pipeline
    }));
    let (meta_tx, mut meta_rx) = mpsc::unbounded_channel::<(u64, u64, u64)>();
    let sent_count = Arc::new(AtomicU64::new(0));
    let measured_sent = Arc::new(AtomicU64::new(0));
    let sender_done = Arc::new(tokio::sync::Notify::new());

    let send_deadline = start + Duration::from_secs(opts.secs);
    let rate = opts.rate;
    if rate > 0 {
        validate_open_loop_rate(rate).expect("offered rate");
    }
    let warmup_ns = warmup.as_nanos() as u64;

    let sender = {
        let inflight = Arc::clone(&inflight);
        let sent_count = Arc::clone(&sent_count);
        let measured_sent = Arc::clone(&measured_sent);
        let sender_done = Arc::clone(&sender_done);
        let body = Arc::clone(&body);
        let conns = opts.conns as u64;
        tokio::spawn(async move {
            let mut corr: u64 = 1_000_000;
            let mut k: u64 = 0;
            let mut inflight_full = 0u64;
            // Connection `idx` owns every `conns`-th global arrival slot, preserving the aggregate offered rate even when `rate` does not divide 1e9.
            let idx = idx as u64;
            loop {
                // In open loop, the sender issues a late scheduled slot immediately and records its lag without adding catch-up slots.
                let scheduled = if rate > 0 {
                    let at =
                        start + Duration::from_nanos(open_loop_offset_ns(k * conns + idx, rate));
                    if at >= send_deadline {
                        break;
                    }
                    tokio::time::sleep_until(at.into()).await;
                    at
                } else {
                    if Instant::now() >= send_deadline {
                        break;
                    }
                    Instant::now()
                };
                let permit = match inflight.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    // When the reader closes the semaphore after its connection ends, the sender stops the schedule.
                    Err(TryAcquireError::Closed) => break,
                    Err(TryAcquireError::NoPermits) => {
                        inflight_full += 1;
                        if rate > 0 {
                            // In open loop, the sender drops a slot when no in-flight permit is available.
                            // In open loop, waiting for an in-flight permit would throttle the offered rate to the completion rate and hide overload in the outcome table.
                            let scheduled_ns = scheduled.duration_since(start).as_nanos() as u64;
                            if scheduled_ns >= warmup_ns {
                                measured_sent.fetch_add(1, Ordering::Release);
                            }
                            if meta_tx.send((0, scheduled_ns, u64::MAX)).is_err() {
                                break;
                            }
                            k += 1;
                            continue;
                        }
                        match inflight.clone().acquire_owned().await {
                            Ok(permit) => {
                                // The sender drops a permit acquired after the send deadline because issuing then would inflate throughput measured over the fixed window.
                                if Instant::now() >= send_deadline {
                                    break;
                                }
                                permit
                            }
                            Err(_) => break,
                        }
                    }
                };
                permit.forget();
                corr += 1;
                k += 1;
                let scheduled_ns = scheduled.duration_since(start).as_nanos() as u64;
                // The RTT measurement starts after the sender acquires an in-flight permit.
                let issue_ns = Instant::now().duration_since(start).as_nanos() as u64;
                // Open-loop classification uses scheduled time so scheduler lag cannot move a pre-warmup arrival into the measured window.
                // Classifying a late open-loop request by issue time moves pre-warmup arrivals into the measured distribution under scheduler lag.
                let window_ns = if rate > 0 { scheduled_ns } else { issue_ns };
                if meta_tx.send((corr, scheduled_ns, issue_ns)).is_err() {
                    break;
                }
                let mut frame = raw_client::header(
                    body.len() as u32,
                    TY_REQUEST,
                    FLAGS_INTERACTIVE,
                    channel,
                    epoch,
                    corr,
                );
                frame.extend_from_slice(&body);
                if write_half.write_all(&frame).await.is_err() {
                    // The sender marks the request terminal so the reader records `WriteFailure` instead of `UnresolvedAtDrain`.
                    if window_ns >= warmup_ns {
                        measured_sent.fetch_add(1, Ordering::Release);
                    }
                    let _ = meta_tx.send((corr, u64::MAX, issue_ns));
                    break;
                }
                sent_count.fetch_add(1, Ordering::Release);
                if window_ns >= warmup_ns {
                    measured_sent.fetch_add(1, Ordering::Release);
                }
            }
            sender_done.notify_one();
            (inflight_full, write_half)
        })
    };

    let mut result = ConnResult {
        issue_latencies_ns: Vec::new(),
        sched_latencies_ns: Vec::new(),
        sched_lag_ns: Vec::new(),
        sent: 0,
        measured_scheduled: 0,
        resolved: 0,
        outcomes: OutcomeCounts::default(),
        error_codes: HashMap::new(),
        closed_early: false,
        protocol_violation: None,
        inflight_full: 0,
    };
    let mut read_half = read_half;
    let mut pending: HashMap<u64, (u64, u64)> = HashMap::new();
    // Open-loop classification uses scheduled time, while closed-loop classification uses issue time, so scheduler lag cannot move a pre-warmup arrival into the measured window.
    let open_loop = opts.rate > 0;
    let in_window = move |sched: u64, issue: u64| {
        if open_loop {
            sched >= warmup_ns
        } else {
            issue >= warmup_ns
        }
    };
    let drain_meta = |meta_rx: &mut mpsc::UnboundedReceiver<(u64, u64, u64)>,
                      pending: &mut HashMap<u64, (u64, u64)>,
                      outcomes: &mut OutcomeCounts| {
        while let Ok((corr, sched, issue)) = meta_rx.try_recv() {
            if issue == u64::MAX {
                // A missed open-loop slot is terminal at the scheduler and has a scheduled time but no issue time.
                if sched >= warmup_ns {
                    outcomes.record(Outcome::MissedSlot);
                }
            } else if sched == u64::MAX {
                // The sender sends metadata before writing, so the write-failure marker can recover the scheduled and issue times from `pending`.
                if let Some((sched0, issue0)) = pending.remove(&corr) {
                    if in_window(sched0, issue0) {
                        outcomes.record(Outcome::WriteFailure);
                    }
                }
            } else {
                pending.insert(corr, (sched, issue));
            }
        }
    };
    let mut header = [0u8; raw_client::HEADER_LEN];
    let mut header_filled = 0usize;
    let mut body_buf: Vec<u8> = Vec::new();
    let mut pending_frame: Option<raw_client::RawFrame> = None;
    let mut body_filled = 0usize;
    let mut done_wait = false;
    let mut resolved: u64 = 0;
    let mut drain_deadline: Option<Instant> = None;

    loop {
        // `read` is cancellation-safe, so cancelling a select branch retains partial frame bytes and cannot desynchronize the frame stream; the drain deadline bounds peers that stall mid-body.
        let read = tokio::select! {
            biased;
            read = async {
                match &pending_frame {
                    Some(frame) => {
                        read_half
                            .read(&mut body_buf[body_filled..frame.len as usize])
                            .await
                    }
                    None => read_half.read(&mut header[header_filled..]).await,
                }
            } => Some(read),
            () = sender_done.notified(), if !done_wait => {
                done_wait = true;
                drain_deadline = Some(Instant::now() + DRAIN_BUDGET);
                None
            }
            // The start-armed backstop ends runs when a peer withholds responses: saturated closed-loop senders wait on permits and never arm the sender-driven drain deadline.
            () = tokio::time::sleep_until((send_deadline + DRAIN_BUDGET).into()),
                if !done_wait =>
            {
                drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
                for (_, (sched, issue)) in pending.drain() {
                    if in_window(sched, issue) {
                        result.outcomes.record(Outcome::UnresolvedAtDrain);
                    }
                }
                result.closed_early = true;
                break;
            }
            () = async {
                match drain_deadline {
                    Some(at) => tokio::time::sleep_until(at.into()).await,
                    None => std::future::pending().await,
                }
            }, if done_wait => {
                // The reader records every pending request as `UnresolvedAtDrain` when the drain budget expires.
                // The reader rejects peer-controlled frame lengths before allocation to bound memory use.
                drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
                for (_, (sched, issue)) in pending.drain() {
                    if in_window(sched, issue) {
                        result.outcomes.record(Outcome::UnresolvedAtDrain);
                    }
                }
                break;
            }
        };
        let Some(read) = read else {
            if resolved >= sent_count.load(Ordering::Acquire) {
                break;
            }
            continue;
        };
        match read {
            Ok(0) | Err(_) => {
                result.closed_early = true;
                break;
            }
            Ok(n) => {
                if let Some(frame_len) = pending_frame.as_ref().map(|f| f.len as usize) {
                    body_filled += n;
                    if body_filled < frame_len {
                        continue;
                    }
                    body_filled = 0;
                } else {
                    header_filled += n;
                    if header_filled < raw_client::HEADER_LEN {
                        continue;
                    }
                    header_filled = 0;
                    let frame = raw_client::decode_header(&header);
                    // The reader fails the connection because the stream cannot resynchronize past the unread body.
                    if frame.len > max_response_len {
                        result.closed_early = true;
                        break;
                    }
                    body_buf.resize(frame.len as usize, 0);
                    pending_frame = Some(frame);
                    if !body_buf.is_empty() {
                        continue;
                    }
                }
            }
        }
        let frame = pending_frame.take().expect("frame body completed");
        let now_ns = Instant::now().duration_since(start).as_nanos() as u64;
        drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
        // Only RESPONSE, ERROR, STREAM_DATA, and STREAM_END may resolve pending requests; PING, PUSH, and GOODBYE may be unsolicited; all other types violate the protocol.
        // wire-protocol regression.
        if !matches!(
            frame.ty,
            TY_RESPONSE | TY_ERROR | raw_client::TY_STREAM_DATA | raw_client::TY_STREAM_END
        ) {
            if matches!(
                frame.ty,
                raw_client::TY_PING | raw_client::TY_PUSH | raw_client::TY_GOODBYE
            ) {
                // Skipped connection frames must have a valid version, pure-header shape, and matching `(channel, epoch, corr)`.
                if let Some(violation) = raw_client::connection_frame_violation(&frame) {
                    result.protocol_violation = Some(violation);
                    result.closed_early = true;
                    break;
                }
                // GOODBYE for `(channel, epoch)` or `(0, 0)` closes the connection.
                if frame.ty == raw_client::TY_GOODBYE
                    && ((frame.channel, frame.epoch) == (channel, epoch)
                        || (frame.channel == 0 && frame.epoch == 0))
                {
                    result.closed_early = true;
                    break;
                }
                continue;
            }
            result.protocol_violation = Some(format!("server-illegal frame type {}", frame.ty));
            result.closed_early = true;
            break;
        }
        let Some((sched, issue)) = pending.remove(&frame.corr) else {
            result.protocol_violation = Some(format!(
                "unsolicited terminal for correlation {}",
                frame.corr
            ));
            result.closed_early = true;
            break;
        };
        inflight.add_permits(1);
        resolved += 1;
        let measured = in_window(sched, issue);
        // Warmup validation failures set protocol_violation instead of recording an outcome.
        macro_rules! record_failure {
            ($outcome:expr, $label:expr) => {
                if measured {
                    result.outcomes.record($outcome);
                } else {
                    result.protocol_violation =
                        Some(format!("warmup response failed validation ({})", $label));
                    result.closed_early = true;
                    break;
                }
            };
        }
        // The wire identity is `(channel, epoch, corr)`.
        // A terminal on the wrong channel, epoch, or wire version is a protocol failure.
        if (frame.channel, frame.epoch) != (channel, epoch) || frame.ver != raw_client::WIRE_VERSION
        {
            record_failure!(Outcome::UnexpectedFrame, "route or version mismatch");
            if done_wait && resolved >= sent_count.load(Ordering::Acquire) {
                break;
            }
            continue;
        }
        match frame.ty {
            TY_RESPONSE => {
                // A successful terminal response must use `FLAGS_RESPONSE_TEXT_LAST`.
                if frame.flags != raw_client::FLAGS_RESPONSE_TEXT_LAST {
                    record_failure!(Outcome::UnexpectedFrame, "response flags");
                } else if expect_fixture && body_buf.as_slice() != FIXTURE_BODY {
                    record_failure!(Outcome::BodyMismatch, "fixture body");
                } else if !expect_fixture && body_buf.as_slice() != body.as_slice() {
                    // The raw echo contract compares bodies byte-for-byte.
                    // Same-length corruption is a body mismatch.
                    // echo either.
                    record_failure!(Outcome::BodyMismatch, "raw echo bytes");
                } else if measured {
                    result.outcomes.record(Outcome::Success);
                    result.issue_latencies_ns.push(now_ns.saturating_sub(issue));
                    if opts.rate > 0 {
                        result.sched_latencies_ns.push(now_ns.saturating_sub(sched));
                        result.sched_lag_ns.push(issue.saturating_sub(sched));
                    }
                }
            }
            TY_ERROR => {
                let code = serde_json::from_slice::<serde_json::Value>(&body_buf)
                    .ok()
                    .and_then(|v| v["code"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unparsable".to_owned());
                *result.error_codes.entry(code).or_default() += 1;
                record_failure!(Outcome::ProtocolError, "error terminal");
            }
            _ => {
                record_failure!(Outcome::UnexpectedFrame, "stream terminal");
            }
        }
        if done_wait && resolved >= sent_count.load(Ordering::Acquire) {
            break;
        }
    }

    // The reader returns permits before it exits so senders blocked on a saturated window cannot wait forever.
    inflight.close();

    // A bounded sender join prevents write_all from wedging the run after the peer stops reading.
    let mut sender = sender;
    result.inflight_full = match tokio::time::timeout(DRAIN_BUDGET, &mut sender).await {
        Ok(Ok((count, _write_half))) => count,
        Ok(Err(_)) => 0,
        Err(_) => {
            sender.abort();
            result.closed_early = true;
            0
        }
    };
    // The reader drains metadata after the sender exits so queued write-failure and missed-slot markers are not missed.
    drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
    // When the sender times out, the reader records `Outcome::PeerClosed` for each remaining request in the measurement window.
    if result.closed_early {
        for (_, (sched, issue)) in pending.drain() {
            if in_window(sched, issue) {
                result.outcomes.record(Outcome::PeerClosed);
            }
        }
    }

    result.sent = sent_count.load(Ordering::Acquire);
    result.measured_scheduled = measured_sent.load(Ordering::Acquire);
    result.resolved = resolved;
    result
}

async fn run_stall(info: raw_client::Discovered, opts: Opts) {
    let (stream, channel, epoch) = open_route(&info, "stall").await;
    let (_read_half, mut write_half) = stream.into_split();
    let body = vec![0u8; opts.payload.max(5)];
    for corr in 1..=opts.stall_big as u64 {
        let header = raw_client::header(
            body.len() as u32,
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
        );
        write_half.write_all(&header).await.expect("stall header");
        if write_half.write_all(&body).await.is_err() {
            println!("STALL retired early by host (expected under write deadline)");
            return;
        }
    }
    println!(
        "STALL sent={} payload={} holding_secs={}",
        opts.stall_big, opts.payload, opts.secs
    );
    tokio::time::sleep(Duration::from_secs(opts.secs)).await;
}

fn ms(ns: u64) -> f64 {
    ns as f64 / 1_000_000.0
}

fn print_latency(kind: &str, samples: Vec<u64>) {
    let Some(summary) = LatencySummary::from_unsorted(samples) else {
        println!("LATENCY_MS kind={kind} count=0");
        return;
    };
    let p999 = summary
        .p999_ns
        .map(|v| format!("{:.3}", ms(v)))
        .unwrap_or_else(|| "suppressed(below-tail-floor)".to_owned());
    println!(
        "LATENCY_MS kind={kind} count={} p50={:.3} p90={:.3} p99={:.3} p999={} max={:.3}",
        summary.count,
        ms(summary.p50_ns),
        ms(summary.p90_ns),
        ms(summary.p99_ns),
        p999,
        ms(summary.max_ns),
    );
}

#[tokio::main]
async fn main() {
    let opts = parse_opts();
    if opts.rate > 0 {
        // The client fails malformed offered rates before generating traffic.
        validate_open_loop_rate(opts.rate).expect("offered rate");
    }
    let info = raw_client::discover(&opts.publication).expect("publication");

    if opts.stall_big > 0 {
        run_stall(info, opts).await;
        return;
    }

    let warmup = Duration::from_secs(opts.secs) / 10;
    let mut conns = Vec::new();
    for idx in 0..opts.conns {
        conns.push(open_route(&info, &format!("load-{idx}")).await);
    }
    let start = Instant::now();
    let mut tasks = Vec::new();
    for (idx, conn) in conns.into_iter().enumerate() {
        tasks.push(tokio::spawn(run_conn(
            conn,
            idx,
            opts.clone(),
            start,
            warmup,
        )));
    }

    let mut issue_latencies = Vec::new();
    let mut sched_latencies = Vec::new();
    let mut lags = Vec::new();
    let mut sent = 0u64;
    let mut measured_scheduled = 0u64;
    let mut outcomes = OutcomeCounts::default();
    let mut error_codes: HashMap<String, u64> = HashMap::new();
    let mut closed = 0usize;
    let mut inflight_full = 0u64;
    let mut completed = 0u64;
    let mut protocol_violation: Option<String> = None;
    for task in tasks {
        let conn = task.await.expect("conn task");
        issue_latencies.extend(conn.issue_latencies_ns);
        sched_latencies.extend(conn.sched_latencies_ns);
        lags.extend(conn.sched_lag_ns);
        sent += conn.sent;
        measured_scheduled += conn.measured_scheduled;
        closed += usize::from(conn.closed_early);
        inflight_full += conn.inflight_full;
        completed += conn.resolved;
        if protocol_violation.is_none() {
            protocol_violation = conn.protocol_violation;
        }
        for (code, count) in conn.error_codes {
            *error_codes.entry(code).or_default() += count;
        }
        let c = conn.outcomes;
        outcomes.merge(&c);
    }

    let measured_secs = opts.secs as f64 * 0.9;
    let loop_kind = if opts.rate > 0 {
        "open"
    } else if opts.pipeline == 1 {
        "serial"
    } else {
        "closed"
    };
    let workload = match opts.workload {
        Workload::Raw => "raw-legacy",
        Workload::Json => perf_measurement::FIXTURE_LABEL,
    };
    let payload_bytes = body_bytes(&opts).len();
    println!(
        "RESULT label={} loop={} workload={} conns={} payload={} rate={} pipeline={} secs={} \
         sent={} completed={} measured={} closed_early={} inflight_full={} errors={:?}",
        opts.label,
        loop_kind,
        workload,
        opts.conns,
        payload_bytes,
        opts.rate,
        opts.pipeline,
        opts.secs,
        sent,
        completed,
        issue_latencies.len(),
        closed,
        inflight_full,
        error_codes,
    );
    println!(
        "OUTCOMES scheduled={} success={} protocol_error={} missed_slot={} write_failure={} \
         peer_closed={} unexpected_frame={} body_mismatch={} unresolved_at_drain={} \
         histogram_overflow={} conserved={}",
        measured_scheduled,
        outcomes.success,
        outcomes.protocol_error,
        outcomes.missed_slot,
        outcomes.write_failure,
        outcomes.peer_closed,
        outcomes.unexpected_frame,
        outcomes.body_mismatch,
        outcomes.unresolved_at_drain,
        outcomes.histogram_overflow,
        outcomes.conserved(measured_scheduled),
    );
    let conserved = outcomes.conserved(measured_scheduled);

    print_latency("issue_to_completion", issue_latencies.clone());
    if opts.rate > 0 {
        print_latency("sched_to_completion", sched_latencies);
        print_latency("scheduler_lag", lags);
    }
    println!(
        "THROUGHPUT completed_rps={:.0}",
        outcomes.success as f64 / measured_secs,
    );

    if !conserved {
        eprintln!("outcome-accounting loss: aborting with failure status");
        std::process::exit(1);
    }
    if let Some(reason) = protocol_violation {
        eprintln!("wire-protocol violation: {reason}: aborting with failure status");
        std::process::exit(1);
    }
    let correctness_failures =
        outcomes.protocol_error + outcomes.body_mismatch + outcomes.unexpected_frame;
    if correctness_failures > 0 {
        eprintln!(
            "{correctness_failures} correctness violation(s) in measured outcomes: \
             aborting with failure status"
        );
        std::process::exit(1);
    }
    let transport_failures =
        outcomes.peer_closed + outcomes.write_failure + outcomes.unresolved_at_drain;
    if closed > 0 || transport_failures > 0 {
        eprintln!(
            "{closed} connection(s) retired before the requested window \
             ({transport_failures} transport-failure outcome(s)): aborting with failure status"
        );
        std::process::exit(1);
    }
    if outcomes.success == 0 {
        eprintln!("no successful measured observation: aborting with failure status");
        std::process::exit(1);
    }
}
