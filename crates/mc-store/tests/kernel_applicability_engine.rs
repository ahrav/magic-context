//! Applicability evaluator proofs: per-object classification, generation
//! caches, and the zero-repo-access-on-hit guarantee.

#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::time::{Duration, Instant};

use git_fixtures::{
    commit_snapshot, init_repo, materialize, set_head_detached, write_worktree_file, FixtureRepo,
};
use mc_store::kernel::applicability::{
    capture_anchor_representation, snapshot_checkout, ApplicabilityCandidate, ApplicabilityEngine,
    ApplicabilityState, CheckSpec, CheckoutSnapshot, EvalBudget, ObjectApplicabilitySpec,
};
use mc_store::kernel::{
    encode_anchor_captures, AnchorRowSpec, Dimension, QueryContext, ScopeMatchContext,
    ScopeTermSpec,
};

fn checkout(fixture: &FixtureRepo, commit: gix::ObjectId) -> CheckoutSnapshot {
    set_head_detached(&fixture.repo, commit);
    materialize(&fixture.repo, commit);
    snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).expect("snapshot succeeds")
}

fn reachable_anchor(
    fixture: &FixtureRepo,
    anchor_id: &str,
    commit: gix::ObjectId,
) -> AnchorRowSpec {
    let capture = capture_anchor_representation(&fixture.repo, commit, &EvalBudget::unbounded())
        .expect("capture builds");
    AnchorRowSpec {
        anchor_id: anchor_id.to_string(),
        anchor_kind: "reachable_from".to_string(),
        reachable_from_oid: Some(commit.to_string()),
        payload: Some(encode_anchor_captures(&[capture])),
        ..AnchorRowSpec::default()
    }
}

fn candidate(object_id: &str) -> ApplicabilityCandidate {
    ApplicabilityCandidate {
        object_id: object_id.to_string(),
        object_revision: 1,
        ..ApplicabilityCandidate::default()
    }
}

fn seeded_repo(dir: &std::path::Path) -> (FixtureRepo, gix::ObjectId, gix::ObjectId) {
    let fixture = init_repo(dir);
    let base = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[
            ("src/lib.rs", "pub fn a() {}\n"),
            ("config.toml", "flag = true\n"),
        ],
        "base",
        1,
    );
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[base],
        &[
            ("src/lib.rs", "pub fn a() {}\npub fn b() {}\n"),
            ("config.toml", "flag = true\n"),
        ],
        "tip",
        2,
    );
    (fixture, base, tip)
}

#[test]
fn classifies_dirty_overlap_and_leaves_disjoint_paths_unaffected() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    // AE4: uncommitted edit inside the object's affected paths.
    write_worktree_file(&fixture.repo, "src/lib.rs", "pub fn a() { /* dirty */ }\n");
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();

    let engine = ApplicabilityEngine::new();
    let overlapping = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["src/lib.rs".to_string()], vec![]).encode(),
        ),
        ..candidate("object-overlap")
    };
    let disjoint = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["docs/README.md".to_string()], vec![]).encode(),
        ),
        ..candidate("object-disjoint")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[overlapping, disjoint],
        &EvalBudget::unbounded(),
    );
    assert_eq!(
        batch.objects[0].state,
        ApplicabilityState::DirtyTreeUncertain
    );
    assert!(batch.objects[0].state.blocks_auto_injection());
    assert_eq!(batch.objects[1].state, ApplicabilityState::Current);
}

#[test]
fn git_reachable_scope_terms_use_the_wired_graph_oracle() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let foreign = commit_snapshot(&fixture.repo, "other", &[], &[("z.txt", "z\n")], "z", 3);

    let scope_terms = vec![ScopeTermSpec {
        dimension: "branch".to_string(),
        operator: "git_reachable".to_string(),
        git_oid: Some(base.to_string()),
        ..ScopeTermSpec::default()
    }];
    let engine = ApplicabilityEngine::new();
    let scoped = ApplicabilityCandidate {
        scope_terms: Some(scope_terms),
        ..candidate("object-scoped")
    };

    // HEAD descends from the scope term's commit → matches → current.
    let snapshot = checkout(&fixture, tip);
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&scoped),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);

    // Foreign branch → the oracle answers definitively → out of scope.
    let snapshot = checkout(&fixture, foreign);
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[scoped],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::OutOfScope);
}

#[test]
fn cache_hit_performs_zero_object_database_operations() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let candidates: Vec<ApplicabilityCandidate> = (0..3)
        .map(|index| ApplicabilityCandidate {
            anchor: Some(reachable_anchor(&fixture, "anchor-shared", base)),
            payload: Some(
                ObjectApplicabilitySpec::new(
                    vec![],
                    vec![CheckSpec::FileExists {
                        path: "src/lib.rs".to_string(),
                    }],
                )
                .encode(),
            ),
            ..candidate(&format!("object-{index}"))
        })
        .collect();

    let first = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert!(first
        .objects
        .iter()
        .all(|object| object.state == ApplicabilityState::Current));
    assert!(
        first.stats.graph_operations > 0,
        "first run walks the graph"
    );
    // The shared anchor resolved once for the whole batch, not per object.
    assert_eq!(first.stats.anchor_cache_misses, 1);

    // Second evaluation with unchanged (HEAD, dirty fingerprint): all object
    // classifications come from cache and the object database is untouched
    // beyond the per-request snapshot taken above.
    let second = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(second.stats.object_cache_hits, 3);
    assert_eq!(second.stats.graph_operations, 0);
    assert_eq!(second.stats.anchor_cache_misses, 0);
}

#[test]
fn head_movement_invalidates_prior_generation() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let engine = ApplicabilityEngine::new();
    let object = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        ..candidate("object-1")
    };

    let snapshot = checkout(&fixture, base);
    let first = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&object),
        &EvalBudget::unbounded(),
    );
    assert_eq!(first.objects[0].state, ApplicabilityState::Current);

    // HEAD moves: the old generation's keys no longer apply; resolution runs
    // fresh instead of serving the stale entry.
    let snapshot = checkout(&fixture, tip);
    let second = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[object],
        &EvalBudget::unbounded(),
    );
    assert_eq!(second.stats.object_cache_hits, 0);
    assert!(second.stats.graph_operations > 0);
    assert_eq!(second.objects[0].state, ApplicabilityState::Current);
}

#[test]
fn malformed_inputs_stay_uncertain_and_do_not_poison_the_batch() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    let malformed_scope = ApplicabilityCandidate {
        scope_terms: Some(vec![ScopeTermSpec {
            dimension: "constellation".to_string(),
            operator: "exact".to_string(),
            exact_value: Some("orion".to_string()),
            ..ScopeTermSpec::default()
        }]),
        ..candidate("object-malformed")
    };
    let unknown_anchor = ApplicabilityCandidate {
        anchor: Some(AnchorRowSpec {
            anchor_id: "anchor-unknown".to_string(),
            anchor_kind: "symbol_hash".to_string(),
            ..AnchorRowSpec::default()
        }),
        ..candidate("object-unknown-anchor")
    };
    let healthy = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        ..candidate("object-healthy")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[malformed_scope, unknown_anchor, healthy],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[0].evidence.contains("malformed scope"));
    assert_eq!(batch.objects[1].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[1].evidence.contains("undecodable anchor"));
    assert_eq!(batch.objects[2].state, ApplicabilityState::Current);
}

#[test]
fn unsupported_symbol_checks_are_uncertain_and_failed_checks_go_stale() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    let symbol = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::Symbol {
                    path: "src/lib.rs".to_string(),
                    symbol: "a".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-symbol")
    };
    let missing_file = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/deleted.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-missing-file")
    };
    let config_present = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::ConfigKey {
                    path: "config.toml".to_string(),
                    key: "flag".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-config")
    };
    let config_absent = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::ConfigKey {
                    path: "config.toml".to_string(),
                    key: "missing_key".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-config-absent")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[symbol, missing_file, config_present, config_absent],
        &EvalBudget::unbounded(),
    );
    // Symbol support is absent, not failing: uncertain, never "symbol absent".
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[0].evidence.contains("not supported"));
    assert!(batch.objects[0].failed_check.is_none());
    // A failing file-existence check is a stale classification with the
    // failed check attached for read repair.
    assert_eq!(batch.objects[1].state, ApplicabilityState::Stale);
    assert!(batch.objects[1].failed_check.is_some());
    assert!(batch.objects[1].append_pending);
    assert_eq!(batch.objects[2].state, ApplicabilityState::Current);
    assert_eq!(batch.objects[3].state, ApplicabilityState::Stale);
}

#[test]
fn lifecycle_invalidated_objects_skip_evaluation() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let invalidated = ApplicabilityCandidate {
        lifecycle_invalidated: true,
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        ..candidate("object-invalidated")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[invalidated],
        &EvalBudget::unbounded(),
    );
    assert_eq!(
        batch.objects[0].state,
        ApplicabilityState::LifecycleInvalidated
    );
    assert!(batch.objects[0].state.blocks_auto_injection());
    // Nothing was resolved for it.
    assert_eq!(batch.stats.graph_operations, 0);
}

#[test]
fn deadline_exhaustion_mid_batch_leaves_remaining_objects_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let candidates: Vec<ApplicabilityCandidate> = (0..4)
        .map(|index| ApplicabilityCandidate {
            anchor: Some(reachable_anchor(&fixture, &format!("anchor-{index}"), base)),
            ..candidate(&format!("object-{index}"))
        })
        .collect();
    // A budget that expires immediately: every candidate classifies
    // uncertain, nothing panics, and nothing transient enters the cache.
    let expired = EvalBudget::new(
        Some(Instant::now() - Duration::from_millis(1)),
        Default::default(),
    );
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &expired,
    );
    assert!(batch
        .objects
        .iter()
        .all(|object| object.state == ApplicabilityState::Uncertain));

    // The cache was not poisoned: a healthy budget re-evaluates fresh and
    // reaches current.
    let healthy = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(healthy.stats.object_cache_hits, 0);
    assert!(healthy
        .objects
        .iter()
        .all(|object| object.state == ApplicabilityState::Current));
}

#[test]
fn scope_context_dimension_values_gate_matching() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let scoped = ApplicabilityCandidate {
        scope_terms: Some(vec![ScopeTermSpec {
            dimension: "environment".to_string(),
            operator: "exact".to_string(),
            exact_value: Some("production".to_string()),
            ..ScopeTermSpec::default()
        }]),
        ..candidate("object-env")
    };
    let matching = ScopeMatchContext::new().with_value(Dimension::Environment, "production");
    let other = ScopeMatchContext::new().with_value(Dimension::Environment, "staging");
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &matching,
        std::slice::from_ref(&scoped),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &other,
        &[scoped],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::OutOfScope);
}

#[test]
fn distinct_anchor_rows_never_share_a_cached_classification() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    // Rows that differ only in `exact_value` must not share a cache entry.
    let first = ApplicabilityCandidate {
        anchor: Some(AnchorRowSpec {
            anchor_id: "anchor-a".to_string(),
            anchor_kind: "exact".to_string(),
            exact_value: Some("ab".to_string()),
            ..AnchorRowSpec::default()
        }),
        ..candidate("object-x")
    };
    let second = ApplicabilityCandidate {
        anchor: Some(AnchorRowSpec {
            anchor_id: "anchor-a".to_string(),
            anchor_kind: "exact".to_string(),
            exact_value: Some("a".to_string()),
            ..AnchorRowSpec::default()
        }),
        ..candidate("object-x")
    };
    let with_payload = ApplicabilityCandidate {
        anchor: Some(AnchorRowSpec {
            anchor_id: "anchor-a".to_string(),
            anchor_kind: "exact".to_string(),
            exact_value: Some("ab".to_string()),
            payload: Some(Vec::new()),
            ..AnchorRowSpec::default()
        }),
        ..candidate("object-x")
    };

    let query = QueryContext {
        exact_token: Some("ab".to_string()),
        ..QueryContext::default()
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &query,
        &ScopeMatchContext::new(),
        &[first, second, with_payload],
        &EvalBudget::unbounded(),
    );
    let tokens: Vec<_> = batch.objects.iter().map(|object| &object.token).collect();
    assert_ne!(tokens[0], tokens[1]);
    assert_ne!(tokens[0], tokens[2]);
    assert_ne!(tokens[1], tokens[2]);
    // Same object, three distinct anchor rows: each classifies on its own
    // inputs rather than answering from another row's cache entry.
    assert_eq!(batch.stats.object_cache_hits, 0);
    assert_eq!(batch.stats.object_cache_misses, 3);
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert_eq!(batch.objects[1].state, ApplicabilityState::Historical);
}

#[test]
fn rows_sharing_an_anchor_id_decode_independently() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    // Same anchor_id, one decodable row and one undecodable row, in both
    // orders: the batch decode memo must never let one row answer for the
    // other.
    let valid_row = reachable_anchor(&fixture, "anchor-dup", base);
    let broken_row = AnchorRowSpec {
        anchor_id: "anchor-dup".to_string(),
        anchor_kind: "reachable_from".to_string(),
        reachable_from_oid: Some("not-an-oid".to_string()),
        ..AnchorRowSpec::default()
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[
            ApplicabilityCandidate {
                anchor: Some(valid_row.clone()),
                ..candidate("object-valid-first")
            },
            ApplicabilityCandidate {
                anchor: Some(broken_row.clone()),
                ..candidate("object-broken-second")
            },
            ApplicabilityCandidate {
                anchor: Some(broken_row),
                ..candidate("object-broken-third")
            },
            ApplicabilityCandidate {
                anchor: Some(valid_row),
                ..candidate("object-valid-fourth")
            },
        ],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert_eq!(batch.objects[1].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[1].evidence.contains("undecodable anchor"));
    assert_eq!(batch.objects[2].state, ApplicabilityState::Uncertain);
    assert_eq!(batch.objects[3].state, ApplicabilityState::Current);
}

#[test]
fn unreadable_payloads_are_uncertain_rather_than_current() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    // A payload the build cannot read leaves the object's declared paths and
    // checks unknown, so it must not reach the auto-injectable state.
    let corrupt = ApplicabilityCandidate {
        payload: Some(b"{not json".to_vec()),
        ..candidate("object-corrupt")
    };
    let future_schema = ApplicabilityCandidate {
        payload: Some(
            br#"{"schema":"mc.applicability.object.v2","affected_paths":["src/lib.rs"]}"#.to_vec(),
        ),
        ..candidate("object-future-schema")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[corrupt, future_schema],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[0].evidence.contains("did not parse"));
    assert_eq!(batch.objects[1].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[1].evidence.contains("schema"));
    assert!(batch
        .objects
        .iter()
        .all(|object| object.state.blocks_auto_injection()));
}

#[test]
fn check_paths_outside_the_checkout_are_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    let spec = |path: &str| ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: path.to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-escape")
    };
    // `/etc/hostname` exists on the host, and `Path::join` would let the
    // absolute path replace the workdir; a traversal likewise leaves it.
    let absolute = spec("/etc/hostname");
    let traversal = spec("../../../../etc/passwd");
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[absolute, traversal],
        &EvalBudget::unbounded(),
    );
    for object in &batch.objects {
        assert_eq!(object.state, ApplicabilityState::Uncertain);
        assert!(object.evidence.contains("not a plain relative path"));
        // Never a definite verdict: the check was refused, not evaluated.
        assert!(object.failed_check.is_none());
    }
}

#[test]
fn unknown_check_kinds_degrade_without_voiding_the_payload() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    write_worktree_file(&fixture.repo, "src/lib.rs", "pub fn a() { /* dirty */ }\n");
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    let engine = ApplicabilityEngine::new();

    // The unknown check kind must not discard `affected_paths`: the dirty gate
    // runs before checks, so a DirtyTreeUncertain verdict proves the rest of
    // the payload still decoded.
    let with_paths = ApplicabilityCandidate {
        payload: Some(
            br#"{"schema":"mc.applicability.object.v1","affected_paths":["src/lib.rs"],
                 "checks":[{"kind":"future_kind","path":"x"}]}"#
                .to_vec(),
        ),
        ..candidate("object-unknown-check-with-paths")
    };
    let only_check = ApplicabilityCandidate {
        payload: Some(
            br#"{"schema":"mc.applicability.object.v1","affected_paths":[],
                 "checks":[{"kind":"future_kind","path":"x"}]}"#
                .to_vec(),
        ),
        ..candidate("object-unknown-check")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[with_paths, only_check],
        &EvalBudget::unbounded(),
    );
    assert_eq!(
        batch.objects[0].state,
        ApplicabilityState::DirtyTreeUncertain
    );
    assert_eq!(batch.objects[1].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[1].evidence.contains("not recognized"));
}

#[test]
fn only_cached_classifications_claim_a_pending_append() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();

    let stale = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/deleted.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-stale")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&stale),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);
    assert!(batch.objects[0].append_pending);
    // The token names a live cache entry, so the confirmation lands and the
    // next hit stops asking for the append.
    assert!(engine.confirm_durable_append(&batch.objects[0].token));
    let repeat = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[stale],
        &EvalBudget::unbounded(),
    );
    assert_eq!(repeat.stats.object_cache_hits, 1);
    assert!(!repeat.objects[0].append_pending);

    // A budget-exhausted verdict is never cached, so it must not advertise an
    // append that could never be confirmed.
    let expired = EvalBudget::new(
        Some(Instant::now() - Duration::from_millis(1)),
        Default::default(),
    );
    let transient = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[candidate("object-transient")],
        &expired,
    );
    assert_eq!(transient.objects[0].state, ApplicabilityState::Uncertain);
    assert!(!transient.objects[0].append_pending);
    assert!(!engine.confirm_durable_append(&transient.objects[0].token));
}

#[test]
fn unconstrained_objects_do_not_claim_an_anchor_held() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[
            candidate("object-bare"),
            ApplicabilityCandidate {
                anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
                ..candidate("object-anchored")
            },
        ],
        &EvalBudget::unbounded(),
    );
    // Both are current, but the evidence is the durable record, so it must not
    // claim an anchor resolved for an object that has none.
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert!(!batch.objects[0].evidence.contains("anchor holds"));
    assert_eq!(batch.objects[1].state, ApplicabilityState::Current);
    assert!(batch.objects[1].evidence.contains("anchor holds"));
}

#[test]
fn every_state_maps_to_a_distinct_observation_kind() {
    let states = [
        ApplicabilityState::Current,
        ApplicabilityState::Historical,
        ApplicabilityState::OutOfScope,
        ApplicabilityState::Uncertain,
        ApplicabilityState::DirtyTreeUncertain,
        ApplicabilityState::Stale,
        ApplicabilityState::LifecycleInvalidated,
    ];
    let mut kinds: Vec<&str> = states
        .iter()
        .map(|state| state.observation_kind())
        .collect();
    kinds.sort_unstable();
    let total = kinds.len();
    kinds.dedup();
    assert_eq!(kinds.len(), total, "observation kinds collide");
    assert!(kinds.iter().all(|kind| kind.starts_with("applicability.")));
}

#[test]
fn unrelated_edit_preserves_cached_classifications() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();

    let engine = ApplicabilityEngine::new();
    let scoped_to_docs = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["docs/README.md".to_string()], vec![]).encode(),
        ),
        ..candidate("object-docs")
    };
    let no_payload = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        ..candidate("object-no-payload")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[scoped_to_docs.clone(), no_payload.clone()],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_misses, 2);

    // An edit outside both objects' declared paths must not evict either
    // classification, even though the checkout-wide dirty state changed.
    write_worktree_file(&fixture.repo, "notes.txt", "scratch\n");
    let edited = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    assert_ne!(edited.dirty_fingerprint(), snapshot.dirty_fingerprint());
    let batch = engine.evaluate_batch(
        &edited,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[scoped_to_docs, no_payload],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 2);
    assert_eq!(batch.stats.object_cache_misses, 0);
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert_eq!(batch.objects[1].state, ApplicabilityState::Current);
}

#[test]
fn overlapping_edit_invalidates_the_cached_classification() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();

    let engine = ApplicabilityEngine::new();
    let scoped_to_src = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["src/lib.rs".to_string()], vec![]).encode(),
        ),
        ..candidate("object-src")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&scoped_to_src),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);

    write_worktree_file(&fixture.repo, "src/lib.rs", "pub fn a() { /* dirty */ }\n");
    let edited = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &edited,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[scoped_to_src],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 0);
    assert_eq!(
        batch.objects[0].state,
        ApplicabilityState::DirtyTreeUncertain
    );
}

#[test]
fn dirty_edit_to_a_checked_file_invalidates_the_check_verdict() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();

    let engine = ApplicabilityEngine::new();
    let checked = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::ConfigKey {
                    path: "config.toml".to_string(),
                    key: "flag".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-checked")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&checked),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);

    // Removing the key as an uncommitted edit must re-run the check rather
    // than serve the cached Current verdict.
    write_worktree_file(&fixture.repo, "config.toml", "other = 1\n");
    let edited = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &edited,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[checked],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 0);
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);
}

#[test]
fn reverting_an_overlapping_edit_restores_the_original_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    let original = "pub fn a() {}\npub fn b() {}\n";
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();

    let engine = ApplicabilityEngine::new();
    let scoped_to_src = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["src/lib.rs".to_string()], vec![]).encode(),
        ),
        ..candidate("object-src")
    };
    engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&scoped_to_src),
        &EvalBudget::unbounded(),
    );

    write_worktree_file(&fixture.repo, "src/lib.rs", "pub fn a() { /* dirty */ }\n");
    let edited = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    engine.evaluate_batch(
        &edited,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&scoped_to_src),
        &EvalBudget::unbounded(),
    );

    write_worktree_file(&fixture.repo, "src/lib.rs", original);
    let reverted = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &reverted,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[scoped_to_src],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 1);
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
}

/// An absent payload declares nothing and reaches `Current`; a zero-byte
/// payload fails to decode and is `Uncertain`. Sharing a cache key would let
/// the first verdict auto-inject the second object.
#[test]
fn an_empty_payload_does_not_share_a_cache_key_with_an_absent_one() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let absent = candidate("object-1");
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&absent),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);

    let empty = ApplicabilityCandidate {
        payload: Some(Vec::new()),
        ..candidate("object-1")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[empty],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 0);
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
}

/// Two anchor rows can share an `anchor_id` and disagree: the batch memo has
/// to evaluate the second row's own condition rather than reuse the first's
/// outcome.
#[test]
fn anchor_rows_sharing_an_id_are_evaluated_separately() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let on_main = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n")],
        "base",
        1,
    );
    // A commit on a disjoint branch is unreachable from `on_main`.
    let off_main = commit_snapshot(
        &fixture.repo,
        "side",
        &[],
        &[("other.rs", "pub fn z() {}\n")],
        "side",
        2,
    );
    let snapshot = checkout(&fixture, on_main);

    let engine = ApplicabilityEngine::new();
    let reachable = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "shared-id", on_main)),
        ..candidate("object-reachable")
    };
    let unreachable = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "shared-id", off_main)),
        ..candidate("object-unreachable")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[reachable, unreachable],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert_ne!(
        batch.objects[1].state,
        ApplicabilityState::Current,
        "the second anchor row reused the first row's outcome"
    );
}

/// Git spells dirty paths one way; a declared path can arrive spelled
/// otherwise, and the dirty gate must still fire.
#[test]
fn noncanonical_affected_paths_still_overlap_the_dirty_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    write_worktree_file(&fixture.repo, "src/lib.rs", "pub fn a() { /* dirty */ }\n");
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();

    let engine = ApplicabilityEngine::new();
    for (index, spelling) in ["./src/lib.rs", "/src/lib.rs", "src/./lib.rs", "src/", ""]
        .into_iter()
        .enumerate()
    {
        let declared = ApplicabilityCandidate {
            payload: Some(
                ObjectApplicabilitySpec::new(vec![spelling.to_string()], vec![]).encode(),
            ),
            ..candidate(&format!("object-{index}"))
        };
        let batch = engine.evaluate_batch(
            &snapshot,
            &QueryContext::default(),
            &ScopeMatchContext::new(),
            &[declared],
            &EvalBudget::unbounded(),
        );
        assert_eq!(
            batch.objects[0].state,
            ApplicabilityState::DirtyTreeUncertain,
            "affected path {spelling:?} skipped the dirty-tree gate"
        );
    }
}

/// A minified JSON config has no line structure, so the line-oriented
/// heuristic reports every key missing and marks an applicable object stale.
#[test]
fn a_config_key_resolves_in_single_line_json() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("app.json", "{\"flag\":true,\"nested\":{\"deep\":1}}")],
        "base",
        1,
    );
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    for (index, key) in ["flag", "nested", "deep"].into_iter().enumerate() {
        let checked = ApplicabilityCandidate {
            payload: Some(
                ObjectApplicabilitySpec::new(
                    vec![],
                    vec![CheckSpec::ConfigKey {
                        path: "app.json".to_string(),
                        key: key.to_string(),
                    }],
                )
                .encode(),
            ),
            ..candidate(&format!("object-{index}"))
        };
        let batch = engine.evaluate_batch(
            &snapshot,
            &QueryContext::default(),
            &ScopeMatchContext::new(),
            &[checked],
            &EvalBudget::unbounded(),
        );
        assert_eq!(
            batch.objects[0].state,
            ApplicabilityState::Current,
            "key {key:?} was not found in minified JSON"
        );
    }

    let missing = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::ConfigKey {
                    path: "app.json".to_string(),
                    key: "absent".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-missing")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[missing],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);
}

/// A config file the check could not read leaves the key unevaluated, so the
/// object is uncertain rather than definitely stale, and read repair records
/// no repairable failure.
#[test]
fn an_unreadable_config_file_is_uncertain_not_stale() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n")],
        "base",
        1,
    );
    let snapshot = checkout(&fixture, tip);
    // A directory is present but is not a config file to read.
    std::fs::create_dir_all(fixture.root.join("config.d")).unwrap();

    let engine = ApplicabilityEngine::new();
    let checked = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::ConfigKey {
                    path: "config.d".to_string(),
                    key: "flag".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-unreadable")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[checked],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
    assert!(
        batch.objects[0].failed_check.is_none(),
        "an unevaluated read attached a repairable failure"
    );
}

/// A missing config file is a definite failure, unlike one that could not be
/// read.
#[test]
fn a_missing_config_file_stays_stale() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n")],
        "base",
        1,
    );
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let checked = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::ConfigKey {
                    path: "absent.toml".to_string(),
                    key: "flag".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-missing-config")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[checked],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Stale);
    assert!(batch.objects[0].failed_check.is_some());
}

/// The default spec has to survive an encode/decode round trip; a derived
/// `Default` leaves the schema tag empty and decodes as undecodable.
#[test]
fn the_default_object_spec_round_trips() {
    let encoded = ObjectApplicabilitySpec::default().encode();
    assert_eq!(
        ObjectApplicabilitySpec::decode(Some(&encoded)),
        mc_store::kernel::applicability::PayloadDecode::Present(ObjectApplicabilitySpec::default())
    );
}

/// Read repair confirms an append once. A later evaluation of the same key
/// must not report the append pending again.
#[test]
fn a_confirmed_append_stays_confirmed_across_evaluations() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let invalid_scope = ApplicabilityCandidate {
        scope_terms: Some(vec![ScopeTermSpec {
            dimension: Dimension::Project.as_str().to_string(),
            operator: "exact".to_string(),
            ..ScopeTermSpec::default()
        }]),
        ..candidate("object-uncertain")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&invalid_scope),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
    assert!(batch.objects[0].append_pending);
    assert!(engine.confirm_durable_append(&batch.objects[0].token));

    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[invalid_scope],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 1);
    assert!(
        !batch.objects[0].append_pending,
        "a confirmed append was reported pending again"
    );
}

/// A verdict the engine declined to cache has no entry to confirm, so the
/// confirmation is dropped rather than applied to some other key's entry.
#[test]
fn confirming_an_uncacheable_verdict_reports_the_drop() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[candidate("object-1")],
        // An already-expired budget yields the uncacheable early exit.
        &EvalBudget::new(
            Some(Instant::now() - Duration::from_millis(1)),
            Default::default(),
        ),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Uncertain);
    assert!(!batch.objects[0].append_pending);
    assert!(!engine.confirm_durable_append(&batch.objects[0].token));
}

/// The shallow boundary decides how far an ancestry walk reaches, and
/// unshallowing moves neither HEAD nor the worktree. Both caches have to miss
/// so a verdict formed under a truncated history is re-derived.
#[test]
fn changing_the_shallow_boundary_invalidates_both_caches() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let anchored = ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-1", base)),
        ..candidate("object-anchored")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&anchored),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert_eq!(batch.stats.anchor_cache_misses, 1);

    // A grafted boundary is the state `git fetch --unshallow` removes.
    std::fs::write(fixture.repo.git_dir().join("shallow"), format!("{base}\n")).unwrap();
    let grafted = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    assert_ne!(grafted.repository_state(), snapshot.repository_state());
    let batch = engine.evaluate_batch(
        &grafted,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[anchored],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 0);
    assert_eq!(batch.stats.anchor_cache_hits, 0);
}

/// Sparse patterns decide which declared paths materialize, so a check verdict
/// formed under one pattern set cannot answer under another.
#[test]
fn changing_sparse_patterns_invalidates_the_object_cache() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);

    let engine = ApplicabilityEngine::new();
    let checked = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(
                vec![],
                vec![CheckSpec::FileExists {
                    path: "src/lib.rs".to_string(),
                }],
            )
            .encode(),
        ),
        ..candidate("object-checked")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        std::slice::from_ref(&checked),
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);

    let info = fixture.repo.git_dir().join("info");
    std::fs::create_dir_all(&info).unwrap();
    std::fs::write(info.join("sparse-checkout"), "/docs/\n").unwrap();
    let sparse = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    let batch = engine.evaluate_batch(
        &sparse,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[checked],
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.stats.object_cache_hits, 0);
}
