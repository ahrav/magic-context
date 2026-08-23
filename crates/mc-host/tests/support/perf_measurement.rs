//! Shared measurement rules for the mc-host performance harness.
//!
//! Pure timing, percentile, workload, and outcome-accounting logic used by
//! `examples/perf_load.rs`, the `ipc_budget` benchmark, and their tests.
//! Contract: issue-to-validated-terminal is the RTT boundary, scheduled
//! time exists only for open-loop accounting, and every scheduled slot must
//! resolve to exactly one terminal outcome.

#![allow(dead_code)]

use sha2::{Digest, Sha256};

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
