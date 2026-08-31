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
fn staged_entry_modes_distinguish_file_kinds() {
    use gix::index::entry::{Flags, Mode, Stat};

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let stage = |mode: Mode| {
        let mut index = fixture.repo.open_index().expect("index opens");
        index.remove_entries(|_, path, _| path == "link");
        let blob = fixture
            .repo
            .write_blob(b"target")
            .expect("blob writes")
            .detach();
        index.dangerously_push_entry(Stat::default(), blob, Flags::empty(), mode, "link".into());
        index.sort_entries();
        index
            .write(gix::index::write::Options::default())
            .expect("index writes");
    };
    let staged_hash = |snapshot: &mc_store::kernel::applicability::CheckoutSnapshot| {
        snapshot
            .dirty_entries()
            .iter()
            .find(|entry| entry.path == "link" && entry.status == "staged_added")
            .expect("staged entry present")
            .content_hash
            .clone()
    };

    let budget = EvalBudget::unbounded();
    stage(Mode::FILE);
    let as_file = snapshot_checkout(dir.path(), &budget).unwrap();
    stage(Mode::SYMLINK);
    let as_symlink = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        staged_hash(&as_file),
        staged_hash(&as_symlink),
        "one blob staged under two file kinds must produce distinct entries"
    );
}

#[test]
fn assume_valid_entries_are_content_hashed() {
    use gix::index::entry::Flags;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("trusted.txt", "original\n")],
        "seed",
        1,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let mut index = fixture.repo.open_index().expect("index opens");
    let position = index
        .entry_index_by_path("trusted.txt".into())
        .expect("entry exists");
    index.entries_mut()[position].flags |= Flags::ASSUME_VALID;
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");

    let budget = EvalBudget::unbounded();
    let before = snapshot_checkout(dir.path(), &budget).unwrap();
    assert!(before
        .dirty_entries()
        .iter()
        .any(|entry| entry.path == "trusted.txt" && entry.status == "assume_valid"));

    // The status walk trusts the flag; the content hash detects changes to
    // assume-valid files.
    write_worktree_file(&fixture.repo, "trusted.txt", "edited\n");
    let after = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        before.dirty_fingerprint(),
        after.dirty_fingerprint(),
        "editing an assume-valid file changes the key"
    );
}

#[test]
fn dirty_submodules_fingerprint_their_head() {
    use gix::index::entry::{Flags, Mode, Stat};

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path().join("parent").as_path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    // A nested repository represents a checked-out submodule.
    let workdir = fixture.repo.workdir().unwrap().to_path_buf();
    let sub = init_repo(workdir.join("sub").as_path());
    let sub_one = commit_snapshot(&sub.repo, "main", &[], &[("inner.txt", "one\n")], "one", 1);
    git_fixtures::set_head(&sub.repo, "main");
    materialize(&sub.repo, sub_one);

    // Track the gitlink at a stale commit so the scan reports it dirty.
    let stale = gix::ObjectId::from_hex("dd".repeat(20).as_bytes()).unwrap();
    let mut index = fixture.repo.open_index().expect("index opens");
    index.dangerously_push_entry(
        Stat::default(),
        stale,
        Flags::empty(),
        Mode::COMMIT,
        "sub".into(),
    );
    index.sort_entries();
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");
    // Submodule status participation requires a `.gitmodules` entry.
    write_worktree_file(
        &fixture.repo,
        ".gitmodules",
        "[submodule \"sub\"]\n\tpath = sub\n\turl = ./sub\n",
    );

    let budget = EvalBudget::unbounded();
    let first = snapshot_checkout(&fixture.root, &budget).unwrap();
    let gitlink_hash = |snapshot: &mc_store::kernel::applicability::CheckoutSnapshot| {
        snapshot
            .dirty_entries()
            .iter()
            .find(|entry| entry.path == "sub" && entry.content_hash.starts_with("gitlink:"))
            .map(|entry| entry.content_hash.clone())
    };
    let first_hash = gitlink_hash(&first).expect("dirty gitlink is hashed by submodule HEAD");
    assert!(first_hash.starts_with(&format!("gitlink:{sub_one}:")));

    // Moving the submodule HEAD moves the fingerprint.
    let sub_two = commit_snapshot(
        &sub.repo,
        "main",
        &[sub_one],
        &[("inner.txt", "two\n")],
        "two",
        2,
    );
    materialize(&sub.repo, sub_two);
    let second = snapshot_checkout(&fixture.root, &budget).unwrap();
    assert!(gitlink_hash(&second)
        .expect("gitlink stays dirty")
        .starts_with(&format!("gitlink:{sub_two}:")));
    assert_ne!(first.dirty_fingerprint(), second.dirty_fingerprint());
}

#[cfg(unix)]
#[test]
fn assume_valid_mode_changes_alter_the_fingerprint() {
    use gix::index::entry::Flags;
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("trusted.sh", "echo hi\n")],
        "seed",
        1,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let mut index = fixture.repo.open_index().expect("index opens");
    let position = index
        .entry_index_by_path("trusted.sh".into())
        .expect("entry exists");
    index.entries_mut()[position].flags |= Flags::ASSUME_VALID;
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");

    let budget = EvalBudget::unbounded();
    let before = snapshot_checkout(dir.path(), &budget).unwrap();

    // The bytes stay equal; only the executable bit moves.
    let file = fixture.repo.workdir().unwrap().join("trusted.sh");
    let mut permissions = std::fs::metadata(&file).unwrap().permissions();
    permissions.set_mode(permissions.mode() | 0o111);
    std::fs::set_permissions(&file, permissions).unwrap();

    let after = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        before.dirty_fingerprint(),
        after.dirty_fingerprint(),
        "chmod on an assume-valid file changes the key"
    );
}

#[test]
fn sparse_checkout_state_alters_the_fingerprint() {
    use std::io::Write;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("a.txt", "a\n"), ("sub/b.txt", "b\n")],
        "seed",
        1,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let budget = EvalBudget::unbounded();
    let dense = snapshot_checkout(dir.path(), &budget).unwrap();

    let git_dir = fixture.repo.git_dir().to_path_buf();
    let mut config = std::fs::OpenOptions::new()
        .append(true)
        .open(git_dir.join("config"))
        .expect("config opens");
    writeln!(config, "[core]\n\tsparseCheckout = true").expect("config writes");
    drop(config);
    std::fs::create_dir_all(git_dir.join("info")).expect("info dir creatable");
    std::fs::write(git_dir.join("info/sparse-checkout"), "/a.txt\n").expect("patterns write");

    let sparse = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        dense.dirty_fingerprint(),
        sparse.dirty_fingerprint(),
        "enabling sparse checkout changes the key"
    );

    std::fs::write(git_dir.join("info/sparse-checkout"), "/sub/\n").expect("patterns rewrite");
    let other_layout = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        sparse.dirty_fingerprint(),
        other_layout.dirty_fingerprint(),
        "switching sparse layouts changes the key"
    );
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

#[test]
fn submodule_worktree_edits_move_the_gitlink_hash() {
    use gix::index::entry::{Flags, Mode, Stat};

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path().join("parent").as_path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let workdir = fixture.repo.workdir().unwrap().to_path_buf();
    let sub = init_repo(workdir.join("sub").as_path());
    let sub_one = commit_snapshot(&sub.repo, "main", &[], &[("inner.txt", "one\n")], "one", 1);
    git_fixtures::set_head(&sub.repo, "main");
    materialize(&sub.repo, sub_one);

    let stale = gix::ObjectId::from_hex("dd".repeat(20).as_bytes()).unwrap();
    let mut index = fixture.repo.open_index().expect("index opens");
    index.dangerously_push_entry(
        Stat::default(),
        stale,
        Flags::empty(),
        Mode::COMMIT,
        "sub".into(),
    );
    index.sort_entries();
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");
    write_worktree_file(
        &fixture.repo,
        ".gitmodules",
        "[submodule \"sub\"]\n\tpath = sub\n\turl = ./sub\n",
    );

    let budget = EvalBudget::unbounded();
    let before = snapshot_checkout(&fixture.root, &budget).unwrap();

    // The submodule HEAD holds still while its worktree content changes, so
    // a HEAD-only gitlink hash would keep the superproject key stable.
    write_worktree_file(&sub.repo, "inner.txt", "edited\n");
    let after = snapshot_checkout(&fixture.root, &budget).unwrap();
    assert_ne!(
        before.dirty_fingerprint(),
        after.dirty_fingerprint(),
        "an edit under the submodule path must move the key"
    );

    let gitlink = |snapshot: &mc_store::kernel::applicability::CheckoutSnapshot| {
        snapshot
            .dirty_entries()
            .iter()
            .find(|entry| entry.path == "sub" && entry.content_hash.starts_with("gitlink:"))
            .map(|entry| entry.content_hash.clone())
            .expect("dirty gitlink is hashed")
    };
    let prefix = format!("gitlink:{sub_one}:");
    assert!(gitlink(&before).starts_with(&prefix));
    assert!(gitlink(&after).starts_with(&prefix));
    assert_ne!(gitlink(&before), gitlink(&after));
}

#[test]
fn skip_worktree_entries_key_their_materialization() {
    use gix::index::entry::Flags;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("sparse.txt", "content\n")],
        "seed",
        1,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let budget = EvalBudget::unbounded();
    let materialized = snapshot_checkout(dir.path(), &budget).unwrap();

    // `git update-index --skip-worktree` marks the entry index-only, and the
    // status scan then stays clean whether or not the file is on disk.
    let mut index = fixture.repo.open_index().expect("index opens");
    let position = index
        .entry_index_by_path("sparse.txt".into())
        .expect("entry exists");
    // gix serializes the extended flags only for a V3 index, which it
    // selects from `EXTENDED` being present.
    index.entries_mut()[position].flags |= Flags::SKIP_WORKTREE | Flags::EXTENDED;
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");
    std::fs::remove_file(fixture.repo.workdir().unwrap().join("sparse.txt")).unwrap();

    let index_only = snapshot_checkout(dir.path(), &budget).unwrap();
    assert!(
        index_only
            .dirty_entries()
            .iter()
            .any(|entry| entry.path == "sparse.txt" && entry.status == "skip_worktree"),
        "{:?}",
        index_only.dirty_entries()
    );
    assert_ne!(
        materialized.dirty_fingerprint(),
        index_only.dirty_fingerprint(),
        "an absent skip-worktree file must not key like a present one"
    );

    // Restoring the file under the same flag is a third distinct layout.
    write_worktree_file(&fixture.repo, "sparse.txt", "content\n");
    let restored = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        index_only.dirty_fingerprint(),
        restored.dirty_fingerprint(),
        "materializing a skip-worktree file must move the key"
    );
}

#[cfg(unix)]
#[test]
fn a_utf8_name_cannot_alias_a_non_utf8_path() {
    use std::os::unix::ffi::OsStrExt;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);
    let workdir = fixture.repo.workdir().unwrap().to_path_buf();

    // The lossy rendering of this byte path, plus the digest suffix the
    // encoder appends, is a name a repository can hold verbatim.
    let raw = b"\xff";
    let lossy_twin = format!(
        "{}#x{:x}",
        String::from_utf8_lossy(raw),
        <sha2::Sha256 as sha2::Digest>::digest(raw)
    );

    let budget = EvalBudget::unbounded();
    std::fs::write(
        workdir.join(std::ffi::OsStr::from_bytes(raw)),
        "same bytes\n",
    )
    .unwrap();
    let byte_path = snapshot_checkout(dir.path(), &budget).unwrap();
    std::fs::remove_file(workdir.join(std::ffi::OsStr::from_bytes(raw))).unwrap();

    std::fs::write(workdir.join(&lossy_twin), "same bytes\n").unwrap();
    let utf8_twin = snapshot_checkout(dir.path(), &budget).unwrap();

    assert_eq!(
        byte_path.dirty_entries().len(),
        utf8_twin.dirty_entries().len(),
        "both checkouts hold one untracked file"
    );
    assert_ne!(
        byte_path.dirty_fingerprint(),
        utf8_twin.dirty_fingerprint(),
        "a UTF-8 name spelled like a lossy rendering must key differently"
    );
}

#[cfg(unix)]
#[test]
fn unreadable_sparse_patterns_fail_the_scan() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let info = fixture.repo.git_dir().join("info");
    std::fs::create_dir_all(&info).unwrap();
    let patterns = info.join("sparse-checkout");
    std::fs::write(&patterns, "/*\n!/vendor/\n").unwrap();
    std::fs::set_permissions(&patterns, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&patterns).is_ok() {
        // A privileged test process ignores the mode bits.
        return;
    }

    let budget = EvalBudget::unbounded();
    // A pattern set that cannot be read leaves the materialized layout
    // unknown, so no snapshot may key as though there were no patterns.
    assert!(matches!(
        snapshot_checkout(dir.path(), &budget),
        Err(SnapshotError::Scan(_))
    ));

    std::fs::set_permissions(&patterns, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(snapshot_checkout(dir.path(), &budget).is_ok());
}

#[test]
fn large_sparse_pattern_files_key_by_content() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let info = fixture.repo.git_dir().join("info");
    std::fs::create_dir_all(&info).unwrap();
    let patterns = info.join("sparse-checkout");
    // Several hash chunks worth of patterns, folded in incrementally rather
    // than held whole.
    let bulk: String = (0..40_000).map(|n| format!("/dir{n}/\n")).collect();
    std::fs::write(&patterns, &bulk).unwrap();

    let budget = EvalBudget::unbounded();
    let first = snapshot_checkout(dir.path(), &budget).unwrap();
    let again = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_eq!(first.dirty_fingerprint(), again.dirty_fingerprint());

    // A change in the final chunk still reaches the digest.
    std::fs::write(&patterns, format!("{bulk}/last/\n")).unwrap();
    let changed = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(first.dirty_fingerprint(), changed.dirty_fingerprint());
}

#[test]
fn a_finite_deadline_does_not_add_watchdog_latency() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "seed", 1);
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    const ROUNDS: u32 = 6;
    let baseline = Instant::now();
    for _ in 0..ROUNDS {
        snapshot_checkout(dir.path(), &EvalBudget::unbounded()).unwrap();
    }
    let unarmed = baseline.elapsed();

    let armed_start = Instant::now();
    for _ in 0..ROUNDS {
        // Far enough out that the deadline never fires; only the watchdog's
        // own teardown separates this from the unbounded case.
        let budget = EvalBudget::new(
            Some(Instant::now() + Duration::from_secs(30)),
            Default::default(),
        );
        snapshot_checkout(dir.path(), &budget).unwrap();
    }
    let armed = armed_start.elapsed();

    // A watchdog that cannot be woken adds the remainder of a 25 ms nap per
    // snapshot. The bound is loose enough to survive a loaded machine while
    // still failing on a per-snapshot quantum of that size.
    let ceiling = unarmed + Duration::from_millis(15) * ROUNDS;
    assert!(
        armed < ceiling,
        "armed {armed:?} exceeded {ceiling:?} (unbounded baseline {unarmed:?})"
    );
}

#[test]
fn shallow_boundaries_alter_the_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let base = commit_snapshot(&fixture.repo, "main", &[], &[("a.txt", "a\n")], "base", 1);
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[base],
        &[("a.txt", "b\n")],
        "head",
        2,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);

    let budget = EvalBudget::unbounded();
    let complete = snapshot_checkout(dir.path(), &budget).unwrap();

    // Resolution branches on the shallow boundary, so it has to reach the
    // generation: HEAD and the worktree are untouched here.
    let shallow_file = fixture.root.join(".git/shallow");
    std::fs::write(&shallow_file, format!("{base}\n")).unwrap();
    let shallow = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_ne!(
        complete.dirty_fingerprint(),
        shallow.dirty_fingerprint(),
        "becoming shallow must move the key"
    );

    // Unshallowing has to move it back rather than reuse the shallow verdict.
    std::fs::remove_file(&shallow_file).unwrap();
    let unshallowed = snapshot_checkout(dir.path(), &budget).unwrap();
    assert_eq!(
        complete.dirty_fingerprint(),
        unshallowed.dirty_fingerprint()
    );
}
