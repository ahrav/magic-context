# tstx-a-boundary-assert-is-module-triggered

## Discovery trigger

Part 4b establishes that the CI suite named after the Rust transform tests the
TypeScript caller against a stub returning canned objects, and that `boundary_id`
is part of the Rust contract Part 4b's
`synthetic-strip-precedes-every-coverage-read` covers. The task asks what the
adapter does with a response the stub could never produce. Working backwards from
that question meant first establishing what the adapter checks at all — and the
answer is that its one structural check on the returned array is gated on an
optional field the module itself chooses whether to send.

## Evidence trail

Read at `HEAD` = `e447c927`. All references in
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` unless stated.

**The check.** `assertNativeBoundary`, `:630-654`:

```ts
function assertNativeBoundary(output: unknown[], sessionId: string, boundaryId: string): void {
    const first = output.find((message) => messageInfo(message).role !== "system");
    const info = messageInfo(first);
    const parts = isRecord(first) && Array.isArray(first.parts) ? first.parts : [];
    const synthetic =
        parts.length > 0 && parts.every((part) => isRecord(part) && part.synthetic === true);
    if (info.role === "user" && info.sessionID === sessionId && synthetic) return;
```

Three conjuncts at `:636`: `role === "user"`, `sessionID === sessionId`, and the
all-parts-synthetic predicate computed at `:634-635`. The failure arm at
`:637-654` builds a diagnostic naming which clause failed, and the comment at
`:637-640` explains why: "without it, every violation reads identically and the
defect is undiagnosable from logs alone (a live incident required a binary bisect
that a single log line would have answered)." So the check has already caught a
real defect, which is evidence the check matters.

**The gate.** `:2660-2663`:

```ts
const boundaryId = response.boundary_id;
if (typeof boundaryId === "string" && boundaryId.length > 0) {
    assertNativeBoundary(appliedMessages, sessionId, boundaryId);
}
```

The assert runs if and only if the module sent a non-empty string `boundary_id`.

**`boundary_id` appears nowhere else in the file.** `grep -n boundary_id` over
`rust-mode-transform.ts` returns only `:2660`. So nothing requires the field on
any pass class, including a cache-busting pass, and nothing records its absence.
The adapter does know whether the pass busts the cache — `cacheBustingPass` is in
scope at `:2669`, seven lines later — so the information needed to require the
field is present and unused.

**This is the second of three module-triggered gates.** The other two:

- `mirrorRustRenderedClaimState` (`:715-760`) returns at `:722` unless the
  response carries `rendered_revision_locators` or `memory_snapshot_vector`
  (`:720-722`). When either is present, both must be present and valid or it
  throws (`:726-734`). So a response sending neither is unvalidated; a response
  sending one is rejected. That is a well-designed all-or-nothing gate, and it is
  still the module choosing whether to be checked.
- `runRustModePostprocess` (`transform-postprocess-phase.ts:357`) returns at
  `:379` if any message lacks an `info` record (`:371-380`). That one is
  shape-triggered rather than field-triggered and has its own record,
  `tstx-a-shared-postprocess-skips-any-array-with-a-bare-message`.

**Everything else is unconditional but shallow.** `responseValue` (`:657-661`)
requires an object. `applyNativeMessagesVerbatim` (`:1245-1289`) requires
`native_messages` to be a parseable-array string, an array, or a well-formed
delta. Neither inspects an element. `:1264-1265` states the policy: "The module
owns healing, ordering, and codec fidelity. Do not clone, normalize, or otherwise
inspect the returned native message array."

**The stub triggers none of it.** From `rust-mode-transform.test.ts` (3,702 lines,
70 tests): `boundary_id` appears at `:989` and `:1023` only, both inside the same
two-test region. Every other `native` array is declared bare, for example `:848`:

```ts
const native = [{ role: "assistant", parts: [{ type: "text", text: "module output" }] }];
```

That array has no `info` wrapper, and its single part is not marked synthetic, so
it would fail `assertNativeBoundary` on two of three conjuncts. It is applied
without complaint because the gate is closed.

`messageInfo` (`:347-350`) is why the bare shape reads as a message at all:

```ts
function messageInfo(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return {};
    return isRecord(value.info) ? value.info : value;
}
```

It falls back to the object itself. And `isRecord` (`:333-334`) is
`value !== null && typeof value === "object"`, which is also true of arrays, so a
nested array would satisfy it.

## Failure scenario

A module build stops sending `boundary_id` — a refactor, a new pass class that
forgets it, a response assembled on an error path. Every subsequent response is
applied verbatim with no head check. If that module also emits a malformed head,
the adapter serves it: a non-synthetic m0, an m0 scoped to a different session, or
an assistant message where m0 belongs.

The consequence is not a crash. It is that the Rust-side contract Part 4b calls
`[m0, m1] ++ tail` is served unverified, and the TypeScript side is the only place
it could have been caught, because Part 4b establishes none of the Rust tests run
in CI. The failure mode is silent and the symptom is wrong context, which the
comment at `:637-640` says previously cost a binary bisect to localise.

The inverse scenario is also worth naming: a module that sends `boundary_id` on
happy paths only. Then the check is present exactly when it is least needed and
absent on the error paths where a malformed head is most likely.

## Timing windows and dependencies

No timing window; the gate is a synchronous field test on every applied response.

The dependency that matters is ordering, not timing:
`runRustModePostprocess` at `:2650` runs **before** the assert at `:2662`, so when
the assert does fire, the postprocess has already mutated the array and written to
the database. That is the separate record
`tstx-a-postprocess-writes-precede-the-boundary-assert`, and the two interact: on
a response with no `boundary_id`, the postprocess is the only thing that touched
the array and nothing validated it afterwards.

Dependency on the transport: whether a real module ever omits `boundary_id` is a
question about `mc-module`'s response assembly, which is Part 4b and 4e territory.
This record does not claim the omission happens; it claims the adapter's only
structural check is under the module's control, which is true regardless.

## What a test must construct

The property is the biconditional, so both directions need a case, and only one
exists today.

1. **Gate closed, malformed head, applied.** Stub a response with no
   `boundary_id` whose `native_messages` head fails all three conjuncts — an
   assistant message with a non-synthetic part. Assert the pass **succeeds**, that
   `output.messages` equals the malformed array, and that `failureCount` is 0.
   Asserting success is the point: it documents the gate rather than the defect,
   which keeps the check meaningful on a correct implementation.
2. **Gate open, malformed head, rejected.** This exists:
   `rust-mode-transform.test.ts:1011` ("fails the pass when a present boundary
   lacks a synthetic session-scoped m0") supplies `boundary_id: "m1#0"` at
   `:1023` and a head whose part is not marked synthetic, and asserts
   `output.messages).toBe(input)` (`:1038`) and `failureCount).toBe(1)` (`:1040`).
3. **Gate open, well-formed head, applied.** Also exists, at `:967` ("applies
   module output through the OpenCode hook array reference"), whose `native` at
   `:973-982` is the one array in the file carrying `info` wrappers and
   `synthetic: true`.

Case 1 is the missing one and costs about fifteen lines. Its value is that it
turns an implicit gate into an asserted contract, so a future change that makes
`boundary_id` mandatory breaks a test that says why.

A fourth case worth adding, once case 1 exists: assert that a **cache-busting**
pass received a `boundary_id`. That is the requirement the gate currently does not
express, and `cacheBustingPass` at `:2669` makes it checkable.

## Investigation log

### Q: Should a cache-busting pass require `boundary_id`? The adapter knows `cacheBustingPass` at `:2669`, so the information is present.

- Sources examined: `rust-mode-transform.ts:2660-2670`; the sole `boundary_id`
  occurrence confirmed by grep; `mirrorRustSyntheticTodoAnchor` at `:2664-2670`,
  which is the consumer of `cacheBustingPass` at that point;
  `rust-mode-transform.test.ts:989` and `:1023`, the two tests that supply the
  field, both of which set `action: "CACHE_HIT"` alongside it (`:987`, `:1021`).
- Findings: the two tests that send `boundary_id` send it with
  `action: "CACHE_HIT"`, which suggests the field is associated with a served
  boundary rather than specifically with a bust. That weakens the naive form of the
  requirement ("busting passes must send it") because the observed pairing is with
  a hit, not a bust. I could not determine from the TypeScript side which pass
  classes the module attaches it to.
- Missing evidence: the module's response-assembly rules for `boundary_id`. That
  is `mc-module` source, outside this part, and Part 4b's catalog does not index
  the field by name.
- Conclusion: needs human input. The record's claim does not depend on the answer —
  the gate is module-triggered either way. What depends on it is which pass classes
  a mandatory-field assertion should cover, and answering that needs a reader who
  knows the module's contract. Recommend framing the question to them as "which
  response classes are specified to carry `boundary_id`", since that turns it from
  a design decision into a lookup.

### Q: Does `isRecord` accepting arrays create a reachable problem in `assertNativeBoundary`?

- Sources examined: `isRecord` at `:333-334`; `messageInfo` at `:347-350`;
  `assertNativeBoundary` at `:630-636`.
- Findings: if `first.parts` contained nested arrays, `parts.every(part =>
  isRecord(part) && part.synthetic === true)` would evaluate `isRecord(array)` as
  true and then `array.synthetic` as `undefined`, so the conjunct fails and the
  assert throws. The laxness therefore makes the check *stricter* here, not looser.
  A message that is itself an array would give `messageInfo` the array as `info`,
  whose `.role` is `undefined`, so the assert also throws.
- Missing evidence: none for this question.
- Conclusion: resolved, no additional finding. `isRecord`'s array-permissiveness is
  a latent sharp edge but at this call site it fails safe. Recorded so a later
  reader does not have to re-derive it, and noted in the lens as laxness rather
  than as a defect.
