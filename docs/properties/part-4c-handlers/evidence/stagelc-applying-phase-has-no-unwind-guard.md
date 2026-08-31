# stagelc-applying-phase-has-no-unwind-guard

## Discovery trigger

The task asked whether a stuck coordination blocks unrelated work. Tracing what
`TransformPagePhase::Applying` blocks led to the `InProgress` error, and tracing
when the phase is released led to a plain statement after an `await` with no
guard, in a file where every other per-request resource has a `Drop` guard.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

What `Applying` blocks:

- `:1242-1254` — `stage`'s `Applying` arm restores the phase unchanged
  (`:1246-1252`) and returns `Err(TransformPageStageError::InProgress)`
  (`:1253`).
- `:9501-9503` — the handler maps that to
  `("in_progress", "the final transform page is being applied")`.
- `:9505` — returned via `transform_page_error(lane, suffix, message)`.

So while a session is `Applying`, every subsequent paged transform for that
session fails. The blocking is per session, not global, which bounds the blast
radius and belongs in the record.

When the phase is set and released:

- `:1298-1304` — set to `Applying` inside `stage`, before the handler returns the
  `Apply` action at `:1305-1311`.
- `:1210-1224` — the single-page variant sets it the same way at `:1211-1217`.
- `:9528-9536` — `handle_transform_unpaged_value(...).await`, the terminal step.
- `:9541-9548` — after the await, the coordinator is re-locked and the phase is
  taken with `std::mem::replace(..., TransformPagePhase::Idle)` (`:9547`).
- `:9549-9557` — the `Applying` arm calls `release_phase`, which decrements
  `pending_transform_count` and subtracts the bytes (`:1120-1127`).

Every one of `:9541` through `:9572` is reachable only by normal return from the
await at `:9536`. There is no guard:

- No `impl Drop for TransformPagePhase` and no `impl Drop for TransformPageCoordinator`
  anywhere in the file.
- The `Apply` action carries the data out of the coordinator (`:1295`,
  `std::mem::take(&mut pending.pages)`), so the bytes are counted against the
  budget while the phase says `Applying` and the pages themselves have moved into
  the caller's local.

The codebase's own idiom for exactly this hazard, which is what makes this an
inconsistency rather than a judgement call:

- `:497-508` — `impl Drop for TransformDispatchTicket`, whose body comment at
  `:503-504` reads "A panic unwinds through this guard. Decrement the count, but
  do not stamp a completion: a panicking dispatch did not prove that the lane
  advanced." The `in_flight_count` is decremented on unwind at `:505`.
- `:1875-1881` — `impl Drop for SnapshotLease`.
- `:3198-3220` — `WrapupSessionGuard` with its `Drop`.
- `:3063` — `impl Drop for DreamerRunGuard`.
- `:324-332` — `StoreOpenWaiterGuard` with its `Drop`.

Five guards in this file protect per-request accounting against unwind. The
staging phase, which is per-request accounting, has none.

The condition is observable but not remediated:

- `:1153-1163` — `oldest_queued_at_ms` reports only `Collecting` phases, so a
  stranded `Applying` phase does **not** feed the queue-staleness signal at all.
- `:251` and `:372-445` — the wedge detector's other input is
  `last_dispatch_completed_at_ms` versus `last_dispatch_started_at_ms`, and the
  ticket's `Drop` at `:497-508` deliberately does not stamp a completion on
  unwind. So `completion_lag_ms` (`:379`) grows and `heartbeat_stale` (`:385-390`)
  becomes true past `TRANSFORM_WEDGE_THRESHOLD_MS` = 120,000 ms. The wedge is
  therefore visible, through the heartbeat rather than the queue.
- Nothing consumes `stale` to release the phase. `report` builds a
  `HealthReport` and returns it (`:372-445`).

Reachability, both sides per METHOD.md rule 4:

- Config default: none. The await at `:9528-9536` and the release at `:9554` are
  on the unconditional final-page path.
- Shipped setup path: paging is automatic per
  `packages/plugin/src/hooks/magic-context/module-wire.ts:1097` against
  `MODULE_PAGE_MAX_BYTES` = `512 * 1024` (`module-wire.ts:20`).
- Class: `default-production` for the code path. Note the *fault* that triggers
  the strand, a panic or a dropped future, is a separate reachability question
  handled in the investigation log below.

## Failure scenario

A session's final page arrives. `stage` sets the phase to `Applying` and charges
the assembled series' bytes. `handle_transform_unpaged_value` is awaited. Inside
it, a panic occurs, or the host drops the dispatch future.

Control never reaches `:9541`. The phase stays `Applying` and the bytes stay
charged. From then on:

- Every paged transform for that session returns `in_progress` (`:9501-9503`).
- The session's bytes remain subtracted from the shared 128 MiB budget
  (`TRANSFORM_PAGE_MAX_STAGED_BYTES`, `:631`), reducing headroom for every other
  session.
- Its slot remains counted in `pending_transform_count`, consuming one of the 64
  (`:632`).
- The only recovery is route teardown, which calls
  `discard_transform_pages_for_route` (`:4268`) and does release an `Applying`
  phase because `discard` replaces any non-`Idle` phase (`:1134`, `:1140-1142`),
  or a process restart.

Note the teardown recovery is itself conditional: `:4256` gates it on the unbound
route being the last for that session, so a multi-route session does not get it.

## Timing windows and dependencies

The window is the duration of the await at `:9528-9536`, which for a large
transform is the most expensive operation in the handler. Wider window, higher
chance of coinciding with a panic or a cancellation.

Dependency: the panic half and the cancellation half have different
reachability. A panic inside `apply_once` is plausible given that file's density
of `assert!`/`unreachable!` on the output path, including the two named
fail-loud guards `assert_no_orphaned_tool_arcs` (`transform.rs:11172-11225`) and
`enforce_unique_tool_use_ids` (`transform.rs:11231-11305`). The cancellation half
depends on whether `mc-host` can drop a dispatch future, which is outside 4c.

## What a test must construct

Panic arm, which needs no host cooperation:

1. Build a handler and bind route 1 to session A.
2. Arrange for the terminal transform to panic. The `drive-fault` feature block
   (`:13229-13337`) is the intended lever: `apply_drive_fault` at `:13294-13337`
   plus `parse_drive_fault`. It is absent from a default build, which the Cargo
   manifest treats as the dormancy proof, so the test is feature-gated.
3. Send a complete two-page series. Catch the panic at the test boundary.
4. Send page 0 of a fresh series for session A. Assert it acks. Today it returns
   `in_progress`.
5. Assert `pending_transform_count` and `total_staged_bytes` returned to their
   pre-series values.

Cancellation arm, if the host permits it:

6. Drive the dispatch future and drop it partway through the terminal await, for
   example with `tokio::time::timeout` around
   `handler.dispatch_value(...)` in a `current_thread` runtime, matching the
   flavour used by the inline tests such as `:27013`.
7. Apply the same assertions as steps 4 and 5.

Step 4 asserts that a legitimate fresh series succeeds, which holds on a correct
system, so it does not assert the violation directly.

## Investigation log

### Q: Is the dispatch future ever dropped at that await, or does the host always poll a request to completion?

- Sources examined: `CompositeComponent::handle` (`:11963-11996`), which awaits
  `dispatch_value_with_inbound_bytes` inline at `:11992-11994` and then
  `settle_prepared` at `:11995`; the `TransformDispatchTicket` `Drop` (`:497-508`)
  and its comment, which names panic but not cancellation; and
  `spawn_tracked_task` / `spawn_module_task` (`:3399-3496`), neither of which
  wraps the request path.
- Findings: within `mc-module` the request path is a plain inline await, so
  cancellation can only come from the caller dropping the future returned by
  `handle`. That is `mc-host` behaviour. The ticket's `Drop` existing at all shows
  the author expected abnormal exits from this region, and its comment attributes
  them to panic specifically.
- Missing evidence: whether `mc-host` uses a timeout, a `select!`, or a
  cancellation token around component dispatch. That is Part 2a territory.
- Conclusion: unresolved, needs an `mc-host` dispatch-cancellation fact from Part
  2a. The panic half is independently sufficient to make the record actionable,
  so the record does not depend on this answer.

### Q: Does `discard` actually release a stranded `Applying` phase, so route teardown is a real recovery?

- Sources examined: `discard` (`:1131-1144`) and `release_phase` (`:1120-1127`).
- Findings: yes. `discard` replaces whatever phase is present with `Idle` at
  `:1134` and calls `release_phase` on the taken phase at `:1140-1142`.
  `release_phase` treats any non-`Idle` phase as pending (`:1116-1118`) and
  `phase_bytes` returns the `Applying` variant's `bytes` (`:1111`). So the
  accounting is correctly reversed. The `staged_pages` return is `None` for
  `Applying` (`:1138`), which only means the discard is not logged, not that it
  did nothing.
- Missing evidence: none.
- Conclusion: resolved with answer. Route teardown is a genuine recovery, subject
  to the `last_session_route` gate at `:4256`.

### Q: Does the health surface actually reveal a stranded `Applying` phase?

- Sources examined: `oldest_queued_at_ms` (`:1153-1163`), `report` (`:372-445`),
  and the ticket's unwind path (`:497-508`).
- Findings: not through the queue signal, because `oldest_queued_at_ms` filters
  for `Collecting` only (`:1157-1159`) and returns `None` for `Applying`. It does
  show through the heartbeat: the ticket's `Drop` deliberately omits the
  completion stamp, so `completion_lag_ms` grows and `heartbeat_stale` trips past
  120,000 ms (`:251`, `:385-390`).
- Missing evidence: none.
- Conclusion: resolved with answer. The wedge is observable but by the heartbeat
  rather than the queue, and nothing acts on either.
