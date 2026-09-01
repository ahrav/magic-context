# tstx-a-smart-drops-off-is-inert

## Discovery trigger

Part 4b's lens C records claim C24: `CONFIGURATION.md:763` promises that smart
drops "replay byte-for-byte identically" and that "**When `smart_drops` is off, the
messages sent to the model are byte-identical to the age-based-only behavior** — the
entire feature is inert", and notes "the byte-identity half has no Rust check"
([part-4b lens-c:74](../../part-4b-transform/_lenses/lens-c-claims-and-checks.md)).

The task asks what the TypeScript side does with each named Rust behaviour. This is
the one where the answer runs the other way: the TypeScript implementation is
structurally arranged so the claim holds, and the cheap assertion belongs here
rather than in Rust.

## Evidence trail

Read at `HEAD` = `e447c927`.

**The claim.** `CONFIGURATION.md:763`, in full, is the "Cache safety" paragraph:

> **Cache safety.** Selection is age-independent, but smart-drops only *acts* during a
> transform pass that is already rewriting the message array (the same execute-threshold
> gate the age-based drop uses), so it never causes a prompt-cache miss on its own. Every
> drop resolves to the same deterministic placeholder as the normal drops, so defer passes
> replay byte-for-byte identically. **When `smart_drops` is off, the messages sent to the
> model are byte-identical to the age-based-only behavior** — the entire feature is inert.

Two separate promises. The defer-replay determinism is not this record; the
inertness-when-off is.

**The default is off.**
`packages/plugin/src/config/schema/magic-context.ts:958-964`:

```ts
smart_drops: z
    .boolean()
    .default(false)
```

`:960` is the default. The `.describe()` at `:961-963` repeats the claim in
different words: "when off the wire is byte-identical to the positional-only
reclaim." So there are two independent statements of the same promise, in
`CONFIGURATION.md` and in the schema.

**The structure that satisfies it.**
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:1349-1393`:

```ts
const syntheticPendingOps = buildSyntheticToolReclaimOps({ ... });   // :1350
...
const editMarkerTagIds = new Set<number>();                          // :1361
if (args.smartDrops) {                                               // :1362
    const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
    const supersessionOps = buildSupersessionReclaimOps({ ... });    // :1365
    for (const op of supersessionOps) { ...push... }                 // :1371
    const editReclaim = buildEditSupersessionReclaim({ ... });       // :1374
    for (const op of editReclaim.ops) { ...push... }                 // :1380
}
autoReclaimTargetCount = syntheticPendingOps.length;                 // :1393
```

The structure is what makes the property provable rather than merely plausible.
`buildSyntheticToolReclaimOps` at `:1350` runs unconditionally and produces the
positional-only baseline. Both smart-drops builders, `buildSupersessionReclaimOps`
(`:1365`) and `buildEditSupersessionReclaim` (`:1374`), and both loops that push their
output into `syntheticPendingOps`, are inside the single `if (args.smartDrops)` at
`:1362`. `editMarkerTagIds` is declared outside the block (`:1361`) but only
populated inside it (`:1384`).

So with the flag off, `syntheticPendingOps` at `:1393` is exactly what `:1350`
produced. There is no second gate to check and no partial path. That is a
one-conditional proof, which is why the confidence is high without needing to trace
the builders.

**The keep-counts agree across implementations.** This matters because the inertness
claim would be worthless if the *baseline* differed between the two renderers.

- `packages/plugin/src/features/magic-context/reclaim-protection.ts:2`:
  `export const CTX_REDUCE_KEEP = 3;`
- `crates/mc-module/src/selection.rs:38`: `const CTX_REDUCE_KEEP: usize = 3;`
- `packages/plugin/src/hooks/magic-context/supersession-reclaim.ts:18`:
  `const TODOWRITE_KEEP = 1;`, consumed at `:57`; `CTX_REDUCE_KEEP` imported at `:1`
  and consumed at `:60`.

Both implementations keep 3. Rust uses it at `selection.rs:749` (`.take(CTX_REDUCE_KEEP)`),
TypeScript at `reclaim-protection.ts:17` (`.slice(0, CTX_REDUCE_KEEP)`).

**The documentation does not agree with either.** `CONFIGURATION.md:759`, in the
smart-drops class table:

> | `ctx_reduce` | Keep the newest 5 calls, drop older ones (preserves the visible reduce rhythm). |

Five. The schema's `.describe()` at `:963` says "spent ctx_reduce (keep newest 3)".
So one documentation line disagrees with another documentation line **and** with both
implementations, which agree with each other. That is the unusual shape worth
recording: the contract is wrong and the two implementations are right, which is the
inverse of every other divergence in this part. It is lead L4 in the lens.

**Existing on-path coverage.** Two test files, both running under `bun run test` at
`ci.yml:257-258`:

- `packages/plugin/src/hooks/magic-context/supersession-reclaim.test.ts:82` — "keeps
  the newest three ctx_reduce exemplars and drops older ones", inserting tags at `:86`.
- `packages/plugin/src/hooks/magic-context/tool-reclaim.test.ts:42` — "keeps the
  newest three ctx_reduce exemplars out of the age lane".

Both assert the keep-3 rule with the feature on. Neither asserts the off-path
equality, which is the whole of the documented promise.

## Failure scenario

The property fails if the off path contributes an operation. From the structure at
`:1349-1393` that requires a code change, so the realistic failure is a future one:

1. A third reclaim rule is added and its builder is placed at `:1350`'s level rather
   than inside the `if` at `:1362`, because the author reads
   `buildSyntheticToolReclaimOps` as "the unconditional list" without noticing that
   the smart-drops additions are the only thing the flag guards.
2. `smart_drops` stays off by default, so nobody notices.
3. On the next release, every user's served array changes. Because reclaim
   operations change the message array, and the array is what the provider caches on,
   this busts every prompt cache on upgrade.

`CONFIGURATION.md:765` names a related cross-version hazard for the on case ("If a
stale older binary co-runs with the feature on, the worst case is a one-time cache
bust"), which shows the project already reasons about cache busts from this feature.
The off case has no such note, presumably because it is assumed impossible — which is
exactly the assumption a test should hold in place.

A second, subtler failure: the *baseline* changes on one side only. If
`CTX_REDUCE_KEEP` were edited in `reclaim-protection.ts:2` and not in
`selection.rs:38`, the off-path arrays would diverge between renderers while both
sides' own inertness tests still passed. Two constants, two languages, no shared
source. That is a cheap thing to pin and nothing pins it.

## Timing windows and dependencies

None. This is a metamorphic relation over one boolean config field, evaluated
synchronously in one expression. No fault injection, no concurrency, no module, no
timing. Along with `tstx-a-three-synthetic-predicates-disagree` it is one of the two
records in this part that a differential harness could assert today, which is why the
lens lists it among the differential's preconditions.

Dependencies:

- The three builders (`buildSyntheticToolReclaimOps`, `buildSupersessionReclaimOps`,
  `buildEditSupersessionReclaim`) live outside this file set. The property does not
  depend on their internals — only on which side of the `if` they sit — so the record
  stands without reading them. That independence is the point of stating the property
  structurally.
- `applyPendingOperations` at `:1395` consumes `syntheticPendingOps`, so the
  observable consequence flows from set equality to array equality. A test can assert
  either; asserting the array is closer to the documented claim, which is about "the
  messages sent to the model".
- The pass must reach `:1349`: `toolReclaimExecutePass` (`:1344`) requires
  `!compactionOff && schedulerDecision === "execute"`, and `alreadyMutatingThisPass`
  (`:1345`) requires a prior mutation, and `!emergencyDropEligible` (`:1348`). A
  fixture must satisfy all three or the block never runs and the test passes
  vacuously. That is the one real trap in constructing this test.

## What a test must construct

1. **The metamorphic relation, which is the property.** One fixture, run twice
   through the postprocess with `smartDrops: false` and `smartDrops: true`, on a
   session seeded with the three classes the builders target: two or more `todowrite`
   tool tags, four or more `ctx_reduce` tags, and two or more edits to the same
   `filePath`. Assert that with the flag off the served array is byte-identical to a
   run with the smart-drops block removed — operationally, assert
   `autoReclaimTargetCount` equals `buildSyntheticToolReclaimOps`'s output length, and
   assert the served arrays are equal. Assert that with the flag on they differ, which
   is what proves the fixture is discriminating rather than the assertion vacuous.
2. **The vacuity guard.** Assert the block was entered: `toolReclaimExecutePass`,
   `alreadyMutatingThisPass`, and `!emergencyDropEligible` all true. Without this, a
   fixture that fails any of the three preconditions passes case 1 trivially and the
   test is worthless. This is the assertion most likely to be omitted.
3. **The cross-language constant pin.** Assert `CTX_REDUCE_KEEP === 3` in TypeScript
   and add the mirror assertion in `selection.rs`. Two one-line tests in two languages,
   catching a class of drift that no other check in either tree covers.
4. **The documentation correction, not a test.** `CONFIGURATION.md:759` says 5 and
   both implementations say 3. That is lead L4 and belongs in a documentation fix, not
   an assertion — but a test that pins 3 makes the documentation's error detectable by
   a reader comparing the two.

## Investigation log

### Q: Does the off path really contribute nothing, or is there a second gate elsewhere?

- Sources examined: `transform-postprocess-phase.ts:1340-1400`; every occurrence of
  `smartDrops` and `smart_drops` in `packages/plugin/src`, which is
  `transform.ts:526` (the dep declaration), `transform.ts:2247`
  (`smartDrops: deps.smartDrops === true`), `transform-postprocess-phase.ts:650` (the
  arg declaration), `transform-postprocess-phase.ts:1362` (the gate),
  `hook.ts:155` and `:1250`, `magic-context.ts:586` and `:958`,
  `features/magic-context/types.ts:15`, `edit-marker.ts:13`, and
  `plugin/hooks/create-session-hooks.ts:23`.
- Findings: exactly one behavioural gate, at `:1362`. Every other occurrence is a
  declaration, a plumbing assignment, or a comment. `transform.ts:2247` normalises with
  `=== true`, so an undefined dep is `false` rather than truthy, which closes the one
  obvious hole. `edit-marker.ts:13`'s comment ("`edit_marker`" rows, which only exist
  when `smart_drops` is on") and `types.ts:15` ("Only produced when the smart_drops
  config is on") are consistency statements about downstream data, not gates.
- Missing evidence: whether `edit_marker` rows written during an earlier on-period
  still affect rendering after the flag is turned back off. `edit-marker.ts:13` says
  such rows "only exist when `smart_drops` is on", which is true of their creation but
  says nothing about their persistence. If they persist and still render, then turning
  the flag off does not restore byte-identity for a session that ran with it on — which
  would be a genuine and interesting exception to the documented claim.
- Conclusion: resolved for a session that has never had the flag on, which is what the
  claim's "the entire feature is inert" most naturally means, and which is the case a
  default install is in. Unresolved for the flag-was-on-then-off transition. That
  second case is worth queueing as a separate question rather than folding into this
  record, because it is a durability question about `edit_marker` rows rather than a
  gating question about the postprocess. `CONFIGURATION.md:767` says the feature
  "Requires a restart to take effect", which means the transition happens at a process
  boundary and a mid-session flip is not the concern.

### Q: Do the two implementations share a baseline, so that inertness on one side means the same array as the other?

- Sources examined: `reclaim-protection.ts:2` and `:17`; `selection.rs:38` and `:749`;
  `supersession-reclaim.ts:1`, `:18`, `:57`, `:60`; `CONFIGURATION.md:759`;
  `magic-context.ts:963`.
- Findings: both keep 3, and both use it as a "keep the newest N" bound with a
  newest-first ordering (`supersession-reclaim.ts:41` comments "Active tool tags,
  newest-first, so 'keep newest N' = the first N seen"). So the baselines agree on this
  constant. The constant is duplicated with no shared source, and one documentation line
  disagrees with both.
- Missing evidence: whether every other constant in the baseline agrees. I checked
  `CTX_REDUCE_KEEP` and `TODOWRITE_KEEP`; `TODOWRITE_KEEP = 1` is local to
  `supersession-reclaim.ts:18` and I did not find its Rust counterpart.
- Conclusion: resolved for `CTX_REDUCE_KEEP`, unresolved for the rest of the baseline.
  Recorded as test case 3 because a constant-pinning assertion is the cheapest possible
  guard and the record already establishes that at least one such constant is duplicated
  across languages. The `TODOWRITE_KEEP` gap is noted rather than chased, since
  `selection.rs` is Part 4's scope.
