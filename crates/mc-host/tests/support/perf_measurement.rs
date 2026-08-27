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

/// Validates an open-loop offered rate. Rejects a zero rate (no arrival
/// process at all) and rates above 1e9/s, whose per-request spacing
/// truncates to 0 ns: consecutive slots would share a timestamp and the
/// arm would silently degrade into unrestricted closed-loop traffic.
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

/// Absolute nanosecond offset of `slot` in an open-loop arrival schedule
/// at `rate_per_sec`: `floor(slot * 1e9 / rate)` computed in `u128`.
///
/// Each slot is placed independently against the ideal real-valued
/// schedule, so the floor error is strictly below 1 ns per slot and never
/// accumulates. In particular `open_loop_offset_ns(rate, rate)` is exactly
/// 1_000_000_000: the mean offered rate over every whole second is exact
/// for any rate, not only for divisors of 1e9. A slot's own spacing is the
/// gap to the next slot, `offset_ns(slot + 1) - offset_ns(slot)`, which
/// varies by at most 1 ns around the nominal interval.
///
/// Callers must gate the rate through [`validate_open_loop_rate`] first;
/// a zero rate divides by zero here.
pub fn open_loop_offset_ns(slot: u64, rate_per_sec: u64) -> u64 {
    u64::try_from(u128::from(slot) * 1_000_000_000u128 / u128::from(rate_per_sec))
        .expect("scheduled offset exceeds u64 nanoseconds")
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

/// Code the harness records when its own deadline fired before any terminal
/// arrived. It marks an attempt whose admission outcome the wire never
/// revealed, which is why [`validate_synapse_ledgers`] keeps it out of both
/// the admitted and the rejected subtotals.
pub const ATTEMPT_TIMEOUT_CODE: &str = "attempt_timeout";

/// Mutually exclusive attempt-ledger categories from the frozen contract.
///
/// The frozen partition is `successes + retryable rejections + timeouts +
/// polls`. [`Self::Failure`] is the out-of-vocabulary bucket: a non-poll wire
/// call answered with an error the client policy cannot act on
/// (`artifact_invalid`, `schema_violation`, `cancelled`, ...). Those terminals
/// only occur when the run is already invalid, and
/// [`validate_synapse_ledgers`] reports any nonzero count as a ledger error,
/// so every retained repetition still satisfies the frozen four-way identity.
/// Recording them as successes instead would corrupt the raw evidence that
/// diagnoses the invalid run.
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
    /// The window class of the owning logical request, so an attempt is
    /// included or excluded with the request it belongs to rather than by its
    /// own send instant.
    ///
    /// An attempt is not an independent observation but one wire call of a
    /// logical request, and [`validate_synapse_ledgers`] rejects a repetition
    /// whose logical row disagrees with the attempts it owns. Classifying by
    /// `actual_send_ns` would break that identity for every measured request
    /// still retrying or polling past the window end, so an ordinary saturated
    /// repetition would be reported inadmissible. Ownership also keeps
    /// amplification conservative: attempts per request needs both sides over
    /// the same requests, and truncating a censored request's attempts at the
    /// boundary would understate it.
    ///
    /// Deliberately not `#[serde(default)]`: evidence written without the
    /// marker is not contract-conformant, so it must fail to parse rather than
    /// silently read as measured.
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
    /// Which part of the hold window this request opened in. See
    /// [`AttemptRecord::window`] for the retention and parsing contract.
    pub window: WindowClass,
}

/// Code marking a request the hold window closed on. Its wire outcome, if any
/// arrived, stays in the attempt ledger; the logical row records only that the
/// request had not settled when measurement ended.
pub const IN_FLIGHT_AT_WINDOW_END_CODE: &str = "in_flight_at_window_end";

/// Fraction of the hold window the frozen contract discards as warmup: the
/// first 10%, matching the `mc-host-baseline.md` convention.
const WARMUP_WINDOW_DIVISOR: u64 = 10;

/// Where an observation falls relative to the frozen hold window.
///
/// One field rather than a pair of exclusion booleans: every consumer asks the
/// same question — is this row part of the measured set — and a single class
/// cannot encode the contradictory answers two independent flags can. Only
/// [`WindowClass::Measured`] rows feed ledgers, rates, percentiles, and gates;
/// the other two stay in raw evidence so the discard is auditable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowClass {
    /// Opened inside the window's warmup prefix.
    Warmup,
    /// Opened inside the measured span between the warmup boundary and the
    /// window end.
    Measured,
    /// Opened at or after the window end. Closed-loop workers test the
    /// boundary before dispatching, so a worker that passes the test can still
    /// land its first wire send after the window closed; such a request never
    /// started under measurement and must not be counted as offered.
    AfterWindow,
}

impl WindowClass {
    /// True for the only class that feeds estimates.
    pub fn is_measured(self) -> bool {
        matches!(self, Self::Measured)
    }
}

/// One engine service-time observation, timestamped so it can be attributed to
/// a window class.
///
/// The duration alone is not sufficient evidence: without a start instant a
/// consumer cannot tell a call made under the warmup prefix, or one drained
/// after the window closed, from one served inside the measured span.
///
/// Classified by `started_ns` alone, deliberately. A call that begins inside the
/// measured span is work that span generated, and its duration is a complete
/// observation of service time even when it finishes after the boundary.
/// Excluding boundary-spanning calls instead — `started_ns + service_ns` beyond
/// the window end — would drop the longest calls from `S`, truncating its right
/// tail and biasing the mean and coefficient of variation downward and the
/// derived capacity upward. That is the same right-censoring error that keeps
/// unsettled requests out of the latency percentiles, applied in the direction
/// that silently flatters the system, so start-based classification is the
/// conservative rule here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServiceSample {
    /// When the engine call began, on the harness wire clock. The completion
    /// instant is `started_ns + service_ns`, so a consumer that wants a
    /// different boundary rule can derive it without a second field.
    pub started_ns: u64,
    /// Wall time the engine call occupied.
    pub service_ns: u64,
    pub window: WindowClass,
}

/// One repetition's scheduled hold window on the harness wire clock.
///
/// The contract measures a fixed window, so both frozen boundaries are derived
/// from the *scheduled* span rather than from observed completions: the warmup
/// prefix that stays out of estimates, and the end past which an unsettled
/// request is censored instead of being awaited into a completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldWindow {
    pub start_ns: u64,
    pub warmup_end_ns: u64,
    pub end_ns: u64,
}

impl HoldWindow {
    /// `start_ns` is the first scheduled slot on the wire clock and `seconds`
    /// the frozen hold duration.
    pub fn new(start_ns: u64, seconds: u64) -> Self {
        let span_ns = seconds.saturating_mul(1_000_000_000);
        Self {
            start_ns,
            warmup_end_ns: start_ns.saturating_add(span_ns / WARMUP_WINDOW_DIVISOR),
            end_ns: start_ns.saturating_add(span_ns),
        }
    }

    /// Classifies an opening instant. Both boundaries are half-open: the
    /// warmup boundary itself is already measured, and the window end itself is
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

    /// The instant a logical request opened: its scheduled start for open-loop
    /// work, or its first wire send for closed-loop work, matching the frozen
    /// definition of a logical request.
    pub fn opened_ns(record: &LogicalRecord) -> u64 {
        record
            .scheduled_start_ns
            .unwrap_or(record.actual_first_send_ns)
    }

    /// Stamps the frozen window boundaries onto one repetition's ledgers.
    ///
    /// A request that settled after the window closed was, at the window's
    /// end, still in flight; recording its later outcome as a completion or
    /// timeout would understate censoring and let post-window work inflate the
    /// completed rate over the configured window. Its attempt rows keep the
    /// wire outcome that did arrive, so nothing is lost from raw evidence.
    ///
    /// The censoring rewrite applies only to measured rows. A warmup or
    /// after-window request is excluded from estimates outright, so rewriting
    /// its disposition would discard a true outcome from raw evidence and buy
    /// nothing; it also keeps the in-flight-at-window-end code meaning exactly
    /// "the measured window closed on this request".
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
            // Ownership, not the attempt's own send instant: see
            // `AttemptRecord::window` for why the per-request ledger identity
            // requires it. An attempt whose logical row is missing cannot be
            // attributed to the measured set at all; the ledger validator
            // reports the orphan.
            attempt.window = classes
                .get(&attempt.logical_id)
                .copied()
                .unwrap_or(WindowClass::AfterWindow);
        }
    }
}

/// Splits one repetition's ledgers into the measured set and everything the
/// frozen window excludes. Only the measured set feeds rates, percentiles, and
/// gates; the caller retains both in raw evidence.
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

/// Counts excluded rows of one class, so the summary can report the warmup
/// discard and the after-window discard as the distinct quantities they are.
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
    /// Attempts whose admission cannot be decided from the wire: the client
    /// deadline fired before any terminal arrived, so the harness has no
    /// evidence the host took an admission permit or job slot. Kept out of
    /// `admitted_by_method` because that subtotal is the measured λ_adm.
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
    /// Non-poll wire calls answered with an error outside the client policy's
    /// vocabulary. Always zero in an admissible repetition.
    pub failures: u64,
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
    let failures = attempts
        .iter()
        .filter(|record| record.disposition == AttemptDisposition::Failure)
        .count() as u64;

    let mut admitted_by_method = BTreeMap::new();
    let mut outcome_unknown_by_method = BTreeMap::new();
    let mut rejected_by_method_code = BTreeMap::new();
    let mut timed_out_by_method_code = BTreeMap::new();
    // One pass over attempts also builds the per-logical aggregates the
    // ownership and method subtotals need, so validation stays linear in
    // (logical + attempts) instead of rescanning every attempt per request.
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
        // A client-side attempt timeout produced no terminal, so the wire
        // carries no evidence either way: it can neither be counted as
        // admitted nor as rejected.
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
    // The two conservation equations below cannot fail on their own —
    // the dispositions partition each ledger — so the falsifiable
    // identity checks come first: duplicate logical rows, duplicate
    // attempt rows, and attempts owned by no logical request are the
    // corruption shapes a recording bug actually produces.
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
    // The frozen attempt vocabulary has four categories. A recorded failure
    // is a wire error the client policy cannot act on, so the repetition
    // carries an instrumentation or host fault and is inadmissible.
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
        // The attempt total alone cannot catch a misattributed poll count: a
        // row claiming zero polls while owning a Poll attempt still balances
        // whenever its total matches, and the poll distribution it feeds is
        // then wrong while the ledger reports valid.
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

/// Deterministic generator used only by the benchmark's jitter policy.
///
/// SplitMix64: the state advances by the golden-ratio increment and each
/// draw runs the full avalanche finalizer, so the first draw from any
/// seed — including adjacent small seeds such as `seed ^ logical_id` —
/// is already well mixed. (A raw xorshift here would make every small
/// seed's first draw nearly zero, synchronizing all callers' first retry
/// delays at the base value and defeating the jitter.) Every distinct
/// seed, including 0, yields a distinct sequence.
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

    /// Mirrors plugin retry jitter: `[base, 3 * base)`.
    pub fn retry_delay_ms(&mut self, base_ms: u64) -> f64 {
        base_ms as f64 * (1.0 + 2.0 * self.unit())
    }

    /// Mirrors plugin fast-first poll jitter: `[1ms, 2ms)`.
    pub fn first_poll_delay_ms(&mut self) -> f64 {
        1.0 + self.unit()
    }
}

/// Plugin poll-policy constants mirrored here so the benchmark's variant
/// arms schedule exactly the shipped cadence. Single source on the Rust
/// side; must equal `SYNAPSE_POLL_DELAY_MULTIPLIER` and
/// `SYNAPSE_POLL_MIN_DELAY_MS` in
/// `packages/plugin/src/features/magic-context/memory/embedding-synapse.ts`,
/// and `retry_and_poll_schedule_matches_plugin_policy` pins the unsaturated
/// escalation step so a drifted copy fails a gate instead of silently
/// invalidating client-faithfulness.
pub const POLL_DELAY_MULTIPLIER: f64 = 1.6;
pub const POLL_MIN_DELAY_MS: u64 = 10;

/// Mirrors the plugin's `SYNAPSE_QUEUE_FULL_MAX_ATTEMPTS`: `queue_full` is a
/// deadline-bounded wait for an admission slot, and this cap only bounds
/// amplification when a served hint is pathologically small.
pub const QUEUE_FULL_MAX_ATTEMPTS: u32 = 64;

/// Consumes the current pending-poll delay and escalates the stored next
/// one, mirroring the plugin's `pendingPollDelay`: the first pending reply
/// waits the jittered fast-first seed, later pendings wait the escalated
/// value, and the served `retry_after_ms` (floored at the busy-poll
/// minimum) caps every returned delay while the stored state escalates
/// uncapped.
pub fn pending_poll_delay_ms(next_delay_ms: &mut f64, served_cap_ms: u64) -> f64 {
    let current = *next_delay_ms;
    *next_delay_ms = (current * POLL_DELAY_MULTIPLIER).max(POLL_MIN_DELAY_MS as f64);
    current.min(served_cap_ms.max(POLL_MIN_DELAY_MS) as f64)
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

    /// CLI spelling of the variant; the inverse of `parse`.
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

    /// `None` is the historical query-only admission loop: retry until the
    /// single absolute deadline with no attempt cap. Treatment/hygiene arms
    /// mirror the plugin's `queue_full` budget: deadline-bounded with the
    /// [`QUEUE_FULL_MAX_ATTEMPTS`] safety cap.
    pub fn query_attempt_limit(self) -> Option<u32> {
        (!matches!(self, Self::Baseline)).then_some(QUEUE_FULL_MAX_ATTEMPTS)
    }

    /// Only candidate B reads the host's served `query_retry_after_ms`. The
    /// frozen matrix declares `a+c` as A's bounded server waiting plus C's
    /// fast polling, so letting it read the hint too would make its query
    /// results unattributable between A+C and an unlabelled B.
    pub fn uses_served_query_hint(self) -> bool {
        matches!(self, Self::B)
    }

    pub fn fast_polls(self) -> bool {
        matches!(self, Self::C | Self::APlusC)
    }

    /// Seed of the pending-poll ladder for fast-poll arms: the jittered
    /// fast-first delay, consumed by the first pending reply. The first
    /// `embed.result` itself is issued immediately in every arm, mirroring
    /// the plugin.
    pub fn initial_pending_delay_ms(self, rng: &mut DeterministicRng) -> Option<f64> {
        self.fast_polls().then(|| rng.first_poll_delay_ms())
    }

    /// One pending wait. Fast arms consume-then-escalate the ladder state;
    /// other arms reproduce the historical fixed served-delay poll.
    pub fn pending_poll_delay_ms(self, state: &mut f64, served_ms: u64) -> f64 {
        if self.fast_polls() {
            pending_poll_delay_ms(state, served_ms)
        } else {
            served_ms.max(POLL_MIN_DELAY_MS) as f64
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
