# tstx-a-unfrozen-todo-verdict-decides-oppositely-per-path

## Discovery trigger

Mining equivalence relations worth checking as metamorphic properties, the natural
first candidate is "same input yields the same output on both sides". Testing that
premise on the smallest shared input — a single `ToolAvailabilityVerdict` — found it
already false, for a reason visible in two expressions eight files apart.

This is the cleanest divergence in the part: one value, two consumers, opposite
verdicts, no timing, no fixture, no module.

## Evidence trail

Read at `HEAD` = `e447c927`.

**The shared input.** Both paths resolve the same verdict from the same helper.
`packages/plugin/src/hooks/magic-context/transform.ts:889-890`:

```ts
const todowriteAvailability: ToolAvailabilityVerdict =
    resolveTodowriteAvailabilityFromMessages(sessionId, messages);
```

`ToolAvailabilityVerdict` carries `callable: boolean` and `frozen: boolean`
(`ctx-reduce-availability.ts:36`, `:42`), and the `frozen` field's own comment at
`:37-41` describes callers that "PERSIST state derived from the verdict ... must skip
persistence until a frozen verdict exists, or a later final verdict flips the
persisted bytes and busts the prompt cache".

**The TypeScript renderer's polarity.**
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:250-251`:

```ts
const toolsMapUnavailable =
    args.todowriteAvailability.frozen && !args.todowriteAvailability.callable;
```

Suppression requires **both** `frozen` and `!callable`. So with `frozen === false`,
`toolsMapUnavailable` is `false` — the tool is treated as **available**.

**The adapter's polarity.**
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:141-147`:

```ts
async function resolveCombinedTodowriteVerdict(
    deps: TransformDeps,
    sessionId: string,
    messages: readonly MessageLike[],
    availability: ToolAvailabilityVerdict,
): Promise<boolean> {
    if (!availability.frozen || !availability.callable || deps.compactionOff === true) return false;
```

Returning `false` means unavailable. The guard requires **both** `frozen` and
`callable`. So with `frozen === false`, the function returns `false` — the tool is
treated as **unavailable**.

**The truth table, from the two expressions.**

| Verdict | TypeScript renderer | Rust-mode adapter | Agree? |
| --- | --- | --- | --- |
| `frozen: true, callable: true` | available | available | yes |
| `frozen: true, callable: false` | unavailable | unavailable | yes |
| **`frozen: false, callable: true`** | **available** | **unavailable** | **no** |
| `frozen: false, callable: false` | available | unavailable | no |

Rows 3 and 4 are the divergence. Row 3 is the reachable one, because `frozen: false`
is only ever returned alongside `callable: true`: `ctx-reduce-availability.ts:158`
returns `{ callable: true, frozen: false }` and `:193` returns
`{ callable: true, frozen: false }`. Row 4 is not constructible from the resolvers as
written, so the test surface is row 3 alone.

**When `frozen: false` occurs.** Two arms, both deliberate:

- `:158`, after the loop finds no `role === "user"` message in the array. The comment
  at `:154-157` explains: "No user message in the array at all (not a real prompt —
  e.g. a stray pass on an empty session). Fail open but do NOT freeze: caching true
  here would lock a deny-list session into the tool's surface before its first user
  message ever arrives to say otherwise."
- `:193`, in the database-backed resolver, `return { callable: true, frozen: false }; // session not persisted yet`.

So `frozen: false` means "not yet determinable", and the two paths resolve that
uncertainty in opposite directions. Neither is obviously wrong in isolation. The
renderer fails open, the adapter fails closed.

**A second, independent divergence in the same pair of functions.** The refresh
cadence differs.

The renderer re-reads the live permission only on a cache-busting pass —
`transform-postprocess-phase.ts:253`:

```ts
if (args.isCacheBustingPass && args.client && !toolsMapUnavailable) {
```

The adapter re-reads whenever a client exists, on every pass —
`rust-mode-transform.ts:152-153`:

```ts
if (deps.client) {
    try {
        permissionDenied = await todowritePermissionDenied(...)
```

The renderer's cadence is documented as intentional at
`ctx-reduce-availability.ts:92-93`: "The cached permission verdict is updated only
during cache-busting passes; defer passes reuse it without performing a live
permission read." The adapter does not follow it. Both then persist the result
(`transform-postprocess-phase.ts:260`, `rust-mode-transform.ts:160`), and both share
the same durable store via `setPersistedTodoPermissionDenied`, so the adapter's
every-pass read can overwrite a value the renderer's cadence deliberately left stale.

Both functions handle a failed read the same way, which is the one place they agree
by design: the renderer's comment at `:262-264` ("A transient SDK read must not turn
a previously denied tool back on") and the adapter's at `:162-163` ("A failed SDK
read cannot turn a prior denial into an allow") state the same rule.

## Failure scenario

A session's first pass, before OpenCode has persisted the session row, or a pass
whose array contains no user message.

1. `resolveTodowriteAvailabilityFromMessages` returns
   `{ callable: true, frozen: false }` (`ctx-reduce-availability.ts:158` or `:193`).
2. Under the default TypeScript renderer, `toolsMapUnavailable` is `false`
   (`transform-postprocess-phase.ts:250-251`), so the synthetic todo-pair machinery
   proceeds and a pair is injected into the served array.
3. Under `transform_mode: "rust"`, `resolveCombinedTodowriteVerdict` returns `false`
   (`rust-mode-transform.ts:147`), so no pair is injected.

The two renderers serve different first arrays for the same input, for a reason that
has nothing to do with rendering. Consequences:

- If the session genuinely lacks `todowrite`, the renderer injected a pair for a tool
  the model cannot call — the outcome `transform.ts:886-888` says the gate exists to
  prevent ("must not replay a pair for a tool the model cannot call").
- If the session has `todowrite`, the adapter withheld a pair the model could have
  used, and the first pass is the pass where the plan matters most.
- For a differential, this is a false positive on every fixture whose first pass has
  an unfrozen verdict. A comparison harness that does not normalize it will report a
  rendering divergence that is actually an availability-polarity divergence, which is
  the worst kind of noise: it looks like the thing you were looking for.

## Timing windows and dependencies

The window is the interval during which the verdict is unfrozen: from the session's
first transform pass until either a user message with a `tools` map appears in the
array or the session row is persisted. That is the first pass or two, which is
precisely the window in which the first render is composed and cached.

There is no race. Both expressions are synchronous reads of one value, so the
divergence is deterministic given the verdict.

Dependencies:

- Reachability of `frozen: false` depends on `ctx-reduce-availability.ts:158` and
  `:193`, both outside this file set but both plainly reachable: `:193` fires whenever
  the session row is absent, which is every session's first pass before persistence.
- `tstx-a-frozen-tool-verdict-is-evictable` supplies a **second** route to an
  unfrozen verdict: LRU eviction followed by a re-resolution that finds no user
  message. So the window is not only the session's opening; it can reopen later in a
  long-lived process. The two records should be read together, and the eviction record
  is the reason this one is not confined to first passes.
- `deps.compactionOff` is a third disjunct in the adapter's guard (`:147`) but not a
  divergence: the renderer also disables the machinery under compaction-off, at
  `transform-postprocess-phase.ts:367`.

## What a test must construct

1. **The polarity table, directly.** Call both predicates with all four verdicts and
   assert the four-row table above. Two of the four rows agree, which is what makes the
   test informative rather than an assertion of the obvious: it pins where the paths
   coincide as well as where they diverge. This is about fifteen lines and needs no
   fixture. `resolveCombinedTodowriteVerdict` is module-private, so the test either
   exports it or reaches it through a pass.
2. **The end-to-end divergence, which is the property.** One fixture, a session with
   no persisted row so the verdict is `{ callable: true, frozen: false }`. Run it twice
   through `createTransform`, once with `transformMode: "ts"` and once with
   `"rust"` plus a stub returning the input array unchanged. Assert the two served
   arrays differ *only* in the presence of the synthetic todo pair. Asserting
   "differ only in" rather than "differ" is what makes the test a metamorphic relation
   rather than a snapshot: it isolates the cause.
3. **The cadence divergence.** Same fixture, but count calls to
   `todowritePermissionDenied` across three passes of which one busts the cache. Assert
   the renderer called it once and the adapter three times. Then assert the durable
   value after the adapter's run can differ from the renderer's, which is the
   consequence that matters because the store is shared.
4. **The agreed row, as a regression guard.** Assert both paths suppress on
   `{ frozen: true, callable: false }`. If a future fix unifies the polarity, this row
   must not move, and having it asserted separately means the fix's diff shows only the
   rows it intended to change.

## Investigation log

### Q: Which polarity is intended? The rust side's is the conservative one, and the comment at `transform.ts:886-888` argues for conservatism.

- Sources examined: `transform.ts:884-888`; `transform-postprocess-phase.ts:250-251`
  and `:253`; `rust-mode-transform.ts:141-172`; `ctx-reduce-availability.ts:36-42`
  (the `frozen` field and its comment), `:92-93`, `:154-158`, `:193`.
- Findings: the two comments argue in opposite directions and both are coherent.
  `transform.ts:886-888` argues for conservatism ("must not replay a pair for a tool
  the model cannot call"), which matches the adapter. `ctx-reduce-availability.ts:154-157`
  argues for failing open while undetermined ("Fail open but do NOT freeze: caching
  true here would lock a deny-list session into the tool's surface"), which matches the
  renderer. So the disagreement is not an oversight in one place; it is two authors
  resolving the same ambiguity differently, each with a stated reason.
  `ctx-reduce-availability.ts:37-41`'s comment on the `frozen` field — that callers
  which persist derived state "must skip persistence until a frozen verdict exists" — is
  the closest thing to a contract, and it says what *not* to do (persist) rather than what to do (inject or
  withhold). Neither consumer violates it.
- Missing evidence: whether an unfrozen first pass's injected todo pair is durable.
  If the renderer's pair is persisted as an anchor
  (`mirrorRustSyntheticTodoAnchor` at `rust-mode-transform.ts:2664-2670` is the
  adapter's equivalent), then the renderer's fail-open choice writes state the
  `frozen` field's comment says should wait, which would settle the question against
  the renderer. I did not trace the renderer's anchor persistence, which is in
  `todo-view.ts` and outside this file set.
- Conclusion: needs human input, and the tie-breaker is the persistence question
  above rather than a taste judgement. Recommend framing it as: does the renderer
  persist a todo anchor on an unfrozen pass? If yes, the renderer contradicts
  `ctx-reduce-availability.ts:37-41` and should adopt the adapter's polarity. If no,
  both are defensible and the project should pick one and state it at the `frozen`
  field's definition, so the next consumer inherits a rule instead of a choice.

### Q: Is the cadence divergence a defect or a deliberate adaptation?

- Sources examined: `ctx-reduce-availability.ts:92-93`;
  `transform-postprocess-phase.ts:253`; `rust-mode-transform.ts:152-160`; the shared
  writer `setPersistedTodoPermissionDenied` called at
  `transform-postprocess-phase.ts:260` and `rust-mode-transform.ts:160`.
- Findings: the cadence rule is stated at `ctx-reduce-availability.ts:92-93` as a
  property of the cache, not of one consumer, and the renderer honours it while the
  adapter does not. Both write the same durable field. Under rust mode the adapter is
  the only writer, so nothing is overwritten in practice — but a mode flip mid-install,
  or a second process on a different mode sharing the database, puts an every-pass
  writer and a bust-only writer on the same row.
- Missing evidence: whether `todowritePermissionDenied` is cheap. If it is an SDK
  round trip per pass, the adapter's cadence is also a latency cost, which
  `docs/rust-mode-transport-overhead-2026-08-10.md` suggests is a live concern for this
  path, though that document does not mention this call.
- Conclusion: unresolved, and lower priority than the polarity question. Recorded as a
  second finding in the same record rather than a separate one, because it is the same
  two functions and a fix to either would naturally address both.
