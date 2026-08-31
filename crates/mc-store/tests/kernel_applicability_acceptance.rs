//! Acceptance sweep: one named test per bead acceptance criterion, driven
//! end-to-end through the public `ApplicabilityEngine::evaluate` entry
//! point over the gix-built fixture kit.
//!
//! Criterion map:
//! - Property tests over the four scope predicates → `kernel_scope_algebra.rs`
//!   (proptest law suite with pinned seed); referenced, not duplicated here.
//! - Fixture repos distinguish the applicability states →
//!   `acceptance_matrix_distinguishes_every_state`.
//! - Rebase/cherry-pick patch-ID fallback →
//!   `acceptance_patch_id_fallback_resolves_moved_commits`.
//! - Bounded and cancellable work →
//!   `acceptance_work_stays_bounded_and_cancellable`.
//! - Zero git subprocesses on cache hits →
//!   `acceptance_cache_hits_do_no_git_work_and_nothing_spawns`.
//! - Failed read repair blocks without waiting for deep verification →
//!   `acceptance_failed_check_blocks_before_deep_verification`.
//! - State changes atomic under known_as_of → `kernel_read_repair.rs`
//!   fault-injection and bitemporal tests, plus the restart proof there.

#![cfg(feature = "test-support")]

#[path = "support/applicability_fixtures.rs"]
mod applicability_fixtures;
#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use applicability_fixtures::{candidate, reachable_anchor};
use git_fixtures::{
    commit_snapshot, init_repo, materialize, set_head_detached, write_worktree_file,
};
use mc_store::kernel::applicability::{
    AppendOutcome, ApplicabilityCandidate, ApplicabilityEngine, ApplicabilityRequest,
    ApplicabilityState, CheckSpec, EvalBudget, ObjectApplicabilitySpec,
};
use mc_store::kernel::{
    AnchorRowSpec, CommitIntent, DecisionPayload, DecisionSpec, DomainSpec, KernelStore,
    QueryContext, ScopeMatchContext, ScopeTermSpec, Sensitivity,
};

const DOMAIN: &str = "domain";

fn intent(key: &str, digest: char) -> CommitIntent {
    applicability_fixtures::intent("acceptance-test", key, digest)
}

fn seed_store(root: &std::path::Path, object_ids: &[&str]) -> KernelStore {
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
    for (index, object_id) in object_ids.iter().enumerate() {
        store
            .commit(intent(&format!("target-{object_id}"), '1'), |envelope| {
                envelope.insert_decision(DecisionSpec {
                    decision_id: format!("decision-{index}"),
                    object_id: object_id.to_string(),
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
                    source_id: format!("decision-{index}"),
                    source_revision: 1,
                    sensitivity: Sensitivity::Normal,
                })?;
                Ok(String::new())
            })
            .unwrap();
    }
    store
}

#[test]
fn acceptance_matrix_distinguishes_every_state() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(repo_dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(
        repo,
        "main",
        &[],
        &[("src/lib.rs", "lib\n"), ("docs/notes.md", "notes\n")],
        "base",
        1,
    );
    let start = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("src/lib.rs", "lib v2\n"), ("docs/notes.md", "notes\n")],
        "start",
        2,
    );
    let end = commit_snapshot(
        repo,
        "main",
        &[start],
        &[("src/lib.rs", "lib v3\n"), ("docs/notes.md", "notes\n")],
        "end",
        3,
    );
    set_head_detached(repo, end);
    materialize(repo, end);
    // Dirty edit overlapping only the dirty candidate's affected paths.
    write_worktree_file(repo, "docs/notes.md", "notes edited\n");

    let objects = [
        "object-current",
        "object-historical",
        "object-uncertain",
        "object-stale",
        "object-dirty",
        "object-invalidated",
        "object-out-of-scope",
    ];
    let store = seed_store(store_dir.path(), &objects);
    let engine = ApplicabilityEngine::new();

    let current = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-current", base)),
        ..candidate("object-current")
    };
    // reachable_between whose end commit has been reached → historical.
    let historical = ApplicabilityCandidate {
        anchor: Some(AnchorRowSpec {
            anchor_id: "anchor-between".to_string(),
            anchor_kind: "reachable_between".to_string(),
            reachable_between_start_oid: Some(start.to_string()),
            reachable_between_end_oid: Some(end.to_string()),
            ..AnchorRowSpec::default()
        }),
        ..candidate("object-historical")
    };
    // Anchor commit absent from the odb with no capture → uncertain.
    let uncertain = ApplicabilityCandidate {
        anchor: Some(AnchorRowSpec {
            anchor_id: "anchor-missing".to_string(),
            anchor_kind: "reachable_from".to_string(),
            reachable_from_oid: Some("bb".repeat(20)),
            ..AnchorRowSpec::default()
        }),
        ..candidate("object-uncertain")
    };
    let stale = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/gone.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-stale")
    };
    let dirty = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["docs/notes.md".to_string()], vec![]).encode(),
        ),
        ..candidate("object-dirty")
    };
    let invalidated = ApplicabilityCandidate {
        lifecycle_invalidated: true,
        ..candidate("object-invalidated")
    };
    let out_of_scope = ApplicabilityCandidate {
        scope_terms: Some(vec![ScopeTermSpec {
            dimension: "environment".to_string(),
            operator: "exact".to_string(),
            exact_value: Some("production".to_string()),
            ..ScopeTermSpec::default()
        }]),
        ..candidate("object-out-of-scope")
    };

    let query = QueryContext::default();
    let scope =
        ScopeMatchContext::new().with_value(mc_store::kernel::Dimension::Environment, "staging");
    let candidates = [
        current,
        historical,
        uncertain,
        stale,
        dirty,
        invalidated,
        out_of_scope,
    ];
    let report = engine
        .evaluate(
            &store,
            &ApplicabilityRequest {
                checkout_path: repo_dir.path(),
                query: &query,
                scope_context: &scope,
                candidates: &candidates,
                domain_id: DOMAIN,
                actor: "test",
                observed_at: 42,
            },
            &EvalBudget::unbounded(),
        )
        .unwrap();

    let states: BTreeMap<&str, ApplicabilityState> = report
        .objects
        .iter()
        .map(|object| (object.object_id.as_str(), object.state))
        .collect();
    assert_eq!(states["object-current"], ApplicabilityState::Current);
    assert_eq!(states["object-historical"], ApplicabilityState::Historical);
    assert_eq!(states["object-uncertain"], ApplicabilityState::Uncertain);
    assert_eq!(states["object-stale"], ApplicabilityState::Stale);
    assert_eq!(
        states["object-dirty"],
        ApplicabilityState::DirtyTreeUncertain
    );
    assert_eq!(
        states["object-invalidated"],
        ApplicabilityState::LifecycleInvalidated
    );
    assert_eq!(
        states["object-out-of-scope"],
        ApplicabilityState::OutOfScope
    );

    // Auto-injection view: current only, never double-labeled.
    let injectable: Vec<&str> = report
        .auto_injectable()
        .map(|object| object.object_id.as_str())
        .collect();
    assert_eq!(injectable, vec!["object-current"]);
    let labeled: BTreeMap<&str, &str> = report
        .labeled_non_current()
        .map(|(label, object)| (object.object_id.as_str(), label))
        .collect();
    assert_eq!(labeled.len(), report.objects.len() - 1);
    assert!(!labeled.contains_key("object-current"));
    assert_eq!(labeled["object-historical"], "historical");
    assert_eq!(labeled["object-stale"], "stale");
    assert_eq!(labeled["object-dirty"], "dirty_tree_uncertain");
    assert_eq!(labeled["object-uncertain"], "uncertain");
    assert_eq!(labeled["object-invalidated"], "lifecycle_invalidated");
    assert_eq!(labeled["object-out-of-scope"], "out_of_scope");
}

#[test]
fn acceptance_patch_id_fallback_resolves_moved_commits() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(repo_dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "change\n")],
        "anchored",
        2,
    );
    // Rebase-shaped rewrite reachable from HEAD.
    let advanced = commit_snapshot(repo, "main", &[base], &[("f.txt", "two\n")], "advance", 3);
    let rebased = commit_snapshot(
        repo,
        "main",
        &[advanced],
        &[("f.txt", "two\n"), ("g.txt", "change\n")],
        "anchored",
        4,
    );
    set_head_detached(repo, rebased);
    materialize(repo, rebased);

    let store = seed_store(store_dir.path(), &["object-moved"]);
    let engine = ApplicabilityEngine::new();
    let moved = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-moved", anchored)),
        ..candidate("object-moved")
    };
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [moved];
    let report = engine
        .evaluate(
            &store,
            &ApplicabilityRequest {
                checkout_path: repo_dir.path(),
                query: &query,
                scope_context: &scope,
                candidates: &candidates,
                domain_id: DOMAIN,
                actor: "test",
                observed_at: 42,
            },
            &EvalBudget::unbounded(),
        )
        .unwrap();
    assert_eq!(report.objects[0].state, ApplicabilityState::Current);
}

#[test]
fn acceptance_cache_hits_do_no_git_work_and_nothing_spawns() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(repo_dir.path());
    let base = commit_snapshot(&fixture.repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[base],
        &[("f.txt", "two\n")],
        "tip",
        2,
    );
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);

    let store = seed_store(store_dir.path(), &["object-cached"]);
    let engine = ApplicabilityEngine::new();
    let cached = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-cached", base)),
        ..candidate("object-cached")
    };
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [cached];
    let request = ApplicabilityRequest {
        checkout_path: repo_dir.path(),
        query: &query,
        scope_context: &scope,
        candidates: &candidates,
        domain_id: DOMAIN,
        actor: "test",
        observed_at: 42,
    };
    let first = engine
        .evaluate(&store, &request, &EvalBudget::unbounded())
        .unwrap();
    assert!(first.stats.graph_operations > 0);
    let second = engine
        .evaluate(&store, &request, &EvalBudget::unbounded())
        .unwrap();
    // Zero object-database work beyond the per-request snapshot; the
    // no-subprocess half of the criterion is the source gate in
    // `kernel_anchor_resolution.rs` plus the isolated open options.
    assert_eq!(second.stats.graph_operations, 0);
    assert_eq!(second.stats.object_cache_hits, 1);
}

#[test]
fn acceptance_work_stays_bounded_and_cancellable() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(repo_dir.path());
    let tip = commit_snapshot(&fixture.repo, "main", &[], &[("f.txt", "one\n")], "tip", 1);
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);

    let store = seed_store(store_dir.path(), &["object-bounded"]);
    let engine = ApplicabilityEngine::new();
    let bounded = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-bounded", tip)),
        ..candidate("object-bounded")
    };
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [bounded];
    // An already-expired deadline: every object classifies uncertain, the
    // request completes without panics, and no stale answer is presented as
    // current.
    let expired = EvalBudget::new(
        Some(Instant::now() - Duration::from_millis(1)),
        Default::default(),
    );
    let report = engine
        .evaluate(
            &store,
            &ApplicabilityRequest {
                checkout_path: repo_dir.path(),
                query: &query,
                scope_context: &scope,
                candidates: &candidates,
                domain_id: DOMAIN,
                actor: "test",
                observed_at: 42,
            },
            &expired,
        )
        .unwrap();
    assert!(report
        .objects
        .iter()
        .all(|object| object.state == ApplicabilityState::Uncertain));
    assert!(report.auto_injectable().next().is_none());
}

#[test]
fn acceptance_failed_check_blocks_before_deep_verification() {
    let store_dir = tempfile::tempdir().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(repo_dir.path());
    let tip = commit_snapshot(&fixture.repo, "main", &[], &[("f.txt", "one\n")], "tip", 1);
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);

    let store = seed_store(store_dir.path(), &["object-blocked"]);
    let engine = ApplicabilityEngine::new();
    let failing = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "missing.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-blocked")
    };
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let candidates = [failing];
    let report = engine
        .evaluate(
            &store,
            &ApplicabilityRequest {
                checkout_path: repo_dir.path(),
                query: &query,
                scope_context: &scope,
                candidates: &candidates,
                domain_id: DOMAIN,
                actor: "test",
                observed_at: 42,
            },
            &EvalBudget::unbounded(),
        )
        .unwrap();
    // The veto and the durable block both exist before any deep
    // verification consumer has run (none exists yet — the outbox job is
    // scheduled, not consumed).
    assert_eq!(report.objects[0].state, ApplicabilityState::Stale);
    assert!(report.auto_injectable().next().is_none());
    assert!(matches!(report.appends[0].1, AppendOutcome::Landed { .. }));
}
