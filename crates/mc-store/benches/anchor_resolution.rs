//! Criterion benches for the mc-store anchor-resolution kernel. commentlint: allow(JUDGE)
//!
//! See `docs/perf/mc-store-anchor-resolution.md` for the estimand, corpus,
//! cell table, and comparison protocol. commentlint: allow(JUDGE)
//! Each cell asserts its intended resolution rung before timing. Fixture
//! drift fails the benchmark instead of timing a cheaper resolution rung.
//!
//! Run with `cargo bench -p mc-store --bench anchor_resolution`.

#[path = "../tests/support/git_fixtures.rs"]
mod git_fixtures;

use std::collections::BTreeMap;
use std::hint::black_box;
use std::time::Duration;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use git_fixtures::{
    commit_snapshot, init_repo, materialize, set_head_detached, write_worktree_file, FixtureRepo,
};
use gix::ObjectId;
use mc_store::kernel::applicability::{
    capture_anchor_representation, snapshot_checkout, CheckoutSnapshot, EvalBudget,
    GitConditionOutcome, ResolutionLadder, CANDIDATE_WINDOW,
};
use mc_store::kernel::{AnchorCapture, GitCondition};

/// Tracked-file count committed by every `snapshot` cell. Only the dirty
/// state varies across cells.
const TRACKED_FILES: usize = 100;

/// ~230 bytes of deterministic content, distinct per (file, generation). commentlint: allow(JUDGE)
/// A generation bump rewrites every line, changing the stored bytes. commentlint: allow(JUDGE)
fn tracked_file_body(index: usize, generation: usize) -> String {
    let mut body = String::with_capacity(256);
    for line in 0..4 {
        body.push_str(&format!(
            "file {index:03} gen {generation} line {line} 0123456789abcdefghijklmnopqrstuvwxyz\n"
        ));
    }
    body
}

/// `materialize` rebuilds the index from the tree with default stat data; commentlint: allow(JUDGE)
/// every snapshot therefore rehashes all tracked files to prove them commentlint: allow(JUDGE)
/// unchanged, the worst-case stat-invalidated scan. commentlint: allow(JUDGE)
fn snapshot_fixture(modified: usize) -> (tempfile::TempDir, FixtureRepo) {
    assert!(modified <= TRACKED_FILES);
    let dir = tempfile::tempdir().expect("bench fixture dir");
    let fixture = init_repo(dir.path());
    let files: Vec<(String, String)> = (0..TRACKED_FILES)
        .map(|index| (format!("src/file_{index:03}.txt"), tracked_file_body(index, 0)))
        .collect();
    let file_refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(path, content)| (path.as_str(), content.as_str()))
        .collect();
    let head = commit_snapshot(&fixture.repo, "main", &[], &file_refs, "seed", 1);
    set_head_detached(&fixture.repo, head);
    materialize(&fixture.repo, head);
    for index in 0..modified {
        write_worktree_file(
            &fixture.repo,
            &format!("src/file_{index:03}.txt"),
            &tracked_file_body(index, 1),
        );
    }
    (dir, fixture)
}

fn assert_snapshot_shape(root: &std::path::Path, budget: &EvalBudget, cell: &str, dirty: usize) {
    let snapshot = snapshot_checkout(root, budget).expect("snapshot succeeds");
    assert_eq!(
        snapshot.dirty_entries().len(),
        dirty,
        "{cell}: dirty entry count, got {:?}",
        snapshot.dirty_entries()
    );
}

fn bench_snapshot(c: &mut Criterion) {
    let mut group = c.benchmark_group("snapshot");
    group.sample_size(20);
    group.measurement_time(Duration::from_secs(5));
    let budget = EvalBudget::unbounded();

    for &modified in &[0usize, 10, 100] {
        let cell = format!("dirty_{modified:03}");
        let (dir, _fixture) = snapshot_fixture(modified);
        assert_snapshot_shape(dir.path(), &budget, &cell, modified);
        group.bench_function(BenchmarkId::from_parameter(&cell), |b| {
            b.iter_batched(
                || (),
                // Returning the snapshot as batch output keeps the drop of commentlint: allow(JUDGE)
                // its open repository handle outside the timed section. commentlint: allow(JUDGE)
                |()| snapshot_checkout(black_box(dir.path()), &budget).expect("snapshot succeeds"),
                criterion::BatchSize::PerIteration,
            )
        });
    }

    // One untracked 4 MiB file on top of the clean fixture: the scan hashes commentlint: allow(JUDGE)
    // the full content to build the dirty fingerprint. commentlint: allow(JUDGE)
    let (dir, fixture) = snapshot_fixture(0);
    let large = "0123456789abcdef".repeat(4 * 1024 * 1024 / 16);
    write_worktree_file(&fixture.repo, "blob.bin", &large);
    let snapshot = snapshot_checkout(dir.path(), &budget).expect("snapshot succeeds");
    assert_eq!(
        snapshot.dirty_entries().len(),
        1,
        "dirty_large_4mib: exactly the untracked blob, got {:?}",
        snapshot.dirty_entries()
    );
    assert_eq!(snapshot.dirty_entries()[0].status, "untracked");
    drop(snapshot);
    group.bench_function(BenchmarkId::from_parameter("dirty_large_4mib"), |b| {
        b.iter_batched(
            || (),
            |()| snapshot_checkout(black_box(dir.path()), &budget).expect("snapshot succeeds"),
            criterion::BatchSize::PerIteration,
        )
    });
    group.finish();
}

/// One `evaluate` cell: a frozen snapshot plus the condition it times. commentlint: allow(JUDGE)
/// The tempdir and fixture keep the repository alive for the cell's life. commentlint: allow(JUDGE)
struct EvaluateCell {
    _dir: tempfile::TempDir,
    _fixture: FixtureRepo,
    snapshot: CheckoutSnapshot,
    condition: GitCondition,
}

fn checkout(fixture: &FixtureRepo, commit: ObjectId, budget: &EvalBudget) -> CheckoutSnapshot {
    set_head_detached(&fixture.repo, commit);
    materialize(&fixture.repo, commit);
    snapshot_checkout(&fixture.root, budget).expect("snapshot succeeds")
}

fn reachable_from(oid: ObjectId, captures: BTreeMap<String, AnchorCapture>) -> GitCondition {
    GitCondition::ReachableFrom {
        oid: oid.to_string(),
        captures,
    }
}

/// Appends `count` commits to `branch`, each changing only `filler.txt` commentlint: allow(JUDGE)
/// while `constant_files` stay byte-identical; consecutive trees differ in commentlint: allow(JUDGE)
/// exactly one path. Timestamps start at `seconds` and increment. commentlint: allow(JUDGE)
fn append_filler_commits(
    repo: &gix::Repository,
    branch: &str,
    mut tip: ObjectId,
    constant_files: &[(&str, &str)],
    count: usize,
    seconds: i64,
) -> Vec<ObjectId> {
    let mut commits = Vec::with_capacity(count);
    for index in 0..count {
        let filler = format!("filler {seconds}+{index}\n");
        let mut files: Vec<(&str, &str)> = constant_files.to_vec();
        files.push(("filler.txt", filler.as_str()));
        tip = commit_snapshot(
            repo,
            branch,
            &[tip],
            &files,
            "filler",
            seconds + index as i64,
        );
        commits.push(tip);
    }
    commits
}

/// Linear 64-commit history with the root commit as anchor: each cold commentlint: allow(JUDGE)
/// evaluation walks the full ancestry from HEAD before answering Holds. commentlint: allow(JUDGE)
/// With no captures the window rungs cannot fire; Holds proves the ancestry commentlint: allow(JUDGE)
/// rung decided. commentlint: allow(JUDGE)
fn exact_reachable_cell(budget: &EvalBudget) -> EvaluateCell {
    let dir = tempfile::tempdir().expect("bench fixture dir");
    let fixture = init_repo(dir.path());
    let root = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("f.txt", "one\n"), ("filler.txt", "filler root\n")],
        "root",
        1,
    );
    let chain = append_filler_commits(&fixture.repo, "main", root, &[("f.txt", "one\n")], 63, 2);
    let head = *chain.last().expect("chain is non-empty");
    let snapshot = checkout(&fixture, head, budget);
    let condition = reachable_from(root, BTreeMap::new());
    let ladder = ResolutionLadder::new(&snapshot, budget);
    assert_eq!(
        ladder.evaluate(&condition),
        GitConditionOutcome::Holds,
        "exact_reachable: root anchor must hold via ancestry"
    );
    drop(ladder);
    EvaluateCell {
        _dir: dir,
        _fixture: fixture,
        snapshot,
        condition,
    }
}

/// The anchor commit sits on an abandoned side branch, never merged: commentlint: allow(JUDGE)
/// present in the odb but unreachable from HEAD. With no captures the commentlint: allow(JUDGE)
/// window rungs are skipped; the cell times a pure negative ancestry walk. commentlint: allow(JUDGE)
fn ancestry_negative_cell(budget: &EvalBudget) -> EvaluateCell {
    let dir = tempfile::tempdir().expect("bench fixture dir");
    let fixture = init_repo(dir.path());
    let root = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("f.txt", "one\n"), ("filler.txt", "filler root\n")],
        "root",
        1,
    );
    let abandoned = commit_snapshot(
        &fixture.repo,
        "abandoned",
        &[root],
        &[
            ("f.txt", "one\n"),
            ("filler.txt", "filler root\n"),
            ("side.txt", "side change\n"),
        ],
        "abandoned",
        2,
    );
    let chain = append_filler_commits(&fixture.repo, "main", root, &[("f.txt", "one\n")], 63, 3);
    let head = *chain.last().expect("chain is non-empty");
    let snapshot = checkout(&fixture, head, budget);
    assert!(
        fixture.repo.find_commit(abandoned).is_ok(),
        "ancestry_negative: anchor must be present in the odb"
    );
    let condition = reachable_from(abandoned, BTreeMap::new());
    let ladder = ResolutionLadder::new(&snapshot, budget);
    assert_eq!(
        ladder.evaluate(&condition),
        GitConditionOutcome::DoesNotHold { historical: false },
        "ancestry_negative: present-but-unreachable anchor without captures"
    );
    drop(ladder);
    EvaluateCell {
        _dir: dir,
        _fixture: fixture,
        snapshot,
        condition,
    }
}

/// Rebase-shaped history: the anchored commit survives on a topic ref commentlint: allow(JUDGE)
/// (present but unreachable from HEAD, the normal post-rebase state) while commentlint: allow(JUDGE)
/// an equivalent commit with the same diff and a new parent sits `post` commentlint: allow(JUDGE)
/// commits deep in the first-parent window. Only the rebased commit touches commentlint: allow(JUDGE)
/// the captured changed path; the patch-ID rung computes exactly one commentlint: allow(JUDGE)
/// candidate identity. commentlint: allow(JUDGE)
fn patch_id_cell(pre: usize, post: usize, cell: &str, budget: &EvalBudget) -> EvaluateCell {
    assert!(
        post + 1 < CANDIDATE_WINDOW,
        "{cell}: the rebased match must sit inside the candidate window"
    );
    let dir = tempfile::tempdir().expect("bench fixture dir");
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
    let capture = capture_anchor_representation(repo, anchored, budget).expect("capture builds");
    // Advance main without touching g.txt, then re-parent the same diff. commentlint: allow(JUDGE)
    let mut tip = base;
    let mut advanced_f = String::from("one\n");
    for index in 0..pre {
        advanced_f = format!("advance {index}\n");
        tip = commit_snapshot(
            repo,
            "main",
            &[tip],
            &[("f.txt", advanced_f.as_str())],
            "advance",
            10 + index as i64,
        );
    }
    let rebased = commit_snapshot(
        repo,
        "main",
        &[tip],
        &[("f.txt", advanced_f.as_str()), ("g.txt", "topic change\n")],
        "anchored",
        10 + pre as i64,
    );
    let constant = [("f.txt", advanced_f.as_str()), ("g.txt", "topic change\n")];
    let chain = append_filler_commits(repo, "main", rebased, &constant, post, 1_000);
    let head = *chain.last().expect("chain is non-empty");

    assert!(
        capture.patch_id.is_some(),
        "{cell}: the stored capture must carry a patch identity"
    );
    let rebased_tree = repo
        .find_commit(rebased)
        .expect("rebased commit exists")
        .tree_id()
        .expect("rebased commit has a tree")
        .detach();
    // The capture's tree differs from the rebased tree (f.txt advanced): a commentlint: allow(JUDGE)
    // Holds verdict cannot come from the tree-hash rung. commentlint: allow(JUDGE)
    assert_ne!(
        capture.tree_oid.as_deref(),
        Some(rebased_tree.to_string().as_str()),
        "{cell}: tree-hash rung must not be able to decide the match"
    );

    let mut captures = BTreeMap::new();
    captures.insert(capture.commit_oid.clone(), capture);
    let snapshot = checkout(&fixture, head, budget);
    assert!(
        fixture.repo.find_commit(anchored).is_ok(),
        "{cell}: anchor must stay present in the odb via the topic ref"
    );
    let ladder = ResolutionLadder::new(&snapshot, budget);
    // Without captures the ancestry verdict stands (DoesNotHold below); commentlint: allow(JUDGE)
    // Holds with captures therefore proves the patch-ID rung decided. commentlint: allow(JUDGE)
    assert_eq!(
        ladder.evaluate(&reachable_from(anchored, BTreeMap::new())),
        GitConditionOutcome::DoesNotHold { historical: false },
        "{cell}: anchor must be unreachable from HEAD"
    );
    let condition = reachable_from(anchored, captures);
    assert_eq!(
        ladder.evaluate(&condition),
        GitConditionOutcome::Holds,
        "{cell}: patch-ID rung must resolve the rebased equivalent"
    );
    drop(ladder);
    EvaluateCell {
        _dir: dir,
        _fixture: fixture,
        snapshot,
        condition,
    }
}

/// The anchor OID is absent from the odb and the capture carries a tree commentlint: allow(JUDGE)
/// hash but no patch identity: only the tree-hash rung can decide. The commentlint: allow(JUDGE)
/// matching tree sits 32 commits deep in a 64-deep window; the rung still commentlint: allow(JUDGE)
/// scans the whole window to prove the match unambiguous. commentlint: allow(JUDGE)
fn tree_hash_cell(budget: &EvalBudget) -> EvaluateCell {
    let dir = tempfile::tempdir().expect("bench fixture dir");
    let fixture = init_repo(dir.path());
    let root = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("f.txt", "one\n"), ("filler.txt", "filler root\n")],
        "root",
        1,
    );
    let chain = append_filler_commits(&fixture.repo, "main", root, &[("f.txt", "one\n")], 63, 2);
    let head = *chain.last().expect("chain is non-empty");
    // chain[62] is HEAD; chain[30] sits 32 first-parent steps deep. commentlint: allow(JUDGE)
    let target = chain[30];
    let target_tree = fixture
        .repo
        .find_commit(target)
        .expect("target commit exists")
        .tree_id()
        .expect("target commit has a tree")
        .detach();
    let missing = ObjectId::from_hex("aa".repeat(20).as_bytes()).expect("synthetic oid parses");
    assert!(
        fixture.repo.find_commit(missing).is_err(),
        "tree_hash_rung: anchor must be absent from the odb"
    );
    let capture = AnchorCapture {
        commit_oid: missing.to_string(),
        tree_oid: Some(target_tree.to_string()),
        patch_id: None,
        changed_paths: vec!["filler.txt".to_string()],
    };
    let mut captures = BTreeMap::new();
    captures.insert(missing.to_string(), capture);
    let snapshot = checkout(&fixture, head, budget);
    let ladder = ResolutionLadder::new(&snapshot, budget);
    // An absent anchor with no capture answers Uncertain (no cheaper rung commentlint: allow(JUDGE)
    // can decide); Holds with the capture proves the tree-hash rung fired. commentlint: allow(JUDGE)
    assert_eq!(
        ladder.evaluate(&reachable_from(missing, BTreeMap::new())),
        GitConditionOutcome::Uncertain,
        "tree_hash_rung: absent anchor without captures must stay uncertain"
    );
    let condition = reachable_from(missing, captures);
    assert_eq!(
        ladder.evaluate(&condition),
        GitConditionOutcome::Holds,
        "tree_hash_rung: tree-hash rung must resolve the capture"
    );
    drop(ladder);
    EvaluateCell {
        _dir: dir,
        _fixture: fixture,
        snapshot,
        condition,
    }
}

fn bench_evaluate(c: &mut Criterion) {
    let mut group = c.benchmark_group("evaluate");
    group.sample_size(20);
    group.measurement_time(Duration::from_secs(5));
    let budget = EvalBudget::unbounded();

    // Cold cells construct the ladder inside the timed loop: one request commentlint: allow(JUDGE)
    // builds one ladder, and construction, evaluation, and drop of the commentlint: allow(JUDGE)
    // ladder's interior caches all belong to the per-call cost. commentlint: allow(JUDGE)
    let exact = exact_reachable_cell(&budget);
    group.bench_function(BenchmarkId::from_parameter("exact_reachable"), |b| {
        b.iter(|| {
            let ladder = ResolutionLadder::new(&exact.snapshot, &budget);
            black_box(ladder.evaluate(black_box(&exact.condition)))
        })
    });

    let negative = ancestry_negative_cell(&budget);
    group.bench_function(BenchmarkId::from_parameter("ancestry_negative"), |b| {
        b.iter(|| {
            let ladder = ResolutionLadder::new(&negative.snapshot, &budget);
            black_box(ladder.evaluate(black_box(&negative.condition)))
        })
    });

    // Match 32 deep in a 65-deep window: 31 advance commits, the rebased commentlint: allow(JUDGE)
    // equivalent, then 32 filler commits on top. commentlint: allow(JUDGE)
    let patch_064 = patch_id_cell(31, 32, "patch_id_rung_064", &budget);
    group.bench_function(BenchmarkId::from_parameter("patch_id_rung_064"), |b| {
        b.iter(|| {
            let ladder = ResolutionLadder::new(&patch_064.snapshot, &budget);
            black_box(ladder.evaluate(black_box(&patch_064.condition)))
        })
    });

    // Match near the bottom of the CANDIDATE_WINDOW-deep window: the whole commentlint: allow(JUDGE)
    // ~510-commit history stays inside the window, rebased at index 504. commentlint: allow(JUDGE)
    let patch_512 = patch_id_cell(4, CANDIDATE_WINDOW - 8, "patch_id_rung_512", &budget);
    group.bench_function(BenchmarkId::from_parameter("patch_id_rung_512"), |b| {
        b.iter(|| {
            let ladder = ResolutionLadder::new(&patch_512.snapshot, &budget);
            black_box(ladder.evaluate(black_box(&patch_512.condition)))
        })
    });

    let tree = tree_hash_cell(&budget);
    group.bench_function(BenchmarkId::from_parameter("tree_hash_rung"), |b| {
        b.iter(|| {
            let ladder = ResolutionLadder::new(&tree.snapshot, &budget);
            black_box(ladder.evaluate(black_box(&tree.condition)))
        })
    });

    // Warm variant: one ladder constructed outside the loop, and repeated commentlint: allow(JUDGE)
    // evaluations hit the interior ancestry cache instead of re-walking. commentlint: allow(JUDGE)
    // The delta against exact_reachable quantifies the ladder's caches. commentlint: allow(JUDGE)
    let warm_ladder = ResolutionLadder::new(&exact.snapshot, &budget);
    assert_eq!(
        warm_ladder.evaluate(&exact.condition),
        GitConditionOutcome::Holds,
        "warm_exact_reachable: root anchor must hold via ancestry"
    );
    group.bench_function(BenchmarkId::from_parameter("warm_exact_reachable"), |b| {
        b.iter(|| black_box(warm_ladder.evaluate(black_box(&exact.condition))))
    });
    drop(warm_ladder);
    group.finish();
}

criterion_group!(benches, bench_snapshot, bench_evaluate);
criterion_main!(benches);
