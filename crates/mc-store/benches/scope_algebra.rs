#[path = "../tests/support/applicability_fixtures.rs"]
mod applicability_fixtures;
#[path = "../tests/support/git_fixtures.rs"]
mod git_fixtures;

use std::hint::black_box;
use std::time::Duration;

use applicability_fixtures::{candidate, checkout, reachable_anchor};
use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use git_fixtures::{
    commit_snapshot, commit_tree, init_repo, materialize, set_head, write_tree,
    write_worktree_file, FixtureRepo,
};
use mc_store::kernel::applicability::{
    snapshot_checkout, ApplicabilityCandidate, ApplicabilityEngine, EvalBudget,
    ObjectApplicabilitySpec, ResolutionLadder,
};
use mc_store::kernel::{
    scope_matches, scope_overlaps, scope_subsumes, CanonicalScope, Dimension, GraphOracle,
    QueryContext, ScopeMatchContext, ScopeTermSpec, UnknownGraph,
};

fn exact(dimension: &str, value: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        dimension: dimension.to_string(),
        operator: "exact".to_string(),
        exact_value: Some(value.to_string()),
        ..ScopeTermSpec::default()
    }
}

fn version_range(dimension: &str, value: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        dimension: dimension.to_string(),
        operator: "version_range".to_string(),
        version_range: Some(value.to_string()),
        ..ScopeTermSpec::default()
    }
}

fn algebra_benches(c: &mut Criterion) {
    let one = CanonicalScope::from_term_specs(&[exact("branch", "main")]).unwrap();
    let eight = CanonicalScope::from_term_specs(&[
        exact("domain", "code"),
        exact("project", "magic-context"),
        exact("entity", "store"),
        exact("branch", "main"),
        exact("environment", "test"),
        exact("region", "local"),
        version_range("deployment", ">=1.0.0, <3.0.0"),
        version_range("platform", ">=1.70.0, <2.0.0"),
    ])
    .unwrap();
    let mut context = ScopeMatchContext::new();
    for (dimension, value) in [
        (Dimension::Domain, "code"),
        (Dimension::Project, "magic-context"),
        (Dimension::Entity, "store"),
        (Dimension::Branch, "main"),
        (Dimension::Environment, "test"),
        (Dimension::Region, "local"),
        (Dimension::Deployment, "2.0.0"),
        (Dimension::Platform, "1.98.0"),
    ] {
        context = context.with_value(dimension, value);
    }

    let mut group = c.benchmark_group("algebra");
    for (name, scope) in [("one-term", &one), ("eight-term", &eight)] {
        group.bench_with_input(BenchmarkId::new("matches", name), scope, |b, scope| {
            b.iter(|| scope_matches(black_box(scope), black_box(&context), &UnknownGraph));
        });
        group.bench_with_input(BenchmarkId::new("subsumes", name), scope, |b, scope| {
            b.iter(|| scope_subsumes(black_box(scope), black_box(scope), &UnknownGraph));
        });
        group.bench_with_input(BenchmarkId::new("overlaps", name), scope, |b, scope| {
            b.iter(|| scope_overlaps(black_box(scope), black_box(scope), &UnknownGraph));
        });
    }
    group.finish();
}

struct HistoryFixture {
    _dir: tempfile::TempDir,
    fixture: FixtureRepo,
    commits: Vec<gix::ObjectId>,
    foreign: gix::ObjectId,
}

fn linear_history(size: usize) -> HistoryFixture {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let tree = write_tree(&fixture.repo, &[("f", "content")]);
    let mut commits = Vec::with_capacity(size);
    for index in 0..size {
        let parents = commits.last().copied().into_iter().collect::<Vec<_>>();
        commits.push(commit_tree(
            &fixture.repo,
            "main",
            &parents,
            tree,
            &format!("commit {index}"),
            i64::try_from(index + 1).unwrap(),
        ));
    }
    let foreign = commit_tree(&fixture.repo, "foreign", &[], tree, "foreign", 1_000_000);
    HistoryFixture {
        _dir: dir,
        fixture,
        commits,
        foreign,
    }
}

fn merge_history(size: usize) -> HistoryFixture {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let tree = write_tree(&fixture.repo, &[("f", "content")]);
    let root = commit_tree(&fixture.repo, "node-0", &[], tree, "root", 1);
    let mut commits = vec![root];
    for index in 1..size {
        let first = commits[index - 1];
        let parents = if index > 2 && index % 3 == 0 {
            vec![first, commits[index / 3]]
        } else {
            vec![first]
        };
        commits.push(commit_tree(
            &fixture.repo,
            &format!("node-{index}"),
            &parents,
            tree,
            &format!("commit {index}"),
            i64::try_from(index + 1).unwrap(),
        ));
    }
    let foreign = commit_tree(&fixture.repo, "foreign", &[], tree, "foreign", 1_000_000);
    HistoryFixture {
        _dir: dir,
        fixture,
        commits,
        foreign,
    }
}

fn ancestry_benches(c: &mut Criterion) {
    let histories = [
        ("linear-100", linear_history(100)),
        ("linear-10k", linear_history(10_000)),
        ("merge-5k", merge_history(5_000)),
    ];
    let mut group = c.benchmark_group("ancestry");
    group.sample_size(20);
    for (shape, history) in &histories {
        let snapshot = checkout(&history.fixture, *history.commits.last().unwrap());
        let tip = history.commits.last().unwrap().to_string();
        for (mix, ancestor) in [
            (
                "near",
                history.commits[history.commits.len().saturating_sub(10)].to_string(),
            ),
            ("far", history.commits[0].to_string()),
            ("unrelated", history.foreign.to_string()),
        ] {
            group.bench_function(BenchmarkId::new(*shape, mix), |b| {
                b.iter(|| {
                    ResolutionLadder::new(&snapshot, &EvalBudget::unbounded())
                        .is_ancestor_or_equal(black_box(&ancestor), black_box(&tip))
                });
            });
        }
        let budget = EvalBudget::unbounded();
        let ladder = ResolutionLadder::new(&snapshot, &budget);
        let ancestor = history.commits[0].to_string();
        let _ = ladder.is_ancestor_or_equal(&ancestor, &tip);
        group.bench_function(BenchmarkId::new(*shape, "memo-hit"), |b| {
            b.iter(|| ladder.is_ancestor_or_equal(black_box(&ancestor), black_box(&tip)));
        });
    }
    group.finish();
}

fn snapshot_fixture(untracked: usize) -> (tempfile::TempDir, FixtureRepo) {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let head = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("tracked", "base")],
        "base",
        1,
    );
    set_head(&fixture.repo, "main");
    materialize(&fixture.repo, head);
    for index in 0..untracked {
        write_worktree_file(&fixture.repo, &format!("dirty/{index}.txt"), "dirty");
    }
    let _ = snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).unwrap();
    (dir, fixture)
}

fn snapshot_benches(c: &mut Criterion) {
    let fixtures = [
        ("clean", snapshot_fixture(0)),
        ("untracked-10", snapshot_fixture(10)),
        ("untracked-1000", snapshot_fixture(1_000)),
    ];
    let mut group = c.benchmark_group("snapshot");
    group.sample_size(20);
    for (name, (_dir, fixture)) in &fixtures {
        group.bench_function(*name, |b| {
            b.iter(|| {
                snapshot_checkout(black_box(&fixture.root), &EvalBudget::unbounded()).unwrap()
            });
        });
    }
    group.finish();
}

fn applicability_fixture() -> (tempfile::TempDir, FixtureRepo, gix::ObjectId, gix::ObjectId) {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let base = commit_snapshot(
        &fixture.repo,
        "main",
        &[],
        &[("src/lib.rs", "pub fn a() {}\n")],
        "base",
        1,
    );
    let tip = commit_snapshot(
        &fixture.repo,
        "main",
        &[base],
        &[("src/lib.rs", "pub fn a() {}\npub fn b() {}\n")],
        "tip",
        2,
    );
    (dir, fixture, base, tip)
}

fn candidates(
    fixture: &FixtureRepo,
    base: gix::ObjectId,
    size: usize,
    anchored: bool,
) -> Vec<ApplicabilityCandidate> {
    let anchor = anchored.then(|| reachable_anchor(fixture, "shared", base));
    (0..size)
        .map(|index| ApplicabilityCandidate {
            anchor: anchor.clone(),
            payload: Some(ObjectApplicabilitySpec::new(vec![], vec![]).encode()),
            ..candidate(&format!("object-{index}"))
        })
        .collect()
}

fn batch_benches(c: &mut Criterion) {
    let (_dir, fixture, base, tip) = applicability_fixture();
    let snapshot = checkout(&fixture, tip);
    let query = QueryContext::default();
    let scope = ScopeMatchContext::new();
    let mut group = c.benchmark_group("batch");
    group.sample_size(20);
    for size in [1, 8, 64, 512] {
        for anchored in [false, true] {
            let candidates = candidates(&fixture, base, size, anchored);
            let name = if anchored { "anchored" } else { "plain" };
            group.bench_function(BenchmarkId::new(format!("cold-{name}"), size), |b| {
                b.iter_batched(
                    ApplicabilityEngine::new,
                    |engine| {
                        engine.evaluate_batch(
                            black_box(&snapshot),
                            black_box(&query),
                            black_box(&scope),
                            black_box(&candidates),
                            &EvalBudget::unbounded(),
                        )
                    },
                    BatchSize::SmallInput,
                );
            });
            let engine = ApplicabilityEngine::new();
            let _ = engine.evaluate_batch(
                &snapshot,
                &query,
                &scope,
                &candidates,
                &EvalBudget::unbounded(),
            );
            group.bench_function(BenchmarkId::new(format!("warm-{name}"), size), |b| {
                b.iter(|| {
                    engine.evaluate_batch(
                        black_box(&snapshot),
                        black_box(&query),
                        black_box(&scope),
                        black_box(&candidates),
                        &EvalBudget::unbounded(),
                    )
                });
            });
        }
    }
    group.finish();
}

fn configure() -> Criterion {
    Criterion::default()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(2))
        .sample_size(20)
}

criterion_group! {
    name = benches;
    config = configure();
    targets = algebra_benches, ancestry_benches, snapshot_benches, batch_benches
}
criterion_main!(benches);
