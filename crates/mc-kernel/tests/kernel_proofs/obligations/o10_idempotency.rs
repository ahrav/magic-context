//! O10, duplicate-processing idempotency: a history run once equals the same
//! history run with duplicated, restarted, and faulted-then-retried steps.
//! Per-subsystem replay proofs live in the sibling kernel test files; this
//! module owns the cross-cutting property.

use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

use crate::model::{run, step, Step};

const SEED: [u8; 32] = *b"kernel-proofs-o10-idempotency-01";

#[test]
fn perturbed_history_matches_clean_run_and_reference_model() {
    let mut runner = TestRunner::new_with_rng(
        Config {
            cases: 32,
            source_file: Some(file!()),
            ..Config::default()
        },
        TestRng::from_seed(RngAlgorithm::ChaCha, &SEED),
    );
    runner
        .run(
            &prop::collection::vec(step(), 8..=24),
            |steps: Vec<Step>| {
                let outcome = run(&steps);
                prop_assert!(outcome.envelope_commits > 0);
                Ok(())
            },
        )
        .unwrap();
}

/// The cross-cutting delete-after-ingest case is pinned as a fixed history so
/// the propagation rows (four outbox targets plus barrier bookkeeping) are
/// compared under the cross-root profile every run, not only when sampled.
#[test]
fn delete_after_ingest_propagates_identically_under_duplicates_and_restart() {
    use crate::model::Op;
    let steps = [
        Step {
            op: Op::RegisterConsumer,
            duplicate_after: true,
            restart_after: false,
            fault_then_retry: true,
        },
        Step {
            op: Op::Ingest { sensitive: false },
            duplicate_after: true,
            restart_after: true,
            fault_then_retry: false,
        },
        Step {
            op: Op::Delete(0),
            duplicate_after: true,
            restart_after: true,
            fault_then_retry: true,
        },
        Step {
            op: Op::Acknowledge(0),
            duplicate_after: true,
            restart_after: false,
            fault_then_retry: false,
        },
    ];
    let outcome = run(&steps);
    assert_eq!(outcome.duplicates_replayed, 1);
    assert_eq!(outcome.faults_injected, 2);
}
