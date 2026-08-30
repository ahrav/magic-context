//! Runner-level contract tests: script syntax, script/Rust schedule and
//! rate-default parity, deterministic counterbalanced dry-run schedules,
//! preserved open-loop arrival schedules, missed-slot accounting under a
//! full in-flight queue, and throughput-arm rate separation.

#![allow(clippy::duplicate_mod)]

#[path = "support/perf_measurement.rs"]
mod perf_measurement;

#[path = "../benches/support/evidence.rs"]
mod evidence;

#[path = "../benches/support/ring.rs"]
mod ring;

#[path = "support/echo_host.rs"]
mod echo_host;

// The bench entry point, included for its schedule-expansion seam
// (`plan_block_entries`, `DEFAULT_RATES`); its collection machinery is
// unused here.
#[path = "../benches/ipc_budget.rs"]
#[allow(dead_code)]
mod ipc_budget;

use std::time::Duration;

use evidence::{counterbalanced_schedule, HistogramConfig};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn script_text() -> String {
    std::fs::read_to_string(repo_root().join("scripts/perf-mc-host.sh")).unwrap()
}

/// The budget arm names in forward orientation, from the shared constants.
fn budget_arms() -> Vec<String> {
    [
        evidence::ARM_ATOMIC,
        evidence::ARM_RING_SERIAL,
        evidence::ARM_RING_OPEN,
        evidence::ARM_RING_THROUGHPUT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// The cross-NUMA paired tail in forward orientation.
fn cross_arms() -> Vec<String> {
    [evidence::ARM_ATOMIC, evidence::ARM_RING_SERIAL]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Extracts every `name=(...)` array assignment in the script as its
/// whitespace-separated tokens, in file order.
fn script_array_values(script: &str, name: &str) -> Vec<Vec<String>> {
    let prefix = format!("{name}=(");
    script
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("local ").unwrap_or(line);
            let inner = line.strip_prefix(&prefix)?.strip_suffix(')')?;
            Some(inner.split_whitespace().map(str::to_owned).collect())
        })
        .collect()
}

#[test]
fn perf_script_parses() {
    let script = repo_root().join("scripts/perf-mc-host.sh");
    let status = std::process::Command::new("bash")
        .arg("-n")
        .arg(&script)
        .status()
        .unwrap();
    assert!(status.success(), "bash -n rejected {}", script.display());
}

#[test]
fn script_arm_orders_match_rust_constants_in_both_orientations() {
    let script = script_text();

    let forward = budget_arms();
    let mut reversed = forward.clone();
    reversed.reverse();
    assert_eq!(
        script_array_values(&script, "arms"),
        vec![forward, reversed],
        "the script's same-l3 arms=() lines must match the Rust arm \
         constants forward then reversed"
    );

    let cross_forward = cross_arms();
    let mut cross_reversed = cross_forward.clone();
    cross_reversed.reverse();
    assert_eq!(
        script_array_values(&script, "cross"),
        vec![cross_forward, cross_reversed],
        "the script's cross=() lines must match the cross-NUMA tail \
         forward then reversed"
    );
}

#[test]
fn script_rate_default_matches_rust_constant() {
    let default = script_text()
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("BUDGET_RATES=\"${BUDGET_RATES:-")?
                .strip_suffix("}\"")
                .map(str::to_owned)
        })
        .expect("script defines the BUDGET_RATES default");
    assert_eq!(default, ipc_budget::DEFAULT_RATES);
}

#[test]
fn plan_blocks_expand_rates_and_cross_numa_tail() {
    let rates: Vec<u64> = ipc_budget::DEFAULT_RATES
        .split_whitespace()
        .map(|token| token.parse().unwrap())
        .collect();
    let same_l3 = counterbalanced_schedule(2, &budget_arms());
    let cross = counterbalanced_schedule(2, &cross_arms());

    let odd = ipc_budget::plan_block_entries(&same_l3[0], &cross[0], &rates);
    assert_eq!(
        odd,
        [
            "atomic-floor@same-l3",
            "ring-serial@same-l3",
            "ring-open@same-l3:r20000",
            "ring-open@same-l3:r50000",
            "ring-open@same-l3:r80000",
            "ring-throughput@same-l3",
            "atomic-floor@cross-numa",
            "ring-serial@cross-numa",
        ]
    );

    // Even blocks reverse the same-L3 arm order and the cross-NUMA tail
    // (matching the script's `arms` and `cross` arrays); the rate
    // fan-out inside ring-open keeps the script's `for rate in
    // $BUDGET_RATES` order.
    let even = ipc_budget::plan_block_entries(&same_l3[1], &cross[1], &rates);
    assert_eq!(
        even,
        [
            "ring-throughput@same-l3",
            "ring-open@same-l3:r20000",
            "ring-open@same-l3:r50000",
            "ring-open@same-l3:r80000",
            "ring-serial@same-l3",
            "atomic-floor@same-l3",
            "ring-serial@cross-numa",
            "atomic-floor@cross-numa",
        ]
    );
}

#[test]
fn dry_run_schedule_is_stable_across_invocations() {
    let arms = budget_arms();
    let first = counterbalanced_schedule(10, &arms);
    let second = counterbalanced_schedule(10, &arms);
    assert_eq!(first, second);
    assert_eq!(first.len(), 10);
    // Counterbalancing: each arm leads half the blocks' orientations.
    assert_eq!(first[0].first(), first[2].first());
    assert_eq!(first[1].first(), first[3].first());
    assert_ne!(first[0].first(), first[1].first());
    // Every block runs every arm exactly once.
    for block in &first {
        let mut sorted = block.clone();
        sorted.sort();
        let mut expected = arms.clone();
        expected.sort();
        assert_eq!(sorted, expected);
    }
}

#[test]
fn open_loop_preserves_schedule_and_records_missed_slots() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());

    // A one-deep in-flight cap at an interval far below loopback RTT
    // forces slot misses; the absolute schedule must keep counting slots
    // rather than bursting to catch up.
    let cfg = ring::OpenLoopConfig {
        rate_per_sec: 50_000,
        warmup: Duration::from_millis(200),
        measure: Duration::from_millis(800),
        inflight_cap: 1,
        histogram: HistogramConfig::default(),
    };
    let result = ring::run_open_loop(&host.publication, &cfg).unwrap();
    assert!(!result.truncated, "healthy host must complete the window");

    // The arrival schedule is frozen by (rate, window): the measured slot
    // count equals measure/interval regardless of completions.
    let expected_slots = 800 * 50; // 800 ms at 50 slots/ms
    assert!(
        (result.scheduled_slots as i64 - expected_slots).unsigned_abs() <= 1,
        "scheduled {} slots, expected ~{expected_slots}",
        result.scheduled_slots
    );
    assert!(
        result.outcomes.missed_slot > 0,
        "a full in-flight queue must record missed slots: {:?}",
        result.outcomes
    );
    assert!(
        result.outcomes.conserved(result.scheduled_slots),
        "every scheduled slot resolves exactly once: {:?} for {}",
        result.outcomes,
        result.scheduled_slots
    );
    assert!(result.outcomes.success > 0);

    // Issue-time discrimination: with a saturated one-deep window the
    // generator runs behind schedule, so recorded lag is large and
    // mean(sched-to-completion) = mean(issue-to-completion) + mean(lag)
    // (identical timestamps per request). An implementation that timed
    // issue from the scheduled slot would record lag but identical
    // sched/issue distributions and fail this.
    let sched_mean = result.sched_to_completion.mean();
    let issue_mean = result.issue_to_completion.mean();
    let lag_mean = result.scheduler_lag.mean();
    assert!(lag_mean > 1_000.0, "saturation must produce real lag");
    let reconstructed = issue_mean + lag_mean;
    assert!(
        (sched_mean - reconstructed).abs() / sched_mean < 0.05,
        "sched mean {sched_mean} != issue mean {issue_mean} + lag mean {lag_mean}"
    );
}

#[test]
fn open_loop_separates_lag_from_server_latency() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());

    let cfg = ring::OpenLoopConfig {
        rate_per_sec: 500,
        warmup: Duration::from_millis(200),
        measure: Duration::from_millis(800),
        inflight_cap: 64,
        histogram: HistogramConfig::default(),
    };
    let result = ring::run_open_loop(&host.publication, &cfg).unwrap();
    assert!(!result.truncated, "healthy host must complete the window");
    assert!(result.outcomes.success > 0);
    assert!(result.outcomes.conserved(result.scheduled_slots));
    // Three distinct distributions with consistent sample counts.
    assert_eq!(result.sched_to_completion.len(), result.outcomes.success);
    assert_eq!(result.issue_to_completion.len(), result.outcomes.success);
    assert_eq!(result.scheduler_lag.len(), result.outcomes.success);
    // sched-to-completion >= issue-to-completion for every request, so it
    // holds for medians too.
    assert!(
        result.sched_to_completion.value_at_quantile(0.5)
            >= result.issue_to_completion.value_at_quantile(0.5)
    );
}

#[test]
fn throughput_arm_reports_rates_separately() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());

    let cfg = ring::ThroughputConfig {
        depth: 16,
        warmup: Duration::from_millis(200),
        measure: Duration::from_millis(800),
    };
    let result = ring::run_throughput(&host.publication, &cfg).unwrap();
    assert!(!result.truncated, "healthy host must complete the window");
    assert!(result.successful > 0);
    assert_eq!(result.successful, result.outcomes.success);
    assert!(result.terminal >= result.successful);
    assert!(result.successful_per_sec > 0.0);
    assert!(result.goodput_bytes_per_sec > result.successful_per_sec);
    assert!(result.measured >= Duration::from_millis(700));
    // A healthy window closes either on the boundary terminal (depth-1
    // requests left in flight) or on the window deadline between frames
    // (depth in flight); the post-window drain must resolve each exactly
    // once (an undrained response returns Err instead).
    let depth = cfg.depth as u64;
    assert!(
        result.drained == depth || result.drained == depth - 1,
        "drained {} responses for a depth-{depth} pipeline",
        result.drained
    );
}

#[test]
fn serial_arm_stays_one_in_flight() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());

    let cfg = ring::SerialConfig {
        warmup_ops: 10,
        measured_ops: 200,
        histogram: HistogramConfig::default(),
    };
    let result = ring::run_serial(&host.publication, &cfg).unwrap();
    assert_eq!(result.outcomes.success, 200);
    assert!(result.outcomes.conserved(result.scheduled));
    // Serial: one request in flight, so measured wall time is at least
    // the sum of recorded RTTs; a depth-2 pipeline would halve the wall
    // time and fail.
    let sum_rtt_ns: u64 = result
        .histogram
        .iter_recorded()
        .map(|v| v.value_iterated_to() * v.count_at_value())
        .sum();
    assert!(
        result.elapsed.as_nanos() as u64 >= sum_rtt_ns,
        "elapsed {:?} vs recorded sum {}ns",
        result.elapsed,
        sum_rtt_ns
    );
}

#[test]
fn host_death_mid_run_conserves_outcomes() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());
    let publication = host.publication.clone();

    // Kill the host mid-measurement from another thread.
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        drop(host);
    });

    let cfg = ring::OpenLoopConfig {
        rate_per_sec: 2_000,
        warmup: Duration::from_millis(100),
        measure: Duration::from_secs(5),
        inflight_cap: 64,
        histogram: HistogramConfig::default(),
    };
    let result = ring::run_open_loop(&publication, &cfg).unwrap();
    killer.join().unwrap();

    // Host death may resolve every in-flight request cleanly first (the
    // host error-flushes before closing), so specific failure outcomes
    // are not guaranteed. The guaranteed signals are the truncation
    // marker — the window cannot complete against a dead host — and
    // conservation over the slots reached before the break.
    let o = &result.outcomes;
    assert!(
        result.truncated,
        "a connection retired mid-window must report truncation: {o:?}"
    );
    assert!(
        o.conserved(result.scheduled_slots),
        "conservation across failure paths: {o:?} for {} slots",
        result.scheduled_slots
    );
}
