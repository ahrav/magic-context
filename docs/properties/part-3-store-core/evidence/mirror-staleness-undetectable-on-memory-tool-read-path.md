# mirror-staleness-undetectable-on-memory-tool-read-path

## Discovery trigger

Three production functions read committed mirror claims. Two of them bracket the
read with a snapshot-vector comparison and bail out on any mismatch. The third,
`list_committed_claims`, reads `claim_mirror_state()` only to extract an incarnation
string and then lists claims with no comparison at all.

## Evidence trail

**The unfenced path.**

```
57 pub fn list_committed_claims(
58     store: &McStore,
59     public_claim_ids: &BTreeSet<String>,
60     category: Option<&str>,
61     limit: usize,
62 ) -> Result<Vec<CommittedClaimMirrorRow>, MemoryToolError> {
63     let Some(state) = store.claim_mirror_state()? else {
64         return Ok(Vec::new());
65     };
66     Ok(store
67         .list_claim_mirror(&state.database_incarnation_id, None)?
```

(`crates/mc-module/src/memory_tool.rs:57-67`.) The signature takes no expected
vector, so the function could not compare even if it wanted to. `state` is consumed
solely for `database_incarnation_id`. Everything after `:67` is filtering by claim
ID, category, and limit (`:68-80` onward). There is no second state read and no
freshness test.

**The two fenced paths, for contrast.**

`crates/mc-module/src/transform.rs:1978-2011` takes an expected vector from
`lane.snapshot_vector` (`:1971-1977`), compares the mirror's canonical vector against
it at `:1988-1990`, lists claims at `:1995-1999`, re-reads state at `:2004`, and
re-compares at `:2008-2010`. Any mismatch returns `Ok(None)`, so the caller gets no
claim memory rather than stale claim memory.

`crates/mc-module/src/historian_chunk.rs:563-608` does the same shape with an
`expected: Option<&SnapshotVector>` parameter (`:563`), an early return when it is
absent (`:564-566`), a canonical comparison at `:585-587`, and a full
`ClaimMirrorState` equality check at `:605-607`, which is strictly stronger because
it also covers `acked_effect_id`.

The third fenced path is atomic. `crates/mc-store/src/lib.rs:7368-7377` re-reads the
vector with `claim_mirror::snapshot_vector_from_connection`
(`claim_mirror.rs:647-681`) inside the same `with_conn_fenced` transaction as the CAS
and converts a mismatch into `CommitOutcome::CasConflict`, so a commit cannot land
against a vector the caller did not observe.

**There is no other freshness signal available.** `mc_claim_mirror_state` carries
`updated_at_ms` (`lib.rs:1258`), written on seed (`claim_mirror.rs:827`) and on every
receipt (`:1114-1117`). No `SELECT` anywhere in the tree retrieves it: the four
statements that read `mc_claim_mirror_state` project
`vector_version, database_incarnation_id, workspace_epoch` (`claim_mirror.rs:652-653`),
`mirror_version, vector_version, database_incarnation_id, workspace_epoch`
(`:717-719`), `database_incarnation_id` alone (`:772`), and
`database_incarnation_id, workspace_epoch` (`:889`). So age is written and never
read, and `ClaimMirrorState` (`:138-146`) has no timestamp field to expose. A caller
cannot ask how old the mirror is even if it wanted to.

**And the mirror can genuinely fall arbitrarily behind.** Every admission check in
`apply_claim_mirror_receipt` refuses the whole receipt on failure: project-set
mismatch (`:942-957`), generation mismatch (`:963-990`), checkpoint mismatch
(`:992-1006`), and the per-claim guards (`:1008-1050`). A refused receipt leaves the
mirror at its previous position, and because the source's next receipt chains from a
position the mirror never reached, every subsequent receipt is refused too. The lane
wedges at a fixed, self-consistent, arbitrarily old state — and
`mirror-reset-cycle-requires-a-rebuild-grant` shows production cannot reseed out of
it.

**Reachability.** `memory_tool.rs:57` is production: the `#[cfg(test)] mod tests` in
that file begins at `:361-362`, well below. `transform.rs` and `historian_chunk.rs`
paths are likewise production. So all four read shapes are default-production, and
the unfenced one is not gated on configuration.

## Failure scenario

1. Receipt 9 is refused for any of the reasons above — say a `CheckpointMismatch`
   after the double-apply in `mirror-receipt-replay-applies-effects-once`.
2. The mirror stops advancing. Its state row, project rows, and claim rows remain
   internally consistent and pass every validation, so nothing looks broken.
3. `transform.rs:1988` compares the mirror's vector against the host's expected
   vector, which has moved on, and returns `Ok(None)`. Claim memory silently
   disappears from that surface. `historian_chunk.rs:585` does the same.
4. `list_committed_claims` continues to return the frozen claim set, indefinitely,
   with no error and no signal to its caller.

So the system degrades inconsistently: the two surfaces that can tell go quiet, and
the one that cannot keeps serving. An operator looking at the quiet surfaces would
conclude the claim lane is off; a user reading through the tool surface would see
stale memories presented as current. The two observations disagree, and neither
carries the information needed to diagnose the other.

The inverse hazard is worth stating: the fenced surfaces fail *closed* into silence,
which is safe but also invisible. Nothing in the mirror emits a signal when the
vector comparison fails, so a wedged mirror produces no error anywhere — only an
absence on two paths and staleness on the third.

## Timing windows and dependencies

- No bounded window. The staleness is unbounded in both duration and magnitude,
  because nothing prunes, expires, or ages the mirror and `updated_at_ms` is
  unreadable.
- Depends on the wedge being reachable at all, which
  `mirror-reset-cycle-requires-a-rebuild-grant` establishes: without a reseed path,
  a refused receipt is permanent rather than transient.
- Independent of `mirror-read-fence-relies-on-generation-advance`, which is about
  whether the fenced paths' comparison is *sound*. This record is about a path with
  no comparison to be sound or unsound.

## What a test must construct

1. Enumerate the read surface as a structural assertion rather than a runtime one.
   For every production call site of `list_claim_mirror`, assert the enclosing
   function either accepts a `SnapshotVector` parameter or is annotated as
   staleness-tolerant. On the current tree that enumeration is four sites
   (`lib.rs:7368-7377` indirectly via `snapshot_vector_from_connection`,
   `transform.rs:1996`, `historian_chunk.rs:592`, `memory_tool.rs:67`) and the last
   fails. This is the cheapest oracle and needs no fault injection.
2. Behavioural version. Seed a mirror and apply receipt 8. Then submit receipt 10,
   skipping 9, and assert it is refused with `CheckpointMismatch`, leaving the mirror
   at receipt 8's state.
3. With the mirror wedged at 8 and the host's expected vector at 10, call the
   transform path and assert it returns `None`. Call the historian path and assert it
   returns an empty string (`historian_chunk.rs:586`).
4. Call `list_committed_claims` and assert it returns the receipt-8 claim set. That
   is the finding: the same wedged mirror produces silence on two surfaces and
   confident stale data on the third.
5. Assert there is no way for the caller to detect it: confirm `ClaimMirrorState`
   (`claim_mirror.rs:138-146`) exposes no timestamp and no source position beyond
   `acked_effect_id`, and that `acked_effect_id` alone is meaningless without the
   authority's position, which this store never holds.
6. Do not write a coverage marker pairing `always(!stale)` with `sometimes(stale)`.
   The independent preconditions to assert are: a receipt was refused, and a read
   occurred through an unfenced call site.

## Investigation log

### Q: Is `list_committed_claims` a tool-facing read whose caller already accepts lag?

- Sources examined: `memory_tool.rs:57-67` and the filtering that follows,
  `:361-362` (the test module boundary, confirming production reachability),
  `transform.rs:1971-1977` (where the fenced path gets its expected vector),
  `historian_chunk.rs:563-566` (same).
- Findings: the signature cannot check. The two fenced paths receive their expected
  vector from a lane configuration the caller already holds;
  `list_committed_claims` takes claim IDs, a category, and a limit, and nothing that
  could serve as a freshness reference. So either the caller is expected to
  tolerate lag, or the parameter is missing. The function's behaviour is consistent
  with the first reading and its neighbours' behaviour is consistent with the
  second.
- Missing evidence: the tool-surface contract for this call, and whether its result
  is presented to a user as current.
- Conclusion: needs human input.

### Q: Is `updated_at_ms` read anywhere, giving a fallback freshness signal?

- Sources examined: every reference to `mc_claim_mirror_state` in the tree —
  `claim_mirror.rs:652-653`, `:706`, `:717-719`, `:772`, `:818-829`, `:889`,
  `:1115`, and the schema at `lib.rs:1251-1259`. Also `ClaimMirrorState`
  (`claim_mirror.rs:138-146`) for an exposed field.
- Findings: written in two places, projected by none. The struct has no timestamp
  field, so even if a statement selected it there would be nowhere to put it.
- Missing evidence: none.
- Conclusion: resolved with answer — no. `updated_at_ms` is write-only and cannot
  serve as a freshness signal without a schema-adjacent code change.
