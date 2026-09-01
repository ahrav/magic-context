# tstx-a-three-synthetic-predicates-disagree

## Discovery trigger

Part 4b's poison-resistance framing names two invariants the Rust transform
enforces, the first being that synthetic items are stripped before any boundary,
coverage, or tail computation
(`synthetic-strip-precedes-every-coverage-read`). Checking whether the
TypeScript side enforces it meant finding the TypeScript definition of
"synthetic". There are three, they disagree, and two of them live in the same file
forty lines apart in reading order.

## Evidence trail

Read at `HEAD` = `e447c927`.

**Predicate 1: `isSyntheticWireMessage`,
`packages/plugin/src/hooks/magic-context/module-wire.ts:855-863`.**

```ts
function isSyntheticWireMessage(message: MessageLike): boolean {
    if ((message.info as { synthetic?: unknown }).synthetic === true) return true;
    return message.parts.some(
        (part) =>
            part !== null &&
            typeof part === "object" &&
            (part as { synthetic?: unknown }).synthetic === true,
    );
}
```

Message-level flag **or** `some` part synthetic. No `syntheticTodoMarker`. No
non-empty-parts requirement, because the message-level flag short-circuits.
Consumed by the wire-slot exception described at `:999-1005` ("OpenCode can place
an unpersisted synthetic nudge between two persisted messages in one wire
snapshot ... Only explicit synthetic messages get this exception").

**Predicate 2: the encoder, `module-wire.ts:1413-1421`,** inside
`encodeOpenCodeMessagesToCk` (`:1390`).

```ts
const synthetic =
    parts.length > 0 &&
    parts.every(
        (part) =>
            part !== null &&
            typeof part === "object" &&
            ((part as Record<string, unknown>).synthetic === true ||
                (part as Record<string, unknown>).syntheticTodoMarker === true),
    );
```

`every` part, **plus** `syntheticTodoMarker` accepted, **plus** non-empty parts
required. Ignores the message-level flag entirely.

**Predicate 3: `assertNativeBoundary`,
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:633-635`.**

```ts
const parts = isRecord(first) && Array.isArray(first.parts) ? first.parts : [];
const synthetic =
    parts.length > 0 && parts.every((part) => isRecord(part) && part.synthetic === true);
```

`every` part, **no** `syntheticTodoMarker`, non-empty parts required, message-level
flag ignored.

**Three discriminating cases, derived from the source rather than observed.**

| Message | P1 (`some`, msg-flag) | P2 (encoder) | P3 (assert) |
| --- | --- | --- | --- |
| Two parts, one `synthetic: true`, one plain | **true** | false | false |
| Two parts, both `syntheticTodoMarker: true` | false | **true** | **false** |
| `info.synthetic === true`, `parts: []` | **true** | false | false |

**Correction to a claim this evidence originally carried.** I first recorded that
"nothing in `transform.rs` re-derives synthetic status from parts, so predicate 2
is the sole authority". That is wrong, and the correct picture is more interesting.

Rust reads `ServedMessage.meta.synthetic`, a plain `pub synthetic: bool`
(`crates/mc-module/src/transform.rs:541`), at fifteen sites (`:2408`, `:2521`,
`:2556`, `:2723`, `:2743`, `:3360`, `:3368`, `:3444`, `:5504`, `:5705`, `:5798`,
`:5829`, `:5895`, `:6326`, `:6449`). But it also **repairs** the flag on ingress.
`normalize_synthetic_todo_ingress` (`:2405-2422`), called at `:3243`, promotes any
non-synthetic message to synthetic when one of its content blocks is a `ToolCall`
or `ToolResult` whose id satisfies `is_synthetic_todo_id`
(`crates/mc-module/src/injection.rs:195-197`), which is
`id.starts_with("mc_synthetic_todo_")` (`injection.rs:23`).

The comment at `transform.rs:3239-3241` states the purpose exactly:

> OpenCode transports the frozen todo pair as one marked tool part. Older adapters did not
> copy that marker into CK metadata, so recognize the reserved call-id namespace here too.
> Normalizing before projection keeps the replayed pair out of selection, coverage, and output.

So predicate 2's `syntheticTodoMarker` acceptance and Rust's id-based repair are
two independent mechanisms for the same case, deliberately redundant, and the
prefix constant is duplicated across languages: `injection.rs:23` and
`packages/plugin/src/hooks/magic-context/todo-view.ts:82` both spell
`mc_synthetic_todo_`.

**The repair is load-bearing for a second reason.** `transform.rs:3357-3366`
collects `live` blocks as those failing `.synthetic()` (`:3360`) and rejects any
`live` block whose id starts with `RESERVED_ID_PREFIX` (`:3363-3364`,
prefix `"mc_"` at `:90-91`). A synthetic todo pair carries an `mc_synthetic_todo_*`
id, which is in the reserved namespace. So if the normalizer at `:3243` did not run
first, every replayed todo pair from an adapter that failed to set the flag would
be rejected with `ReservedId`. The ordering `:3243` before `:3363` is what prevents
that.

**Where the disagreement actually bites: the return leg.** With Rust's repair in
place, row 2 is doubly covered *outbound* — the encoder sets the flag and Rust
would recover it anyway. The uncovered direction is inbound. Rust mints its own
synthetic head ids as `mc_todo:{id}:call`, `mc_todo:{id}:result`, `mc_m0`, `mc_m1`,
and `mc_synthetic:{n}` (`transform.rs:2367-2375`), and `assertNativeBoundary` (P3)
does not read any id or message-level flag — it requires every part of the head to
carry `synthetic === true` specifically. Nothing on the TypeScript side repairs
that, and P3 is the check.

## Failure scenario

Two scenarios, of different severity, and the honest ordering puts the weaker one
second.

**Return leg, the live one.** The module returns a head whose parts carry
`syntheticTodoMarker: true` rather than `synthetic: true` — the same
representational choice the encoder accepts on the way out — together with a
non-empty `boundary_id`.

1. `assertNativeBoundary` computes `parts.every(part => part.synthetic === true)` →
   false, and throws (`:652-654`).
2. The catch at `:2894` logs the wire-invariant case (`:2896-2903`), replays LKG
   (`:2916-2921`), and calls `markFailure` (`:2924`).
3. Three consecutive such passes park the session (`:1474-1485`) and notify the
   user "Rust Magic Context is unavailable for this session".

The module did nothing wrong: it used a marker the adapter's own encoder treats as
equivalent. The user-visible symptom is a parked session with a transport-shaped
message, which points a reader at the transport rather than at a predicate
mismatch. Whether a real module actually emits that shape on the return leg is the
open question below; the asymmetry between P2 and P3 is not in question.

**Outbound leg, mitigated.** A message with one synthetic part and one plain part
(row 1) is synthetic to P1 and non-synthetic to P2. P1 gates the wire-slot
exception at `:999-1005`, so such a message borrows the preceding canonical ordinal
as if synthetic, while the encoder marks it non-synthetic on the wire. Rust's
normalizer does **not** repair this one, because the repair keys on a synthetic
todo id and this message has none. So the module receives a message whose ordinal
treatment and synthetic flag were decided by two different rules. This is the
quieter defect and the harder one to attribute.

## Timing windows and dependencies

None. This is a pure shape property, decidable from a single array by three
function calls. No fixture, no database, no module, no timing. It is the cheapest
record in the part.

Dependency on reachability: all three predicates sit on the rust-mode wire path, so
the *consequence* requires `transform_mode: "rust"`. The **disagreement** is
observable with no mode configured, because all three functions are reachable
directly. `isSyntheticWireMessage` is module-private in `module-wire.ts`, so a test
either exports it or reaches it through the slot logic that consumes it; that is
the only friction.

Dependency on Rust's repair: the outbound severity depends on
`normalize_synthetic_todo_ingress` running on every path that later reads the flag.
It is called once, at `:3243`, inside `apply_once`. `apply_additive_only` returns
earlier at `:3234`, so the additive-only engine does **not** get the repair. Part 4b
records that the OpenCode leg downgrades `transform_mode` to `ts` when compaction
is off, which is the additive-only path's main caller, so this may be unreachable
in the shipped configuration — but it is a real second entry point with a different
normalization posture, and it is noted rather than resolved.

## What a test must construct

1. **One table-driven test over the three rows.** For each message, call all three
   predicates and assert the expected triple. This is the whole property. It fires
   on a correct implementation because it asserts each predicate's *current*
   behaviour; if they are later unified, the expectations change in one place and the
   change is visible in review.
2. **A return-leg test for the live scenario.** Feed a head whose parts carry only
   `syntheticTodoMarker: true` into `assertNativeBoundary` with a `boundary_id`, and
   assert it throws. Then feed the same message through
   `encodeOpenCodeMessagesToCk` and assert the wire message has `synthetic: true`.
   The pair is the contradiction in about twelve lines, and it is worth having
   because it names the asymmetry rather than the two halves.
3. **A cross-language constant test.** Assert
   `todo-view.ts:82`'s `SYNTHETIC_CALL_ID_PREFIX` equals `"mc_synthetic_todo_"`, the
   literal `injection.rs:23` uses. A duplicated constant across two languages with no
   shared source is a drift hazard, and a one-line assertion in each language pins it
   cheaply. This is the kind of check that costs nothing and catches a rename.
4. **The outbound row-1 case, through the slot logic.** Encode a
   one-synthetic-one-plain message and assert both the ordinal treatment P1 produced
   and the `synthetic` flag P2 produced, in the same assertion block, so the
   disagreement is recorded at the point it reaches the wire.

What a test must not do: assert that all three predicates agree. They do not, so
that test fails today for a reason it cannot explain. The property is stated as the
invariant that *should* hold; the table test establishes the current disagreement so
the invariant can be argued about.

## Investigation log

### Q: Which predicate is intended as canonical?

- Sources examined: all three predicates; `transform.rs:541`; the fifteen
  `meta.synthetic` reads; `normalize_synthetic_todo_ingress` at `:2405-2422` and its
  call at `:3243`; the comment at `:3239-3241`; `is_synthetic_todo_id` at
  `injection.rs:195-197` and its prefix at `:23`; the reserved-id check at
  `:3357-3366`; `todo-view.ts:82`; the slot-exception comment at
  `module-wire.ts:999-1005`.
- Findings: the answer differs by leg, which is why a single canonical predicate is
  probably the wrong goal. Outbound, predicate 2 is authoritative and Rust already
  carries a redundant repair for the one case it was known to miss, so P1's
  divergence is the outbound problem and it is a slot-placement question rather
  than a flag question. Inbound, P3 re-derives from parts a fact the module knows
  and could state: Rust *writes* `meta.synthetic = true` at `:2419` on messages it
  promotes, and mints ids in a namespace it controls (`:2367-2375`), so a
  message-level flag or an id check would be strictly more reliable than scanning
  parts.
- Missing evidence: whether the module's encode-back sets a message-level synthetic
  marker on the returned array. That decides whether P3 should read a flag or widen
  its part scan to accept `syntheticTodoMarker` for symmetry with P2.
- Conclusion: needs human input, split into two answers. (a) Outbound: should P1
  delegate to the encoder's rule? They classify the same array in the same file for
  different purposes and the `some`/`every` split looks unintentional. (b) Inbound:
  does the module mark synthetic messages on the wire? That is a lookup in
  `mc-module`'s encode-back, not a design decision, and it converts (b) from an
  open question into a one-line fix in either direction.

### Q: Does the `parts.length > 0` requirement in P2 and P3 exclude anything real?

- Sources examined: `module-wire.ts:1413-1421`; the encoder's content loop at
  `:1423-1440`, which builds `content` from parts and skips non-object parts;
  `rust-mode-transform.ts:633-635`.
- Findings: a zero-part message encodes to empty `content`, so it carries no
  payload and treating it as non-synthetic is inert for the encoder. For P3 it is
  not inert: a head whose payload lives outside `parts` is rejected for having no
  parts rather than for being wrong, and the adapter forbids inspecting the array
  (`:1264-1265`), so such a shape is not excluded by contract.
- Missing evidence: whether any real module response places m0 payload outside
  `parts`.
- Conclusion: resolved as a non-finding for P2, unresolved and low priority for P3.
  Pinned as row 3 of the table so the behaviour is recorded rather than rediscovered.

### Q: Does `apply_additive_only` get the ingress repair?

- Sources examined: `transform.rs:3234` (`return apply_additive_only(...)`), `:3243`
  (the normalizer call, after that return); Part 4b's note that the OpenCode leg
  downgrades `transform_mode` to `ts` when compaction is off.
- Findings: the normalizer is called at `:3243`, strictly after the additive-only
  early return at `:3234`, so the additive-only engine sees unrepaired flags. Part
  4b's `sel-*` records and its portfolio evaluation both treat the additive-only arm
  as possibly unreachable on the shipped OpenCode leg for exactly this
  configuration reason.
- Missing evidence: whether any shipped caller reaches `apply_additive_only` with a
  synthetic todo pair in the request.
- Conclusion: unresolved, and out of this part's scope — it is a Rust-side
  reachability question that Part 4b owns. Recorded in the dependencies section so a
  reader comparing the two entry points does not assume uniform normalization.
