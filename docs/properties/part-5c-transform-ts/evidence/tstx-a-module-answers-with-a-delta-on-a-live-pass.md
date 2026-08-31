# tstx-a-module-answers-with-a-delta-on-a-live-pass

## Discovery trigger

The task asks for at least one `sometimes` situation-coverage record. Looking for a
state the code plainly supports but no campaign produces, the delta arm of
`applyNativeMessagesVerbatim` stood out: it has two direct unit tests, so line
coverage is satisfied, and yet nothing drives it through a real pass. That is exactly
METHOD.md's distinction — "a campaign can execute a branch's lines while never
producing the operational state the branch represents; when that distinction matters,
the answer is `sometimes`".

It matters here because the arm reconstructs the served array from a prefix the
adapter *believes* is acknowledged, and the belief is the adapter's own bookkeeping.
A unit test that hands the function a hand-written `previous` tests the splice
arithmetic and specifically not the bookkeeping.

## Evidence trail

Read at `HEAD` = `e447c927`. All references in
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` unless stated.

**The arm.** `:1268-1289`:

```ts
const delta = response.native_messages_delta;
if (!isRecord(delta) || !Array.isArray(delta.messages)) {
    throw new Error("rust transform response omitted native_messages");
}
const replaceFrom = delta.replace_from;
if (
    !previous ||
    delta.after !== previous.fingerprint ||
    typeof replaceFrom !== "number" ||
    !Number.isSafeInteger(replaceFrom) ||
    replaceFrom < 0 ||
    replaceFrom > previous.messages.length
) {
    throw new Error(
        "rust transform native_messages_delta did not match the acknowledged output",
    );
}
return replaceMessagesInPlace(output, [
    ...previous.messages.slice(0, replaceFrom),
    ...delta.messages,
]);
```

The guard at `:1273-1284` is six conjuncts. The splice at `:1286-1289` keeps the
first `replaceFrom` elements of `previous.messages` **by reference** and appends the
module's replacement suffix.

**Where `previous` comes from.** `:2639-2648`:

```ts
appliedMessages = applyNativeMessagesVerbatim(
    { messages: [] },
    response,
    previousWireCache?.nativeOutput
        ? {
              messages: previousWireCache.nativeOutput,
              fingerprint: previousWireCache.fingerprint,
          }
        : undefined,
);
pendingWireCache.nativeOutput = appliedMessages;
```

`:2649` writes this pass's output into the pending cache, which becomes the next
pass's `previousWireCache`. So the delta arm is inherently two-pass: pass N's applied
array is the prefix pass N+1's delta is spliced onto.

**The fingerprint the guard checks is over the previous pass's INPUT, while the
prefix it authorises comes from the previous pass's OUTPUT.** This is the load-bearing
detail and it took reading the cache construction to see.

`pendingWireCache.fingerprint` is assembled at `:2276` as

```ts
fingerprint: `${ckFingerprint.fingerprint}|${nativeFingerprint.fingerprint}`,
```

where `ckFingerprint` is `buildWireFingerprint(encodedInput)` (`:2260`) and
`nativeFingerprint` is `buildWireFingerprint(messages)` (`:2261`) — the encoded CK
input and the raw input array. Both use FNV-1a-32 (`:357-358`, `:360-367`) folded by
`advanceWireFingerprint` (`:510-516`) inside `buildWireFingerprint` (`:518-529`). The
adapter sends this value to the module as `full_array_fingerprint` (`:2336`, `:2557`).

`previous.messages`, by contrast, is `previousWireCache.nativeOutput` (`:2642`),
described at `:274-276` as "Previous acknowledged module output."

So the guard's `delta.after !== previous.fingerprint` check at `:1276` proves *the
module is responding to the same input generation the adapter last sent*. It does not
prove *the prefix the adapter is about to reuse is the prefix the module would produce
now*. The protocol makes that a reasonable inference — same input, same output — but it
is an inference, not a check.

Note the asymmetry with the input side, which **is** re-verified. `:266-268` documents
`rawContentSnapshots` as "Content-sensitive per-message snapshots for the whole raw
array. Delta passes re-verify every reused message so in-place edits cannot ride a
stale prefix", and `messageMatchesContentSnapshot` (`:465-487`) and
`prefixContentSnapshotsMatch` (`:489-501`) implement it. The output prefix has no
equivalent re-verification; `:274-276` calls it "validated" on the strength of the
`after` match alone.

That asymmetry is why a live-pass test is worth more than the unit tests: the unit
tests supply a matched `(messages, fingerprint)` pair by construction, which removes
the only variable the guard cannot itself establish.

**Invalidation silently converts the situation to a full send.**
`invalidateWireState` (`:1495-1501`) does `wireCaches.delete(sessionId)`, so
`previousWireCache` is `undefined` on the next pass, so `:2642` passes `undefined` (the cache is read at `:2040`)
and any delta response fails the `!previous` conjunct at `:1274`. `state.forceFullWire`
is also set (`:1501`). So a test that does not control invalidation may never reach
the arm and will pass vacuously.

**Nothing drives the arm through a pass.** `grep -n native_messages_delta` over
`rust-mode-transform.test.ts` returns exactly two hits, `:3312` and `:3331`, both
inside direct `applyNativeMessagesVerbatim` calls:

- `:3298` — "reconstructs the exact acknowledged prefix plus replacement suffix",
  which calls the function directly at `:3308-3319` with
  `{ messages: previous, fingerprint: "fp-before" }` as the third argument and asserts
  `applied[0]).toBe(previous[0])` at `:3323`, pinning the by-reference prefix.
- `:3326` — "rejects a delta whose prefix fingerprint is not acknowledged", asserting
  the `:1281-1284` throw.

Neither goes through `transform.run`. No module stub in the file returns
`native_messages_delta`.

**The outbound half *is* covered end-to-end, which sharpens the gap.** The test at
`:3286-3295` asserts `transformBodies[1]?.tail_delta` equals
`{ after: transformBodies[0]?.full_array_fingerprint, replace_from: 0, native_replace_from: 0 }`.
So the suite proves the adapter *sends* a delta request keyed on the previous
fingerprint, and never proves it can *consume* a delta response. The two halves of one
protocol, one covered and one not.

## Failure scenario

The situation is absent, so the scenario is what an absent situation permits.

**A scenario I first proposed and then refuted, recorded because the refutation is the
useful part.** I initially reasoned that a pass could write
`pendingWireCache.nativeOutput` at `:2649` and then fail at `assertNativeBoundary`
(`:2662`), leaving the adapter remembering an output the module never acknowledged, so
the next delta would splice onto a never-served prefix. That is **not** reachable.
`wireCaches.set(sessionId, pendingWireCache)` is at `:2857`, roughly 200 lines further
into the same `try`, well past the assert. A throw at `:2662` skips it and `wireCaches`
retains the prior entry. The staged-commit shape — mutate `pendingWireCache`, promote
once at `:2857` — is correct, and `:2649` writing into the pending object rather than
the committed map is what makes it correct. Recorded per METHOD.md rather than deleted,
because a later reader may propose the same scenario.

**The residual risk, which is real.** A module returns a delta whose `after` matches
the input fingerprint the adapter sent, with `replace_from` at 3 on a previous output of
40. The adapter keeps `previous.messages[0..3]` **by reference** (`:1287`) and appends
the module's suffix.

The guard proves the module is answering about the same *input*. It does not prove the
module would still render that *output* prefix. Anything that changes the module's
rendering for a fixed input breaks the inference while leaving every conjunct at
`:1273-1284` satisfied:

- A module binary upgrade between the two passes. The plugin process survives it — the
  transport reconnects — and `state.forceFullWire` is set only by
  `invalidateWireState` (`:1501`), which reconnect handling may or may not call.
- A module-side configuration or cache change that alters composition for the same
  input. Part 4b establishes the Rust selection is impure in exactly this way: it reads
  `ProducerContext` state that is in neither the request nor the store
  (`sel-eligibility-reads-process-local-scheduler-state`), so the same input can select
  a different pass class. The adapter's fingerprint cannot see that.

The result is a served array whose first three messages are the *old* module's
rendering and whose remainder is the new one. Nothing detects it, because the
input-generation check passed and the output prefix is never re-verified — unlike the
input prefix, which `rawContentSnapshots` re-verifies per message (`:266-268`).

That is a hypothesis, not a demonstrated defect: I have not established that a module
upgrade avoids `invalidateWireState`. It is stated as the reason the situation is worth
constructing, which is what a `sometimes` record is for.

## Timing windows and dependencies

The situation requires state carried across two consecutive successful passes, which
is why it is `sometimes` rather than `reachable`:

- Pass N must succeed and write `pendingWireCache.nativeOutput` (`:2649`) and its
  fingerprint.
- No `invalidateWireState` (`:1495-1501`) may intervene, and `state.forceFullWire`
  must be clear.
- Pass N+1's module response must carry `native_messages_delta` whose `after` equals
  the fingerprint the adapter sent, and whose `replace_from` is in
  `(0, previous.messages.length)` — strictly inside, since `replace_from === 0`
  degenerates to a full replacement and `=== length` degenerates to a pure append.

The `replace_from: 0` case is what the existing outbound test uses (`:3289`), so the
interesting interior case is doubly uncovered.

Dependencies:

- The stub must read the `full_array_fingerprint` the adapter sent (`:2336` or `:2557`)
  in order to echo it as `after`. No current stub inspects the request body for that
  purpose, though `rust-mode-transform.test.ts:1051-1055` shows the pattern
  (`if (method === "transform") transformRequest = body as Record<string, unknown>`), so
  the harness capability exists.
- Reachability is `explicit-config-only`: the arm is in the adapter.

## What a test must construct

1. **The two-pass live delta, which is the situation.** A stub that on pass 1 returns
   a full `native_messages` array, records the `full_array_fingerprint` the adapter sent,
   and on pass 2 returns
   `{ native_messages_delta: { after: <that fingerprint>, replace_from: 2, messages: [...] } }`.
   Assert the served array equals `previous.slice(0, 2)` concatenated with the suffix,
   and assert the retained prefix elements are the **same object references** as pass 1's
   output, which is what `:3323` pins in the unit test and what proves the splice took
   the remembered array rather than rebuilding it.
2. **The `sometimes` marker itself.** Per METHOD.md, a constant globally unique marker
   fired when a pass reaches `:1286` with `0 < replace_from < previous.messages.length`
   **and** `previous` originated from a prior pass's `pendingWireCache` rather than a
   literal. The second clause is the whole point; a marker on the line alone would fire
   from the existing unit tests and record nothing.
3. **The invalidation control.** Same fixture with `invalidateWireState` called between
   the passes. Assert the pass 2 delta is rejected with "did not match the acknowledged
   output" and that the adapter retried with a full array. This documents the silent
   conversion and, more usefully, protects case 1 from becoming vacuous if a future
   change starts invalidating more eagerly.
4. **The fingerprint-mismatch control at pass level.** Pass 2 returns a delta with a
   wrong `after`. Assert rejection, LKG replay, and `failureCount === 1`. The unit test
   at `:3326` covers the throw; this covers what the pass does with it.
5. **The input-versus-output fingerprint distinction, made visible.** Pass 2 returns a
   delta whose `after` matches the sent `full_array_fingerprint` but whose implied prefix
   the module would no longer produce — simulate it by having the stub return, on a third
   pass with identical input, a *different* full array. Assert that pass 2's delta was
   nonetheless accepted. This does not assert a defect; it documents that the guard is an
   input-generation check, which is the fact a reader of `:274-276`'s word "validated"
   would otherwise get wrong.

Case 2 is the deliverable for the `sometimes` requirement. Case 1 is what makes it
achievable. Case 5 is what makes the guard's actual strength legible.

## Investigation log

### Q: Is `pendingWireCache` committed when the pass later fails?

- Sources examined: `:2649` (`pendingWireCache.nativeOutput = appliedMessages`); `:2662`
  (the boundary assert, after it); every `wireCaches` reference, found by grep:
  the declaration at `:1431`, the delete in `invalidateWireState` at `:1496`, the read
  at `:2040`, the promotion at `:2857`, and the delete in `clearSession` at `:2948`.
- Findings: resolved in the safe direction. `wireCaches.set(sessionId, pendingWireCache)`
  is at `:2857`, inside the same `try` but roughly 200 lines after the assert at `:2662`
  and immediately before `appliedAt = performance.now()` (`:2858`). A throw anywhere
  between `:2639` and `:2857` skips the promotion, so `wireCaches` keeps the prior
  entry and the next pass's `previous` is the last **successfully applied** output. The
  design is a staged commit: `:2649` mutates the pending object, `:2857` promotes it
  once.
- Missing evidence: none for this question.
- Conclusion: resolved with answer — the promotion is success-only. This refutes the
  failure scenario I first proposed, and the refutation is recorded in the Failure
  scenario section rather than silently dropped. The record's `sometimes` claim is
  unaffected: it is about situation coverage, which the grep over
  `native_messages_delta` establishes independently. The residual risk was re-derived
  from the fingerprint's provenance instead, which is a stronger finding because it does
  not depend on an error interleaving.

### Q: Do the two direct unit tests amount to adequate coverage, making this record redundant?

- Sources examined: `rust-mode-transform.test.ts:3298-3324` and `:3326-3340`; the
  outbound test at `:3260-3296`; `applyNativeMessagesVerbatim`'s export at `:1245`.
- Findings: the unit tests cover the splice arithmetic, the by-reference prefix
  retention, and the fingerprint-mismatch throw. They cover all of `:1268-1289`'s
  branches. What they cannot cover is the provenance of `previous`, because they supply
  it. The distinction is not academic: the guard's job is to check the module's claim
  against the adapter's record, so a test that constructs both sides consistently has
  removed the only variable. METHOD.md's `sometimes` definition names exactly this —
  lines executed, situation absent.
- Missing evidence: none for this question.
- Conclusion: resolved. Not redundant. The right framing for a reader is that the arm
  has good unit coverage and zero integration coverage, and the record asks for the
  latter. Recorded in `Exercised:` as `partial` with the two tests named, so the
  existing work is credited rather than overlooked.
