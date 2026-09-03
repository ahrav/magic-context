//! Shared-memory ring measurement arms for the IPC budget.
//!
//! Every arm discovers the installed publication, authenticates over the setup
//! socket, receives the ring descriptors, and sends application frames through
//! the managed ring client. Setup is outside every measurement window.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use tokio::task::JoinSet;

use super::evidence::HistogramConfig;
use super::perf_measurement::{
    open_loop_offset_ns, validate_open_loop_rate, Outcome, OutcomeCounts, FIXTURE_BODY,
};

const MODULE_ID: &str = "perf-echo";
const DRAIN_BUDGET: Duration = Duration::from_secs(5);
const SETUP_BUDGET: Duration = Duration::from_secs(30);

type CallResult = Result<mc_host::Response, mc_host::CallError>;

fn target() -> mc_host::RouteTarget {
    mc_host::RouteTarget {
        module_id: MODULE_ID.to_owned(),
        kind: mc_host::TargetKind::ToolProvider,
    }
}

fn identity(session: &str) -> mc_host::RouteIdentity {
    mc_host::RouteIdentity {
        project_root: PathBuf::from("/tmp/mc-host-ipc-budget"),
        harness: "ipc-budget".to_owned(),
        session: session.to_owned(),
        consumer_module_id: None,
        consumer_launch_nonce: None,
        consumer_capabilities: Vec::new(),
        admission_facts: None,
        credential_fingerprints: Default::default(),
    }
}

async fn open_route(
    publication: &Path,
    session: &str,
) -> Result<(Arc<mc_host::Client>, mc_host::RouteHandle), String> {
    tokio::time::timeout(SETUP_BUDGET, async {
        let client = mc_host::Client::connect(publication)
            .await
            .map_err(|err| err.to_string())?;
        let route = client
            .open_route(target(), identity(session))
            .await
            .map_err(|err| err.to_string())?;
        Ok((Arc::new(client), route))
    })
    .await
    .map_err(|_| format!("ring setup exceeded {}s", SETUP_BUDGET.as_secs()))?
}

async fn request(client: Arc<mc_host::Client>, route: mc_host::RouteHandle) -> CallResult {
    client
        .request(
            route,
            FIXTURE_BODY.to_vec(),
            mc_host::RequestOptions {
                timeout: DRAIN_BUDGET,
                cancellation: None,
            },
        )
        .await
}

fn classify(result: &CallResult) -> Outcome {
    match result {
        Ok(response) if response.binary => Outcome::UnexpectedFrame,
        Ok(response) if response.body == FIXTURE_BODY => Outcome::Success,
        Ok(_) => Outcome::BodyMismatch,
        Err(error) => match error.outcome() {
            mc_host::SendOutcome::NotSent => Outcome::WriteFailure,
            mc_host::SendOutcome::OutcomeUnknown => Outcome::PeerClosed,
            mc_host::SendOutcome::Terminal => Outcome::ProtocolError,
        },
    }
}

fn record(histogram: &mut Histogram<u64>, outcomes: &mut OutcomeCounts, value_ns: u64) {
    if histogram.record(value_ns).is_ok() {
        outcomes.record(Outcome::Success);
    } else {
        outcomes.record(Outcome::HistogramOverflow);
    }
}

/// Configuration for sequential request/response latency measurement.
#[derive(Debug, Clone)]
pub struct SerialConfig {
    /// Untimed requests issued before measurement.
    pub warmup_ops: u64,
    /// Timed requests. Must be nonzero.
    pub measured_ops: u64,
    /// Nanosecond histogram configuration.
    pub histogram: HistogramConfig,
}

/// Results from sequential latency measurement.
#[derive(Debug)]
pub struct SerialResult {
    /// Issue-to-completion latency in nanoseconds for successful responses.
    pub histogram: Histogram<u64>,
    /// Terminal outcome counts for measured requests.
    pub outcomes: OutcomeCounts,
    /// Number of measured requests issued.
    pub scheduled: u64,
    /// Wall-clock duration of measured requests.
    pub elapsed: Duration,
}

/// Runs sequential latency measurement against `publication`.
///
/// Returns an error for zero measured operations, setup failures, invalid
/// histogram configuration, or failed warmup validation.
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
    let (client, route) = open_route(publication, "budget-serial").await?;
    for _ in 0..cfg.warmup_ops {
        let result = request(Arc::clone(&client), route).await;
        let outcome = classify(&result);
        if outcome != Outcome::Success {
            return Err(format!("warmup response failed validation ({outcome:?})"));
        }
    }

    let mut histogram = cfg.histogram.build()?;
    let mut outcomes = OutcomeCounts::default();
    let start = Instant::now();
    for _ in 0..cfg.measured_ops {
        let issue = Instant::now();
        let result = request(Arc::clone(&client), route).await;
        match classify(&result) {
            Outcome::Success => record(
                &mut histogram,
                &mut outcomes,
                issue.elapsed().as_nanos() as u64,
            ),
            outcome => outcomes.record(outcome),
        }
    }
    Ok(SerialResult {
        histogram,
        outcomes,
        scheduled: cfg.measured_ops,
        elapsed: start.elapsed(),
    })
}

/// Configuration for fixed-rate open-loop measurement.
#[derive(Debug, Clone)]
pub struct OpenLoopConfig {
    /// Scheduled requests per second. Valid range is 1 through 1,000,000,000.
    pub rate_per_sec: u64,
    /// Unmeasured schedule prefix.
    pub warmup: Duration,
    /// Measured schedule duration. Must be nonzero.
    pub measure: Duration,
    /// Maximum concurrent request tasks. Must be nonzero.
    pub inflight_cap: usize,
    /// Nanosecond histogram configuration.
    pub histogram: HistogramConfig,
}

/// Results from fixed-rate open-loop measurement.
#[derive(Debug)]
pub struct OpenLoopResult {
    /// Scheduled-slot-to-completion latency in nanoseconds.
    pub sched_to_completion: Histogram<u64>,
    /// Actual-issue-to-completion latency in nanoseconds.
    pub issue_to_completion: Histogram<u64>,
    /// Scheduled-slot-to-actual-issue lag in nanoseconds.
    pub scheduler_lag: Histogram<u64>,
    /// One terminal outcome per measured scheduled slot.
    pub outcomes: OutcomeCounts,
    /// Measured slots, including slots missed at the in-flight cap.
    pub scheduled_slots: u64,
    /// Wall-clock duration including warmup and drain.
    pub elapsed: Duration,
    /// Whether failure or unresolved drain work ended complete accounting.
    pub truncated: bool,
}

struct Completion {
    scheduled_ns: u64,
    issue_ns: u64,
    completion_ns: u64,
    measured: bool,
    result: CallResult,
}

fn record_completion(
    completion: Completion,
    warmup_ns: u64,
    sched: &mut Histogram<u64>,
    issue: &mut Histogram<u64>,
    lag: &mut Histogram<u64>,
    outcomes: &mut OutcomeCounts,
) -> bool {
    let outcome = classify(&completion.result);
    if !completion.measured {
        return outcome != Outcome::Success;
    }
    match outcome {
        Outcome::Success => {
            if sched
                .record(
                    completion
                        .completion_ns
                        .saturating_sub(completion.scheduled_ns),
                )
                .is_ok()
            {
                let _ = issue.record(completion.completion_ns.saturating_sub(completion.issue_ns));
                let _ = lag.record(completion.issue_ns.saturating_sub(completion.scheduled_ns));
                outcomes.record(Outcome::Success);
            } else {
                outcomes.record(Outcome::HistogramOverflow);
            }
            false
        }
        other => {
            outcomes.record(other);
            completion.scheduled_ns >= warmup_ns
        }
    }
}

/// Runs fixed-rate open-loop measurement against `publication`.
///
/// Returns an error for invalid rate, window, or concurrency settings and for
/// setup, histogram, or request-task failures.
pub fn run_open_loop(publication: &Path, cfg: &OpenLoopConfig) -> Result<OpenLoopResult, String> {
    if cfg.measure.is_zero() {
        return Err("open-loop arm requires a nonzero measurement window".to_owned());
    }
    if cfg.inflight_cap == 0 {
        return Err("open-loop in-flight cap must be nonzero".to_owned());
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
    let (client, route) = open_route(publication, "budget-open").await?;
    let start = Instant::now();
    let warmup_ns = cfg.warmup.as_nanos() as u64;
    let deadline_ns = (cfg.warmup + cfg.measure).as_nanos() as u64;
    let mut sched = cfg.histogram.build()?;
    let mut issue = cfg.histogram.build()?;
    let mut lag = cfg.histogram.build()?;
    let mut outcomes = OutcomeCounts::default();
    let mut requests: JoinSet<Completion> = JoinSet::new();
    let mut measured_inflight = 0u64;
    let mut scheduled_slots = 0u64;
    let mut truncated = false;
    let mut slot = 0u64;

    'schedule: loop {
        let scheduled_ns = open_loop_offset_ns(slot, cfg.rate_per_sec);
        slot += 1;
        if scheduled_ns >= deadline_ns {
            break;
        }
        let at = start + Duration::from_nanos(scheduled_ns);
        while Instant::now() < at && !requests.is_empty() {
            tokio::select! {
                joined = requests.join_next() => {
                    let completion = joined.ok_or("request set ended unexpectedly")?
                        .map_err(|err| format!("request task failed: {err}"))?;
                    if completion.measured { measured_inflight -= 1; }
                    if record_completion(completion, warmup_ns, &mut sched, &mut issue, &mut lag, &mut outcomes) {
                        truncated = true;
                        break 'schedule;
                    }
                }
                () = tokio::time::sleep_until(at.into()) => break,
            }
        }
        tokio::time::sleep_until(at.into()).await;
        let measured = scheduled_ns >= warmup_ns;
        while let Some(joined) = requests.try_join_next() {
            let completion = joined.map_err(|err| format!("request task failed: {err}"))?;
            if completion.measured {
                measured_inflight -= 1;
            }
            if record_completion(
                completion,
                warmup_ns,
                &mut sched,
                &mut issue,
                &mut lag,
                &mut outcomes,
            ) {
                truncated = true;
                break 'schedule;
            }
        }
        if measured {
            scheduled_slots += 1;
        }
        if requests.len() >= cfg.inflight_cap {
            if measured {
                outcomes.record(Outcome::MissedSlot);
            }
            continue;
        }
        let issue_ns = start.elapsed().as_nanos() as u64;
        if measured {
            measured_inflight += 1;
        }
        let task_client = Arc::clone(&client);
        requests.spawn(async move {
            let result = request(task_client, route).await;
            Completion {
                scheduled_ns,
                issue_ns,
                completion_ns: start.elapsed().as_nanos() as u64,
                measured,
                result,
            }
        });
    }

    let drain_deadline = Instant::now() + DRAIN_BUDGET;
    while !requests.is_empty() {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, requests.join_next()).await {
            Ok(Some(Ok(completion))) => {
                if completion.measured {
                    measured_inflight -= 1;
                }
                truncated |= record_completion(
                    completion,
                    warmup_ns,
                    &mut sched,
                    &mut issue,
                    &mut lag,
                    &mut outcomes,
                );
            }
            Ok(Some(Err(err))) => return Err(format!("request task failed: {err}")),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    if measured_inflight > 0 {
        for _ in 0..measured_inflight {
            outcomes.record(Outcome::UnresolvedAtDrain);
        }
        requests.abort_all();
        truncated = true;
    }
    Ok(OpenLoopResult {
        sched_to_completion: sched,
        issue_to_completion: issue,
        scheduler_lag: lag,
        outcomes,
        scheduled_slots,
        elapsed: start.elapsed(),
        truncated,
    })
}

/// Configuration for closed-loop throughput measurement.
#[derive(Debug, Clone)]
pub struct ThroughputConfig {
    /// Constant request concurrency. Must be nonzero.
    pub depth: usize,
    /// Warmup duration. Must be nonzero.
    pub warmup: Duration,
    /// Measurement duration. Must be nonzero.
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
    pub drained: u64,
    pub truncated: bool,
}

fn spawn_request(
    requests: &mut JoinSet<CallResult>,
    client: &Arc<mc_host::Client>,
    route: mc_host::RouteHandle,
) {
    let client = Arc::clone(client);
    requests.spawn(async move { request(client, route).await });
}

/// Runs closed-loop throughput measurement against `publication`.
///
/// Returns an error for invalid configuration, setup failure, request-task
/// failure, invalid warmup response, or incomplete drain.
pub fn run_throughput(
    publication: &Path,
    cfg: &ThroughputConfig,
) -> Result<ThroughputResult, String> {
    if cfg.depth == 0 {
        return Err("throughput depth must be nonzero".to_owned());
    }
    if cfg.warmup.is_zero() || cfg.measure.is_zero() {
        return Err("throughput arm requires nonzero warmup and measurement windows".to_owned());
    }
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
    let (client, route) = open_route(publication, "budget-throughput").await?;
    let mut requests = JoinSet::new();
    for _ in 0..cfg.depth {
        spawn_request(&mut requests, &client, route);
    }
    let warmup_deadline = Instant::now() + cfg.warmup;
    while Instant::now() < warmup_deadline {
        let remaining = warmup_deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, requests.join_next()).await {
            Ok(Some(Ok(result))) if classify(&result) == Outcome::Success => {
                spawn_request(&mut requests, &client, route);
            }
            Ok(Some(Ok(result))) => {
                return Err(format!(
                    "warmup response failed validation ({:?})",
                    classify(&result)
                ));
            }
            Ok(Some(Err(err))) => return Err(format!("request task failed: {err}")),
            _ => break,
        }
    }
    while let Some(joined) = requests.join_next().await {
        let result = joined.map_err(|err| format!("request task failed: {err}"))?;
        if classify(&result) != Outcome::Success {
            return Err(format!(
                "warmup drain failed validation ({:?})",
                classify(&result)
            ));
        }
    }

    let measure_start = Instant::now();
    let measure_deadline = measure_start + cfg.measure;
    let mut offered = 0u64;
    let mut outcomes = OutcomeCounts::default();
    for _ in 0..cfg.depth {
        spawn_request(&mut requests, &client, route);
        offered += 1;
    }
    let mut truncated = false;
    while Instant::now() < measure_deadline {
        let remaining = measure_deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, requests.join_next()).await {
            Ok(Some(Ok(result))) => {
                let outcome = classify(&result);
                outcomes.record(outcome);
                if outcome != Outcome::Success {
                    truncated = true;
                    break;
                }
                if Instant::now() < measure_deadline {
                    spawn_request(&mut requests, &client, route);
                    offered += 1;
                }
            }
            Ok(Some(Err(err))) => return Err(format!("request task failed: {err}")),
            _ => break,
        }
    }
    let measured = measure_start.elapsed().min(cfg.measure);
    let drain_deadline = Instant::now() + DRAIN_BUDGET;
    let mut drained = 0u64;
    while !requests.is_empty() {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, requests.join_next()).await {
            Ok(Some(Ok(result))) if classify(&result) == Outcome::Success => drained += 1,
            Ok(Some(Ok(_))) | Err(_) => {
                requests.abort_all();
                return Err(format!(
                    "connection failed with {} in-flight response(s) undrained",
                    requests.len()
                ));
            }
            Ok(Some(Err(err))) => return Err(format!("request task failed: {err}")),
            Ok(None) => break,
        }
    }
    let secs = measured.as_secs_f64().max(f64::MIN_POSITIVE);
    Ok(ThroughputResult {
        offered,
        terminal: outcomes.total(),
        successful: outcomes.success,
        goodput_bytes_per_sec: outcomes.success as f64 * FIXTURE_BODY.len() as f64 / secs,
        successful_per_sec: outcomes.success as f64 / secs,
        outcomes,
        measured,
        drained,
        truncated,
    })
}

/// Reusable sequential round-trip probe with one route and runtime.
pub struct SerialProbe {
    runtime: tokio::runtime::Runtime,
    client: Arc<mc_host::Client>,
    route: mc_host::RouteHandle,
}

impl SerialProbe {
    /// Connects a probe, bounded by the 30-second setup budget.
    pub fn connect(publication: &Path) -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        let (client, route) = runtime.block_on(open_route(publication, "budget-criterion"))?;
        Ok(Self {
            runtime,
            client,
            route,
        })
    }

    /// Runs `n` sequential validated round trips and returns wall-clock duration.
    ///
    /// Returns an error on the first non-success terminal outcome.
    pub fn roundtrips(&mut self, n: u64) -> Result<Duration, String> {
        let client = Arc::clone(&self.client);
        let route = self.route;
        self.runtime.block_on(async move {
            let start = Instant::now();
            for _ in 0..n {
                let result = request(Arc::clone(&client), route).await;
                let outcome = classify(&result);
                if outcome != Outcome::Success {
                    return Err(format!("unexpected terminal during probe ({outcome:?})"));
                }
            }
            Ok(start.elapsed())
        })
    }
}
