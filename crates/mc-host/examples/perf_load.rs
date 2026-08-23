//! This binary drives the perf-harness host over loopback TCP.
//! docs/perf/mc-host-baseline.md defines the historical benchmark arms;
//! the shared measurement contract lives in
//! `tests/support/perf_measurement.rs`.
//!
//! Timing semantics: issue time is captured after admission and
//! immediately before frame construction. Closed-loop arms report
//! issue-to-validated-terminal latency (serial mode, `--pipeline 1` via
//! `--serial`, is the only closed-loop shape whose value is an RTT).
//! Open-loop arms report scheduled-to-completion, issue-to-completion, and
//! scheduler-lag distributions separately, preserving the original arrival
//! schedule. Every scheduled request resolves to exactly one terminal
//! outcome.

#[path = "../tests/support/raw_client.rs"]
mod raw_client;

#[path = "../tests/support/perf_measurement.rs"]
mod perf_measurement;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use perf_measurement::{
    open_loop_interval_ns, LatencySummary, Outcome, OutcomeCounts, FIXTURE_BODY,
};
use raw_client::{RawClient, FLAGS_INTERACTIVE, TY_ERROR, TY_REQUEST, TY_RESPONSE};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};

const MODULE_ID: &str = "perf-echo";
/// Bound on post-send drain before pending requests resolve as
/// `UnresolvedAtDrain`; the drain loop can never hang on a lost response.
const DRAIN_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Workload {
    /// Legacy raw body (mode byte + optional sleep), non-comparable with
    /// the JSON fixture arms.
    Raw,
    /// Committed compact JSON fixture; terminal bodies are validated
    /// against the fixture bytes before counting success.
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
    /// Issue-to-validated-terminal (closed loop: the primary value; open
    /// loop: the issue-based distribution).
    issue_latencies_ns: Vec<u64>,
    /// Scheduled-to-completion (open loop only; coordinated-omission
    /// honest).
    sched_latencies_ns: Vec<u64>,
    /// Issue minus scheduled: load-generator lag, never server latency.
    sched_lag_ns: Vec<u64>,
    sent: u64,
    measured_scheduled: u64,
    outcomes: OutcomeCounts,
    error_codes: HashMap<String, u64>,
    closed_early: bool,
    inflight_full: u64,
}

async fn open_route(
    info: &raw_client::Discovered,
    session: &str,
) -> (tokio::net::TcpStream, u16, u32) {
    let mut client = RawClient::connect(info).await.expect("auth");
    let (channel, epoch) = client
        .route_open(MODULE_ID, "/perf", "perf", session)
        .await
        .expect("route");
    let stream = client.into_stream();
    stream.set_nodelay(true).expect("client nodelay");
    (stream, channel, epoch)
}

async fn run_conn(
    conn: (tokio::net::TcpStream, u16, u32),
    idx: usize,
    opts: Opts,
    start: Instant,
    warmup: Duration,
) -> ConnResult {
    let (stream, channel, epoch) = conn;
    let (read_half, mut write_half) = stream.into_split();
    let body = body_bytes(&opts);
    let expect_fixture = opts.workload == Workload::Json;

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
    let interval_ns = if opts.rate > 0 {
        open_loop_interval_ns(opts.rate).expect("offered rate") * opts.conns as u64
    } else {
        0
    };
    let warmup_ns = warmup.as_nanos() as u64;

    let sender = {
        let inflight = Arc::clone(&inflight);
        let sent_count = Arc::clone(&sent_count);
        let measured_sent = Arc::clone(&measured_sent);
        let sender_done = Arc::clone(&sender_done);
        let conns = opts.conns as u64;
        tokio::spawn(async move {
            let mut corr: u64 = 1_000_000;
            let mut k: u64 = 0;
            let mut inflight_full = 0u64;
            let offset_ns = if interval_ns > 0 {
                interval_ns * idx as u64 / conns
            } else {
                0
            };
            loop {
                // Open loop: the arrival schedule is absolute; a late wake
                // issues immediately (lag recorded), never a catch-up
                // burst of extra slots.
                let scheduled = if interval_ns > 0 {
                    let at = start + Duration::from_nanos(offset_ns + k * interval_ns);
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
                    Err(_) => {
                        inflight_full += 1;
                        match inflight.clone().acquire_owned().await {
                            Ok(permit) => permit,
                            Err(_) => break,
                        }
                    }
                };
                permit.forget();
                corr += 1;
                k += 1;
                let scheduled_ns = scheduled.duration_since(start).as_nanos() as u64;
                // The measured RTT starts here: after the in-flight permit
                // wait, immediately before frame construction.
                let issue_ns = Instant::now().duration_since(start).as_nanos() as u64;
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
                    // The slot is scheduled and terminal: mark it so the
                    // reader records WriteFailure instead of letting the
                    // stale meta entry rot into UnresolvedAtDrain.
                    if issue_ns >= warmup_ns {
                        measured_sent.fetch_add(1, Ordering::Release);
                    }
                    let _ = meta_tx.send((corr, u64::MAX, issue_ns));
                    break;
                }
                sent_count.fetch_add(1, Ordering::Release);
                if issue_ns >= warmup_ns {
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
        outcomes: OutcomeCounts::default(),
        error_codes: HashMap::new(),
        closed_early: false,
        inflight_full: 0,
    };
    let mut read_half = read_half;
    let mut pending: HashMap<u64, (u64, u64)> = HashMap::new();
    let drain_meta = |meta_rx: &mut mpsc::UnboundedReceiver<(u64, u64, u64)>,
                      pending: &mut HashMap<u64, (u64, u64)>,
                      outcomes: &mut OutcomeCounts| {
        while let Ok((corr, sched, issue)) = meta_rx.try_recv() {
            if sched == u64::MAX {
                pending.remove(&corr);
                if issue >= warmup_ns {
                    outcomes.record(Outcome::WriteFailure);
                }
            } else {
                pending.insert(corr, (sched, issue));
            }
        }
    };
    let mut header = [0u8; raw_client::HEADER_LEN];
    let mut header_filled = 0usize;
    let mut body_buf: Vec<u8> = Vec::new();
    let mut done_wait = false;
    let mut resolved: u64 = 0;
    let mut drain_deadline: Option<Instant> = None;

    loop {
        // `read` (unlike `read_exact`) is cancellation-safe: a cancelled
        // branch loses no partially read header bytes, so the other
        // select arms can win without desyncing the frame stream.
        let read = tokio::select! {
            biased;
            read = read_half.read(&mut header[header_filled..]) => Some(read),
            () = sender_done.notified(), if !done_wait => {
                done_wait = true;
                drain_deadline = Some(Instant::now() + DRAIN_BUDGET);
                None
            }
            () = async {
                match drain_deadline {
                    Some(at) => tokio::time::sleep_until(at.into()).await,
                    None => std::future::pending().await,
                }
            }, if done_wait => {
                // Drain budget exhausted: everything still pending is a
                // terminal unresolved outcome.
                drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
                for (_, (_, issue)) in pending.drain() {
                    if issue >= warmup_ns {
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
                header_filled += n;
                if header_filled < raw_client::HEADER_LEN {
                    continue;
                }
                header_filled = 0;
            }
        }
        let frame = raw_client::decode_header(&header);
        body_buf.resize(frame.len as usize, 0);
        if frame.len > 0 && read_half.read_exact(&mut body_buf).await.is_err() {
            result.closed_early = true;
            break;
        }
        let now_ns = Instant::now().duration_since(start).as_nanos() as u64;
        drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
        let Some((sched, issue)) = pending.remove(&frame.corr) else {
            continue;
        };
        inflight.add_permits(1);
        resolved += 1;
        let measured = issue >= warmup_ns;
        match frame.ty {
            TY_RESPONSE => {
                let valid = !expect_fixture || body_buf.as_slice() == FIXTURE_BODY;
                if !valid {
                    if measured {
                        result.outcomes.record(Outcome::BodyMismatch);
                    }
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
                if measured {
                    result.outcomes.record(Outcome::ProtocolError);
                }
                let code = serde_json::from_slice::<serde_json::Value>(&body_buf)
                    .ok()
                    .and_then(|v| v["code"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unparsable".to_owned());
                *result.error_codes.entry(code).or_default() += 1;
            }
            _ => {
                if measured {
                    result.outcomes.record(Outcome::UnexpectedFrame);
                }
            }
        }
        if done_wait && resolved >= sent_count.load(Ordering::Acquire) {
            break;
        }
    }

    // The reader owns permit returns; once it exits, a parked sender
    // would otherwise wait forever on a saturated window.
    inflight.close();

    // A closed connection resolves every remaining in-flight request.
    if result.closed_early {
        drain_meta(&mut meta_rx, &mut pending, &mut result.outcomes);
        for (_, (_, issue)) in pending.drain() {
            if issue >= warmup_ns {
                result.outcomes.record(Outcome::PeerClosed);
            }
        }
    }

    result.inflight_full = sender.await.map(|(count, _write_half)| count).unwrap_or(0);
    result.sent = sent_count.load(Ordering::Acquire);
    result.measured_scheduled = measured_sent.load(Ordering::Acquire);
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
        // Fail malformed offered rates before any traffic is generated.
        open_loop_interval_ns(opts.rate).expect("offered rate");
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
    for task in tasks {
        let conn = task.await.expect("conn task");
        issue_latencies.extend(conn.issue_latencies_ns);
        sched_latencies.extend(conn.sched_latencies_ns);
        lags.extend(conn.sched_lag_ns);
        sent += conn.sent;
        measured_scheduled += conn.measured_scheduled;
        closed += usize::from(conn.closed_early);
        inflight_full += conn.inflight_full;
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
    println!(
        "RESULT label={} loop={} workload={} conns={} payload={} rate={} pipeline={} secs={} \
         sent={} completed={} measured={} closed_early={} inflight_full={} errors={:?}",
        opts.label,
        loop_kind,
        workload,
        opts.conns,
        opts.payload,
        opts.rate,
        opts.pipeline,
        opts.secs,
        sent,
        outcomes.success,
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
}
