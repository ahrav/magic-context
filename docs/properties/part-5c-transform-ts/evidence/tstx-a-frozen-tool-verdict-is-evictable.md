# tstx-a-frozen-tool-verdict-is-evictable

## Discovery trigger

Part 4b's fourth framing fact is that selection is deterministic on collection
order and is *not pure*: the decision reads `ProducerContext` state that is in
neither the request nor the store, so two processes sharing one store can select
different pass classes for byte-identical inputs
(`sel-eligibility-reads-process-local-scheduler-state`).

Looking for the same impurity in the TypeScript renderer, the obvious candidates
are the module-scope caches. Two of them memoize a verdict the source explicitly
documents as frozen and unable to flap, and the cache they use is an LRU with a
finite cap. So the impurity here is not merely "process-local state exists" but
"process-local state exists behind a comment that denies it can vary".

## Evidence trail

Read at `HEAD` = `e447c927`.

**The claims.** `packages/plugin/src/hooks/magic-context/transform.ts:874-879`,
closing a comment about the `ctx_reduce` availability gate:

> ALSO gated on the session's actual tool availability: a parent agent
> can spawn this session with an explicit allow-list tools map that
> filters ctx_reduce out entirely — §N§ prefixes and nudges for a tool
> the model can't call are pure overhead plus cargo-cult risk. The
> verdict is frozen per session (first user message's tools map) so it
> can never flap mid-session and bust the cache.

`:878-879` is the claim. And `:884-888`, for the `todowrite` sibling:

> Same frozen-per-session verdict for the native `todowrite` tool. ...
> Resolved here from the same first-user-message map
> so the verdict is frozen identically and never flaps mid-session.

`:888` repeats it. Both are unconditional statements, which is what makes them
testable claims rather than approximations.

**The cache is a bounded LRU.**
`packages/plugin/src/hooks/magic-context/ctx-reduce-availability.ts:91`:

```ts
const availabilityBySession = new BoundedSessionMap<boolean>(1000);
```

The key is `cacheKey(toolName, sessionId)` (`:142`), not the session id alone, so
the cap is shared across the two tools resolved. The comment at `:88-89` says so:
"Cap covers ~500 sessions across the two tools we currently resolve (ctx_reduce +
todowrite)." So the eviction threshold is about **501** sessions, not 1001.

Two siblings in the same file: `permissionDeniedBySession` at `:95` (cap 2000) and
`ctxReducePermissionDenyLogged` at `:96` (cap 1000).

`packages/plugin/src/shared/bounded-session-map.ts` is explicit about eviction. The
docstring at `:20-26`:

> - Built on `Map` which preserves insertion order. On every `set`/`get`
>   touch we delete+reinsert to move the key to the tail (most-recent).
> - Eviction drops the oldest entry (first in iteration order).
> - The cached value type is generic — callers decide what per-session state
>   to store. For injection/token state, all three properties of the cached
>   object are safe to throw away: they are either recomputable from the
>   messages array on the next pass, or reloadable from SQLite.

`:22` is the eviction rule. `:23-26` is the justification, and it names its
intended consumers — "injection/token state" — which are not this consumer.

The `get` at `:39-46` performs the delete-and-reinsert touch, so the map is a true
LRU and eviction order is recency of use, not insertion.

**Re-resolution reads the current array, not the original.**
`ctx-reduce-availability.ts:136-158`:

```ts
const cached = availabilityBySession.get(key);
if (cached !== undefined) return { callable: cached, frozen: true };

for (const message of messages) {
    if (message.info?.role !== "user") continue;
    // First user message decides: explicit signal, or no-signal → available.
    // Either way the verdict is final — freeze it.
    const verdict = verdictFromToolsMap(message.info.tools, toolName) ?? true;
    availabilityBySession.set(key, verdict);
    return { callable: verdict, frozen: true };
}
return { callable: true, frozen: false };
```

`:143-144` is the cache hit, returning `frozen: true`. `:147-153` is the miss path:
it scans for the **first** message with `role === "user"` and freezes that message's
verdict. `:158` is the fall-through when the array contains no user message at all,
returning `{ callable: true, frozen: false }`, and `:154-157` explains why it does
not freeze: "caching true here would lock a deny-list session into the tool's
surface before its first user message ever arrives to say otherwise."

The precise mechanism is therefore sharper than "the verdict may not be
recoverable". On a miss the resolver takes **whichever user message is now first in
the supplied array**. If the original first user message is no longer in the array,
a different message's `tools` map decides, and the result is re-frozen as if it were
authoritative. `verdictFromToolsMap(..., toolName) ?? true` at `:150` means a message
carrying no `tools` signal at all yields `true`, so the common re-resolution outcome
is `{ callable: true, frozen: true }` — a confidently frozen *wrong* answer, not an
unfrozen one.

A third arm is stable and worth noting because it is the one place the design is
airtight: `:139-141` returns `{ callable: false, frozen: true }` without caching
when `ctx_reduce` is not registered process-globally, so that verdict cannot be
disturbed by eviction at all.

There is also a second resolver, `:167-195`, which reads from the OpenCode database
instead of the array: `:181` returns `{ callable: true, frozen: true }` when
`!openCodeDbExists()`, `:193` returns `{ callable: true, frozen: false }` when the
session row is absent ("session not persisted yet"), and `:195` parses `row.tools`.
So a re-resolution after eviction can also land on a *different resolver's* answer
depending on persistence state.

**Why the recomputation is not guaranteed to agree.** The verdict is a function of
the first user message's `tools` map. Two mechanisms can change what that
recomputation sees:

- The messages array a transform pass receives is the array the harness supplies,
  and the transform itself removes messages from it — `reconcileMarkerRepresentation`
  splices at `transform-postprocess-phase.ts:474`, and the drop machinery removes
  content. A later pass's array is not the first pass's array, so "first user
  message" resolves to a different message.
- `verdictFromToolsMap(...) ?? true` (`:150`) makes absence of signal mean
  *available*. So the dominant flip direction is `false → true`: a session frozen as
  uncallable becomes callable, which is the direction `:876-877` says is harmful
  ("pure overhead plus cargo-cult risk").
- `:158` and `:193` return `frozen: false` when no verdict can be taken at all. That
  is the rarer outcome and it matters because
  `tstx-a-unfrozen-todo-verdict-decides-oppositely-per-path` records that the two
  renderers interpret `frozen: false` with opposite polarity.

Two distinguishable damage modes, then: a re-frozen wrong verdict (likely) and an
unfrozen verdict (rare, and worse because the two paths disagree about it).

**Both verdicts reach live decisions.** `transform.ts:880-882` takes
`ctxReduceAvailability` and `ctxReduceCallable`; `:889-890` takes
`todowriteAvailability`, forwarded to the postprocess at `:2201`. On the postprocess
side `transform-postprocess-phase.ts:494-496` uses
`ctxReduceAvailability.frozen && ctxReduceAvailability.callable` to decide whether
to prepend a tag number to the marker summary text, and `:251` uses
`todowriteAvailability` to decide tool availability. So a flip changes served bytes,
which is exactly what `transform.ts:879` says it cannot do ("bust the cache").

## Failure scenario

A single long-lived OpenCode process, or a plugin process serving many sessions —
the condition `bounded-session-map.ts:6-11` describes as the reason the cap exists
("sessions that are never explicitly deleted ... leak entries for the lifetime of
the plugin process").

1. Session S has its `ctx_reduce` verdict frozen as `callable: false`, because its
   parent spawned it with an allow-list excluding `ctx_reduce`. `§N§` prefixes are
   suppressed and no reduce nudges are emitted.
2. Roughly 500 other session ids are touched, filling the shared 1000-entry cap
   across two tools. S's key is least recently used and is evicted
   (`bounded-session-map.ts:22`).
3. S takes another pass. `availabilityBySession.get(key)` misses. The resolver at
   `:147-153` scans for the first `role === "user"` message in the array it was
   given.
4. The original first user message has since been dropped or replaced by a marker
   summary, so a later user message is now first. It carries no `tools` map, so
   `verdictFromToolsMap(...) ?? true` (`:150`) yields `true`, and `:151` caches it.
   The verdict is now `{ callable: true, frozen: true }`.
5. `ctxReduceCallable` (`transform.ts:882`) flips from `false` to `true`, and
   `transform-postprocess-phase.ts:494`'s `frozen && callable` flips from false to
   true. `§N§` prefixes and reduce nudges begin appearing mid-session.
6. The served bytes change for reasons unrelated to the conversation, busting the
   prompt cache and introducing guidance for a tool the model still cannot call —
   the exact outcome `:876-877` says the gate exists to prevent ("pure overhead plus
   cargo-cult risk").

The flip is confidently frozen, so it is durable for the rest of the process
lifetime and no later pass corrects it. That is worse than an unfrozen verdict,
which at least re-resolves each pass.

## Timing windows and dependencies

The window opens once the shared 1000-entry cap fills — about 501 sessions across
the two tools, per the comment at `:88-89` — and stays open for as long as S remains
evicted. There is no race and no interleaving; it is a
capacity effect, so a test is deterministic.

Dependencies:

- The cap, 1000, at `ctx-reduce-availability.ts:91`, shared across tools via
  `cacheKey` at `:142`. A test should drive the eviction by touching keys rather than
  assuming a session count.
- `verdictFromToolsMap` (`:116`) and `openCodeDbExists()` (`:181`), both of which
  decide which resolver arm a re-resolution lands on. The property does not depend on
  their internals, only on the existence of a `frozen: false` arm.
- The interaction with `tstx-a-unfrozen-todo-verdict-decides-oppositely-per-path`:
  that record establishes the two paths disagree about `frozen: false`, so eviction is
  a mechanism for reaching the state that record is about. The two should be read
  together.

Note the contrast with Part 4b's Rust analogue: `ProducerContext`'s impurity comes
from state that is *inherently* process-local (`observed_last_response_at_ms` returns
`None` until this process has seen a response, per Part 4b's catalog), which is
honest about being per-process. Here the state is documented as frozen and the
eviction is invisible to the consumer. That is the extra trigger the Rust side does
not have.

## What a test must construct

1. **The eviction flip, which is the property.** Freeze a verdict for session S with
   a first user message whose `tools` map excludes `ctx_reduce`; assert
   `{ callable: false, frozen: true }`. Touch enough other keys to evict S. Re-resolve S
   with an array whose original first user message has been removed and whose new first
   user message carries no `tools` map. Assert the verdict is now
   `{ callable: true, frozen: true }` — a *frozen* flip, which is the sharp version of
   the finding. One loop, no database.
2. **The benign control.** Same eviction, but re-resolve with the original array
   intact. Assert the verdict re-freezes to `callable: false`. This is the case that
   makes the design defensible and it should be recorded as passing, so a fix is not
   credited with repairing something that already worked.
3. **The observable consequence.** Run a full pass before and after the eviction flip
   and assert the served arrays differ — specifically that `§N§` prefixes appear where
   they did not. That connects the cache behaviour to the claim at `:879` about busting
   the cache, which is the part a reader cares about.
4. **The `todowrite` sibling.** Same three cases for
   `resolveTodowriteAvailabilityFromMessages`, because `:888` makes the identical claim
   and the two verdicts are consumed by different code
   (`transform-postprocess-phase.ts:251` versus `:494`).

The test must not assert that eviction never happens. Eviction is correct behaviour
for a bounded map; the property is about what the consumer assumes, and the oracle is
verdict stability, not cache residency.

## Investigation log

### Q: Is the LRU cap reachable in practice, or is 1000 sessions in one process unrealistic?

- Sources examined: `bounded-session-map.ts:1-27`, whose rationale section explicitly
  motivates the cap with "In long-running OpenCode instances with thousands of sessions
  over time, an unbounded `Map<sessionId, LargeObject>` can retain tens of megabytes
  indefinitely" (`:12-14`); the three caps in `ctx-reduce-availability.ts:91`, `:95`,
  `:96`.
- Findings: the map's own docstring asserts the thousands-of-sessions case is the
  motivating scenario, so the project already believes the cap is reachable. That is
  the strongest available evidence and it comes from the code being audited rather
  than from speculation. Also note the docstring's example cap is 100 (`:14`) while the
  actual caps here are 1000 and 2000, and the consumer's own comment at `:88-89`
  reasons about the resulting session count ("~500 sessions across the two tools") —
  evidence the number was chosen deliberately, which makes the eviction path a
  considered behaviour rather than an oversight.
- Missing evidence: telemetry on real session counts per process. Not available from
  the repository.
- Conclusion: resolved for the purposes of the record. The cap is reachable by the
  project's own stated reasoning, and the record's reachability label
  (`default-production`) rests on the code path rather than on the cap being hit
  often. A test reaches it deterministically regardless.

### Q: Does eviction actually change the verdict, or does the re-resolution reliably reproduce it?

- Sources examined: `ctx-reduce-availability.ts:136-158` (array resolver) and
  `:167-195` (database resolver); `transform-postprocess-phase.ts:474` (the array
  splice); the two `frozen: false` returns at `:158` and `:193`.
- Findings: the re-resolution is a function of the array or the persisted session row,
  neither of which is guaranteed to still contain the original first user message. The
  transform removes messages from the array, so "the same array" is not a safe
  assumption across passes. The dominant outcome is not an unfrozen verdict but a
  *re-frozen wrong* one: `:147-153` takes whichever user message is now first, and
  `verdictFromToolsMap(...) ?? true` at `:150` treats absence of signal as available, so
  a session frozen `false` re-freezes `true`. Both resolvers additionally have a
  `frozen: false` fall-through (`:158`, `:193`), which is the rarer and more awkward
  outcome because the two renderers disagree about `frozen: false`.
- Missing evidence: whether OpenCode's persisted `session.tools` row is stable for the
  session lifetime. If it is, the database resolver at `:167-195` would reproduce the
  verdict reliably and the exposure would narrow to sessions whose row is absent
  (`:193`). I did not establish that.
- Conclusion: unresolved in the narrow sense, resolved in the sense that matters. The
  re-resolution at `:147-153` takes a different message whenever the array has changed,
  so the verdict is not stable across eviction and the claim at `:878-879` and `:888` is
  false as written. The persisted-row question affects only how often the *database*
  resolver reproduces the verdict, which is severity, not validity. Recommend attaching the persisted-row question to whoever audits
  `ctx-reduce-availability.ts` as a unit, since it is outside this file set.
