//! Read-repair proofs: durable applicability observations, atomicity under
//! fault injection, dedup via receipts, deadline-missed retry, and the
//! injection-block reducer across restarts.

#![cfg(feature = "test-support")]

#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::time::{Duration, Instant};

use git_fixtures::{commit_snapshot, init_repo, materialize, set_head_detached, FixtureRepo};
use mc_store::kernel::applicability::{
    checkout_identity_digest, commit_read_repair, snapshot_checkout, AppendOutcome,
    ApplicabilityCandidate, ApplicabilityEngine, ApplicabilityObservationPayload,
    ApplicabilityRequest, ApplicabilityState, BlockState, CheckSpec, EvalBudget,
    ObjectApplicabilitySpec, RepairIntent, DEPENDENCY_KIND_TARGET,
    OBSERVATION_APPLICABILITY_SCHEMA, OBSERVATION_KIND_CURRENT, OBSERVATION_KIND_STALE,
    PATCH_ID_ALGORITHM,
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
    let (object_id, outcome) = report.appends().next().expect("one append");
    assert!(
        !report.objects[0].append_pending,
        "a landed append leaves nothing outstanding"
    );
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
        *first.appends().next().expect("an append").1,
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
        second.appends().next().is_none(),
        "no append is attempted, got {:?}",
        second.appends().collect::<Vec<_>>()
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
        *report.appends().next().expect("an append").1,
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
        report.appends().collect::<Vec<_>>().first(),
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
        *first.appends().next().expect("an append").1,
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
            *refailed.appends().next().expect("an append").1,
            AppendOutcome::Landed {
                replayed: false,
                ..
            }
        ),
        "the re-failure appends a fresh record, got {:?}",
        *refailed.appends().next().expect("an append").1
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
    assert!(matches!(
        *report.appends().next().expect("an append").1,
        AppendOutcome::Landed { .. }
    ));

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
    assert_eq!(
        *report.appends().next().expect("an append").1,
        AppendOutcome::DeadlineMissed
    );
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
        report.appends().count(),
        1,
        "the first append consumed the deadline, so the second is not attempted"
    );
    assert_eq!(
        *report.appends().next().expect("an append").1,
        AppendOutcome::DeadlineMissed
    );
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
        *blocked.appends().next().expect("an append").1,
        AppendOutcome::Landed {
            replayed: false,
            ..
        }
    ));

    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let cleared = evaluate();
    assert_eq!(cleared.objects[0].state, ApplicabilityState::Current);
    assert!(matches!(
        *cleared.appends().next().expect("an append").1,
        AppendOutcome::Landed { .. }
    ));

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
            refailed.appends().collect::<Vec<_>>().first(),
            Some((_, AppendOutcome::Landed { .. }))
        ),
        "the cached verdict still repairs, got {:?}",
        refailed.appends().collect::<Vec<_>>()
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
        report.appends().count(),
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
    assert!(matches!(
        *report.appends().next().expect("an append").1,
        AppendOutcome::Landed { .. }
    ));

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

#[test]
fn an_empty_batch_does_not_wait_for_the_store() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();

    let started = Instant::now();
    let (report, elapsed) = std::thread::scope(|threads| {
        threads.spawn(|| store.hold_readers_for_test(Duration::from_millis(1_500)));
        std::thread::sleep(Duration::from_millis(50));
        let budget = EvalBudget::new(
            Some(Instant::now() + Duration::from_secs(1)),
            Default::default(),
        );
        let report = ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &[]),
                &budget,
            )
            .unwrap();
        (report, started.elapsed())
    });

    assert!(report.objects.is_empty());
    assert!(
        elapsed < Duration::from_millis(500),
        "an empty batch waited for a store reader, took {elapsed:?}"
    );
}

/// The reducer takes a reader connection, and `Mutex::lock` has no timeout, so
/// a held pool could carry a bounded evaluation past its deadline before the
/// scan reached its first poll.
#[test]
fn a_held_reader_pool_does_not_outlast_the_evaluation_deadline() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    // A passing candidate, so the verdict is current and the durable state is
    // what decides whether it may auto-inject.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let candidates = [feature_candidate(TARGET_OBJECT)];

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
    assert!(report.appends().next().is_none());
    // Without the durable record no verdict can be shown unblocked. The fence
    // applies the same policy when its own recheck cannot complete.
    assert!(
        report.auto_injectable().next().is_none(),
        "an unread durable state leaves nothing auto-injectable, got {:?}",
        report.objects[0].state
    );
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
    let AppendOutcome::Landed { commit_seq, .. } = *report.appends().next().expect("an append").1
    else {
        panic!(
            "expected a landed append, got {:?}",
            *report.appends().next().expect("an append").1
        );
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
    assert!(matches!(
        *report.appends().next().expect("an append").1,
        AppendOutcome::Landed { .. }
    ));

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
        *first.appends().next().expect("an append").1,
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
            second.appends().collect::<Vec<_>>().first(),
            Some((
                _,
                AppendOutcome::Landed {
                    replayed: false,
                    ..
                }
            ))
        ),
        "the moved checkout appends its own evidence, got {:?}",
        second.appends().collect::<Vec<_>>()
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

/// `blocked` is derived from the outer observation kind, and the generic
/// `insert_observation` API accepts any kind with any payload. A row claiming
/// `applicability.current` while its payload records a stale state would
/// otherwise clear a real block and let the object auto-inject.
#[test]
fn an_observation_whose_payload_disagrees_with_its_kind_is_corrupt() {
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
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();

    // A clearing kind carrying a stale payload, written through the generic API.
    let detail = serde_json::to_string(&ApplicabilityObservationPayload {
        schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
        checkout_identity_digest: checkout_identity_digest(snapshot.identity()),
        head: snapshot.head().to_string(),
        dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
        patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
        state: "stale".to_string(),
        evidence: "forged clear".to_string(),
    })
    .unwrap();
    store
        .commit(intent("forged-clear", '9'), |envelope| {
            envelope.insert_observation(ObservationSpec {
                observation_id: "forged".to_string(),
                object_id: "forged-object".to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                observation_kind: OBSERVATION_KIND_CURRENT.to_string(),
                payload: ObservationPayload {
                    summary: "forged clear".to_string(),
                    classification: OBSERVATION_KIND_CURRENT.to_string(),
                    detail: Some(detail),
                },
                observed_at: 2,
                dependencies: vec![ObservationDependencySpec {
                    dependency_object_id: TARGET_OBJECT.to_string(),
                    dependency_kind: DEPENDENCY_KIND_TARGET.to_string(),
                    dependency_payload: None,
                }],
                source_kind: "fixture".to_string(),
                source_id: "forged".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();

    let error = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap_err();
    assert_eq!(
        error,
        KernelError::CorruptCanonicalRow,
        "the forged clear is rejected rather than lifting the block"
    );
}

/// A repair whose owning domain went inactive is discarded, not an error: the
/// slice rejects an inactive parent, and that must not turn the veto this
/// evaluation already derived into a failed call.
#[test]
fn a_retired_domain_discards_the_repair_instead_of_failing_the_evaluation() {
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
    let intent_record =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], None, "test", 42).unwrap();

    // The owning domain is retired while the repair is in flight.
    store
        .commit(intent("retire-domain", 'a'), |envelope| {
            envelope.retire_domain("domain-object")?;
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
        0,
        "nothing durable written under an inactive domain"
    );
}

/// A raised interrupt stops the reducer before it reads.
///
/// The reducer's `ORDER BY` spans two tables, so SQLite sorts each target's rows
/// before yielding the first one and the row-loop poll cannot run during that
/// sort. A progress handler tied to the budget stops the statement itself, but it
/// fires on a virtual-machine step boundary that a small scan can finish without
/// reaching — so cancellation already raised is checked before the scan starts.
/// This asserts that check; the handler covers cancellation raised mid-sort,
/// which needs a history too large to build here.
#[test]
fn an_interrupted_budget_stops_the_reducer_before_it_reads() {
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
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();

    // A deadline far enough out that acquisition succeeds, and an interrupt
    // already raised, which is what a deadline crossing mid-statement leaves.
    let interrupt = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let budget = EvalBudget::new(
        Some(Instant::now() + Duration::from_secs(60)),
        std::sync::Arc::clone(&interrupt),
    );
    let error = store
        .applicability_block_states_at_tip(&[TARGET_OBJECT], snapshot.identity(), &budget)
        .unwrap_err();
    assert_eq!(error, KernelError::Deadline);

    // The handler is cleared, so the pooled connection still serves later reads.
    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("the block is still readable");
    assert!(block.blocked);
}

/// One unreadable row degrades its own object rather than failing the read for
/// every object sharing the batch.
#[test]
fn an_unreadable_row_degrades_only_its_own_object() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    store
        .commit(intent("neighbour", 'b'), |envelope| {
            envelope.insert_decision(DecisionSpec {
                decision_id: "decision-5".to_string(),
                object_id: "neighbour-object".to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                decision_kind: "adr".to_string(),
                payload: DecisionPayload {
                    summary: "neighbour".to_string(),
                    rationale: "fixture".to_string(),
                },
                source_kind: "fixture".to_string(),
                source_id: "decision-5".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [
        failing_candidate(),
        ApplicabilityCandidate {
            object_id: "neighbour-object".to_string(),
            ..failing_candidate()
        },
    ];
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();

    // Corrupt only the first object's record.
    let connection = Connection::open(store_dir.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations SET observation_payload=X'00'
             WHERE observation_id IN (
                 SELECT observation_id FROM observation_dependencies
                 WHERE dependency_object_id=?1 AND dependency_kind=?2
             )",
            (TARGET_OBJECT, DEPENDENCY_KIND_TARGET),
        )
        .unwrap();
    drop(connection);

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let states = store
        .applicability_block_states_at_tip(
            &[TARGET_OBJECT, "neighbour-object"],
            snapshot.identity(),
            &EvalBudget::unbounded(),
        )
        .expect("the batch still reads");
    assert_eq!(states.get(TARGET_OBJECT), Some(&BlockState::Unreadable));
    let neighbour = states
        .get("neighbour-object")
        .expect("the untouched object still reduces");
    assert!(
        matches!(neighbour, BlockState::Recorded(block) if block.blocked),
        "got {neighbour:?}"
    );

    // A current verdict over an unreadable record cannot auto-inject.
    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert!(report
        .objects
        .iter()
        .all(|object| object.state.blocks_auto_injection()));
}

/// A budget can carry a shared interrupt with no deadline, and that flag is then
/// the whole cancellation mechanism. Acquiring a connection must observe it.
#[test]
fn an_interrupt_only_budget_stops_a_blocked_reader_acquisition() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();

    let interrupt = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let budget = EvalBudget::new(None, std::sync::Arc::clone(&interrupt));
    let started = Instant::now();
    let (error, elapsed) = std::thread::scope(|threads| {
        threads.spawn(|| store.hold_readers_for_test(Duration::from_millis(1_500)));
        std::thread::sleep(Duration::from_millis(50));
        // Cancellation is raised while every reader is occupied.
        let raiser = threads.spawn({
            let interrupt = std::sync::Arc::clone(&interrupt);
            move || {
                std::thread::sleep(Duration::from_millis(150));
                interrupt.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
        let error = store
            .applicability_block_states_at_tip(&[TARGET_OBJECT], snapshot.identity(), &budget)
            .unwrap_err();
        raiser.join().unwrap();
        (error, started.elapsed())
    });
    assert_eq!(error, KernelError::Deadline);
    assert!(
        elapsed < Duration::from_millis(1_400),
        "acquisition stopped on the interrupt rather than on the holder, took {elapsed:?}"
    );
}

/// Same contract on the writer side: an interrupt-only budget must not wait out
/// a slow commit before noticing cancellation.
#[test]
fn an_interrupt_only_budget_stops_a_blocked_writer_acquisition() {
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
    let intent_record =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], None, "test", 42).unwrap();

    let interrupt = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let budget = EvalBudget::new(None, std::sync::Arc::clone(&interrupt));
    let held = std::sync::Barrier::new(2);
    let started = Instant::now();
    let (outcome, elapsed) = std::thread::scope(|threads| {
        hold_writer(
            threads,
            &store,
            &held,
            "interrupt-domain",
            Duration::from_millis(1_500),
        );
        threads.spawn({
            let interrupt = std::sync::Arc::clone(&interrupt);
            move || {
                std::thread::sleep(Duration::from_millis(150));
                interrupt.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
        let outcome = commit_read_repair(
            &store,
            &engine,
            &snapshot,
            &batch.objects[0],
            &intent_record,
            &budget,
        )
        .unwrap();
        (outcome, started.elapsed())
    });
    assert_eq!(outcome, AppendOutcome::DeadlineMissed);
    assert!(
        elapsed < Duration::from_millis(1_400),
        "the commit stopped on the interrupt rather than on the holder, took {elapsed:?}"
    );
}

/// Commit receipts are immutable while observations can be retired, so a replay
/// is not proof the record still exists. The generation moves past a retired
/// record so the replacement lands, and a replay with no live record does not
/// report as durable.
#[test]
fn retiring_a_clearing_record_lets_the_next_clear_land() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];
    let evaluate = || {
        ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &EvalBudget::unbounded(),
            )
            .unwrap()
    };

    evaluate();
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let cleared = evaluate();
    assert_eq!(cleared.objects[0].state, ApplicabilityState::Current);
    let clearing_object = text(
        store_dir.path(),
        &format!(
            "SELECT object_id FROM observations
             WHERE observation_kind='{OBSERVATION_KIND_CURRENT}'"
        ),
    );

    // An operator retires the clearing record; its receipt stays.
    store
        .commit(intent("retire-clear", 'c'), |envelope| {
            envelope.retire_observation(&clearing_object)?;
            Ok(String::new())
        })
        .unwrap();
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        store
            .applicability_block_state(
                TARGET_OBJECT,
                snapshot.identity(),
                store.known_as_of(0).unwrap().tip
            )
            .unwrap()
            .expect("the stale record is exposed again")
            .blocked,
        "retiring the clear restores the older block"
    );

    // Re-evaluating the same passing checkout has to land a replacement rather
    // than replay the retired receipt.
    let report = evaluate();
    assert!(
        matches!(
            report.appends().next(),
            Some((
                _,
                AppendOutcome::Landed {
                    replayed: false,
                    ..
                }
            ))
        ),
        "a replacement clear lands, got {:?}",
        report.appends().collect::<Vec<_>>()
    );
    assert_eq!(report.objects[0].state, ApplicabilityState::Current);
    assert!(
        !store
            .applicability_block_state(
                TARGET_OBJECT,
                snapshot.identity(),
                store.known_as_of(0).unwrap().tip
            )
            .unwrap()
            .expect("the replacement is visible")
            .blocked,
        "the block is genuinely cleared, not just reported clear"
    );
}

/// Newest-first scanning means a matched latest record is already authoritative.
/// An older row this build cannot read — a v1 payload after the schema moved to
/// v2, for instance — must not discard it and strand the object uncertain.
#[test]
fn an_older_unreadable_row_does_not_discard_a_newer_verdict() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];

    // A stale record, then a clearing one, so the older row is not the latest.
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    let stale_object = text(
        store_dir.path(),
        &format!(
            "SELECT object_id FROM observations
             WHERE observation_kind='{OBSERVATION_KIND_STALE}'"
        ),
    );
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();

    // Only the older record becomes unreadable.
    let connection = Connection::open(store_dir.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations SET observation_payload=X'00' WHERE object_id=?1",
            [stale_object.as_str()],
        )
        .unwrap();
    drop(connection);

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("the newer clearing record still reduces");
    assert!(
        !block.blocked,
        "the valid latest record stands over an unreadable older one"
    );
    assert_eq!(block.observation_kind, OBSERVATION_KIND_CURRENT);

    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(report.objects[0].state, ApplicabilityState::Current);
    assert_eq!(report.auto_injectable().count(), 1);
}

/// Two evaluations can share a HEAD and disagree about the worktree. The one
/// that reaches the writer second must not make its older evidence the latest
/// record and lift the newer block.
#[test]
fn a_repair_built_against_a_superseded_reduction_is_discarded() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];

    // A block is recorded while the checked file is absent.
    engine
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();

    // One evaluation sees the file appear and builds a clearing repair, holding
    // it while another evaluation records a newer stale block at the same HEAD.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &snapshot,
        &query,
        &scope,
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap();
    let stale_intent =
        RepairIntent::for_classification(&snapshot, &batch.objects[0], block.as_ref(), "test", 42)
            .unwrap();

    // The newer evidence lands first: the file disappears again, and an
    // unrelated edit makes this a worktree state no record describes yet, so the
    // second evaluation appends rather than recognising its own record.
    std::fs::remove_file(repo_dir.path().join("src/feature.rs")).unwrap();
    git_fixtures::write_worktree_file(&fixture.repo, "src/unrelated.rs", "pub fn u() {}\n");
    let before_newer = store.known_as_of(0).unwrap().tip;
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    let newer_tip = store.known_as_of(0).unwrap().tip;
    assert!(
        newer_tip > before_newer,
        "the second evaluation recorded newer evidence"
    );

    // Now the held clearing repair reaches the writer.
    let outcome = commit_read_repair(
        &store,
        &engine,
        &snapshot,
        &batch.objects[0],
        &stale_intent,
        &EvalBudget::unbounded(),
    )
    .unwrap();
    assert_eq!(
        outcome,
        AppendOutcome::Discarded,
        "the superseded clearing repair is discarded"
    );
    assert_eq!(
        store.known_as_of(0).unwrap().tip,
        newer_tip,
        "nothing was committed"
    );
    let current = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        store
            .applicability_block_state(TARGET_OBJECT, current.identity(), newer_tip)
            .unwrap()
            .expect("the newer block stands")
            .blocked,
        "the newer stale block survives the older clearing repair"
    );
}

/// One commit can write both a clearing and a stale applicability observation
/// for the same target through the generic API. They share a commit sequence, so
/// ordering by identifier would resolve to whichever sorts higher rather than to
/// the one written last.
#[test]
fn same_commit_observations_reduce_in_insertion_order() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let detail = |state: &str| {
        serde_json::to_string(&ApplicabilityObservationPayload {
            schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
            checkout_identity_digest: checkout_identity_digest(snapshot.identity()),
            head: snapshot.head().to_string(),
            dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
            patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
            state: state.to_string(),
            evidence: format!("{state} in one commit"),
        })
        .unwrap()
    };
    let spec = |id: &str, kind: &str, state: &str| ObservationSpec {
        observation_id: id.to_string(),
        object_id: format!("{id}-object"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: kind.to_string(),
        payload: ObservationPayload {
            summary: state.to_string(),
            classification: kind.to_string(),
            detail: Some(detail(state)),
        },
        observed_at: 1,
        dependencies: vec![ObservationDependencySpec {
            dependency_object_id: TARGET_OBJECT.to_string(),
            dependency_kind: DEPENDENCY_KIND_TARGET.to_string(),
            dependency_payload: None,
        }],
        source_kind: "fixture".to_string(),
        source_id: id.to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    };
    // The clearing row's identifier sorts above the stale row's, so an
    // identifier tie-break would pick the clear even though the stale row is
    // written second.
    store
        .commit(intent("same-commit", 'd'), |envelope| {
            envelope.insert_observation(spec("zz-clear", OBSERVATION_KIND_CURRENT, "current"))?;
            envelope.insert_observation(spec("aa-stale", OBSERVATION_KIND_STALE, "stale"))?;
            Ok(String::new())
        })
        .unwrap();

    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("the commit recorded applicability observations");
    assert_eq!(
        block.observation_kind, OBSERVATION_KIND_STALE,
        "the row written last is authoritative"
    );
    assert!(block.blocked);
}

/// A history whose records were all invalidated blocks nothing, so a current
/// verdict over it has nothing to clear and must not write durably.
#[test]
fn a_fully_invalidated_history_needs_no_clearing_append() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];

    // Record a block, then retire it, leaving an invalidated-only history.
    ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    let stale_object = text(
        store_dir.path(),
        &format!(
            "SELECT object_id FROM observations
             WHERE observation_kind='{OBSERVATION_KIND_STALE}'"
        ),
    );
    store
        .commit(intent("retire-stale", 'e'), |envelope| {
            envelope.retire_observation(&stale_object)?;
            Ok(String::new())
        })
        .unwrap();
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(
        store
            .applicability_block_state(
                TARGET_OBJECT,
                snapshot.identity(),
                store.known_as_of(0).unwrap().tip
            )
            .unwrap()
            .is_none_or(|block| !block.blocked),
        "a retired record blocks nothing"
    );

    // The object now passes. There is no block to lift, so nothing commits.
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    let before = store.known_as_of(0).unwrap().tip;
    let report = ApplicabilityEngine::new()
        .evaluate(
            &store,
            &request(repo_dir.path(), &query, &scope, &candidates),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(report.objects[0].state, ApplicabilityState::Current);
    assert_eq!(
        report.appends().count(),
        0,
        "no clearing append for a history that blocks nothing, got {:?}",
        report.appends().collect::<Vec<_>>()
    );
    assert_eq!(
        store.known_as_of(0).unwrap().tip,
        before,
        "nothing was committed"
    );
}

/// A row older than the newest kind change can carry a newer invalidation, and
/// the generation has to include it or a replacement repair reuses a retired
/// identity. The verdict settles at the kind change, so the scan has to keep
/// walking past it to see that invalidation.
#[test]
fn an_invalidation_older_than_the_kind_change_still_moves_the_generation() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (fixture, _tip) = seeded_checkout(repo_dir.path());
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [feature_candidate(TARGET_OBJECT)];
    let evaluate = || {
        ApplicabilityEngine::new()
            .evaluate(
                &store,
                &request(repo_dir.path(), &query, &scope, &candidates),
                &EvalBudget::unbounded(),
            )
            .unwrap()
    };

    // Two failing snapshots, then a passing one. Newest-first that is
    // current, stale, stale: the first stale row is the kind-change boundary and
    // the second is older than it.
    evaluate();
    let oldest_stale = text(
        store_dir.path(),
        &format!(
            "SELECT object_id FROM observations
             WHERE observation_kind='{OBSERVATION_KIND_STALE}'"
        ),
    );
    git_fixtures::write_worktree_file(&fixture.repo, "src/unrelated.rs", "pub fn u() {}\n");
    evaluate();
    assert_eq!(
        count(
            store_dir.path(),
            &format!(
                "SELECT COUNT(*) FROM observations
                 WHERE observation_kind='{OBSERVATION_KIND_STALE}'"
            )
        ),
        2,
        "two failing snapshots recorded two stale rows"
    );
    git_fixtures::write_worktree_file(&fixture.repo, "src/feature.rs", "pub fn f() {}\n");
    evaluate();

    // The oldest row is retired, at a commit newer than everything above it.
    store
        .commit(intent("retire-older", 'f'), |envelope| {
            envelope.retire_observation(&oldest_stale)?;
            Ok(String::new())
        })
        .unwrap();
    let retired_at = store.known_as_of(0).unwrap().tip;

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let block = store
        .applicability_block_state(TARGET_OBJECT, snapshot.identity(), retired_at)
        .unwrap()
        .expect("the clearing record still reduces");
    assert_eq!(
        block.observation_kind, OBSERVATION_KIND_CURRENT,
        "the verdict still settles on the newest record"
    );
    assert_eq!(
        block.invalidated_commit_seq, retired_at,
        "the invalidation behind the kind change reaches the generation"
    );
    assert!(
        block.generation_for(OBSERVATION_KIND_STALE) >= retired_at,
        "a stale repair derives an identity past the retirement"
    );
}

/// A retired record cannot be authoritative even when this build cannot decode
/// it, or the object stays uncertain forever behind a row that is no longer live.
#[test]
fn a_retired_unreadable_row_is_not_authoritative() {
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
    let stale_object = text(
        store_dir.path(),
        &format!(
            "SELECT object_id FROM observations
             WHERE observation_kind='{OBSERVATION_KIND_STALE}'"
        ),
    );

    // The only record becomes undecodable and is then retired.
    let connection = Connection::open(store_dir.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations SET observation_payload=X'00' WHERE object_id=?1",
            [stale_object.as_str()],
        )
        .unwrap();
    drop(connection);
    store
        .commit(intent("retire-unreadable", '3'), |envelope| {
            envelope.retire_observation(&stale_object)?;
            Ok(String::new())
        })
        .unwrap();
    let retired_at = store.known_as_of(0).unwrap().tip;

    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();
    let states = store
        .applicability_block_states_at_tip(
            &[TARGET_OBJECT],
            snapshot.identity(),
            &EvalBudget::unbounded(),
        )
        .expect("the reduction still reads");
    match states.get(TARGET_OBJECT) {
        Some(BlockState::Recorded(block)) => {
            assert!(!block.blocked, "a retired record blocks nothing");
            assert_eq!(
                block.invalidated_commit_seq, retired_at,
                "its invalidation still moves the generation"
            );
        }
        other => panic!("expected a recorded reduction, got {other:?}"),
    }
}

/// The fence around "nothing to clear" keys on the sequence the reduction read
/// at: an unchanged tip proves no commit landed since, and a moved tip forces a
/// re-reduction. This asserts that pair of primitives reports movement.
///
/// The interleaving itself — a block landing between the reduction and the
/// return — has no deterministic trigger from outside the engine, so the fence's
/// demotion path is argued from these primitives rather than from a timing test.
#[test]
fn the_reduction_reports_the_sequence_it_read_at() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let snapshot = snapshot_checkout(repo_dir.path(), &EvalBudget::unbounded()).unwrap();

    let (as_of, _) = store
        .applicability_block_states_as_of_tip(
            &[TARGET_OBJECT],
            snapshot.identity(),
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(
        store.applicability_tip(&EvalBudget::unbounded()).unwrap(),
        as_of,
        "an unchanged tip proves the reduction is still current"
    );

    // Any commit moves the tip past the sequence the reduction read at.
    store
        .commit(intent("moves-the-tip", '9'), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "tip-domain".to_string(),
                object_id: "tip-domain-object".to_string(),
                name: "tip".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "tip-domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    assert!(
        store.applicability_tip(&EvalBudget::unbounded()).unwrap() > as_of,
        "a commit makes the reduction stale, which is what the fence detects"
    );
}

/// A `source_id` equal to a repair's operation key does not make a row the
/// engine's repair. Only the engine's own `source_kind` does.
#[test]
fn a_foreign_source_id_is_not_a_repair_identity() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let store = seed_store(store_dir.path());
    let (_fixture, _tip) = seeded_checkout(repo_dir.path());
    let engine = ApplicabilityEngine::new();
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing_candidate()];

    // Derive the operation key the engine would use, then let a foreign
    // producer claim it as its own `source_id`.
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
    let operation_key = intent_record.operation_key().to_string();
    let detail = serde_json::to_string(&ApplicabilityObservationPayload {
        schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
        checkout_identity_digest: checkout_identity_digest(snapshot.identity()),
        head: snapshot.head().to_string(),
        dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
        patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
        state: "stale".to_string(),
        evidence: "foreign producer".to_string(),
    })
    .unwrap();
    store
        .commit(intent("foreign-identity", '8'), |envelope| {
            envelope.insert_observation(ObservationSpec {
                observation_id: "foreign".to_string(),
                object_id: "foreign-object".to_string(),
                domain_id: DOMAIN.to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                observation_kind: OBSERVATION_KIND_STALE.to_string(),
                payload: ObservationPayload {
                    summary: "foreign producer".to_string(),
                    classification: OBSERVATION_KIND_STALE.to_string(),
                    detail: Some(detail),
                },
                observed_at: 2,
                dependencies: vec![ObservationDependencySpec {
                    dependency_object_id: TARGET_OBJECT.to_string(),
                    dependency_kind: DEPENDENCY_KIND_TARGET.to_string(),
                    dependency_payload: None,
                }],
                // Not the engine, but claiming the engine's operation key.
                source_kind: "some-other-producer".to_string(),
                source_id: operation_key.clone(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();

    let block = store
        .applicability_block_state(
            TARGET_OBJECT,
            snapshot.identity(),
            store.known_as_of(0).unwrap().tip,
        )
        .unwrap()
        .expect("the foreign row still reduces");
    assert!(
        block.repair_identity.is_empty(),
        "a foreign producer's source_id is not a repair identity, got {:?}",
        block.repair_identity
    );
    assert_ne!(block.repair_identity, operation_key);
}

/// A clearing repair that does not land leaves the clear owed. A current
/// classification carries `append_pending` false, so the demotion has to set it
/// or the report says nothing is outstanding while the block still stands.
#[test]
fn an_unresolved_clearing_repair_reports_an_outstanding_append() {
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

    // The writer is held past the deadline, so the clearing append cannot land.
    let held = std::sync::Barrier::new(2);
    let report = std::thread::scope(|threads| {
        hold_writer(
            threads,
            &store,
            &held,
            "pending-domain",
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
        report.objects[0].append,
        Some(AppendOutcome::DeadlineMissed)
    );
    assert!(
        report.objects[0].append_pending,
        "the clear is still owed, so an append is outstanding"
    );
    assert!(report.auto_injectable().next().is_none());
}
