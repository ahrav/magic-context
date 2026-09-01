#[path = "support/perf_measurement.rs"]
mod perf_measurement;

use perf_measurement::{
    fixture_workload, nearest_rank, open_loop_offset_ns, tail_publishable, validate_open_loop_rate,
    LatencySummary, Outcome, OutcomeCounts, WindowClass, FIXTURE_BODY, TAIL_SAMPLE_FLOOR,
};

#[test]
fn fixture_is_the_committed_compact_json_shape() {
    let workload = fixture_workload();
    assert_eq!(workload.label, "compact-json-v1");
    assert_eq!(workload.len, FIXTURE_BODY.len());
    assert!(!workload.binary);
    // The fixture bytes are committed benchmark input.
    assert_eq!(workload.sha256, perf_measurement::sha256_hex(FIXTURE_BODY),);
    let parsed: serde_json::Value =
        serde_json::from_slice(FIXTURE_BODY).expect("fixture is valid JSON");
    assert_eq!(parsed["op"], "perf.echo");
    // Keep the fixture's first byte distinct from the sleep-request marker.
    // The fixture must not trigger the sleep-request path.
    assert_ne!(FIXTURE_BODY[0], 1);
}

#[test]
fn fixture_bytes_are_frozen() {
    // The fixture bytes are the workload contract.
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
    // Rates above 1e9/s have sub-nanosecond intervals.
    // Reject rates above 1e9/s because slots cannot have distinct nanosecond issue times.
    assert!(validate_open_loop_rate(2_000_000_000).is_err());
    assert!(validate_open_loop_rate(1_000_000_000).is_ok());
    assert!(validate_open_loop_rate(20_000).is_ok());
    // Non-divisor rates use exact rational scheduling.
    assert!(validate_open_loop_rate(49).is_ok());
    assert!(validate_open_loop_rate(3000).is_ok());
}

#[test]
fn open_loop_offsets_are_exact_and_drift_free() {
    // Divisor rates use a fixed-interval schedule.
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
            // Each scheduled time is less than 1 ns before the ideal schedule.
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

    // Below `TAIL_SAMPLE_FLOOR`, retain count, p50–p99, and max but suppress headline p99.9.
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
            window: WindowClass::Measured,
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
            window: WindowClass::Measured,
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
        window: WindowClass::Measured,
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
    // The first pending reply uses the jittered fast-first seed; later replies use 10, 16, and 25.6 ms delays, capped at the served delay.
    // The unsaturated 10 → 16 step detects changes to the 1.6 multiplier.
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
    // A near-zero first draw would collapse every caller's first retry delay to the base value.
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
        window: WindowClass::Measured,
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
        window: WindowClass::Measured,
    };

    let duplicated_logical = validate_synapse_ledgers(
        &[logical(1, 1), logical(1, 1)],
        &[attempt(1, 1), attempt(1, 2)],
    );
    assert!(!duplicated_logical.valid);
    assert!(duplicated_logical
        .errors
        .iter()
        .any(|error| error.contains("duplicate logical_id 1")));

    let duplicated_attempt =
        validate_synapse_ledgers(&[logical(1, 2)], &[attempt(1, 1), attempt(1, 1)]);
    assert!(!duplicated_attempt.valid);
    assert!(duplicated_attempt
        .errors
        .iter()
        .any(|error| error.contains("duplicate attempt_id 1")));

    let orphan = validate_synapse_ledgers(&[logical(1, 1)], &[attempt(1, 1), attempt(9, 2)]);
    assert!(!orphan.valid);
    assert!(orphan
        .errors
        .iter()
        .any(|error| error.contains("unknown logical_id 9")));

    let miscounted = validate_synapse_ledgers(&[logical(1, 3)], &[attempt(1, 1)]);
    assert!(!miscounted.valid);
    assert!(miscounted
        .errors
        .iter()
        .any(|error| error.contains("records 3 attempts")));
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
        window: WindowClass::Measured,
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
        window: WindowClass::Measured,
    };

    let singleton = validate_synapse_ledgers(
        &[logical(1, LogicalDisposition::Completed, 1)],
        &[attempt(1, 1, AttemptDisposition::Success)],
    );
    assert!(singleton.valid);
    assert_eq!(singleton.amplification, 1.0, "closed concurrency 1 has A=1");

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
    // The first pending reply uses the fast-first seed; the 10 ms floor applies from the second pending reply onward.
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

    // For a 10-second hold beginning at 1 s, warmup covers [1 s, 2 s) and the window closes at 11 s.
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
        window: WindowClass::Measured,
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
        window: WindowClass::Measured,
    };

    let mut logical = vec![
        logical_row(1, 1_500_000_000, 1_600_000_000),
        // The warmup boundary is post-warmup; the prefix excludes its end.
        logical_row(2, 2_000_000_000, 2_100_000_000),
        logical_row(3, 5_000_000_000, 6_000_000_000),
        logical_row(4, 10_900_000_000, 13_500_000_000),
        logical_row(5, 11_200_000_000, 11_900_000_000),
    ];
    let mut attempts = vec![
        attempt_row(1),
        attempt_row(2),
        attempt_row(3),
        attempt_row(4),
        attempt_row(5),
    ];

    window.stamp(&mut logical, &mut attempts);

    use WindowClass::{AfterWindow, Measured, Warmup};
    assert_eq!(
        logical.iter().map(|r| r.window).collect::<Vec<_>>(),
        [Warmup, Measured, Measured, Measured, AfterWindow],
        "both boundaries are half-open: the warmup end is already measured and \
         the window end is already outside"
    );
    // Attempts inherit their owning request's window class so both ledgers remain reconcilable when excluded.
    assert_eq!(
        attempts.iter().map(|a| a.window).collect::<Vec<_>>(),
        [Warmup, Measured, Measured, Measured, AfterWindow]
    );

    // A measured request still open when the window closes is censored.
    // completed.
    assert_eq!(logical[3].disposition, LogicalDisposition::InFlight);
    assert_eq!(
        logical[3].terminal_code.as_deref(),
        Some(IN_FLIGHT_AT_WINDOW_END_CODE)
    );
    // Requests that settled inside the window keep their outcome.
    for record in logical.iter().take(3) {
        assert_eq!(record.disposition, LogicalDisposition::Completed);
    }
    // request".
    assert_eq!(logical[4].disposition, LogicalDisposition::Completed);
    assert_eq!(logical[4].terminal_code, None);

    // The estimate set excludes after-window records; raw evidence retains them.
    let (estimates, excluded) = perf_measurement::partition_measured(&logical, |r| r.window);
    assert_eq!(
        estimates.iter().map(|r| r.logical_id).collect::<Vec<_>>(),
        [2, 3, 4]
    );
    assert_eq!(
        excluded.iter().map(|r| r.logical_id).collect::<Vec<_>>(),
        [1, 5]
    );
    assert_eq!(
        perf_measurement::count_class(&excluded, Warmup, |r| r.window),
        1
    );
    assert_eq!(
        perf_measurement::count_class(&excluded, AfterWindow, |r| r.window),
        1
    );
}

#[test]
fn attempts_follow_their_request_so_the_per_request_ledger_reconciles() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, HoldWindow,
        LogicalDisposition, LogicalRecord, SynapseMethod,
    };

    let window = HoldWindow::new(0, 10);
    // `embed.result` always uses polling; no other method does.
    // `validate_synapse_ledgers` rejects poll methods other than `embed.result`.
    let attempt = |logical_id, attempt_id, send_ns: u64, disposition| AttemptRecord {
        logical_id,
        attempt_id,
        method: if disposition == AttemptDisposition::Poll {
            SynapseMethod::Result
        } else {
            SynapseMethod::Batch
        },
        disposition,
        code: None,
        retry_after_ms: None,
        actual_send_ns: send_ns,
        terminal_ns: send_ns + 1_000_000,
        latency_ns: 1_000_000,
        window: WindowClass::Measured,
    };
    let request =
        |logical_id, opened_ns: u64, terminal_ns, attempts, polls, disposition| LogicalRecord {
            logical_id,
            scheduled_start_ns: Some(opened_ns),
            actual_first_send_ns: opened_ns,
            terminal_ns,
            latency_ns: terminal_ns - opened_ns,
            disposition,
            terminal_code: None,
            attempts,
            polls,
            window: WindowClass::Measured,
        };

    let mut logical = vec![
        request(
            1,
            9_500_000_000,
            14_000_000_000,
            3,
            2,
            LogicalDisposition::Completed,
        ),
        // boundary.
        request(
            2,
            500_000_000,
            4_000_000_000,
            2,
            1,
            LogicalDisposition::Completed,
        ),
    ];
    let mut attempts = vec![
        attempt(1, 1, 9_500_000_000, AttemptDisposition::Success),
        attempt(1, 2, 11_000_000_000, AttemptDisposition::Poll),
        attempt(1, 3, 13_000_000_000, AttemptDisposition::Poll),
        attempt(2, 4, 500_000_000, AttemptDisposition::Success),
        // A warmup request sent this attempt after the warmup boundary.
        attempt(2, 5, 3_000_000_000, AttemptDisposition::Poll),
    ];

    window.stamp(&mut logical, &mut attempts);

    // Request ownership keeps request 1's post-window polls Measured and classifies request 2's post-warmup poll Warmup.
    assert_eq!(
        attempts.iter().map(|a| a.window).collect::<Vec<_>>(),
        [
            WindowClass::Measured,
            WindowClass::Measured,
            WindowClass::Measured,
            WindowClass::Warmup,
            WindowClass::Warmup,
        ]
    );

    // Attempt classification must follow request ownership so each measured logical record retains all of its attempts.
    // The validator rejects a logical record whose recorded attempt count differs from its owned attempts.
    let (logical_estimates, _) = perf_measurement::partition_measured(&logical, |r| r.window);
    let (attempt_estimates, _) = perf_measurement::partition_measured(&attempts, |a| a.window);
    let ledger = validate_synapse_ledgers(&logical_estimates, &attempt_estimates);
    assert!(ledger.valid, "{:?}", ledger.errors);
    assert_eq!(ledger.offered, 1);
    assert_eq!(ledger.attempts, 3);
    assert_eq!(ledger.polls, 2);

    // The contract forbids dropping post-window attempts.
    let truncated: Vec<_> = attempt_estimates
        .iter()
        .filter(|a| a.actual_send_ns < window.end_ns)
        .cloned()
        .collect();
    let broken = validate_synapse_ledgers(&logical_estimates, &truncated);
    assert!(!broken.valid);
    assert!(
        broken
            .errors
            .iter()
            .any(|error| error.contains("records 3 attempts but owns 1")),
        "{:?}",
        broken.errors
    );
}

#[test]
fn a_result_attempt_recorded_as_a_success_is_rejected() {
    use perf_measurement::{
        validate_synapse_ledgers, AttemptDisposition, AttemptRecord, LogicalDisposition,
        LogicalRecord, SynapseMethod,
    };

    // An `embed.result` row recorded as a success increments `successes` instead of `polls`, so totals can reconcile while poll counts diverge.
    // An `embed.result` row recorded as a success increments `successes` instead of `polls`, so totals can reconcile while poll counts diverge.
    // understated.
    let logical = vec![LogicalRecord {
        logical_id: 1,
        scheduled_start_ns: Some(0),
        actual_first_send_ns: 0,
        terminal_ns: 2,
        latency_ns: 2,
        disposition: LogicalDisposition::Completed,
        terminal_code: None,
        attempts: 2,
        polls: 0,
        window: WindowClass::Measured,
    }];
    let attempt = |attempt_id, method, disposition| AttemptRecord {
        logical_id: 1,
        attempt_id,
        method,
        disposition,
        code: None,
        retry_after_ms: None,
        actual_send_ns: 0,
        terminal_ns: 1,
        latency_ns: 1,
        window: WindowClass::Measured,
    };
    let attempts = vec![
        attempt(1, SynapseMethod::Batch, AttemptDisposition::Success),
        attempt(2, SynapseMethod::Result, AttemptDisposition::Success),
    ];

    let ledger = validate_synapse_ledgers(&logical, &attempts);
    // The validator checks poll counts independently because total attempt counts can reconcile when `embed.result` rows are recorded as successes.
    assert_eq!(ledger.attempts, 2);
    assert_eq!(ledger.polls, 0);
    assert!(!ledger.valid);
    assert!(
        ledger
            .errors
            .iter()
            .any(|error| error.contains("every embed.result attempt is a poll")),
        "{:?}",
        ledger.errors
    );

    // A non-poll method cannot use Poll disposition.
    let mislabelled = vec![
        attempt(1, SynapseMethod::Batch, AttemptDisposition::Success),
        attempt(2, SynapseMethod::Query, AttemptDisposition::Poll),
    ];
    let ledger = validate_synapse_ledgers(&logical, &mislabelled);
    assert!(!ledger.valid);
    assert!(ledger
        .errors
        .iter()
        .any(|error| error.contains("no other method is")));
}

#[test]
fn an_orphan_attempt_cannot_enter_the_measured_set() {
    use perf_measurement::{
        AttemptDisposition, AttemptRecord, HoldWindow, LogicalDisposition, LogicalRecord,
        SynapseMethod,
    };

    let window = HoldWindow::new(0, 10);
    let mut logical = vec![LogicalRecord {
        logical_id: 1,
        scheduled_start_ns: Some(5_000_000_000),
        actual_first_send_ns: 5_000_000_000,
        terminal_ns: 5_100_000_000,
        latency_ns: 100_000_000,
        disposition: LogicalDisposition::Completed,
        terminal_code: None,
        attempts: 1,
        polls: 0,
        window: WindowClass::Measured,
    }];
    let attempt = |logical_id, attempt_id| AttemptRecord {
        logical_id,
        attempt_id,
        method: SynapseMethod::Query,
        disposition: AttemptDisposition::Success,
        code: None,
        retry_after_ms: None,
        actual_send_ns: 5_000_000_000,
        terminal_ns: 5_100_000_000,
        latency_ns: 100_000_000,
        window: WindowClass::Measured,
    };
    // The validator rejects attempts whose `logical_id` is absent from the logical ledger.
    // The classifier excludes an orphan from estimates, and the ledger validator rejects it.
    // The validator reports attempts whose `logical_id` is absent from the logical ledger.
    let mut attempts = vec![attempt(1, 1), attempt(99, 2)];

    window.stamp(&mut logical, &mut attempts);

    assert_eq!(attempts[0].window, WindowClass::Measured);
    assert_eq!(attempts[1].window, WindowClass::AfterWindow);
    let (measured, excluded) = perf_measurement::partition_measured(&attempts, |a| a.window);
    assert_eq!(measured.len(), 1);
    assert_eq!(excluded.len(), 1);
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
        window: WindowClass::Measured,
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
        window: WindowClass::Measured,
    }];
    let ledger = validate_synapse_ledgers(
        &logical,
        &[
            // A served call has wire evidence that the host admitted it.
            attempt(1, AttemptDisposition::Success, None),
            // An admission rejection has wire evidence that the host did not admit the call.
            attempt(
                2,
                AttemptDisposition::RetryableRejection,
                Some("queue_full"),
            ),
            // No terminal arrived, so the wire records neither admission nor rejection.
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
        window: WindowClass::Measured,
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
            window: WindowClass::Measured,
        }],
    );

    assert_eq!(ledger.successes, 0, "the row must not be counted a success");
    assert_eq!(ledger.failures, 1);
    // A recorded `Failure` is outside the four-category attempt vocabulary.
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
        window: WindowClass::Measured,
    };
    // The row owns one submission and one poll, so `attempts: 2` is accurate.
    // The attempt-count check accepts `attempts: 2` but does not detect `polls: 0`.
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
        window: WindowClass::Measured,
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

    // With `polls: 1`, `validate_synapse_ledgers` accepts the ledger.
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
