//! Resolution ladder proofs: ancestry against HEAD, patch-ID and tree-hash
//! fallbacks over rebase/cherry-pick fixtures, and stop-on-ambiguity.

#[path = "support/applicability_fixtures.rs"]
mod applicability_fixtures;
#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::Ordering;

use applicability_fixtures::checkout;
use git_fixtures::{commit_snapshot, init_repo};
use mc_store::kernel::applicability::{
    capture_anchor_representation, compute_patch_id, EvalBudget, GitConditionOutcome,
    ResolutionLadder,
};
use mc_store::kernel::{AnchorCapture, GitCondition, GraphOracle};
use proptest::prelude::*;

fn captures_for(
    repo: &gix::Repository,
    commits: &[gix::ObjectId],
) -> BTreeMap<String, AnchorCapture> {
    commits
        .iter()
        .map(|commit| {
            let capture = capture_anchor_representation(repo, *commit, &EvalBudget::unbounded())
                .expect("capture builds");
            (capture.commit_oid.clone(), capture)
        })
        .collect()
}

fn reachable_from(oid: gix::ObjectId, captures: BTreeMap<String, AnchorCapture>) -> GitCondition {
    GitCondition::ReachableFrom {
        oid: oid.to_string(),
        captures,
    }
}

fn reference_reachable(parents: &[Vec<usize>], ancestor: usize, descendant: usize) -> Option<bool> {
    if ancestor == descendant {
        return Some(true);
    }
    if ancestor >= parents.len() || descendant >= parents.len() {
        return None;
    }
    let mut pending = VecDeque::from([descendant]);
    let mut seen = vec![false; parents.len()];
    while let Some(commit) = pending.pop_front() {
        if seen[commit] {
            continue;
        }
        seen[commit] = true;
        for &parent in &parents[commit] {
            if parent == ancestor {
                return Some(true);
            }
            pending.push_back(parent);
        }
    }
    Some(false)
}

fn query_oid(commits: &[gix::ObjectId], index: usize) -> String {
    commits
        .get(index)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{:02x}", 0x80 + index % 0x7f).repeat(20))
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 48,
        rng_algorithm: prop::test_runner::RngAlgorithm::ChaCha,
        rng_seed: prop::test_runner::RngSeed::Fixed(0xA11CE57),
        ..ProptestConfig::default()
    })]

    #[test]
    fn ancestry_matches_parent_graph_bfs(
        shape in prop::collection::vec((any::<u16>(), any::<u16>(), any::<bool>(), any::<bool>()), 1..18),
        ancestor_raw in any::<u16>(),
        descendant_raw in any::<u16>(),
    ) {
        let dir = tempfile::tempdir().unwrap();
        let fixture = init_repo(dir.path());
        let mut commits = Vec::with_capacity(shape.len());
        let mut parents = Vec::with_capacity(shape.len());
        for (index, (first, second, is_root, has_second)) in shape.into_iter().enumerate() {
            let mut parent_indexes = Vec::new();
            if index > 0 && !is_root {
                parent_indexes.push(usize::from(first) % index);
                let second = usize::from(second) % index;
                if has_second && second != parent_indexes[0] {
                    parent_indexes.push(second);
                }
            }
            let parent_oids: Vec<gix::ObjectId> = parent_indexes
                .iter()
                .map(|parent| commits[*parent])
                .collect();
            let commit = commit_snapshot(
                &fixture.repo,
                &format!("node-{index}"),
                &parent_oids,
                &[("graph.txt", &format!("node {index}\n"))],
                &format!("node {index}"),
                i64::try_from(index + 1).unwrap(),
            );
            parents.push(parent_indexes);
            commits.push(commit);
        }

        let snapshot = checkout(&fixture, *commits.last().unwrap());
        let budget = EvalBudget::unbounded();
        let ladder = ResolutionLadder::new(&snapshot, &budget);
        let query_span = commits.len() + 2;
        let ancestor = usize::from(ancestor_raw) % query_span;
        let descendant = usize::from(descendant_raw) % query_span;
        prop_assert_eq!(
            ladder.is_ancestor_or_equal(
                &query_oid(&commits, ancestor),
                &query_oid(&commits, descendant),
            ),
            reference_reachable(&parents, ancestor, descendant),
        );
    }
}

#[test]
fn exhausted_budget_makes_uncached_ancestry_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let root = commit_snapshot(&fixture.repo, "main", &[], &[("f", "0")], "root", 1);
    let tip = commit_snapshot(&fixture.repo, "main", &[root], &[("f", "1")], "tip", 2);
    let snapshot = checkout(&fixture, tip);
    let budget = EvalBudget::unbounded();
    budget.interrupt_flag().store(true, Ordering::Relaxed);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.is_ancestor_or_equal(&root.to_string(), &tip.to_string()),
        None
    );
}

#[test]
fn reachable_from_holds_on_descendants_and_fails_on_foreign_branches() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let a = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "a", 1);
    let b = commit_snapshot(repo, "main", &[a], &[("f.txt", "two\n")], "b", 2);
    let foreign = commit_snapshot(repo, "other", &[], &[("g.txt", "x\n")], "g", 3);

    // AE1: HEAD is a descendant of the anchor commit.
    let snapshot = checkout(&fixture, b);
    let budget = EvalBudget::unbounded();
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(a, BTreeMap::new())),
        GitConditionOutcome::Holds
    );
    assert_eq!(
        ladder.evaluate(&reachable_from(b, BTreeMap::new())),
        GitConditionOutcome::Holds,
        "anchor equal to HEAD holds"
    );

    // AE2: checkout of a branch without the anchor commit.
    let snapshot = checkout(&fixture, foreign);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(a, BTreeMap::new())),
        GitConditionOutcome::DoesNotHold { historical: false }
    );
}

#[test]
fn reachable_between_is_half_open_over_independent_ancestry_tests() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let start = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "start", 1);
    let mid = commit_snapshot(repo, "main", &[start], &[("f.txt", "two\n")], "mid", 2);
    let end = commit_snapshot(repo, "main", &[mid], &[("f.txt", "three\n")], "end", 3);

    let condition = GitCondition::ReachableBetween {
        start_oid: start.to_string(),
        end_oid: end.to_string(),
        captures: BTreeMap::new(),
    };
    let budget = EvalBudget::unbounded();

    // HEAD at start: start reachable, end not → holds.
    let snapshot = checkout(&fixture, start);
    assert_eq!(
        ResolutionLadder::new(&snapshot, &budget).evaluate(&condition),
        GitConditionOutcome::Holds
    );
    // HEAD at mid: still inside the window.
    let snapshot = checkout(&fixture, mid);
    assert_eq!(
        ResolutionLadder::new(&snapshot, &budget).evaluate(&condition),
        GitConditionOutcome::Holds
    );
    // HEAD at end: half-open — the end commit exits the window.
    let snapshot = checkout(&fixture, end);
    assert_eq!(
        ResolutionLadder::new(&snapshot, &budget).evaluate(&condition),
        GitConditionOutcome::DoesNotHold { historical: true }
    );
    // HEAD before start: start not reachable.
    let before = commit_snapshot(repo, "before", &[], &[("h.txt", "h\n")], "before", 4);
    let snapshot = checkout(&fixture, before);
    assert_eq!(
        ResolutionLadder::new(&snapshot, &budget).evaluate(&condition),
        GitConditionOutcome::DoesNotHold { historical: false }
    );
}

#[test]
fn criss_cross_histories_answer_deterministically() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let root = commit_snapshot(repo, "main", &[], &[("f.txt", "root\n")], "root", 1);
    let a = commit_snapshot(repo, "side-a", &[root], &[("f.txt", "a\n")], "a", 2);
    let b = commit_snapshot(repo, "side-b", &[root], &[("f.txt", "b\n")], "b", 3);
    // Criss-cross: two merges with the same two parents in opposite order.
    let m1 = commit_snapshot(repo, "merge1", &[a, b], &[("f.txt", "m1\n")], "m1", 4);
    let _m2 = commit_snapshot(repo, "merge2", &[b, a], &[("f.txt", "m2\n")], "m2", 5);

    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, m1);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    // Both sides are ancestors of the merge; two independent ancestry tests
    // agree regardless of which merge base a merge-base search would pick.
    for anchor in [a, b, root] {
        assert_eq!(
            ladder.evaluate(&reachable_from(anchor, BTreeMap::new())),
            GitConditionOutcome::Holds
        );
    }
    let between = GitCondition::ReachableBetween {
        start_oid: a.to_string(),
        end_oid: b.to_string(),
        captures: BTreeMap::new(),
    };
    assert_eq!(
        ladder.evaluate(&between),
        GitConditionOutcome::DoesNotHold { historical: true }
    );
}

#[test]
fn rebase_fixture_resolves_through_patch_id_and_duplicates_stay_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    // The anchored change on a topic branch.
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "topic change\n")],
        "anchored",
        2,
    );
    let captures = captures_for(repo, &[anchored]);
    // Rebase: main moves forward, the change is re-parented (same diff, new
    // OID). The pre-rebase commit stays in the odb, held by the topic ref —
    // the same state a reflog leaves after a real rebase.
    let advanced = commit_snapshot(repo, "main", &[base], &[("f.txt", "two\n")], "advance", 3);
    let rebased = commit_snapshot(
        repo,
        "main",
        &[advanced],
        &[("f.txt", "two\n"), ("g.txt", "topic change\n")],
        "anchored",
        4,
    );

    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, rebased);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    // AE3: the anchor OID is present but unreachable from HEAD; the
    // patch-ID rung resolves it to the rebased commit.
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures.clone())),
        GitConditionOutcome::Holds
    );
    // Without any stored capture, ancestry's verdict stands.
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, BTreeMap::new())),
        GitConditionOutcome::DoesNotHold { historical: false }
    );

    // Duplicate cherry-pick: a second commit with the identical diff enters
    // the first-parent window → ambiguous → uncertain.
    let duplicated = commit_snapshot(
        repo,
        "main",
        &[rebased],
        &[
            ("f.txt", "two\n"),
            ("g.txt", "topic change\n"),
            ("h.txt", "unrelated\n"),
        ],
        "unrelated",
        5,
    );
    // Remove g.txt again, then re-add it with the same content so the diff
    // repeats in first-parent history.
    let removed = commit_snapshot(
        repo,
        "main",
        &[duplicated],
        &[("f.txt", "two\n"), ("h.txt", "unrelated\n")],
        "remove",
        6,
    );
    let picked_again = commit_snapshot(
        repo,
        "main",
        &[removed],
        &[
            ("f.txt", "two\n"),
            ("g.txt", "topic change\n"),
            ("h.txt", "unrelated\n"),
        ],
        "anchored again",
        7,
    );
    let snapshot = checkout(&fixture, picked_again);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Uncertain
    );

    // A reachable anchor is decided by ancestry before any fallback rung:
    // the ambiguous window above must never be consulted for it.
    let reachable_captures = captures_for(repo, &[rebased]);
    assert_eq!(
        ladder.evaluate(&reachable_from(rebased, reachable_captures)),
        GitConditionOutcome::Holds,
        "ancestry decides before the fallback ladder"
    );
}

#[test]
fn foreign_algorithm_patch_ids_skip_the_rung() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(
        repo,
        "main",
        &[],
        &[(
            "f.txt", "one
",
        )],
        "base",
        1,
    );
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[
            (
                "f.txt", "one
",
            ),
            (
                "g.txt", "change
",
            ),
        ],
        "anchored",
        2,
    );
    let advanced = commit_snapshot(
        repo,
        "main",
        &[base],
        &[(
            "f.txt", "two
",
        )],
        "advance",
        3,
    );
    let rebased = commit_snapshot(
        repo,
        "main",
        &[advanced],
        &[
            (
                "f.txt", "two
",
            ),
            (
                "g.txt", "change
",
            ),
        ],
        "anchored",
        4,
    );
    let mut captures = captures_for(repo, &[anchored]);
    let capture = captures.get_mut(&anchored.to_string()).unwrap();
    // Same value, foreign algorithm tag; the rung must not treat it as one
    // of ours. Drop the tree hash to isolate the patch-ID rung.
    capture.patch_id.as_mut().unwrap().algorithm = "git-patch-id-stable-v1".to_string();
    capture.tree_oid = None;
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, rebased);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::DoesNotHold { historical: false },
        "present-but-unreachable anchor keeps the ancestry verdict"
    );
}

#[test]
fn absent_anchor_without_resolution_is_uncertain_and_tree_hash_rescues() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let tip = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "content\n")],
        "tip",
        2,
    );
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, tip);
    let ladder = ResolutionLadder::new(&snapshot, &budget);

    // A fabricated OID absent from the odb, with no capture → uncertain.
    let missing = gix::ObjectId::from_hex("aa".repeat(20).as_bytes()).unwrap();
    assert_eq!(
        ladder.evaluate(&reachable_from(missing, BTreeMap::new())),
        GitConditionOutcome::Uncertain
    );

    // Same absent OID, but the capture's tree hash survives as the tip's
    // tree → tree-hash rung resolves it (no patch-ID stored → rung skipped).
    let tip_tree = repo.find_commit(tip).unwrap().tree_id().unwrap().detach();
    let capture = AnchorCapture {
        commit_oid: missing.to_string(),
        tree_oid: Some(tip_tree.to_string()),
        patch_id: None,
        changed_paths: vec!["g.txt".to_string()],
    };
    let mut captures = BTreeMap::new();
    captures.insert(missing.to_string(), capture);
    assert_eq!(
        ladder.evaluate(&reachable_from(missing, captures)),
        GitConditionOutcome::Holds
    );
}

#[test]
fn true_match_outside_the_candidate_window_stays_unresolved() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "windowed change\n")],
        "anchored",
        2,
    );
    let captures = captures_for(repo, &[anchored]);
    // Rebased equivalent lands deep in history…
    let rebased = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "windowed change\n")],
        "anchored",
        3,
    );
    // …buried under more than CANDIDATE_WINDOW filler commits.
    let mut tip = rebased;
    for index in 0..(mc_store::kernel::applicability::CANDIDATE_WINDOW as i64 + 8) {
        tip = commit_snapshot(
            repo,
            "main",
            &[tip],
            &[
                ("f.txt", "one\n"),
                ("g.txt", "windowed change\n"),
                ("filler.txt", &format!("filler {index}\n")),
            ],
            "filler",
            4 + index,
        );
    }
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, tip);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    // The anchor commit is present (topic ref) but unreachable; its true
    // match sits outside the bounded window, so no rung resolves it and the
    // ancestry verdict stands.
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::DoesNotHold { historical: false }
    );
}

#[test]
fn patch_id_is_stable_across_parents_and_whitespace_and_absent_for_merges() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();

    let base_a = commit_snapshot(repo, "a", &[], &[("f.txt", "base a\n")], "a", 1);
    let base_b = commit_snapshot(repo, "b", &[], &[("f.txt", "base b\n")], "b", 2);
    // The same logical change (add g.txt) on two different parents.
    let on_a = commit_snapshot(
        repo,
        "a",
        &[base_a],
        &[("f.txt", "base a\n"), ("g.txt", "same change\n")],
        "change",
        3,
    );
    let on_b = commit_snapshot(
        repo,
        "b",
        &[base_b],
        &[("f.txt", "base b\n"), ("g.txt", "same change\n")],
        "change",
        4,
    );
    let id_a = compute_patch_id(repo, on_a, &budget).unwrap().unwrap();
    let id_b = compute_patch_id(repo, on_b, &budget).unwrap().unwrap();
    assert_eq!(id_a, id_b, "same diff on different parents");

    // Whitespace-only variant of the change.
    let on_a_ws = commit_snapshot(
        repo,
        "ws",
        &[base_a],
        &[("f.txt", "base a\n"), ("g.txt", "  same   change  \n")],
        "change ws",
        5,
    );
    let id_ws = compute_patch_id(repo, on_a_ws, &budget).unwrap().unwrap();
    assert_eq!(id_a, id_ws, "whitespace-only variants share an identity");

    // A different change gets a different identity.
    let different = commit_snapshot(
        repo,
        "diff",
        &[base_a],
        &[("f.txt", "base a\n"), ("g.txt", "other change\n")],
        "other",
        6,
    );
    assert_ne!(
        id_a,
        compute_patch_id(repo, different, &budget).unwrap().unwrap()
    );

    // A two-file change on two different parents: the order-independent
    // combination yields the same identity, distinct from the one-file one.
    let two_on_a = commit_snapshot(
        repo,
        "two-a",
        &[base_a],
        &[
            ("f.txt", "base a\n"),
            ("g.txt", "same change\n"),
            ("h.txt", "second file\n"),
        ],
        "two",
        8,
    );
    let two_on_b = commit_snapshot(
        repo,
        "two-b",
        &[base_b],
        &[
            ("f.txt", "base b\n"),
            ("g.txt", "same change\n"),
            ("h.txt", "second file\n"),
        ],
        "two",
        9,
    );
    let id_two_a = compute_patch_id(repo, two_on_a, &budget).unwrap().unwrap();
    let id_two_b = compute_patch_id(repo, two_on_b, &budget).unwrap().unwrap();
    assert_eq!(id_two_a, id_two_b, "two-file diff stable across parents");
    assert_ne!(id_two_a, id_a, "two-file diff differs from one-file diff");

    // Merge commits have no patch identity.
    let merge = commit_snapshot(
        repo,
        "merged",
        &[on_a, on_b],
        &[("f.txt", "merged\n"), ("g.txt", "same change\n")],
        "merge",
        7,
    );
    assert_eq!(compute_patch_id(repo, merge, &budget).unwrap(), None);
}

#[test]
fn kernel_store_sources_contain_no_subprocess_usage() {
    // KTD1 gate, first-party half: no std::process or Command anywhere in
    // this crate's sources. The gix half is covered by the isolated open
    // options (no credential helpers or filter drivers become reachable).
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut pending = vec![src_root];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("source dir readable") {
            let entry = entry.expect("source entry readable");
            let path = entry.path();
            if entry.file_type().expect("file type readable").is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("source readable");
            for forbidden in ["process::Command", "Command::new", ".spawn("] {
                assert!(
                    !source.contains(forbidden),
                    "{} must not reference {forbidden}",
                    path.display()
                );
            }
        }
    }
}
