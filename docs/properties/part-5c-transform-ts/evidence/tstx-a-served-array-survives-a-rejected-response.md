# tstx-a-served-array-survives-a-rejected-response

## Discovery trigger

Reading the adapter's failure ladder to answer "what does it do when the native call
fails" surfaced a comment that states an invariant rather than describing code:
`rust-mode-transform.ts:2914-2915`, "Validation happens before the caller-owned array
is replaced, so the original live array is still available for fail-open replay."

That is a load-bearing precondition for two of the ladder's five steps, and the
mechanism that satisfies it is one argument in one call. A type change would not
break it and no test names it. That combination — a real invariant with a fragile
implementation and no dedicated check — is what makes it a record.

## Evidence trail

Read at `HEAD` = `e447c927`. All references in
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` unless stated.

**The invariant, stated in source.** `:2914-2915`, in the `catch` at `:2894`:

```ts
// Validation happens before the caller-owned array is replaced, so the
// original live array is still available for fail-open replay.
const replayed = replayLastGood(
    sessionId,
    messages,
    output,
    sessionMeta.systemPromptTokens,
);
```

**The mechanism.** `:2636-2648`:

```ts
// Validate and postprocess the module result before touching the caller-owned
// array. This keeps failure recovery O(1) on the steady path: no defensive
// full-array clone is needed just in case boundary validation rejects it.
appliedMessages = applyNativeMessagesVerbatim(
    { messages: [] },
    response,
    previousWireCache?.nativeOutput ? { ... } : undefined,
);
```

The first argument at `:2640` is a **fresh throwaway object literal**, not `output`.
`applyNativeMessagesVerbatim` ends in `replaceMessagesInPlace(output, ...)` on all
four of its return paths (`:1260`, `:1265`, `:1286-1289`), and
`replaceMessagesInPlace` (`:341-345`) splices into `target = output.messages`:

```ts
function replaceMessagesInPlace(output: { messages: unknown[] }, next: unknown[]): unknown[] {
    const target = output.messages;
    if (target !== next) target.splice(0, target.length, ...next);
    return target;
}
```

So passing `{ messages: [] }` means the splice lands in a discarded array and the
function's return value — the throwaway's now-populated array — becomes
`appliedMessages`. The caller's `output.messages` is untouched until later.

The comment at `:2636-2638` shows the reasoning: the throwaway exists to avoid a
defensive full-array clone, so the invariant is a *performance* decision that
happens to also be the fail-open precondition. That is the fragility: nothing marks
`{ messages: [] }` as safety-critical, and its type is identical to `output`'s.

**The window has a definite end.** The caller's array is replaced at `:2754`:

```ts
const applyReplaceStartedAt = performance.now();
replaceMessagesInPlace(output, appliedMessages);
```

So the invariant covers `:2639` through `:2754`. Anything that throws inside that
range must leave `output.messages` as the caller's input; anything after `:2754` is
post-replacement and outside the claim.

**The six rejection sites inside the window.**

| Site | Condition | Error |
| --- | --- | --- |
| `:660` | response is not an object | "module transform returned a non-object response" |
| `:1252-1258` | `native_messages` string is not valid JSON | "native_messages string was not valid JSON" |
| `:1261` | parsed string is not an array | "native_messages string was not an array" |
| `:1271` | no `native_messages` and no well-formed delta | "response omitted native_messages" |
| `:1281-1284` | delta does not match the acknowledged output | "did not match the acknowledged output" |
| `:652-654` | boundary head malformed, gated `:2660-2662` | "wire invariant failed" |

`:660` is reached *outside* `applyNativeMessagesVerbatim`, so its safety comes from
executing before `:2754` rather than from the throwaway argument. The other five are
protected by the throwaway.

**`mirrorRustRenderedClaimState`'s throw is not a rejection site, and finding out why
is a finding.** Its "invalid rendered-claim state" throw at `:734` is real, but the
call site at `:2766` is (a) after the replacement at `:2754` and (b) wrapped in its
own catch:

```ts
try {
    mirrorRustRenderedClaimState({ db: deps.db, sessionId, response });
} catch (error) {
    sessionLog(sessionId, "rust rendered-memory mirror write failed (ignored):", error);
}
```

`:2765-2769`. The error is swallowed with a log. So the all-or-nothing validation at
`:726-733` does not gate the pass at all — it only prevents the `session_meta` write
at `:739-760`. A module returning `rendered_revision_locators` without
`memory_snapshot_vector` serves its output normally and silently skips mirroring the
rendered-claim state. That is a separate finding about a validation that reads like a
gate and is not one, and it is queued in the lens rather than folded in here.

**The two ladder steps that depend on it.** From the `catch` at `:2894`:

- Step 3, `replayLastGood` (`:2916-2921`), takes `messages` and `output`. It replays
  the last-known-good array, and it computes against `messages`, the caller's array.
- Step 5, `serveRawFallback` (`:2927`), ends at `:1806` with
  `replaceMessagesInPlace(output, messages)` — it serves `messages`, the caller's
  input, verbatim.

If `output.messages` had already been replaced with the module's rejected array, then
`messages` — the parameter — would still be the input, but both consumers would be
computing against a mutated `output`. The raw fallback happens to remain correct
because `:1807` is a full splice of `messages` over whatever is there. So the sharper
dependency is `replayLastGood`'s, and the raw fallback is more robust than the comment
implies.

**The emergency arm has a stricter rule.** `:2904-2913`, ahead of both:

```ts
if (emergencyFailClosed) {
    // At 95% of a trusted limit, or while provider overflow recovery is armed,
    // any adapter failure aborts. Parking controls retry cadence, not fallback admission.
    sessionLog(sessionId, "mc_rust_emergency_refusal before_lkg");
    markFailure(sessionId, state, error);
    finishPass(false, false);
    throw new EmergencyFailClosedError(...);
}
```

`RUST_EMERGENCY_WALL_PCT = 95` at `:128`. This arm rethrows rather than serving
anything, so it does not depend on the invariant — but it is the reason the ladder's
ordering matters: the loud refusal must come *before* the fallbacks, and it does.

**Existing coverage: one site of six.**
`rust-mode-transform.test.ts:1011` ("fails the pass when a present boundary lacks a
synthetic session-scoped m0") asserts at `:1038-1040`:

```ts
expect(output.messages).toBe(input);
expect(output.messages[0]).toEqual(input[0]);
expect(transform.getState(sessionId).failureCount).toBe(1);
```

`toBe(input)` is the identity assertion and it is exactly right — it proves the array
reference was never swapped. `:1039` additionally checks the first element's contents,
guarding against in-place element mutation. That is a well-constructed test; it covers
`:652-654` and nothing else, so one of six sites.

## Failure scenario

Someone changes `:2640` from `{ messages: [] }` to `output`.

The change is invisible to the type checker: `applyNativeMessagesVerbatim`'s first
parameter is `{ messages: unknown[] }` and `output` satisfies it. It is a plausible
edit — it looks like removing a pointless allocation, and the function's name suggests
it should write to the real output.

After the change:

1. A module returns a malformed head with a `boundary_id`.
2. `applyNativeMessagesVerbatim` splices the malformed array into `output.messages`.
3. `runRustModePostprocess` runs on it (`:2650`).
4. `assertNativeBoundary` throws (`:2662`).
5. `replayLastGood` (`:2916`) is asked to restore, but `output` now contains the
   module's rejected content. Whether it recovers depends on whether it replaces
   wholesale or merges.
6. If it does not fully replace, the user is served the array the adapter just
   rejected as invariant-violating — the precise outcome the boundary check exists to
   prevent.

The existing test at `:1011` would catch this, because `toBe(input)` fails once the
splice targets `output`. So the invariant is not unguarded; it is guarded at one of
six sites. A refactor that touched a path the boundary test does not exercise — the
delta arm, say — would land silently.

## Timing windows and dependencies

No timing window. Every rejection is synchronous within the pass.

METHOD.md's `always-or-unreached` fits exactly: the rejection paths are optional, a
campaign of healthy passes enters none of them, and each one entered must hold. Writing
this as `always` would misdescribe it, because on a healthy pass there is no rejection
at which to evaluate the array's identity.

Dependencies:

- `replayLastGood`'s replacement semantics, in `lkg-replay.ts`, outside this file set.
  The invariant is stated as a precondition for it, so how strictly it depends on a
  pristine `output` is worth knowing but does not change what must be proved here.
- The `finishPass(false, false)` call at `:2911` versus `finishPass(false)` at `:2933`:
  the second argument is `served`, defaulted `true` at `:1809`. So the emergency arm
  records "not served" and the fallback arms record "served". A test asserting the
  ladder should check this, since it is the only durable evidence of which arm ran.
- `tstx-a-postprocess-writes-precede-the-boundary-assert` is the counterpart: the array
  survives, and the database writes do not get rolled back. Together they say the adapter
  protects the served array carefully and the durable state not at all.

## What a test must construct

One test per rejection site, each asserting array identity. Five of six are missing.

1. **`:660`** — stub returns a non-object (a string, a number). Assert
   `output.messages).toBe(input)`.
2. **`:1252-1258`** — `native_messages` is a string of invalid JSON.
3. **`:1261`** — `native_messages` is `"{}"`, valid JSON but not an array.
4. **`:1271`** — response has neither `native_messages` nor a well-formed
   `native_messages_delta`.
5. **`:1281-1284`** — a delta with a mismatched `after`. This one needs the two-pass
   setup from `tstx-a-module-answers-with-a-delta-on-a-live-pass`, so the two records
   share a fixture.
6. **`:652-654`** — exists at `:1011`.

Not in the set: `:734`. Its throw is swallowed at `:2765-2769`, so it never reaches the
ladder. A test there should instead assert that the pass **succeeds** and the
`session_meta` mirror write did not happen, which documents the swallow.

Each should assert three things, following the pattern the existing test already
establishes: `output.messages).toBe(input)` for reference identity,
`output.messages[0]).toEqual(input[0])` for element integrity, and `failureCount === 1`
for ladder entry.

**The test that would have the most value is none of the six.** A guard test that
asserts `:2640`'s argument is not `output` cannot be written directly, but its effect
can: run one rejection and assert the module's array is *absent* from
`output.messages` by identity, not merely that the input is present. That distinguishes
"never written" from "written then restored", and it is the assertion that survives a
refactor of `replayLastGood`.

Also worth asserting: the emergency arm's precedence. With
`emergencyFailClosed` true, assert `EmergencyFailClosedError` is thrown and no fallback
ran, by checking that `finishPass` recorded `served: false` (`:2911`). That pins the
ladder's order, which is the part of the failure handling a reader is most likely to get
wrong.

## Investigation log

### Q: Does `replayLastGood` actually require a pristine `output`, or is the comment overstating the dependency?

- Sources examined: `:2914-2921`; `serveRawFallback`'s tail at `:1806`
  (`replaceMessagesInPlace(output, messages)`); `replaceMessagesInPlace` at `:341-345`;
  `noteEntry` and `getSlot` usage in `plugin/messages-transform.ts:155-170`, which
  snapshots the LKG entry at wrapper entry rather than inside the adapter.
- Findings: the raw fallback is robust regardless, because it does a full splice of
  `messages` over whatever `output.messages` holds. `replayLastGood` is the one whose
  behaviour I could not determine from this file: it receives both `messages` and
  `output`, which suggests it computes something from the former and writes the latter,
  and a mutated `output` would only matter if it merges rather than replaces. Separately,
  `messages-transform.ts:155-170` takes its own entry snapshot *before* calling the
  transform, so the outer wrapper's replay has a clean base regardless of what the
  adapter does to `output`.
- Missing evidence: `lkg-replay.ts`, outside this file set.
- Conclusion: unresolved for `replayLastGood`, and the record does not depend on it. The
  invariant is worth holding whether or not one consumer tolerates its violation, and the
  test shape in case "the most value" section — asserting the rejected array is absent by
  identity — proves the invariant directly rather than through a consumer. Recorded so a
  reader does not assume the comment at `:2914-2915` has been verified end to end; the
  ordering it describes is verified, the consequence for `replayLastGood` is not.

### Q: How many rejection sites are there really, and where does the window close?

- Sources examined: every `throw` in `applyNativeMessagesVerbatim` (`:1245-1289`);
  `responseValue` (`:657-661`); `mirrorRustRenderedClaimState` (`:715-760`) and its call
  site, located by grep at `:2766`; `assertNativeBoundary` (`:630-654`); every
  `replaceMessagesInPlace(output, ...)` call, found by grep: `:1262`, `:1267`, `:1286`,
  `:1591`, `:1807`, `:2754`.
- Findings: three corrections to what I first wrote. (1) The window closes at `:2754`,
  `replaceMessagesInPlace(output, appliedMessages)`, which I had not identified; the
  invariant covers `:2639` to `:2754` and nothing after. (2) `:1262`, `:1267`, and `:1286`
  all target the throwaway because `:2640` passes it, so the five in-function throws are
  protected by the argument; `:660` is protected by ordering alone. (3) `:734` is **not**
  a rejection site: its call at `:2766` is both after `:2754` and inside its own
  `try`/`catch` at `:2765-2769` that logs and swallows ("rust rendered-memory mirror write
  failed (ignored)"). So the count is six, not the five I first wrote nor the seven I
  corrected it to mid-pass.
- Missing evidence: none for this question.
- Conclusion: resolved with answer — six sites, one protected by ordering and five by the
  throwaway argument, window closing at `:2754`. The `:734` discovery is a separate
  finding worth surfacing: `mirrorRustRenderedClaimState`'s all-or-nothing validation at
  `:726-733` reads like a gate on the response and is not one. It only prevents the
  `session_meta` write at `:739-760`. That belongs in the lens's leads rather than in this
  record, and it also removes `mirrorRustRenderedClaimState` from
  `tstx-a-postprocess-writes-precede-the-boundary-assert`'s effect set, since it runs
  after both the postprocess and the assert.
