# Research Brief

Date: 2026-09-01.

Decision: choose safe, reversible performance mechanisms for ancestry evaluation, snapshotting,
batch cache keys, and cache values without changing verdicts, budgets, staleness keys, or
auto-injection safety.

Critical questions:

1. Which Git DAG reachability accelerators preserve exact ancestry and missing-object uncertainty?
2. Which mechanisms are available through gix 0.87.1 without a new dependency or Git subprocess?
3. Can snapshot work be reused without missing worktree-only changes?
4. Which batch-key and cache-value changes remove measured work without weakening collision or
   staleness protection?
5. Do alternative cache policies fit the observed access distribution and scan-resistance contract?

Hard constraints are the campaign plan's safe-Rust, exact-verdict, exact-budget/stat, bounded-cache,
attacker-influenced-input, gix-only-fixture, and no-widened-injection requirements. Persistent
indexes must fail to the current slow path when absent, stale, or corrupt.

Stopping rule: direct primary-source or current-source evidence for every leading decision;
counter-evidence retained; unresolved reachability-label, path-trie, and cache-policy claims remain
INSUFFICIENT rather than becoming implementation requirements.

