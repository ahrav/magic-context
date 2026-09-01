# Research Report: A1 - Specifications and Algorithms

## Coverage

Reviewed Git 2.51 commit-graph generation semantics and Git's batch reachability implementation.
Searched generation cutoffs, mixed graph chains, absent commits, shallow history, replacements, and
multi-tip painting. Reachability-labeling papers were not needed to distinguish the leading
repository-local options and remain insufficiently evaluated.

## Findings

**A1.F1: Generation numbers provide a sound ancestry cutoff**

- Claim: when testing whether ancestor A reaches descendant B, a walk from B may stop below A's
  generation; strict inequality remains safe for mixed/incomplete generation data.
- Support: DIRECT, Git v2.51 technical commit-graph document, "Generation Numbers" and the weaker
  condition for `GENERATION_NUMBER_INFINITY`/`ZERO`.
- Source: `git/git@v2.51.0:Documentation/technical/commit-graph.adoc`, lines 41-124.
- Applicability: direct to exact DAG ancestry.
- Counter-evidence: none; the document explicitly limits shallow and replaced histories.

**A1.F2: Git answers batches with shared paint-down state**

- Claim: Git's production reachability code sorts by generation and shares flags/frontiers across
  multiple sources and targets instead of running one independent full walk per pair.
- Support: DIRECT, `git/git@v2.51.0:commit-reach.c`, `can_all_from_reach_with_flag`,
  `get_reachable_subset`, lines 786-1005 and 1128-1230.
- Applicability: partial; this engine needs per-pair `Option<bool>` and exact budget-denial order,
  so Git's implementation cannot be copied blindly.

**A1.F3: Persistent reachability labels are not yet justified**

- Claim: GRAIL/FERRARI/2-hop labels add persistent build/update/corruption semantics that the
  measured request-local problem does not require.
- Support: INSUFFICIENT for a comparative performance claim; no project-shaped benchmark or
  maintenance design was found in this bounded survey.
- Decision effect: exclude from the first tournament winner; retain as a switch condition only
  after request-local graph reuse is exhausted.

## Lens conclusion

Use generation-bounded traversal and shared request-local graph state. Do not add a persistent
reachability database in this campaign.

