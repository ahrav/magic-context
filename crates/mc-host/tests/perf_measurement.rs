//! Contract tests for the shared performance-measurement rules: timing
//! boundaries, percentile semantics, workload fixture identity, outcome
//! conservation, offered-rate validation, and tail suppression.

#[path = "support/perf_measurement.rs"]
mod perf_measurement;

#[path = "support/raw_client.rs"]
mod raw_client;

use perf_measurement::{
    fixture_workload, nearest_rank, open_loop_offset_ns, tail_publishable, validate_open_loop_rate,
    LatencySummary, Outcome, OutcomeCounts, FIXTURE_BODY, TAIL_SAMPLE_FLOOR,
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
    assert!(validate_open_loop_rate(0).is_err(), "zero rate");
    // A rate above 1e9/s has a sub-nanosecond interval: consecutive slots
    // would share a timestamp, and silently becoming unrestricted
    // closed-loop traffic is the failure mode this guards against.
    assert!(validate_open_loop_rate(2_000_000_000).is_err());
    assert!(validate_open_loop_rate(1_000_000_000).is_ok());
    assert!(validate_open_loop_rate(20_000).is_ok());
    // Rates that do not divide 1e9 are representable through the exact
    // per-slot offset schedule.
    assert!(validate_open_loop_rate(49).is_ok());
    assert!(validate_open_loop_rate(3000).is_ok());
}

#[test]
fn open_loop_offsets_are_exact_and_drift_free() {
    // Divisor rates reproduce the old fixed-interval schedule.
    assert_eq!(open_loop_offset_ns(0, 20_000), 0);
    assert_eq!(open_loop_offset_ns(1, 20_000), 50_000);
    assert_eq!(open_loop_offset_ns(7, 20_000), 350_000);
    assert_eq!(open_loop_offset_ns(1, 1_000_000_000), 1);

    for rate in [49u64, 99, 148, 3000, 6000, 20_000] {
        // The mean rate over each whole second is exact: slot `rate`
        // lands on the second boundary with zero accumulated drift.
        assert_eq!(open_loop_offset_ns(rate, rate), 1_000_000_000);
        assert_eq!(open_loop_offset_ns(rate * 5, rate), 5_000_000_000);

        let mut prev = 0u64;
        for slot in 0..=rate.min(10_000) {
            let got = open_loop_offset_ns(slot, rate);
            // Exactly floor(slot * 1e9 / rate) against the u128 ideal:
            // below the real-valued schedule by strictly less than 1 ns.
            let numerator = u128::from(slot) * 1_000_000_000u128;
            assert_eq!(u128::from(got), numerator / u128::from(rate));
            assert!(numerator - u128::from(got) * u128::from(rate) < u128::from(rate));
            assert!(got >= prev, "offsets must be monotonic nondecreasing");
            prev = got;
        }
    }
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

#[test]
fn synapse_ledgers_reconcile_exactly() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod,
    };
    let attempts = vec![
        AttemptRecord {
            logical_id: 7,
            attempt_id: 1,
            method: SynapseMethod::Batch,
            disposition: AttemptDisposition::Success,
            code: None,
            retry_after_ms: None,
            actual_send_ns: 10,
            terminal_ns: 20,
            latency_ns: 10,
        },
        AttemptRecord {
            logical_id: 7,
            attempt_id: 2,
            method: SynapseMethod::Result,
            disposition: AttemptDisposition::Poll,
            code: None,
            retry_after_ms: Some(50),
            actual_send_ns: 30,
            terminal_ns: 40,
            latency_ns: 10,
        },
    ];
    let logical = vec![LogicalRecord {
        logical_id: 7,
        scheduled_start_ns: Some(0),
        actual_first_send_ns: 10,
        terminal_ns: 40,
        latency_ns: 40,
        disposition: LogicalDisposition::Completed,
        terminal_code: None,
        attempts: 2,
        polls: 1,
    }];
    let ledger = validate_synapse_ledgers(&logical, &attempts);
    assert!(ledger.valid, "{:?}", ledger.errors);
    assert_eq!(ledger.offered, 1);
    assert_eq!(ledger.completed, 1);
    assert_eq!(ledger.attempts, 2);
    assert_eq!(ledger.polls, 1);
    assert_eq!(ledger.amplification, 2.0);

    let mut broken = logical;
    broken[0].attempts = 1;
    let ledger = validate_synapse_ledgers(&broken, &attempts);
    assert!(!ledger.valid);
    assert!(ledger.errors[0].contains("records 1 attempts"));
}

#[test]
fn retry_and_poll_schedule_matches_plugin_policy() {
    let mut rng = perf_measurement::DeterministicRng::new(9);
    for _ in 0..100 {
        let retry = rng.retry_delay_ms(50);
        assert!((50.0..150.0).contains(&retry));
        let first = rng.first_poll_delay_ms();
        assert!((1.0..2.0).contains(&first));
    }
    assert_eq!(perf_measurement::next_poll_delay_ms(1.5, 50), 10.0);
    assert_eq!(perf_measurement::next_poll_delay_ms(40.0, 50), 50.0);
    assert_eq!(perf_measurement::next_poll_delay_ms(40.0, 5), 10.0);
}

#[test]
fn raw_error_surfaces_retry_after_ms() {
    let frame = raw_client::RawFrame {
        len: 45,
        ver: raw_client::WIRE_VERSION,
        ty: raw_client::TY_ERROR,
        flags: raw_client::FLAGS_RESPONSE_TEXT_LAST,
        channel: 1,
        epoch: 1,
        corr: 1,
        body: br#"{"code":"queue_full","retry_after_ms":73}"#.to_vec(),
    };
    assert_eq!(frame.error_code(), "queue_full");
    assert_eq!(frame.error_retry_after_ms(), Some(73));
}

#[test]
fn overload_and_closed_singleton_ledgers_keep_expected_amplification() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod,
    };
    let attempt = |logical_id, attempt_id, disposition| AttemptRecord {
        logical_id,
        attempt_id,
        method: SynapseMethod::Query,
        disposition,
        code: (disposition == AttemptDisposition::RetryableRejection)
            .then(|| "queue_full".to_owned()),
        retry_after_ms: None,
        actual_send_ns: attempt_id,
        terminal_ns: attempt_id + 1,
        latency_ns: 1,
    };
    let logical = |logical_id, disposition, attempts| LogicalRecord {
        logical_id,
        scheduled_start_ns: None,
        actual_first_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        disposition,
        terminal_code: (disposition == LogicalDisposition::Rejected)
            .then(|| "queue_full".to_owned()),
        attempts,
        polls: 0,
    };

    let singleton = validate_synapse_ledgers(
        &[logical(1, LogicalDisposition::Completed, 1)],
        &[attempt(1, 1, AttemptDisposition::Success)],
    );
    assert!(singleton.valid);
    assert_eq!(singleton.amplification, 1.0, "closed concurrency 1 has A=1");

    // A deterministic 2x-capacity shape: one request completes, one exhausts
    // four retryable attempts. The repetition remains exactly accounted even
    // though its >1% censoring makes its latency summary unpublishable.
    let overload = validate_synapse_ledgers(
        &[
            logical(1, LogicalDisposition::Completed, 1),
            logical(2, LogicalDisposition::Rejected, 4),
        ],
        &[
            attempt(1, 1, AttemptDisposition::Success),
            attempt(2, 2, AttemptDisposition::RetryableRejection),
            attempt(2, 3, AttemptDisposition::RetryableRejection),
            attempt(2, 4, AttemptDisposition::RetryableRejection),
            attempt(2, 5, AttemptDisposition::RetryableRejection),
        ],
    );
    assert!(overload.valid, "{:?}", overload.errors);
    assert_eq!(overload.offered, 2);
    assert_eq!(overload.completed, 1);
    assert_eq!(overload.amplification, 2.5);
    assert_eq!(
        overload.rejected_by_method_code["embed.query:queue_full"],
        4
    );
}

#[test]
fn variant_policy_keeps_control_arms_isolated_from_landed_hints() {
    use perf_measurement::SynapseVariant;
    let mut baseline_rng = perf_measurement::DeterministicRng::new(1);
    assert_eq!(
        SynapseVariant::Baseline.query_retry_delay_ms(Some(7), &mut baseline_rng),
        100.0
    );
    assert_eq!(SynapseVariant::Baseline.query_attempt_limit(), None);
    assert!(!SynapseVariant::Baseline.fast_polls());

    for variant in [
        SynapseVariant::HygieneOnly,
        SynapseVariant::A,
        SynapseVariant::C,
    ] {
        let mut rng = perf_measurement::DeterministicRng::new(9);
        let delay = variant.query_retry_delay_ms(Some(7), &mut rng);
        assert!((100.0..300.0).contains(&delay));
        assert_eq!(variant.query_attempt_limit(), Some(4));
        assert!(!variant.uses_served_query_hint());
    }

    for variant in [SynapseVariant::B, SynapseVariant::APlusC] {
        let mut rng = perf_measurement::DeterministicRng::new(9);
        let delay = variant.query_retry_delay_ms(Some(7), &mut rng);
        assert!((7.0..21.0).contains(&delay));
        assert!(variant.uses_served_query_hint());
    }
    assert!(SynapseVariant::A.needs_waiting_queries());
    assert!(SynapseVariant::APlusC.needs_waiting_queries());
    assert!(SynapseVariant::C.fast_polls());
    assert!(SynapseVariant::APlusC.fast_polls());

    let mut poll_rng = perf_measurement::DeterministicRng::new(17);
    assert_eq!(
        SynapseVariant::Baseline.initial_poll_delay_ms(&mut poll_rng),
        None,
        "baseline polls immediately"
    );
    assert_eq!(
        SynapseVariant::HygieneOnly.pending_poll_delay_ms(0.0, 73),
        73.0,
        "control polling stays at the served constant"
    );
    let first = SynapseVariant::C
        .initial_poll_delay_ms(&mut poll_rng)
        .expect("C has fast-first polling");
    assert!((1.0..2.0).contains(&first));
    assert_eq!(SynapseVariant::C.pending_poll_delay_ms(first, 73), 10.0);
}
