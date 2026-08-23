//! Runner-level contract tests: script syntax, deterministic
//! counterbalanced dry-run schedules, preserved open-loop arrival
//! schedules, missed-slot accounting under a full in-flight queue, and
//! throughput-arm rate separation.

#[path = "support/raw_client.rs"]
mod raw_client;

#[path = "support/perf_measurement.rs"]
mod perf_measurement;

#[path = "../benches/support/evidence.rs"]
mod evidence;

#[path = "../benches/support/tcp.rs"]
mod tcp;

#[path = "support/echo_host.rs"]
mod echo_host;

use std::time::Duration;

use evidence::{counterbalanced_schedule, HistogramConfig};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
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
fn dry_run_schedule_is_stable_across_invocations() {
    let arms: Vec<String> = [
        evidence::ARM_ATOMIC,
        evidence::ARM_TCP_SERIAL,
        evidence::ARM_TCP_OPEN,
        evidence::ARM_TCP_THROUGHPUT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
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
    let cfg = tcp::OpenLoopConfig {
        rate_per_sec: 50_000,
        warmup: Duration::from_millis(200),
        measure: Duration::from_millis(800),
        inflight_cap: 1,
        histogram: HistogramConfig::default(),
    };
    let result = tcp::run_open_loop(&host.publication, &cfg).unwrap();

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

    let cfg = tcp::OpenLoopConfig {
        rate_per_sec: 500,
        warmup: Duration::from_millis(200),
        measure: Duration::from_millis(800),
        inflight_cap: 64,
        histogram: HistogramConfig::default(),
    };
    let result = tcp::run_open_loop(&host.publication, &cfg).unwrap();
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

    let cfg = tcp::ThroughputConfig {
        depth: 16,
        warmup: Duration::from_millis(200),
        measure: Duration::from_millis(800),
    };
    let result = tcp::run_throughput(&host.publication, &cfg).unwrap();
    assert!(result.successful > 0);
    assert_eq!(result.successful, result.outcomes.success);
    assert!(result.terminal >= result.successful);
    assert!(result.successful_per_sec > 0.0);
    assert!(result.goodput_bytes_per_sec > result.successful_per_sec);
    assert!(result.measured >= Duration::from_millis(700));
}

#[test]
fn serial_arm_stays_one_in_flight() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());

    let cfg = tcp::SerialConfig {
        warmup_ops: 10,
        measured_ops: 200,
        histogram: HistogramConfig::default(),
    };
    let result = tcp::run_serial(&host.publication, &cfg).unwrap();
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

    let cfg = tcp::OpenLoopConfig {
        rate_per_sec: 2_000,
        warmup: Duration::from_millis(100),
        measure: Duration::from_secs(5),
        inflight_cap: 64,
        histogram: HistogramConfig::default(),
    };
    let result = tcp::run_open_loop(&publication, &cfg).unwrap();
    killer.join().unwrap();

    // The failure paths (peer close, write failure, unresolved drain)
    // must still resolve every measured slot exactly once.
    let o = &result.outcomes;
    assert!(
        o.peer_closed + o.write_failure + o.unresolved_at_drain > 0,
        "host death must surface as failure outcomes: {o:?}"
    );
    assert!(
        o.conserved(result.scheduled_slots),
        "conservation across failure paths: {o:?} for {} slots",
        result.scheduled_slots
    );
}
