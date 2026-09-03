//! O3, git-branch applicability: `ResolutionLadder::evaluate` agrees with an
//! independent reachability oracle for every `(anchor, head)` pair over random
//! commit DAGs with merges and a disconnected root. Patch-id
//! fallback through `ApplicabilityEngine::evaluate` and duplicate-patch-id
//! ambiguity are proven in the sibling anchor-resolution and acceptance
//! files, which the registry cites; this module owns the graph property.
//!
//! With no capture, `resolve_commit` skips the patch-id and tree-hash rungs
//! (`match_in_window` has nothing to match), so the ancestry test alone
//! decides each outcome.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use gix::ObjectId;
use mc_kernel::applicability::{
    snapshot_checkout, EvalBudget, GitConditionOutcome, ResolutionLadder,
};
use mc_kernel::GitCondition;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

use crate::git_fixtures::{commit_snapshot, init_repo, materialize, set_head_detached};

const SEED: [u8; 32] = *b"kernel-proofs-o3-branch-reach-01";

/// Parent choices per commit as abstract indices.
///
/// Commit `i` resolves each choice modulo `i`, so every edge points to an earlier commit and
/// shrinking any prefix still yields an acyclic graph. A `None` first parent starts a new root.
#[derive(Debug, Clone)]
struct Shape {
    parents: Vec<(Option<u8>, Option<u8>)>,
}

fn shape() -> impl Strategy<Value = Shape> {
    prop::collection::vec(
        (
            prop::option::weighted(0.9, any::<u8>()),
            prop::option::weighted(0.25, any::<u8>()),
        ),
        5..=12,
    )
    .prop_map(|parents| Shape { parents })
}

struct Dag {
    commits: Vec<ObjectId>,
    parents: Vec<Vec<usize>>,
}

impl Dag {
    /// Resolves the shape into real commits with at most two merge commits.
    ///
    /// Commit timestamps increase by one second from the Unix epoch. Each commit uses its own ref
    /// so disconnected roots can coexist in one fixture repository.
    fn build(repo: &gix::Repository, shape: &Shape) -> Self {
        let mut commits = Vec::new();
        let mut parents: Vec<Vec<usize>> = Vec::new();
        let mut merges = 0;
        for (index, (first, second)) in shape.parents.iter().enumerate() {
            let mut chosen = Vec::new();
            if index > 0 {
                if let Some(first) = first {
                    chosen.push(usize::from(*first) % index);
                }
                if let Some(second) = second {
                    let candidate = usize::from(*second) % index;
                    if merges < 2 && !chosen.is_empty() && !chosen.contains(&candidate) {
                        chosen.push(candidate);
                        merges += 1;
                    }
                }
            }
            let oids = chosen.iter().map(|&p| commits[p]).collect::<Vec<_>>();
            let content = format!("content-{index}\n");
            // One ref per commit: a root commit's ref update must create
            // its ref, so a shared branch would reject the second root.
            let oid = commit_snapshot(
                repo,
                &format!("c{index}"),
                &oids,
                &[("f.txt", content.as_str())],
                &format!("commit {index}"),
                index as i64 + 1,
            );
            commits.push(oid);
            parents.push(chosen);
        }
        Self { commits, parents }
    }

    /// Returns the transitive parent closure of `head`, including `head`.
    ///
    /// The ordered set makes oracle membership independent of Git traversal order.
    fn ancestors(&self, head: usize) -> BTreeSet<usize> {
        let mut seen = BTreeSet::from([head]);
        let mut queue = vec![head];
        while let Some(node) = queue.pop() {
            for &parent in &self.parents[node] {
                if seen.insert(parent) {
                    queue.push(parent);
                }
            }
        }
        seen
    }
}

/// Checks every anchor, head, and valid window-end combination.
///
/// Returns `(merges, roots)` so the property can prove the deterministic sample exercised merges
/// and disconnected components.
///
/// # Panics
///
/// Panics when fixture construction fails or the resolution ladder disagrees with the oracle.
fn run(shape: &Shape) -> (usize, usize) {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let dag = Dag::build(&fixture.repo, shape);
    let budget = EvalBudget::unbounded();
    for head in 0..dag.commits.len() {
        set_head_detached(&fixture.repo, dag.commits[head]);
        materialize(&fixture.repo, dag.commits[head]);
        let snapshot = snapshot_checkout(&fixture.root, &budget).unwrap();
        let ladder = ResolutionLadder::new(&snapshot, &budget);
        let reachable = dag.ancestors(head);
        for anchor in 0..dag.commits.len() {
            let expected = if reachable.contains(&anchor) {
                GitConditionOutcome::Holds
            } else {
                GitConditionOutcome::DoesNotHold { historical: false }
            };
            let actual = ladder.evaluate(&GitCondition::ReachableFrom {
                oid: dag.commits[anchor].to_string(),
                captures: BTreeMap::new(),
            });
            assert_eq!(
                actual, expected,
                "reachable_from anchor {anchor} head {head}"
            );
            // Windows run from an anchor to each of its descendants; the
            // window holds while HEAD has entered it and not yet reached its
            // end.
            for end in 0..dag.commits.len() {
                if end == anchor || !dag.ancestors(end).contains(&anchor) {
                    continue;
                }
                let expected = if reachable.contains(&end) {
                    GitConditionOutcome::DoesNotHold { historical: true }
                } else if reachable.contains(&anchor) {
                    GitConditionOutcome::Holds
                } else {
                    GitConditionOutcome::DoesNotHold { historical: false }
                };
                let actual = ladder.evaluate(&GitCondition::ReachableBetween {
                    start_oid: dag.commits[anchor].to_string(),
                    end_oid: dag.commits[end].to_string(),
                    captures: BTreeMap::new(),
                });
                assert_eq!(actual, expected, "between {anchor}..{end} head {head}");
            }
        }
    }
    (
        dag.parents
            .iter()
            .filter(|parents| parents.len() == 2)
            .count(),
        dag.parents
            .iter()
            .filter(|parents| parents.is_empty())
            .count(),
    )
}

#[test]
fn ladder_matches_breadth_first_reachability_on_random_dags() {
    let mut runner = TestRunner::new_with_rng(
        Config {
            cases: 16,
            source_file: Some(file!()),
            ..Config::default()
        },
        TestRng::from_seed(RngAlgorithm::ChaCha, &SEED),
    );
    let merges = Cell::new(0);
    let extra_roots = Cell::new(0);
    runner
        .run(&shape(), |shape| {
            let (dag_merges, dag_roots) = run(&shape);
            merges.set(merges.get() + dag_merges);
            extra_roots.set(extra_roots.get() + dag_roots - 1);
            Ok(())
        })
        .unwrap();
    // Positive controls on the generator: the sampled DAGs include merges
    // and disconnected roots, so the oracle was exercised beyond chains.
    assert!(merges.get() > 0, "no merge commit was generated");
    assert!(extra_roots.get() > 0, "no disconnected root was generated");
}

#[test]
fn head_on_a_disconnected_root_reaches_nothing_from_the_other_component() {
    let shape = Shape {
        parents: vec![(None, None), (Some(0), None), (None, None), (Some(2), None)],
    };
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let dag = Dag::build(&fixture.repo, &shape);
    assert_eq!(dag.ancestors(3), BTreeSet::from([2, 3]), "positive control");
    set_head_detached(&fixture.repo, dag.commits[3]);
    materialize(&fixture.repo, dag.commits[3]);
    let budget = EvalBudget::unbounded();
    let snapshot = snapshot_checkout(&fixture.root, &budget).unwrap();
    let ladder = ResolutionLadder::new(&snapshot, &budget);
    for anchor in [0, 1] {
        assert_eq!(
            ladder.evaluate(&GitCondition::ReachableFrom {
                oid: dag.commits[anchor].to_string(),
                captures: BTreeMap::new(),
            }),
            GitConditionOutcome::DoesNotHold { historical: false }
        );
    }
}
