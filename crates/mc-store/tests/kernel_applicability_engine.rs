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
