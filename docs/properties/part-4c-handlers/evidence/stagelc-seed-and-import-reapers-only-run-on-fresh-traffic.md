# stagelc-seed-and-import-reapers-only-run-on-fresh-traffic

## Discovery trigger

Having found that `TransformPageCoordinator` has no reaper at all, the next
question was whether the two reapers that do exist actually fire. Grepping for
their call sites returned one each, and both are inside the staging path they are
meant to clean.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

The seed reaper:

- `:1004-1018` — `StateSyncSeedCoordinator::evict_stale_collectors(now)`. Filters
  `sessions` for `Collecting` phases (`:1009`) whose `last_activity` is at least
  `STATE_SYNC_SEED_COLLECTOR_TTL` old (`:1012`), then calls `evict` on each
  (`:1017`).
- `:626-627` — the TTL and its comment: "Release partial state-sync seeds whose
  sender stopped before completing the page sequence", 10 minutes.
- Exactly one call site in the file: `:8860`,
  `seeds.evict_stale_collectors(activity_at);` inside the staging block of
  `handle_state_sync_value` (`:8642-9125`), immediately before the phase is taken
  at `:8861-8864`. `activity_at` comes from `self.state_sync_seed_now()`
  (`:8617`).

The import reaper:

- `:1397-1413` — `StateImportCoordinator::evict_stale(now)`, same shape, filtering
  `Collecting` past `self.stale_after` (`:1403`) and calling `discard`
  (`:1411`).
- `:654`, `:1346`, `:1357` — `STATE_IMPORT_STALE_AFTER` = 5 minutes, held in the
  struct field `stale_after`.
- Exactly one call site: `:1441`, `self.evict_stale(now);` as the first statement
  of `StateImportCoordinator::stage`. The `now` is supplied by the caller at
  `:5728` as `Instant::now()`.

Nothing else drives either. There is no interval task: the handler's task
spawners are `spawn_tracked_task` and `spawn_module_task` (`:3399-3496` group),
and neither is used to schedule a coordinator sweep. `shutdown` (`:12048`) resets
the coordinators wholesale at `:12095-12099` rather than reaping them.

The existing import test proves the point rather than refuting it:

- `:27013-27072` — `state_import_batch_gap_and_staleness_evict_partial_attempts`.
  At `:27051-27055` it reaches into the handler and sets
  `.stale_after = Duration::ZERO` by hand, then at `:27056-27066` sends *another*
  `state_import` to trigger the sweep. The test cannot observe the reaper without
  supplying fresh traffic, because there is no other trigger.

Reachability, both sides per METHOD.md rule 4:

- Seed reaper. Config default: no leaf gates seed paging. Shipped setup path:
  `packages/plugin/src/hooks/magic-context/module-state-sync.ts:1173` sets
  `seed_batch_index` on the outbound payload, and the paging threshold is the
  same `MODULE_PAGE_MAX_BYTES` used at `module-state-sync.ts:1268` and `:1274`.
  Class: `default-production`.
- Import reaper. Config default: `state_import` is dispatched at `:12279`, but a
  search of `packages/` finds exactly one non-test sender, the developer script
  `packages/plugin/scripts/drive-preseed.ts:48`. Class:
  `explicit-config-only`. This is why the record's reachability label is split
  and why the seed half is the one that matters in production.

## Failure scenario

A session begins a paged state-sync seed, delivers batch 0 of 4, and then stops
sending `state_sync` requests. It may keep sending transforms, facade calls, and
status requests; none of those reach `:8860`. The `Collecting` phase's bytes stay
charged against `STATE_SYNC_SEED_MAX_STAGED_BYTES` (32 MiB, `:625`) for as long
as the route stays bound, which can be the whole process lifetime.

The comment at `:626` states the intent precisely: release seeds "whose sender
stopped before completing the page sequence". A sender that stopped is by
definition a sender that supplies no further `state_sync` request, so the
condition the reaper is designed for is the condition under which it cannot run.
This is the contract-versus-code disagreement recorded as lead 2 in the lens
file.

There is a partial mitigation worth stating so the record is not overclaimed. The
sweep is global, not per-session: `:1004-1015` scans every session in the map.
So *any other session's* seed batch triggers a sweep that reaps the abandoned
one. In a busy multi-session daemon the reaper therefore does fire. The failure
is confined to a daemon whose seed traffic goes quiet, for example a single-user
desktop install between sessions, which is this component's primary deployment
shape.

## Timing windows and dependencies

The window is the quiescent period for that one request kind. Other request
kinds may flow freely; that is exactly what distinguishes a self-driven reaper
from a timer, and it is what the test must hold fixed.

Dependency: the route must stay bound, or `unbind_route` (`:4267` for seeds,
`:4269` for imports) releases the state through a different path and masks the
property.

## What a test must construct

Per METHOD.md's liveness rule, the window is explicit and stated in the unit the
code bounds, namely the coordinator's own TTL constant.

1. Bind route 1 to session A. Record `total_staged_bytes` as the baseline.
2. Send batch 0 of a two-batch seed for session A. Assert `total_staged_bytes`
   rose.
3. Stop all `state_sync` traffic, for every session, not just A. Continue
   ordinary traffic of other kinds so the test proves the reaper is not merely
   waiting on load in general.
4. Wait `STATE_SYNC_SEED_COLLECTOR_TTL` plus a 60-second margin, that is 11
   minutes.
5. Assert `total_staged_bytes` returned to the baseline. Today it has not.
6. Control arm: repeat, but at step 4 send one seed batch for an unrelated
   session B. Assert A's bytes are released. This distinguishes "the reaper is
   broken" from "the reaper is self-driven", which is the actual finding.

The control arm is what makes this record precise rather than alarmist, and it is
cheap.

## Investigation log

### Q: Is there any timer, interval, or background task that sweeps either coordinator?

- Sources examined: every occurrence of `evict_stale_collectors` and
  `evict_stale` in the file; `spawn_tracked_task` and `spawn_module_task`
  (`:3399-3496`); `McHandler::new` (`:3403-3472`); the
  `CompositeComponent` impl (`:11934-12115`) including `health` (`:12003`) and
  `shutdown` (`:12048`); and `initialize` (`:12118`).
- Findings: two call sites total, `:8860` and `:1441`, both inside a staging
  path. No spawned task references either coordinator. `health` reads
  `DISPATCH_HEALTH` and does not touch the coordinators. `shutdown` replaces them
  with `Default` rather than reaping.
- Missing evidence: none. The search space is one file and the identifiers are
  unique to it.
- Conclusion: resolved with answer. Both reapers are self-driven only.

### Q: Does the global scan mean a busy daemon is unaffected?

- Sources examined: the filter at `:1005-1015`, which iterates `self.sessions`
  rather than looking up one key.
- Findings: yes, the sweep is global, so one session's traffic reaps every
  session's stale collectors. The exposure is therefore confined to periods with
  no seed traffic at all.
- Missing evidence: no data on how long a real install goes without a
  `state_sync` request. That is an operational question, not a code one.
- Conclusion: resolved with answer, with the scope narrowed. The record stands
  but its impact statement must say "quiescent for that request kind" rather
  than "always", and the test needs the control arm above to demonstrate the
  distinction.
