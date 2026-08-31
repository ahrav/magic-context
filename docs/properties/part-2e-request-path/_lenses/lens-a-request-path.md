# Lens A, sub-part 2e-request-path: admission, dispatch, and response obligations

Attention focus: what admits a request, what guarantees it gets a response, and
what happens when it does not. A sibling lens owns the claim and check
inventory, so this file carries no check inventory.

Scope files, per the re-scope's list: `crates/mc-host/src/dispatch.rs` (1,539),
`control.rs` (1,180), `routing.rs` (833), `handler.rs` (604), `composite.rs`
(390). Total 4,546 lines, all verified against `e447c927`.

`connection.rs` is Part 2a's file and is cited here as the caller boundary only.
`ring_transport.rs`, `wire.rs`, and `frame_channel.rs` are Part 2b's and are
cited for the publication contract only. `client.rs` is Part 2d's.

## Reachability evidence, established once and applied per record

METHOD rule 4 forbids a blanket preamble claim, so each record carries its own
label. The three facts below are the shared evidence those labels cite; they were
verified here, not assumed.

1. **The routed request path is production.** The production binary is
   `crates/mc-module/src/bin/ck_mc_host/serve.rs`, which builds the composite at
   `:575` and calls `mc_host::run` at `:632`. Part 2b resolved the ring as
   `default-production` against three misleading signals, and `read_loop`
   (`connection.rs:373`) is the ring's only frame consumer, calling
   `dispatch_request` at `connection.rs:467` and `handle_control` at `:462`.
2. **`RouteClass::Reserved` is production, not a test fixture.**
   `runtime.rs:118-119` claims the reserved pools are "Zero-permit when no
   module declared a reservation, and then unreachable because every route is
   general-class". That comment is not a reachability answer:
   `broca/mod.rs:164-176` declares `route_class: RouteClass::Reserved` with
   `RESERVED_PENDING_REQUESTS = 96` and `RESERVED_HANDLER_TASKS = 96`
   (`broca/config.rs:185`, `:188`), and `serve.rs:575` composes that exact
   Broca component. Both permit classes are live in production.
3. **Only two of this sub-part's five test binaries run in CI.** Every
   `mc-host` invocation in `.github/workflows/ci.yml` carries a `--test` filter:
   `:132-134`, `:178-179`, `:187`, `:190`. The named binaries are `client`,
   `lifecycle`, `shm_failure_modes`, `shm_soak`, plus `--doc`. So
   `tests/dispatch.rs`, `tests/routing.rs`, `tests/handler_contract.rs`, and
   `tests/composite_routing.rs` — the four suites that carry almost every
   existing check in this sub-part — run locally only. Grep across all five
   workflow files returns no hit for any of those four names. Every
   `Existing check:` below states this where it applies.

## Admission map

Two disjoint chains, one per channel class. Order is the source order in the
code, and each row states exactly what it rejects and how.

### Routed request, `channel != 0`

| # | Gate | Location | Rejects with |
| --- | --- | --- | --- |
| 1 | correlation strictly above the generation watermark | `connection.rs:456` | silent generation close, no terminal |
| 2 | `epoch != 0` | `connection.rs:464` | silent generation close, no terminal |
| 3 | `draining` flag or host shutdown token | `dispatch.rs:844` | `server_busy`, via `emit_rejection` |
| 4 | advisory live-route lookup, `route_tracker` | `dispatch.rs:861` | `unknown_channel`, via `emit_rejection` |
| 5 | class-scoped pending permit, `try_acquire_owned` | `dispatch.rs:884` | `server_busy`, via `emit_rejection` |
| 6 | class-scoped task permit, `try_acquire_owned` | `dispatch.rs:896` | `server_busy`, via `emit_rejection` |
| 7 | authoritative `register_dispatch` under the registry lock | `dispatch.rs:1069` | `server_busy` if draining, else `unknown_channel`, via `emit_rejection` |

Gates 1 and 2 are the only two that produce no frame at all while the host is
otherwise healthy. Gates 3 through 7 all funnel through `emit_rejection`
(`dispatch.rs:613-641`), which is itself gated on a third counter: see the
rejection-bound section below.

Gate 5's class comes from the route, not the body: `route_tracker` returns
`(TaskTracker, RouteClass)` (`routing.rs:326-340`) and `dispatch.rs:873-879`
selects the pool pair from it. The host never parses an application body to
pick a class.

### Control request, `channel == 0`

| # | Gate | Location | Rejects with |
| --- | --- | --- | --- |
| 1 | correlation strictly above the watermark | `connection.rs:456` (frames), `:416` (oversize) | silent generation close |
| 2 | 65,536-byte channel-0 body cap, enforced in the transport | `connection.rs:408` arm | `invalid_control_request` via `emit_authoritative_rejection` |
| 3 | JSON-only, `binary == 0` | `control.rs:104` | `invalid_control_request` |
| 4 | strict JSON: UTF-8, no duplicate keys, no trailing bytes | `control.rs:107`, `:611-708` | `invalid_control_request` |
| 5 | object root | `control.rs:111` | `invalid_control_request` |
| 6 | whole-request nesting, `MAX_CONTROL_DEPTH = 33` | `control.rs:114-123` | `invalid_control_request` |
| 7 | `op` present, string, 1..=64 bytes, no NUL | `control.rs:125-133` | `invalid_control_request` |
| 8 | per-operation field bounds | `control.rs:147-337` | `invalid_control_request` |
| 9 | target classification, after every bound held | `control.rs:300-319` | `target_unavailable` or `unknown_module` |
| 10 | pending permit, class-selected for `route.open` | `connection.rs:616-635` | `server_busy`, via `emit_rejection` |

Two structural asymmetries against the routed chain:

- **A control request consumes no task permit.** Gates 5 and 6 of the routed
  chain have no control analogue. Only `pending_permits` bounds control work.
- **Parsing precedes admission.** Gates 3 through 9 run on the read loop with
  no permit held and no byte charge for the derived `serde_json::Value` tree
  (`control.rs:107`, called from `connection.rs:596`). The permit is acquired at
  gate 10, *after* the work. `value_depth` (`control.rs:373-379`) is a genuine
  unbounded recursion over that tree, but `strict_json::parse` runs first and
  serde_json's own default recursion limit caps nesting before `value_depth`
  ever descends, so the reader-side cost is O(body) with a bounded stack. This
  closes the re-scope's lead (a) as bounded, not as a defect.

### Cancel

`connection.rs:470-477`: structural shape only — nonzero channel, nonzero
epoch, nonzero correlation, else silent generation close. No permit, no charge,
no terminal. `handle_cancel` (`dispatch.rs:1489-1496`) is a map lookup that
cancels only an unsettled entry.

### Is rejection uniform across request kinds?

No, in three separate ways, all of them client-visible.

1. **Different codes for the same cause.** A routed request rejected because the
   host is shutting down gets `server_busy` (`dispatch.rs:850`). A `route.open`
   rejected for the identical cause gets `target_unavailable`
   (`dispatch.rs:1117`). Protocol §10.2 gives these two codes different retry
   rules, so the code choice changes client behaviour.
2. **Different bounds on the emission.** Routed rejections and control
   *capacity* rejections go through `emit_rejection`, bounded by the
   per-generation `busy_rejects` semaphore of 32 (`connection.rs:42`, `:244`).
   Control *semantic* rejections go through `emit_error_terminal` inside a task
   that holds a pending permit (`connection.rs:638-655`), bounded by
   `pending_permits`. Oversize-control rejections use a third path,
   `emit_authoritative_rejection`, bounded by `busy_rejects` but carrying a
   write-completion fence the other two do not have (`connection.rs:430-450`).
3. **Different guarantees on delivery.** Only the oversize path can prove its
   terminal reached the socket, because only it passes a `written` hook.

## Dispatch map

`dispatch_request` (`dispatch.rs:828-1095`) is the whole routed path.

```
read_loop (connection.rs:467)
  -> dispatch_request
       gates 3-7 above
       Settlement::new(), CancellationToken::new()      dispatch.rs:913-914
       gen.pending.insert(key, PendingEntry)            dispatch.rs:916-922
       outer = spawn_tracked(route_tracker.track_future(..))   dispatch.rs:932
         waits on start_rx                              dispatch.rs:934
         inner = spawn_tracked(handler_fence.track_future(..)) dispatch.rs:985
           holds task_permit                            dispatch.rs:990
           redact_sync(|| handler.handle(ctx))           dispatch.rs:994
           redact(callback).await                        dispatch.rs:995
         AbortOnDropHandle::new(inner)                   dispatch.rs:997
         select! { cancel.cancelled() | joined }         dispatch.rs:999-1065
         settle(..)                                      dispatch.rs:1004 / :1063
         remove_pending                                  dispatch.rs:1066
       register_dispatch -> start_tx.send(())            dispatch.rs:1069-1074
```

Two tasks per request, not one. The split is deliberate and load-bearing: the
**task permit lives in the inner callback task** so capacity frees the moment
the handler returns, while the **pending permit lives in the outer settling
task** so it is held across the egress wait (`dispatch.rs:933`, `:990`, and the
comment at `:987-989`).

`start_tx`/`start_rx` is a two-phase commit against the registry: the pending
entry and both tasks exist before `register_dispatch` runs, and a refused
registration drops `start_tx`, which the outer task observes as
`start_rx.await.is_err()` and answers by removing the pending entry and
returning (`dispatch.rs:934-937`). No handler callback runs on that path.

**What bounds concurrent handler work.** Four independent bounds:

| Bound | Value | Scope | Acquisition |
| --- | --- | --- | --- |
| `task_permits` | `max_handler_tasks` (default 256) minus reservations | host-global, general class | `try_acquire_owned` on the read loop |
| `reserved_task_permits` | 96 (Broca) | host-global, reserved class | same |
| `pending_permits` | `max_pending_requests` (default 1024) minus reservations | host-global, general class | same |
| `reserved_pending_permits` | 96 (Broca) | host-global, reserved class | same |

Defaults at `config.rs:131-132`; pool construction at `runtime.rs:905-912`.
All four are **host-global, not per-generation**, so one connection can consume
every general slot; per-connection fairness is not a property of this layer.

**What happens when the bound binds.** `try_acquire_owned` never waits. The
request is rejected pre-dispatch with `server_busy` and zero handler
invocation. The comment at `dispatch.rs:881-883` states the reason: acquiring
inside the spawned task would let a client pipeline unbounded tasks ahead of the
gate. This is the one place where the design is unambiguously correct and
tested (`tests/dispatch.rs:295`, `:976`, `:1074`).

## Response obligation map

### Routed request

The arbiter is `Settlement` (`dispatch.rs:34-59`): `won: AtomicBool` flipped by
`swap(true)` under an async `order` mutex (`dispatch.rs:407-410`). Every
emission for a correlation serializes on that mutex, so a stream item can never
follow the terminal, and `streamed` is stored before the lock releases
(`dispatch.rs:583-604`, store at `:599`). Exactly one caller wins, no matter
which of handler completion, cancellation, route close, or teardown arrives
first.

Terminal selection, `dispatch.rs:1018-1063`:

| Handler result | Terminal | Location |
| --- | --- | --- |
| `Response` after any `StreamData` | `internal_error` | `:1020-1030` |
| `Response`, `body.len() <= MAX_BODY_LEN` | `Response` | `:1031-1034` |
| `Response`, oversized | `internal_error` | `:1035-1039` |
| `Error` | `Error`, diagnostics capped | `:1040-1051` |
| `Streamed` | `StreamEnd` | `:1052` |
| join error, panic | `internal_error` | `:1053-1057` |
| join error, not panic (abort) | **no terminal**, pending removed | `:1058-1061` |

So a routed request gets **at most one** terminal, and one specific exit gets
none. The zero-terminal exit is the abort path, reached from
`force_close_all_routes` (`dispatch.rs:1421-1452`), which aborts before waiting.

### Control request

Control correlations have **no settlement object**. `emit_error_terminal`
(`dispatch.rs:370-394`) is documented as the emitter "for a correlation that has
no settlement object". Exactly-one is enforced structurally instead: each
`handle_control` arm emits exactly one frame (`connection.rs:637-726`).

`route.open` is the exception and the worst case. `open_route`
(`dispatch.rs:1103-1239`) has seven exits and **three of them emit nothing** for
the correlation:

| Exit | Location | Answers the correlation |
| --- | --- | --- |
| draining | `:1112-1122` | yes, `target_unavailable` |
| `reserve` returned `None` | `:1127-1137` | yes, `target_unavailable` |
| bind panicked, aborted, or self-deadlined | `:1164-1170` | **no** |
| bind still executing at the lifecycle deadline | `:1174` | **no** |
| accept, installed | `:1178-1194` | yes, `Response` |
| accept, `CloseWins` | `:1195-1202` | **no** |
| handler `Reject` | `:1204-1237` | yes, `Error` |

The first two silent exits both trip the fatal latch inside
`lifecycle_join` (`runtime.rs:186-207`), so the host is terminating. The third is
reached whenever a close raced the bind. In all three the client's only signal
is its own 30-second route deadline.

### Acknowledgement versus attempt

Per METHOD's effect-accounting rule, these are tracked separately here.

- **Attempted** = `send_before` returned `Ok`, meaning the frame entered the
  writer queue.
- **Acknowledged** = the `written` hook fired after every byte reached egress
  (`ring_transport.rs:573-575`).

Only three emissions in this sub-part carry a `written` hook:
`handle_host_shutdown` on both its paths (`dispatch.rs:678-680`, `:743-756`),
`emit_authoritative_rejection` (`dispatch.rs:814-816`), and
`send_connection_goodbye` (`dispatch.rs:1474-1476`). Every routed terminal
passes `written: None` (`dispatch.rs:358`, `:300` when the caller supplies
nothing). So for routed work the host's acknowledged count is identically zero,
and observed client terminals are bounded above by the settlement count and
below by nothing the host can witness.

## Observations

Every line reference below was read at `e447c927`.

1. `dispatch.rs:34-59` — `Settlement` is three fields: `won`, an async `order`
   mutex, and `streamed`. The `swap` at `:408` is the sole arbiter.
2. `dispatch.rs:79-95` — `MAX_TERMINAL_CODE_LEN = 128` and
   `MAX_TERMINAL_MESSAGE_LEN = 4096`. `bounded_terminal_error` replaces an
   over-cap pair wholesale with `internal_error` and drops `retry_after_ms`.
   The doc comment at `:75-78` states the reason: diagnostics are held across
   the egress wait without a byte charge.
3. `dispatch.rs:1210-1218` — the same two caps are re-applied by hand to a
   handler `BindOutcome::Reject`, with a different substitute message. Two copies
   of one policy.
4. `dispatch.rs:101-124`, `:228-245` — `escaped_json_len` models `serde_json`'s
   escaping exactly so the byte charge is taken before the body is materialized.
   `debug_assert_eq!` at `:212` is the only guard, and `mc-host` inline tests do
   not run in CI, so the model has no release-build check.
5. `dispatch.rs:143-168` — `charge_frame_or_cancel` is `biased` on request
   cancellation, then generation cancellation, then the budget wait. A budget
   wait that outlives the writer's admission deadline **cancels the generation**
   (`:163`), converting one slow frame into a connection close.
6. `dispatch.rs:195-197`, `:277-282`, `:323-325` — every emit entry rechecks
   `gen.writer.is_retired() || gen.token.is_cancelled()` before doing work.
7. `dispatch.rs:377-380`, `:429-431`, `:443`, `:458`, `:471`, `:484`, `:498` —
   seven distinct sites where an emission failure answers by cancelling the
   generation token. A per-request failure is escalated to a connection close.
8. `dispatch.rs:613-641` — `emit_rejection`. On `busy_rejects` exhaustion
   (`:629`) it cancels the token **and** calls `gen.writer.discard()` (`:638`),
   which drops the queued frames of every other correlation on the generation.
   The comment at `:630-636` names the tradeoff and says the unemitted terminals
   "become outcome_unknown".
9. `dispatch.rs:1058-1061` — the non-panic join-error arm returns without
   settling. This is the only routed exit with no terminal and no generation
   cancellation.
10. `dispatch.rs:1031-1034` — the handler `Response` guard is
    `body.len() <= MAX_BODY_LEN`. There is no lower bound and no content check.
    `OutputBuffer::len()` (`handler.rs:362-366`) returns the *declared*
    `exact_len` for a direct output and the *written* length for an owned one.
11. `handler.rs:381-396` — `extend_from_slice` and `resize` both refuse to grow
    past `max_len` and both refuse outright when `direct.is_some()`. A handler
    that reserves and never writes is a supported, silent state.
12. `dispatch.rs:326-350` with `ring_transport.rs:580-593` — a direct output's
    serializer runs inside the writer, long after `settle` returned. A short or
    long write reaches `reservation.commit(body_len)`, which rejects on
    `cursor != body_len` (`mc-shm-transport/src/backend/ring.rs:1363-1367`,
    `ProducerError::Underfill`).
13. `ring_transport.rs:564-566` — a failed publication returns `Err` from
    `publish_one` without running the `written` hook and without touching the
    settlement. Part 2b established that this presents to the peer as a clean
    close.
14. `dispatch.rs:844-855` versus `:1112-1122` — the same shutdown condition,
    two different codes: `CODE_SERVER_BUSY` for routed, `CODE_TARGET_UNAVAILABLE`
    for `route.open`.
15. `dispatch.rs:770-779` — the shutdown-commit watchdog is a bare
    `tokio::spawn`, not `spawn_tracked` and not in `gen.read_tasks`. It is the
    only spawn in this sub-part outside the host's task tracker.
16. `dispatch.rs:1348-1372` — route close is grace, then abort, then a second
    bounded wait; a tracker that still will not drain trips the fatal latch and
    returns `false` so route-gone never runs beside live request code.
17. `dispatch.rs:1374-1380` — `settle_route_work` removes the pending keys it
    collected, "Aborted tasks never removed their own pending entries".
    `force_close_all_routes` (`:1421-1452`) performs no equivalent sweep.
18. `routing.rs:294-320` — `register_dispatch` is the linearization point. It
    checks `inner.accepting` first (`:305`), so the shutdown freeze and dispatch
    admission share one lock.
19. `routing.rs:317` — `occupant.aborts.retain(|abort| !abort.is_finished())`
    prunes only on the dispatch path that grows the list. A route that stops
    receiving requests retains its last handles until close.
20. `routing.rs:184` — `unreachable!("bind completion found route in {state:?}")`
    and `routing.rs:441-452` — `expect_occupant` panics with "registry lost
    route it owns". Two registry invariants enforced by panic, inside a
    `Mutex`, so tripping either poisons the registry lock for the process.
21. `composite.rs:277-287` — an unmapped route in `handle` returns
    `RequestOutcome::error(CODE_INTERNAL_ERROR, ...)`. This is the one
    handler-side failure in the sub-part that is correctly shaped as an error.
22. `composite.rs:359-389` — the composite's `shutdown` collects child failures
    and re-raises them as a single `panic!`, deliberately, so the runtime
    classifies the callback as failed.
23. `control.rs:300-319` — classification runs only after every bound held, so a
    hostile body cannot pick its rejection code to probe the catalog cheaply.
24. `control.rs:397-410`, `:441-461` — the catalog is serialized once at startup
    through a `CappedWriter`, so `catalog.list` allocates nothing per request
    and cannot be used to amplify.
25. `config.rs:199-218` — `HostTiming` has seven fields. None of them bounds a
    request's lifetime. `frame_deadline`, `route_close_budget`, and
    `lifecycle_callback_deadline` bound frames, closes, and lifecycle callbacks
    respectively; the handler callback itself is unbounded.
26. `handler.rs:552-557` — the trait doc states the failure policy: a `handle`
    panic maps to one `internal_error` terminal, and `initialize`, `bind`,
    `route_gone`, and `health` overruns are host-fatal. The code matches.

## Candidate properties

### req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:358` and `:453` race cancel against
completion and assert one terminal; neither binary runs in CI, and neither
races route close or generation teardown into the same settlement.
Guarantee: For one routed correlation, at most one of `Response`, `Error`, or
`StreamEnd` reaches the writer queue, whichever of handler completion,
cancellation, route close, and generation teardown arrives first.
Check: `always` — over every correlation observed on a generation, the count of
terminal-typed frames carrying that `(channel, epoch, corr)` is at most one, and
no `StreamData` for that correlation follows its terminal. `always` because the
arbiter is evaluated on every settlement attempt, not on an optional path.
Fault/timing angle: The window is between `settlement.order.lock()` and the
`won.swap` at `dispatch.rs:408`. A stream `send` holds the same lock while
emitting and stores `streamed` before releasing it (`:583`, `:599`), so the
`has_streamed` read at `:418` cannot observe a torn state.
Required faults and enabling state: A live route with a handler that both
streams and returns a unary `Response`, plus a client `Cancel` and a route
`Goodbye` delivered inside the handler's execution window. Three settlement
claimants must be in flight at once.
Confidence: high — [evidence](evidence/req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame.md).
Verified the `swap` is the only mutator of `won`, that all five emission sites
take the order lock, and that the `streamed` store precedes lock release.
Existing check: `tests/dispatch.rs:358` `cancel_and_completion_settle_exactly_once`,
`:453` `simultaneous_cancel_and_completion_still_emit_one_terminal`,
`:504` `cancelling_a_stream_stops_it_with_one_terminal`. Status unaudited. Not
in CI.
Impact: A duplicate terminal settles a correlation the client has already
retired and, per Part 2d, is dropped as unmatched; a `Response` after
`StreamData` corrupts the client's view of the stream.
Open questions: None.

### req-a-a-routed-terminal-carries-no-delivery-acknowledgement

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test distinguishes a queued terminal from a delivered
one for a routed correlation, because the host exposes no signal to distinguish
them.
Guarantee: A routed terminal's logical settlement records only that the frame
entered the writer queue; the host retains no evidence that any routed terminal
reached the peer.
Check: `always` — for every routed terminal emission, the `OutboundFrame`
carries `written: None`, so host-side acknowledged effects are identically zero
while attempted effects equal the settlement count. Per METHOD's effect
accounting, assert observed client terminals at most the host's settlement count
and at least zero, and assert per-correlation that no host state claims delivery.
`always` because it holds on every emission, not on a failure path.
Fault/timing angle: The gap is unbounded in time. `send_before` returning `Ok`
proves queue admission (`frame_channel.rs:715-723`); publication happens later
inside the endpoint thread (`ring_transport.rs:536-578`).
Required faults and enabling state: A generation whose writer queue holds a
settled terminal when the generation is cancelled or the publication fails. The
settlement is already recorded; the frame never leaves.
Confidence: high — [evidence](evidence/req-a-a-routed-terminal-carries-no-delivery-acknowledgement.md).
Enumerated every `written:` construction in the sub-part: three hooks exist, all
on control or teardown frames, none on a routed terminal.
Existing check: none.
Impact: The host cannot report, log, or meter which requests were actually
answered. Protocol §10.1 makes an unobserved terminal `outcome_unknown` on the
client side; the host has no matching classification, so the two ends cannot be
reconciled after a close.
Open questions:
- Should routed terminals carry a `written` hook for metering, given the hook
  is a boxed closure per frame? (needs human input)

### req-a-a-response-publication-failure-never-reaches-the-settling-path

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives a serializer that writes the wrong number
of bytes, and none asserts what the client observes when a settled terminal
fails to publish.
Guarantee: When a settled terminal fails to publish, the settling path has
already returned success, the request is recorded as settled, and the client's
only signal is a clean connection close.
Check: `always` — whenever `publish_one` returns `Err` for a frame whose
correlation has `won == true`, assert that no `Error` terminal for that
correlation is emitted afterwards and that the generation's close carries no
distinguishing reason. `always` rather than `always-or-unreached` because the
settlement half runs on every request; only the failure half is conditional, and
the guarantee is about their relationship.
Fault/timing angle: `settle` completes at `dispatch.rs:460` once `send_before`
returns `Ok`. The failure occurs later in the endpoint thread. The two are not
ordered by anything, so the settling task is typically already gone.
Required faults and enabling state: A handler that calls
`RequestCtx::output_from_writer` with an `exact_len` its serializer does not
match, or a ring reservation that fails under contention.
`reservation.commit(body_len)` then returns `ProducerError::Underfill`
(`mc-shm-transport/src/backend/ring.rs:1363-1367`).
Confidence: high — [evidence](evidence/req-a-a-response-publication-failure-never-reaches-the-settling-path.md).
Traced the direct-output path from `dispatch.rs:332-349` through
`ring_transport.rs:580-593` into `commit`, and confirmed `publish_one` discards
the `written` hook on failure without touching the settlement.
Existing check: none in this sub-part. Part 2b holds
`ring-a-publish-failure-is-reported-as-a-clean-peer-close`, which establishes
the close half but not the settlement half.
Impact: The host believes the request was answered and the client believes
nothing was answered. Combined with Part 2d's finding that a clean host close
and a transport failure share one code, the client cannot attribute the loss,
and any effect the handler already applied is invisible to it.
Open questions:
- Does any production handler use `output_from_writer` with a computed
  `exact_len` that could disagree with its serializer? That is `mc-module`'s
  side of the boundary. (unresolved, needs an `mc-module` audit)

### req-a-a-handler-response-is-length-checked-and-never-content-checked

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:665`
`oversized_handler_output_cannot_corrupt_framing` covers the upper bound only.
No test constructs a handler that reserves output and returns `Response`
without writing.
Guarantee: The dispatch layer validates a handler `Response` against the frame
size ceiling and nothing else, so a handler that reserved output and wrote
nothing produces a successful zero-length `Response` terminal.
Check: `always` — for every `RequestOutcome::Response` accepted at
`dispatch.rs:1031`, the only predicate applied is
`body.len() <= MAX_BODY_LEN`; assert there is no lower-bound, emptiness, or
declared-versus-written comparison anywhere on the path to
`emit_reserved_frame`. `always` because the check runs on every unary success.
Fault/timing angle: None. This is a static gap in the guard, not a race.
Required faults and enabling state: A handler that reserves an `OutputBuffer`,
takes an early error return without writing, and still returns
`RequestOutcome::Response`. Parts 4c and 4d found handlers returning success
without writing, on the other side of this boundary.
Confidence: high — [evidence](evidence/req-a-a-handler-response-is-length-checked-and-never-content-checked.md).
Confirmed `encode_owned_frame` (`wire.rs:571-602`) accepts an empty body and
that `decode`'s pure-header rule (`wire.rs:340`) covers only Cancel, Ping,
Pong, and Goodbye, so a zero-length `Response` is a well-formed frame.
Existing check: `tests/dispatch.rs:665` for the ceiling. Status unaudited. Not
in CI.
Impact: This is the success-shaped-error-path pattern in this layer, and it is
the fourth part of the catalog to find it. A handler failure reaches the client
as a terminal success with an empty body. The client cannot distinguish it from
a legitimately empty result, so it will not retry and will not surface an error.
Open questions:
- Does any client treat an empty-body `Response` as a protocol violation? That
  is Part 2d's and Part 5's surface. (unresolved, needs a client-side check)

### req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:295` and `:271` assert the terminal on
the healthy path. Nothing exercises the exhaustion path.
Guarantee: Every pre-dispatch rejection either enters the writer queue or the
generation is retired with its queue discarded; no rejection is silently
dropped while the generation stays live.
Check: `always` — on every `emit_rejection` call, assert either that a terminal
frame for the correlation is queued, or that `gen.token.is_cancelled()` and
`gen.writer` is discarding. `always` because the disjunction must hold at every
call, and the second disjunct is the code's actual answer past the bound
(`dispatch.rs:629-639`).
Fault/timing angle: The window is 32 concurrent no-dispatch rejections per
generation, all blocked on contended egress budget, before a 33rd arrives.
`busy_rejects` is `MAX_INFLIGHT_BUSY_REJECTS = 32` (`connection.rs:42`, `:244`).
Required faults and enabling state: A saturated egress byte budget plus a client
pipelining more than 32 requests that fail admission. Both are reachable: the
budget saturates in `tests/dispatch.rs:788`, and admission failure needs only a
closed route or an exhausted permit pool.
Confidence: high — [evidence](evidence/req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired.md).
Verified the permit is acquired before the spawn on both call paths and that the
exhaustion arm cancels and discards rather than awaiting inline.
Existing check: `tests/dispatch.rs:271` `an_unknown_route_is_refused_with_zero_dispatch`,
`:295` `saturated_request_capacity_returns_server_busy_without_dispatch`. Status
unaudited. Not in CI.
Impact: `writer.discard()` drops queued frames belonging to *other*
correlations, so one client's rejection flood converts every in-flight peer
request on that generation into `outcome_unknown`. Protocol §10.2 lists
`server_busy` as a terminal that proves no dispatch; past this bound no such
terminal exists, so the proof the client is told to rely on is conditional on
capacity the client cannot observe.
Open questions: None.

### req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/routing.rs:396` and `:570`, and
`tests/handler_contract.rs:229`, cover the answering exits. No test drives a
bind panic, a bind deadline overrun, or a close that races a bind through
`open_route`.
Guarantee: A `route.open` correlation receives exactly one terminal unless the
host has tripped its fatal latch or the route's close already won, in which
case it receives none and the client learns only from its own deadline.
Check: `always` — on every `open_route` return, assert either that one terminal
frame carries the control correlation, or that `shared.fatal` is tripped, or
that the registry reports the handle in `Closing`. `always` because the
disjunction must hold on all seven exits.
Fault/timing angle: Three windows. A bind callback that panics or overruns
`lifecycle_callback_deadline` (30 s default, `config.rs:225`) exits at
`dispatch.rs:1164-1170` or `:1174`. A close marked between `reserve` and
`install_bound` produces `BindInstall::CloseWins` at `:1195-1202`.
Required faults and enabling state: For the first two, a handler `bind` that
panics or blocks. Parts 4c and 4d found handler panics, so this is not
hypothetical. For the third, a generation teardown or forced drain concurrent
with an in-flight bind; `routing.rs:408-413` marks mid-bind routes
close-requested rather than draining them.
Confidence: high — [evidence](evidence/req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining.md).
Enumerated all seven exits, and confirmed via `runtime.rs:186-207` that both
lifecycle-failure variants trip the fatal latch before returning.
Existing check: `tests/routing.rs:396` `rejected_bind_never_publishes_and_still_reports_route_gone`,
`:570` `route_capacity_exhaustion_is_refused_without_binding`,
`tests/handler_contract.rs:229` `a_rejected_bind_carries_the_handler_code_to_the_client`.
Status unaudited. Not in CI.
Impact: Protocol §8.2 acknowledges an abandoned `route.open` and gives the
client a remedy keyed on receiving an *unmatched control `Response`*. On these
three exits there is no frame at all, so that remedy never triggers and the
client burns its full 30-second route deadline. Repeated bind panics therefore
cost one route deadline each.
Open questions:
- Is the `CloseWins` silent exit reachable on a generation that stays live
  afterwards, or does every producer of that decision also retire the
  generation? `settle_route` is called from host shutdown, so the host is at
  least draining; a route `Goodbye` cannot reach it because the client does not
  yet know the handle. (unresolved, needs the shutdown-path caller list from
  `harness_closure.rs`, which is sub-part 2f)

### req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test sends a `route.open` and a routed request into the
same draining host and compares the two codes.
Guarantee: The shutdown admission fence is one condition evaluated at two call
sites, and the two sites answer with different error codes carrying different
client retry rules.
Check: `always` — whenever `shared.draining` is set or `shared.shutdown` is
cancelled, assert that every routed request receives `server_busy` and every
`route.open` receives `target_unavailable`, and record that both are attributed
to the same cause. `always` because the fence is evaluated on every admission.
Fault/timing angle: The fence is checked twice per request kind: advisorily at
`dispatch.rs:844` and `:1112`, then authoritatively under the registry lock at
`routing.rs:305`. `handle_host_shutdown`'s write hook sets both `draining` and
`freeze_admission` inside the writer task (`dispatch.rs:752-753`), so the
commit point and the fence coincide.
Required faults and enabling state: An authenticated `host.shutdown`, or an
external shutdown signal, with a client pipelining both a routed request and a
`route.open` behind it.
Confidence: high — [evidence](evidence/req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes.md).
Both call sites read; protocol §10.2's two retry rows compared.
Existing check: none.
Impact: Protocol §10.2 tells a client to retry `target_unavailable` "with new
correlation under bounded route deadline" and `server_busy` "with backoff". A
draining host therefore invites un-backed-off `route.open` retries from exactly
the clients it is trying to shed, while backing off their routed traffic.
Open questions:
- Which code does the protocol intend for a `route.open` during shutdown? §12
  step 1 names `server_busy` for routed requests and is silent on `route.open`;
  §8.3 reserves `target_unavailable` for route admission failures such as
  channel exhaustion, which shutdown is not. (needs human input)

### req-a-a-handler-outliving-every-host-deadline-is-reached

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:295` parks a handler in a "hang" mode to
occupy a permit, so the state is constructed; nothing asserts the absence of a
host-side bound or measures how long the permits stay held.
Guarantee: A campaign reaches the state where an admitted request's handler has
been executing longer than every deadline the host configures, with its route
and generation still live and no `Cancel` outstanding.
Check: `sometimes` — at least once per campaign, observe a request whose
handler has held its task and pending permits for longer than
`max(frame_deadline, lifecycle_callback_deadline, route_close_budget)` while
`route_tracker` still reports the route live and the pending entry is unsettled.
`sometimes` and not `reachable`: the branch lines are trivially executed by any
slow handler, but the operational state that matters is a handler outliving the
host's whole deadline vocabulary, which is a situation, not a location.
Fault/timing angle: `HostTiming` (`config.rs:199-218`) has no request field.
`route_close_budget` (5 s) applies only once a close begins;
`lifecycle_callback_deadline` (30 s) applies to `bind`, `route_gone`,
`initialize`, and `health`, never to `handle`.
Required faults and enabling state: A handler whose `handle` blocks on an
external dependency with no internal timeout. Protocol §11 assigns the
30-second request deadline to the *client*, so a client that dies without
sending `Cancel` leaves the host holding the permits indefinitely.
Confidence: high — [evidence](evidence/req-a-a-handler-outliving-every-host-deadline-is-reached.md).
Read all seven `HostTiming` fields and every `timeout`/`timeout_at` call in
`dispatch.rs`; none wraps the handler callback.
Existing check: `tests/dispatch.rs:295` constructs the state incidentally.
Status unaudited. Not in CI.
Impact: Handler-task capacity is reclaimed only by handler cooperation, client
`Cancel`, route close, or generation teardown. A module with a missing internal
timeout can hold all 256 general task permits, at which point every other
route's traffic gets `server_busy` while the host reports itself healthy.
Open questions:
- Should the host own a request deadline at all, given protocol §11's rule that
  each operation owns exactly one absolute deadline and it assigns the request
  deadline to the client? Adding one would create the multiplied timer §11
  forbids. (needs human input)

### req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:835`
`closing_a_route_settles_its_admitted_work` and `tests/routing.rs:435` cover
close-then-request. No test lets a handler complete *after* its generation
retired and asserts nothing is emitted.
Guarantee: A handler result that arrives after its generation was cancelled or
retired, or after its correlation was settled by another claimant, produces no
frame on any generation.
Check: `always` — at every emission entry point, assert that
`gen.writer.is_retired() || gen.token.is_cancelled()` implies no frame is
constructed, and that `settlement.won` already true implies no frame is
constructed. `always` because the recheck runs unconditionally on each of the
four entry points.
Fault/timing angle: The recheck sites are `dispatch.rs:195-197` (charged error
body), `:277-282` (`emit_frame_with_written`), `:323-325`
(`emit_reserved_frame`), and `:519-524` plus `:531-536` (`StreamSink::reserve`,
which rechecks both before and after the budget wait). The request token is a
free-standing root, not a child of the generation token
(`dispatch.rs:911-914`), so route close must cancel entries explicitly
(`:1338-1341`).
Required faults and enabling state: A handler that completes while its
generation is being torn down, with the terminal's byte charge acquired before
the cancellation and consumed after it.
Confidence: high — [evidence](evidence/req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation.md).
Verified all four entry points recheck, and that `StreamSink::reserve` rechecks
on both sides of the await so a charge granted before cancellation cannot be
used after it.
Existing check: `tests/dispatch.rs:835`, `tests/routing.rs:435`
`closed_route_requests_are_unknown_and_cleanup_is_idempotent`. Status
unaudited. Not in CI.
Impact: A frame emitted onto a retired generation would be delivered to a
successor connection's peer if the writer were reused, or dropped as unmatched
if not. Part 2a's silent-close rule depends on this holding: a retirement that
fabricated a terminal would contradict protocol §6.3.
Open questions: None.

### req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:976` and `:1074` prove the two classes
cannot consume each other; `tests/handler_contract.rs:323` and `:636` prove the
startup checked-sum. No test proves the permits are acquired *before* the spawn
rather than inside it.
Guarantee: Concurrent handler callbacks are bounded by the class-scoped
`task_permits` pool, concurrent unsettled requests by the class-scoped
`pending_permits` pool, both acquired non-blockingly on the read loop before any
task is spawned, and each class is unreachable from the other.
Check: `always` — assert that live handler callbacks never exceed the class's
task-permit count, that unsettled requests never exceed its pending-permit
count, and that both acquisitions are `try_acquire_owned` on the reader so
exhaustion rejects instead of queueing. `always` because both bounds must hold
at every instant.
Fault/timing angle: The task permit is released when the handler returns
(`dispatch.rs:990`, inside the inner task) while the pending permit is held
across the egress wait (`:933`, in the outer task). Under a slow peer the two
counts diverge, which is intended: a blocked terminal must not occupy handler
capacity.
Required faults and enabling state: A client pipelining more requests than
`max_handler_tasks` on one route, plus a slow-reading peer so terminals queue
and the pending count exceeds the task count.
Confidence: high — [evidence](evidence/req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs.md).
Verified pool construction at `runtime.rs:905-912`, class selection at
`dispatch.rs:873-879` from `route_tracker`'s stored class, and Broca's live
96/96 reserved declaration.
Existing check: `tests/dispatch.rs:976` `saturated_broca_reserve_cannot_consume_a_general_slot`,
`:1074` `saturated_general_capacity_cannot_consume_the_broca_reserve`,
`tests/handler_contract.rs:323` `reservations_must_leave_one_general_slot_in_each_pool`,
`:636` `zero_reservation_handlers_keep_single_pool_admission`. Status unaudited.
None in CI.
Impact: All four pools are host-global, so one connection can hold every general
permit. Per-connection fairness is not provided at this layer; if it is
required, it is required somewhere else and nothing here supplies it.
Open questions:
- Is per-connection handler-capacity fairness owned anywhere? `connection_permits`
  bounds connection count but not per-connection dispatch share. (unresolved,
  needs sub-part 2f's `runtime.rs` and `config.rs` pass)

### req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test inspects `gen.pending` after a forced close, and
the map is private to the crate.
Guarantee: Every entry inserted into `gen.pending` is removed either by the
outer dispatch task on each of its exits, or by the route close that aborted
that task.
Check: `always` — after a generation quiesces, assert `gen.pending` is empty.
`always` on an emptiness postcondition rather than `unreachable` on a leak site,
because a stranded entry is a forbidden *state* with no dedicated detection
point, which METHOD's first coverage rule assigns to `always(!X)`.
Fault/timing angle: `remove_pending` is called on all five outer-task exits
(`dispatch.rs:935`, `:958`, `:1059`, `:1066`). The abort case is covered by
`settle_route_work`'s explicit sweep of the keys it collected
(`:1332-1342`, removal at `:1374-1380`), whose comment states "Aborted tasks
never removed their own pending entries". `force_close_all_routes`
(`:1421-1452`) aborts the same tasks and performs **no** equivalent sweep.
Required faults and enabling state: A forced shutdown past the drain deadline
with requests in flight, so `force_close_all_routes` aborts outer tasks whose
keys no `settle_route_work` collected.
Confidence: medium — [evidence](evidence/req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close.md).
The sweep asymmetry is verified by reading both functions. What I could not
verify is whether the forced path is always followed by the whole
`GenerationCore` being dropped, which would make the leak unobservable; that
depends on `harness_closure.rs`, which is sub-part 2f.
Existing check: none.
Impact: Bounded by the pending-permit pool in the worst case, so this is not
unbounded growth. The consequence is a stale `PendingEntry` holding a
`CancellationToken` and an `Arc<Settlement>` for the remaining life of the
generation, which makes `handle_cancel` for that key a live no-op against an
already-dead task.
Open questions:
- Does the forced path always drop the `GenerationCore` immediately afterwards?
  `close_generation` removes the connection at `dispatch.rs:1409-1413`, but
  `force_close_all_routes` does not call it. (unresolved, needs sub-part 2f)

### req-a-three-control-rejection-paths-carry-three-different-bounds

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/routing.rs:212` and `:98` exercise the semantic
path. Part 2a holds `oversize-control-drain-work-is-bounded-without-ingress-budget`
for the oversize path. Nothing exercises all three under one saturation.
Guarantee: A channel-0 rejection is bounded by exactly one of three different
counters depending on why it was rejected, and only one of the three can prove
its terminal reached the peer.
Check: `always` — classify every channel-0 rejection emission by path and
assert the matching bound: semantic rejections by `pending_permits`, capacity
rejections and oversize rejections by the per-generation `busy_rejects` count of
32, and assert that only the oversize path attaches a `written` hook.
`always` because the classification holds on every rejection.
Fault/timing angle: The three paths are `emit_error_terminal` inside a
pending-permit-holding task (`connection.rs:638-655`), `emit_rejection`
(`connection.rs:625-635` and `dispatch.rs:613-641`), and
`emit_authoritative_rejection` (`connection.rs:430-450`,
`dispatch.rs:786-821`). Only the third carries `written_tx`, which the read
loop uses to fence exactly one authoritative frame past an otherwise silent
close (`connection.rs:391-400`).
Required faults and enabling state: Concurrent floods of malformed control
bodies, oversize control bodies, and requests past the pending-permit bound on
one generation.
Confidence: high — [evidence](evidence/req-a-three-control-rejection-paths-carry-three-different-bounds.md).
All three call sites and both bounding counters read; `MAX_INFLIGHT_BUSY_REJECTS`
confirmed as 32 at `connection.rs:42` and used at `:244`.
Existing check: `tests/routing.rs:98` `unsupported_operations_leave_the_generation_usable`,
`:212` `malformed_control_bodies_are_refused_before_handler_work`. Status
unaudited. Not in CI.
Impact: A semantic-rejection flood consumes the same global pool that funds real
requests, so malformed control traffic degrades application throughput on every
connection, while a capacity-rejection flood is contained per generation. The
two attack surfaces have different blast radii for the same client behaviour.
Open questions:
- Protocol §8.3 says a control request is "one consumer request against the
  global unsettled bound", which the semantic path honours. Is charging
  malformed traffic to the *global* pool rather than a per-generation one the
  intended reading? (needs human input)

### req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:1524` `diagnostic_limit_substitution_drops_retry_hint`
is an inline unit test covering `bounded_terminal_error` only, and inline
`mc-host` tests do not run in CI. The `BindOutcome::Reject` copy of the same
policy has no test.
Guarantee: Handler-authored error codes and messages are truncated-by-
substitution to at most 128 and 4,096 bytes before the terminal is held across
any await, on both the request-error and bind-rejection paths.
Check: `always` — assert that no `Terminal::Error` or bind rejection retained
across an await carries a code above 128 bytes or a message above 4,096, and
assert the two capping sites use identical limits. `always` because the cap is
applied on every handler-authored diagnostic.
Fault/timing angle: The window is the egress wait. `dispatch.rs:1045-1049`
states it: the handler task permit is already released when the outer task
holds the terminal, so an uncapped string would accumulate uncharged across up
to `max_pending_requests` settlements. `dispatch.rs:1206-1209` states the same
for up to `max_routes` concurrent binds.
Required faults and enabling state: A handler returning a multi-megabyte error
message, at pending-pool or route-pool saturation, with a slow-reading peer so
the terminals queue.
Confidence: high — [evidence](evidence/req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait.md).
Both capping sites read and their limits compared: same constants, different
substitute messages, and the bind path re-implements the comparison by hand
instead of calling `bounded_terminal_error`.
Existing check: `tests/dispatch.rs:1524` (inline, not in CI). Status unaudited.
Impact: Without the cap, `max_pending_requests` (1024) times an arbitrary
message is unbounded uncharged residency. With two hand-written copies of one
policy, a future limit change applied to one and missed in the other silently
reopens half of it.
Open questions: None.

### req-a-both-admission-classes-and-the-rejection-bound-saturate

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — `tests/dispatch.rs:295`, `:976`, and `:1074` saturate
pending capacity in both classes. Task-permit saturation and `busy_rejects`
saturation are constructed by no test.
Guarantee: A campaign reaches each of the five distinct saturation states this
layer can enter, so no admission bound is asserted only in theory.
Check: `sometimes` — at least once per campaign, observe each of: general
pending exhaustion, general task exhaustion, reserved pending exhaustion,
reserved task exhaustion, and per-generation `busy_rejects` exhaustion.
`sometimes` and not `reachable` because a campaign can execute the
`try_acquire_owned` error arm of one pool while never producing the operational
state of a saturated *task* pool or a saturated rejection counter, and those
are the states whose consequences differ.
Fault/timing angle: Task-permit exhaustion requires more than 256 concurrent
*executing* handlers, which is harder to reach than pending exhaustion because
the task permit releases on handler return.
`busy_rejects` exhaustion additionally requires contended egress so the 32
in-flight rejections do not drain.
Required faults and enabling state: A shrunk configuration (`max_handler_tasks`
and `max_pending_requests` lowered, as `tests/dispatch.rs:295` already does for
pending), a parked handler, a saturated egress budget, and a client pipelining
past each bound.
Confidence: high — [evidence](evidence/req-a-both-admission-classes-and-the-rejection-bound-saturate.md).
Enumerated the five `try_acquire_owned` sites and confirmed which existing tests
reach which.
Existing check: `tests/dispatch.rs:295`, `:976`, `:1074` for pending in both
classes. Status unaudited. Not in CI.
Impact: The reserved class exists specifically to survive general-load
saturation. If reserved *task* exhaustion is never constructed, the carve-out's
second half is unverified, and `runtime.rs:118-119`'s claim that the reserved
pools may be "unreachable" would go unchallenged even though Broca makes them
live.
Open questions: None.

## Contract-vs-code leads

Each cites both sides. None is resolved in the doc's favour.

1. **§9.1 names a deleted mechanism.** The doc states "Handler
   `Response(Vec<u8>)` becomes `Response`". The code's outcome is
   `RequestOutcome::Response { body: OutputBuffer, binary: bool }`
   (`handler.rs:224`), and `handler.rs:213-219` carries a `compile_fail`
   doctest whose whole purpose is to prove a `Vec<u8>` cannot be used, because
   output must be reserved through `RequestCtx::reserve_output` before
   allocation. The doc describes the pre-reservation API. First-class finding
   under the re-scope's rule about doc statements naming deleted mechanisms.
2. **§10.2 states `server_busy` proves no dispatch, unconditionally.** The row
   reads "yes; host proves no handler dispatch (limit exhaustion before
   dispatch, Section 8.3)". `dispatch.rs:629-639` shows the terminal is not
   emitted at all past the per-generation rejection bound, and the comment at
   `:634-636` concedes "The unemitted terminals become outcome_unknown". The
   proof the client is instructed to rely on is conditional on a counter the
   client cannot see.
3. **§12 step 1 and §8.3 do not name a code for `route.open` during shutdown.**
   §12 step 1 specifies `server_busy` for "a complete, valid routed `Request`";
   §8.3 reserves `target_unavailable` for "route admission — `route.open`
   failures such as channel exhaustion". Shutdown is not channel exhaustion,
   yet `dispatch.rs:1117` emits `target_unavailable` for it. Two doc sections
   jointly under-specify the case the code decides.
4. **§8.3 does not describe reserved-class admission for `route.open`.** It says
   "Every routed request draws both its pending and its task permit from the
   class stored on its installed route at bind time". `connection.rs:616-624`
   additionally routes a *reserved-target* `route.open` to
   `reserved_pending_permits`, with a deliberate comment at `:613-615`
   explaining that charging it to the general pool would make the carve-out
   unreachable under the saturation it exists to survive. The code's reasoning
   is sound; the doc does not cover it.
5. **§8.2's rejection arrow does not cover a bind panic.** The sequence diagram
   has exactly two bind outcomes, accepted and "else rejected → `H-->>C: Error
   corr=N`". `dispatch.rs:1164-1170` is a third outcome: the callback stopped
   without producing a `BindOutcome`, route-gone still runs exactly once, and
   **no** `Error` is emitted. §8.2's route-gone promise holds; its terminal
   promise does not.
6. **§11's request-deadline row is client-only, and the doc never says the host
   has none.** The table assigns "request | one caller-overridable 30 s
   absolute deadline" to managed clients. `config.rs:199-218` shows `HostTiming`
   carries no request field. §11's rule that "per-stage timers MUST NOT
   multiply" a single owning deadline arguably *requires* this, but the
   consequence — host handler-task capacity reclaimable only by handler
   cooperation or client action — is stated nowhere.
7. **§8.3's finite-limits sentence lists "queued requests" and "aggregate
   buffered bodies" as separate bounds.** In the code the unsettled bound
   (`pending_permits`) and the buffered-byte bound (`ingress_budget`,
   `egress_budget`, `scratch_budget`) are indeed separate, but the doc's
   "queued requests" has no distinct implementation: queue depth is
   `frame_channel`'s slot count, which §11 attributes to the client. Whether the
   host has a queued-request bound distinct from the pending bound is
   unresolved from this sub-part's files.

## Open questions

- Does any client treat a zero-length `Response` body as a protocol violation?
  If not, `req-a-a-handler-response-is-length-checked-and-never-content-checked`
  is an end-to-end silent-success path, not merely a host-side gap. Part 2d and
  Part 5 own the two client surfaces. (unresolved, needs a client-side check)
- Is per-connection handler-capacity fairness owned by any layer? All four
  admission pools here are host-global. (unresolved, needs sub-part 2f)
- Does the forced shutdown path drop the `GenerationCore` immediately after
  `force_close_all_routes`, making the un-swept pending entries unobservable?
  (unresolved, needs sub-part 2f's `harness_closure.rs`)
- Should routed terminals carry a write-completion hook so the host can
  distinguish attempted from acknowledged responses? The cost is one boxed
  closure per frame. (needs human input)
- `routing.rs:184` and `:441-452` enforce two registry invariants by panicking
  while holding the registry `Mutex`, which poisons it for the process. Every
  other registry method calls `.expect("registry lock")`, so a single violation
  converts into a panic on every subsequent route operation. Is that the
  intended failure mode, given `panic_boundary` exists to redact and contain
  handler panics but not host-internal ones? (needs human input)
- `dispatch.rs:770-779` spawns the shutdown-commit watchdog with a bare
  `tokio::spawn`, outside both `spawn_tracked` and `gen.read_tasks`. It is the
  only spawn in this sub-part the host's task tracker does not observe, so a
  shutdown can complete while it is live holding an `Arc<GenerationCore>`. Is
  that deliberate? (unresolved, needs the `run` teardown order from sub-part 2f)
