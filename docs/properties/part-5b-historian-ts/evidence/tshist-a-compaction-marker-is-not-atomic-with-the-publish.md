# tshist-a-compaction-marker-is-not-atomic-with-the-publish

## Discovery trigger

Reading the publish transaction for the commit point showed
`setPendingCompactionMarkerState` inside it at `:707-713` but only on one arm,
with a comment explaining that the blob exists so a crash cannot desynchronize
the marker. That implies the other arm has the window the comment describes.

## Evidence trail

All references at `HEAD` = `e447c927`, in
`packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts`
unless noted.

`:568`:

```
const deferMarkerApplication = deps.preserveInjectionCacheUntilConsumed === true;
```

The comment above it, `:557-567`, is explicit about the intent:

> We persist a pending blob INSIDE the same publish transaction so a crash
> between publish and drain cannot leave the marker out of sync — either both
> land or neither does. [...] Direct apply (legacy path) still fires for
> non-deferring callers (recomp / partial-recomp / explicit flushes), which clear
> the injection cache eagerly anyway.

Deferring arm, inside the transaction:

- `:707-713` `setPendingCompactionMarkerState(db, sessionId, { ordinal:
  lastCompartmentEnd, endMessageId: lastNewEndMessageId, publishedAt: Date.now() })`,
  guarded on `lastNewEndMessageId` being present.
- `:714` `COMMIT`.
- `:744-745` after the commit, `deps.onDeferredMarkerPending?.(sessionId)` is
  only a signal; the durable request is already committed.

Non-deferring arm, after the commit:

- `:746-753` `updateCompactionMarkerAfterPublication(db, sessionId,
  lastCompartmentEnd, sessionDirectory)`.

What the marker does:
`packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts:9-12`
states the marker "exists solely to make OpenCode's filterCompacted stop at the
boundary so the transform receives only the live tail". It is written into
OpenCode's own database, not the plugin's: `:21-24` imports
`injectCompactionMarker`, `removeCompactionMarker`, and
`removeForeignCompactionMarker`, and `:41` imports `Database as SqliteDb` for a
second connection. `:67-79` types the drain outcomes as `applied`,
`already-current`, and a retryable failure that keeps the blob.

Ordering also matters relative to the injection cache: `:729-731` clears the
injection cache when not deferring, so on the non-deferred arm the cache is
cleared and the marker written, both after `COMMIT`.

## Failure scenario

Non-deferred publish. `COMMIT` at `:714` succeeds. The process dies, or
`injectCompactionMarker` throws, before `:753`.

Durable state: compartments exist, the publication floor has advanced to
`lastCompartmentEnd + 1`, drop ops are queued, and the injection cache is
cleared. OpenCode's database has no marker, so `filterCompacted` does not stop
at the boundary and the harness resends the raw messages the plugin has just
comparted. The injector will serve the summary for the same range. Until a later
pass repairs the marker, both representations of the same range are live.

The deferred arm cannot reach this state: the pending blob is committed with the
compartments, so either both exist or neither does, and a retryable drain failure
keeps the blob for the next pass.

## Timing windows and dependencies

The window is `:714` to `:753`. It contains no `await`, so it is not an
interleaving window within one process; the exposure is process death, an
exception from the second database open, or a failure inside
`injectCompactionMarker`. `:738` (`onCompartmentStatePublished`) fires inside the
window, so a caller can observe "published" before the marker exists, which is
deliberate per the comment at `:733-737`.

Cross-process, the marker write opens its own connection to OpenCode's database
(`compaction-marker-manager.ts:41`), so it is subject to that database's own lock
contention while the plugin's publish lock is already released.

## What a test must construct

1. A publish with `deps.preserveInjectionCacheUntilConsumed` unset, so `:568`
   evaluates false.
2. A fault in `updateCompactionMarkerAfterPublication`, or a kill between `:714`
   and `:747`.
3. Assertions: compartments committed, publication floor advanced, and no marker
   in OpenCode's database.
4. The same run with the flag set, asserting a committed pending blob and a drain
   that applies it.

Step 3's oracle is `listSessionCompactionMarkers`
(`compaction-marker-manager.ts:22`), which reads the foreign database directly.

## Investigation log

### Q: Is the direct-apply arm still reached by any shipped caller, or is `preserveInjectionCacheUntilConsumed` now always true in production?

- Sources examined: `compartment-runner-incremental.ts:557-568`, `:729-731`,
  `:744-753`; the comment naming "recomp / partial-recomp / explicit flushes" as
  the non-deferring callers.
- Findings: the code names three caller classes for the non-deferring arm, and
  all three exist in 5b's file set (`compartment-runner-recomp.ts`,
  `compartment-runner-partial-recomp.ts`, and the wrapup path). So the arm is
  reachable by design, not vestigial. What was not established is whether the
  *incremental* trigger path, which is the common case, always sets the flag.
- Missing evidence: the deps construction in `startCompartmentAgent`
  (`compartment-runner.ts:111-306`) was read only to `:159`; the flag's origin in
  the transform pass was not traced.
- Conclusion: unresolved, needs a caller sweep of `CompartmentRunnerDeps`
  construction. The record's reachability label rests on the three named caller
  classes, which is sufficient for `default-production`, but the frequency of the
  window is unestablished.
