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

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::evidence::HistogramConfig;
use super::perf_measurement::{
    open_loop_interval_ns, Outcome, OutcomeCounts, FIXTURE_BODY, MAX_BODY_LEN,
};
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

/// Classifies one non-ping terminal frame against the fixture, route, and
/// wire contract. The pending identity on the wire is (channel, epoch,
/// corr): a frame that resolves a pending correlation on the wrong channel
/// or epoch is a routing failure. A success additionally requires the
/// supported wire version and the exact terminal-response flag shape
/// (non-binary, last): a version or flag regression must not produce
/// successful evidence for a text fixture echo.
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

/// Reads one complete frame (header plus body) with cancellation-safe
/// incremental progress: every await is a single `read` into a retained
/// buffer, so a future dropped by `timeout` mid-frame loses no bytes and
/// the next call resumes exactly where the stream left off. `read_exact`
/// under `timeout` would instead discard a partial header or body and
/// desynchronize every later read on the connection.
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

    /// Drives the receive one step; returns the decoded frame once its
    /// body is fully buffered in `body`. An oversized length field is an
    /// `InvalidData` error before any allocation: the length is untrusted
    /// 32-bit input and the stream cannot resync past an unread body.
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

/// Bound on connection setup (discover, authenticate, open the route):
/// none of the arm deadlines is armed until setup returns, so an
/// unbounded control exchange against a live-but-stuck host would hang
/// the whole run before any liveness check can fire.
const SETUP_BUDGET: Duration = Duration::from_secs(30);

/// One authenticated connection with one open route to the echo module.
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
        // The RTT boundary starts here: after admission and immediately
        // before the write, so permit or setup waits never count.
        let issue = Instant::now();
        if stream.write_all(&frame).await.is_err() {
            if measured {
                outcomes.record(Outcome::WriteFailure);
            }
            return finish_serial(hist, outcomes, measured_scheduled, window_start);
        }
        // Each response wait is bounded: a live host that stops
        // responding would otherwise hang the arm before its liveness
        // and truncation checks can run. Expiry abandons the connection
        // outright, so the cancelled read_exact cannot desync later
        // reads — there are none.
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
            // The length field is untrusted 32-bit input: a corrupted
            // value must fail the attempt, not drive the allocation, and
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
                    if let Some(violation) = connection_frame_violation(&decoded) {
                        return Err(format!("wire-protocol violation: {violation}"));
                    }
                    continue;
                }
                return Err(format!(
                    "wire-protocol violation: server-illegal frame type {}",
                    decoded.ty
                ));
            }
            if decoded.corr != corr {
                // One request is in flight on this route, so the only
                // legal request terminal answers it; anything else is a
                // wire-protocol regression.
                return Err(format!(
                    "wire-protocol violation: unsolicited terminal for correlation {} \
                     (awaiting {corr})",
                    decoded.corr
                ));
            }
            let rtt_ns = issue.elapsed().as_nanos() as u64;
            if !measured {
                break;
            }
            match classify_terminal(&decoded, (channel, epoch), &body) {
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
    if cfg.measure.is_zero() {
        return Err("open-loop arm requires a nonzero measurement window".to_owned());
    }
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
        route: (channel, epoch),
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
        // The frame is built before the slot arrives, so neither the
        // recorded scheduler lag (issue minus scheduled) nor the
        // completion latency carries its construction and allocation
        // cost; a cap-missed slot simply discards it.
        let corr = slot + CORR_BASE;
        let frame = request_frame(channel, epoch, corr);
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
                            // The body read is bounded: a peer that sends a
                            // valid header and stalls mid-body would
                            // otherwise hang the window with no deadline at
                            // all, since the sleep arm above was already
                            // cancelled when this arm won.
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
        // The write is bounded by the arm deadline plus the drain
        // budget: a host that stops reading fills the TCP window and an
        // unbounded write_all would park the sender past every deadline.
        // Expiry abandons the run (truncated), so a partially written
        // frame cannot corrupt later traffic — there is none.
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

    // Bounded drain: every in-flight request resolves or is counted
    // unresolved; the loop cannot hang on a lost response.
    let drain_deadline = Instant::now() + DRAIN_BUDGET;
    while !state.pending.is_empty() {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            state.fail_pending(Outcome::UnresolvedAtDrain);
            break;
        }
        // The deadline bounds the whole receive, body included: a peer
        // that sends a valid header and stalls mid-body would otherwise
        // hang the drain inside `consume` despite the budget.
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
    /// Route identity (channel, epoch) every terminal must carry.
    route: (u16, u32),
    body: Vec<u8>,
}

/// True for frame types that answer a request and must therefore name an
/// outstanding correlation.
fn is_request_terminal(ty: u8) -> bool {
    matches!(
        ty,
        TY_RESPONSE | TY_ERROR | raw_client::TY_STREAM_DATA | raw_client::TY_STREAM_END
    )
}

/// True for the frame types a host may legally emit outside a request
/// exchange, matching the wire contract's host-to-consumer set
/// (keepalive pings, pushes, and the shutdown goodbye). Pong is
/// consumer-to-host only. Everything that is neither a request terminal
/// nor one of these is a wire-protocol violation, never a skippable
/// frame.
fn is_connection_frame(ty: u8) -> bool {
    matches!(
        ty,
        raw_client::TY_PING | raw_client::TY_PUSH | raw_client::TY_GOODBYE
    )
}

/// Validates a skippable connection frame against the wire contract:
/// supported version, and the pure-header shape (len 0) for ping and
/// goodbye. A push legitimately carries a body. Accepting a malformed
/// frame solely by type would let a wire regression coexist with an
/// otherwise successful attempt.
fn connection_frame_violation(frame: &raw_client::RawFrame) -> Option<String> {
    if frame.ver != raw_client::WIRE_VERSION {
        return Some(format!(
            "connection frame type {} with unsupported wire version {}",
            frame.ty, frame.ver
        ));
    }
    if matches!(frame.ty, raw_client::TY_PING | raw_client::TY_GOODBYE) && frame.len != 0 {
        return Some(format!(
            "pure-header frame type {} carries body length {}",
            frame.ty, frame.len
        ));
    }
    None
}

/// How one open-loop receive failed: transport failures resolve pending
/// requests as connection loss, while a wire-protocol violation from a
/// live host fails the whole attempt with its own reason.
enum ConsumeFailure {
    Transport,
    Protocol(String),
}

impl OpenLoopState {
    /// Reads the frame body and resolves its pending slot to one outcome.
    async fn consume(
        &mut self,
        read_half: &mut tokio::net::tcp::OwnedReadHalf,
        frame: raw_client::RawFrame,
    ) -> Result<(), ConsumeFailure> {
        // Untrusted 32-bit length: refuse the allocation and fail the
        // attempt, since the stream cannot resync past an unread body.
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
                if let Some(violation) = connection_frame_violation(&frame) {
                    return Err(ConsumeFailure::Protocol(violation));
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
            // Only pings and responses to issued requests are legal on
            // this single-route connection: a duplicate terminal or a
            // never-issued correlation is a wire-protocol regression
            // that must not finalize successful evidence.
            return Err(ConsumeFailure::Protocol(format!(
                "unsolicited terminal for correlation {}",
                frame.corr
            )));
        };
        if scheduled_ns < self.warmup_ns {
            return Ok(());
        }
        match classify_terminal(&frame, self.route, &self.body) {
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
    /// Responses drained after the measure window closes, one per request
    /// still in flight at the window boundary; drained frames are never
    /// measured outcomes.
    pub drained: u64,
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
    if cfg.measure.is_zero() {
        return Err("throughput arm requires a nonzero measurement window".to_owned());
    }
    if cfg.warmup.is_zero() {
        // The primed pipeline is issued before `first_measured` can be
        // set, so with a zero warmup the depth primed requests would sit
        // inside the measured window yet be excluded from offered and
        // terminal accounting, underreporting the rate.
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
    // First corr sent inside the measured window: terminals attribute to
    // the REQUEST's window, so a response to a warmup send arriving
    // inside the window is carry-in, never measured work.
    let mut first_measured: Option<u64> = None;
    let measured_corr = |first: Option<u64>, c: u64| first.is_some_and(|f| c >= f);
    let start = Instant::now();
    // Writes share the receive deadline (plus drain budget): a host that
    // stops reading fills the TCP send buffer, and an unbounded
    // write_all would park the arm past every deadline.
    let write_deadline = start + cfg.warmup + cfg.measure + DRAIN_BUDGET;

    // Prime the pipeline to the fixed depth.
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

    // The window deadline bounds every receive: a host that delays one
    // response past the deadline cannot stretch the fixed measurement
    // window's denominator, and a live-but-silent host cannot hang the
    // run with an unbounded read. The receiver's incremental state
    // survives an expired timeout, so a window that closes mid-frame
    // hands the partial frame to the drain instead of desynchronizing
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
                // Deadline reached without a frame. Inside the measured
                // window that closes the window at its nominal length and
                // hands the outstanding requests to the drain below; a
                // deadline during warmup means the host produced no
                // terminal for the whole warmup+measure budget and the
                // zero measured window marks the run truncated.
                if measuring {
                    measured_elapsed = measure_start.elapsed();
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
                if let Some(violation) = connection_frame_violation(&decoded) {
                    return Err(format!("wire-protocol violation: {violation}"));
                }
                continue;
            }
            return Err(format!(
                "wire-protocol violation: server-illegal frame type {}",
                decoded.ty
            ));
        }
        // A frame naming no outstanding request (a duplicate terminal or
        // a never-issued correlation) is a wire-protocol regression: it
        // must neither count as a terminal nor trigger a replacement
        // send, and silently discarding it would let the attempt
        // finalize despite the regression.
        if !outstanding.remove(&decoded.corr) {
            return Err(format!(
                "wire-protocol violation: unsolicited terminal for correlation {}",
                decoded.corr
            ));
        }
        if measured_corr(first_measured, decoded.corr) {
            outcomes.record(classify_terminal(&decoded, (channel, epoch), &body));
        }
        let elapsed = start.elapsed();
        if !measuring && elapsed >= cfg.warmup {
            measuring = true;
            // Anchored to the nominal warmup boundary, not this
            // response's arrival time: a delayed first post-warmup
            // response must not shrink the measured window below its
            // configured length while the fixed deadline stays put.
            measure_start = start + cfg.warmup;
        } else if measuring && measure_start.elapsed() >= cfg.measure {
            measured_elapsed = measure_start.elapsed();
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
            // The failed or deadline-expired send and every other
            // outstanding measured request resolve as failures; the
            // window did not complete.
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

    // A zero measured window here means the loop exited before the
    // measure window completed (transport failure, or a host silent for
    // the whole warmup+measure budget); the fallback still reports the
    // partial elapsed time for diagnostics. Truncated runs skip the
    // drain: the caller rejects the attempt, so in-flight accounting
    // proves nothing further.
    let truncated = measured_elapsed.is_zero();
    let mut drained = 0u64;
    if truncated {
        measured_elapsed = measure_start.elapsed();
    } else {
        // Post-window drain: the host owes one response per request still
        // in flight at the window close. Drained frames resolve pipeline
        // accounting only and are never measured outcomes; a drain-budget
        // expiry or connection failure with requests still outstanding is
        // real response loss, and the arm fails rather than publishing a
        // window that quietly dropped responses.
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
            // The deadline bounds the whole receive, body included, and
            // the receiver resumes any frame the window loop left
            // partially read, so a peer that stalls mid-body cannot hang
            // the drain and the handoff never desynchronizes the stream.
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
                    } else if let Some(violation) = connection_frame_violation(&decoded) {
                        return Err(format!("wire-protocol violation: {violation}"));
                    }
                    if is_request_terminal(decoded.ty) {
                        // Every drained response passes the same terminal
                        // validation as an in-window frame: the window
                        // boundary does not exempt the final measured
                        // requests from the correctness contract.
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
                // Each exchange is bounded like every other arm's I/O: a
                // live-but-stuck host would otherwise park the Criterion
                // sample forever. Expiry abandons the connection, so the
                // cancelled read cannot desync later traffic.
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
                        // Untrusted 32-bit length: refuse the allocation;
                        // the stream cannot resync past an unread body.
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
