# req-a-a-handler-outliving-every-host-deadline-is-reached

## Discovery trigger

Task 4 asked what bounds a request's lifetime. The answer turned out to be
nothing on the host side, so the recordable property is the situation-coverage
one: a campaign must actually reach the state where a handler has outlived every
deadline the host configures.

## Evidence trail

`HostTiming` has exactly seven fields (`config.rs:198-218`):

| Field | Default | What it bounds |
| --- | --- | --- |
| `auth_deadline` | 2 s | the three-message authentication exchange |
| `frame_deadline` | 30 s | remaining header plus body after the first byte; also one dequeued frame's write |
| `lifecycle_callback_deadline` | 30 s | `bind`, `route_gone`, `initialize`, `health` |
| `route_close_budget` | 5 s | settling one route's admitted work at close |
| `transport_setup_deadline` | 2 s | transport setup |
| `shutdown_deadline` | 10 s | the whole graceful drain |
| `health_interval` | 30 s | period between health probes |

Defaults at `config.rs:220-232`. None of the seven names a request or a `handle`
callback.

The doc comment on `lifecycle_callback_deadline` (`config.rs:208-209`) enumerates
its scope: "Bind, route-gone, initialization, and health callback budget; expiry
is host-fatal (plan KTD9)". `handle` is absent, and the trait doc confirms the
asymmetry at `handler.rs:552-557`: a panic or overrun in `initialize`, `bind`,
`route_gone`, or `health` is host-fatal, while "A panic in `handle` maps to one
`internal_error` terminal for that correlation only". Overrun is not mentioned for
`handle` because there is no overrun to detect.

Every `timeout` and `timeout_at` in `dispatch.rs`, checked exhaustively:

| Site | Wraps |
| --- | --- |
| `:160` | the byte-budget charge, against the writer admission deadline |
| `:687` | the shutdown response's write completion |
| `:1264` | the `route_gone` callback |
| `:1350` | the route's dispatch-task tracker at close |
| `:1358` | the same tracker, second attempt |
| `:1434` | the tracker on the forced path |
| `:1483` | the connection `Goodbye`'s write completion |

None wraps `handler.handle(ctx)`. The handler callback is awaited bare at
`dispatch.rs:994-995`:

```
let callback = crate::panic_boundary::redact_sync(|| handler.handle(ctx));
crate::panic_boundary::redact(callback).await
```

The only things that end it are the handler returning, `cancel.cancelled()`
firing (`dispatch.rs:1001`, which aborts the inner task at `:1002`), or the
`AbortOnDropHandle` at `:997` dropping.

`cancel` has exactly three producers:

1. Client `Cancel` frame, via `handle_cancel` (`dispatch.rs:1489-1496`).
2. Route close, via `settle_route_work`'s sweep (`:1332-1342`).
3. The pre-handler check at `:944`, which is not a producer but a consumer.

Note what is *not* a producer: the generation token. The request token is created
as a free-standing root at `dispatch.rs:914` (`CancellationToken::new()`), not as
a child of `gen.token`, and the comment at `:911-913` says so: "The request token
is a free-standing root: route close cancels entries explicitly when it collects
them." So cancelling the generation does not by itself cancel a request's token;
it stops emission (via the rechecks at `:195`, `:277`, `:323`) but the handler
keeps running until `close_generation` reaches its routes.

Protocol §11 assigns the request deadline to the client: "request | one
caller-overridable 30 s absolute deadline", under the heading "Managed Rust and
TypeScript client defaults". §11's governing rule is "Every operation owns one
absolute deadline; per-stage timers MUST NOT multiply it", which is a coherent
reason for the host not to add a second one.

## Failure scenario

1. A module's handler calls an external dependency with no internal timeout — a
   subprocess, a network fetch, a lock.
2. The dependency hangs.
3. The client's own 30-second request deadline expires. Per protocol §9.2,
   cancellation is best-effort and the caller's outcome is `outcome_unknown`; per
   §13.5 ("Timeout after write") the client does not have to send `Cancel`.
4. If the client dies without sending `Cancel`, nothing cancels the request. The
   generation eventually retires on EOF, which runs `close_generation`
   (`dispatch.rs:1394-1414`), which reaches `settle_route_work` and finally
   cancels the entry.
5. Until that happens, the request holds one task permit and one pending permit.

Repeat with 256 requests and the general task pool (`max_handler_tasks` default
256, `config.rs:132`) is empty. Every other route's traffic then gets
`server_busy` from gate 6 (`dispatch.rs:896-907`), while the host's own health
probe (`handler.health`, on a dedicated task per §9.3) reports whatever the
handler chooses.

The reserved class is the mitigation and it works: `tests/dispatch.rs:1074`
(`saturated_general_capacity_cannot_consume_the_broca_reserve`) proves Broca's 96
slots survive general saturation. But there are only two classes, so a general
module starving the general pool starves every other general module.

## Timing windows and dependencies

There is no window; this is a steady state. The relevant quantity is duration,
and the bound to compare against is
`max(frame_deadline, lifecycle_callback_deadline, route_close_budget)` = 30 s at
defaults.

Dependency on the client: the permits are reclaimed by client `Cancel`, route
`Goodbye`, or connection loss. A cooperative client bounds the host's exposure;
an uncooperative or crashed one does not, except through EOF. A client that
crashes without closing its socket leaves the host waiting on liveness policy,
and `HostConfig::liveness` defaults to `None` (`config.rs:294`), which
`config.rs:281` documents as "`None` sends no Pings at all". So at default
configuration there is no liveness probe either.

That combination is the sharp edge: no host request deadline, and no host
liveness probing by default.

## What a test must construct

1. A handler mode that parks forever on a `CancellationToken` the test controls,
   or on a channel that is never fed.
2. Shrink `max_handler_tasks` and `max_pending_requests` so saturation is cheap,
   as `tests/dispatch.rs:295` already does for pending.
3. Send one request into the parked handler. Advance or wait past
   `max(frame_deadline, lifecycle_callback_deadline, route_close_budget)`.
4. Assert the route is still live via a second request that dispatches normally,
   and assert the parked request's pending entry is still unsettled — that is the
   `sometimes` observation.
5. Then fill the pool and assert the next request gets `server_busy`, and that a
   reserved-class request on a Broca route still dispatches.

`tests/dispatch.rs:295` already parks a handler in a "hang" mode
(`mode_body(json!({"mode": "hang"}))`) to occupy the only pending slot, so the
fixture exists; what is missing is the duration assertion and the "route still
live" assertion.

## Investigation log

### Q: Does the generation token cancel a request's handler?

- Sources examined: `dispatch.rs:911-914` (token construction and its comment),
  `:999-1017` (the select's cancel arm watches only `cancel`), `:1332-1342`
  (route close cancels entries explicitly), `:1399` (`close_generation` cancels
  `gen.token` first, then closes routes).
- Findings: the request token is an independent root. `gen.token` cancellation
  stops *emission* through the rechecks at `:195`, `:277`, `:323`, and it makes
  `charge_frame_or_cancel` return `None` at `:159`, but it does not reach the
  handler callback. The handler is cancelled only when `close_generation` gets as
  far as `settle_route_work`.
- Missing evidence: none.
- Conclusion: resolved with answer — generation cancellation does not directly
  cancel handler execution; route close does.

### Q: Is there a host request deadline anywhere outside `HostTiming`?

- Sources examined: all seven `HostTiming` fields; every `timeout`/`timeout_at`
  in `dispatch.rs`; `HostLimits` at `config.rs:95-160`.
- Findings: `HostLimits` carries counts and byte caps, no durations. No request
  duration exists in either struct.
- Missing evidence: `runtime.rs` (1,344 lines, sub-part 2f) was read only around
  `HostShared` and `spawn_*`; a request timer there would be surprising but I did
  not read the whole file.
- Conclusion: resolved with answer for this sub-part's files; flagged as
  needing sub-part 2f confirmation for `runtime.rs`'s remainder.

### Q: Should the host own a request deadline?

- Sources examined: protocol §11's opening rule and its client-defaults table;
  §9.2 on best-effort cancellation.
- Findings: §11 forbids multiplying per-stage timers over one owning deadline,
  and it assigns the request deadline to the client. Adding a host-side request
  timer would create exactly the second timer §11 forbids, unless it is framed as
  a resource-protection bound rather than a request deadline.
- Missing evidence: none.
- Conclusion: needs human input. The tension is real: §11's rule argues against a
  host request deadline, and the capacity consequence argues for some host-side
  reclamation that is not a deadline — a parked-task bound, which
  `ResourceDeclaration::general_task_hold_bound` (`handler.rs:98-107`) already
  provides as a *declared* limit checked at startup but not enforced at runtime.
