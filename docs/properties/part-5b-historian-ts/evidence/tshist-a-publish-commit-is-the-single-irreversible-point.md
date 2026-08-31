# tshist-a-publish-commit-is-the-single-irreversible-point

## Discovery trigger

Mapping the pipeline to find the point after which a substitution cannot be
undone on this side. The scope map ranked 5b second on the criterion "raw
conversation is replaced by model-generated summary text", so the first question
was where that replacement becomes durable.

## Evidence trail

All references at `HEAD` = `e447c927`.

`packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts`:

- `:637` `db.exec("BEGIN IMMEDIATE")` opens the only publish transaction on the
  incremental path.
- `:639-647` re-checks `isCompartmentLeaseHeld(db, sessionId, holderId)` inside
  the transaction and rolls back at `:640` when the lease is gone. The comment at
  `:626-629` states the reason: `BEGIN IMMEDIATE` makes the holder check and the
  writes share one write-locked snapshot across sibling processes.
- `:648` `appendCompartments(db, sessionId, persistedCompartments)`.
- `:653-655` reads back the appended rows' ids by taking the last
  `persistedCompartments.length` rows.
- `:663-677` `promoteSessionFactsDurable`, gated on `promotionActive` and
  `!skipUnanchoredPromotion`. The comment at `:659-662` says promotion is in the
  same transaction as the boundary floor so a crash cannot advance past facts
  that never became project memories.
- `:683-693` `insertCompartmentEvents` inside a `try/catch` that logs and
  continues (`:690-692`). Deliberate, per the comment at `:681-682`.
- `:695` `queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd)`.
- `:697` `clearHistorianFailureState`, `:700` `clearHistorianDrainFailure`.
- `:704` `recordProtectedTailPublicationFloor(db, sessionId, lastCompartmentEnd + 1)`.
- `:705` conditional `clearEmergencyRecovery`.
- `:707-713` `setPendingCompactionMarkerState` on the deferring path only.
- `:714` `db.exec("COMMIT")`, `:715` `published = true`.
- `:716-724` `finally` rolls back when `published` is false, tolerating an
  already-closed transaction.

Every earlier exit is above `:637` and precedes any durable write:
`:199-212` (stored-compartment validation failure), `:224-232` (missing boundary
snapshot), `:280-289` (stale snapshot), `:299-321` (nothing to compact),
`:342-350` (drain quota), `:358-375` (empty chunk), `:385-399` (chunk coverage),
`:483-495` (validation failure), `:534-553` (no forward progress), `:631-635`
(missing lease holder). `incrementHistorianFailure` and `updateSessionMeta` do
write on some of those paths, but neither is a compartment, a floor, or a drop.

## Failure scenario

A SQL error at `:695` after `:648` and `:663-677` have run. Without the
transaction, compartments and promoted facts would be durable while no drop op
exists, so the next transform would serve both the summary and the raw messages
it replaced. With the transaction, `:717-723` rolls all of it back and the run
records a failure.

The inverse scenario is the one that makes this a property rather than an
observation: if `:704` committed while `:648` did not, the publication floor
would sit past compartments that do not exist, and `:214-217` computes the next
run's `offset` from the last stored compartment end, so the floor and the offset
would disagree permanently.

## Timing windows and dependencies

The window is `:637` to `:714`, entirely synchronous: no `await` appears inside
it, so no other task interleaves within one process. Cross-process
serialization rests on `BEGIN IMMEDIATE` plus the in-transaction lease check at
`:639`. The lease has a five-minute TTL renewed on an interval
(`compartment-runner.ts:89-109`, TTL noted at `:102`), so the relevant race is a
renewal missed for longer than the TTL while this run holds an open transaction.

## What a test must construct

1. A session with a validated pass reaching `:637`.
2. A fault injected at each of `:648`, `:663`, `:695`, `:704` in turn.
3. Assertions after each: `getCompartments` unchanged, publication floor
   unchanged, no `drop` pending op added, and `session_facts` promotion absent.
4. Separately, a lease revoked between `:630` and `:639`, asserting the same
   three invariants plus the "lease no longer held" log.

The event-insert arm at `:683-693` needs the opposite assertion: an event insert
that throws must still leave the compartments committed.

## Investigation log

### Q: Does the swallowed event insert at `:683-693` ever leave `persistedIds` disagreeing with the event rows in a way a later reader notices?

- Sources examined: `compartment-runner-incremental.ts:653-655`, `:683-693`,
  `:774`; the import of `insertCompartmentEvents` at `:2`.
- Findings: `persistedIds` is computed before the event insert and used both for
  event anchoring (`:685`) and for embedding (`:789`). A throw inside
  `insertCompartmentEvents` is caught at `:690`, so `telemetry.eventsEmitted`
  (`:774`) records `publishableEvents.length` regardless of whether any row
  landed.
- Missing evidence: `insertCompartmentEvents`'s own body was not read; it is in
  `features/magic-context/compartment-events.ts`, outside 5b's file set.
- Conclusion: unresolved, needs a read of `compartment-events.ts` to establish
  whether a partial event insert is possible and whether any reader treats a
  missing event as corruption or as absence.
