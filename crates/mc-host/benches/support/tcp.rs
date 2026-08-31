//! This module measures serial RTT, open-loop loaded latency, and closed-loop throughput for the IPC budget.
//!
//! Each arm uses the independent raw client to speak the production wire.
//! Each arm authenticates once, opens one route, and echoes the committed compact JSON fixture.
//! Serial RTT measures issue-to-validated-terminal latency with exactly one request in flight.
//! Loaded latency records scheduled-to-completion, issue-to-completion, and scheduler lag in separate distributions.
//! Throughput timestamps only the measurement-window boundaries.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::evidence::HistogramConfig;
use super::perf_measurement::{
    open_loop_offset_ns, validate_open_loop_rate, Outcome, OutcomeCounts, FIXTURE_BODY,
    MAX_BODY_LEN,
};
use super::raw_client::{self, RawClient, FLAGS_INTERACTIVE, TY_ERROR, TY_RESPONSE};

const MODULE_ID: &str = "perf-echo";
const CORR_BASE: u64 = 1_000_000;
/// Pending requests resolve as `UnresolvedAtDrain` after a five-second post-window drain.
/// `UnresolvedAtDrain`.
const DRAIN_BUDGET: Duration = Duration::from_secs(5);

/// A latency outside the histogram's configured range records `HistogramOverflow`; the histogram never auto-resizes.
fn record(hist: &mut Histogram<u64>, outcomes: &mut OutcomeCounts, value_ns: u64) {
    if hist.record(value_ns).is_ok() {
        outcomes.record(Outcome::Success);
    } else {
        outcomes.record(Outcome::HistogramOverflow);
    }
}

/// The wire identifies pending requests by `(channel, epoch, corr)`.
/// A frame matching `corr` on a different channel or epoch is a routing failure.
/// Successful classification requires the supported wire version and exact terminal-response flags.
/// A successful text-fixture echo requires non-binary, last terminal-response flags.
/// A wire-version or flag regression cannot produce successful evidence for the text fixture echo.
fn classify_terminal(frame: &raw_client::RawFrame, route: (u16, u32), body: &[u8]) -> Outcome {
    if (frame.channel, frame.epoch) != route || frame.ver != raw_client::WIRE_VERSION {
        return Outcome::UnexpectedFrame;
    }
    match frame.ty {
        TY_RESPONSE if frame.flags != raw_client::FLAGS_RESPONSE_TEXT_LAST => {
            Outcome::UnexpectedFrame
        }
        TY_RESPONSE if body == FIXTURE_BODY => Outcome::Success,
        TY_RESPONSE => Outcome::BodyMismatch,
        TY_ERROR => Outcome::ProtocolError,
        _ => Outcome::UnexpectedFrame,
    }
}

/// `HeaderReader` retains partial header bytes across `select!` cancellation.
/// Each `HeaderReader::step` await performs one `read`, so cancellation preserves partial header bytes.
/// Using `read_exact` here would discard partial header bytes on cancellation and desynchronize the stream.
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

/// The frame reader retains partial header and body bytes across cancellation.
/// Each frame-reader await performs one `read` into a retained buffer.
/// `timeout` cancellation preserves partial bytes in `FrameReader` for the next call.
/// `read_exact` under `timeout` can discard a partial header or body.
/// Discarding a partial header or body desynchronizes later reads on the connection.
struct FrameReceiver {
    header: HeaderReader,
    frame: Option<raw_client::RawFrame>,
    body_filled: usize,
}

impl FrameReceiver {
    fn new() -> Self {
        Self {
            header: HeaderReader::new(),
            frame: None,
            body_filled: 0,
        }
    }

    /// The receive driver returns a frame only after buffering its entire body in `body`.
    /// The receive driver rejects oversized length fields with `InvalidData` before allocation.
    /// The stream cannot resynchronize after an unread body.
    async fn step<R: tokio::io::AsyncRead + Unpin>(
        &mut self,
        reader: &mut R,
        body: &mut Vec<u8>,
    ) -> std::io::Result<Option<raw_client::RawFrame>> {
        if self.frame.is_none() {
            let Some(frame) = self.header.step(reader).await? else {
                return Ok(None);
            };
            if frame.len > MAX_BODY_LEN {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            body.resize(frame.len as usize, 0);
            self.body_filled = 0;
            self.frame = Some(frame);
        }
        let len = self.frame.as_ref().map_or(0, |f| f.len as usize);
        if self.body_filled < len {
            let n = reader.read(&mut body[self.body_filled..len]).await?;
            if n == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            self.body_filled += n;
            if self.body_filled < len {
                return Ok(None);
            }
        }
        self.body_filled = 0;
        Ok(self.frame.take())
    }
}

/// TODO: Apply a setup deadline to discovery, authentication, and route opening; a live stuck host otherwise blocks the run before arm deadlines start.
const SETUP_BUDGET: Duration = Duration::from_secs(30);

/// Each arm uses one authenticated connection and one open route to the echo module.
async fn open_route(publication: &Path, session: &str) -> Result<(TcpStream, u16, u32), String> {
    tokio::time::timeout(SETUP_BUDGET, async {
        let info = raw_client::discover(publication)?;
        let mut client = RawClient::connect(&info).await?;
        let (channel, epoch) = client
            .route_open(MODULE_ID, "/perf", "perf", session)
            .await?;
        let stream = client.into_stream();
        stream.set_nodelay(true).map_err(|err| err.to_string())?;
        Ok((stream, channel, epoch))
    })
    .await
    .map_err(|_| format!("connection setup exceeded {}s", SETUP_BUDGET.as_secs()))?
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

/// Serial loopback RTT uses one established connection and one request in flight.
/// Serial RTT timing runs from issue to validated terminal response and excludes authentication and route setup.
/// Warmup operations use the same connection but are not timed.
/// recorded.
pub fn run_serial(publication: &Path, cfg: &SerialConfig) -> Result<SerialResult, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(run_serial_inner(publication, cfg))
}

async fn run_serial_inner(publication: &Path, cfg: &SerialConfig) -> Result<SerialResult, String> {
    if cfg.measured_ops == 0 {
        return Err("serial arm requires a nonzero measured operation count".to_owned());
    }
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
        // The RTT boundary starts after admission and immediately before the write, so permit and setup waits never count.
        let issue = Instant::now();
        if stream.write_all(&frame).await.is_err() {
            if measured {
                outcomes.record(Outcome::WriteFailure);
            }
            return finish_serial(hist, outcomes, measured_scheduled, window_start);
        }
        // A response deadline lets liveness and truncation checks run when a live host stops responding.
        // Returning after timeout prevents a cancelled read_exact from desynchronizing later reads.
        let response_deadline = Instant::now() + DRAIN_BUDGET;
        loop {
            let remaining = response_deadline.saturating_duration_since(Instant::now());
            let header_read = if remaining.is_zero() {
                None
            } else {
                tokio::time::timeout(remaining, stream.read_exact(&mut header))
                    .await
                    .ok()
            };
            let Some(header_read) = header_read else {
                if measured {
                    outcomes.record(Outcome::UnresolvedAtDrain);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            };
            if header_read.is_err() {
                if measured {
                    outcomes.record(Outcome::PeerClosed);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            }
            let decoded = raw_client::decode_header(&header);
            // Values above MAX_BODY_LEN fail before body.resize can allocate from them.
            // the stream cannot be resynchronized past an unread body.
            if decoded.len > MAX_BODY_LEN {
                if measured {
                    outcomes.record(Outcome::UnexpectedFrame);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            }
            body.resize(decoded.len as usize, 0);
            let remaining = response_deadline.saturating_duration_since(Instant::now());
            let body_read = if decoded.len == 0 {
                Some(Ok(()))
            } else if remaining.is_zero() {
                None
            } else {
                tokio::time::timeout(remaining, async {
                    stream.read_exact(&mut body).await.map(|_| ())
                })
                .await
                .ok()
            };
            let Some(body_read) = body_read else {
                if measured {
                    outcomes.record(Outcome::UnresolvedAtDrain);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            };
            if body_read.is_err() {
                if measured {
                    outcomes.record(Outcome::PeerClosed);
                }
                return finish_serial(hist, outcomes, measured_scheduled, window_start);
            }
            if !is_request_terminal(decoded.ty) {
                if is_connection_frame(decoded.ty) {
                    if let Some(violation) = raw_client::connection_frame_violation(&decoded) {
                        return Err(format!("wire-protocol violation: {violation}"));
                    }
                    // A Goodbye that retires (channel, epoch) resolves the in-flight operation as connection loss.
                    // the attempt.
                    if goodbye_retires(&decoded, (channel, epoch)) {
                        if measured {
                            outcomes.record(Outcome::PeerClosed);
                        }
                        return finish_serial(hist, outcomes, measured_scheduled, window_start);
                    }
                    continue;
                }
                return Err(format!(
                    "wire-protocol violation: server-illegal frame type {}",
                    decoded.ty
                ));
            }
            if decoded.corr != corr {
                // Only the in-flight request can produce a valid terminal.
                // A terminal for a different request is a protocol error.
                // wire-protocol regression.
                return Err(format!(
                    "wire-protocol violation: unsolicited terminal for correlation {} \
                     (awaiting {corr})",
                    decoded.corr
                ));
            }
            let rtt_ns = issue.elapsed().as_nanos() as u64;
            // Warmup suppresses recording but not validation.
            let outcome = classify_terminal(&decoded, (channel, epoch), &body);
            if !measured {
                if outcome != Outcome::Success {
                    return Err(format!("warmup response failed validation ({outcome:?})"));
                }
                break;
            }
            match outcome {
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
    /// The scheduled histogram records scheduled-send-to-validated-terminal latency to avoid coordinated omission.
    pub sched_to_completion: Histogram<u64>,
    /// The actual histogram records issue-to-validated-terminal latency.
    pub issue_to_completion: Histogram<u64>,
    /// The lag histogram records issue-minus-scheduled time separately so server latency excludes load-generator lag.
    pub scheduler_lag: Histogram<u64>,
    pub outcomes: OutcomeCounts,
    pub scheduled_slots: u64,
    pub elapsed: Duration,
    /// The partial_window flag is true when the connection fails before the warmup-and-measure window completes.
    /// The caller must reject the partial window when partial_window is true.
    pub truncated: bool,
}

/// The benchmark measures open-loop latency at one fixed offered rate.
/// The absolute arrival schedule treats an unavailable permit as a missed slot.
/// A missed slot never triggers a catch-up burst.
pub fn run_open_loop(publication: &Path, cfg: &OpenLoopConfig) -> Result<OpenLoopResult, String> {
    if cfg.measure.is_zero() {
        return Err("open-loop arm requires a nonzero measurement window".to_owned());
    }
    validate_open_loop_rate(cfg.rate_per_sec)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(run_open_loop_inner(publication, cfg))
}

async fn run_open_loop_inner(
    publication: &Path,
    cfg: &OpenLoopConfig,
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
        route: (channel, epoch),
        body: Vec::new(),
    };
    let deadline_ns = (cfg.warmup + cfg.measure).as_nanos() as u64;
    let mut scheduled_slots = 0u64;
    let mut truncated = false;
    let mut header = HeaderReader::new();
    let mut slot = 0u64;

    'sender: loop {
        let scheduled_ns = open_loop_offset_ns(slot, cfg.rate_per_sec);
        slot += 1;
        if scheduled_ns >= deadline_ns {
            break;
        }
        let at = start + Duration::from_nanos(scheduled_ns);
        // Completion latency starts at `issue`, after `frame` construction.
        let corr = slot + CORR_BASE;
        let frame = request_frame(channel, epoch, corr);
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
                            // `DRAIN_BUDGET` bounds `consume` after `header.step` wins the select.
                            let consumed = tokio::time::timeout(
                                DRAIN_BUDGET,
                                state.consume(&mut read_half, frame),
                            )
                            .await;
                            match consumed {
                                Ok(Ok(())) => {}
                                Ok(Err(ConsumeFailure::Protocol(reason))) => {
                                    return Err(format!("wire-protocol violation: {reason}"));
                                }
                                Ok(Err(ConsumeFailure::Transport)) => {
                                    state.fail_pending(Outcome::PeerClosed);
                                    truncated = true;
                                    break 'sender;
                                }
                                Err(_) => {
                                    state.fail_pending(Outcome::UnresolvedAtDrain);
                                    truncated = true;
                                    break 'sender;
                                }
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
        let issue_ns = start.elapsed().as_nanos() as u64;
        // `write_deadline` limits `write_all` to the benchmark deadline plus `DRAIN_BUDGET`.
        // A write timeout marks the run truncated and stops sending.
        let write_deadline = start + Duration::from_nanos(deadline_ns) + DRAIN_BUDGET;
        let remaining = write_deadline.saturating_duration_since(Instant::now());
        let wrote = if remaining.is_zero() {
            None
        } else {
            tokio::time::timeout(remaining, write_half.write_all(&frame))
                .await
                .ok()
        };
        let write_failed = match wrote {
            None => {
                if measured {
                    state.outcomes.record(Outcome::WriteFailure);
                }
                state.fail_pending(Outcome::UnresolvedAtDrain);
                true
            }
            Some(Err(_)) => {
                if measured {
                    state.outcomes.record(Outcome::WriteFailure);
                }
                state.fail_pending(Outcome::PeerClosed);
                true
            }
            Some(Ok(())) => false,
        };
        if write_failed {
            truncated = true;
            break;
        }
        state.pending.insert(corr, (scheduled_ns, issue_ns));
    }

    let drain_deadline = Instant::now() + DRAIN_BUDGET;
    while !state.pending.is_empty() {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            state.fail_pending(Outcome::UnresolvedAtDrain);
            break;
        }
        // `DRAIN_BUDGET` bounds `consume` after `header.step` wins the select.
        let step = tokio::time::timeout(remaining, async {
            match header.step(&mut read_half).await {
                Ok(None) => Ok(()),
                Ok(Some(frame)) => state.consume(&mut read_half, frame).await,
                Err(_) => Err(ConsumeFailure::Transport),
            }
        })
        .await;
        match step {
            Ok(Ok(())) => {}
            Ok(Err(ConsumeFailure::Protocol(reason))) => {
                return Err(format!("wire-protocol violation: {reason}"));
            }
            Ok(Err(ConsumeFailure::Transport)) => {
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

struct OpenLoopState {
    sched_hist: Histogram<u64>,
    issue_hist: Histogram<u64>,
    lag_hist: Histogram<u64>,
    outcomes: OutcomeCounts,
    pending: HashMap<u64, (u64, u64)>,
    start: Instant,
    warmup_ns: u64,
    /// Every terminal must carry the route identity: `channel` and `epoch`.
    route: (u16, u32),
    body: Vec<u8>,
}

/// outstanding correlation.
fn is_request_terminal(ty: u8) -> bool {
    matches!(
        ty,
        TY_RESPONSE | TY_ERROR | raw_client::TY_STREAM_DATA | raw_client::TY_STREAM_END
    )
}

/// frame.
fn is_connection_frame(ty: u8) -> bool {
    matches!(
        ty,
        raw_client::TY_PING | raw_client::TY_PUSH | raw_client::TY_GOODBYE
    )
}

fn goodbye_retires(frame: &raw_client::RawFrame, route: (u16, u32)) -> bool {
    frame.ty == raw_client::TY_GOODBYE
        && ((frame.channel, frame.epoch) == route || (frame.channel == 0 && frame.epoch == 0))
}

enum ConsumeFailure {
    Transport,
    Protocol(String),
}

impl OpenLoopState {
    async fn consume(
        &mut self,
        read_half: &mut tokio::net::tcp::OwnedReadHalf,
        frame: raw_client::RawFrame,
    ) -> Result<(), ConsumeFailure> {
        if frame.len > MAX_BODY_LEN {
            return Err(ConsumeFailure::Protocol(format!(
                "oversized response length {}",
                frame.len
            )));
        }
        self.body.resize(frame.len as usize, 0);
        if frame.len > 0 && read_half.read_exact(&mut self.body).await.is_err() {
            return Err(ConsumeFailure::Transport);
        }
        if !is_request_terminal(frame.ty) {
            if is_connection_frame(frame.ty) {
                if let Some(violation) = raw_client::connection_frame_violation(&frame) {
                    return Err(ConsumeFailure::Protocol(violation));
                }
                // attempt.
                if goodbye_retires(&frame, self.route) {
                    return Err(ConsumeFailure::Transport);
                }
                return Ok(());
            }
            return Err(ConsumeFailure::Protocol(format!(
                "server-illegal frame type {}",
                frame.ty
            )));
        }
        let now_ns = self.start.elapsed().as_nanos() as u64;
        let Some((scheduled_ns, issue_ns)) = self.pending.remove(&frame.corr) else {
            // Each terminal frame must match an issued pending correlation; duplicates and never-issued correlations fail the attempt as protocol violations.
            return Err(ConsumeFailure::Protocol(format!(
                "unsolicited terminal for correlation {}",
                frame.corr
            )));
        };
        // warmup boundary.
        let outcome = classify_terminal(&frame, self.route, &self.body);
        if scheduled_ns < self.warmup_ns {
            if outcome != Outcome::Success {
                return Err(ConsumeFailure::Protocol(format!(
                    "warmup response failed validation ({outcome:?})"
                )));
            }
            return Ok(());
        }
        match outcome {
            Outcome::Success => {
                // The sched-to-completion bound gates all three histograms because it is their largest value.
                // On sched-to-completion overflow, no histogram records a sample.
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
    pub goodput_bytes_per_sec: f64,
    pub successful_per_sec: f64,
    pub outcomes: OutcomeCounts,
    pub measured: Duration,
    /// measured outcomes.
    pub drained: u64,
    pub truncated: bool,
}

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
    if cfg.measure.is_zero() {
        return Err("throughput arm requires a nonzero measurement window".to_owned());
    }
    if cfg.warmup.is_zero() {
        return Err("throughput arm requires a nonzero warmup window".to_owned());
    }
    let (mut stream, channel, epoch) = open_route(publication, "budget-throughput").await?;
    let mut body = Vec::new();
    let mut outcomes = OutcomeCounts::default();
    let mut corr = CORR_BASE;
    let mut outstanding: HashSet<u64> = HashSet::with_capacity(cfg.depth);
    let mut offered = 0u64;
    let mut measuring = false;
    let mut measure_start = Instant::now();
    let mut measured_elapsed = Duration::ZERO;
    let mut first_measured: Option<u64> = None;
    let measured_corr = |first: Option<u64>, c: u64| first.is_some_and(|f| c >= f);
    let start = Instant::now();
    let write_deadline = start + cfg.warmup + cfg.measure + DRAIN_BUDGET;

    for _ in 0..cfg.depth {
        corr += 1;
        outstanding.insert(corr);
        let remaining = write_deadline.saturating_duration_since(Instant::now());
        tokio::time::timeout(
            remaining,
            stream.write_all(&request_frame(channel, epoch, corr)),
        )
        .await
        .map_err(|_| "prime write: deadline exceeded".to_owned())?
        .map_err(|err| format!("prime write: {err}"))?;
    }

    // the stream.
    let mut receiver = FrameReceiver::new();
    let window_deadline = start + cfg.warmup + cfg.measure;
    loop {
        let remaining = window_deadline.saturating_duration_since(Instant::now());
        let received = if remaining.is_zero() {
            None
        } else {
            tokio::time::timeout(remaining, receiver.step(&mut stream, &mut body))
                .await
                .ok()
        };
        let decoded = match received {
            None => {
                // The receive deadline stops admitting measured completions at the window boundary.
                // The receive deadline prevents post-window collector descheduling from extending the measurement window.
                // Scheduler delay after the deadline cannot add a measured completion.
                // fill.
                if measuring {
                    measured_elapsed = cfg.measure;
                }
                break;
            }
            Some(Err(_)) => {
                for c in outstanding.drain() {
                    if measured_corr(first_measured, c) {
                        outcomes.record(Outcome::PeerClosed);
                    }
                }
                break;
            }
            Some(Ok(None)) => continue,
            Some(Ok(Some(decoded))) => decoded,
        };
        if !is_request_terminal(decoded.ty) {
            if is_connection_frame(decoded.ty) {
                if let Some(violation) = raw_client::connection_frame_violation(&decoded) {
                    return Err(format!("wire-protocol violation: {violation}"));
                }
                // Orderly teardown resolves outstanding measured requests as connection loss and fails the truncation gate.
                if goodbye_retires(&decoded, (channel, epoch)) {
                    for c in outstanding.drain() {
                        if measured_corr(first_measured, c) {
                            outcomes.record(Outcome::PeerClosed);
                        }
                    }
                    break;
                }
                continue;
            }
            return Err(format!(
                "wire-protocol violation: server-illegal frame type {}",
                decoded.ty
            ));
        }
        // A terminal for no outstanding request is a wire-protocol regression.
        // Duplicate terminals and never-issued correlations name no outstanding request.
        // A terminal for no outstanding request must neither count as a terminal nor trigger a replacement send.
        // Silently discarding a terminal for no outstanding request would allow the attempt to finalize despite the regression.
        if !outstanding.remove(&decoded.corr) {
            return Err(format!(
                "wire-protocol violation: unsolicited terminal for correlation {}",
                decoded.corr
            ));
        }
        // Warmup suppresses outcome recording but still rejects protocol regressions.
        // warmup boundary.
        let outcome = classify_terminal(&decoded, (channel, epoch), &body);
        if measured_corr(first_measured, decoded.corr) {
            outcomes.record(outcome);
        } else if outcome != Outcome::Success {
            return Err(format!("warmup response failed validation ({outcome:?})"));
        }
        let elapsed = start.elapsed();
        if !measuring && elapsed >= cfg.warmup {
            measuring = true;
            // The measurement window starts at the nominal warmup boundary, not at the first post-warmup response.
            // A delayed first post-warmup response does not shorten the configured measurement window.
            measure_start = start + cfg.warmup;
        } else if measuring && measure_start.elapsed() >= cfg.measure {
            // The fixed deadline excludes completions received after the nominal measurement end.
            measured_elapsed = cfg.measure;
            break;
        }
        corr += 1;
        if measuring {
            offered += 1;
            if first_measured.is_none() {
                first_measured = Some(corr);
            }
        }
        outstanding.insert(corr);
        let write_remaining = write_deadline.saturating_duration_since(Instant::now());
        let wrote = if write_remaining.is_zero() {
            None
        } else {
            tokio::time::timeout(
                write_remaining,
                stream.write_all(&request_frame(channel, epoch, corr)),
            )
            .await
            .ok()
        };
        if !matches!(wrote, Some(Ok(()))) {
            // A failed or expired send records `WriteFailure` for the current request and `PeerClosed` for other outstanding measured requests.
            // The failed send ends measurement before the window completes.
            for c in outstanding.drain() {
                if measured_corr(first_measured, c) {
                    outcomes.record(if c == corr {
                        Outcome::WriteFailure
                    } else {
                        Outcome::PeerClosed
                    });
                }
            }
            break;
        }
    }

    // A zero `measured_elapsed` means measurement ended before the configured window completed.
    let truncated = measured_elapsed.is_zero();
    let mut drained = 0u64;
    if truncated {
        measured_elapsed = measure_start.elapsed();
    } else {
        // The post-window drain resolves responses for requests outstanding at window close.
        // Drained frames update pipeline accounting but are not measured outcomes.
        // The post-window drain fails if the drain expires or the connection fails while responses remain outstanding.
        let undrained = |n: usize| {
            format!(
                "{n} in-flight response(s) undrained after the {}s post-window drain budget",
                DRAIN_BUDGET.as_secs()
            )
        };
        let drain_deadline = Instant::now() + DRAIN_BUDGET;
        while !outstanding.is_empty() {
            let remaining = drain_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(undrained(outstanding.len()));
            }
            // The deadline bounds the whole receive, including the body.
            // The receiver resumes a frame the window loop left partially read.
            // A peer that stalls mid-body cannot hang the drain.
            // Reusing `receiver` preserves stream synchronization after the window loop.
            let read = tokio::time::timeout(remaining, receiver.step(&mut stream, &mut body)).await;
            match read {
                Ok(Ok(None)) => {}
                Ok(Ok(Some(decoded))) => {
                    if !is_request_terminal(decoded.ty) && !is_connection_frame(decoded.ty) {
                        return Err(format!(
                            "wire-protocol violation: server-illegal frame type {}",
                            decoded.ty
                        ));
                    }
                    if is_request_terminal(decoded.ty) {
                        if !outstanding.remove(&decoded.corr) {
                            return Err(format!(
                                "wire-protocol violation: unsolicited terminal for \
                                 correlation {}",
                                decoded.corr
                            ));
                        }
                    } else if let Some(violation) = raw_client::connection_frame_violation(&decoded)
                    {
                        return Err(format!("wire-protocol violation: {violation}"));
                    } else if goodbye_retires(&decoded, (channel, epoch)) {
                        // A matching goodbye retires the connection, so outstanding responses will not arrive.
                        return Err(format!(
                            "connection closed by goodbye with {} in-flight response(s) undrained",
                            outstanding.len()
                        ));
                    }
                    if is_request_terminal(decoded.ty) {
                        // Drained terminal responses must satisfy the same validation as in-window responses.
                        let outcome = classify_terminal(&decoded, (channel, epoch), &body);
                        if outcome != Outcome::Success {
                            return Err(format!(
                                "drained response for corr {} failed validation ({outcome:?})",
                                decoded.corr
                            ));
                        }
                        drained += 1;
                    }
                }
                Ok(Err(_)) => {
                    return Err(format!(
                        "connection failed with {} in-flight response(s) undrained",
                        outstanding.len()
                    ));
                }
                Err(_) => return Err(undrained(outstanding.len())),
            }
        }
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
        drained,
        truncated,
    })
}

/// Criterion's `iter_custom` times `n` consecutive fixture round trips on one established connection.
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
                // Each exchange has an I/O deadline so a live but stalled host cannot block a Criterion sample indefinitely.
                // Expiry abandons the connection, preventing a cancelled read from desynchronizing later traffic.
                let deadline = Instant::now() + DRAIN_BUDGET;
                let remaining = deadline.saturating_duration_since(Instant::now());
                tokio::time::timeout(remaining, stream.write_all(&frame))
                    .await
                    .map_err(|_| "write: deadline exceeded".to_owned())?
                    .map_err(|err| format!("write: {err}"))?;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err("response: deadline exceeded".to_owned());
                    }
                    tokio::time::timeout(remaining, stream.read_exact(&mut header))
                        .await
                        .map_err(|_| "read: deadline exceeded".to_owned())?
                        .map_err(|err| format!("read: {err}"))?;
                    let decoded = raw_client::decode_header(&header);
                    if decoded.len > MAX_BODY_LEN {
                        // The decoder rejects allocations derived from untrusted 32-bit lengths.
                        // The decoder must not continue because it would parse the unread body as the next header.
                        return Err(format!("oversized response length {}", decoded.len));
                    }
                    body.resize(decoded.len as usize, 0);
                    if decoded.len > 0 {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        tokio::time::timeout(remaining, stream.read_exact(&mut body))
                            .await
                            .map_err(|_| "read body: deadline exceeded".to_owned())?
                            .map_err(|err| format!("read body: {err}"))?;
                    }
                    if decoded.corr == *corr && decoded.ty != raw_client::TY_PING {
                        if classify_terminal(&decoded, (channel, epoch), &body) != Outcome::Success
                        {
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
