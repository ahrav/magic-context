//! Shared measurement rules for the mc-host performance harness.
//!
//! Pure timing, percentile, workload, and outcome-accounting logic used by
//! `examples/perf_load.rs`, the `ipc_budget` benchmark, and their tests.
//! Contract: issue-to-validated-terminal is the RTT boundary, scheduled
//! time exists only for open-loop accounting, and every scheduled slot must
//! resolve to exactly one terminal outcome.

#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Version label for the committed compact JSON workload fixture.
pub const FIXTURE_LABEL: &str = "compact-json-v1";

/// Committed compact JSON request fixture matching the production client's
/// small-message shape (`JSON.stringify` of a small op object, binary=false;
/// see packages/plugin/src/shared/mc-host-client/client.ts `encodeBody`).
pub const FIXTURE_BODY: &[u8] =
    br#"{"op":"perf.echo","v":1,"payload":"0123456789abcdef0123456789abcdef"}"#;

/// The fixture is JSON text on the wire, never a binary frame.
pub const FIXTURE_BINARY: bool = false;

/// Minimum successful post-warmup observations before any tail percentile
/// (p99.9) may be published for a run.
pub const TAIL_SAMPLE_FLOOR: u64 = 30_000;

/// Minimum successful post-warmup observations per repetition for a headline
/// p99.9 row in the published budget.
pub const HEADLINE_TAIL_FLOOR: u64 = 100_000;

/// Upper bound accepted for a response body length. The fixture is 69
/// bytes and error terminals are small JSON; anything larger is a
/// corrupted or hostile length field that must fail the run before it
/// drives a multi-gigabyte allocation from an untrusted 32-bit value.
pub const MAX_BODY_LEN: u32 = 1 << 20;

/// Identity of a workload: enough to prove two runs measured the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkloadId {
    pub label: String,
    pub len: usize,
    pub sha256: String,
    pub binary: bool,
}

/// The committed fixture's identity record.
pub fn fixture_workload() -> WorkloadId {
    WorkloadId {
        label: FIXTURE_LABEL.to_owned(),
        len: FIXTURE_BODY.len(),
        sha256: sha256_hex(FIXTURE_BODY),
        binary: FIXTURE_BINARY,
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Nearest-rank percentile over an ascending-sorted sample vector: the
/// result is always an actually observed sample (same rule as
/// packages/plugin/scripts/retrieval-benchmark/timing.ts).
pub fn nearest_rank(sorted: &[u64], percentile: f64) -> Option<u64> {
    if sorted.is_empty() || !(percentile > 0.0 && percentile <= 100.0) {
        return None;
    }
    let rank = ((percentile / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.max(1) - 1])
}

/// Every scheduled slot resolves to exactly one of these terminal outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Success,
    ProtocolError,
    MissedSlot,
    WriteFailure,
    PeerClosed,
    UnexpectedFrame,
    BodyMismatch,
    UnresolvedAtDrain,
    HistogramOverflow,
}

/// Terminal-outcome counters with a conservation check.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OutcomeCounts {
    pub success: u64,
    pub protocol_error: u64,
    pub missed_slot: u64,
    pub write_failure: u64,
    pub peer_closed: u64,
    pub unexpected_frame: u64,
    pub body_mismatch: u64,
    pub unresolved_at_drain: u64,
    pub histogram_overflow: u64,
}

impl OutcomeCounts {
    pub fn record(&mut self, outcome: Outcome) {
        let slot = match outcome {
            Outcome::Success => &mut self.success,
            Outcome::ProtocolError => &mut self.protocol_error,
            Outcome::MissedSlot => &mut self.missed_slot,
            Outcome::WriteFailure => &mut self.write_failure,
            Outcome::PeerClosed => &mut self.peer_closed,
            Outcome::UnexpectedFrame => &mut self.unexpected_frame,
            Outcome::BodyMismatch => &mut self.body_mismatch,
            Outcome::UnresolvedAtDrain => &mut self.unresolved_at_drain,
            Outcome::HistogramOverflow => &mut self.histogram_overflow,
        };
        *slot += 1;
    }

    pub fn total(&self) -> u64 {
        self.success
            + self.protocol_error
            + self.missed_slot
            + self.write_failure
            + self.peer_closed
            + self.unexpected_frame
            + self.body_mismatch
            + self.unresolved_at_drain
            + self.histogram_overflow
    }

    pub fn merge(&mut self, other: &OutcomeCounts) {
        self.success += other.success;
        self.protocol_error += other.protocol_error;
        self.missed_slot += other.missed_slot;
        self.write_failure += other.write_failure;
        self.peer_closed += other.peer_closed;
        self.unexpected_frame += other.unexpected_frame;
        self.body_mismatch += other.body_mismatch;
        self.unresolved_at_drain += other.unresolved_at_drain;
        self.histogram_overflow += other.histogram_overflow;
    }

    /// True when every scheduled slot has exactly one terminal outcome.
    pub fn conserved(&self, scheduled_slots: u64) -> bool {
        self.total() == scheduled_slots
    }
}

/// Validates an open-loop offered rate: the per-request interval must be a
/// representable nonzero nanosecond count, otherwise the arm would silently
/// degrade into unrestricted closed-loop traffic.
pub fn open_loop_interval_ns(rate_per_sec: u64) -> Result<u64, String> {
    if rate_per_sec == 0 {
        return Err("offered rate must be nonzero".to_owned());
    }
    // A truncated interval silently raises the actual arrival rate while
    // every manifest retains the requested label; only exactly
    // representable rates are honest.
    if !1_000_000_000u64.is_multiple_of(rate_per_sec) {
        return Err(format!(
            "offered rate {rate_per_sec}/s has no exact nanosecond interval; \
             choose a rate that divides 1e9"
        ));
    }
    match 1_000_000_000u64.checked_div(rate_per_sec) {
        Some(interval) if interval > 0 => Ok(interval),
        _ => Err(format!(
            "offered rate {rate_per_sec}/s has no representable nanosecond interval"
        )),
    }
}

/// True when a run has enough successful post-warmup observations to
/// publish a p99.9 for that run at all.
pub fn tail_publishable(successful_observations: u64) -> bool {
    successful_observations >= TAIL_SAMPLE_FLOOR
}

/// Latency summary computed with nearest-rank semantics. `p999` is `None`
/// when the sample count is below `TAIL_SAMPLE_FLOOR` (evidence retained,
/// headline suppressed).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LatencySummary {
    pub count: u64,
    pub p50_ns: u64,
    pub p90_ns: u64,
    pub p95_ns: u64,
    pub p99_ns: u64,
    pub p999_ns: Option<u64>,
    pub max_ns: u64,
}

impl LatencySummary {
    pub fn from_unsorted(mut samples: Vec<u64>) -> Option<Self> {
        samples.sort_unstable();
        let count = samples.len() as u64;
        Some(Self {
            count,
            p50_ns: nearest_rank(&samples, 50.0)?,
            p90_ns: nearest_rank(&samples, 90.0)?,
            p95_ns: nearest_rank(&samples, 95.0)?,
            p99_ns: nearest_rank(&samples, 99.0)?,
            p999_ns: if tail_publishable(count) {
                nearest_rank(&samples, 99.9)
            } else {
                None
            },
            max_ns: *samples.last()?,
        })
    }
}

/// Wire methods exercised by the Synapse benchmark.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum SynapseMethod {
    Query,
    Batch,
    Result,
}

impl SynapseMethod {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Query => "embed.query",
            Self::Batch => "embed.batch",
            Self::Result => "embed.result",
        }
    }
}

/// Mutually exclusive attempt-ledger categories from the frozen contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptDisposition {
    Success,
    RetryableRejection,
    Timeout,
    Poll,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AttemptRecord {
    pub logical_id: u64,
    pub attempt_id: u64,
    pub method: SynapseMethod,
    pub disposition: AttemptDisposition,
    pub code: Option<String>,
    pub retry_after_ms: Option<u64>,
    pub actual_send_ns: u64,
    pub terminal_ns: u64,
    pub latency_ns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogicalDisposition {
    Completed,
    Rejected,
    TimedOut,
    InFlight,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LogicalRecord {
    pub logical_id: u64,
    pub scheduled_start_ns: Option<u64>,
    pub actual_first_send_ns: u64,
    pub terminal_ns: u64,
    pub latency_ns: u64,
    pub disposition: LogicalDisposition,
    pub terminal_code: Option<String>,
    pub attempts: u64,
    pub polls: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SynapseLedgerSummary {
    pub valid: bool,
    pub errors: Vec<String>,
    pub offered: u64,
    pub offered_by_method: BTreeMap<String, u64>,
    pub admitted_by_method: BTreeMap<String, u64>,
    pub completed: u64,
    pub completed_by_method: BTreeMap<String, u64>,
    pub rejected_by_method_code: BTreeMap<String, u64>,
    pub timed_out: u64,
    pub timed_out_by_method_code: BTreeMap<String, u64>,
    pub in_flight: u64,
    pub attempts: u64,
    pub successes: u64,
    pub retryable_rejections: u64,
    pub attempt_timeouts: u64,
    pub polls: u64,
    pub amplification: f64,
}

/// Validates both frozen count ledgers before any rate or percentile is used.
pub fn validate_synapse_ledgers(
    logical: &[LogicalRecord],
    attempts: &[AttemptRecord],
) -> SynapseLedgerSummary {
    let offered = logical.len() as u64;
    let completed = logical
        .iter()
        .filter(|record| record.disposition == LogicalDisposition::Completed)
        .count() as u64;
    let terminal_rejected = logical
        .iter()
        .filter(|record| record.disposition == LogicalDisposition::Rejected)
        .count() as u64;
    let timed_out = logical
        .iter()
        .filter(|record| record.disposition == LogicalDisposition::TimedOut)
        .count() as u64;
    let in_flight = logical
        .iter()
        .filter(|record| record.disposition == LogicalDisposition::InFlight)
        .count() as u64;

    let successes = attempts
        .iter()
        .filter(|record| record.disposition == AttemptDisposition::Success)
        .count() as u64;
    let retryable_rejections = attempts
        .iter()
        .filter(|record| record.disposition == AttemptDisposition::RetryableRejection)
        .count() as u64;
    let attempt_timeouts = attempts
        .iter()
        .filter(|record| record.disposition == AttemptDisposition::Timeout)
        .count() as u64;
    let polls = attempts
        .iter()
        .filter(|record| record.disposition == AttemptDisposition::Poll)
        .count() as u64;

    let mut admitted_by_method = BTreeMap::new();
    let mut rejected_by_method_code = BTreeMap::new();
    let mut timed_out_by_method_code = BTreeMap::new();
    for attempt in attempts {
        let queue_full = attempt.code.as_deref() == Some("queue_full");
        if !queue_full {
            *admitted_by_method
                .entry(attempt.method.wire_name().to_owned())
                .or_default() += 1;
        }
        if queue_full {
            let key = format!(
                "{}:{}",
                attempt.method.wire_name(),
                attempt.code.as_deref().unwrap_or("unknown")
            );
            *rejected_by_method_code.entry(key).or_default() += 1;
        }
        if attempt.disposition == AttemptDisposition::Timeout
            || attempt
                .code
                .as_deref()
                .is_some_and(|code| code.contains("timeout"))
        {
            let key = format!(
                "{}:{}",
                attempt.method.wire_name(),
                attempt.code.as_deref().unwrap_or("timeout")
            );
            *timed_out_by_method_code.entry(key).or_default() += 1;
        }
    }
    let mut offered_by_method = BTreeMap::new();
    let mut completed_by_method = BTreeMap::new();
    for request in logical {
        let method = attempts
            .iter()
            .find(|attempt| attempt.logical_id == request.logical_id)
            .map(|attempt| attempt.method.wire_name())
            .unwrap_or("unknown")
            .to_owned();
        *offered_by_method.entry(method.clone()).or_default() += 1;
        if request.disposition == LogicalDisposition::Completed {
            *completed_by_method.entry(method).or_default() += 1;
        }
    }

    let mut errors = Vec::new();
    if offered != completed + terminal_rejected + timed_out + in_flight {
        errors.push(format!(
            "logical ledger: {offered} != {completed} + {terminal_rejected} + {timed_out} + {in_flight}"
        ));
    }
    let attempt_total = attempts.len() as u64;
    if attempt_total != successes + retryable_rejections + attempt_timeouts + polls {
        errors.push(format!(
            "attempt ledger: {attempt_total} != {successes} + {retryable_rejections} + {attempt_timeouts} + {polls}"
        ));
    }
    for request in logical {
        let actual = attempts
            .iter()
            .filter(|attempt| attempt.logical_id == request.logical_id)
            .count() as u64;
        if actual != request.attempts {
            errors.push(format!(
                "logical {} records {} attempts but owns {actual}",
                request.logical_id, request.attempts
            ));
        }
    }

    SynapseLedgerSummary {
        valid: errors.is_empty(),
        errors,
        offered,
        offered_by_method,
        admitted_by_method,
        completed,
        completed_by_method,
        rejected_by_method_code,
        timed_out,
        timed_out_by_method_code,
        in_flight,
        attempts: attempt_total,
        successes,
        retryable_rejections,
        attempt_timeouts,
        polls,
        amplification: if offered == 0 {
            0.0
        } else {
            attempt_total as f64 / offered as f64
        },
    }
}

/// Deterministic generator used only by the benchmark's jitter policy.
#[derive(Debug, Clone)]
pub struct DeterministicRng(u64);

impl DeterministicRng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn unit(&mut self) -> f64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value as f64 / (u64::MAX as f64 + 1.0)
    }

    /// Mirrors plugin retry jitter: `[base, 3 * base)`.
    pub fn retry_delay_ms(&mut self, base_ms: u64) -> f64 {
        base_ms as f64 * (1.0 + 2.0 * self.unit())
    }

    /// Mirrors plugin fast-first poll jitter: `[1ms, 2ms)`.
    pub fn first_poll_delay_ms(&mut self) -> f64 {
        1.0 + self.unit()
    }
}

/// Advances one pending-poll delay using the landed plugin policy.
pub fn next_poll_delay_ms(previous_ms: f64, served_cap_ms: u64) -> f64 {
    (previous_ms * 1.6)
        .max(10.0)
        .min(served_cap_ms.max(10) as f64)
}

/// Frozen treatment arm. Policy methods keep the benchmark's client behavior
/// in one place so a host hint cannot accidentally leak into control arms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SynapseVariant {
    #[serde(rename = "baseline")]
    Baseline,
    #[serde(rename = "hygiene-only")]
    HygieneOnly,
    #[serde(rename = "a")]
    A,
    #[serde(rename = "b")]
    B,
    #[serde(rename = "c")]
    C,
    #[serde(rename = "a+c")]
    APlusC,
}

impl SynapseVariant {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "baseline" => Ok(Self::Baseline),
            "hygiene-only" => Ok(Self::HygieneOnly),
            "a" => Ok(Self::A),
            "b" => Ok(Self::B),
            "c" => Ok(Self::C),
            "a+c" => Ok(Self::APlusC),
            _ => Err("variant must be baseline, hygiene-only, a, b, c, or a+c".to_owned()),
        }
    }

    pub fn needs_waiting_queries(self) -> bool {
        matches!(self, Self::A | Self::APlusC)
    }

    /// `None` is the historical query-only admission loop: retry until the
    /// single absolute deadline. Every treatment/hygiene arm has four total
    /// attempts.
    pub fn query_attempt_limit(self) -> Option<u32> {
        (!matches!(self, Self::Baseline)).then_some(4)
    }

    pub fn uses_served_query_hint(self) -> bool {
        matches!(self, Self::B | Self::APlusC)
    }

    pub fn fast_polls(self) -> bool {
        matches!(self, Self::C | Self::APlusC)
    }

    pub fn initial_poll_delay_ms(self, rng: &mut DeterministicRng) -> Option<f64> {
        self.fast_polls().then(|| rng.first_poll_delay_ms())
    }

    pub fn pending_poll_delay_ms(self, previous_ms: f64, served_ms: u64) -> f64 {
        if self.fast_polls() {
            next_poll_delay_ms(previous_ms, served_ms)
        } else {
            served_ms.max(10) as f64
        }
    }

    /// Query admission delay in milliseconds. Baseline reproduces the fixed,
    /// unjittered 100 ms loop. Other arms jitter either the fallback or the
    /// served hint over `[base, 3base)`.
    pub fn query_retry_delay_ms(
        self,
        served_hint_ms: Option<u64>,
        rng: &mut DeterministicRng,
    ) -> f64 {
        if matches!(self, Self::Baseline) {
            100.0
        } else {
            let base = if self.uses_served_query_hint() {
                served_hint_ms.unwrap_or(100)
            } else {
                100
            };
            rng.retry_delay_ms(base)
        }
    }
}
