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
    ObjectApplicabilitySpec, RepairIntent, OBSERVATION_KIND_CURRENT, OBSERVATION_KIND_STALE,
};
use mc_store::kernel::{
    CommitIntent, DecisionPayload, DecisionSpec, DomainSpec, KernelError, KernelStore,
    ObservationDependencySpec, ObservationPayload, ObservationSpec, QueryContext,
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
        .commit_with_fault_after_events_for_test(intent("faulted-repair", '2'), {
            let spec = spec.clone();
            move |envelope: &mut mc_store::kernel::Envelope<'_>| {
                Ok(envelope.insert_observation(spec)?.result_json())
            }
        })
        .unwrap_err();
    assert_eq!(error, KernelError::Fault);
    // No observation without its event and job: everything rolled back.
    for table in ["observations", "observation_dependencies"] {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE observation_id LIKE 'obs-fault%'");
        assert_eq!(count(store_dir.path(), &sql), 0, "{table} rolled back");
    }
}

/// Two repairs racing on the same failure both reach the commit, because
/// neither can see the other's record yet. The receipt is what keeps that from
/// duplicating the observation and its deep-verification job (KTD9).
#[test]
fn duplicate_repair_replays_the_receipt_without_new_rows() {
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
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);
    // Both attempts carry the intent built against an empty durable history,
    // which is what two racing repairs each hold.
    let intent_record =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], None, "test", 42).unwrap();
    let first = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &intent_record,
        &EvalBudget::unbounded(),
    )
    .unwrap();
    assert!(matches!(
        first,
        AppendOutcome::Landed {
            replayed: false,
            ..
        }
    ));
    let second = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &intent_record,
        &EvalBudget::unbounded(),
    )
    .unwrap();
    assert!(
        matches!(second, AppendOutcome::Landed { replayed: true, .. }),
        "the second attempt replays the receipt, got {second:?}"
    );
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

/// A verdict the durable record already states needs no append, so the repair
/// pass does not take the writer at all. The engine's append-confirmed flag is
/// per process; this reconciliation is what a second process relies on.
#[test]
fn an_already_recorded_verdict_skips_the_commit() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    let first = ApplicabilityEngine::new()
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
    let tip_after_first = store.known_as_of(0).unwrap().tip;

    // A second engine — a different process, empty caches — reaches the same
    // stale verdict the record already holds.
    let second = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(second.objects[0].state, ApplicabilityState::Stale);
    assert!(
        second.appends.is_empty(),
        "no append is attempted, got {:?}",
        second.appends
    );
    assert_eq!(
        store.known_as_of(0).unwrap().tip,
        tip_after_first,
        "no commit means no new commit sequence"
    );
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        1
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
    let intent_record =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], None, "test", 42)
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
    let intent_record =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], None, "test", 42).unwrap();

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
    assert_eq!(error, KernelError::FutureSnapshot);
}

fn text(store_root: &std::path::Path, sql: &str) -> String {
    let connection = Connection::open_with_flags(
        store_root.join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Candidate whose check fails while `src/feature.rs` is absent and passes
/// once it exists, so one fixture drives a stale/clear/stale sequence.
fn feature_candidate(object_id: &str) -> ApplicabilityCandidate {
    ApplicabilityCandidate {
        object_id: object_id.to_string(),
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
    }
}

/// Returning to a state that already failed reproduces the earlier HEAD,
/// dirty fingerprint, object revision, and failed check, so the dedup key
/// repeats unless the repair generation advances across the clear.
#[test]
fn refailure_after_a_clear_appends_instead_of_replaying_the_pre_clear_receipt() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];

    // State A: the checked file is absent, so a stale block lands.
    let first = ApplicabilityEngine::new()
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

    // State B: the file appears and a clearing observation lands.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let cleared = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(cleared.objects[0].state, ApplicabilityState::Current);
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        !store
            .applicability_block_state(
                TARGET_OBJECT,
                snapshot.identity(),
                store.known_as_of(0).unwrap().tip
            )
            .unwrap()
            .expect("clearing observation recorded")
            .blocked
    );

    // Back to state A, in a process whose classification cache is empty.
    std::fs::remove_file(repo_dir.path().join("src/feature.rs")).unwrap();
    let refailed = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(refailed.objects[0].state, ApplicabilityState::Stale);
    assert!(
        matches!(
            refailed.appends[0].1,
            AppendOutcome::Landed {
                replayed: false,
                ..
            }
        ),
        "the re-failure appends a fresh record, got {:?}",
        refailed.appends[0].1
    );
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("block recorded again");
    assert!(block.blocked, "the durable block returns with the failure");
    assert_eq!(block.observation_kind, OBSERVATION_KIND_STALE);
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        3,
        "stale, clear, stale"
    );
}

/// A repair payload carries evidence derived from its target, so it takes the
/// target's domain and sensitivity rather than the caller's.
#[test]
fn repair_inherits_the_target_domain_and_sensitivity() {
    const OTHER_DOMAIN: &str = "other-domain";
    const SENSITIVE_TARGET: &str = "sensitive-target";
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    store
        .commit(intent("other-domain", '4'), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: OTHER_DOMAIN.to_string(),
                object_id: "other-domain-object".to_string(),
                name: "other".to_string(),
                source_kind: "fixture".to_string(),
                source_id: OTHER_DOMAIN.to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            envelope.insert_decision(DecisionSpec {
                decision_id: "decision-2".to_string(),
                object_id: SENSITIVE_TARGET.to_string(),
                domain_id: OTHER_DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                decision_kind: "adr".to_string(),
                payload: DecisionPayload {
                    summary: "sensitive target".to_string(),
                    rationale: "fixture".to_string(),
                },
                source_kind: "fixture".to_string(),
                source_id: "decision-2".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Sensitive,
            })?;
            Ok(String::new())
        })
        .unwrap();

    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(SENSITIVE_TARGET)];
    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(matches!(report.appends[0].1, AppendOutcome::Landed { .. }));

    let observation = "SELECT observation_id FROM observations
                       WHERE observation_kind LIKE 'applicability.%'";
    let observation_id = text(store_dir.path(), observation);
    assert_eq!(
        text(
            store_dir.path(),
            &format!(
                "SELECT sensitivity_class FROM observations
                 WHERE observation_id='{observation_id}'"
            )
        ),
        "sensitive",
        "the observation follows the target's class, not the hard-coded normal"
    );
    assert_eq!(
        text(
            store_dir.path(),
            &format!(
                "SELECT domain_id FROM object_registry r
                 JOIN observations o ON o.object_id = r.object_id
                 WHERE o.observation_id='{observation_id}'"
            )
        ),
        OTHER_DOMAIN,
        "the repair is accounted to the target's domain"
    );
    // The identifier carries the whole dedup key: a truncation would trade
    // collision-free primary keys for shorter rows.
    assert_eq!(observation_id.len(), "applicability-".len() + 64);
}

/// A corrupt latest record must not reduce to an older `applicability.current`
/// or to "no block recorded", either of which lets a failing object inject.
#[test]
fn corrupt_latest_observation_payload_fails_the_reducer_closed() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();

    let connection = Connection::open(store_dir.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations SET observation_payload=X'00'
             WHERE observation_kind LIKE 'applicability.%'",
            [],
        )
        .unwrap();
    drop(connection);

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let error = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap_err();
    assert_eq!(error, KernelError::CorruptCanonicalRow);
}

/// Holds the writer so a deadline-bounded repair cannot commit, and returns
/// once the writer is actually held.
fn hold_writer<'scope>(
    threads: &'scope std::thread::Scope<'scope, '_>,
    store: &'scope KernelStore,
    held: &'scope std::sync::Barrier,
    domain_id: &'static str,
    duration: Duration,
) {
    threads.spawn(move || {
        store
            .commit(intent(domain_id, '7'), |envelope| {
                envelope.insert_domain(DomainSpec {
                    domain_id: domain_id.to_string(),
                    object_id: format!("{domain_id}-object"),
                    name: "hold".to_string(),
                    source_kind: "fixture".to_string(),
                    source_id: domain_id.to_string(),
                    source_revision: 1,
                    sensitivity: Sensitivity::Normal,
                })?;
                held.wait();
                std::thread::sleep(duration);
                Ok(String::new())
            })
            .unwrap();
    });
    held.wait();
}

/// The clearing append is what lifts a durable block. When it cannot land,
/// every other reader still sees the block, so this request cannot label the
/// object current and auto-inject it.
///
/// Holding the writer past the retrieval deadline also proves the repair stops
/// at its own bound: `Mutex::lock` has no timeout, so acquiring the writer
/// without one would return `DeadlineMissed` only after the holder finished.
#[test]
fn a_clearing_append_that_cannot_commit_leaves_the_object_uncertain() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");

    let held = std::sync::Barrier::new(2);
    let started = Instant::now();
    let report = std::thread::scope(|threads| {
        hold_writer(
            threads,
            &store,
            &held,
            "hold-domain",
            Duration::from_millis(1_500),
        );
        let budget = EvalBudget::new(
            Some(Instant::now() + Duration::from_millis(200)),
            Default::default(),
        );
        let report = ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &budget,
            )
            .unwrap();
        (report, started.elapsed())
    });
    let (report, elapsed) = report;
    assert_eq!(report.appends[0].1, AppendOutcome::DeadlineMissed);
    assert_eq!(report.objects[0].state, ApplicabilityState::Uncertain);
    assert!(
        report.auto_injectable().next().is_none(),
        "an object whose block was not cleared must not auto-inject"
    );
    assert!(
        elapsed < Duration::from_millis(1_400),
        "the repair returned at its own deadline rather than at the holder's, took {elapsed:?}"
    );
}

/// The repair pass commits per object, so an expired deadline has to stop the
/// batch instead of attempting a commit for every remaining object.
#[test]
fn the_repair_pass_stops_when_the_deadline_expires_mid_batch() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    store
        .commit(intent("second-target", '5'), |envelope| {
            envelope.insert_decision(DecisionSpec {
                decision_id: "decision-3".to_string(),
                object_id: "second-target".to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                decision_kind: "adr".to_string(),
                payload: DecisionPayload {
                    summary: "second".to_string(),
                    rationale: "fixture".to_string(),
                },
                source_kind: "fixture".to_string(),
                source_id: "decision-3".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();

    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [
        feature_candidate(TARGET_OBJECT),
        feature_candidate("second-target"),
    ];
    let held = std::sync::Barrier::new(2);
    let report = std::thread::scope(|threads| {
        hold_writer(
            threads,
            &store,
            &held,
            "stop-domain",
            Duration::from_millis(1_500),
        );
        let budget = EvalBudget::new(
            Some(Instant::now() + Duration::from_millis(200)),
            Default::default(),
        );
        ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &budget,
            )
            .unwrap()
    });
    assert_eq!(
        report.objects.len(),
        2,
        "every candidate still gets a label"
    );
    assert_eq!(
        report.appends.len(),
        1,
        "the first append consumed the deadline, so the second is not attempted"
    );
    assert_eq!(report.appends[0].1, AppendOutcome::DeadlineMissed);
}

/// A worktree edit between the snapshot and the commit leaves the recorded
/// fingerprint describing the snapshot rather than the committed worktree.
/// The record is evidence as observed, and the next evaluation snapshots the
/// changed worktree, derives a different dedup key, and supersedes it — so the
/// reducer converges without an unbounded worktree walk inside the writer.
#[test]
fn a_worktree_edit_after_the_snapshot_is_superseded_by_the_next_evaluation() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &snapshot,
        &query,
        &scope,
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);

    // The check's file appears while the repair waits for the writer.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let intent_record =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], None, "test", 42).unwrap();
    let outcome = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &intent_record,
        &EvalBudget::unbounded(),
    )
    .unwrap();
    assert!(matches!(outcome, AppendOutcome::Landed { .. }));
    let stale_as_of = store.known_as_of(0).unwrap().tip;

    // The next evaluation snapshots the changed worktree and clears the block.
    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(report.objects[0].state, ApplicabilityState::Current);
    let current = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        store
            .applicability_block_state(TARGET_OBJECT, current.identity(), stale_as_of)
            .unwrap()
            .expect("the snapshot-time record is visible at its own commit")
            .blocked
    );
    assert!(
        !store
            .applicability_block_state(
                TARGET_OBJECT,
                current.identity(),
                store.known_as_of(0).unwrap().tip
            )
            .unwrap()
            .expect("the superseding record is visible at the tip")
            .blocked
    );
}

/// One engine, one cache. A confirmed stale append, a clear, then a return to
/// the failing state hits the cached stale entry whose append is already marked
/// confirmed — so the flag cannot be what decides whether repair runs, or the
/// durable block would stay lifted while the object reads stale in-request.
#[test]
fn a_confirmed_cache_entry_still_repairs_after_a_clear() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    // One engine for every step, so the cache carries across them.
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];
    let evaluate = || {
        engine
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &EvalBudget::unbounded(),
            )
            .unwrap()
    };

    let blocked = evaluate();
    assert_eq!(blocked.objects[0].state, ApplicabilityState::Stale);
    assert!(matches!(
        blocked.appends[0].1,
        AppendOutcome::Landed {
            replayed: false,
            ..
        }
    ));

    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let cleared = evaluate();
    assert_eq!(cleared.objects[0].state, ApplicabilityState::Current);
    assert!(matches!(cleared.appends[0].1, AppendOutcome::Landed { .. }));

    // Back to the failing state: identical HEAD, dirty fingerprint, revision
    // and check, so this is a hit on the entry from the first evaluation.
    std::fs::remove_file(repo_dir.path().join("src/feature.rs")).unwrap();
    let refailed = evaluate();
    assert_eq!(refailed.objects[0].state, ApplicabilityState::Stale);
    assert!(
        refailed.stats.object_cache_hits >= 1,
        "the third evaluation reuses the cached stale verdict"
    );
    assert!(
        matches!(
            refailed.appends.first(),
            Some((_, AppendOutcome::Landed { .. }))
        ),
        "the cached verdict still repairs, got {:?}",
        refailed.appends
    );
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        store
            .applicability_block_state(
                TARGET_OBJECT,
                snapshot.identity(),
                store.known_as_of(0).unwrap().tip
            )
            .unwrap()
            .expect("the block is recorded again")
            .blocked,
        "the durable block returns with the failure"
    );
}

/// The deadline can expire before the pass reaches every object. An object it
/// never reached must not keep a current label while its block stands.
#[test]
fn objects_the_repair_pass_never_reached_do_not_stay_current() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    store
        .commit(intent("blocked-second", '6'), |envelope| {
            envelope.insert_decision(DecisionSpec {
                decision_id: "decision-4".to_string(),
                object_id: "second-blocked".to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                decision_kind: "adr".to_string(),
                payload: DecisionPayload {
                    summary: "second".to_string(),
                    rationale: "fixture".to_string(),
                },
                source_kind: "fixture".to_string(),
                source_id: "decision-4".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();

    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [
        feature_candidate(TARGET_OBJECT),
        feature_candidate("second-blocked"),
    ];
    // Record a durable block for both objects while the file is absent.
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    // Both now classify current, so both need their blocks cleared.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");

    let held = std::sync::Barrier::new(2);
    let report = std::thread::scope(|threads| {
        hold_writer(
            threads,
            &store,
            &held,
            "unreached-domain",
            Duration::from_millis(1_500),
        );
        let budget = EvalBudget::new(
            Some(Instant::now() + Duration::from_millis(200)),
            Default::default(),
        );
        ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &budget,
            )
            .unwrap()
    });
    assert_eq!(
        report.appends.len(),
        1,
        "the first append consumed the deadline"
    );
    for object in &report.objects {
        assert_eq!(
            object.state,
            ApplicabilityState::Uncertain,
            "{} kept a current label with its block standing",
            object.object_id
        );
    }
    assert!(report.auto_injectable().next().is_none());
}

/// End to end over the committed row: a check path carrying secret-shaped and
/// JSON-punctuation bytes still produces a payload the reducer decodes. The
/// pre-redaction and bound that keep it that way are proven in the unit tests
/// beside `evidence_for_payload`.
#[test]
fn a_secret_shaped_check_path_leaves_the_stored_payload_decodable() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    // The checked path reaches the evidence string verbatim.
    let candidates = [ApplicabilityCandidate {
        object_id: TARGET_OBJECT.to_string(),
        object_revision: 1,
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/AKIAIOSFODNN7EXAMPLE/\"quoted\"/{brace}.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..ApplicabilityCandidate::default()
    }];
    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(matches!(report.appends[0].1, AppendOutcome::Landed { .. }));

    // The reducer decodes the committed document rather than failing closed on
    // a payload redaction rewrote.
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("the stored payload still decodes");
    assert!(block.blocked);
}

/// The reducer takes a reader connection, and `Mutex::lock` has no timeout, so
/// a held pool could carry a bounded evaluation past its deadline before the
/// scan reached its first poll.
#[test]
fn a_held_reader_pool_does_not_outlast_the_evaluation_deadline() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    let started = Instant::now();
    let (report, elapsed) = std::thread::scope(|threads| {
        threads.spawn(|| store.hold_readers_for_test(Duration::from_millis(1_500)));
        // Give the holder the whole pool before the bounded evaluation starts.
        std::thread::sleep(Duration::from_millis(50));
        let budget = EvalBudget::new(
            Some(Instant::now() + Duration::from_millis(200)),
            Default::default(),
        );
        let report = ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &budget,
            )
            .unwrap();
        (report, started.elapsed())
    });
    assert!(
        elapsed < Duration::from_millis(1_400),
        "the evaluation returned at its own deadline rather than at the holder's, took {elapsed:?}"
    );
    // A deadline is a domain outcome: the batch still carries labels.
    assert_eq!(report.objects.len(), 1);
    assert!(report.appends.is_empty());
}

/// Alignment is derived from `implements` dependencies alone, and an
/// applicability observation carries only `applicability_target`. Rebuilding for
/// one loads and decodes every decision and observation in the store while the
/// writer is held, which every retrieval-time repair would otherwise pay.
#[test]
fn a_repair_commit_does_not_rebuild_the_alignment_projection() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    let generation = "SELECT COALESCE((SELECT built_through_commit_seq
                       FROM alignment_projection_state WHERE singleton=1),0)";
    let before = count(store_dir.path(), generation);
    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    let AppendOutcome::Landed { commit_seq, .. } = report.appends[0].1 else {
        panic!("expected a landed append, got {:?}", report.appends[0].1);
    };
    assert_eq!(
        count(store_dir.path(), generation),
        before,
        "the repair commit left the projection generation where it was"
    );
    assert!(
        commit_seq > before,
        "the repair did commit, at {commit_seq}, past generation {before}"
    );
}

/// The narrowing is specific to dependencies alignment does not read: an
/// observation carrying `implements` still rebuilds.
#[test]
fn an_implements_observation_still_rebuilds_the_alignment_projection() {
    let store_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let generation = "SELECT COALESCE((SELECT built_through_commit_seq
                       FROM alignment_projection_state WHERE singleton=1),0)";
    let before = count(store_dir.path(), generation);
    let receipt = store
        .commit(intent("implements-observation", '8'), |envelope| {
            envelope.insert_observation(ObservationSpec {
                observation_id: "obs-implements".to_string(),
                object_id: "obs-implements-object".to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                observation_kind: "state".to_string(),
                payload: ObservationPayload {
                    summary: "implements the target".to_string(),
                    classification: "implemented".to_string(),
                    detail: None,
                },
                observed_at: 1,
                dependencies: vec![ObservationDependencySpec {
                    dependency_object_id: TARGET_OBJECT.to_string(),
                    dependency_kind: "implements".to_string(),
                    dependency_payload: None,
                }],
                source_kind: "fixture".to_string(),
                source_id: "obs-implements".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        count(store_dir.path(), generation),
        receipt.commit_seq,
        "an alignment-bearing insert advances the projection generation"
    );
    assert!(receipt.commit_seq > before);
}

/// The checkout identity is a filesystem path. The slice redacts the payload
/// document as one text field, so a path segment shaped like a secret would be
/// rewritten inside the stored payload while the reducer compared against the
/// caller's original path — and the block would never match its own checkout.
#[test]
fn a_secret_shaped_checkout_path_still_matches_its_own_block() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_root = tempfile::tempdir().unwrap();
    // The identity is the resolved `.git` directory, so the secret-shaped
    // segment has to be in the path itself.
    let repo_dir = repo_root.path().join("password=hunter-two");
    std::fs::create_dir(&repo_dir).unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(&repo_dir);
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(&repo_dir, &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(matches!(report.appends[0].1, AppendOutcome::Landed { .. }));

    let snapshot = snapshot_checkout(&repo_dir, &EvalBudget::unbounded()).unwrap();
    assert!(
        snapshot.identity().contains("password="),
        "the fixture identity carries the secret-shaped segment: {}",
        snapshot.identity()
    );
    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("the block matches the checkout that recorded it");
    assert!(block.blocked);
}

/// A checkout that moves while the same check keeps failing is new evidence for
/// deep verification, so the repair still appends. Matching only the observation
/// kind would suppress it and leave the outbox job describing the old state.
#[test]
fn a_moved_head_with_the_same_failure_still_appends() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];
    let evaluate = || {
        ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &EvalBudget::unbounded(),
            )
            .unwrap()
    };

    let first = evaluate();
    assert!(matches!(
        first.appends[0].1,
        AppendOutcome::Landed {
            replayed: false,
            ..
        }
    ));

    // HEAD advances; the checked file is still absent, so the verdict is stale
    // again — at a checkout state the recorded observation does not describe.
    let moved = commit_snapshot(
        &fixture.repo,
        "moved",
        &[tip],
        &[
            ("src/lib.rs", "pub fn a() {}\n"),
            ("src/other.rs", "moved\n"),
        ],
        "moved",
        2,
    );
    set_head_detached(&fixture.repo, moved);
    materialize(&fixture.repo, moved);

    let second = evaluate();
    assert_eq!(second.objects[0].state, ApplicabilityState::Stale);
    assert!(
        matches!(
            second.appends.first(),
            Some((
                _,
                AppendOutcome::Landed {
                    replayed: false,
                    ..
                }
            ))
        ),
        "the moved checkout appends its own evidence, got {:?}",
        second.appends
    );
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM observations WHERE observation_kind LIKE 'applicability.%'"
        ),
        2,
        "one record per failing checkout state"
    );
    assert_eq!(
        count(
            store_dir.path(),
            "SELECT COUNT(*) FROM outbox o JOIN observations obs ON obs.object_id = o.object_id"
        ),
        2,
        "deep verification is scheduled for each"
    );
}

/// A check path past the redactor's input limit does not resolve, so the verdict
/// is uncertain and no append is attempted. The veto still holds and the
/// evaluation still returns a report rather than a store error.
#[test]
fn an_unresolvable_oversized_check_path_still_vetoes() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [ApplicabilityCandidate {
        object_id: TARGET_OBJECT.to_string(),
        object_revision: 1,
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    // Past mc_secret_scanner::MAX_INPUT_BYTES.
                    path: format!("src/{}.rs", "a".repeat(600 * 1024)),
                }],
            )
            .encode(),
        ),
        ..ApplicabilityCandidate::default()
    }];

    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(
        report.objects[0].state.blocks_auto_injection(),
        "the veto still holds, got {:?}",
        report.objects[0].state
    );
    assert!(report.auto_injectable().next().is_none());
}
