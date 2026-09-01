# req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining

## Discovery trigger

Mapping the response obligation for channel-0 work showed that control
correlations have no `Settlement` object, so exactly-one is structural rather
than arbitrated. `open_route` is the only control handler with more than a
handful of exits, so it was worth enumerating all of them.

## Evidence trail

`open_route` spans `dispatch.rs:1103-1239`. Seven exits, verified by reading
every `return` and every arm of the two `match` blocks:

| # | Exit | Location | Terminal for the correlation |
| --- | --- | --- | --- |
| 1 | host draining or shutdown cancelled | `:1112-1122` | `target_unavailable`, "host is shutting down" |
| 2 | `registry.reserve` returned `None` | `:1127-1137` | `target_unavailable`, "route capacity exhausted" |
| 3 | bind callback stopped: panic, abort, or its own inner deadline | `:1164-1170` | **none** |
| 4 | bind callback still executing at `lifecycle_callback_deadline` | `:1174` | **none** |
| 5 | `BindOutcome::Accept` and `BindInstall::Installed` | `:1178-1194` | `Response` with channel and epoch |
| 6 | `BindOutcome::Accept` and `BindInstall::CloseWins` | `:1195-1202` | **none** |
| 7 | `BindOutcome::Reject` | `:1204-1237` | `Error` with the handler's code |

Exits 3 and 4 come from `shared.lifecycle_join("bind", bind_task)` at `:1160`.
`lifecycle_join` (`runtime.rs:179-208`) trips the fatal latch on both:

```
Ok(Err(join_err)) => {
    let kind = if join_err.is_panic() { "panicked" } else { "was aborted" };
    self.fatal.trip(&self.shutdown, format!("{what} callback {kind}"));
    Err(LifecycleFailure { stopped: true })
}
Err(_) => {
    task.abort();
    self.fatal.trip(&self.shutdown, format!("{what} callback deadline expired"));
    Err(LifecycleFailure { stopped: false })
}
```

`Ok(None)` — the third case folded into exit 3 — comes from the bind task's own
inner watchdog at `dispatch.rs:1151-1157`, which trips the same latch before
returning `None`. So all three variants of exit 3 and exit 4 leave the host
fatal, and `fatal.trip` takes `&self.shutdown`, so the host's shutdown token is
cancelled.

Exit 6 is different: no latch, no fatal. `BindInstall::CloseWins` is returned by
`routing.rs:178-183` when the occupant is in `Binding { close_requested: true }`.
Two producers set that flag: `begin_close_for` at `routing.rs:248-253`
(`CloseDecision::DeferredToBind`) and `force_drain` at `routing.rs:408-413`. The
comment at `dispatch.rs:1196-1198` states the contract: "Close raced the bind and
wins: never publish, still exactly one route-gone because the handler observed
the handle (protocol AE8)". Route-gone is honoured; the client is not answered.

Exits 3, 4, 6 do all run `run_route_gone` (`:1166`, and `:1199`) except exit 4,
which deliberately does not, because the callback may still be executing and
route-gone must not run beside it (comment at `:1171-1173`).

## Failure scenario

**Bind panic.** Parts 4c and 4d found handler panics, so:

1. Client sends `route.open` with correlation N.
2. `handle_control` acquires a pending permit (`connection.rs:625`) and spawns
   `open_route` on `spawn_lifecycle` (`:721`).
3. `registry.reserve` succeeds; the handle exists.
4. The handler's `bind` panics. `panic_boundary::redact` catches and redacts, the
   task's join is `Err(is_panic)`.
5. `lifecycle_join` trips the fatal latch and returns
   `Err(LifecycleFailure { stopped: true })`.
6. `open_route` takes exit 3: `take_rejected_bind`, `run_route_gone`,
   `finalize_close`, `return`.
7. No frame carries correlation N. The client's `route.open` is never answered.
8. The fatal latch cancels the host's shutdown token, so the host begins
   terminating and the generation retires shortly after.

The client's signal is the generation close, plus its own 30-second route
deadline (protocol §11). It learns nothing about why.

**Close-wins.** Exit 6 without a fatal latch:

1. Client sends `route.open`.
2. `reserve` succeeds, `bind` is in flight.
3. Host shutdown's route snapshot marks the mid-bind route close-requested
   (`routing.rs:408-413`).
4. `bind` returns `Accept`. `install_bound` returns `CloseWins`.
5. Route-gone runs once, the channel is finalized, and the client is not
   answered.

Here the host is draining but not fatal, which is why the property's disjunction
needs the "or draining" arm.

## Timing windows and dependencies

Exit 3's panic variant has no window; it fires as soon as the callback unwinds.
Exit 3's inner-deadline variant and exit 4 both require the bind callback to
exceed `lifecycle_callback_deadline`, default 30 s (`config.rs:225`). The
difference between them is whether the callback's poll returned: exit 3 means the
task actually stopped, exit 4 means the deadline expired while a non-yielding
poll continued, and only exit 3 may proceed to cleanup. `runtime.rs:196-207`
states that distinction.

Exit 6's window is between `registry.reserve` (`dispatch.rs:1127`) and
`install_bound` (`:1178`), which spans the whole bind callback, so it is up to 30
seconds wide.

Dependency: `open_route` is spawned on `spawn_lifecycle`
(`connection.rs:721`), which deliberately does **not** register an abort handle
(`runtime.rs:157-168`), so `abort_all` on the forced shutdown path cannot cancel
it. That is why the mid-bind route must be marked rather than drained, and it is
why exit 6 exists at all.

## What a test must construct

1. A handler whose `bind` panics for a specific identity. Send `route.open`;
   assert no frame carries the correlation, assert exactly one `route_gone` for
   the handle, and assert the host reaches its fatal state.
2. A handler whose `bind` sleeps past `lifecycle_callback_deadline` with a
   shrunk timing config. Assert no terminal, assert the fatal latch, and assert
   `route_gone` does **not** run (exit 4's specific rule).
3. A handler whose `bind` blocks on a barrier; trigger host shutdown so the
   mid-bind route is marked; release the barrier with `Accept`. Assert
   `install_bound` produced `CloseWins`, exactly one `route_gone` ran, and no
   frame carries the correlation.

Existing coverage reaches only the answering exits: `tests/routing.rs:396`
(`rejected_bind_never_publishes_and_still_reports_route_gone`) is exit 7,
`tests/routing.rs:570` (`route_capacity_exhaustion_is_refused_without_binding`)
is exit 2, and `tests/handler_contract.rs:229`
(`a_rejected_bind_carries_the_handler_code_to_the_client`) is exit 7 again.
`tests/routing.rs` and `tests/handler_contract.rs` are named in no CI workflow.

## Investigation log

### Q: Do exits 3 and 4 always leave the host fatal?

- Sources examined: `dispatch.rs:1146-1175`; `runtime.rs:179-208`;
  `dispatch.rs:1151-1157` (the bind task's own watchdog).
- Findings: all three paths into exits 3 and 4 call `fatal.trip`. The inner
  watchdog trips it at `:1152-1155` before returning `None`; `lifecycle_join`
  trips it at `runtime.rs:192-193` and `:204-205`.
- Missing evidence: none.
- Conclusion: resolved with answer — yes, both exits imply a tripped fatal latch.

### Q: Is exit 6 reachable on a generation that stays live afterwards?

- Sources examined: producers of `close_requested`: `routing.rs:248-253`
  (`begin_close_for` on a `Binding` occupant) and `:408-413` (`force_drain`).
  Callers of `begin_close`: `dispatch.rs:1288` (`settle_route`) and
  `:1401` (`begin_close_generation` inside `close_generation`).
  `close_generation` cancels the generation token first (`:1399`).
  `settle_route` is the phase-A entry documented at `:1280-1283` as "for host
  shutdown".
- Findings: the `close_generation` route implies the generation is already
  cancelled. The `settle_route` route implies host shutdown is in progress. A
  client-originated route `Goodbye` cannot reach a mid-bind route, because the
  client does not yet know the handle — protocol §8.2 says exactly this, and
  `connection.rs:541` requires a `RouteHandle` from the frame header.
- Missing evidence: the full caller list for `settle_route`, which lives in
  `harness_closure.rs` (sub-part 2f, 1,122 lines, not in this scope).
- Conclusion: unresolved, needs sub-part 2f. The property's "or draining" arm is
  written to cover the `settle_route` case conservatively rather than asserting
  the generation is always already cancelled.

### Q: Does protocol §8.2 anticipate an unanswered `route.open`?

- Sources examined: §8.2's sequence diagram and the paragraph following it.
- Findings: the diagram has exactly two bind outcomes and both emit a frame. The
  following paragraph does anticipate an abandoned `route.open` — "a caller that
  drops or times out after the request is written" — and gives the client a
  remedy: treat an unmatched control `Response` that names a route as a late bind
  it cannot own. That remedy is keyed on *receiving a frame*. On exits 3, 4, and
  6 there is no frame, so the remedy never triggers.
- Missing evidence: none.
- Conclusion: resolved with answer — §8.2 covers the abandoned-caller direction
  and not the unanswered-request direction. Recorded as lead 5 in the lens file.
