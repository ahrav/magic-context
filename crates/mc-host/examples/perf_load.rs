//! This binary drives the perf-harness host over loopback TCP.
//! docs/perf/mc-host-baseline.md defines the benchmark arms and metrics.

#[path = "../tests/support/raw_client.rs"]
mod raw_client;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use raw_client::{RawClient, FLAGS_INTERACTIVE, TY_ERROR, TY_REQUEST, TY_RESPONSE};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};

const MODULE_ID: &str = "perf-echo";

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
    };
    let mut args = std::env::args().skip(1);
    opts.publication = args
        .next()
        .expect("usage: perf_load <publication> ...")
        .into();
    while let Some(flag) = args.next() {
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
            other => panic!("unknown flag {other}"),
        }
    }
    opts
}

fn body_bytes(opts: &Opts) -> Vec<u8> {
    let len = opts.payload.max(5);
    let mut body = vec![0u8; len];
    body[0] = if opts.sleep_ms > 0 { 1 } else { 0 };
    body[1..5].copy_from_slice(&opts.sleep_ms.to_le_bytes());
    body
}

struct ConnResult {
    latencies_ns: Vec<u64>,
    sent: u64,
    completed: u64,
    errors: HashMap<String, u64>,
    closed_early: bool,
    sched_lag_ns: Vec<u64>,
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

    let inflight = Arc::new(Semaphore::new(if opts.rate > 0 {
        opts.inflight_cap
    } else {
        opts.pipeline
    }));
    let (meta_tx, mut meta_rx) = mpsc::unbounded_channel::<(u64, u64, u64)>();
    let sent_count = Arc::new(AtomicU64::new(0));
    let sender_done = Arc::new(tokio::sync::Notify::new());

    let send_deadline = start + Duration::from_secs(opts.secs);
    let interval_ns = (1_000_000_000u64 * opts.conns as u64)
        .checked_div(opts.rate)
        .unwrap_or(0);

    let sender = {
        let inflight = Arc::clone(&inflight);
        let sent_count = Arc::clone(&sent_count);
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
                let sent_ns = Instant::now().duration_since(start).as_nanos() as u64;
                if meta_tx.send((corr, scheduled_ns, sent_ns)).is_err() {
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
                    break;
                }
                sent_count.fetch_add(1, Ordering::Release);
            }
            sender_done.notify_one();
            (inflight_full, write_half)
        })
    };

    let mut result = ConnResult {
        latencies_ns: Vec::new(),
        sent: 0,
        completed: 0,
        errors: HashMap::new(),
        closed_early: false,
        sched_lag_ns: Vec::new(),
        inflight_full: 0,
    };
    let mut read_half = read_half;
    let mut pending: HashMap<u64, (u64, u64)> = HashMap::new();
    let mut header = [0u8; raw_client::HEADER_LEN];
    let mut body_buf: Vec<u8> = Vec::new();
    let mut done_wait = false;
    let warmup_ns = warmup.as_nanos() as u64;

    loop {
        let read = tokio::select! {
            biased;
            read = read_half.read_exact(&mut header) => Some(read),
            () = sender_done.notified(), if !done_wait => { done_wait = true; None }
        };
        let Some(read) = read else {
            if result.completed + result.errors.values().sum::<u64>()
                >= sent_count.load(Ordering::Acquire)
            {
                break;
            }
            continue;
        };
        if read.is_err() {
            result.closed_early = true;
            break;
        }
        let frame = raw_client::decode_header(&header);
        body_buf.resize(frame.len as usize, 0);
        if read_half.read_exact(&mut body_buf).await.is_err() {
            result.closed_early = true;
            break;
        }
        let now_ns = Instant::now().duration_since(start).as_nanos() as u64;
        while let Ok((corr, sched, sent)) = meta_rx.try_recv() {
            pending.insert(corr, (sched, sent));
        }
        let Some((sched, sent)) = pending.remove(&frame.corr) else {
            continue;
        };
        inflight.add_permits(1);
        match frame.ty {
            TY_RESPONSE => {
                if sched >= warmup_ns {
                    result.latencies_ns.push(now_ns.saturating_sub(sched));
                    result.sched_lag_ns.push(sent.saturating_sub(sched));
                }
                result.completed += 1;
            }
            TY_ERROR => {
                let code = serde_json::from_slice::<serde_json::Value>(&body_buf)
                    .ok()
                    .and_then(|v| v["code"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unparsable".to_owned());
                *result.errors.entry(code).or_default() += 1;
            }
            _ => {}
        }
        if done_wait
            && result.completed + result.errors.values().sum::<u64>()
                >= sent_count.load(Ordering::Acquire)
        {
            break;
        }
    }

    result.inflight_full = sender.await.map(|(count, _write_half)| count).unwrap_or(0);
    result.sent = sent_count.load(Ordering::Acquire);
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

fn pct(sorted: &[u64], q: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[rank]
}

fn ms(ns: u64) -> f64 {
    ns as f64 / 1_000_000.0
}

#[tokio::main]
async fn main() {
    let opts = parse_opts();
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

    let mut latencies = Vec::new();
    let mut lags = Vec::new();
    let mut sent = 0u64;
    let mut completed = 0u64;
    let mut errors: HashMap<String, u64> = HashMap::new();
    let mut closed = 0usize;
    let mut inflight_full = 0u64;
    for task in tasks {
        let conn = task.await.expect("conn task");
        latencies.extend(conn.latencies_ns);
        lags.extend(conn.sched_lag_ns);
        sent += conn.sent;
        completed += conn.completed;
        closed += usize::from(conn.closed_early);
        inflight_full += conn.inflight_full;
        for (code, count) in conn.errors {
            *errors.entry(code).or_default() += count;
        }
    }
    latencies.sort_unstable();
    lags.sort_unstable();

    let measured_secs = opts.secs as f64 * 0.9;
    let loop_kind = if opts.rate > 0 { "open" } else { "closed" };
    println!(
        "RESULT label={} loop={} conns={} payload={} rate={} pipeline={} secs={} \
         sent={} completed={} measured={} closed_early={} inflight_full={} errors={:?}",
        opts.label,
        loop_kind,
        opts.conns,
        opts.payload,
        opts.rate,
        opts.pipeline,
        opts.secs,
        sent,
        completed,
        latencies.len(),
        closed,
        inflight_full,
        errors,
    );
    println!(
        "LATENCY_MS p50={:.3} p90={:.3} p99={:.3} p999={:.3} max={:.3} mean={:.3} \
         sched_lag_p99={:.3} throughput_rps={:.0}",
        ms(pct(&latencies, 0.50)),
        ms(pct(&latencies, 0.90)),
        ms(pct(&latencies, 0.99)),
        ms(pct(&latencies, 0.999)),
        latencies.last().copied().map(ms).unwrap_or(0.0),
        if latencies.is_empty() {
            0.0
        } else {
            ms(latencies.iter().sum::<u64>() / latencies.len() as u64)
        },
        ms(pct(&lags, 0.99)),
        latencies.len() as f64 / measured_secs,
    );
}
