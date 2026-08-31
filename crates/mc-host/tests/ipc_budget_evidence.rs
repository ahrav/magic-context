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

use std::path::Path;

use evidence::{
    counterbalanced_schedule, ArmId, Attempt, BuildId, HistogramConfig, HostId, Manifest, State,
    ARM_ATOMIC, ARM_TCP_SERIAL,
};
use perf_measurement::fixture_workload;

fn manifest(arm: &str, block: u32, pair: Option<(u32, u32)>) -> Manifest {
    Manifest {
        schema: evidence::SCHEMA_VERSION,
        state: State::Running,
        arm: ArmId {
            name: arm.to_owned(),
            class: Some("same-l3".to_owned()),
            pair,
        },
        run_block: block,
        started_utc: evidence::utc_now(),
        finished_utc: None,
        workload: fixture_workload(),
        build: BuildId {
            commit: "test-commit".to_owned(),
            rustc: "test-rustc".to_owned(),
            profile: "debug".to_owned(),
            binary: "test-binary".to_owned(),
        },
        host: HostId {
            hostname: "test-host".to_owned(),
            kernel: "0.0".to_owned(),
            cpu_model: "synthetic".to_owned(),
            cpu_count: 2,
        },
        histogram: None,
        host_load: None,
        affinity: None,
        outcomes: None,
        recorded_samples: None,
        histogram_rejected: None,
        skip_reason: None,
        fail_reason: None,
        sidecars: Vec::new(),
        collection: None,
        results: None,
    }
}

fn small_histogram(values: &[u64]) -> hdrhistogram::Histogram<u64> {
    let mut hist = HistogramConfig::default().build().unwrap();
    for &v in values {
        hist.record(v).unwrap();
    }
    hist
}

/// Paired-gap integrity recomputes serial p50 from the histogram sidecar; fixtures derive it likewise.
fn serial_p50(values: &[u64]) -> f64 {
    small_histogram(values).value_at_quantile(0.5) as f64
}

/// Atomic-floor attempts include `batches.json` because paired-gap integrity recomputes its median.
fn write_complete(
    run_dir: &Path,
    arm: &str,
    block: u32,
    pair: (u32, u32),
    hist_file: &str,
    values: &[u64],
    results: serde_json::Value,
) {
    let mut attempt = Attempt::begin(
        run_dir,
        &format!("{arm}-b{block:02}"),
        manifest(arm, block, Some(pair)),
    )
    .unwrap();
    attempt
        .add_histogram(hist_file, &small_histogram(values))
        .unwrap();
    if arm == ARM_ATOMIC {
        let means: Vec<f64> = values.iter().map(|&v| v as f64).collect();
        let raw =
            serde_json::to_vec_pretty(&serde_json::json!({"batch_mean_rtt_ns": means})).unwrap();
        attempt.add_sidecar("batches.json", &raw).unwrap();
    }
    let m = attempt.manifest_mut();
    m.histogram = Some(HistogramConfig::default());
    // Pairing spans arms with different collection schemas; merges within one arm require equal collections.
    // collection equality.
    m.collection = Some(serde_json::json!({"fixture_arm": arm}));
    m.results = Some(results);
    attempt.finalize(State::Complete).unwrap();
}

#[test]
fn histogram_resolves_sub_microsecond_samples_to_the_nanosecond() {
    // A 64 ns unit would collapse neighboring samples and quantize merged percentiles.
    let samples = [146u64, 147, 210, 279, 280];
    let hist = small_histogram(&samples);
    for &v in &samples {
        assert_eq!(hist.count_at(v), 1, "{v} ns shares a bucket");
    }
    assert_eq!(hist.min(), 146);
    assert_eq!(hist.max(), 280);
    assert_eq!(hist.value_at_quantile(0.5), 210);
}

#[test]
fn attempt_directory_is_never_appended_into() {
    let dir = tempfile::tempdir().unwrap();
    let _first = Attempt::begin(dir.path(), "arm-b01", manifest(ARM_ATOMIC, 1, None)).unwrap();
    let err = Attempt::begin(dir.path(), "arm-b01", manifest(ARM_ATOMIC, 1, None)).unwrap_err();
    assert!(err.contains("already exists"), "{err}");
}

#[test]
fn attempt_moves_running_to_one_terminal_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut attempt =
        Attempt::begin(dir.path(), "arm-b01", manifest(ARM_ATOMIC, 1, Some((0, 1)))).unwrap();
    let attempt_dir = attempt.dir().to_path_buf();
    assert!(attempt_dir.join(evidence::RUNNING_MANIFEST).is_file());
    assert!(!attempt_dir.join(evidence::FINAL_MANIFEST).exists());

    attempt.add_sidecar("data.json", b"[1,2,3]").unwrap();
    attempt.manifest_mut().results = Some(serde_json::json!({"ok": true}));
    attempt.finalize(State::Complete).unwrap();

    assert!(!attempt_dir.join(evidence::RUNNING_MANIFEST).exists());
    let loaded = evidence::load_attempts(dir.path()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].manifest.state, State::Complete);
    assert_eq!(loaded[0].manifest.sidecars.len(), 1);
    evidence::verify_sidecars(&loaded[0]).unwrap();
}

#[test]
fn interrupted_attempt_is_retained_and_excluded() {
    let dir = tempfile::tempdir().unwrap();
    // Forgetting `attempt` leaves the running manifest behind to simulate a killed process.
    let attempt =
        Attempt::begin(dir.path(), "arm-b01", manifest(ARM_ATOMIC, 1, Some((0, 1)))).unwrap();
    let attempt_dir = attempt.dir().to_path_buf();
    std::mem::forget(attempt);

    assert!(evidence::load_attempts(dir.path()).unwrap().is_empty());

    // The interrupt trap finalizes interrupted attempts; they remain available for diagnosis and never aggregate.
    // The rename atomically publishes and consumes the temporary file.
    // The rename atomically publishes and consumes the temporary file.
    let finalized = evidence::finalize_interrupted(dir.path()).unwrap();
    assert_eq!(finalized.len(), 1);
    assert!(!attempt_dir.join(evidence::RUNNING_MANIFEST).exists());
    assert!(!attempt_dir.join("manifest.json.tmp").exists());
    let loaded = evidence::load_attempts(dir.path()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].manifest.state, State::Interrupted);
    let gaps = evidence::paired_gaps(&loaded).unwrap();
    assert!(gaps.is_empty());
}

#[test]
fn skipped_manifest_retains_reason() {
    let dir = tempfile::tempdir().unwrap();
    let mut attempt = Attempt::begin(dir.path(), "arm-b01", manifest(ARM_ATOMIC, 1, None)).unwrap();
    attempt.manifest_mut().skip_reason = Some("no second NUMA node".to_owned());
    attempt.finalize(State::Skipped).unwrap();
    let loaded = evidence::load_attempts(dir.path()).unwrap();
    assert_eq!(loaded[0].manifest.state, State::Skipped);
    assert_eq!(
        loaded[0].manifest.skip_reason.as_deref(),
        Some("no second NUMA node")
    );
}

#[test]
fn sidecar_corruption_blocks_aggregation() {
    let dir = tempfile::tempdir().unwrap();
    write_complete(
        dir.path(),
        ARM_ATOMIC,
        1,
        (0, 1),
        "batch_mean_rtt.hist",
        &[500, 600],
        serde_json::json!({"median_batch_rtt_ns": 550.0}),
    );
    let loaded = evidence::load_attempts(dir.path()).unwrap();
    evidence::verify_sidecars(&loaded[0]).unwrap();

    let sidecar = loaded[0].dir.join("batch_mean_rtt.hist");
    std::fs::write(&sidecar, b"corrupt").unwrap();
    let err = evidence::verify_sidecars(&loaded[0]).unwrap_err();
    assert!(err.contains("checksum mismatch"), "{err}");
    let arm = loaded[0].manifest.arm.clone();
    assert!(evidence::merge_arm_histograms(&loaded, &arm, "batch_mean_rtt.hist").is_err());
}

#[test]
fn incompatible_manifests_never_merge_or_pair() {
    // Each incompatibility axis independently rejects histogram merging and gap pairing.
    // Load rejects schema mismatches because equal foreign schemas would pass pairwise checks.
    // Load rejects schema mismatches because equal foreign schemas would pass pairwise checks.
    // check.
    for (name, mutate) in [
        (
            "build",
            Box::new(|m: &mut Manifest| m.build.commit = "other-commit".to_owned())
                as Box<dyn Fn(&mut Manifest)>,
        ),
        (
            "workload",
            Box::new(|m: &mut Manifest| m.workload.sha256 = "0".repeat(64)),
        ),
        (
            "host",
            Box::new(|m: &mut Manifest| m.host.hostname = "other-host".to_owned()),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        write_complete(
            dir.path(),
            ARM_ATOMIC,
            1,
            (0, 1),
            "batch_mean_rtt.hist",
            &[500],
            serde_json::json!({"median_batch_rtt_ns": 500.0}),
        );

        let mut other = manifest(ARM_ATOMIC, 2, Some((0, 1)));
        mutate(&mut other);
        let mut attempt = Attempt::begin(dir.path(), "atomic-b02", other).unwrap();
        attempt
            .add_histogram("batch_mean_rtt.hist", &small_histogram(&[700]))
            .unwrap();
        attempt
            .add_sidecar(
                "batches.json",
                &serde_json::to_vec_pretty(&serde_json::json!({"batch_mean_rtt_ns": [700.0]}))
                    .unwrap(),
            )
            .unwrap();
        attempt.manifest_mut().histogram = Some(HistogramConfig::default());
        attempt.manifest_mut().collection = Some(serde_json::json!({"fixture_arm": ARM_ATOMIC}));
        attempt.manifest_mut().results = Some(serde_json::json!({"median_batch_rtt_ns": 700.0}));
        attempt.finalize(State::Complete).unwrap();

        let loaded = evidence::load_attempts(dir.path()).unwrap();
        let arm = ArmId {
            name: ARM_ATOMIC.to_owned(),
            class: Some("same-l3".to_owned()),
            pair: Some((0, 1)),
        };
        let err =
            evidence::merge_arm_histograms(&loaded, &arm, "batch_mean_rtt.hist").expect_err(name);
        assert!(err.contains("incompatible"), "{name}: {err}");
        let err = evidence::paired_gaps(&loaded).expect_err(name);
        assert!(err.contains("incompatible"), "{name}: {err}");
    }
}

#[test]
fn unsupported_schema_version_is_refused_at_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut foreign = manifest(ARM_ATOMIC, 1, Some((0, 1)));
    foreign.schema += 1;
    let mut attempt = Attempt::begin(dir.path(), "atomic-b01", foreign).unwrap();
    attempt
        .add_histogram("batch_mean_rtt.hist", &small_histogram(&[500]))
        .unwrap();
    attempt.manifest_mut().histogram = Some(HistogramConfig::default());
    attempt.manifest_mut().results = Some(serde_json::json!({"median_batch_rtt_ns": 500.0}));
    attempt.finalize(State::Complete).unwrap();

    let err = evidence::load_attempts(dir.path()).expect_err("foreign schema must refuse to load");
    assert!(err.contains("schema"), "{err}");
}

#[test]
fn arm_mismatch_blocks_merge_but_gap_join_survives() {
    let dir = tempfile::tempdir().unwrap();
    write_complete(
        dir.path(),
        ARM_ATOMIC,
        1,
        (0, 1),
        "batch_mean_rtt.hist",
        &[500],
        serde_json::json!({"median_batch_rtt_ns": 500.0}),
    );
    write_complete(
        dir.path(),
        ARM_TCP_SERIAL,
        1,
        (0, 1),
        "issue_to_terminal.hist",
        &[20_000],
        serde_json::json!({"p50_ns": serial_p50(&[20_000])}),
    );
    let loaded = evidence::load_attempts(dir.path()).unwrap();

    // own attempts.
    let atomic_arm = ArmId {
        name: ARM_ATOMIC.to_owned(),
        class: Some("same-l3".to_owned()),
        pair: Some((0, 1)),
    };
    let merged =
        evidence::merge_arm_histograms(&loaded, &atomic_arm, "batch_mean_rtt.hist").unwrap();
    assert_eq!(merged.len(), 1);

    // The designated atomic-floor / serial-TCP pair joins by run block.
    let p50 = serial_p50(&[20_000]);
    let gaps = evidence::paired_gaps(&loaded).unwrap();
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0].run_block, 1);
    assert_eq!(gaps[0].pair, (0, 1));
    assert!((gaps[0].gap_ns - (p50 - 500.0)).abs() < f64::EPSILON);
    assert!((gaps[0].ratio - p50 / 500.0).abs() < f64::EPSILON);
}

#[test]
fn gap_join_requires_matching_block_and_pair() {
    let dir = tempfile::tempdir().unwrap();
    write_complete(
        dir.path(),
        ARM_ATOMIC,
        1,
        (0, 1),
        "batch_mean_rtt.hist",
        &[500],
        serde_json::json!({"median_batch_rtt_ns": 500.0}),
    );
    // Neither serial attempt joins: the block-2 attempt and pair-(2, 3) attempt both mismatch the atomic attempt.
    // Neither serial attempt joins: the block-2 attempt and pair-(2, 3) attempt both mismatch the atomic attempt.
    write_complete(
        dir.path(),
        ARM_TCP_SERIAL,
        2,
        (0, 1),
        "issue_to_terminal.hist",
        &[20_000],
        serde_json::json!({"p50_ns": serial_p50(&[20_000])}),
    );
    write_complete(
        dir.path(),
        ARM_TCP_SERIAL,
        1,
        (2, 3),
        "issue_to_terminal.hist",
        &[20_000],
        serde_json::json!({"p50_ns": serial_p50(&[20_000])}),
    );
    // A serial attempt joins only when its topology class matches the atomic attempt's class.
    // A physical pair can validate for both topology classes when its nodes share an L3 under sub-NUMA clustering.
    // Observations from different topology classes are not comparable.
    // not comparable.
    let mut cross = manifest(ARM_TCP_SERIAL, 1, Some((0, 1)));
    cross.arm.class = Some("cross-numa".to_owned());
    let mut attempt = Attempt::begin(dir.path(), "serial-cross-b01", cross).unwrap();
    attempt
        .add_histogram("issue_to_terminal.hist", &small_histogram(&[20_000]))
        .unwrap();
    attempt.manifest_mut().histogram = Some(HistogramConfig::default());
    attempt.manifest_mut().collection = Some(serde_json::json!({"fixture_arm": ARM_TCP_SERIAL}));
    attempt.manifest_mut().results = Some(serde_json::json!({"p50_ns": serial_p50(&[20_000])}));
    attempt.finalize(State::Complete).unwrap();
    let loaded = evidence::load_attempts(dir.path()).unwrap();
    assert!(evidence::paired_gaps(&loaded).unwrap().is_empty());
}

#[test]
fn gap_scalar_disagreeing_with_sidecar_is_rejected() {
    // Pairing recomputes the result scalar from the verified sidecar because sidecar checksums do not protect manifest `results` fields.
    let dir = tempfile::tempdir().unwrap();
    write_complete(
        dir.path(),
        ARM_ATOMIC,
        1,
        (0, 1),
        "batch_mean_rtt.hist",
        &[500],
        serde_json::json!({"median_batch_rtt_ns": 500.0}),
    );
    write_complete(
        dir.path(),
        ARM_TCP_SERIAL,
        1,
        (0, 1),
        "issue_to_terminal.hist",
        &[20_000],
        serde_json::json!({"p50_ns": serial_p50(&[20_000])}),
    );
    let path = dir
        .path()
        .join(format!("{ARM_ATOMIC}-b01"))
        .join(evidence::FINAL_MANIFEST);
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("500.0", "400.0");
    std::fs::write(&path, text).unwrap();

    let loaded = evidence::load_attempts(dir.path()).unwrap();
    let err = evidence::paired_gaps(&loaded).expect_err("tampered scalar must be rejected");
    assert!(err.contains("disagrees"), "{err}");
}

#[test]
fn counterbalanced_schedule_is_deterministic() {
    let arms: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
    let first = counterbalanced_schedule(4, &arms);
    let second = counterbalanced_schedule(4, &arms);
    assert_eq!(first, second, "repeated invocations emit the same schedule");
    assert_eq!(first[0], vec!["a", "b", "c"]);
    assert_eq!(first[1], vec!["c", "b", "a"]);
    assert_eq!(first[2], vec!["a", "b", "c"]);
    assert_eq!(first[3], vec!["c", "b", "a"]);
}

#[test]
fn bootstrap_interval_is_deterministic_and_bounded() {
    let values = [10.0, 12.0, 11.0, 13.0, 9.0, 14.0, 10.5, 12.5, 11.5, 13.5];
    let a = evidence::bootstrap_interval(&values, 2000, 42).unwrap();
    let b = evidence::bootstrap_interval(&values, 2000, 42).unwrap();
    assert_eq!(a, b, "same seed, same interval");
    assert!(a.0 <= a.1);
    assert!(
        a.0 > 9.0 && a.1 < 14.0,
        "interval {a:?} not strictly inside"
    );
    assert!(evidence::bootstrap_interval(&[], 100, 1).is_none());
}

#[test]
fn tiny_serial_run_finalizes_a_complete_manifest() {
    let data_dir = tempfile::tempdir().unwrap();
    let host = echo_host::InProcessHost::start(data_dir.path());
    let publication = host.publication.clone();

    // The fixture uses one authenticated connection over one route for echo round trips.
    let cfg = tcp::SerialConfig {
        warmup_ops: 5,
        measured_ops: 50,
        histogram: HistogramConfig::default(),
    };
    let result = tcp::run_serial(&publication, &cfg).unwrap();
    assert_eq!(result.outcomes.success, 50);
    assert!(result.outcomes.conserved(result.scheduled));
    assert_eq!(result.histogram.len(), 50);

    let run_root = tempfile::tempdir().unwrap();
    let mut attempt = Attempt::begin(
        run_root.path(),
        "tcp-serial-same-l3-b01",
        manifest(ARM_TCP_SERIAL, 1, Some((0, 1))),
    )
    .unwrap();
    attempt
        .add_histogram("issue_to_terminal.hist", &result.histogram)
        .unwrap();
    let m = attempt.manifest_mut();
    m.histogram = Some(cfg.histogram.clone());
    m.outcomes = Some(result.outcomes.clone());
    m.recorded_samples = Some(result.histogram.len());
    m.results = Some(serde_json::json!({
        "p50_ns": result.histogram.value_at_quantile(0.5),
    }));
    attempt.finalize(State::Complete).unwrap();

    let loaded = evidence::load_attempts(run_root.path()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].manifest.state, State::Complete);
    evidence::verify_sidecars(&loaded[0]).unwrap();
    let restored = evidence::read_histogram(&loaded[0], "issue_to_terminal.hist").unwrap();
    assert_eq!(restored.len(), 50);
    assert_eq!(
        restored.value_at_quantile(0.5),
        result.histogram.value_at_quantile(0.5),
        "sidecar round-trips the recorded distribution"
    );
}
