# read-task-quiescence-implies-no-further-registration

## Discovery trigger

`TaskTracker::wait()` completes when the tracker is closed *and* empty, and
closing does not forbid a later `track_future`. Both waiters exploit that:
`connection.rs:339-340` closes and waits, and `runtime.rs:1161-1164` closes
every generation's tracker while its read loop is still live. If anything could
register into the set after it drained, both waits would silently stop covering
producers. Enumerating the registration sites was the only way to establish that
nothing can.

## Evidence trail

Every `gen.read_tasks.track_future(..)` call outside a test module — twelve
sites. `connection.rs` `mod tests` starts at `:1481`, `dispatch.rs` at `:1466`.

The read loop itself, and the one site that precedes it:

- `connection.rs:276-278` — `read_loop` is wrapped into the set and awaited
  inline at `:304`. **The read loop is tracked in its own set**, which is the
  safety net the catalog names: the count cannot reach zero while the loop
  runs, so no producer it spawns can be missed.
- `connection.rs:296` — `liveness_loop`. Registered at `:296`, after the
  registry insert at `:288` but before `read_task.await` at `:304`, so it
  precedes the read loop's first poll.

The ten inside the read loop's dynamic extent:

- `connection.rs:452` — authoritative rejection, from `read_loop`'s
  `InboundEvent::Rejected` arm.
- `connection.rs:573` — route Goodbye close, from the `FrameType::Goodbye` arm.
- `connection.rs:687`, `:705`, `:724`, `:732`, `:761` — the `Reject`,
  `CatalogList`, `HostShutdown`, `HostStatus`, and `RouteOpen` arms of
  `handle_control`, which `read_loop` awaits at `:475`.
- `connection.rs:983` — `respond_tcp`, reached from `handle_negotiate`, which
  `handle_control` returns into at `:638`.
- `connection.rs:1094` — the candidate setup driver, from `grant_candidate`,
  also under `handle_negotiate`.
- `dispatch.rs:612` — `emit_rejection`.

`dispatch.rs:612` needed its own check, because `emit_rejection` is called from
six places and one of them looked like it might sit in a spawned task. All six
are inside the read loop's extent: `dispatch.rs:823`, `:840`, `:863`, `:875`,
and `:1070` are all in `dispatch_request`'s own body (`:805-1072`), which
`read_loop` awaits at `connection.rs:486`; `connection.rs:669` is in
`handle_control`. In particular `:1070` is in the `else` arm after
`register_dispatch` at `:1046-1049`, *not* inside the task spawned at `:909` —
that task is registered in `route_tracker`, not `read_tasks`.

The transitive check also holds. Three tasks are themselves registered in
`read_tasks` and could in principle register again: `open_route` (spawned at
`connection.rs:761`), `close_route_decision` (`:573`), and
`run_candidate_setup` (`:1094`). None registers into `read_tasks`. `open_route`
spawns at `dispatch.rs:1123` and `:1239` — both `spawn_lifecycle` with no
tracker wrapper. `close_route_decision` reaches `settle_route_work`, which uses
the registry-owned route tracker (`dispatch.rs:1326`), and `run_route_gone`,
which is `spawn_lifecycle` again. `run_candidate_setup`
(`connection.rs:1130-1199`) spawns nothing.

So: **no registration site sits outside the read loop's dynamic extent.** All
twelve are the read loop itself, precede its first poll, or run within it.

`routing.rs:495` constructs a `read_tasks` field on a test fixture inside
`mod tests` (starts `:478`), not a registration.

Test-module registrations, excluded: `connection.rs:1535` (a bare
`tokio::spawn` wrapping `track_future`), plus the fixture constructions at
`:1520` and `:1625`.

Corrected reference: the catalog cites `connection.rs:1598-1607` as the
existing check. The two `#[tokio::test]` functions span `:1598-1606`
(`shutdown_fence_queues_started_catalog_before_goodbye` and
`..._started_capacity_rejection_before_goodbye`); `:1607` is blank. Both are
thin wrappers over `assert_started_producer_precedes_goodbye`, and the
substantive mechanism is `:1535-1580` in that helper. The catalog's
characterization is accurate: the helper hand-rolls its producer with a bare
`tokio::spawn(gen.read_tasks.track_future(..))` at `:1535` rather than driving
`read_loop`, so it proves an already-started producer is waited for and says
nothing about who else can register. Both are `#[tokio::test]` with no `flavor`,
so current-thread, as the catalog states. These are `--lib` tests, and CI does
run `cargo nextest run -p mc-host --lib` (`.github/workflows/ci.yml:122`), so
unlike the integration-suite proofs this one is executed.

## Failure scenario

1. Shutdown reaches `runtime.rs:1159-1162` and closes a generation's
   `read_tasks` while its read loop is still live.
2. The wait at `:1164` blocks, because the read loop is itself a member
   (`connection.rs:276-278`). Any emission the loop spawns before it exits
   raises the count again, and the wait covers it.
3. Now suppose a refactor moved one emission out of the read loop's extent — for
   example, spawning `emit_rejection` from the route-settle path, which runs at
   `runtime.rs:1146` *before* the close at `:1161`. That task registers into
   `read_tasks`, but if it registers after the count reached zero, the wait at
   `:1164` has already returned.
4. Shutdown then proceeds to queue the Goodbye at `:1168` and cancel the token
   at `:1171` while a producer is still enqueueing. The Goodbye can be written
   before that producer's terminal, violating the step-4 ordering the drain
   comment at `runtime.rs:1139-1143` states.
5. The same break happens if the read loop stops being tracked: the count can
   reach zero between two emissions, and both waiters return early.

## Timing windows and dependencies

No narrow window for the property as it holds today; the exposure is to
refactors, which is why the catalog frames the impact that way. The
enabling state for observing the *positive* case is a read cancellation fired
while an emission is mid-flight — `gen.read_cancel.cancel()` at
`runtime.rs:1160` with a task spawned at one of the ten in-loop sites still
parked on contended egress. Two orderings make that reachable: the shutdown
sequence closes the tracker at `:1161` while the read loop is live, and
`serve_generation` closes it at `connection.rs:339` immediately after the read
loop returns, so a producer spawned on the loop's last iteration is registered
just before the close.

## What a test must construct

The real read loop driving a real emission, then a close-and-wait — which is
exactly what the existing check does not do. Drive a client that sends a
control request whose handling spawns an emission (a `catalog.list` reaching
`connection.rs:705`, or a `server_busy` rejection reaching `dispatch.rs:612`
with `pending_permits` saturated), stall egress so the emission parks, then
cancel the read and close the tracker. The oracle is the catalog's: after the
wait returns, the read loop has returned and no registration site is reachable.
The reachable half is assertable — the emission's frame appears on the socket
before the Goodbye — and that is what `:1598-1606` already proves for a
hand-rolled producer. The part that needs the real loop is that the emission was
registered *by the loop*, so the test also pins the tracked-read-loop
invariant. A mutation control makes it meaningful: removing
`gen.read_tasks.track_future` from `connection.rs:276-278` must fail the test.

## Investigation log

The catalog records no open questions. The enumeration resolved cleanly, with
one count clarification and one citation correction.

- Sources examined: all `read_tasks` references crate-wide
  (`connection.rs:106`, `:248`, `:277`, `:296`, `:334`, `:339-340`, `:346`,
  `:452`, `:573`, `:687`, `:705`, `:724`, `:732`, `:761`, `:983`, `:1092-1094`,
  `:1520`, `:1535`, `:1564-1565`, `:1625`; `dispatch.rs:612`;
  `runtime.rs:1161`, `:1164`; `routing.rs:495`); `emit_rejection` call sites
  (`dispatch.rs:823`, `:840`, `:863`, `:875`, `:1070`, `connection.rs:669`);
  `dispatch.rs:805-1072`, `:1080-1216`, `:1229-1255`, `:1297-1349`;
  `connection.rs:1130-1199`, `:1505-1606`; `.github/workflows/ci.yml:118-125`.
- Findings: twelve non-test registration sites, all inside the read loop's
  dynamic extent or preceding its first poll, and the read loop is itself
  tracked. No task registered in `read_tasks` registers into it again. The
  catalog's "all ten registration sites enumerated" counts the ten in-loop
  sites; the other two are the read loop itself and `liveness_loop`, which
  precedes it. Both framings agree — the count differs only in whether the
  net and the pre-loop registration are included.
- Missing evidence: none.
- Conclusion: resolved. The property holds at HEAD, no registration site sits
  outside the read loop's extent, and the gap is that the existing check
  substitutes a hand-rolled producer for the loop that owns the invariant.
