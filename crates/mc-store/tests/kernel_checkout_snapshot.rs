//! Checkout snapshot proofs: identity, HEAD, dirty fingerprints, interrupt
//! behavior, and the gix-built fixture kit itself.

#[path = "support/git_fixtures.rs"]
mod git_fixtures;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use git_fixtures::{
    add_linked_worktree, commit_snapshot, init_repo, materialize, set_head,
    write_conflicted_index_entry, write_worktree_file,
};
use mc_store::kernel::applicability::{snapshot_checkout, EvalBudget, SnapshotError};

#[test]
fn clean_repo_has_stable_fingerprint_and_content_changes_it() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n"), ("README.md", "readme\n")],
        "seed",
        1,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let budget = EvalBudget::unbounded();
    let clean = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_eq!(clean.head(), head.to_string());
    assert!(
        clean.dirty_entries().is_empty(),
        "{:?}",
        clean.dirty_entries()
    );
    let again = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_eq!(clean.dirty_fingerprint(), again.dirty_fingerprint());

    write_worktree_file(&fixture.repo, "src/lib.rs", "pub fn a() { /* edited */ }\n");
    let modified = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(clean.dirty_fingerprint(), modified.dirty_fingerprint());
    assert!(modified.dirty_paths().contains("src/lib.rs"));

    write_worktree_file(&fixture.repo, "notes.txt", "untracked\n");
    let untracked = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(modified.dirty_fingerprint(), untracked.dirty_fingerprint());
    assert!(untracked.dirty_paths().contains("notes.txt"));

    write_conflicted_index_entry(&fixture.repo, "src/lib.rs", "base\n", "ours\n", "theirs\n");
    let conflicted = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        untracked.dirty_fingerprint(),
        conflicted.dirty_fingerprint()
    );
    assert!(conflicted
        .dirty_entries()
        .iter()
        .any(|entry| entry.path == "src/lib.rs" && entry.status == "conflicted"));
}

#[test]
fn linked_worktree_has_distinct_identity_and_own_head() {
    let dir = tempfile::tempdir().unwrap();
    let main_root = dir.path().join("main");
    let fixture = init_repo(&main_root);
    let base = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "base", 1);
    let feature = commit_snapshot(
        &fixture.repo,
        "feature",
        &[base],
        &[("a.txt", "a\n"), ("b.txt", "b\n")],
        "feature",
        2,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, base);

    let worktree_root = dir.path().join("linked");
    let linked = add_linked_worktree(&fixture, "linked", &worktree_root, "feature");
    materialize(&linked.repo, feature);

    let budget = EvalBudget::unbounded();
    let main_snapshot = snapshot_checkout(&main_root, &budget).unwrap();
    let linked_snapshot = snapshot_checkout(&worktree_root, &budget).unwrap();
    assert_ne!(main_snapshot.identity(), linked_snapshot.identity());
    assert_eq!(main_snapshot.head(), base.to_string());
    assert_eq!(linked_snapshot.head(), feature.to_string());
    assert!(linked_snapshot.dirty_entries().is_empty());
}

#[test]
fn interrupt_and_deadline_yield_typed_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let interrupted = EvalBudget::unbounded();
    interrupted.interrupt_flag().store(true, Ordering::Relaxed);
    assert_eq!(
        snapshot_checkout(dir.path(), &interrupted).unwrap_err(),
        SnapshotError::BudgetExhausted
    );

    let expired = EvalBudget::new(
        Some(Instant::now() - Duration::from_millis(1)),
        Default::default(),
    );
    assert_eq!(
        snapshot_checkout(dir.path(), &expired).unwrap_err(),
        SnapshotError::BudgetExhausted
    );
}

#[test]
fn fixture_kit_builds_branched_rebase_and_cherry_pick_histories() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let repo = &fixture.repo;

    // Linear history on main.
    let a = commit_snapshot(repo, "main", &[], &[("f.txt", "one\n")], "a", 1);
    let b = commit_snapshot(repo, "main", &[a], &[("f.txt", "two\n")], "b", 2);

    // Branch with an extra commit.
    let c = commit_snapshot(
        repo,
        "topic",
        &[b],
        &[("f.txt", "two\n"), ("g.txt", "topic\n")],
        "c",
        3,
    );

    // Rebase-shaped rewrite: the same logical change re-parented onto a new
    // base commit, written directly.
    let new_base = commit_snapshot(repo, "main", &[b], &[("f.txt", "three\n")], "d", 4);
    let c_rebased = commit_snapshot(
        repo,
        "topic-rebased",
        &[new_base],
        &[("f.txt", "three\n"), ("g.txt", "topic\n")],
        "c",
        5,
    );

    // Cherry-pick-shaped duplicate of the same change onto another branch.
    let c_picked = commit_snapshot(
        repo,
        "release",
        &[a],
        &[("f.txt", "one\n"), ("g.txt", "topic\n")],
        "c",
        6,
    );

    let parents = |commit: gix::ObjectId| -> Vec<gix::ObjectId> {
        repo.find_commit(commit)
            .unwrap()
            .parent_ids()
            .map(|id| id.detach())
            .collect()
    };
    assert_eq!(parents(b), vec![a]);
    assert_eq!(parents(c), vec![b]);
    assert_eq!(parents(c_rebased), vec![new_base]);
    assert_eq!(parents(c_picked), vec![a]);
    assert_ne!(c, c_rebased);
    assert_ne!(c, c_picked);

    // All five refs resolve to their tips.
    for (branch, tip) in [
        ("main", new_base),
        ("topic", c),
        ("topic-rebased", c_rebased),
        ("release", c_picked),
    ] {
        let resolved = repo
            .find_reference(&format!("refs/heads/{branch}"))
            .unwrap()
            .id()
            .detach();
        assert_eq!(resolved, tip, "branch {branch}");
    }
}
