# stagelc-abandoned-page-collection-is-released-within-a-bounded-window

## Discovery trigger

The task asked directly whether the Part 3 pattern recurs: staged state that
persists with no reaper. Part 3's instance is
`part-3-store-core/catalog.md:999`, claim-mirror rows that "are never
garbage-collected". Enumerating reapers in 4c produced two TTL constants and two
`evict_stale*` methods, and one coordinator with neither.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty, so they hold
at the task's `76cd6f41`.

The two coordinators that do have a TTL:

- `:626-627` — `/// Release partial state-sync seeds whose sender stopped before
  completing the page sequence.` then
  `const STATE_SYNC_SEED_COLLECTOR_TTL: Duration = Duration::from_secs(10 * 60);`
- `:1004-1018` — `StateSyncSeedCoordinator::evict_stale_collectors`, which filters
  for `Collecting` (`:1009`) past the TTL (`:1012`) and calls `evict` (`:1017`).
- `:654` and `:1357` — `STATE_IMPORT_STALE_AFTER` is
  `Duration::from_secs(5 * 60)`, stored in the struct's `stale_after` field
  (`:1346`).
- `:1397-1413` — `StateImportCoordinator::evict_stale`, same shape.

The coordinator that has neither:

- `:1107-1320` — the whole `impl TransformPageCoordinator`. Its methods are
  `phase_bytes`, `is_pending`, `release_phase`, `discard`, `set_phase`,
  `oldest_queued_at_ms`, `completed`, and `stage`. There is no `evict_stale*`.
- `:596-669` — the constant block. There is no transform-page TTL constant. The
  page constants present are `TRANSFORM_PAGE_MAX_BYTES` (`:630`),
  `TRANSFORM_PAGE_MAX_STAGED_BYTES` (`:631`), `TRANSFORM_PAGE_MAX_PENDING`
  (`:632`), and `TRANSFORM_PAGE_MAX_ID_BYTES` (`:633`). All are size and count
  caps; none is a time bound.

So the only release paths for a page collection are explicit:

- `:3800` — route replacement, `discard_transform_pages_for_route(..., "route_replaced")`.
- `:4268` — route teardown, `discard_transform_pages_for_route(..., "route_teardown")`,
  reached from `route_gone` (`:11999-12001`). Guarded by `last_session_route`
  (`:4242-4247`, tested at `:4256`), so a session with a second bound route gets
  nothing.
- `:9352`, `:9358`, `:9365`, `:9369`, `:9373`, `:9380`, `:9384`, `:9390`,
  `:9398`, `:9416`, `:9424`, `:9434`, `:9439` — the thirteen validation returns in
  `handle_transform_page_value`, each calling `discard_transform_pages`. These
  require the sender to send *another* page, which an abandoning sender does not.
- `:9524` — assembly failure after the final page.
- `:12097` — `shutdown`, which ends the process.

Staleness is observed but not acted on:

- `:1153-1163` — `oldest_queued_at_ms` reports the minimum `queued_at_ms` across
  `Collecting` phases.
- `:3985-3994` — `refresh_oldest_queued_at_ms` mirrors it into the
  `DISPATCH_HEALTH` atomic.
- `:251` — `TRANSFORM_WEDGE_THRESHOLD_MS` = `120_000`.
- `:372-445` — `report` computes `queue_stale` from that age and sets
  `HealthStatus::Degraded` (`:403-404`). Nothing consumes `queue_stale` to
  release the collector; it is a report field only.

Reachability, both sides per METHOD.md rule 4:

- Config default: none; dispatch is on field presence (`:7985-7986`,
  `:12326`).
- Shipped setup path: `module-wire.ts:1097` pages anything over
  `MODULE_PAGE_MAX_BYTES` = `512 * 1024` (`module-wire.ts:20`). Mid-series
  abandonment is also a shape the plugin's own tests observe:
  `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts:1718`
  captures a `failedPageId` mid-series and `:1741-1742` asserts the retry starts
  a new page id, which means the old series' pages were left staged on the Rust
  side.
- Class: `default-production`.

## Failure scenario

A sender begins a five-page series, delivers pages 0 and 1, then dies, loses its
connection at a layer that does not tear down the route, or gives up and starts a
fresh series under a new `transform_page_id`. The `Collecting` phase holds up to
two pages' bytes, charged to `total_staged_bytes` and to
`pending_transform_count`. Nothing releases it. The route stays bound, so
`route_gone` never fires. No further page arrives for that series, so none of the
thirteen validation discards run.

Note the retry case is the more likely one and is only partly self-healing. A
retry with a *new* page id on the *same* session hits the `Collecting` arm at
`:1255`, fails the `pending.transform_id != transform_id` check at `:1256`, and
does call `release_phase` at `:1260` before returning `AttemptMismatch`. So a
same-session retry does reclaim the bytes. The unreclaimed case is the session
that abandons and never comes back, which is exactly what the seed TTL comment
at `:626` describes as the thing worth reaping.

Accumulated across sessions, staged bytes approach the 128 MiB cap at `:631`, at
which point legitimate large transforms begin failing `buffer_overflow`
(`:9497-9500`) on a daemon that never restarts.

## Timing windows and dependencies

The window is the quiescent period after the last delivered page. Its defining
feature is that the coordinator receives no further input, which is what makes a
self-driven reaper useless here even if one existed. See
[stagelc-seed-and-import-reapers-only-run-on-fresh-traffic](stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md)
for that separate problem on the two coordinators that do have TTLs.

Dependency: the route must stay bound for the whole window, otherwise
`route_gone` masks the property.

## What a test must construct

Following METHOD.md's liveness rule, the window must be explicit and finite, and
stated in the units the code bounds. The code bounds nothing here, so the bound
comes from the siblings: 15 minutes strictly exceeds both the 10-minute seed TTL
(`:627`) and the 5-minute import TTL (`:654`), so any correct reaper on this
coordinator would have to fire inside it.

1. Bind a route to session A. Record `total_staged_bytes` as the baseline.
2. Stage pages 0 and 1 of a three-page series. Assert both returned
   `"staged": true` and that `total_staged_bytes` rose.
3. Stop. Send no further request touching session A. Keep the route bound.
4. Poll `total_staged_bytes` every 30 seconds for 15 minutes.
5. Assert it returned to the baseline. Today it does not.

For a fast test, inject the clock the way `:27051-27055` injects `stale_after`
for imports, or add a page TTL field and set it to `Duration::ZERO`. Both require
a source change, so as a discovery-phase artifact the 15-minute wall-clock form
is the honest one.

## Investigation log

### Q: Was the page coordinator intentionally left without a TTL on the theory that `route_gone` always arrives?

- Sources examined: `unbind_route` (`:4233-4298`) including the
  `last_session_route` computation (`:4242-4247`) and its test at `:4256`;
  `route_gone` (`:11999-12001`); the route-replacement path (`:3790-3804`); the
  coordinator doc comment (`:1064-1065`); and the seed TTL comment (`:626`).
- Findings: `route_gone` is not a sufficient substitute for two reasons. First,
  the teardown block is gated on the unbound route being the *last* one for that
  session, so a multi-route session releases nothing. Second, the seed
  coordinator has both `route_gone` coverage (`:4267`) *and* a TTL, which shows
  the author did not consider teardown sufficient for seeds. The asymmetry is
  unexplained by any comment.
- Missing evidence: nothing in the tree states the intent. The `#[cfg(test)]`
  discard-log hook (`:2949`, written at `:4003`) is read by no test, so there is
  no expectation recorded even in the test surface.
- Conclusion: needs human input. The evidence points to omission, but whether to
  add a TTL or to strengthen teardown is a design decision.

### Q: Does the same-session retry path actually reclaim the bytes?

- Sources examined: the `Collecting` arm's mismatch branch (`:1255-1262`) and
  `release_phase` (`:1120-1127`).
- Findings: yes. `:1256-1261` compares `transform_id`, `generation`, and `total`,
  and on any mismatch calls
  `self.release_phase(&TransformPagePhase::Collecting(pending))` before
  returning. Because `pending` is moved in, the bytes are both released and
  dropped.
- Missing evidence: none.
- Conclusion: resolved with answer. The retry case self-heals; the
  abandon-and-never-return case does not. The record is scoped to the latter and
  the test in step 3 above must not send any further request, or it will pass
  vacuously through this branch.
