# mirror-read-fence-relies-on-generation-advance

## Discovery trigger

Two production consumers guard the same non-atomic read of the same mirror tables,
and they compare different things. `crates/mc-module/src/transform.rs:2008`
compares canonical snapshot vectors; `crates/mc-module/src/historian_chunk.rs:605`
compares the whole `ClaimMirrorState`. Both are protecting the same window for the
same reason, so one of them is wrong about what the fence needs.

## Evidence trail

**The transform fence.** `claim_snapshot_for_context` makes three separate store
calls with no shared transaction:

```
1978 let Some(before) = claim_mirror_read_outcome(store.claim_mirror_state())?.flatten() else {
1981 let before_vector = claim_state_vector(&before);
1988 if before_canonical != expected_canonical { return Ok(None); }
1995 let Some(rows) = claim_mirror_read_outcome(store.list_claim_mirror(...))?
2004 let Some(after) = claim_mirror_read_outcome(store.claim_mirror_state())?.flatten() else {
2008 if canonical_snapshot_vector(&after_vector).ok().as_deref() != Some(&before_canonical) {
2009     return Ok(None);
```

(`transform.rs:1978-2011`.) The `:1988` comparison is a freshness test against the
host-supplied `lane.snapshot_vector` (`:1971-1977`). The `:2008` comparison is the
*change* detector: it must catch any mirror mutation that committed between the
two `claim_mirror_state()` calls.

**What the comparison actually covers.** `canonical_snapshot_vector` encodes only
what `snapshot_vector_value` builds
(`crates/mc-core/src/claim_operation.rs:330-337`): `databaseIncarnationId`,
`policyGenerations`, `projectGenerations`, `vectorVersion`, `workspaceEpoch`. It
does **not** include `acked_effect_id`. `ClaimMirrorProjectState` carries
`acked_effect_id` (`claim_mirror.rs:130-136`) and
`claim_mirror_state` reads it (`:735`, via `read_project_states` at `:625-645`), so
the data is available and deliberately dropped by the projection to a vector.

**Why the comparison is nevertheless sufficient today.** Two facts in
`apply_claim_mirror_receipt` combine:

1. Every project the receipt touches must present a generation of exactly
   `stored + 1` (`claim_mirror.rs:963-990`), so a touched project's generation
   always moves.
2. Only touched projects have their `acked_effect_id` written
   (`claim_mirror.rs:1064-1096`; the `UPDATE` at `:1083-1095` runs inside
   `for project_id in &touched`).

So the set of projects whose `acked_effect_id` changes is a subset of the set whose
generation changes, and any receipt that changes a checkpoint also changes the
canonical vector. The reseed path also always changes the vector or is a no-op: it
either short-circuits on full equality (`:800-805`) or clears and rewrites
everything (`:816-848`).

That makes `transform.rs:2008` correct **by consequence**, not by construction.
Neither `transform.rs` nor `claim_mirror.rs` records the dependency.
`historian_chunk.rs:605` independently chose `before != after` on the full
`ClaimMirrorState`, which does not depend on the coupling at all.

**Reachability.** `claim_snapshot_for_context` is production code in
`transform.rs`; the `#[cfg(test)]` items in that file begin far below
(`transform.rs:13585` onward is inside a test module, and the mirror calls at
`:14114`, `:14150`, `:14199` are test-module calls). `historian_chunk.rs:563-608`
is likewise production. The atomic third path, `lib.rs:7368-7377`, re-reads the
vector via `claim_mirror::snapshot_vector_from_connection` (`claim_mirror.rs:647-681`)
inside the same `with_conn_fenced` transaction as the CAS and turns a mismatch into
`CommitOutcome::CasConflict`, so it does not depend on this property either.

## Failure scenario

A future change relaxes the generation rule — for example to let a policy-only
receipt advance a project's `acked_effect_id` without bumping its generation, which
Q5 in the lens shows is a live design question given that
`ClaimMirrorChangeKind` already distinguishes `Applicability` and `Verification`
from `Upsert` (`claim_mirror.rs:58-68`).

After that change, this interleaving is undetected by transform:

1. `transform.rs:1978` reads state; project 41 at generation 7, checkpoint 100.
2. A policy-only receipt commits, advancing project 41's checkpoint to 104 and
   removing one claim via the revocation delete at `claim_mirror.rs:1053-1061`,
   leaving the generation at 7.
3. `transform.rs:1995` lists claims — the post-receipt set, missing the revoked
   claim.
4. `transform.rs:2004` reads state; the canonical vector is unchanged, so `:2008`
   passes.

Transform returns `(vector, claims)` where the vector describes generation 7 and
the claims describe a state after generation 7's checkpoint moved. The caller
believes it holds a consistent pair. `historian_chunk.rs:605` would have caught it
because `acked_effect_id` differs, so the two surfaces would disagree about
whether the mirror is usable — and the one that goes quiet is the one that was
right.

Worse in the same shape: the vector transform returns is fed to the fenced commit
at `lib.rs:7368-7377`, so a stale-but-equal vector would pass the CAS fence too.

## Timing windows and dependencies

- Window: `transform.rs:1978` to `:2004`. Three separate `with_conn` calls, so a
  concurrent `apply_claim_mirror_receipt` can commit in between. The window is
  bounded only by how long `list_claim_mirror` takes, which scales with the claim
  count.
- Dependency: `mirror-generation-advances-exactly-one-per-touched-project`. If that
  record fails, this one fails silently.
- Dependency: `acked_effect_id` written only for touched projects
  (`claim_mirror.rs:1064-1096`).
- Not a dependency: `historian_chunk.rs` and `lib.rs:7368-7377` are unaffected.

## What a test must construct

This is a coverage check, so it must assert the independent preconditions that
jointly create the window, never the violation. Asserting the violation would
require an implementation that already has the defect.

1. Marker `MIRROR_READ_FENCE_WINDOW_OBSERVED`, constant and globally unique.
2. Precondition A: the fence executed both state reads. Instrument or bracket
   `claim_snapshot_for_context` so a test can observe that `:1978` and `:2004` both
   ran in one call.
3. Precondition B: at least one `apply_claim_mirror_receipt` committed between
   them. Drive a concurrent apply from a second thread, or use a deterministic
   interleaving hook, and confirm the receipt's dedup row exists.
4. Fire the marker when A and B hold in the same call. On a correct implementation
   the fence returns `Ok(None)` and the marker still fires, which is the point.
5. Separately, pin the coupling this record depends on, as an `always` assertion
   independent of the window: for every accepted receipt, assert that the set of
   projects whose `acked_effect_id` changed is a subset of the set whose
   `project_generation` changed. That is cheap, needs no concurrency, and is the
   assertion that would fail first if the coupling were relaxed.
6. Pin the disagreement in L5 as a documentation or review item, not a test: a test
   cannot decide which of the two comparisons is intended.

## Investigation log

### Q: Which read fence is correct, transform's or historian's?

- Sources examined: `transform.rs:1978-2011`, `historian_chunk.rs:563-608`,
  `claim_mirror.rs:963-990`, `:1064-1096`, `:800-805`, `:816-848`,
  `mc-core/src/claim_operation.rs:330-337`.
- Findings: the two are equivalent in effect today. Transform's is weaker in
  principle and sufficient only because of the generation coupling. Historian's is
  unconditionally sufficient and will bail out in strictly more cases, though I
  found no case where it bails out and transform's would not, precisely because of
  the coupling.
- Missing evidence: a design note stating whether the generation-per-effect
  coupling is a permanent invariant. Neither file references the other, and
  `claim_mirror.rs`'s only comment about row equality (`:1066-1071`) is about the
  reseed comparison, not about read fences.
- Conclusion: needs human input.

### Q: Is there a mutation that changes the mirror without changing the canonical vector?

- Sources examined: every write to the four mirror tables —
  `claim_mirror.rs:816` (clear), `:817-829` (state insert), `:830-845` (project
  inserts), `:846-848` and `:1051-1052` (claim upsert), `:1053-1061` (revocation
  delete), `:1072-1082` (row restamp), `:1083-1095` (project-state update),
  `:1097-1113` (dedup insert), `:1114-1117` (`updated_at_ms`), `:1148` (clear).
- Findings: two do not change the canonical vector. The dedup insert at `:1097-1113`
  writes only to `mc_claim_mirror_receipts`, which no read path in the tree ever
  selects except the dedup lookup itself, so it is invisible to consumers. The
  `updated_at_ms` bump at `:1114-1117` writes a column no statement in the tree
  reads. Both are harmless for this record. Every mutation that a consumer can
  observe rides along with a generation change.
- Missing evidence: none.
- Conclusion: resolved with answer — no consumer-visible mutation escapes the
  canonical vector today, and the two that escape it are unobservable.
