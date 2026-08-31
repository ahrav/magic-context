# tstx-a-reserved-mc-id-namespace-is-unenforced-in-typescript

## Discovery trigger

Part 4b's poison-resistance framing names two Rust invariants, the second being
that the `mc_*` id namespace is reserved. The scope map's second attention focus
for 5c asks directly: "Check whether the TypeScript path enforces both. Since only
the TypeScript path is CI-verified, a TypeScript-only invariant is an unverified
Rust obligation and a Rust-only invariant is a live TypeScript defect. Record the
direction for each"
([scope-map:558-563](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)).

This one is Rust-only, so by the scope map's own rule it is a live TypeScript
exposure on the path a default install runs.

## Evidence trail

Read at `HEAD` = `e447c927`.

**The Rust invariant.** `crates/mc-module/src/transform.rs:90-91`:

```rust
/// The reserved id prefix: a non-synthetic item bearing it is a contract violation.
const RESERVED_ID_PREFIX: &str = "mc_";
```

Enforced at two sites. `:2735-2736`, inside a block filter that excludes synthetic
blocks at `:2723`:

```rust
if block.id().starts_with(RESERVED_ID_PREFIX) {
    return Err(TransformError::ReservedId);
}
```

And `:3357-3366`, which builds `live` as the non-synthetic projection blocks
(`:3360` is `.filter(|i| !i.synthetic())`) and rejects any whose id is reserved
(`:3363-3364`). The error variant is `TransformError::ReservedId` (`:1805`),
displayed at `:1849` as "non-synthetic item used a reserved mc_* id".

**The invariant is scoped to non-synthetic items, and a repair makes that
workable.** Both enforcement sites filter synthetic blocks out first, because
Rust's *own* synthetic ids live in the reserved namespace:
`transform.rs:2367-2375` mints `mc_todo:{id}:call`, `mc_todo:{id}:result`, `mc_m0`,
`mc_m1`, and `mc_synthetic:{n}`.

`normalize_synthetic_todo_ingress` (`:2405-2422`, called at `:3243`) promotes a
non-synthetic message to synthetic when a content block carries a `ToolCall` or
`ToolResult` id satisfying `is_synthetic_todo_id`
(`crates/mc-module/src/injection.rs:195-197`, prefix `"mc_synthetic_todo_"` at
`:23`). Since `:3243` runs before `:3363`, a legitimate replayed todo pair is
promoted to synthetic and therefore skipped by the reserved-id check. The comment
at `:3239-3241` says so: "Older adapters did not copy that marker into CK metadata,
so recognize the reserved call-id namespace here too."

So Rust's posture is: reserve `mc_`, mint inside it for synthetic items, repair the
one legitimate case where the flag might be missing, and reject everything else.

**The TypeScript side has no part of this.** Searched all 12 units in the sub-part
for the prefix and for rejection vocabulary:

- `grep -rn "mc_"` across the 12 files returns two hits, neither a check:
  `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2908`
  (`sessionLog(sessionId, "mc_rust_emergency_refusal before_lkg")`, a log tag) and
  nothing else. The `mc_synthetic_todo_` constant lives at
  `packages/plugin/src/hooks/magic-context/todo-view.ts:82`
  (`SYNTHETIC_CALL_ID_PREFIX = "mc_synthetic_todo_"`), which is outside the 12-file
  set and is a *minting* constant, not a rejection.
- `grep -n "reserved\|ReservedId\|ordinal_violation\|OrdinalViolation\|DuplicateBlockId"`
  over `rust-mode-transform.ts` and `module-wire.ts` returns nothing. The adapter
  has no arm for any of the three ingress-validation errors Rust can raise.

**The encoder passes a supplied id through unchanged.**
`packages/plugin/src/hooks/magic-context/module-wire.ts:1404-1406`:

```ts
const id =
    (typeof info.id === "string" && info.id.length > 0 && info.id) ||
    `opencode-${crypto.createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 24)}`;
```

So a harness-supplied `mc_*` id reaches the module verbatim. The encoder mints
`opencode-<sha>` only when the id is absent, so it never introduces a reserved id
of its own.

**The trust boundary is real.** The message array arrives from OpenCode. The scope
map classifies this surface as having a trust boundary on exactly this ground:
"consumes harness-supplied message arrays"
([scope-map:398](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)).
Nothing between the harness and the wire filters ids.

## Failure scenario

**Under rust mode.** A message arrives with `info.id = "mc_m0"` and parts that are
not all synthetic — a user message whose id a caller chose, or a replayed synthetic
message whose marker was lost in a way the todo-id repair does not cover because
the id is not a `mc_synthetic_todo_*` tool id.

1. The encoder classifies it non-synthetic (`module-wire.ts:1413-1421`) and passes
   the id through (`:1404-1406`).
2. `normalize_synthetic_todo_ingress` does not promote it, because its content
   blocks carry no synthetic-todo id.
3. `:3363-3364` returns `TransformError::ReservedId`.
4. The adapter has no arm for it, so it reaches the single catch at `:2894` as a
   generic error, indistinguishable from a transport failure. `markFailure`
   (`:2924`) increments `consecutiveFailures`; three such passes park the session
   (`:1474-1485`).

Because the poisoned id is a property of the *input*, it recurs on every pass, so
the park is immediate and permanent for that session. The user sees "Rust Magic
Context is unavailable for this session; retry after the module recovers"
(`:1479-1480`), which names the module as the thing to wait for when the actual
cause is one field in the input.

**Under the default TypeScript mode.** The same input is processed with no
rejection at all. What Rust exists to prevent is therefore unguarded on the path
users run. The concrete collision candidate is `mc_synthetic_todo_*`: the
TypeScript side mints call ids with that prefix (`todo-view.ts:82`), so a
harness-supplied id in the same namespace could alias a synthetic todo call the
renderer is tracking. Whether that aliasing has a consequence depends on
`todo-view.ts` and `inject-compartments.ts`, both outside this file set, which is
why the record's confidence on the consequence is medium rather than high.

## Timing windows and dependencies

No timing window. This is an ingress-validation property: a single-pass, single-message
shape test.

The asymmetry that makes it a divergence record rather than a Rust record: the
invariant's *obligation* is unconditional (Rust checks it on every pass), while its
*enforcement* exists on one side only. Part 4b establishes none of the 271 Rust
transform tests run in CI, so the invariant is stated in Rust, tested in Rust,
verified nowhere, and unenforced in the implementation that ships by default.

Dependencies for the rust-mode consequence:

- Whether `TransformError::ReservedId` reaches the adapter as a distinguishable
  error depends on the transport's error mapping, which is `module-transport.ts`
  (1,386 lines, held out as a boundary file by the scope map at
  `scope-map:545-547`). The adapter's `isTransformPageAttemptMismatch` (`:663-681`)
  shows the pattern for recognising a specific module error by code or message, so
  the mechanism exists and is simply not used for `ReservedId`.
- `apply_additive_only` returns at `transform.rs:3234`, before the normalizer at
  `:3243`, so the additive-only engine has a different normalization posture. Part 4b
  owns that reachability question.

## What a test must construct

1. **The TypeScript-mode case, which is the live exposure.** Drive a default-mode
   pass with a message whose `info.id` is `"mc_m0"` and whose parts are ordinary
   text. Assert the pass completes. Then decide what *should* happen — and that is
   the point of the test: it documents that nothing happens today, so the decision
   is forced rather than deferred. Per METHOD.md's coverage-check rules the marker
   should assert the preconditions (a default-mode pass, an input id in the reserved
   namespace, a non-synthetic classification) rather than asserting a violation,
   because the violation's consequence is not yet established.
2. **The encoder pass-through.** Feed the same message through
   `encodeOpenCodeMessagesToCk` and assert the wire id is `"mc_m0"` verbatim and
   `synthetic` is `false`. Two assertions, no fixture, and together they prove the
   poisoned id reaches the module unaltered. This is the cheapest half and it needs
   no Rust process.
3. **The rust-mode consequence, once a real module is available.** With a module in
   the path, assert the pass fails and — the useful part — assert the failure is
   *distinguishable*, that is, that the adapter logs or classifies it as an
   input-validation error rather than a transport error. That assertion will fail
   today, which is the finding: it is the argument for adding a `ReservedId` arm
   alongside `isTransformPageAttemptMismatch`.
4. **The legitimate-pair control.** A replayed synthetic todo pair with
   `mc_synthetic_todo_*` ids and `syntheticTodoMarker: true` parts must **not** be
   rejected. This is the case Rust's normalizer exists for, and asserting it keeps a
   future TypeScript-side `mc_` filter from breaking the one legitimate use of the
   namespace. Without this control, a naive fix to case 1 would reject every todo
   pair.

Case 4 is the one an implementer would most likely miss, which is why it belongs in
the record rather than being left to the fix.

## Investigation log

### Q: Does the TypeScript renderer actually have an `mc_`-collision to prevent?

- Sources examined: `grep -rn "mc_"` across the 12 units, which returns only the
  log tag at `rust-mode-transform.ts:2908`; `todo-view.ts:82`
  (`SYNTHETIC_CALL_ID_PREFIX = "mc_synthetic_todo_"`); `injection.rs:23`, the
  identical Rust constant; `module-wire.ts:1404-1406`, the pass-through;
  `transform.rs:2367-2375`, the Rust minting sites.
- Findings: the TypeScript side mints exactly one reserved-namespace id shape,
  `mc_synthetic_todo_*`, and it does so for synthetic todo call ids. Rust mints five
  shapes. So the TypeScript renderer's exposure is narrower than Rust's: only a
  supplied `mc_synthetic_todo_*` id could alias something the TypeScript side is
  tracking, whereas a supplied `mc_m0` would alias nothing in TypeScript and
  everything in Rust. That is a useful narrowing — it means the default-mode
  exposure is real but small, and the rust-mode exposure is the larger one.
- Missing evidence: whether `todo-view.ts` or `inject-compartments.ts` looks up a
  synthetic todo call by id in a way a collision could redirect. Both are outside
  this file set: `inject-compartments.ts` (2,958 lines) is 5b scope per
  `scope-map:517`, and `todo-view.ts` is in no sub-part.
- Conclusion: unresolved, needs a read of those two files. Narrowed usefully in the
  process: the question is not "does TypeScript reserve `mc_`" (it does not) but
  "can a supplied `mc_synthetic_todo_*` id collide with a minted one", which is a
  single-prefix question in two named files rather than an open-ended audit.
  Recommend it be attached to whichever pass takes `inject-compartments.ts`.

### Q: Could the adapter recognise `ReservedId` if it wanted to?

- Sources examined: `isTransformPageAttemptMismatch` at
  `rust-mode-transform.ts:663-681`, which walks the `cause` chain checking
  `current.code` against two string constants and `current.message` against a regex;
  the catch at `:2894`; `markFailure` at `:1470-1485`.
- Findings: yes, and the pattern is already in the file. `isTransformPageAttemptMismatch`
  demonstrates recognising a specific module error by code or message with cycle
  protection (`seen` at `:665`, `:667`). A `ReservedId` arm would be structurally
  identical. What it should *do* is the open part: parking on a permanently poisoned
  input is arguably correct, but parking with a message blaming the module is not.
- Missing evidence: the wire form of `TransformError::ReservedId` — whether the
  transport surfaces the `Display` string from `transform.rs:1849` or a numeric code.
- Conclusion: resolved as "the mechanism exists"; the wire form is unresolved and
  answering it needs `module-transport.ts`, held out as a boundary file. Recorded so
  the fix's shape is known even though its input encoding is not.
