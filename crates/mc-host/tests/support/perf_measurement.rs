//! This module centralizes measurement rules shared by the mc-host performance harness.
//!
//! The performance harness uses this module only for timing, percentiles, workload identity, and outcome accounting.
//! `examples/perf_load.rs`, the `ipc_budget` benchmark, and their tests use this module.
//! `RTT` spans issue through validated terminal outcome.
//! Every scheduled slot resolves to exactly one terminal outcome.

#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const FIXTURE_LABEL: &str = "compact-json-v1";

/// `FIXTURE_BODY` matches the production client's compact JSON request encoding.
/// `client.ts::encodeBody` defines the production encoding that `FIXTURE_BODY` matches.
pub const FIXTURE_BODY: &[u8] =
    br#"{"op":"perf.echo","v":1,"payload":"0123456789abcdef0123456789abcdef"}"#;

pub const FIXTURE_BINARY: bool = false;

/// A run requires at least 30,000 successful post-warmup observations before publishing p99.9.
pub const TAIL_SAMPLE_FLOOR: u64 = 30_000;

/// A published headline p99.9 row requires at least 100,000 successful post-warmup observations per repetition.
pub const HEADLINE_TAIL_FLOOR: u64 = 100_000;

/// `MAX_BODY_LEN` caps bodies at 1 MiB because valid fixture and error bodies are small, preventing untrusted `u32` lengths from causing multi-gigabyte allocations.
pub const MAX_BODY_LEN: u32 = 1 << 20;

/// `WorkloadId` records fixture metadata for comparing runs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkloadId {
    pub label: String,
    pub len: usize,
    pub sha256: String,
    pub binary: bool,
}

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

/// `nearest_rank` returns an observed sample rather than an interpolated value.
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

    pub fn conserved(&self, scheduled_slots: u64) -> bool {
        self.total() == scheduled_slots
    }
}

/// `validate_rate` rejects 0 and rates above 1e9/s because zero has no arrivals and higher rates produce 0-ns slot spacing.
pub fn validate_open_loop_rate(rate_per_sec: u64) -> Result<(), String> {
    if rate_per_sec == 0 {
        return Err("offered rate must be nonzero".to_owned());
    }
    if rate_per_sec > 1_000_000_000 {
        return Err(format!(
            "offered rate {rate_per_sec}/s has a sub-nanosecond interval; \
             the nanosecond schedule cannot separate consecutive slots"
        ));
    }
    Ok(())
}

/// `slot_offset_ns` uses `u128` to prevent overflow when multiplying `slot` by 1e9.
///
/// Each slot is placed independently against the ideal schedule, so floor error never accumulates.
/// Each offset's floor error is strictly below 1 ns and never accumulates.
/// For every valid rate, `open_loop_offset_ns(rate, rate)` is exactly `1_000_000_000`.
/// For every valid rate, the schedule offers exactly `rate_per_sec` slots per whole second.
/// Consecutive-slot spacing varies by at most 1 ns around the nominal interval.
///
/// Callers must invoke [`validate_open_loop_rate`] before calling this function.
pub fn open_loop_offset_ns(slot: u64, rate_per_sec: u64) -> u64 {
    u64::try_from(u128::from(slot) * 1_000_000_000u128 / u128::from(rate_per_sec))
        .expect("scheduled offset exceeds u64 nanoseconds")
}

/// A run needs at least `TAIL_SAMPLE_FLOOR` successful post-warmup observations to publish p99.9.
pub fn tail_publishable(successful_observations: u64) -> bool {
    successful_observations >= TAIL_SAMPLE_FLOOR
}

/// `LatencySummary` uses nearest-rank percentiles; `p999_ns` is `None` below `TAIL_SAMPLE_FLOOR`.
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

/// The Synapse benchmark exercises these wire methods.
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

/// The harness records the timeout outcome when its deadline fires before any terminal outcome arrives.
/// The unknown-admission outcome marks an attempt whose admission outcome the wire never revealed.
/// [`validate_synapse_ledgers`] excludes attempts whose wire admission outcome is unknown from admitted and rejected subtotals.
pub const ATTEMPT_TIMEOUT_CODE: &str = "attempt_timeout";

/// Attempt-ledger categories are mutually exclusive.
///
/// Attempts partition into successes, retryable rejections, timeouts, and polls.
/// [`Self::Failure`] records a non-poll wire call answered with an error the client policy cannot act on.
/// Examples include `artifact_invalid`, `schema_violation`, and `cancelled`.
/// [`Self::Failure`] terminals occur only in an already-invalid run.
/// [`validate_synapse_ledgers`] reports any nonzero [`Self::Failure`] count as a ledger error.
/// Every retained repetition satisfies the frozen four-way identity.
/// Recording [`Self::Failure`] terminals as successes would corrupt the raw evidence used to diagnose an invalid run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptDisposition {
    Success,
    RetryableRejection,
    Timeout,
    Poll,
    Failure,
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
    /// The owning logical request's window class determines whether an attempt is included or excluded.
    /// An attempt is included or excluded with its owning logical request, not by its send instant.
    ///
    /// An attempt is one wire call of its owning logical request, not an independent observation.
    /// An attempt belongs to its logical request, and [`validate_synapse_ledgers`] rejects repetitions whose logical rows disagree with their owned attempts.
    /// Classifying attempts by `actual_send_ns` would mark measured requests that retry or poll past the window end inadmissible.
    /// Counting attempts and requests over the same logical requests keeps amplification conservative.
    /// Excluding a censored request's post-boundary attempts would understate amplification.
    ///
    /// Missing `window` markers must fail parsing rather than default to `Measured`.
    pub window: WindowClass,
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
    /// `window` classifies the hold-window segment in which the logical request opened.
    pub window: WindowClass,
}

/// `IN_FLIGHT_AT_WINDOW_END_CODE` marks requests that had not settled when measurement ended.
/// Any wire outcome remains in the attempt ledger; the logical row records only that the request had not settled when measurement ended.
pub const IN_FLIGHT_AT_WINDOW_END_CODE: &str = "in_flight_at_window_end";

/// Warmup discards the first 10% of the hold window.
const WARMUP_WINDOW_DIVISOR: u64 = 10;

/// `WindowClass` classifies each observation relative to the frozen hold window.
///
/// `WindowClass` prevents the contradictory inclusion states that two exclusion booleans could represent.
/// [`WindowClass::Measured`] rows feed ledgers, rates, percentiles, and gates;
/// `Warmup` and `AfterWindow` rows remain in raw evidence so their exclusion is auditable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowClass {
    /// `Warmup` classifies requests opened inside the window's warmup prefix.
    Warmup,
    /// `Measured` classifies requests opened at or after the warmup boundary and before the window end.
    /// window end.
    Measured,
    /// `AfterWindow` classifies requests whose first wire send lands at or after the window end.
    /// A closed-loop worker can pass its pre-dispatch boundary test yet send its first wire call after the window closes.
    /// Requests whose first wire send lands after the window closes must not count as offered.
    AfterWindow,
}

impl WindowClass {
    pub fn is_measured(self) -> bool {
        matches!(self, Self::Measured)
    }
}

/// `ServiceSample` includes a start timestamp so consumers can attribute it to a window class.
///
/// A duration without a start instant cannot distinguish warmup, measured, and after-window calls.
///
/// `started_ns` alone determines `ServiceSample` classification.
/// A call that finishes after the boundary remains a complete service-time observation.
/// Excluding calls that finish after the window end biases service-time observations toward shorter calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServiceSample {
    /// `started_ns` is the engine-call start on the harness wire clock; completion is `started_ns + service_ns`.
    pub started_ns: u64,
    /// `service_ns` measures the engine call's wall-clock duration.
    pub service_ns: u64,
    pub window: WindowClass,
}

/// `HoldWindow` represents one repetition's scheduled wire-clock hold window.
///
/// `HoldWindow` derives both boundaries from the scheduled span, not observed completions.
/// `warmup_end_ns` excludes the warmup prefix from estimates.
/// `end_ns` censors unsettled requests instead of awaiting completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldWindow {
    pub start_ns: u64,
    pub warmup_end_ns: u64,
    pub end_ns: u64,
}

impl HoldWindow {
    /// `start_ns` is the first scheduled wire-clock slot; `seconds` is the fixed hold duration.
    pub fn new(start_ns: u64, seconds: u64) -> Self {
        let span_ns = seconds.saturating_mul(1_000_000_000);
        Self {
            start_ns,
            warmup_end_ns: start_ns.saturating_add(span_ns / WARMUP_WINDOW_DIVISOR),
            end_ns: start_ns.saturating_add(span_ns),
        }
    }

    /// already outside.
    pub fn classify(&self, opened_ns: u64) -> WindowClass {
        if opened_ns < self.warmup_end_ns {
            WindowClass::Warmup
        } else if opened_ns >= self.end_ns {
            WindowClass::AfterWindow
        } else {
            WindowClass::Measured
        }
    }

    /// `opened_ns` uses scheduled start for open-loop work and first wire send for closed-loop work.
    pub fn opened_ns(record: &LogicalRecord) -> u64 {
        record
            .scheduled_start_ns
            .unwrap_or(record.actual_first_send_ns)
    }

    ///
    /// A measured request that settles after `end_ns` was in flight when the window closed.
    /// Recording a post-window outcome as a completion or timeout understates censoring and inflates the completed rate.
    /// Attempt rows retain the observed wire outcome.
    ///
    /// Warmup and after-window requests are excluded from estimates.
    /// Rewriting an excluded request's disposition would discard its true outcome from raw evidence.
    /// `IN_FLIGHT_AT_WINDOW_END_CODE` applies only when the measured window closes while the request is in flight.
    pub fn stamp(&self, logical: &mut [LogicalRecord], attempts: &mut [AttemptRecord]) {
        let mut classes = std::collections::BTreeMap::new();
        for record in logical.iter_mut() {
            record.window = self.classify(Self::opened_ns(record));
            classes.insert(record.logical_id, record.window);
            if record.window.is_measured()
                && record.terminal_ns > self.end_ns
                && record.disposition != LogicalDisposition::InFlight
            {
                record.disposition = LogicalDisposition::InFlight;
                record.terminal_code = Some(IN_FLIGHT_AT_WINDOW_END_CODE.to_owned());
            }
        }
        for attempt in attempts.iter_mut() {
            // An `AttemptRecord` inherits its `window` from its `logical_id`'s `LogicalRecord`, not from its own send time.
            // An attempt without a matching logical row cannot be attributed to the measured set.
            attempt.window = classes
                .get(&attempt.logical_id)
                .copied()
                .unwrap_or(WindowClass::AfterWindow);
        }
    }
}

/// Only measured records feed rates, percentiles, and gates; raw evidence retains measured and excluded records.
pub fn partition_measured<T: Clone>(
    records: &[T],
    class: impl Fn(&T) -> WindowClass,
) -> (Vec<T>, Vec<T>) {
    let mut measured = Vec::with_capacity(records.len());
    let mut excluded = Vec::new();
    for record in records {
        if class(record).is_measured() {
            measured.push(record.clone());
        } else {
            excluded.push(record.clone());
        }
    }
    (measured, excluded)
}

pub fn count_class<T>(records: &[T], want: WindowClass, class: impl Fn(&T) -> WindowClass) -> u64 {
    records.iter().filter(|row| class(row) == want).count() as u64
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SynapseLedgerSummary {
    pub valid: bool,
    pub errors: Vec<String>,
    pub offered: u64,
    pub offered_by_method: BTreeMap<String, u64>,
    pub admitted_by_method: BTreeMap<String, u64>,
    /// An attempt is outcome-unknown when the client deadline fires before any terminal arrives.
    /// The harness cannot determine whether the host consumed an admission permit or job slot.
    /// `outcome_unknown_by_method` is excluded from `admitted_by_method` because that subtotal is the measured λ_adm.
    pub outcome_unknown_by_method: BTreeMap<String, u64>,
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
    /// An admissible repetition has no non-poll wire calls answered with an error outside the client policy vocabulary.
    pub failures: u64,
    pub amplification: f64,
}

/// The ledger validator checks both frozen count ledgers before rates or percentiles are used.
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
    let failures = attempts
        .iter()
        .filter(|record| record.disposition == AttemptDisposition::Failure)
        .count() as u64;

    let mut admitted_by_method = BTreeMap::new();
    let mut outcome_unknown_by_method = BTreeMap::new();
    let mut rejected_by_method_code = BTreeMap::new();
    let mut timed_out_by_method_code = BTreeMap::new();
    let mut first_method_by_logical: BTreeMap<u64, &'static str> = BTreeMap::new();
    let mut attempts_by_logical: BTreeMap<u64, u64> = BTreeMap::new();
    let mut polls_by_logical: BTreeMap<u64, u64> = BTreeMap::new();
    for attempt in attempts {
        first_method_by_logical
            .entry(attempt.logical_id)
            .or_insert_with(|| attempt.method.wire_name());
        *attempts_by_logical.entry(attempt.logical_id).or_default() += 1;
        if attempt.disposition == AttemptDisposition::Poll {
            *polls_by_logical.entry(attempt.logical_id).or_default() += 1;
        }

        let queue_full = attempt.code.as_deref() == Some("queue_full");
        // A client-side timeout without a terminal provides no wire evidence of admission or rejection.
        // The attempt counts as neither admitted nor rejected.
        let outcome_unknown = attempt.code.as_deref() == Some(ATTEMPT_TIMEOUT_CODE);
        if outcome_unknown {
            *outcome_unknown_by_method
                .entry(attempt.method.wire_name().to_owned())
                .or_default() += 1;
        } else if !queue_full {
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
        let method = first_method_by_logical
            .get(&request.logical_id)
            .copied()
            .unwrap_or("unknown")
            .to_owned();
        *offered_by_method.entry(method.clone()).or_default() += 1;
        if request.disposition == LogicalDisposition::Completed {
            *completed_by_method.entry(method).or_default() += 1;
        }
    }

    let mut errors = Vec::new();
    // The validator checks duplicate IDs and orphaned attempts before ledger totals; disposition counts partition each ledger.
    let mut logical_ids = std::collections::BTreeSet::new();
    for request in logical {
        if !logical_ids.insert(request.logical_id) {
            errors.push(format!("duplicate logical_id {}", request.logical_id));
        }
    }
    let mut attempt_ids = std::collections::BTreeSet::new();
    for attempt in attempts {
        if !attempt_ids.insert(attempt.attempt_id) {
            errors.push(format!("duplicate attempt_id {}", attempt.attempt_id));
        }
        // `SynapseMethod::Result` must have `AttemptDisposition::Poll`, and only that method may have it; ledger totals do not enforce this invariant.
        let is_poll = attempt.disposition == AttemptDisposition::Poll;
        if (attempt.method == SynapseMethod::Result) != is_poll {
            errors.push(format!(
                "attempt {} is {} with disposition {:?}: every embed.result attempt is a poll and no other method is",
                attempt.attempt_id,
                attempt.method.wire_name(),
                attempt.disposition
            ));
        }
        if !logical_ids.contains(&attempt.logical_id) {
            errors.push(format!(
                "attempt {} references unknown logical_id {}",
                attempt.attempt_id, attempt.logical_id
            ));
        }
    }
    if offered != completed + terminal_rejected + timed_out + in_flight {
        errors.push(format!(
            "logical ledger: {offered} != {completed} + {terminal_rejected} + {timed_out} + {in_flight}"
        ));
    }
    let attempt_total = attempts.len() as u64;
    if attempt_total != successes + retryable_rejections + attempt_timeouts + polls + failures {
        errors.push(format!(
            "attempt ledger: {attempt_total} != {successes} + {retryable_rejections} + {attempt_timeouts} + {polls} + {failures}"
        ));
    }
    // A valid attempt ledger contains no `failures`.
    if failures != 0 {
        errors.push(format!(
            "attempt ledger: {failures} non-poll attempts ended in an error outside the frozen vocabulary"
        ));
    }
    for request in logical {
        let actual = attempts_by_logical
            .get(&request.logical_id)
            .copied()
            .unwrap_or(0);
        if actual != request.attempts {
            errors.push(format!(
                "logical {} records {} attempts but owns {actual}",
                request.logical_id, request.attempts
            ));
        }
        // The validator verifies per-logical poll counts because total attempts can balance despite a misattributed `Poll`.
        let owned_polls = polls_by_logical
            .get(&request.logical_id)
            .copied()
            .unwrap_or(0);
        if owned_polls != request.polls {
            errors.push(format!(
                "logical {} records {} polls but owns {owned_polls}",
                request.logical_id, request.polls
            ));
        }
    }

    SynapseLedgerSummary {
        valid: errors.is_empty(),
        errors,
        offered,
        offered_by_method,
        admitted_by_method,
        outcome_unknown_by_method,
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
        failures,
        amplification: if offered == 0 {
            0.0
        } else {
            attempt_total as f64 / offered as f64
        },
    }
}

///
/// SplitMix64 avalanches each draw so adjacent `seed ^ logical_id` values do not synchronize first retry delays.
#[derive(Debug, Clone)]
pub struct DeterministicRng(u64);

impl DeterministicRng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^= value >> 31;
        // Top 53 bits give a uniform double in [0, 1).
        (value >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Retry jitter matches the plugin range: `[base, 3 * base)`.
    pub fn retry_delay_ms(&mut self, base_ms: u64) -> f64 {
        base_ms as f64 * (1.0 + 2.0 * self.unit())
    }

    pub fn first_poll_delay_ms(&mut self) -> f64 {
        1.0 + self.unit()
    }
}

/// `POLL_DELAY_MULTIPLIER` must match `SYNAPSE_POLL_DELAY_MULTIPLIER`.
/// `SYNAPSE_POLL_MIN_DELAY_MS` in
/// `packages/plugin/src/features/magic-context/memory/embedding-synapse.ts`,
/// invalidating client-faithfulness.
pub const POLL_DELAY_MULTIPLIER: f64 = 1.6;
pub const POLL_MIN_DELAY_MS: u64 = 10;

pub const QUEUE_FULL_MAX_ATTEMPTS: u32 = 64;

/// `next_delay_ms` escalates after each call.
/// The first pending reply waits the jittered fast-first seed.
/// Later pending replies use the escalated delay, capped by `served_cap_ms`.
/// uncapped.
pub fn pending_poll_delay_ms(next_delay_ms: &mut f64, served_cap_ms: u64) -> f64 {
    let current = *next_delay_ms;
    *next_delay_ms = (current * POLL_DELAY_MULTIPLIER).max(POLL_MIN_DELAY_MS as f64);
    current.min(served_cap_ms.max(POLL_MIN_DELAY_MS) as f64)
}

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

    /// `as_str` returns a value that `parse` maps back to the same variant.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::HygieneOnly => "hygiene-only",
            Self::A => "a",
            Self::B => "b",
            Self::C => "c",
            Self::APlusC => "a+c",
        }
    }

    pub fn needs_waiting_queries(self) -> bool {
        matches!(self, Self::A | Self::APlusC)
    }

    /// `None` imposes no query-admission attempt cap.
    pub fn query_attempt_limit(self) -> Option<u32> {
        (!matches!(self, Self::Baseline)).then_some(QUEUE_FULL_MAX_ATTEMPTS)
    }

    pub fn uses_served_query_hint(self) -> bool {
        matches!(self, Self::B)
    }

    pub fn fast_polls(self) -> bool {
        matches!(self, Self::C | Self::APlusC)
    }

    /// Fast-poll arms use the jittered fast-first delay for their first pending reply.
    /// the plugin.
    pub fn initial_pending_delay_ms(self, rng: &mut DeterministicRng) -> Option<f64> {
        self.fast_polls().then(|| rng.first_poll_delay_ms())
    }

    pub fn pending_poll_delay_ms(self, state: &mut f64, served_ms: u64) -> f64 {
        if self.fast_polls() {
            pending_poll_delay_ms(state, served_ms)
        } else {
            served_ms.max(POLL_MIN_DELAY_MS) as f64
        }
    }

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
