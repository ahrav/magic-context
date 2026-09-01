# client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind

## Discovery trigger

Task 3 asked whether a retry can duplicate an effect. `open_route` is the only retry
loop in the file, so it is the only place where the answer can be yes.

## Evidence trail

The loop, in full:

```
458:        let deadline = Instant::now() + CLIENT_ROUTE_OPEN_TIMEOUT;
459:        let mut backoff = Duration::from_millis(25);
460:        loop {
461:            let response = self
462:                .inner
463:                .unary(
464:                    RouteHandle {
465:                        channel: 0,
466:                        epoch: 0,
467:                    },
468:                    body.clone(),
469:                    deadline,
470:                    None,
471:                )
472:                .await;
473:            match response {
474:                Ok(response) => { ... }
511:                Err(error)
512:                    if error.outcome == SendOutcome::Terminal
513:                        && matches!(
514:                            error.code.as_str(),
515:                            "unknown_module"
516:                                | "module_reloading"
517:                                | "target_unavailable"
518:                                | "module_timeout"
519:                        )
520:                        && Instant::now() < deadline =>
521:                {
522:                    let remaining = deadline.saturating_duration_since(Instant::now());
523:                    tokio::time::sleep(backoff.min(remaining)).await;
524:                    backoff = (backoff * 2).min(Duration::from_millis(500));
525:                }
526:                Err(error) => return Err(error),
527:            }
528:        }
```

Three things make this mostly safe:

1. The guard at `:512` requires `outcome == SendOutcome::Terminal`. An
   `OutcomeUnknown` falls through to `:526` and is returned, so the client never
   retries a request whose bytes may have been delivered without a terminal. That is
   the correct application of METHOD's effect-accounting discipline and of the
   protocol's own `terminal` definition at `docs/mc-host-wire-protocol.md:62`:
   "matching terminal frame was observed; its success or failure applies only to that
   correlation."
2. `body.clone()` at `:468` means the retried request is byte-identical, and each
   iteration goes through `unary` and therefore through `admit`, which allocates a
   fresh correlation at `:1177`. So the watermark stays satisfied; see
   `client-a-no-request-frame-carries-a-non-increasing-correlation`.
3. The absolute deadline at `:458` is checked at `:520` and clamps the sleep at
   `:523`, so the loop terminates. `docs/mc-host-wire-protocol.md:746` requires
   exactly this: "Backoff counts the first attempt, and retry delay or a later stage
   never resets the owning deadline."

The remaining question is whether the four codes are authoritative that no route was
bound. The doc's clearest statement is at `:658`:

> Limit exhaustion before dispatch of a routed or control request returns terminal
> `server_busy` for that correlation; `target_unavailable` is reserved for route
> admission — `route.open` failures such as channel exhaustion (Section 8.2) — so
> each code keeps exactly one recovery rule in Section 10.2.

`target_unavailable` is described as a route-admission failure, which implies no
bind. The other three are not characterised at that level of precision anywhere I
found. `module_timeout` is the one whose name suggests a deadline rather than a
completed rejection, and a deadline can expire while the operation it bounded is
still running.

The client does have a partial mitigation for a late bind:

```
1421:                    if header.ty == FrameType::Response && header.channel == 0 {
1422:                        self.release_stranded_route(&body);
1423:                    }
```

`release_stranded_route` (`:1572-1590`) parses the body, skips handles already in the
cache, and sends a best-effort route `Goodbye`, retiring the generation if that
cannot be queued (`:1588`). So a bind that lands after a retry moved on is reclaimed,
provided the response arrives while the generation is still live.

## Failure scenario

A caller calls `open_route`. Attempt 1 is answered `Error{code:"module_timeout"}`.
Suppose that is the host's own deadline on a module bind that is still in progress.
The client sleeps 25 ms and issues attempt 2 with a fresh correlation. Attempt 2
succeeds and returns `(7, 77)`, which the caller caches.

The module then completes attempt 1's bind. The host emits a `Response` on `0/0` for
attempt 1's correlation, which is no longer pending. `dispatch` finds no entry at
`:1413`, sees a channel-0 `Response` at `:1421`, and calls
`release_stranded_route`, which sends a route `Goodbye` for the second handle. Net
effect: one bind, one release, no leak. The mitigation works.

Now suppose the caller's route-open deadline expires before the late response
arrives, and the caller closes the client. `retire` clears `routes` and cancels the
writer. The late `Response` either never reaches `dispatch` or reaches it after the
retirement check at `:1983` short-circuits the reader. The host-side bind is not
released and stays for the life of the generation, which is already ending, so the
practical leak is bounded by the generation.

The worse case is repetition. With 25 ms doubling to a 500 ms cap inside a 30-second
deadline, a caller can make roughly 60 attempts. If each `module_timeout` leaves a
bind in flight, the host accumulates up to 60 route and channel permits for one
`open_route` call, reclaimed only as their late responses arrive. Combined with
`client-a-live-route-handles-are-bounded-only-by-the-host`, that pushes the host
toward `target_unavailable`, which is itself a retried code, which produces more
attempts.

Whether any of this happens turns entirely on the open question. This record is
worded as a dependency, not a defect, because I could not resolve it.

## Timing windows and dependencies

Effect accounting, per METHOD. Attempted effects equal loop iterations at `:461`.
Acknowledged failures equal the terminals matched at `:511-519`. Host-side binds
should equal one for a successful call, not the attempt count. The per-attempt
oracle is required because a leaked bind from attempt 1 and a successful bind from
attempt 2 sum to two, which an aggregate check could mistake for two legitimate
opens by two callers.

Depends on `release_stranded_route`, which is the compensating mechanism, and
therefore on the generation staying live long enough for the late response to arrive.

## What a test must construct

1. A peer that answers the first `route.open` with `Error{code:"module_timeout"}`,
   then also binds a route and emits a late `Response` on `0/0` naming a second
   handle, and answers the second `route.open` normally.
2. Assert the caller received exactly one handle.
3. Count route `Goodbye` frames on `control_rx`. Exactly one should appear, for the
   stranded handle, which demonstrates the mitigation firing.
4. Then the negative case: same peer, but drop the caller's future before the late
   response arrives, and assert no `Goodbye` was emitted for the stranded handle.
   That establishes the mitigation's dependency on liveness.
5. Separately assert the retry guard is tight: a peer answering
   `Error{code:"server_busy"}` must not be retried, and a request whose outcome is
   `OutcomeUnknown` must not be retried. Both are absence assertions on `data_rx`
   frame counts.

`an_abandoned_control_open_releases_a_late_bound_route` (`:3503`) already builds
most of the fixture for steps 1 through 3.

## Investigation log

### Q: Is `module_timeout` emitted only after the host proves no bind occurred?

- Sources examined: `docs/mc-host-wire-protocol.md:658` (the `server_busy` versus
  `target_unavailable` split and the claim that "each code keeps exactly one recovery
  rule in Section 10.2"), `client.rs:511-525`, `:1572-1590`, and the retry
  allowlist's four members.
- Findings: the doc's design principle is that each code carries one recovery rule,
  which only works if each code's meaning is definite. `target_unavailable` is
  explicitly a route-admission failure. `unknown_module` and `module_reloading` are
  naturally pre-bind conditions. `module_timeout` is the outlier: a timeout is by
  construction a statement about the observer, not about the observed. The doc does
  not say whether the host cancels the underlying bind before emitting it.
- Missing evidence: the host's `route.open` handler and its timeout path. That is
  `control.rs` or `dispatch.rs`, sub-part 2e.
- Conclusion: unresolved, needs the 2e control-handler pass. If the host cancels the
  bind before emitting `module_timeout`, this record downgrades to a positive record
  about a correctly-guarded retry. If it does not, the retry is an effect-duplication
  path and the record's impact stands.

### Q: Does the client ever retry a routed request?

- Sources examined: every `unary` call site: `:463` (inside the `open_route` loop),
  `:540` (`request`), `:588` (`host_shutdown`), `:638` (`host_status`). Also
  `start_stream` (`:1034`) which does not loop.
- Findings: `open_route` is the only loop. `request` is documented "The body is never
  replayed" at `:531` and calls `unary` exactly once. `host_shutdown` and
  `host_status` call it once each.
- Missing evidence: none.
- Conclusion: resolved with answer. No application request body is ever retried by
  the client. Retry policy for application requests is the caller's, informed by
  `SendOutcome`, which is the correct division.
