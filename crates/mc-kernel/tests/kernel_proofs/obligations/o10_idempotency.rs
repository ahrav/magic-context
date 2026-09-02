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
                run(&steps);
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

/// A generated history may legally contain only operations that never commit an
/// envelope. Such a history still proves the cross-root and duplicate contracts,
/// so it must not be reported as a counterexample.
#[test]
fn history_without_envelope_operations_still_proves_equivalence() {
    use crate::model::Op;
    let steps = [
        Step {
            op: Op::Stage,
            duplicate_after: true,
            restart_after: false,
            fault_then_retry: true,
        },
        Step {
            op: Op::Ingest { sensitive: false },
            duplicate_after: true,
            restart_after: true,
            fault_then_retry: true,
        },
        Step {
            op: Op::RebuildAlignment,
            duplicate_after: true,
            restart_after: false,
            fault_then_retry: true,
        },
    ];
    let outcome = run(&steps);
    // None of these operations is fault-capable, so the run exercises only the
    // duplicate and restart perturbations. The counts pin that nothing faulted.
    assert_eq!(outcome.faults_injected, 0);
    assert_eq!(outcome.duplicates_replayed, 0);
}

/// A supersession replacement is itself supersedable, so the model must keep it in
/// the live target set. This pins the chain the randomized history could not reach
/// while the replacement was dropped from `admitted`.
#[test]
fn chained_supersession_replays_and_restarts_identically() {
    use crate::model::Op;
    let steps = [
        Step {
            op: Op::Stage,
            duplicate_after: false,
            restart_after: false,
            fault_then_retry: false,
        },
        Step {
            op: Op::Admit(0),
            duplicate_after: true,
            restart_after: false,
            fault_then_retry: true,
        },
        Step {
            op: Op::Supersede(0),
            duplicate_after: true,
            restart_after: true,
            fault_then_retry: true,
        },
        Step {
            op: Op::Supersede(0),
            duplicate_after: true,
            restart_after: false,
            fault_then_retry: true,
        },
    ];
    let outcome = run(&steps);
    assert_eq!(outcome.duplicates_replayed, 3);
    assert_eq!(outcome.faults_injected, 3);
}
