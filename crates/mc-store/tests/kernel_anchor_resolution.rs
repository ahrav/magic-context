//! Resolution ladder proofs: ancestry against HEAD, patch-ID and tree-hash
//! fallbacks over rebase/cherry-pick fixtures, and stop-on-ambiguity.

#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::collections::BTreeMap;

use git_fixtures::{
    commit_snapshot, commit_snapshot_with_modes, commit_tree, init_repo, materialize,
    set_head_detached, FixtureRepo,
};
use mc_store::kernel::applicability::{
    capture_anchor_representation, compute_patch_id, snapshot_checkout, CheckoutSnapshot,
    EvalBudget, GitConditionOutcome, ResolutionLadder, PATCH_ID_ALGORITHM,
};
use mc_store::kernel::{AnchorCapture, GitCondition};

fn checkout(fixture: &FixtureRepo, commit: gix::ObjectId) -> CheckoutSnapshot {
    set_head_detached(&fixture.repo, commit);
    materialize(&fixture.repo, commit);
    snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).expect("snapshot succeeds")
}

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
    let m2 = commit_snapshot(repo, "merge2", &[b, a], &[("f.txt", "m2\n")], "m2", 5);

    let budget = EvalBudget::unbounded();
    for merge in [m1, m2] {
        let snapshot = checkout(&fixture, merge);
        let ladder = ResolutionLadder::new(&snapshot, &budget);
        // Each anchor is an ancestor of both merges, so evaluation is
        // independent of merge-base selection and parent order.
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
    // The truncated reachable history excludes the rewrite, so the miss
    // is uncertain.
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Uncertain
    );
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, BTreeMap::new())),
        GitConditionOutcome::DoesNotHold { historical: false },
        "without fallback data the truncated window changes nothing"
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
fn nested_path_commits_have_a_patch_identity_and_resolve_after_rebase() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(
        repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n")],
        "base",
        1,
    );
    // A tree diff reports the enclosing `src` directory alongside the file.
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[("src/lib.rs", "pub fn a() {}\npub fn b() {}\n")],
        "anchored",
        2,
    );
    let budget = EvalBudget::unbounded();
    assert!(
        compute_patch_id(repo, anchored, &budget).unwrap().is_some(),
        "a commit below the repository root has a patch identity"
    );
    let captures = captures_for(repo, &[anchored]);
    assert_eq!(
        captures[&anchored.to_string()].changed_paths,
        vec!["src/lib.rs".to_string()],
        "changed paths hold files, not enclosing directories"
    );

    let advanced = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("src/lib.rs", "pub fn a() {}\n"), ("README.md", "readme\n")],
        "advance",
        3,
    );
    let rebased = commit_snapshot(
        repo,
        "main",
        &[advanced],
        &[
            ("src/lib.rs", "pub fn a() {}\npub fn b() {}\n"),
            ("README.md", "readme\n"),
        ],
        "anchored",
        4,
    );
    let snapshot = checkout(&fixture, rebased);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Holds
    );
}

#[test]
fn mode_only_change_resolves_through_the_patch_id_rung() {
    use gix::objs::tree::EntryKind;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot_with_modes(
        repo,
        "main",
        &[],
        &[("run.sh", "echo hi\n", EntryKind::Blob)],
        "base",
        1,
    );
    // Content is unchanged; only the executable bit moves.
    let anchored = commit_snapshot_with_modes(
        repo,
        "topic",
        &[base],
        &[("run.sh", "echo hi\n", EntryKind::BlobExecutable)],
        "chmod",
        2,
    );
    let captures = captures_for(repo, &[anchored]);
    let advanced = commit_snapshot_with_modes(
        repo,
        "main",
        &[base],
        &[
            ("run.sh", "echo hi\n", EntryKind::Blob),
            ("other.txt", "other\n", EntryKind::Blob),
        ],
        "advance",
        3,
    );
    let rebased = commit_snapshot_with_modes(
        repo,
        "main",
        &[advanced],
        &[
            ("run.sh", "echo hi\n", EntryKind::BlobExecutable),
            ("other.txt", "other\n", EntryKind::Blob),
        ],
        "chmod",
        4,
    );
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, rebased);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Holds
    );
}

#[test]
fn capture_from_another_algorithm_version_is_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
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
    let mut captures = captures_for(repo, &[anchored]);
    let capture = captures.get_mut(&anchored.to_string()).unwrap();
    let patch_id = capture.patch_id.as_mut().expect("capture has a patch id");
    patch_id.algorithm = "mc-patch-id-v0".to_string();
    assert_ne!(patch_id.algorithm, PATCH_ID_ALGORITHM);

    let advanced = commit_snapshot(repo, "main", &[base], &[("f.txt", "two\n")], "advance", 3);
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, advanced);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Uncertain,
        "an unreadable fallback is not evidence the anchor moved"
    );
}

#[test]
fn rebase_merged_through_a_second_parent_still_resolves() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "topic change\n")],
        "anchored",
        2,
    );
    let captures = captures_for(repo, &[anchored]);
    let advanced = commit_snapshot(repo, "main", &[base], &[("f.txt", "two\n")], "advance", 3);
    // The rebased equivalent is reachable from HEAD only through the
    // merge's second parent.
    let rebased = commit_snapshot(
        repo,
        "feature",
        &[advanced],
        &[("f.txt", "two\n"), ("g.txt", "topic change\n")],
        "anchored",
        4,
    );
    let merge = commit_snapshot(
        repo,
        "main",
        &[advanced, rebased],
        &[("f.txt", "two\n"), ("g.txt", "topic change\n")],
        "merge",
        5,
    );

    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, merge);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Holds
    );
}

#[test]
fn exhausted_budget_makes_ancestry_verdicts_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let head = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "head", 1);
    let snapshot = checkout(&fixture, head);

    let exhausted = EvalBudget::unbounded();
    exhausted
        .interrupt_flag()
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let ladder = ResolutionLadder::new(&snapshot, &exhausted);
    // Anchor equal to HEAD would otherwise short-circuit to `Holds`.
    assert_eq!(
        ladder.evaluate(&reachable_from(head, BTreeMap::new())),
        GitConditionOutcome::Uncertain
    );
}

#[test]
fn unreachable_start_dominates_an_uncertain_end() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let start = commit_snapshot(repo, "other", &[], &[("f.txt", "one\n")], "start", 1);
    let head = commit_snapshot(repo, "main", &[], &[("g.txt", "g\n")], "head", 2);
    // An end OID absent from the odb resolves as uncertain.
    let missing_end = gix::ObjectId::from_hex("bb".repeat(20).as_bytes()).unwrap();

    let condition = GitCondition::ReachableBetween {
        start_oid: start.to_string(),
        end_oid: missing_end.to_string(),
        captures: BTreeMap::new(),
    };
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, head);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    // The unreachable start already falsifies the window.
    assert_eq!(
        ladder.evaluate(&condition),
        GitConditionOutcome::DoesNotHold { historical: false }
    );
}

#[test]
fn opposite_mode_transitions_have_distinct_patch_ids() {
    use gix::objs::tree::EntryKind;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();

    let plain = commit_snapshot_with_modes(
        repo,
        "a",
        &[],
        &[("run.sh", "echo hi\n", EntryKind::Blob)],
        "plain",
        1,
    );
    let to_exec = commit_snapshot_with_modes(
        repo,
        "a",
        &[plain],
        &[("run.sh", "echo hi\n", EntryKind::BlobExecutable)],
        "chmod +x",
        2,
    );
    let exec = commit_snapshot_with_modes(
        repo,
        "b",
        &[],
        &[("run.sh", "echo hi\n", EntryKind::BlobExecutable)],
        "exec",
        3,
    );
    let to_plain = commit_snapshot_with_modes(
        repo,
        "b",
        &[exec],
        &[("run.sh", "echo hi\n", EntryKind::Blob)],
        "chmod -x",
        4,
    );
    let add_exec = compute_patch_id(repo, to_exec, &budget).unwrap().unwrap();
    let drop_exec = compute_patch_id(repo, to_plain, &budget).unwrap().unwrap();
    assert_ne!(
        add_exec, drop_exec,
        "opposite mode-only transitions must not share an identity"
    );
}

#[test]
fn nul_bytes_do_not_alias_patch_identities() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();

    let base_one = commit_snapshot(repo, "x", &[], &[("f.bin", "a")], "base", 1);
    let mod_one = commit_snapshot(repo, "x", &[base_one], &[("f.bin", "\u{0}b")], "edit", 2);
    let base_two = commit_snapshot(repo, "y", &[], &[("f.bin", "a\u{0}")], "base", 3);
    let mod_two = commit_snapshot(repo, "y", &[base_two], &[("f.bin", "b")], "edit", 4);

    let one = compute_patch_id(repo, mod_one, &budget).unwrap().unwrap();
    let two = compute_patch_id(repo, mod_two, &budget).unwrap().unwrap();
    assert_ne!(one, two, "binary contents must be framed unambiguously");
}

#[test]
fn gitlink_changes_keep_a_patch_identity() {
    use gix::objs::tree::{Entry, EntryKind};

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);

    let blob = repo.write_blob(b"one\n").unwrap().detach();
    // The submodule commit OID is absent from the object database.
    let submodule = gix::ObjectId::from_hex("cc".repeat(20).as_bytes()).unwrap();
    let mut entries = vec![
        Entry {
            mode: EntryKind::Blob.into(),
            filename: "f.txt".into(),
            oid: blob,
        },
        Entry {
            mode: EntryKind::Commit.into(),
            filename: "sub".into(),
            oid: submodule,
        },
    ];
    entries.sort();
    let tree = repo
        .write_object(&gix::objs::Tree { entries })
        .unwrap()
        .detach();
    let child = commit_tree(repo, "main", &[base], tree, "add submodule", 2);

    let patch_id = compute_patch_id(repo, child, &budget).unwrap();
    assert!(
        patch_id.is_some(),
        "a submodule-pointer change has a patch identity"
    );
}

#[test]
fn old_algorithm_capture_still_resolves_through_the_tree_rung() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
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
    let mut captures = captures_for(repo, &[anchored]);
    captures
        .get_mut(&anchored.to_string())
        .unwrap()
        .patch_id
        .as_mut()
        .expect("capture has a patch id")
        .algorithm = "mc-patch-id-v0".to_string();

    // The reworded commit has an identical tree but a different OID.
    let reworded = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "change\n")],
        "reworded message",
        3,
    );
    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, reworded);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Holds,
        "the tree rung is algorithm-independent"
    );
}

#[test]
fn exhausted_budget_stops_patch_id_computation() {
    use mc_store::kernel::applicability::ResolveObstacle;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let child = commit_snapshot(repo, "main", &[base], &[("f.txt", "two\n")], "child", 2);

    let exhausted = EvalBudget::unbounded();
    exhausted
        .interrupt_flag()
        .store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        compute_patch_id(repo, child, &exhausted),
        Err(ResolveObstacle::BudgetExhausted)
    );
}

#[test]
fn non_utf8_changed_paths_do_not_block_patch_resolution() {
    use gix::bstr::BString;
    use gix::objs::tree::{Entry, EntryKind};

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);

    // The anchored commit adds only a file with a non-UTF-8 name.
    let tree_with = |extra_blob: gix::ObjectId, f_content: &str| {
        let f_blob = repo.write_blob(f_content.as_bytes()).unwrap().detach();
        let mut entries = vec![
            Entry {
                mode: EntryKind::Blob.into(),
                filename: "f.txt".into(),
                oid: f_blob,
            },
            Entry {
                mode: EntryKind::Blob.into(),
                filename: BString::from(&b"bad\xffname"[..]),
                oid: extra_blob,
            },
        ];
        entries.sort();
        repo.write_object(&gix::objs::Tree { entries })
            .unwrap()
            .detach()
    };
    let change_blob = repo.write_blob(b"topic change\n").unwrap().detach();
    let anchored = commit_tree(
        repo,
        "topic",
        &[base],
        tree_with(change_blob, "one\n"),
        "anchored",
        2,
    );
    let capture = capture_anchor_representation(repo, anchored, &budget).expect("capture builds");
    assert!(
        capture.changed_paths.is_empty(),
        "the non-UTF-8 location is dropped rather than stored lossily"
    );
    let mut captures = BTreeMap::new();
    captures.insert(capture.commit_oid.clone(), capture);

    // The rebased equivalent replays the same change onto a moved base.
    let advanced = commit_snapshot(repo, "main", &[base], &[("f.txt", "two\n")], "advance", 3);
    let rebased = commit_tree(
        repo,
        "main",
        &[advanced],
        tree_with(change_blob, "two\n"),
        "anchored",
        4,
    );
    let snapshot = checkout(&fixture, rebased);
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Holds,
        "an empty path prefilter falls back to pure patch-ID matching"
    );
}

#[test]
fn unreadable_candidate_blobs_leave_resolution_uncertain() {
    use mc_store::kernel::applicability::ResolveObstacle;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();
    let base = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "base", 1);
    let child = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("f.txt", "one\n"), ("g.txt", "unique payload\n")],
        "child",
        2,
    );

    // Deleting the loose blob simulates a partial clone with an unfetched
    // object.
    let blob = repo.write_blob(b"unique payload\n").unwrap().detach();
    let hex = blob.to_string();
    let object_path = repo
        .git_dir()
        .join("objects")
        .join(&hex[..2])
        .join(&hex[2..]);
    std::fs::remove_file(&object_path).expect("loose blob removable");

    assert_eq!(
        compute_patch_id(repo, child, &budget),
        Err(ResolveObstacle::UnreadableObject),
        "an unavailable blob is an obstacle, not a missing identity"
    );
}

#[test]
fn binary_contents_keep_whitespace_in_patch_identities() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let budget = EvalBudget::unbounded();

    // In binary content, whitespace bytes are data.
    let base_one = commit_snapshot(repo, "x", &[], &[("f.bin", "old")], "base", 1);
    let with_space = commit_snapshot(repo, "x", &[base_one], &[("f.bin", "\u{0}a b")], "edit", 2);
    let base_two = commit_snapshot(repo, "y", &[], &[("f.bin", "old")], "base", 3);
    let without_space = commit_snapshot(repo, "y", &[base_two], &[("f.bin", "\u{0}ab")], "edit", 4);

    let one = compute_patch_id(repo, with_space, &budget)
        .unwrap()
        .unwrap();
    let two = compute_patch_id(repo, without_space, &budget)
        .unwrap()
        .unwrap();
    assert_ne!(one, two, "binary blobs are hashed without normalization");
}

#[test]
fn patch_id_ignores_repository_diff_configuration() {
    use std::io::Write;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let base = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("a.txt", "shared content\n")],
        "base",
        1,
    );
    let renamed = commit_snapshot(
        &fixture.repo,
        "main",
        &[base],
        &[("b.txt", "shared content\n")],
        "rename",
        2,
    );
    let budget = EvalBudget::unbounded();
    let before = compute_patch_id(&fixture.repo, renamed, &budget)
        .unwrap()
        .expect("rename has a patch id");

    let mut config = std::fs::OpenOptions::new()
        .append(true)
        .open(fixture.repo.git_dir().join("config"))
        .expect("config opens");
    writeln!(config, "[diff]\n\trenames = false").expect("config writes");
    drop(config);

    let reopened = mc_store::kernel::applicability::open_isolated(&fixture.root)
        .expect("checkout reopens with the new config");
    let after = compute_patch_id(&reopened, renamed, &budget)
        .unwrap()
        .expect("rename still has a patch id");
    assert_eq!(before, after, "diff.renames does not shift the identity");
}

#[test]
fn kernel_store_sources_contain_no_subprocess_usage() {
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

/// Deletes the loose object backing `rela_path`'s enclosing tree in `commit`,
/// standing in for a partial clone that has a root tree without its subtree.
fn remove_subtree_object(fixture: &FixtureRepo, commit: gix::ObjectId, tree_path: &str) {
    let oid = fixture
        .repo
        .find_commit(commit)
        .expect("commit reads")
        .tree()
        .expect("tree reads")
        .lookup_entry_by_path(tree_path)
        .expect("lookup succeeds")
        .expect("subtree exists")
        .object_id();
    let hex = oid.to_string();
    let path = fixture
        .root
        .join(".git/objects")
        .join(&hex[..2])
        .join(&hex[2..]);
    std::fs::remove_file(&path).expect("loose object is removed");
}

#[test]
fn an_unreadable_captured_path_is_uncertain_not_unreachable() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("src/lib.rs", "a\n")], "base", 1);
    let anchored = commit_snapshot(
        repo,
        "topic",
        &[base],
        &[("src/lib.rs", "a\nb\n")],
        "anchored",
        2,
    );
    let captures = captures_for(repo, &[anchored]);
    assert_eq!(
        captures[&anchored.to_string()].changed_paths,
        vec!["src/lib.rs".to_string()]
    );

    let advanced = commit_snapshot(
        repo,
        "main",
        &[base],
        &[("src/lib.rs", "a\n"), ("README.md", "readme\n")],
        "advance",
        3,
    );
    // The rewrite of `anchored`, reachable from HEAD.
    let rebased = commit_snapshot(
        repo,
        "main",
        &[advanced],
        &[("src/lib.rs", "a\nb\n"), ("README.md", "readme\n")],
        "anchored",
        4,
    );
    // HEAD drops `src` entirely, so the status scan never reads a `src` tree
    // and the checkout snapshot survives the deletions below.
    let head = commit_snapshot(
        repo,
        "main",
        &[rebased],
        &[("README.md", "readme\n")],
        "drop src",
        5,
    );

    let budget = EvalBudget::unbounded();
    let intact = checkout(&fixture, head);
    assert_eq!(
        ResolutionLadder::new(&intact, &budget)
            .evaluate(&reachable_from(anchored, captures.clone())),
        GitConditionOutcome::Holds,
        "with every object present the patch rung finds the rewrite"
    );

    // Both sides of the captured path now live behind a missing subtree.
    remove_subtree_object(&fixture, rebased, "src");
    remove_subtree_object(&fixture, advanced, "src");

    let snapshot = snapshot_checkout(&fixture.root, &budget).expect("snapshot succeeds");
    // The anchor is still present, and the window is short enough to be
    // complete, so a swallowed lookup failure would read as a definite miss.
    assert_eq!(
        ResolutionLadder::new(&snapshot, &budget).evaluate(&reachable_from(anchored, captures)),
        GitConditionOutcome::Uncertain,
        "an unreadable captured path cannot yield a reachability verdict"
    );
}

#[test]
fn symlink_targets_are_not_whitespace_normalized() {
    use gix::objs::tree::EntryKind;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot_with_modes(
        repo,
        "main",
        &[],
        &[("link", "start", EntryKind::Link)],
        "base",
        1,
    );
    // A symlink target carries no NUL, so the binary sniff never fires and
    // these two targets differ only by whitespace.
    let spaced = commit_snapshot_with_modes(
        repo,
        "spaced",
        &[base],
        &[("link", "a b", EntryKind::Link)],
        "spaced",
        2,
    );
    let joined = commit_snapshot_with_modes(
        repo,
        "joined",
        &[base],
        &[("link", "ab", EntryKind::Link)],
        "joined",
        3,
    );

    let budget = EvalBudget::unbounded();
    let spaced_id = compute_patch_id(repo, spaced, &budget).unwrap().unwrap();
    let joined_id = compute_patch_id(repo, joined, &budget).unwrap().unwrap();
    assert_ne!(
        spaced_id, joined_id,
        "`a b` and `ab` are different link targets"
    );

    // A regular file keeps the normalization the identity relies on.
    let text_spaced = commit_snapshot(repo, "ts", &[base], &[("f.txt", "a b\n")], "ts", 4);
    let text_joined = commit_snapshot(repo, "tj", &[base], &[("f.txt", "ab\n")], "tj", 5);
    assert_eq!(
        compute_patch_id(repo, text_spaced, &budget).unwrap(),
        compute_patch_id(repo, text_joined, &budget).unwrap(),
        "text still ignores whitespace"
    );
}

#[test]
fn shallow_boundaries_make_negative_ancestry_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let base = commit_snapshot(repo, "main", &[], &[("a.txt", "a\n")], "base", 1);
    let head = commit_snapshot(repo, "main", &[base], &[("a.txt", "b\n")], "head", 2);
    // A commit on an unrelated branch is genuinely not an ancestor of HEAD.
    let foreign = commit_snapshot(repo, "other", &[], &[("z.txt", "z\n")], "foreign", 3);

    let budget = EvalBudget::unbounded();
    let complete = checkout(&fixture, head);
    assert_eq!(
        ResolutionLadder::new(&complete, &budget)
            .evaluate(&reachable_from(foreign, BTreeMap::new())),
        GitConditionOutcome::DoesNotHold { historical: false },
        "a complete history answers definitively"
    );

    // `.git/shallow` records grafted boundaries, and any non-empty file marks
    // the repository shallow, so every walk may stop short of real history.
    std::fs::write(fixture.root.join(".git/shallow"), format!("{base}\n")).unwrap();

    let shallow = snapshot_checkout(&fixture.root, &budget).expect("snapshot succeeds");
    assert_eq!(
        ResolutionLadder::new(&shallow, &budget)
            .evaluate(&reachable_from(foreign, BTreeMap::new())),
        GitConditionOutcome::Uncertain,
        "a truncated walk cannot prove non-ancestry"
    );
}

#[test]
fn sha256_length_anchors_stay_uncertain_on_a_sha1_build() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;
    let head = commit_snapshot(repo, "main", &[], &[("a.txt", "a\n")], "base", 1);

    let budget = EvalBudget::unbounded();
    let snapshot = checkout(&fixture, head);
    let ladder = ResolutionLadder::new(&snapshot, &budget);

    // The anchor vocabulary accepts 64-digit ids, and this build's gix carries
    // only the sha1 backend, so such an id never parses into an object.
    let sha256_oid = "ab".repeat(32);
    assert_eq!(sha256_oid.len(), 64);
    assert_eq!(
        ladder.evaluate(&GitCondition::ReachableFrom {
            oid: sha256_oid,
            captures: BTreeMap::new(),
        }),
        GitConditionOutcome::Uncertain,
        "an id this build cannot resolve is uncertain, never current"
    );
}
