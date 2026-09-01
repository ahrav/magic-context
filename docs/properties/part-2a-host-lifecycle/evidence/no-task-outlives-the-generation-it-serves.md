# no-task-outlives-the-generation-it-serves

## Discovery trigger

The shutdown sequence's completeness argument is an enumeration, not a
mechanism: `runtime.rs:1190-1191` closes the host tracker and waits on it, and
`runtime.rs:1159-1165` closes and waits each generation's `read_tasks`. Nothing
in the code proves the enumeration is total. Walking every `spawn` in the three
files that build the connection path was the only way to find out, and it turned
up one task that neither wait covers.

## Evidence trail

Every spawn in the three files, classified. Test-module spawns are excluded and
listed at the end. `connection.rs` `mod tests` starts at `:1481`, `dispatch.rs`
at `:1466`; `runtime.rs` has no test module.

`connection.rs`:

- `:187` `AbortOnDropHandle::new(shared.tracker.spawn(channel_io))` — the
  bootstrap writer. Owned-by-AbortOnDropHandle, tracked, **no** abort handle.
- `:210` `AbortOnDropHandle::new(io_task.expect(...))` — re-wrap of the handle
  minted at `:1081`. Owned-by-AbortOnDropHandle.
- `:296` `spawn_tracked(gen.read_tasks.track_future(liveness_loop(..)))` —
  tracked-in-read-tasks and tracked-with-abort-handle.
- `:452`, `:573`, `:687`, `:705`, `:724`, `:732`, `:983`, `:1094` — same
  `spawn_tracked(gen.read_tasks.track_future(..))` shape; both sets.
- `:761` `spawn_lifecycle(gen.read_tasks.track_future(..))` — the `route.open`
  wrapper. Tracked-in-read-tasks; **no** abort handle, deliberately
  (`runtime.rs:157-161`).
- `:1081` `spawn_tracked(io)` — candidate I/O. Tracked-with-abort-handle; the
  handle moves into `handoff.io` (`:1087`) and is re-wrapped at `:210`.

`connection.rs:276-278` also registers `read_loop` into `read_tasks`, but it is
awaited inline at `:304`, not spawned.

`dispatch.rs`:

- `:612` `spawn_tracked(gen.read_tasks.track_future(..))` — both sets.
- `:747` `tokio::spawn(async move { .. })` — **bare**. The only one.
- `:909` `spawn_tracked(route_tracker.track_future(..))` and `:962`
  `spawn_tracked(handler_fence.track_future(..))` — tracked-with-abort-handle,
  registered in the *route* tracker, not `read_tasks`; `:962`'s handle is
  wrapped at `:974`.
- `:1123`, `:1239` `spawn_lifecycle(..)` — tracked, no abort handle,
  abort-exempt by contract.
- `:1381`, `:1402` `JoinSet::spawn` — owned by a local `JoinSet` that its
  caller drains (`:1385`, and `force_close_all_routes`).

`runtime.rs`: `:151` and `:167` are the helper bodies themselves. `:951`,
`:1017`, `:1053` are `spawn_tracked`; `:959`, `:1066`, `:1240` are
`spawn_lifecycle`; `:740` is owned-by-AbortOnDropHandle. `:259`, `:301`,
`:321`, `:387`, `:449` are bare, and all five are teardown or lock-retention
tasks holding `InstanceGuard` and/or `Arc<HostShared>` — none holds an
`Arc<GenerationCore>`. `:449` can reach generations transitively through
`shared.connections`, which is why the claim is scoped to the connection path
rather than to generation reachability.

Test-module spawns, excluded: `connection.rs:1510`, `:1535`, `:1567`, `:1615`.
`dispatch.rs` has none — every one of its spawn sites precedes `:1466`.

What `dispatch.rs:747-756` holds and for how long: a `CancellationToken` clone
of `shared.shutdown` (`:745`) and `gen_watch: Arc<GenerationCore>` (`:746`). It
self-bounds on `sleep_until(deadline)` where `deadline` is
`gen.writer.admission_deadline()` (`:693`), which is `Instant::now() +
admission_timeout` (`frame_channel.rs:783-785`). That timeout is the channel's
`frame_deadline` (`tcp_frame_channel.rs:80`), default 30 seconds
(`config.rs:224`). So it holds a generation reference for up to one frame
deadline past its own registration, and its only effect is
`gen_watch.token.cancel()` at `:753`.

## Failure scenario

1. A client sends an authenticated `host.shutdown`. `handle_host_shutdown`
   wins the latch, admits the response to the writer queue, and spawns the
   watchdog at `:747`.
2. The generation retires for an unrelated reason — peer EOF, a corrupt frame,
   a liveness invalidation. `serve_generation` runs `close_generation`, which
   removes the registry entry (`dispatch.rs:1397-1401`).
3. The watchdog is still parked on its `sleep_until`. It is not in
   `read_tasks`, so neither `connection.rs:340` nor `runtime.rs:1164` waited
   for it; it is not in `abort_handles`, so `abort_all` (`runtime.rs:211-221`)
   cannot reach it.
4. It wakes and calls `token.cancel()` on a generation already gone from the
   registry. Cancelling an already-cancelled token is idempotent, so nothing
   observable happens — which is why this is a completeness defect rather than
   a live bug.
5. The cost is that `shared.tracker.wait()` at `runtime.rs:1191` does not cover
   it either, because `tokio::spawn` does not enter the tracker. A shutdown can
   therefore return graceful while this task is still parked.

## Timing windows and dependencies

The window is bounded by one `frame_deadline` (default 30s) from the watchdog's
spawn. It opens only on the shutdown-owner path: the requester must pass the
latch `try_own` at `dispatch.rs:653`, survive the retirement checks at `:690`,
acquire the egress charge at `:695`, and reach `send_before` at `:712`. A
contender that takes the `Committed` arm at `:655` returns at `:671` and spawns
nothing. So at most one watchdog exists per committed attempt, plus one per
earlier attempt that reopened the latch. The interesting case named in the
catalog — a second shutdown on a generation the first watchdog still holds — is
reachable because the latch reopens when the hook drops unrun, so a successor
requester on a different generation spawns a second watchdog while the first is
still parked.

## What a test must construct

An enumeration assertion, not a state. Two shapes are available. The direct one
is a source-level check that every `spawn` in `connection.rs`, `dispatch.rs`,
and `runtime.rs` outside a test module is one of the four classified forms, with
`dispatch.rs:747` either listed as a declared exception or moved into a tracked
set. The behavioural one drives an authenticated `host.shutdown` to write
completion, retires the generation before the deadline, and asserts the host
tracker's wait does not complete while the watchdog is parked — that is the
observable the record actually protects. The second requires
`start_paused = true` to make a 30-second deadline testable, and a
multi-thread runtime is not needed because the watchdog's only await is a
timer.

## Investigation log

### Q: Should the watchdog be tracked? That makes its lifetime a stated part of the generation's at the cost of one abort handle.

- Sources examined: `dispatch.rs:738-757`, `:641-737`; `runtime.rs:143-168`,
  `:211-221`, `:1119-1221`; `connection.rs:276-304`, `:333-362`;
  `frame_channel.rs:783-785`, `:800-830`; `tcp_frame_channel.rs:64-92`;
  `config.rs:207`, `:224`.
- Findings: the mechanism is fully established. The task is bare, it holds a
  generation reference, it self-bounds at one frame deadline, and its effect is
  idempotent. Tracking it in `read_tasks` would be wrong: `read_tasks` is
  closed and waited at `connection.rs:339-340` before `close_generation`, and
  the watchdog must outlive that wait to bound a write that is still in the
  queue. `spawn_tracked` onto the host tracker would fit the wait and give
  `abort_all` a handle, and the in-code comment at `:738-744` states the
  intended contract ("Hold the same absolute deadline through write
  completion") without saying who owns the task.
- Missing evidence: nothing states whether the omission is deliberate. The
  comment explains why the deadline exists, not why the task is untracked.
  There is no comment marking it as an exception the way `runtime.rs:157-161`
  marks `spawn_lifecycle`'s missing abort handle.
- Conclusion: needs human input. The mechanism needs no further investigation;
  the question is whether the enumeration should be closed by tracking the task
  or by declaring it an exception, and those produce different tests.
