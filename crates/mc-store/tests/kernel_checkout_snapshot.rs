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
fn untracked_directory_contents_change_the_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let budget = EvalBudget::unbounded();
    write_worktree_file(&fixture.repo, "scratch/one.txt", "one\n");
    let first = snapshot_checkout(dir.path(), &budget).unwrap();
    assert!(
        first.dirty_paths().contains("scratch/one.txt"),
        "{:?}",
        first.dirty_entries()
    );

    write_worktree_file(&fixture.repo, "scratch/one.txt", "edited\n");
    let edited = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        first.dirty_fingerprint(),
        edited.dirty_fingerprint(),
        "editing a file inside an untracked directory changes the key"
    );

    write_worktree_file(&fixture.repo, "scratch/two.txt", "two\n");
    let added = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(edited.dirty_fingerprint(), added.dirty_fingerprint());
}

#[cfg(unix)]
#[test]
fn symlinks_hash_their_target_without_reading_the_pointee() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    // A secret outside the worktree, of the kind a link could point at.
    let outside = dir.path().parent().unwrap().join("outside-secret");
    std::fs::write(&outside, "secret\n").unwrap();
    let workdir = fixture.repo.workdir().unwrap().to_path_buf();
    std::os::unix::fs::symlink(&outside, workdir.join("link")).unwrap();

    let budget = EvalBudget::unbounded();
    let snapshot = snapshot_checkout(dir.path(), &budget).unwrap();
    let entry = snapshot
        .dirty_entries()
        .iter()
        .find(|entry| entry.path == "link")
        .expect("the symlink is dirty");
    assert!(entry.content_hash.starts_with("symlink:"), "{entry:?}");

    // Rewriting the pointee leaves the entry alone; the target path decides.
    std::fs::write(&outside, "secret changed\n").unwrap();
    let unchanged = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_eq!(
        snapshot.dirty_fingerprint(),
        unchanged.dirty_fingerprint(),
        "the pointee's content is never hashed"
    );
}

#[test]
fn large_files_are_content_hashed_so_same_length_edits_differ() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let mut big = vec![b'x'; 33 * 1024 * 1024];
    let workdir = fixture.repo.workdir().unwrap().to_path_buf();
    std::fs::write(workdir.join("big.bin"), &big).unwrap();
    let first = snapshot_checkout(dir.path(), &EvalBudget::unbounded()).unwrap();

    // A same-length edit must change the fingerprint; a length token
    // would alias the two contents.
    big[0] = b'y';
    std::fs::write(workdir.join("big.bin"), &big).unwrap();
    let edited = snapshot_checkout(dir.path(), &EvalBudget::unbounded()).unwrap();
    assert_ne!(first.dirty_fingerprint(), edited.dirty_fingerprint());
}

#[cfg(unix)]
#[test]
fn symlinked_parent_directories_cannot_escape_the_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path().join("repo").as_path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "secret\n").unwrap();
    let workdir = fixture.repo.workdir().unwrap().to_path_buf();
    std::os::unix::fs::symlink(&outside, workdir.join("link")).unwrap();

    let snapshot = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    assert!(
        snapshot.worktree_path("link/secret.txt").is_none(),
        "a symlinked ancestor escapes the worktree"
    );
    // The symlink itself stays addressable; only traversal through it is
    // rejected.
    assert!(snapshot.worktree_path("link").is_some());
}

#[test]
fn conflict_stage_changes_alter_the_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("f.txt", "one\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    write_conflicted_index_entry(&fixture.repo, "f.txt", "base\n", "ours\n", "theirs\n");
    let budget = EvalBudget::unbounded();
    let first = snapshot_checkout(dir.path(), &budget).unwrap();

    // Swap only the staged conflict blobs; the worktree file is untouched.
    write_conflicted_index_entry(&fixture.repo, "f.txt", "base\n", "ours\n", "theirs v2\n");
    let restaged = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(first.dirty_fingerprint(), restaged.dirty_fingerprint());
}

#[test]
fn worktree_path_rejects_paths_outside_the_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let snapshot = snapshot_checkout(dir.path(), &EvalBudget::unbounded()).unwrap();
    assert!(snapshot.worktree_path("a.txt").is_some());
    assert!(snapshot.worktree_path("nested/a.txt").is_some());
    for escaping in ["/etc/passwd", "../outside", "nested/../../outside", ""] {
        assert!(
            snapshot.worktree_path(escaping).is_none(),
            "{escaping} escapes the worktree"
        );
    }
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
