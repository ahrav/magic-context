//! Read-repair proofs: durable applicability observations, atomicity under
//! fault injection, dedup via receipts, deadline-missed retry, and the
//! injection-block reducer across restarts.

#![cfg(feature = "test-support")]

#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::time::{Duration, Instant};

use git_fixtures::{commit_snapshot, init_repo, materialize, set_head_detached, FixtureRepo};
use mc_store::kernel::applicability::{
    commit_read_repair, snapshot_checkout, AppendOutcome, ApplicabilityCandidate,
    ApplicabilityEngine, ApplicabilityRequest, ApplicabilityState, CheckSpec, EvalBudget,
    ObjectApplicabilitySpec, PriorBlockState, RepairIntent, OBSERVATION_KIND_CURRENT,
    OBSERVATION_KIND_STALE,
};
use mc_store::kernel::{
    CommitFault, CommitIntent, DecisionPayload, DecisionSpec, DomainSpec, KernelErrorKind,
    KernelStore, ObservationDependencySpec, ObservationPayload, ObservationSpec, QueryContext,
    ScopeMatchContext, Sensitivity,
};
use rusqlite::{Connection, OpenFlags};

const TARGET_OBJECT: &str = "target-object";
const DOMAIN: &str = "domain";

fn intent(key: &str, digest: char) -> CommitIntent {
    CommitIntent {
        producer: "read-repair-test".to_string(),
        operation_key: key.to_string(),
        request_digest: digest.to_string().repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn seed_store(root: &std::path::Path) -> KernelStore {
    let store = KernelStore::open(root).unwrap();
    store
        .commit(intent("domain", '0'), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: DOMAIN.to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("target", '1'), |envelope| {
            envelope.insert_decision(DecisionSpec {
                decision_id: "decision-1".to_string(),
                object_id: TARGET_OBJECT.to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                decision_kind: "adr".to_string(),
                payload: DecisionPayload {
                    summary: "target".to_string(),
                    rationale: "fixture".to_string(),
                },
                source_kind: "fixture".to_string(),
                source_id: "decision-1".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    store
}

fn seeded_checkout(dir: &std::path::Path) -> (FixtureRepo, gix::ObjectId) {
    let fixture = init_repo(dir);
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n")],
        "seed",
        1,
    );
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    (fixture, tip)
}

/// Candidate whose file-existence check fails against the fixture checkout.
fn failing_candidate() -> ApplicabilityCandidate {
    ApplicabilityCandidate {
        object_id: TARGET_OBJECT.to_string(),
        object_revision: 1,
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/removed.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..ApplicabilityCandidate::default()
    }
}

fn request<'a>(
    checkout: &'a std::path::Path,
    query: &'a QueryContext,
    scope: &'a ScopeMatchContext,
    candidates: &'a [ApplicabilityCandidate],
) -> ApplicabilityRequest<'a> {
    ApplicabilityRequest {
        checkout_path: checkout,
        query,
        scope_context: scope,
        candidates,
        domain_id: DOMAIN,
        actor: "test",
        observed_at: 42,
    }
}

fn count(store_root: &std::path::Path, sql: &str) -> i64 {
    let connection = Connection::open_with_flags(
        store_root.join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn failed_check_appends_observation_event_and_job_in_one_commit() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();

    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];
    let report = engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();

    // AE5: the object is vetoed in this request, independent of the append.
    assert_eq!(report.objects[0].state, ApplicabilityState::Stale);
    assert!(report.auto_injectable().next().is_none());
    let (object_id, outcome) = &report.appends[0];
    assert_eq!(object_id, TARGET_OBJECT);
    let AppendOutcome::Landed {
        commit_seq,
        replayed,
    } = outcome
    else {
        panic!("expected landed append, got {outcome:?}");
    };
    assert!(!replayed);

    // Observation, change event, and outbox job share one commit.
    let observations = format!(
        "SELECT COUNT(*) FROM observations WHERE observation_kind='{OBSERVATION_KIND_STALE}'
         AND created_commit_seq={commit_seq}"
    );
    assert_eq!(count(store_dir.path(), &observations), 1);
    let events = format!("SELECT COUNT(*) FROM change_event WHERE commit_seq={commit_seq}");
    assert_eq!(count(store_dir.path(), &events), 1);
    let jobs = format!("SELECT COUNT(*) FROM outbox WHERE commit_seq={commit_seq}");
    assert_eq!(count(store_dir.path(), &jobs), 1);

    // The reducer blocks the object at the new tip.
    let tip = store.known_as_of(0).unwrap().tip;
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(TARGET_OBJECT, snapshot.identity(), tip)
        .unwrap()
        .expect("block recorded");
    assert!(block.blocked);
    assert_eq!(block.observation_kind, OBSERVATION_KIND_STALE);
}

#[test]
fn recorded_block_survives_daemon_restart() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    {
        let store = seed_store(store_dir.path());
        let engine = ApplicabilityEngine::new();
        let query = QueryContext::default();
        let scope = ScopeMatchContext::new();
        let candidates = [failing_candidate()];
        engine
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &EvalBudget::unbounded(),
            )
            .unwrap();
    }
    // AE6: reopen the store — a fresh process with fresh (empty) caches.
    let store = KernelStore::open(store_dir.path()).unwrap();
    let tip = store.known_as_of(0).unwrap().tip;
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(TARGET_OBJECT, snapshot.identity(), tip)
        .unwrap()
        .expect("block persisted");
    assert!(block.blocked);
}

#[test]
fn partial_commit_rolls_back_completely_under_fault_injection() {
    let store_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let spec = ObservationSpec {
        observation_id: "obs-fault".to_string(),
        object_id: "obs-fault-object".to_string(),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: OBSERVATION_KIND_STALE.to_string(),
        payload: ObservationPayload {
            summary: "faulted".to_string(),
            classification: OBSERVATION_KIND_STALE.to_string(),
            detail: Some("{}".to_string()),
        },
        observed_at: 1,
        dependencies: vec![ObservationDependencySpec {
            dependency_object_id: TARGET_OBJECT.to_string(),
            dependency_kind: "applicability_target".to_string(),
            dependency_payload: None,
        }],
        source_kind: "fixture".to_string(),
        source_id: "obs-fault".to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    };
    let error = store
        .commit_with_fault_for_test(intent("faulted-repair", '2'), CommitFault::AfterEvents, {
            let spec = spec.clone();
            move |envelope| Ok(envelope.insert_observation(spec)?.result_json())
        })
        .unwrap_err();
    assert_eq!(error.kind(), KernelErrorKind::Fault);
    // No observation without its event and job: everything rolled back.
    for table in ["observations", "observation_dependencies"] {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE observation_id LIKE 'obs-fault%'");
        assert_eq!(count(store_dir.path(), &sql), 0, "{table} rolled back");
    }
}

#[test]
fn duplicate_repair_replays_the_receipt_without_new_rows() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    let first_engine = ApplicabilityEngine::new();
    let first = first_engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(matches!(
        first.appends[0].1,
        AppendOutcome::Landed {
            replayed: false,
            ..
        }
    ));

    // A second engine (fresh caches — a different process) evaluates the
    // same failure: the same dedup identity replays the receipt.
    let second_engine = ApplicabilityEngine::new();
    let second = second_engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(matches!(
        second.appends[0].1,
        AppendOutcome::Landed { replayed: true, .. }
    ));
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        1,
        "observations stay append-only with no duplicates"
    );
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM outbox o JOIN observations obs
             ON obs.object_id = o.object_id"
        ),
        1,
        "exactly one outbox job for the repair"
    );
}

#[test]
fn deadline_missed_append_retries_on_the_next_evaluation() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    // Classify with a healthy budget, then attempt the append with an
    // expired one: the veto already happened, the append reports the miss.
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &snapshot,
        &query,
        &scope,
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);
    let intent_record = RepairIntent::for_classification(
        &snapshot,
        &batch.objects[0],
        DOMAIN,
        "test",
        42,
        PriorBlockState(None),
    )
    .expect("stale classifications build repair intents");
    let expired = EvalBudget::new(
        Some(Instant::now() - Duration::from_millis(1)),
        Default::default(),
    );
    let outcome = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &intent_record,
        &expired,
    )
    .unwrap();
    assert_eq!(outcome, AppendOutcome::DeadlineMissed);
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        0
    );

    // Next evaluation: cache hit with the append-confirmed flag unset →
    // the durable record lands before the object could auto-inject again.
    let report = engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(report.stats.object_cache_hits >= 1);
    assert!(matches!(
        report.appends[0].1,
        AppendOutcome::Landed {
            replayed: false,
            ..
        }
    ));
}

#[test]
fn moved_head_between_snapshot_and_commit_discards_the_repair() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &snapshot,
        &query,
        &scope,
        &candidates,
        &EvalBudget::unbounded(),
    );
    let intent_record = RepairIntent::for_classification(
        &snapshot,
        &batch.objects[0],
        DOMAIN,
        "test",
        42,
        PriorBlockState(None),
    )
    .unwrap();

    // The checkout moves between snapshot and commit.
    let moved = commit_snapshot(
        &fixture.repo,
        "moved",
        &[tip],
        &[("src/lib.rs", "pub fn a() {}\n"), ("new.rs", "moved\n")],
        "moved",
        2,
    );
    set_head_detached(&fixture.repo, moved);

    let outcome = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &intent_record,
        &EvalBudget::unbounded(),
    )
    .unwrap();
    assert_eq!(outcome, AppendOutcome::Discarded);
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        0,
        "nothing durable written for a moved checkout"
    );
}

#[test]
fn passing_reevaluation_clears_the_block_bitemporally() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();

    // Record the stale block: the object's checked file is absent.
    let failing = [ApplicabilityCandidate {
        object_id: TARGET_OBJECT.to_string(),
        object_revision: 1,
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/feature.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..ApplicabilityCandidate::default()
    }];
    engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &failing),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    let blocked_as_of = store.known_as_of(0).unwrap().tip;

    // The file appears (content change → new dirty fingerprint → no stale
    // cache entry) and re-evaluation passes: a clearing observation lands.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let report = engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &failing),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(report.objects[0].state, ApplicabilityState::Current);
    assert!(matches!(
        report.appends.first(),
        Some((_, AppendOutcome::Landed { .. }))
    ));
    let cleared_as_of = store.known_as_of(0).unwrap().tip;
    assert!(cleared_as_of > blocked_as_of);

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    // R16 bitemporal correctness: the earlier known_as_of still sees the
    // block, the later one sees it lifted.
    let earlier = store
        .applicability_block_state(TARGET_OBJECT, snapshot.identity(), blocked_as_of)
        .unwrap()
        .expect("historical block visible");
    assert!(earlier.blocked);
    let later = store
        .applicability_block_state(TARGET_OBJECT, snapshot.identity(), cleared_as_of)
        .unwrap()
        .expect("clearing observation visible");
    assert!(!later.blocked);
    assert_eq!(later.observation_kind, OBSERVATION_KIND_CURRENT);
}

#[test]
fn future_known_as_of_is_a_typed_error() {
    let store_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let error = store
        .applicability_block_state(TARGET_OBJECT, "checkout", i64::MAX)
        .unwrap_err();
    assert_eq!(error.kind(), KernelErrorKind::FutureSnapshot);
}

#[test]
fn refailure_after_a_clear_restores_the_durable_block() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let failing = [ApplicabilityCandidate {
        object_id: TARGET_OBJECT.to_string(),
        object_revision: 1,
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/feature.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..ApplicabilityCandidate::default()
    }];

    // Fail → clear → fail again, returning to the exact same worktree
    // state as the first failure.
    engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &failing),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &failing),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    std::fs::remove_file(fixture.repo.workdir().unwrap().join("src/feature.rs")).unwrap();
    let refail = engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &failing),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(refail.objects[0].state, ApplicabilityState::Stale);
    assert!(
        matches!(
            refail.appends[0].1,
            AppendOutcome::Landed {
                replayed: false,
                ..
            }
        ),
        "a re-failure after a clear appends fresh instead of replaying the pre-clear receipt: {:?}",
        refail.appends[0].1
    );
    let tip = store.known_as_of(0).unwrap().tip;
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(TARGET_OBJECT, snapshot.identity(), tip)
        .unwrap()
        .expect("block re-recorded");
    assert!(
        block.blocked,
        "the durable block is restored after the clear"
    );
}

#[test]
fn blocks_are_scoped_to_the_recording_checkout() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];
    engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    let tip = store.known_as_of(0).unwrap().tip;
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        store
            .applicability_block_state(TARGET_OBJECT, snapshot.identity(), tip)
            .unwrap()
            .unwrap()
            .blocked
    );
    // A different worktree of the same project sees no recorded block.
    assert!(store
        .applicability_block_state(TARGET_OBJECT, "/some/other/worktree/.git", tip)
        .unwrap()
        .is_none());
    // An object without observations has no recorded block.
    assert!(store
        .applicability_block_state("never-evaluated", snapshot.identity(), tip)
        .unwrap()
        .is_none());
    // Negative snapshots are typed errors.
    assert_eq!(
        store
            .applicability_block_state(TARGET_OBJECT, snapshot.identity(), -1)
            .unwrap_err()
            .kind(),
        KernelErrorKind::InvalidInput
    );
}

#[test]
fn superseded_object_revision_discards_the_repair() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &snapshot,
        &query,
        &scope,
        &candidates,
        &EvalBudget::unbounded(),
    );
    let intent_record = RepairIntent::for_classification(
        &snapshot,
        &batch.objects[0],
        DOMAIN,
        "test",
        42,
        PriorBlockState(None),
    )
    .unwrap();
    // The target object is retired between classification and commit; the
    // revision CAS must discard the repair.
    store
        .commit(intent("retire-target", '4'), |envelope| {
            envelope.retire_decision(TARGET_OBJECT)?;
            Ok(String::new())
        })
        .unwrap();
    let outcome = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &intent_record,
        &EvalBudget::unbounded(),
    )
    .unwrap();
    assert_eq!(outcome, AppendOutcome::Discarded);
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        0
    );
}
