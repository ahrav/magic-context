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
            warmup: false,
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
            warmup: false,
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
        warmup: false,
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
    // Consume-then-escalate, mirroring the plugin's `pendingPollDelay`
    // exactly: the first pending reply waits the jittered fast-first seed,
    // then the ladder escalates 10 -> 16 -> 25.6 under the served cap. The
    // unsaturated 10 -> 16 step pins the 1.6 multiplier so a drifted copy
    // fails here instead of silently de-faithing the benchmark arms.
    let mut ladder = 1.5;
    assert_eq!(
        perf_measurement::pending_poll_delay_ms(&mut ladder, 50),
        1.5
    );
    assert_eq!(
        perf_measurement::pending_poll_delay_ms(&mut ladder, 50),
        10.0
    );
    assert_eq!(
        perf_measurement::pending_poll_delay_ms(&mut ladder, 50),
        16.0
    );
    assert_eq!(
        perf_measurement::pending_poll_delay_ms(&mut ladder, 50),
        25.6
    );
    // The served cap bounds the returned delay and floors at the 10 ms
    // busy-poll minimum; the stored ladder keeps escalating uncapped.
    let mut saturated = 64.0;
    assert_eq!(
        perf_measurement::pending_poll_delay_ms(&mut saturated, 50),
        50.0
    );
    let mut floored = 40.0;
    assert_eq!(
        perf_measurement::pending_poll_delay_ms(&mut floored, 5),
        10.0
    );
}

#[test]
fn adjacent_seeds_disperse_their_first_draw() {
    // The benchmark seeds per-request generators as `seed ^ logical_id`,
    // so adjacent small seeds must not produce synchronized first draws:
    // a first draw pinned near zero would collapse every caller's first
    // retry delay onto the base value and defeat the jitter policy.
    let firsts: Vec<f64> = (1u64..=8)
        .map(|id| perf_measurement::DeterministicRng::new(1 ^ id).unit())
        .collect();
    let min = firsts.iter().copied().fold(f64::INFINITY, f64::min);
    let max = firsts.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    assert!(
        max - min > 0.25,
        "first draws {firsts:?} span {} <= 0.25: adjacent seeds are synchronized",
        max - min
    );
}

#[test]
fn distinct_seeds_yield_distinct_first_draws() {
    // seed.max(1)-style clamping or a weak mixer can collapse distinct
    // seeds onto one sequence; the first draw must already discriminate.
    let a = perf_measurement::DeterministicRng::new(1 << 2).unit();
    let b = perf_measurement::DeterministicRng::new(1 << 3).unit();
    assert_ne!(a, b, "seeds 4 and 8 produced the same first draw");
    let zero = perf_measurement::DeterministicRng::new(0).unit();
    let one = perf_measurement::DeterministicRng::new(1).unit();
    assert_ne!(zero, one, "seeds 0 and 1 collapsed onto one sequence");
}

#[test]
fn ledger_rejects_duplicate_and_orphan_records() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod,
    };
    let attempt = |logical_id, attempt_id| AttemptRecord {
        logical_id,
        attempt_id,
        method: SynapseMethod::Query,
        disposition: AttemptDisposition::Success,
        code: None,
        retry_after_ms: None,
        actual_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        warmup: false,
    };
    let logical = |logical_id, attempts| LogicalRecord {
        logical_id,
        scheduled_start_ns: None,
        actual_first_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        disposition: LogicalDisposition::Completed,
        terminal_code: None,
        attempts,
        polls: 0,
        warmup: false,
    };

    // Duplicate logical rows: two rows claim logical 1.
    let duplicated_logical = validate_synapse_ledgers(
        &[logical(1, 1), logical(1, 1)],
        &[attempt(1, 1), attempt(1, 2)],
    );
    assert!(!duplicated_logical.valid);
    assert!(duplicated_logical
        .errors
        .iter()
        .any(|error| error.contains("duplicate logical_id 1")));

    // Duplicate attempt rows: attempt_id 1 recorded twice.
    let duplicated_attempt =
        validate_synapse_ledgers(&[logical(1, 2)], &[attempt(1, 1), attempt(1, 1)]);
    assert!(!duplicated_attempt.valid);
    assert!(duplicated_attempt
        .errors
        .iter()
        .any(|error| error.contains("duplicate attempt_id 1")));

    // Orphan attempt: logical 9 owns nothing.
    let orphan = validate_synapse_ledgers(&[logical(1, 1)], &[attempt(1, 1), attempt(9, 2)]);
    assert!(!orphan.valid);
    assert!(orphan
        .errors
        .iter()
        .any(|error| error.contains("unknown logical_id 9")));

    // Per-logical attempt-count mismatch is still caught.
    let miscounted = validate_synapse_ledgers(&[logical(1, 3)], &[attempt(1, 1)]);
    assert!(!miscounted.valid);
    assert!(miscounted
        .errors
        .iter()
        .any(|error| error.contains("records 3 attempts")));
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
        warmup: false,
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
        warmup: false,
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
        // `a+c` is A's bounded server waiting plus C's fast polling; reading
        // B's served hint here would fold an unlabelled third mechanism into
        // the arm and make its query results unattributable.
        SynapseVariant::APlusC,
    ] {
        let mut rng = perf_measurement::DeterministicRng::new(9);
        let delay = variant.query_retry_delay_ms(Some(7), &mut rng);
        assert!((100.0..300.0).contains(&delay));
        assert_eq!(
            variant.query_attempt_limit(),
            Some(perf_measurement::QUEUE_FULL_MAX_ATTEMPTS)
        );
        assert!(!variant.uses_served_query_hint());
    }

    {
        let mut rng = perf_measurement::DeterministicRng::new(9);
        let delay = SynapseVariant::B.query_retry_delay_ms(Some(7), &mut rng);
        assert!((7.0..21.0).contains(&delay));
        assert!(SynapseVariant::B.uses_served_query_hint());
    }
    assert!(SynapseVariant::A.needs_waiting_queries());
    assert!(SynapseVariant::APlusC.needs_waiting_queries());
    assert!(SynapseVariant::C.fast_polls());
    assert!(SynapseVariant::APlusC.fast_polls());

    let mut poll_rng = perf_measurement::DeterministicRng::new(17);
    assert_eq!(
        SynapseVariant::Baseline.initial_pending_delay_ms(&mut poll_rng),
        None,
        "baseline has no fast-first ladder seed"
    );
    let mut control_ladder = 0.0;
    assert_eq!(
        SynapseVariant::HygieneOnly.pending_poll_delay_ms(&mut control_ladder, 73),
        73.0,
        "control polling stays at the served constant"
    );
    let mut fast_ladder = SynapseVariant::C
        .initial_pending_delay_ms(&mut poll_rng)
        .expect("C has fast-first polling");
    assert!((1.0..2.0).contains(&fast_ladder));
    // The first pending reply consumes the fast-first seed itself; the
    // escalated 10 ms floor applies from the second pending onward.
    let first_pending = SynapseVariant::C.pending_poll_delay_ms(&mut fast_ladder, 73);
    assert!((1.0..2.0).contains(&first_pending));
    assert_eq!(
        SynapseVariant::C.pending_poll_delay_ms(&mut fast_ladder, 73),
        10.0
    );
}

#[test]
fn the_hold_window_marks_warmup_and_censors_unsettled_requests() {
    use perf_measurement::{
        AttemptDisposition, AttemptRecord, HoldWindow, LogicalDisposition, LogicalRecord,
        SynapseMethod, IN_FLIGHT_AT_WINDOW_END_CODE,
    };

    // A 10-second hold beginning at 1s: warmup covers the first second of the
    // window (its first 10%) and the window closes at 11s.
    let window = HoldWindow::new(1_000_000_000, 10);
    assert_eq!(window.warmup_end_ns, 2_000_000_000);
    assert_eq!(window.end_ns, 11_000_000_000);

    let logical_row = |logical_id, scheduled_ns: u64, terminal_ns| LogicalRecord {
        logical_id,
        scheduled_start_ns: Some(scheduled_ns),
        actual_first_send_ns: scheduled_ns,
        terminal_ns,
        latency_ns: terminal_ns - scheduled_ns,
        disposition: LogicalDisposition::Completed,
        terminal_code: None,
        attempts: 1,
        polls: 0,
        warmup: false,
    };
    let attempt_row = |logical_id| AttemptRecord {
        logical_id,
        attempt_id: logical_id,
        method: SynapseMethod::Query,
        disposition: AttemptDisposition::Success,
        code: None,
        retry_after_ms: None,
        actual_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        warmup: false,
    };

    let mut logical = vec![
        // Opens inside the warmup prefix.
        logical_row(1, 1_500_000_000, 1_600_000_000),
        // The boundary itself is already post-warmup: the prefix is the first
        // 10% exclusive of its end.
        logical_row(2, 2_000_000_000, 2_100_000_000),
        // Settles inside the window.
        logical_row(3, 5_000_000_000, 6_000_000_000),
        // Still outstanding when the window closes.
        logical_row(4, 10_900_000_000, 13_500_000_000),
    ];
    let mut attempts = vec![
        attempt_row(1),
        attempt_row(2),
        attempt_row(3),
        attempt_row(4),
    ];

    window.stamp(&mut logical, &mut attempts);

    assert_eq!(
        logical.iter().map(|r| r.warmup).collect::<Vec<_>>(),
        [true, false, false, false],
        "only the request opening before the warmup boundary is marked"
    );
    // Attempts inherit the marker from the request that owns them, so the two
    // ledgers are discarded together and stay reconcilable.
    assert_eq!(
        attempts.iter().map(|a| a.warmup).collect::<Vec<_>>(),
        [true, false, false, false]
    );

    // A request the window closed on is censored, not credited as completed.
    assert_eq!(logical[3].disposition, LogicalDisposition::InFlight);
    assert_eq!(
        logical[3].terminal_code.as_deref(),
        Some(IN_FLIGHT_AT_WINDOW_END_CODE)
    );
    // Requests that settled inside the window keep their outcome.
    for record in logical.iter().take(3) {
        assert_eq!(record.disposition, LogicalDisposition::Completed);
    }

    // The estimate set excludes the warmup prefix while raw evidence keeps it.
    let (estimates, discarded) = perf_measurement::partition_warmup(&logical, |r| r.warmup);
    assert_eq!(estimates.len(), 3);
    assert_eq!(discarded.len(), 1);
    assert_eq!(discarded[0].logical_id, 1);
}

#[test]
fn outcome_unknown_attempts_are_neither_admitted_nor_rejected() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod, ATTEMPT_TIMEOUT_CODE,
    };

    let attempt = |attempt_id, disposition, code: Option<&str>| AttemptRecord {
        logical_id: 1,
        attempt_id,
        method: SynapseMethod::Query,
        disposition,
        code: code.map(str::to_owned),
        retry_after_ms: None,
        actual_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        warmup: false,
    };
    let logical = vec![LogicalRecord {
        logical_id: 1,
        scheduled_start_ns: None,
        actual_first_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        disposition: LogicalDisposition::TimedOut,
        terminal_code: Some(ATTEMPT_TIMEOUT_CODE.to_owned()),
        attempts: 3,
        polls: 0,
        warmup: false,
    }];
    let ledger = validate_synapse_ledgers(
        &logical,
        &[
            // A served call: wire evidence that the host admitted it.
            attempt(1, AttemptDisposition::Success, None),
            // An admission rejection: wire evidence that it did not.
            attempt(
                2,
                AttemptDisposition::RetryableRejection,
                Some("queue_full"),
            ),
            // No terminal arrived, so the wire says nothing either way.
            attempt(3, AttemptDisposition::Timeout, Some(ATTEMPT_TIMEOUT_CODE)),
        ],
    );

    assert!(ledger.valid, "{:?}", ledger.errors);
    assert_eq!(
        ledger.admitted_by_method.get("embed.query"),
        Some(&1),
        "an outcome-unknown attempt must not inflate measured admitted rate"
    );
    assert_eq!(
        ledger.outcome_unknown_by_method.get("embed.query"),
        Some(&1)
    );
    assert_eq!(
        ledger.rejected_by_method_code.get("embed.query:queue_full"),
        Some(&1)
    );
}

#[test]
fn an_error_outside_the_client_vocabulary_is_not_a_success() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod,
    };

    let logical = vec![LogicalRecord {
        logical_id: 1,
        scheduled_start_ns: None,
        actual_first_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        disposition: LogicalDisposition::InFlight,
        terminal_code: Some("harness_error".to_owned()),
        attempts: 1,
        polls: 0,
        warmup: false,
    }];
    let ledger = validate_synapse_ledgers(
        &logical,
        &[AttemptRecord {
            logical_id: 1,
            attempt_id: 1,
            method: SynapseMethod::Query,
            disposition: AttemptDisposition::Failure,
            code: Some("schema_violation".to_owned()),
            retry_after_ms: None,
            actual_send_ns: 0,
            terminal_ns: 1,
            latency_ns: 1,
            warmup: false,
        }],
    );

    assert_eq!(ledger.successes, 0, "the row must not be counted a success");
    assert_eq!(ledger.failures, 1);
    // The frozen attempt vocabulary has four categories, so a recorded failure
    // makes the repetition inadmissible rather than silently reshaping rates.
    assert!(!ledger.valid);
    assert!(
        ledger
            .errors
            .iter()
            .any(|error| error.contains("outside the frozen vocabulary")),
        "{:?}",
        ledger.errors
    );
}

#[test]
fn a_misattributed_poll_count_is_rejected_even_when_attempts_balance() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod,
    };

    let attempt = |attempt_id, method, disposition| AttemptRecord {
        logical_id: 1,
        attempt_id,
        method,
        disposition,
        code: None,
        retry_after_ms: None,
        actual_send_ns: attempt_id,
        terminal_ns: attempt_id + 1,
        latency_ns: 1,
        warmup: false,
    };
    // The row owns one submission and one poll, and its total is honest, so
    // the attempt-count check alone accepts it while `polls` is understated.
    let logical = vec![LogicalRecord {
        logical_id: 1,
        scheduled_start_ns: None,
        actual_first_send_ns: 1,
        terminal_ns: 4,
        latency_ns: 3,
        disposition: LogicalDisposition::Completed,
        terminal_code: None,
        attempts: 2,
        polls: 0,
        warmup: false,
    }];
    let ledger = validate_synapse_ledgers(
        &logical,
        &[
            attempt(1, SynapseMethod::Batch, AttemptDisposition::Success),
            attempt(2, SynapseMethod::Result, AttemptDisposition::Poll),
        ],
    );

    assert!(
        !ledger.valid,
        "an understated poll count must invalidate the repetition"
    );
    assert!(
        ledger
            .errors
            .iter()
            .any(|error| error.contains("records 0 polls but owns 1")),
        "{:?}",
        ledger.errors
    );

    // The same ledger with the poll count corrected is admissible, so the new
    // check rejects only the misattribution and not the shape itself.
    let corrected = vec![LogicalRecord {
        polls: 1,
        ..logical[0].clone()
    }];
    let ledger = validate_synapse_ledgers(
        &corrected,
        &[
            attempt(1, SynapseMethod::Batch, AttemptDisposition::Success),
            attempt(2, SynapseMethod::Result, AttemptDisposition::Poll),
        ],
    );
    assert!(ledger.valid, "{:?}", ledger.errors);
}
