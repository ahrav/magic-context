# tshist-a-validation-retry-is-bounded-within-one-firing

## Discovery trigger

Part 4a records `hv-validation-rejection-retry-has-no-attempt-bound` on the Rust
side. Checking whether the same hole exists here found the opposite: this side's
retry structure is explicitly bounded, which makes it one of the two places where
the TypeScript implementation is stricter than the Rust one.

## Evidence trail

All references at `HEAD` = `e447c927`, in
`packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts` unless
noted.

**The attempt structure of one firing.** `runValidatedHistorianPass` spans
`:104-215`.

1. Initial call, `:134-138`. On a transport failure it goes straight to the
   fallback chain (`:139-144`).
2. First validation, `:146-152`. On success it either returns or runs the editor
   pass (`:153-164`).
3. Repair, `:168-183`: `buildHistorianRepairPrompt` then one more
   `runHistorianPrompt`. A transport failure again routes to the chain
   (`:184-190`).
4. Second validation, `:189-195`. On success, return or editor.
5. On a second rejection, `:211-215` calls `runFallbackHistorianPass` once.

**The fallback chain is deduplicated and finite.** `:580-589`:

```
const seen = new Set<string>();
const chain: string[] = [];
for (const candidate of [...(args.fallbackModels ?? []), args.fallbackModelId ?? ""]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    chain.push(candidate);
}
if (chain.length === 0) {
    return { ok: false, error: args.error };
}
```

The loop that follows is `for (let i = 0; i < chain.length; i += 1)` (`:591`), one
`runHistorianPrompt` per candidate (`:606`) and one `validateHistorianOutput` per
successful response (`:623-628`). A candidate that fails to parse as
`provider/model` is skipped without a call (`:594`). No inner retry, no restart of
the chain.

**The editor pass cannot extend the chain.** `runEditorPassOrFallback`
(`:229-305`) makes exactly one call (`:236-248`) and returns the already-valid
draft on any failure, whether the call failed (`:250-257`) or the editor's own
output failed validation (`:279-292`). The doc comment at `:216-228` states this
explicitly, and gives the reason: "Iterating through fallback models here would
cost extra LLM calls per chunk for no compression benefit — the draft is already
known to be valid".

So one firing performs at most `2 + |chain| + 1` model calls, where `|chain|` is
the deduplicated configured chain length. The bound is in attempts, not wall
clock, which is the unit the code actually bounds.

**Across firings the runner throttles rather than bounding.**
`compartment-runner-incremental.ts:466` sets
`retainDrainReservationForRetryThrottle = true` before the pass and clears it at
`:496` on success. The `finally` at `:914-927` then either rolls the drain
reservation back or, when the flag is still set, calls
`recordHistorianDrainFailure(db, sessionId)` (`:924`) with the comment at
`:919-923`: "the same condition that retains the drain reservation as a retry
throttle. Record it so the emergency catch-up latch's bypass is suppressed for a
short backoff and a broken historian can't retry-thrash every pass under the
latch."

The user-facing alert has its own separate cooldown, `HISTORIAN_ALERT_COOLDOWN_MS`
of 60 seconds (`:82`), applied in `shouldSuppressHistorianAlert` (`:85-92`). That
bounds notifications, not calls, and the two must not be confused.

## Failure scenario

A misconfigured historian model returns structurally invalid output on every
attempt, with three fallback models configured.

One firing: initial, repair, three fallbacks, and no editor call because nothing
validated. Five model calls, then `runFallbackHistorianPass` returns
`{ ok: false, error: lastError }` (`:639`), the runner records a failure
(`compartment-runner-incremental.ts:491`), notifies subject to the 60-second
cooldown (`:493`), and returns.

The next transform pass can fire again. The bound this record claims is per
firing, and that is the honest scope: the drain-failure backoff and the retained
drain reservation are throttles on the *rate*, not a cap on the total, so a
permanently broken historian keeps making bounded batches of calls indefinitely.
That is still materially different from the Rust side, where Part 4a establishes
no attempt bound at all.

## Timing windows and dependencies

The bound is structural, not temporal, so no window applies to the property
itself. `getHistorianRetryBackoffMs` (`:653-659`) adds jitter, 2 to 3 seconds for
the first retry and 6 to 8 thereafter, so a firing's wall clock is bounded by the
chain length times the per-call timeout plus that backoff, but wall clock is not
the check's unit.

The dependency is configuration: `|chain|` comes from `fallbackModels` and
`fallbackModelId` on the deps, so the bound is a function of user config rather
than a constant. A pathological config with many models makes one firing
expensive while keeping it finite.

## What a test must construct

1. A stubbed `runHistorianPrompt` counting invocations, returning invalid output
   every time.
2. A deps object with `fallbackModels` of length three plus a distinct
   `fallbackModelId`.
3. Assert the total invocation count is exactly `2 + 4` and that
   `runValidatedHistorianPass` returns `ok: false`.
4. A second case with `fallbackModels` containing a duplicate of
   `fallbackModelId`, asserting the dedup reduces the count by one.
5. A third case where the initial call validates and the editor's output does
   not, asserting exactly three calls and that the returned result is the draft.

All five are pure unit tests against an injected prompt runner. None exists today.

## Investigation log

### Q: Across firings, is the throttle sufficient?

- Sources examined: `compartment-runner-historian.ts:104-215`, `:216-305`,
  `:575-639`, `:653-659`; `compartment-runner-incremental.ts:82`, `:85-92`,
  `:466`, `:491-496`, `:914-927`.
- Findings: two distinct mechanisms exist across firings. The drain reservation is
  retained as a throttle, and `recordHistorianDrainFailure` suppresses the
  emergency latch's bypass for a backoff period. Neither is a total cap. The
  60-second alert cooldown bounds only notifications.
- Missing evidence: the body of `recordHistorianDrainFailure` and the backoff
  period it writes, which live in `features/magic-context/storage.ts`, outside
  5b's file set.
- Conclusion: unresolved, needs the drain-failure backoff read. The per-firing
  bound is fully established and is what the record claims; the cross-firing
  question is a separate liveness property a later pass should raise against the
  storage module.
