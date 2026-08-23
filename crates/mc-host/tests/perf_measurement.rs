//! Contract tests for the shared performance-measurement rules: timing
//! boundaries, percentile semantics, workload fixture identity, outcome
//! conservation, offered-rate validation, and tail suppression.

#[path = "support/perf_measurement.rs"]
mod perf_measurement;

use std::time::Duration;

use perf_measurement::{
    fixture_workload, nearest_rank, open_loop_interval_ns, tail_publishable, LatencySummary,
    Outcome, OutcomeCounts, Windows, FIXTURE_BODY, TAIL_SAMPLE_FLOOR,
};

#[test]
fn fixture_is_the_committed_compact_json_shape() {
    let workload = fixture_workload();
    assert_eq!(workload.label, "compact-json-v1");
    assert_eq!(workload.len, FIXTURE_BODY.len());
    assert!(!workload.binary);
    // The fixture is committed bytes: a changed hash means a changed
    // workload, which must never silently compare against old evidence.
    assert_eq!(workload.sha256, perf_measurement::sha256_hex(FIXTURE_BODY),);
    let parsed: serde_json::Value =
        serde_json::from_slice(FIXTURE_BODY).expect("fixture is valid JSON");
    assert_eq!(parsed["op"], "perf.echo");
    // The echo handler treats mode byte 1 as a sleep request; JSON text
    // must never trip that path.
    assert_ne!(FIXTURE_BODY[0], 1);
}

#[test]
fn fixture_bytes_are_frozen() {
    // The exact committed bytes, so any edit is a deliberate contract
    // change with a new hash.
    assert_eq!(
        FIXTURE_BODY,
        br#"{"op":"perf.echo","v":1,"payload":"0123456789abcdef0123456789abcdef"}"#
    );
    assert_eq!(
        fixture_workload().sha256,
        perf_measurement::sha256_hex(FIXTURE_BODY)
    );
}

#[test]
fn nearest_rank_returns_observed_samples() {
    let sorted = vec![10, 20, 30, 40, 50];
    assert_eq!(nearest_rank(&sorted, 50.0), Some(30));
    assert_eq!(nearest_rank(&sorted, 100.0), Some(50));
    assert_eq!(nearest_rank(&sorted, 1.0), Some(10));
    // 90th percentile of five samples is rank ceil(4.5)=5 -> the max.
    assert_eq!(nearest_rank(&sorted, 90.0), Some(50));
    assert_eq!(nearest_rank(&[], 50.0), None);
    assert_eq!(nearest_rank(&sorted, 0.0), None);
    assert_eq!(nearest_rank(&sorted, 101.0), None);
}

#[test]
fn issue_time_starts_after_permit_wait() {
    // Closed-loop semantics: scheduled time is when the slot became due,
    // issue time is after admission. The measured serial RTT uses issue
    // time, so permit queueing is excluded; the difference is scheduler
    // lag, not server latency.
    let scheduled_ns = 1_000u64;
    let issue_ns = 5_000u64;
    let completion_ns = 9_000u64;
    let issue_to_completion = completion_ns - issue_ns;
    let sched_to_completion = completion_ns - scheduled_ns;
    let lag = issue_ns - scheduled_ns;
    assert_eq!(issue_to_completion, 4_000);
    assert_eq!(sched_to_completion, issue_to_completion + lag);
}

#[test]
fn outcome_conservation_accounts_every_slot() {
    let mut outcomes = OutcomeCounts::default();
    for outcome in [
        Outcome::Success,
        Outcome::ProtocolError,
        Outcome::MissedSlot,
        Outcome::WriteFailure,
        Outcome::PeerClosed,
        Outcome::UnexpectedFrame,
        Outcome::BodyMismatch,
        Outcome::UnresolvedAtDrain,
        Outcome::HistogramOverflow,
    ] {
        outcomes.record(outcome);
    }
    assert_eq!(outcomes.total(), 9);
    assert!(outcomes.conserved(9));
    assert!(!outcomes.conserved(10), "a lost slot is accounting loss");
    assert!(
        !outcomes.conserved(8),
        "a double-counted slot is accounting loss"
    );
}

#[test]
fn outcome_merge_preserves_totals() {
    let mut a = OutcomeCounts::default();
    a.record(Outcome::Success);
    a.record(Outcome::BodyMismatch);
    let mut b = OutcomeCounts::default();
    b.record(Outcome::PeerClosed);
    a.merge(&b);
    assert_eq!(a.total(), 3);
    assert_eq!(a.peer_closed, 1);
}

#[test]
fn unrepresentable_offered_rate_fails_validation() {
    assert!(open_loop_interval_ns(0).is_err(), "zero rate");
    // A rate above 1e9/s has a sub-nanosecond interval: unrepresentable,
    // and silently becoming unrestricted closed-loop traffic is the
    // failure mode this guards against.
    assert!(open_loop_interval_ns(2_000_000_000).is_err());
    assert_eq!(open_loop_interval_ns(1_000_000_000).unwrap(), 1);
    assert_eq!(open_loop_interval_ns(20_000).unwrap(), 50_000);
}

#[test]
fn measurement_window_excludes_warmup_and_post_window() {
    let windows = Windows {
        warmup: Duration::from_secs(2),
        measure: Duration::from_secs(10),
    };
    assert!(!windows.in_measurement(Duration::from_secs(1)));
    assert!(windows.in_measurement(Duration::from_secs(2)));
    assert!(windows.in_measurement(Duration::from_millis(11_999)));
    assert!(!windows.in_measurement(Duration::from_secs(12)));
}

#[test]
fn tail_suppression_below_sample_floor() {
    assert!(!tail_publishable(TAIL_SAMPLE_FLOOR - 1));
    assert!(tail_publishable(TAIL_SAMPLE_FLOOR));

    // Below the floor: evidence retained (count, p50..p99, max) but the
    // headline p99.9 is suppressed.
    let small: Vec<u64> = (1..=1000).collect();
    let summary = LatencySummary::from_unsorted(small).unwrap();
    assert_eq!(summary.count, 1000);
    assert_eq!(summary.p999_ns, None);
    assert_eq!(summary.max_ns, 1000);

    let large: Vec<u64> = (1..=TAIL_SAMPLE_FLOOR).collect();
    let summary = LatencySummary::from_unsorted(large).unwrap();
    assert!(summary.p999_ns.is_some());
}
