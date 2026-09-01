# Part 4b lens A: the transform pass engine and its cache-state transition

Attention focus: what a pass reads, what it writes, in what order, where the
boundary between pure computation and durable mutation sits, and what can be
lost, duplicated, or left half-applied. Pass selection and pass ordering
semantics belong to a sibling lens; this pass treats the classifier's verdict
(`PassPlan`) as an opaque input and only asks what the engine does with it.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `76cd6f41`.
Method contract in [../../METHOD.md](../../METHOD.md). Scope taken verbatim
from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md)
sub-part 4b: `transform.rs:1-7510`, `injection.rs`, `compartment_coverage.rs`,
`m0_compose.rs`, `healing.rs`, `m1_compose.rs`, `retained_size.rs`,
`divergence.rs`.

Every line reference below was read back individually at `HEAD`. Four
references outside the stated 4b scope are load-bearing and are cited
explicitly rather than paraphrased:

- `crates/mc-store/src/lib.rs` — the commit transaction itself.
- `crates/mc-module/src/lib.rs:8322` — the only production caller.
- `crates/mc-module/src/transform.rs:7511-8046` — the tag baseline cache and
  the speculative mint numbering, which is 4e's territory but which the commit
  predicate depends on.
- `../commons/crates/cortexkit-cache-core/src/lib.rs` — the cache-state
  machine itself, which lives **outside this repository** as a path dependency
  (`Cargo.toml:15`). Its checkout is at a different commit
  (`d2208eda`, 2026-08-14) from this one.

## Engine map

### What a pass is

A pass is one call to `apply_once` (`transform.rs:3222-5697`), one linear
2,476-line body with no inner functions. Its inputs are a `TransformRequest`
(the harness's CK array plus per-pass scalars), a `ProducerContext` (resolved
config plus `now_ms`), the durable session row, and two optional in-process
caches. Its output is a `TransformWithProjection` carrying the rewritten
array.

There are two engines, selected by one config leaf:

- `compaction_enabled == false` returns `apply_additive_only`
  (`:3234`, body at `:2711-3219`). One commit at `:3113`, `expected:
  loaded.row_version`, no mid-pass durable write. Reachability:
  `explicit-config-only`, since `compaction_enabled` defaults to `true`
  (`config.rs:123`) and the shipped setup writer treats an absent value as
  enabled (`packages/plugin/src/config/agent-disable.ts:34`,
  `config.compaction?.enabled !== false`).
- Otherwise `apply_once` runs the full engine. This is the default-production
  engine and the subject of this lens.

### Enumeration and firing

Passes are not enumerated by the engine. Each transform request is exactly one
firing. The retry wrapper is
`apply_once_with_estimator_and_projection` (`:2261-2301`): a `loop` that calls
`apply_once` and, on `TransformError::Store(McStoreError::CasConflict)` only,
retries while `attempt < MAX_CAS_RETRIES` (`:2284`, `MAX_CAS_RETRIES = 8` at
`:82`). Every other error returns immediately (`:2298`). So one firing performs
at most 9 `apply_once` invocations, and each invocation re-reads all state from
scratch. The only value carried across the reload is
`boundary_divergence_retry`, accumulated with `|=` at `:2289`.

The doc on `MAX_CAS_RETRIES` (`:80-81`) claims "the module is the single writer
in the daemon case, so this rarely loops". That is a claim about
serialization, not a mechanism; see the interleaving question below.

### What the pass reads, and in how many transactions

`load_transform_snapshot` (`:3387`) is the declared read linearization point.
It is one read transaction under the store connection mutex
(`mc-store/src/lib.rs:5529-5545`, and see the existing store test
`transform_snapshot_resists_commit_between_state_and_overlay_reads` at
`mc-store/src/lib.rs:14455`), returning `core`, `meta`, `row_version`, and the
non-tag overlay rows together.

Every other read is a **separate** transaction, taken after that point:

| Read | Line |
| --- | --- |
| `load_cached_tags` | `:3391` |
| `max_compartment_end_ordinal` | `:3429` |
| `has_compartments` | `:3553`, `:4054` |
| `load_compartments` | `:3558`, `:4072`, `:4564`, `:4643`, `:4666`, `:4900`, `:5060` |
| `load_pending_agent_drops` | `:3834` |
| `revision_signal_for_context` (m1 digest) | `:4658`, `:5029`, `:5119` |

So the pass's read set is not one snapshot. The commit predicate covers three
of those reads and none of the rest; see the cache-state map below.

### The pure/durable boundary

`let mut core = loaded.core.clone()` (`:4369`) and `let mut meta =
loaded.meta.clone()` (`:4371`) open the mutation region. Everything from there
to `:5560` mutates only those clones plus `pending_overlays`
(`:3797`, filled at `:3806`). The code states this contract itself at
`:3505-3507`: "Decisions from this request stay in memory until the final
cache-state compare-and-swap accepts the pass."

Two durable writes break that boundary by executing **before** the terminal
commit and outside its transaction:

1. `store.descend_lineage` (`:3312`) on a lineage-switch pass. It copies
   compartments, chunk transcripts, tags, temporal marks and user hints into
   the target session key and bumps that key's `row_version`
   (`mc-store/src/lib.rs:8177`, inserts at `:8705-8745`, `row_version` writes
   at `:8312-8331` and `:8403-8422`).
2. `store.truncate_compartments_for_revert` (`:4646`) on the
   reconcile-rematerialize arm. It deletes compartments past the surviving
   prefix, bumps `meta.revert_epoch`, and bumps `row_version`
   (`mc-store/src/lib.rs:9015`, deletes at `:9106-9138`, `row_version` write at
   `:9139-9144`). The engine then re-points its own CAS expectation at the new
   version (`:4651`) and adopts the new epoch (`:4652`).

Both are committed transactions of their own. Neither is rolled back if the
pass later fails.

### Commit point

`store.commit_transform` at `transform.rs:5565`, guarded by `commit_required`
at `:5559-5561`, with `expected: commit_expected` (`:5569`). It is one fenced
SQLite transaction (`mc-store/src/lib.rs:7260`; wrapper
`with_conn_fenced` at `../commons/crates/cortexkit-store/src/lib.rs:185`,
which takes the process-wide connection mutex at `:189` and runs an IMMEDIATE
transaction).

Inside that one transaction it writes: `mc_cache_state`
(`mc-store/src/lib.rs:7388-7400`), `mc_pass_trace`
(`:7402-7468`), `mc_transform_session_roots` (`:7470-7481`), new
`mc_tags` rows (`:7483-7515`), `mc_temporal_marks` (`:7527-7541`),
`mc_user_hints` (`:7542-7558`), `mc_channel1_appends` (`:7559-7571`),
`mc_overlay_frontiers` (`:7572-7580`), `mc_reduce_command_ledger`
first-applied stamps (`:7582-7591`), and `pending_agent_drops` deletions
(`:7592-7597`). All-or-nothing.

Three other commits exist in the engine and each one is an early `return`, so
at most one of them and the terminal one can run per pass:
`transform.rs:3609` and `:3720` (the two `pending_rewrite` pass-through arms)
and `:3113` (the additive-only engine).

After the commit, and only on the success path, `:5604-5613` replaces the
in-process serialized-output cache entry.

## Cache-state transition map

### The states

Durable state is two JSON blobs in one row, plus `row_version`. The
`CoreState` machine (`../commons/crates/cortexkit-cache-core/src/lib.rs:84-97`)
carries `version`, `boundary_id`, `frozen_units`, `pending_changes`,
`reconcile_pending`. Every field is `pub`.

The engine-visible state coordinates are:

- `meta.initialized` — false before the first fold, set true only in the three
  HARD arms (`transform.rs:2984`, `:4802`, `:5012`). Never set back to false in
  this crate.
- `core.boundary_id` — `""` is the reserved never-minted sentinel
  (cache-core `:188-196`); non-empty is a live coverage anchor.
- `core.reconcile_pending` — the "m0 is stale, next bust must rematerialize"
  latch.
- `meta.coverage_ordinal` — the second view of the same coverage end; the code
  states at `transform.rs:5109-5110` that it must not desync from
  `boundary_id`.
- `meta.revert_epoch` / `meta.last_recut` — recut generation.
- `meta.pending_rewrite` — the boundary-absent-with-held-lineage alarm.
- `BoundaryState` (`transform.rs:640-651`): `LivePresent`,
  `DeclaredTrimValidated`, `Absent`, resolved by `resolve_boundary_state`
  (`:7167-7269`).

### The legal transitions

Exactly three, all in the out-of-repo core (`cache-core:154-165`):

| Action | Guard | Effect |
| --- | --- | --- |
| `SoftPlus` (defer) | none | queues `pending_changes`; sets `reconcile_pending = !boundary_match && !boundary_id.is_empty()` (`:197`); **does not** bump `version` |
| `Soft` | advance of `boundary_id` requires `boundary_match && !reconcile_pending` (`:227`) | freezes rendered units; bumps `version` (`:232`) |
| `Hard` | none | drains all `pending_changes` into this bust, mints `boundary_id`, clears `reconcile_pending` (`:250`), bumps `version` |

Note that defer both **sets and clears** `reconcile_pending` at `:197`. A defer
that finds the boundary again clears the latch with no rematerialize. The core
acknowledges this consequence in prose at `:221-222`.

### What guards each in the engine

The engine reaches exactly one `core.step` per pass. Five call sites exist —
`:4541` (subagent), `:4794` (Hard/MigrateHard), `:5002` and `:5098` (the two
arms of Soft), `:5151` (Defer) — and they are mutually exclusive by
construction: the subagent branch is a separate `if` (`:4538`), the rest are
arms of one `match plan` (`:4554`), and the Soft pair is an if/else. The
compiler enforces it too, because `boundary_token: String` (`:3540-3544`) is
**moved** into whichever `PassInput` runs.

### Is an illegal transition representable

Yes. `CoreState`'s fields are public and the engine writes three of them
directly, outside `step`:

- `core.reconcile_pending = true` at `transform.rs:4430`, on lineage-anchor
  validation failure.
- `core.frozen_units.retain(..)` via `prune_covered_red_units` (`:5117`, body
  `:6926-6947`) and `prune_covered_caveman_units` (`:5118`, body
  `:6385-6398`), both called **after** the Soft step has already bumped
  `core.version`.

Every `core.step` call also discards its `StepResult`, so the
`reconcile_pending` the machine reports is never compared against what the
engine believes.

### What happens to in-flight work when a transition occurs mid-run

Nothing is in flight across a transition in the ordinary sense: a pass is
synchronous (`lib.rs:8322` calls `transform_with_projection_cached` inline in
the async handler, not under `spawn_blocking`). The mid-run hazards are
different:

- Another writer commits between this pass's read and its commit. The
  `row_version` CAS (`mc-store/src/lib.rs:7360-7367`) rejects the pass, the
  wrapper reloads, and the whole computation is redone. Nothing partial
  survives on the main path.
- Another writer commits between this pass's **truncate** and its commit. The
  truncate is already durable. See
  `revert-truncate-commits-outside-the-terminal-cas`.
- The process dies between the truncate and the commit. Compartments are gone
  and `revert_epoch` has moved, but `core.boundary_id` and
  `meta.coverage_ordinal` still describe the pre-truncate coverage.

## Observations

1. `transform.rs:5565` — the terminal `commit_transform`, the commit point.
   Guarded by `commit_required` (`:5559-5561`) = `state_changed ||
   !consumed_drop_ids.is_empty() || !pending_overlays.is_empty()`, where
   `state_changed` (`:5555`) is a whole-struct inequality on both blobs.
2. `transform.rs:4369-4371` — the clone that opens the pure region.
3. `transform.rs:3312` — `descend_lineage`, a durable write 43 lines before
   the array-validity guards at `:3355` (`DuplicateBlockId`), `:3364`
   (`ReservedId`) and `:3371` (`OrdinalViolation`).
4. `transform.rs:4646-4652` — `truncate_compartments_for_revert`, a durable
   write 900 lines before the commit, whose outcome re-points
   `commit_expected` and `meta.revert_epoch`.
5. `transform.rs:4703-4710` — a `CoverageGap` error raised *after* that
   truncate has committed.
6. `mc-store/src/lib.rs:9053-9059` — the truncate's `dropped_count == 0`
   no-op arm returns the current epoch and version without a second bump.
   This is what makes a retried truncate idempotent.
7. `transform.rs:5574` — `compartment_max_seq: is_bust_pass.then_some(..)`.
   `is_bust_pass` (`:4439`) is `Hard | MigrateHard | Soft` and non-subagent,
   so a Defer commits with **no** compartment fence
   (`mc-store/src/lib.rs:7378-7387` is skipped).
8. `transform.rs:5155-5157` — a Defer nonetheless writes
   `meta.coverage_compartment_seq` from a read taken at `:3860`-ish, outside
   any predicate.
9. `transform.rs:5591-5592` — the commit slices `tag_rows` by
   `[tag_mint_start .. tag_mint_start + tag_mint_count]`, the exact span
   `append_tag_mint_rows` appended (`:8028`, `:8030-8043`).
10. `mc-store/src/lib.rs:7488-7500` — the store assigns each new tag's number
    as `MAX(tag_number) + 1` read fresh inside the transaction, and **skips**
    any input whose `block_id` already exists. The in-memory assignment
    (`transform.rs:8029`) is `max(tag_number)` from the loaded rows plus an
    offset. Two independent numbering authorities.
11. `transform.rs:7644` — `load_cached_tags` is an **unbounded** `loop`. Both
    exits are optimistic revalidations (`continue` at `:7678`, fallthrough at
    `:7695`); neither counts attempts. Called from the engine at `:3391`. The
    loop body is 4e's scope; the unbounded call from the engine is 4b's.
12. `transform.rs:3243`, `:3342`, `:3358-3361` — the PRIMARY poison-resistance
    invariant's mechanism: normalize synthetic flags, shadow `req` with the
    normalized (or rebased) request, then filter `live` to non-synthetic. Every
    coverage and boundary read after `:3358` sees only `live`. The BACKSTOP is
    `:3363-3365` rejecting a live `mc_` id (`RESERVED_ID_PREFIX` at `:91`).
13. `transform.rs:5381` — the output-cache snapshot is keyed on
    `meta.revert_epoch`, which is already the post-truncate value. `snapshot`
    evicts on epoch mismatch (`:421-427`). This ordering is correct; the
    render cannot serve pre-revert bytes.
14. `transform.rs:2289` — `boundary_divergence_retry |= detected`. The recut
    intent is sticky across the reload so a fresh m1 watermark cannot downgrade
    a proven inconsistency back to a defer.
15. `transform.rs:85` — `BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT = 3` bounds
    consecutive divergence suppressions, in passes.
16. `transform.rs:4283` — `validate_reduction_monotonicity` runs before
    `classify`, on every pass, and rejects a re-decided reduction whose payload
    differs from the frozen one (`:6813-6825`).

## Commit point

`crates/mc-module/src/transform.rs:5565` — the single
`store.commit_transform` call at the end of `apply_once`, one fenced
transaction that atomically writes the new `core`/`meta` blobs, the pass trace,
every speculative overlay row, and the pending-drop deletions under a
row-version, claim-vector and (bust-only) compartment-sequence
compare-and-swap.

## Candidate properties

### engine-terminal-cas-is-the-sole-core-meta-writer

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `obsolete_pending_row_commits_consumption_without_core_or_meta_changes` (`transform.rs:24607`) pins the `commit_required` fan-in, and `fired_divergence_with_absent_new_anchor_fails_loud_without_commit` (`:20909`) pins one no-commit error path. Neither runs in CI.
Guarantee: On the compaction-enabled engine, a pass that returns `Err` leaves the session's `row_version`, `core_state` and `meta` exactly as `load_transform_snapshot` returned them.
Check: `always` — for every `apply_once` invocation returning `Err`, re-read the row and assert the `(row_version, core_state, meta)` triple equals the triple captured at `:3387` for that attempt. `always` because the obligation is evaluated on every failed pass, not on an optional path.
Fault/timing angle: The window is `:4369` (clone) to `:5565` (commit). Any error raised inside it must not have mutated the row. Two known exceptions live in their own records; this record is the baseline the exceptions are measured against.
Required faults and enabling state: An error inside the mutation region. `CoverageGap` (`:4593`, `:5065`, `:4703`), `BoundaryNotPresent` (`:5091`), `IdentityDrift` (`:5786`), `ReductionConflict` (`:6820`), `FrozenRedTargetVanish` (`:5814`) are all reachable from a crafted array.
Confidence: high — [evidence](evidence/engine-terminal-cas-is-the-sole-core-meta-writer.md). Traced every `store.` call in `:3222-5697` and confirmed only `:3312`, `:4646`, `:3609`, `:3720`, `:5565` write.
Existing check: `transform.rs:20909` asserts one error path does not commit. No check covers the general obligation.
Impact: A partial mutation that survives a rejected pass makes the next pass compute against a state no pass ever accepted, which is the wedged-cache failure the module doc's poison-resistance invariants exist to prevent.
Open questions:
- Should `apply_additive_only` be held to the same obligation as a separate record, given it is `explicit-config-only`? (needs human input)

### lineage-descent-write-precedes-the-array-validity-guards

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives a malformed array through a lineage-switch pass and then asserts the target key is untouched.
Guarantee: A `TransformError` raised by the array-validity guards leaves no durable lineage-descent effect on the target session key.
Check: `always-or-unreached` — on a pass with `lineage_switched && !is_subagent` whose array fails `DuplicateBlockId`, `ReservedId` or `OrdinalViolation`, assert the target key's `row_version`, compartment count and tag count are unchanged. `always-or-unreached` because a lineage switch is optional per pass but the obligation is absolute when one occurs.
Fault/timing angle: The window is `:3312` (descend_lineage commits) to `:3371` (last validity guard). 59 lines, no fault injection needed: the guards are downstream of the write in straight-line code.
Required faults and enabling state: A lineage-switch request (`lineage_switched: true`, `is_subagent: false`, well-formed `descent_edge_id`, `prior_conversation_key`, `constituents`) whose CK array also contains a duplicate flat block id, a live block whose id starts with `mc_`, or non-increasing non-synthetic ordinals. The plugin sets `lineage_switched` from `passInputs` (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1404`), and the array is harness-supplied, so both halves are production-reachable.
Confidence: high — [evidence](evidence/lineage-descent-write-precedes-the-array-validity-guards.md). Read the straight-line order and confirmed `descend_lineage` commits its own fenced transaction.
Existing check: none.
Impact: Compartments, chunk transcripts and tags are copied into the target key and its `row_version` advanced, while the caller receives a hard error and the host serves the raw array. The copy is not idempotent-by-construction across a later retry with a valid array; it is protected only by `descend_lineage`'s own disposition logic.
Open questions:
- Does `descend_lineage` treat a repeat of the same `edge_id` as a no-op, so a retry after fixing the array is safe? Unresolved, needs a read of `mc-store/src/lib.rs:8177-8500` at the disposition level, which is 4c/4a territory.

### revert-truncate-commits-outside-the-terminal-cas

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `reconcile_rematerialize_with_unrecut_store_truncates_and_refolds_prefix` (`transform.rs:19870`) drives the truncate on a success path only. `crash_reentry_after_recut_uses_coverage_shrink_for_todo_reanchor` (`:21806`) covers re-entry after a *committed* recut, not after a failed one. Neither runs in CI.
Guarantee: The reconcile-rematerialize truncate and the pass that ordered it either both take effect or neither does.
Check: `always(!X)` where X is "compartments deleted and `revert_epoch` bumped while `core.boundary_id` and `meta.coverage_ordinal` still name the pre-truncate coverage". `always(!X)` and not `unreachable`, because this is a forbidden durable **state** with no dedicated detection point in the code.
Fault/timing angle: The window is `:4650` (truncate returns) to `:5565` (commit). Roughly 900 lines of rendering sit inside it, including `compose_m0_for_context` (`:4676`), the CoverageGap guard at `:4703`, `build_output_with_tags` (`:5390`+) and the two output integrity guards. A process kill or any error in that span leaves the split state.
Required faults and enabling state: `loaded.core.reconcile_pending == true` plus a minted anchor that is not available in the live array (`:4636-4645`), which is the post-revert shape. Then either a `CoverageGap` at `:4703`, an error from `compose_m0_for_context`, or a process kill. Coverage-check form: assert the independent preconditions — `reconcile_pending` observed true on entry, the truncate observed to return `dropped_count > 0`, and the pass observed to reach `:5565` — rather than the split state itself.
Confidence: high — [evidence](evidence/revert-truncate-commits-outside-the-terminal-cas.md). Confirmed `truncate_compartments_for_revert` is its own fenced transaction that bumps `row_version` and writes `meta`.
Existing check: `transform.rs:19870` and `:21806` cover the committed path.
Impact: `meta.coverage_ordinal` claims coverage through an ordinal whose compartments no longer exist. The next pass's `first_uncovered_live_block` guard (`:4699`) or `resolve_boundary_state` must repair it; if the repair path itself needs the deleted compartments the session cannot fold.
Open questions:
- Is the next pass guaranteed to re-enter the same reconcile arm, given `reconcile_pending` was never cleared? The reasoning says yes, but no test constructs it.

### revert-epoch-bumps-at-most-once-per-logical-recut

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test forces a CAS conflict after the truncate and then counts epoch bumps.
Guarantee: One transform firing advances `meta.revert_epoch` by at most one, even when it performs up to nine `apply_once` attempts each of which re-enters the truncate arm.
Check: `always` — across one call to `transform_with_projection_cached`, assert `revert_epoch_after - revert_epoch_before <= 1`. `always` because the bound must hold on every firing, and idempotence is the property, not the mere absence of a crash.
Fault/timing angle: The retry loop at `:2274-2299` re-runs `apply_once` from scratch. Attempt 2 re-reads the already-truncated compartments at `:4643`, recomputes `surviving_revert_prefix_seq` (`:7275-7284`) over that shorter list, and calls the truncate again. Idempotence rests entirely on `dropped_count == 0` (`mc-store/src/lib.rs:9053`) returning the current epoch. That in turn rests on the recomputed `keep_through_seq` being no smaller than the surviving max sequence.
Required faults and enabling state: The reconcile-rematerialize arm plus a `CasConflict` on the terminal commit, which the `#[cfg(test)]` hook at `:5563-5564` (`run_transform_attempt_hook`) exists to inject.
Confidence: medium — [evidence](evidence/revert-epoch-bumps-at-most-once-per-logical-recut.md). The no-op arm is verified. Whether `surviving_revert_prefix_seq` is a fixpoint after truncation is argued, not proven: it is a `take_while` over compartments whose `end_message_id` is live, and truncation removes a suffix, so the prefix length can only stay or grow. Not tested.
Existing check: none.
Impact: `revert_epoch` keys the serialized-output cache (`:5381`, `:421-427`). Extra bumps evict the cache repeatedly and, more seriously, an epoch that advances without an accepted pass makes the epoch a poor generation witness for anything downstream that compares it.
Open questions:
- Can a retry's `keep_through_seq` ever be *smaller* than the previous attempt's, causing a second real truncation? That needs the `live` set to be identical across attempts, which it is within one firing, so the answer is probably no. Unresolved, needs a constructed test.

### exactly-one-core-step-executes-per-pass

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the arm structure is exercised incidentally by all 280 inline transform tests; nothing asserts the count.
Guarantee: One `apply_once` invocation applies at most one cache-core transition.
Check: `always` — instrument `CoreState::step` with a per-pass counter and assert it never exceeds one per `apply_once`. `always` because a second transition on one pass would double-bump `version` and double-drain `pending_changes`, and that must never happen.
Fault/timing angle: none. This is structural.
Required faults and enabling state: None. The property is worth recording because it is enforced only by control-flow shape plus the move of `boundary_token` (`:3540-3544`) into whichever `PassInput` is built. A future refactor that clones the token instead of moving it silently removes the compiler's help.
Confidence: high — [evidence](evidence/exactly-one-core-step-executes-per-pass.md). Enumerated all five call sites (`:4541`, `:4794`, `:5002`, `:5098`, `:5151`) and confirmed mutual exclusion.
Existing check: none as an explicit assertion.
Impact: A second `Hard` step on one pass drains `pending_changes` twice and re-applies units; `apply_units` replaces by key (cache-core `:261-270`) so the bytes may survive, but `version` and the drain accounting would not.
Open questions: None.

### core-fields-mutated-outside-the-step-machine

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `reverted_orphan_reduction_gcd_on_surviving_prefix_reconcile_hard` (`transform.rs:25052`) covers the orphan GC that the prunes complement. No test asserts the frozen set only changes through documented mechanisms.
Guarantee: Every durable change to `core.frozen_units` and `core.reconcile_pending` is one the cache-state machine's documented rules permit.
Check: `always` — for each committed pass, assert the committed `core` is reproducible by replaying the pass's declared action plus the declared coverage-prune rule from `loaded.core`. `always` because the machine's invariants are what the byte-stability contract rests on.
Fault/timing angle: The relevant ordering is that `prune_covered_red_units` (`:5117`) and `prune_covered_caveman_units` (`:5118`) run **after** `step_soft` has bumped `core.version` (cache-core `:232`), so the committed `version` does not identify the committed frozen set.
Required faults and enabling state: A coverage-extending SOFT (`m1.new_coverage.is_some()`, `:5107`) with at least one frozen `red:` or `cav:` unit whose target the advance folds below coverage. Also, separately, a lineage-anchor validation failure (`validate_lineage_anchor` at `:2484-2547`, failure handled at `:4429-4433`) which sets `reconcile_pending` directly.
Confidence: high — [evidence](evidence/core-fields-mutated-outside-the-step-machine.md). Read both prune bodies and confirmed they `retain` on `core.frozen_units`; confirmed `:4430` assigns the field; confirmed all five `step` calls discard `StepResult`.
Existing check: `transform.rs:25052` for the HARD-fold orphan GC.
Impact: The out-of-repo core enforces its guards (cache-core `:227`) precisely because it is "a shared cache-stability primitive, so the guard is enforced in the core, not assumed". Direct field writes route around that reasoning, and the discarded `StepResult` means the engine never cross-checks the machine's own verdict.
Open questions:
- Is the discarded `StepResult.reconcile_pending` ever different from what the engine assumes? A cheap assertion would answer it. (needs human input on whether to propose a guard)

### defer-commit-carries-no-compartment-fence

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `claim_vector_commit_fence_never_publishes_interleaved_stale_bytes` (`transform.rs:14185`) covers the claim-vector predicate; nothing covers the compartment predicate's absence on Defer.
Guarantee: A committing Defer pass does not persist a compartment watermark that a concurrent publish has already invalidated.
Check: `always` — whenever a Defer commit writes `meta.coverage_compartment_seq`, assert the value equals `MAX(sequence)` of `mc_compartments` for that session as observed inside the commit transaction. `always` because a stale watermark is wrong every time it is written, not only under a specific interleaving.
Fault/timing angle: `compartment_max_seq` is passed only when `is_bust_pass` (`:5574`), and `is_bust_pass` excludes Defer (`:4439`, `:4435-4438`). So the store's compartment check (`mc-store/src/lib.rs:7378-7387`) is skipped, while `:5155-5157` writes the watermark from a read taken outside any predicate. A historian publish landing in that window is not detected.
Required faults and enabling state: A Defer pass with `compartment_seq_changed_since_meta` true and `current_m1_digest == loaded.meta.m1_revision` (`:5155-5156`), plus a compartment append committing between the m1 revision read and `:5565`. The `row_version` CAS does not help: `append_compartments` (`mc-store/src/lib.rs:9169`) does not touch `mc_cache_state`.
Confidence: high — [evidence](evidence/defer-commit-carries-no-compartment-fence.md). Verified `is_bust_pass` excludes Defer, verified `append_compartments` writes no `row_version`.
Impact: `coverage_compartment_seq` is the watermark `compartment_revision_matches` (`:3913-3918`) and `compartment_seq_changed_since_meta` (`:3951`) read to decide whether new compartments need folding. A stale value recorded by a Defer can suppress the next SOFT that would have folded them.
Open questions:
- Does any other writer append compartments concurrently with a live transform for the same session, or does the historian's publication fence serialize them? Unresolved, needs the 4a publish-fence result.

### speculative-tag-numbering-has-two-authorities

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `first_active_render_commits_tagged_bytes_before_replay` (`transform.rs:22514`) and its subagent twin (`:22588`) prove tags commit with the bytes. Neither compares the rendered number to the durable number.
Guarantee: The tag number rendered into the served bytes on the pass that mints it equals the tag number the commit transaction assigns.
Check: `always` — for every accepted pass with `tag_mint_count > 0`, assert each rendered `§N§` prefix's N equals the `tag_number` of the corresponding `mc_tags` row after the commit. `always` because a mismatch corrupts the served prefix on the very pass that froze it.
Fault/timing angle: The engine assigns numbers in memory at `:8029` as `max(loaded tag_number) + offset + 1`. The store assigns them at `mc-store/src/lib.rs:7496-7500` as `MAX(tag_number) + 1` read fresh per row, and **skips** any input whose `block_id` already exists (`:7488-7495`). One skipped input desynchronises every later number in the batch. The `row_version` CAS covers a concurrent transform or `descend_lineage`, so the reachable trigger is a duplicate `block_id` inside one batch, or a batch whose `existing_tag_ids` filter (`:8611`) is computed from a stale baseline-cache read.
Required faults and enabling state: `tagging_active` (`:3503-3504`, requires `ClaudeCodeAnthropic` or `OpencodeAiSdk` plus `tool_present`) and a mint batch containing a `block_id` already present in `mc_tags`. Coverage-check form: assert the preconditions — a non-empty mint batch committed, and at least one batch observed where the store's `exists` branch was taken — rather than the mismatch.
Confidence: medium — [evidence](evidence/speculative-tag-numbering-has-two-authorities.md). Both numbering sites read and verified. Whether the `existing_tag_ids` filter can ever admit a duplicate is not established; `compute_active_overlay_decisions` (`:8574-8761`) is 4e's scope.
Existing check: `transform.rs:22514`, `:22588`.
Impact: A rendered tag prefix that names a number the store gave to a different block breaks the tag-to-block mapping the reduction and nudge surfaces key on, and it does so in bytes already frozen into the provider prefix.
Open questions:
- Can `compute_active_overlay_decisions` emit a `block_id` that already has a tag? Unresolved, needs 4e.

### pass-firing-work-bounded-by-max-cas-retries

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test bounds the work of one firing.
Guarantee: One transform request performs at most nine `apply_once` invocations and then returns, so the handler cannot be pinned by the retry loop.
Check: `always` — instrument the loop at `:2274` and assert the attempt count never exceeds `MAX_CAS_RETRIES + 1 = 9` per firing. Then, for the liveness half: under a writer that forces a CAS conflict on the first three attempts and is then stopped, poll until the firing returns and assert it returns within nine attempts. `always` for the bound, with the bounded fault-free window stated in attempts because attempts are the unit `:2284` actually bounds. No wall-clock "eventually".
Fault/timing angle: The bound holds for the retry loop. It does **not** hold for the whole firing, because `load_cached_tags` (`:3391`, body `:7644-7697`) is an unbounded `loop` whose two exits are optimistic revalidations against `tag_cache_summary`. Nothing counts its attempts.
Required faults and enabling state: For the retry bound, the `#[cfg(test)]` attempt hook at `:5563-5564` committing a conflicting row. For the tag-loop concern, a writer that changes the session's tag summary between the two reads at `:7657` and `:7659`, or between `:7683` and `:7684`, on every iteration.
Confidence: high — [evidence](evidence/pass-firing-work-bounded-by-max-cas-retries.md). `MAX_CAS_RETRIES = 8` at `:82`, comparison at `:2284`, no other bounded loop in `apply_once`. The unbounded loop at `:7644` was read line by line; the body is 4e scope and is flagged, not claimed.
Existing check: `boundary_divergence_recut_retries_after_interleaved_historian_publish` (`transform.rs:20433`) exercises one retry, not the bound.
Impact: If the tag revalidation loop can spin, one request occupies a tokio worker thread indefinitely, because `run_transform` (`lib.rs:8322`) is called inline and not under `spawn_blocking`.
Open questions:
- Is `load_cached_tags`'s loop actually livelock-reachable in production, given the default build's only other `mc_tags` writers are `commit_transform` and `descend_lineage`? Unresolved; `mint_or_get_tags` (`mc-store/src/lib.rs:6258`) is marked as reachable only under `test` or the `test-support` feature (`:6255-6257`), so this needs the 4c concurrency result.

### synthetic-strip-precedes-every-coverage-read

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `pending_rewrite_passes_isolate_ingress_meta_usage_and_reconcile` (`transform.rs:20079`) and the injection module's bust-only freeze tests cover parts. No test asserts the ordering itself.
Guarantee: No boundary, coverage, selection or tail computation in `apply_once` observes a synthetic block, and no live block can carry a reserved `mc_` id.
Check: `always` — assert that every collection reaching `resolve_boundary_state`, `resolve_coverage`, the selection input and the output splice is derived from `live` (`:3358-3361`), and that `live` contains no block with `synthetic()` true or an `mc_`-prefixed id. `always` because the module header states it as an unconditional invariant (`:12-15`).
Fault/timing angle: The mechanism is a shadow, not a copy: `normalize_synthetic_todo_ingress` (`:3243`, body `:2405-2422`) marks flags on a clone, and `let req = rebased_req.as_ref().unwrap_or(ingress_req)` at `:3342` rebinds `req` so every later `req.messages` read (for example the ordinal check at `:3368`, the continuation-base first-live check at `:3441-3446`, and `mutation_exempt_mid` at `:3378`) sees the normalized flags. If a future edit moves a read above `:3342`, the invariant silently breaks for that read with no error.
Required faults and enabling state: An OpenCode array carrying a replayed synthetic todo pair whose CK metadata lacks the `synthetic` marker, so recognition must come from the reserved call-id namespace (`is_synthetic_todo_id`, `injection.rs`). Plus, for the backstop, a harness block whose flat id starts with `mc_`.
Confidence: high — [evidence](evidence/synthetic-strip-precedes-every-coverage-read.md). Enumerated every `ingress_req` use (`:3244`-`:3342`) and every `req.messages` use after `:3342`, confirming the shadow covers all of them at `HEAD`.
Existing check: `transform.rs:20079`; the `RESERVED_ID_PREFIX` guard at `:3363-3365` is itself a production check.
Impact: This is the PRIMARY of the two poison-resistance invariants named in the module header. A synthetic block reaching coverage lets an injected pair masquerade as the real boundary, which is the exact wedge the backstop exists to catch second.
Open questions: None.

### recut-intent-survives-the-mandatory-cas-reload

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `boundary_divergence_recut_retries_after_interleaved_historian_publish` (`transform.rs:20433`) constructs exactly this race. It does not run in CI.
Guarantee: A boundary divergence proven on attempt N is still repaired on attempt N+1, even though the reload observes a newer m1 watermark that would otherwise classify the pass as an ordinary defer.
Check: `always` — on any firing whose attempt N set `boundary_divergence_detected`, assert the accepted pass carries `materialize_reason == "boundary_divergence_recut"` (`:4361`). `always` because forgetting proven damage is wrong on every occurrence.
Fault/timing angle: The mechanism is `boundary_divergence_retry |= boundary_divergence_detected` at `:2289`, a sticky OR across the loop. On the retry, `:3889` skips the revalidation and `:3942` short-circuits the recut filter. Also, `boundary_divergence_pending_count` (`:3925-3939`) is reset to zero on a retry-driven recut (`:3947-3949`), so the three-pass suppression budget (`:85`) is not consumed by the retry.
Required faults and enabling state: A divergence candidate from `detect_boundary_divergence_candidate` (`:6557-6600`), plus a historian publish committing between the detection and the terminal commit, which is what forces the `CasConflict` at `:2283`.
Confidence: high — [evidence](evidence/recut-intent-survives-the-mandatory-cas-reload.md). Traced the flag from `:2270` through `:3232`, `:3889`, `:3942`, `:3953`, `:2289`.
Existing check: `transform.rs:20433`, and `stale_full_state_sync_cannot_rewind_a_committed_divergence_recut` (`:20841`) for the post-commit half.
Impact: Without the sticky flag, a session with a damaged coverage row alternates between detecting the damage and being told by a fresh watermark that a publish is legitimately ahead, so the repair never fires and the served prefix stays wrong.
Open questions:
- `active_legitimate_publication_window` (`:3924`) retains prior evidence rather than incrementing, bounded by "the 3,800-second wrapup request budget documented on the context" (`:3919-3923`). Is that budget enforced anywhere reachable from the transform, or only by the wrapup handler? Unresolved, needs 4a.

### output-cache-replace-trails-the-accepted-commit

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `serialized_output_cache_revert_epoch_bump_evicts_session` (`transform.rs:28884`) covers the epoch eviction. Nothing asserts the ordering against the commit.
Guarantee: The in-process serialized-output cache never holds entries produced by a pass the store rejected, and never serves entries from a superseded revert epoch.
Check: `always` — assert `SerializedOutputCache::replace` is reached only on a path where `commit_transform` either succeeded or was not required, and that every `snapshot` call passes the same `revert_epoch` the pass will commit. `always` because a stale cache hit produces wrong served bytes on every subsequent pass that hits it.
Fault/timing angle: `replace` is at `:5604-5613`, after the commit at `:5565` and after the `?` that propagates a `CasConflict`. `snapshot` is at `:5381` and is keyed on `meta.revert_epoch`, which by then already reflects a mid-pass truncate (`:4652`), so a post-revert render cannot reuse pre-revert entries. `snapshot` evicts on mismatch at `:421-427`.
Required faults and enabling state: A CAS conflict on the terminal commit with a non-empty `output_cache_entries`, plus separately a reconcile-rematerialize pass that bumps the epoch mid-pass and then renders.
Confidence: high — [evidence](evidence/output-cache-replace-trails-the-accepted-commit.md). Read `snapshot` (`:421-437`) and `replace` (`:441-471`) and confirmed the call ordering.
Existing check: `transform.rs:28884`; also the `#[cfg(test)]` drift assertion at `:5551-5577`-region (`"serialized output cache drift"`, `:5479`) which re-renders without the cache and compares canonical bytes.
Impact: A cache holding rejected-pass entries would serve bytes no accepted pass ever produced, which is indistinguishable downstream from a byte-stability violation and would bust the provider prefix.
Open questions:
- `replace` silently drops the whole entry set when it exceeds `max_retained_bytes` (`:445-447`). Is a session whose output always exceeds the budget permanently uncached, and does anything observe that? Suggest one record in 4c's cache-validity focus rather than here.

## Contract-vs-code leads

1. **"Each leaves the durable frozen-set UNCHANGED"**. `transform.rs:1796-1798`
   says every `TransformError` leaves durable state alone so "the CAS simply
   does not advance". Narrowly the claim is about `core.frozen_units` and is
   true. Read as written it is false for two paths: `descend_lineage` at
   `:3312` commits before the guards at `:3355`/`:3364`/`:3371`, and
   `truncate_compartments_for_revert` at `:4646` commits before the
   `CoverageGap` at `:4703-4710`. In both cases the CAS does not advance
   **and** durable state has changed. Cited both sides; not resolved in favour
   of the doc.

2. **"the module is the single writer in the daemon case"**.
   `transform.rs:80-81` justifies `MAX_CAS_RETRIES = 8` on a single-writer
   assumption. There is no per-session mutex on the transform path:
   `lib.rs:8322` calls the engine inline from an `async fn` and nothing
   serialises two concurrent requests for the same session id. What actually
   serialises durable writes is the store connection mutex
   (`../commons/crates/cortexkit-store/src/lib.rs:189`) plus the `row_version`
   CAS. The doc states a property; the code provides a weaker one that happens
   to be sufficient for the main path and demonstrably insufficient for the
   compartment watermark on Defer.

3. **"`reconcile_pending` ... is cleared only by a HARD rematerialize, never a
   SOFT"**. Cache-core `:214-215`. Scoped to SOFT it is accurate, but the same
   file's `step_defer` unconditionally assigns the field at `:197`, so a defer
   that regains the boundary clears it. The same file acknowledges the
   consequence at `:221-222`. A reader who takes `:214-215` as the general rule
   will mis-model the machine.

4. **"Decisions from this request stay in memory until the final cache-state
   compare-and-swap accepts the pass"**. `transform.rs:3505-3507`. True for
   `pending_overlays`, `core` and `meta`. Not true for the revert truncate or
   the lineage descent, which are decisions from this request that become
   durable before the CAS.

5. **The cache-state machine is not in this repository.**
   `Cargo.toml:15` points `cortexkit-cache-core` at
   `../commons/crates/cortexkit-cache-core`, a separate checkout at commit
   `d2208eda`. The transition rules this lens maps, and the guard at cache-core
   `:227` that the comment says is "enforced in the core, not assumed", can
   change with no diff in `magic-context` and no CI signal here. Recording it
   as a lead rather than a property because the remedy is a process decision.

## Open questions

- Can two transform requests for the same session id run concurrently in the
  daemon? Nothing in `lib.rs:8007-8615` appears to serialise them, and the
  answer decides whether `defer-commit-carries-no-compartment-fence` and
  `speculative-tag-numbering-has-two-authorities` are theoretical or live.
  Unresolved, needs 4c's route and dispatch result.
- Should `Exercised:` be `partial` when the only covering test is in a binary
  CI never runs? Eight of these twelve records depend on the answer. The scope
  map already raised it and left it needing human input; this lens uses
  `partial` and names the CI gap inline. (needs human input)
- `apply_additive_only` (`:2711-3219`) is a second engine with its own commit
  at `:3113`. It is `explicit-config-only`. Should 4b catalog its state
  transition separately, or is one record noting it shares
  `commit_transform`'s predicate sufficient? (needs human input)
- Does `descend_lineage` deduplicate a repeated `edge_id`? That decides whether
  `lineage-descent-write-precedes-the-array-validity-guards` is a leak or only
  an ordering smell. Unresolved, needs `mc-store/src/lib.rs:8177-8500`.
- The `#[cfg(test)]` block at `:5551-5577` re-renders every cached output and
  asserts byte equality ("serialized output cache drift"). It is the strongest
  check in the engine and it is compiled out of production. Is that the
  intended trade, or should a sampled form ship? (needs human input)
