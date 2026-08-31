//! Applicability evaluator proofs: per-object classification, generation
//! caches, and the zero-repo-access-on-hit guarantee.

#[path = "support/applicability_fixtures.rs"]
mod applicability_fixtures;
#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::time::{Duration, Instant};

use applicability_fixtures::{candidate, checkout, reachable_anchor};
use git_fixtures::{
    commit_snapshot, init_repo, materialize, set_head_detached, write_worktree_file, FixtureRepo,
};
use mc_store::kernel::applicability::{
    snapshot_checkout, ApplicabilityCandidate, ApplicabilityEngine, ApplicabilityState, CheckSpec,
    EvalBudget, ObjectApplicabilitySpec,
};
use mc_store::kernel::{AnchorRowSpec, Dimension, QueryContext, ScopeMatchContext, ScopeTermSpec};

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
fn cache_hits_survive_an_unreadable_object_database() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let candidates = [ApplicabilityCandidate {
        anchor: Some(reachable_anchor(&fixture, "anchor-odb", base)),
        ..candidate("object-odb")
    }];
    let first = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(first.objects[0].state, ApplicabilityState::Current);

    // Park the object database: a hit path that touched it could no longer
    // answer current. This is the oracle the graph-operation counter only
    // approximates.
    let objects_dir = fixture.repo.git_dir().join("objects");
    let parked = fixture.repo.git_dir().join("objects.parked");
    std::fs::rename(&objects_dir, &parked).unwrap();
    let second = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    std::fs::rename(&parked, &objects_dir).unwrap();
    assert_eq!(second.stats.object_cache_hits, 1);
    assert_eq!(second.objects[0].state, ApplicabilityState::Current);
}

#[test]
fn shared_anchor_ids_with_different_rows_never_alias() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, base, tip) = seeded_repo(dir.path());
    let foreign = commit_snapshot(&fixture.repo, "foreign", &[], &[("q.txt", "q\n")], "q", 9);
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    // Same anchor_id, different anchored commits: the second candidate must
    // not inherit the first's verdict through the batch memo.
    let candidates = [
        ApplicabilityCandidate {
            anchor: Some(reachable_anchor(&fixture, "anchor-dup", base)),
            ..candidate("object-a")
        },
        ApplicabilityCandidate {
            anchor: Some(reachable_anchor(&fixture, "anchor-dup", foreign)),
            ..candidate("object-b")
        },
    ];
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    assert_eq!(batch.objects[0].state, ApplicabilityState::Current);
    assert_eq!(batch.objects[1].state, ApplicabilityState::Historical);
}

#[test]
fn undecodable_object_payloads_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let corrupt = ApplicabilityCandidate {
        payload: Some(b"not json".to_vec()),
        ..candidate("object-corrupt")
    };
    let unknown_schema = ApplicabilityCandidate {
        payload: Some(
            br#"{"schema":"mc.applicability.object.v99","affected_paths":["src/lib.rs"]}"#.to_vec(),
        ),
        ..candidate("object-unknown-schema")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[corrupt, unknown_schema],
        &EvalBudget::unbounded(),
    );
    for object in &batch.objects {
        assert_eq!(
            object.state,
            ApplicabilityState::Uncertain,
            "{}",
            object.object_id
        );
        assert!(object.evidence.contains("undecodable"));
    }
}

#[test]
fn dirty_overlap_respects_directory_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    set_head_detached(&fixture.repo, tip);
    materialize(&fixture.repo, tip);
    write_worktree_file(&fixture.repo, "src/lib.rs", "dirty\n");
    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    let engine = ApplicabilityEngine::new();
    // Affected path declared at directory granularity overlaps a dirty file
    // beneath it; a textual-prefix sibling does not.
    let dir_scoped = ApplicabilityCandidate {
        payload: Some(ObjectApplicabilitySpec::new(vec!["src".to_string()], vec![]).encode()),
        ..candidate("object-dir")
    };
    let sibling = ApplicabilityCandidate {
        payload: Some(
            ObjectApplicabilitySpec::new(vec!["src/lib.rs.bak".to_string()], vec![]).encode(),
        ),
        ..candidate("object-sibling")
    };
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &[dir_scoped, sibling],
        &EvalBudget::unbounded(),
    );
    assert_eq!(
        batch.objects[0].state,
        ApplicabilityState::DirtyTreeUncertain
    );
    assert_eq!(batch.objects[1].state, ApplicabilityState::Current);
}

#[test]
fn traversal_and_absolute_check_paths_are_invalid_not_failures() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _base, tip) = seeded_repo(dir.path());
    let snapshot = checkout(&fixture, tip);
    let engine = ApplicabilityEngine::new();
    let candidates: Vec<ApplicabilityCandidate> = ["../outside.txt", "/etc/hostname"]
        .iter()
        .enumerate()
        .map(|(index, path)| ApplicabilityCandidate {
            payload: Some(
                ObjectApplicabilitySpec::new(
                    vec![],
                    vec![CheckSpec::FileExists {
                        path: path.to_string(),
                    }],
                )
                .encode(),
            ),
            ..candidate(&format!("object-escape-{index}"))
        })
        .collect();
    let batch = engine.evaluate_batch(
        &snapshot,
        &QueryContext::default(),
        &ScopeMatchContext::new(),
        &candidates,
        &EvalBudget::unbounded(),
    );
    for object in &batch.objects {
        // Escaping paths are unusable specifications: uncertain, never a
        // stale classification that would trigger read repair, and never a
        // probe outside the checkout reported as pass/fail.
        assert_eq!(
            object.state,
            ApplicabilityState::Uncertain,
            "{}",
            object.object_id
        );
        assert!(object.failed_check.is_none());
    }
}
