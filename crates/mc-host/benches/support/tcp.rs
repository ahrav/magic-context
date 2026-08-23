//! TCP measurement arms for the IPC budget: serial RTT, open-loop loaded
//! latency, and timestamp-minimal closed-loop throughput.
//!
//! All arms speak the production wire through the independent raw client,
//! authenticate once, open one route, and echo the committed compact JSON
//! fixture. Serial RTT is issue-to-validated-terminal with exactly one
//! request in flight; loaded latency keeps scheduled-to-completion,
//! issue-to-completion, and scheduler lag as separate distributions;
//! throughput timestamps only the window boundaries.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::evidence::HistogramConfig;
use super::perf_measurement::{open_loop_interval_ns, Outcome, OutcomeCounts, FIXTURE_BODY};
use super::raw_client::{self, RawClient, FLAGS_INTERACTIVE, TY_ERROR, TY_RESPONSE};

const MODULE_ID: &str = "perf-echo";
const CORR_BASE: u64 = 1_000_000;
/// Bound on post-window drain before pending requests resolve as
/// `UnresolvedAtDrain`.
const DRAIN_BUDGET: Duration = Duration::from_secs(5);

/// Records one latency into a fixed-range histogram; a value outside the
/// range is a `HistogramOverflow` terminal outcome, never an auto-resize.
fn record(hist: &mut Histogram<u64>, outcomes: &mut OutcomeCounts, value_ns: u64) {
    if hist.record(value_ns).is_ok() {
        outcomes.record(Outcome::Success);
    } else {
        outcomes.record(Outcome::HistogramOverflow);
    }
}

/// Classifies one non-ping terminal frame against the fixture contract.
fn classify_terminal(ty: u8, body: &[u8]) -> Outcome {
    match ty {
        TY_RESPONSE if body == FIXTURE_BODY => Outcome::Success,
        TY_RESPONSE => Outcome::BodyMismatch,
        TY_ERROR => Outcome::ProtocolError,
        _ => Outcome::UnexpectedFrame,
    }
}

/// Incremental header reader whose progress survives `select!`
/// cancellation: each await is one `read` call, so a cancelled branch
/// never discards partially read header bytes (`read_exact` is not
/// cancellation-safe and would desync the stream).
struct HeaderReader {
    buf: [u8; raw_client::HEADER_LEN],
    filled: usize,
}

impl HeaderReader {
    fn new() -> Self {
        Self {
            buf: [0u8; raw_client::HEADER_LEN],
            filled: 0,
        }
    }

    /// Reads at most once; returns the decoded frame header when complete.
    async fn step<R: tokio::io::AsyncRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> std::io::Result<Option<raw_client::RawFrame>> {
        let n = reader.read(&mut self.buf[self.filled..]).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        self.filled += n;
        if self.filled < raw_client::HEADER_LEN {
            return Ok(None);
        }
        self.filled = 0;
        Ok(Some(raw_client::decode_header(&self.buf)))
    }
}

/// One authenticated connection with one open route to the echo module.
async fn open_route(publication: &Path, session: &str) -> Result<(TcpStream, u16, u32), String> {
    let info = raw_client::discover(publication)?;
    let mut client = RawClient::connect(&info).await?;
    let (channel, epoch) = client
        .route_open(MODULE_ID, "/perf", "perf", session)
        .await?;
    let stream = client.into_stream();
    stream.set_nodelay(true).map_err(|err| err.to_string())?;
    Ok((stream, channel, epoch))
}

fn request_frame(channel: u16, epoch: u32, corr: u64) -> Vec<u8> {
    let mut frame = raw_client::header(
        FIXTURE_BODY.len() as u32,
        raw_client::TY_REQUEST,
        FLAGS_INTERACTIVE,
        channel,
        epoch,
        corr,
    );
    frame.extend_from_slice(FIXTURE_BODY);
    frame
}

#[derive(Debug, Clone)]
pub struct SerialConfig {
    pub warmup_ops: u64,
    pub measured_ops: u64,
    pub histogram: HistogramConfig,
}

#[derive(Debug)]
pub struct SerialResult {
    pub histogram: Histogram<u64>,
    pub outcomes: OutcomeCounts,
    pub scheduled: u64,
    pub elapsed: Duration,
}

/// Serial loopback RTT: one established connection, one request in flight,
/// issue-to-validated-terminal timing that excludes authentication and
/// route setup. Warmup operations run on the same connection but are not
/// recorded.
pub fn run_serial(publication: &Path, cfg: &SerialConfig) -> Result<SerialResult, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(run_serial_inner(publication, cfg))
}

async fn run_serial_inner(publication: &Path, cfg: &SerialConfig) -> Result<SerialResult, String> {
    let (mut stream, channel, epoch) = open_route(publication, "budget-serial").await?;
    let mut hist = cfg.histogram.build()?;
    let mut outcomes = OutcomeCounts::default();
    let mut header = [0u8; raw_client::HEADER_LEN];
    let mut body = Vec::new();
    let total = cfg.warmup_ops + cfg.measured_ops;
    let mut measured_scheduled = 0u64;
    let window_start = Instant::now();

    for op in 0..total {
        let corr = CORR_BASE + op + 1;
        let frame = request_frame(channel, epoch, corr);
        let measured = op >= cfg.warmup_ops;
        if measured {
            measured_scheduled += 1;
        }
        // The RTT boundary starts here: after admission and immediately
        // before the write, so permit or setup waits never count.
        let issue = Instant::now();
        if stream.write_all(&frame).await.is_err() {
            if measured {
                outcomes.record(Outcome::WriteFailure);
            }
            return finish_serial(hist, outcomes, measured_scheduled, window_start);
        }
        loop {
            if stream.read_exact(&mut header).await.is_err() {
                if measured {
                    outcomes.record(Outcome::PeerClosed);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            }
            let decoded = raw_client::decode_header(&header);
            body.resize(decoded.len as usize, 0);
            if decoded.len > 0 && stream.read_exact(&mut body).await.is_err() {
                if measured {
                    outcomes.record(Outcome::PeerClosed);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            }
            if decoded.corr != corr || decoded.ty == raw_client::TY_PING {
                continue;
            }
            let rtt_ns = issue.elapsed().as_nanos() as u64;
            if !measured {
                break;
            }
            match classify_terminal(decoded.ty, &body) {
                Outcome::Success => record(&mut hist, &mut outcomes, rtt_ns),
                other => outcomes.record(other),
            }
            break;
        }
    }
    finish_serial(hist, outcomes, measured_scheduled, window_start)
}

fn finish_serial(
    histogram: Histogram<u64>,
    outcomes: OutcomeCounts,
    measured_scheduled: u64,
    window_start: Instant,
) -> Result<SerialResult, String> {
    Ok(SerialResult {
        histogram,
        outcomes,
        scheduled: measured_scheduled,
        elapsed: window_start.elapsed(),
    })
}

#[derive(Debug, Clone)]
pub struct OpenLoopConfig {
    pub rate_per_sec: u64,
    pub warmup: Duration,
    pub measure: Duration,
    pub inflight_cap: usize,
    pub histogram: HistogramConfig,
}

#[derive(Debug)]
pub struct OpenLoopResult {
    /// Scheduled-send to validated-terminal (coordinated-omission honest).
    pub sched_to_completion: Histogram<u64>,
    /// Actual-issue to validated-terminal.
    pub issue_to_completion: Histogram<u64>,
    /// Issue minus scheduled: load-generator lag, kept separate so it is
    /// never mislabeled as server latency.
    pub scheduler_lag: Histogram<u64>,
    pub outcomes: OutcomeCounts,
    pub scheduled_slots: u64,
    pub elapsed: Duration,
    /// True when the connection failed before the warmup+measure window
    /// completed. Conservation still holds over the slots reached, so a
    /// caller must check this flag to reject the partial window.
    pub truncated: bool,
}

/// Open-loop loaded latency at one frozen offered rate. The arrival
/// schedule is absolute: a slot whose permit is unavailable is a missed
/// slot, never a catch-up burst.
pub fn run_open_loop(publication: &Path, cfg: &OpenLoopConfig) -> Result<OpenLoopResult, String> {
    let interval_ns = open_loop_interval_ns(cfg.rate_per_sec)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(run_open_loop_inner(publication, cfg, interval_ns))
}

async fn run_open_loop_inner(
    publication: &Path,
    cfg: &OpenLoopConfig,
    interval_ns: u64,
) -> Result<OpenLoopResult, String> {
    let (stream, channel, epoch) = open_route(publication, "budget-open").await?;
    let (mut read_half, mut write_half) = stream.into_split();

    let start = Instant::now();
    let mut state = OpenLoopState {
        sched_hist: cfg.histogram.build()?,
        issue_hist: cfg.histogram.build()?,
        lag_hist: cfg.histogram.build()?,
        outcomes: OutcomeCounts::default(),
        pending: HashMap::new(),
        start,
        warmup_ns: cfg.warmup.as_nanos() as u64,
        body: Vec::new(),
    };
    let deadline_ns = (cfg.warmup + cfg.measure).as_nanos() as u64;
    let mut scheduled_slots = 0u64;
    let mut truncated = false;
    let mut header = HeaderReader::new();
    let mut slot = 0u64;

    'sender: loop {
        let scheduled_ns = slot * interval_ns;
        slot += 1;
        if scheduled_ns >= deadline_ns {
            break;
        }
        let at = start + Duration::from_nanos(scheduled_ns);
        // Drain any ready responses while waiting for the next slot.
        loop {
            let now = Instant::now();
            if now >= at {
                break;
            }
            tokio::select! {
                () = tokio::time::sleep_until(at.into()) => break,
                step = header.step(&mut read_half) => {
                    match step {
                        Ok(None) => {}
                        Ok(Some(frame)) => {
                            if state.consume(&mut read_half, frame).await.is_err() {
                                state.fail_pending(Outcome::PeerClosed);
                                truncated = true;
                                break 'sender;
                            }
                        }
                        Err(_) => {
                            state.fail_pending(Outcome::PeerClosed);
                            truncated = true;
                            break 'sender;
                        }
                    }
                }
            }
        }
        let measured = scheduled_ns >= state.warmup_ns;
        if measured {
            scheduled_slots += 1;
        }
        if state.pending.len() >= cfg.inflight_cap {
            if measured {
                state.outcomes.record(Outcome::MissedSlot);
            }
            continue;
        }
        let corr = slot + CORR_BASE;
        let frame = request_frame(channel, epoch, corr);
        let issue_ns = start.elapsed().as_nanos() as u64;
        if write_half.write_all(&frame).await.is_err() {
            if measured {
                state.outcomes.record(Outcome::WriteFailure);
            }
            state.fail_pending(Outcome::PeerClosed);
            truncated = true;
            break;
        }
        state.pending.insert(corr, (scheduled_ns, issue_ns));
    }

    // Bounded drain: every in-flight request resolves or is counted
    // unresolved; the loop cannot hang on a lost response.
    let drain_deadline = Instant::now() + DRAIN_BUDGET;
    while !state.pending.is_empty() {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            state.fail_pending(Outcome::UnresolvedAtDrain);
            break;
        }
        match tokio::time::timeout(remaining, header.step(&mut read_half)).await {
            Ok(Ok(None)) => {}
            Ok(Ok(Some(frame))) => {
                if state.consume(&mut read_half, frame).await.is_err() {
                    state.fail_pending(Outcome::PeerClosed);
                    break;
                }
            }
            Ok(Err(_)) => {
                state.fail_pending(Outcome::PeerClosed);
                break;
            }
            Err(_) => {
                state.fail_pending(Outcome::UnresolvedAtDrain);
                break;
            }
        }
    }

    Ok(OpenLoopResult {
        sched_to_completion: state.sched_hist,
        issue_to_completion: state.issue_hist,
        scheduler_lag: state.lag_hist,
        outcomes: state.outcomes,
        scheduled_slots,
        elapsed: start.elapsed(),
        truncated,
    })
}

/// Reader-side bookkeeping for one open-loop run: the three retained
/// distributions, outcome counters, and in-flight request metadata.
struct OpenLoopState {
    sched_hist: Histogram<u64>,
    issue_hist: Histogram<u64>,
    lag_hist: Histogram<u64>,
    outcomes: OutcomeCounts,
    pending: HashMap<u64, (u64, u64)>,
    start: Instant,
    warmup_ns: u64,
    body: Vec<u8>,
}

impl OpenLoopState {
    /// Reads the frame body and resolves its pending slot to one outcome.
    async fn consume(
        &mut self,
        read_half: &mut tokio::net::tcp::OwnedReadHalf,
        frame: raw_client::RawFrame,
    ) -> Result<(), ()> {
        self.body.resize(frame.len as usize, 0);
        if frame.len > 0 && read_half.read_exact(&mut self.body).await.is_err() {
            return Err(());
        }
        if frame.ty == raw_client::TY_PING {
            return Ok(());
        }
        let now_ns = self.start.elapsed().as_nanos() as u64;
        let Some((scheduled_ns, issue_ns)) = self.pending.remove(&frame.corr) else {
            return Ok(());
        };
        if scheduled_ns < self.warmup_ns {
            return Ok(());
        }
        match classify_terminal(frame.ty, &self.body) {
            Outcome::Success => {
                // sched-to-completion spans both the lag and the
                // issue-to-completion intervals, so it is the largest of
                // the three values and its bounds check gates all three:
                // on overflow none of the distributions record and the
                // record is terminal as HistogramOverflow, keeping every
                // histogram's sample count equal to `success`.
                if self
                    .sched_hist
                    .record(now_ns.saturating_sub(scheduled_ns))
                    .is_ok()
                {
                    let _ = self.lag_hist.record(issue_ns.saturating_sub(scheduled_ns));
                    let _ = self.issue_hist.record(now_ns.saturating_sub(issue_ns));
                    self.outcomes.record(Outcome::Success);
                } else {
                    self.outcomes.record(Outcome::HistogramOverflow);
                }
            }
            other => self.outcomes.record(other),
        }
        Ok(())
    }

    /// Resolves every pending measured request with one failure outcome.
    fn fail_pending(&mut self, outcome: Outcome) {
        for (_, (scheduled_ns, _)) in self.pending.drain() {
            if scheduled_ns >= self.warmup_ns {
                self.outcomes.record(outcome);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThroughputConfig {
    pub depth: usize,
    pub warmup: Duration,
    pub measure: Duration,
}

#[derive(Debug)]
pub struct ThroughputResult {
    pub offered: u64,
    pub terminal: u64,
    pub successful: u64,
    /// Successful fixture bytes echoed per measured second.
    pub goodput_bytes_per_sec: f64,
    pub successful_per_sec: f64,
    pub outcomes: OutcomeCounts,
    pub measured: Duration,
    /// True when the connection failed before the measure window
    /// completed; `measured` then covers only the partial window.
    pub truncated: bool,
}

/// Sustained closed-loop throughput at a fixed depth with timestamps only
/// at the window boundaries.
pub fn run_throughput(
    publication: &Path,
    cfg: &ThroughputConfig,
) -> Result<ThroughputResult, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(run_throughput_inner(publication, cfg))
}

async fn run_throughput_inner(
    publication: &Path,
    cfg: &ThroughputConfig,
) -> Result<ThroughputResult, String> {
    if cfg.depth == 0 {
        return Err("throughput depth must be nonzero".to_owned());
    }
    let (mut stream, channel, epoch) = open_route(publication, "budget-throughput").await?;
    let mut header = [0u8; raw_client::HEADER_LEN];
    let mut body = Vec::new();
    let mut outcomes = OutcomeCounts::default();
    let mut corr = CORR_BASE;
    let mut offered = 0u64;
    let mut measuring = false;
    let mut measure_start = Instant::now();
    let mut measured_elapsed = Duration::ZERO;
    let start = Instant::now();

    // Prime the pipeline to the fixed depth.
    for _ in 0..cfg.depth {
        corr += 1;
        stream
            .write_all(&request_frame(channel, epoch, corr))
            .await
            .map_err(|err| format!("prime write: {err}"))?;
    }

    loop {
        if stream.read_exact(&mut header).await.is_err() {
            outcomes.record(Outcome::PeerClosed);
            break;
        }
        let decoded = raw_client::decode_header(&header);
        body.resize(decoded.len as usize, 0);
        if decoded.len > 0 && stream.read_exact(&mut body).await.is_err() {
            outcomes.record(Outcome::PeerClosed);
            break;
        }
        if decoded.ty == raw_client::TY_PING {
            continue;
        }
        if measuring {
            outcomes.record(classify_terminal(decoded.ty, &body));
        }
        let elapsed = start.elapsed();
        if !measuring && elapsed >= cfg.warmup {
            measuring = true;
            measure_start = Instant::now();
        } else if measuring && measure_start.elapsed() >= cfg.measure {
            measured_elapsed = measure_start.elapsed();
            break;
        }
        corr += 1;
        if measuring {
            offered += 1;
        }
        if stream
            .write_all(&request_frame(channel, epoch, corr))
            .await
            .is_err()
        {
            outcomes.record(Outcome::WriteFailure);
            break;
        }
    }

    // A zero measured window here means the loop exited on a transport
    // failure rather than reaching the configured measure duration; the
    // fallback still reports the partial elapsed time for diagnostics.
    let truncated = measured_elapsed.is_zero();
    if truncated {
        measured_elapsed = measure_start.elapsed();
    }
    let secs = measured_elapsed.as_secs_f64().max(f64::MIN_POSITIVE);
    Ok(ThroughputResult {
        offered,
        terminal: outcomes.total(),
        successful: outcomes.success,
        goodput_bytes_per_sec: outcomes.success as f64 * FIXTURE_BODY.len() as f64 / secs,
        successful_per_sec: outcomes.success as f64 / secs,
        outcomes,
        measured: measured_elapsed,
        truncated,
    })
}

/// Persistent serial connection for Criterion's `iter_custom`: times `n`
/// consecutive fixture round trips on one established route.
pub struct SerialProbe {
    runtime: tokio::runtime::Runtime,
    stream: TcpStream,
    channel: u16,
    epoch: u32,
    corr: u64,
}

impl SerialProbe {
    pub fn connect(publication: &Path) -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        let (stream, channel, epoch) =
            runtime.block_on(open_route(publication, "budget-criterion"))?;
        Ok(Self {
            runtime,
            stream,
            channel,
            epoch,
            corr: CORR_BASE,
        })
    }

    pub fn roundtrips(&mut self, n: u64) -> Result<Duration, String> {
        let channel = self.channel;
        let epoch = self.epoch;
        let stream = &mut self.stream;
        let corr = &mut self.corr;
        self.runtime.block_on(async move {
            let mut header = [0u8; raw_client::HEADER_LEN];
            let mut body = Vec::new();
            let start = Instant::now();
            for _ in 0..n {
                *corr += 1;
                let frame = request_frame(channel, epoch, *corr);
                stream
                    .write_all(&frame)
                    .await
                    .map_err(|err| format!("write: {err}"))?;
                loop {
                    stream
                        .read_exact(&mut header)
                        .await
                        .map_err(|err| format!("read: {err}"))?;
                    let decoded = raw_client::decode_header(&header);
                    body.resize(decoded.len as usize, 0);
                    if decoded.len > 0 {
                        stream
                            .read_exact(&mut body)
                            .await
                            .map_err(|err| format!("read body: {err}"))?;
                    }
                    if decoded.corr == *corr && decoded.ty != raw_client::TY_PING {
                        if classify_terminal(decoded.ty, &body) != Outcome::Success {
                            return Err("unexpected terminal during probe".to_owned());
                        }
                        break;
                    }
                }
            }
            Ok(start.elapsed())
        })
    }
}
