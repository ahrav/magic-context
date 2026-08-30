# Sub-part 2e property catalog: admission, dispatch, and the response obligation

Scope: what admits a request, what guarantees it gets a response, and what
happens when it does not. Five files, 4,546 lines, all re-derived with `wc -l`
at `HEAD`: `crates/mc-host/src/dispatch.rs` (1,539), `control.rs` (1,180),
`routing.rs` (833), `handler.rs` (604), `composite.rs` (390).

The production and test halves matter here, because the file that decides every
terminal is almost all production. `dispatch.rs` production occupies `1-1497`
and its `#[cfg(test)] mod tests` occupies `1498-1539`, which is 42 lines,
2.7 percent of the file. `control.rs` production is `1-709` and its tests
`710-1180`. `routing.rs` production is `1-453` and its tests `454-833`.
`handler.rs` and `composite.rs` have no test module at all.

Boundary context, read but not cataloged: `connection.rs` is Part 2a's file and
is cited as the caller boundary only, for `read_loop` (`:373`), the two
dispatch entry points (`:462`, `:467`), and the three rejection bounds.
`ring_transport.rs`, `wire.rs`, and `frame_channel.rs` are Part 2b's and are
cited for the publication contract only. `client.rs` is Part 2d's.
`runtime.rs` and `config.rs` are sub-part 2f's and are cited for pool
construction and the deadline vocabulary.

**This is a post-refactor surface.** The request path survived the refactor with
its comments intact, which is itself a finding: grepping all five files for
`tcp_frame_channel`, `transport_negotiation`, `transport_provider`,
`provider_recovery`, `frame_read`, `shm_provider`, `negotiate`, `Serveable`,
and `fallback` returns zero hits, so **no source comment in this sub-part
describes a deleted mechanism**. The path never named the transport it sat on.
Four commits carry the refactor:

| Commit | Subject |
| --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` |
| `d8bde128` | `feat(host): add authenticated ring setup socket` |
| `793a973e` | `build(shm): require packaged native transport` |
| `ed487e11` | `refactor(host): make ring transport mandatory` |

The one deleted-mechanism finding here is on the other side of the boundary, in
the normative document, and it is the sharpest disagreement in the sub-part:
see the fifth lead below.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`, confirmed with
`git log -1`. Both lens agents read and verified their line references at that
commit. Scope and CI findings come from
[../part-2-rescope/scope-map-and-risk-ranking.md](../part-2-rescope/scope-map-and-risk-ranking.md).

**Where lens B re-derived a citation lens A made, lens B's line numbers win.**
Four differences, all verified again by this synthesis by printing the lines,
and none changes a finding.

- Busy-reject exhaustion cancels at `dispatch.rs:637` and discards at `:638`.
  Lens A cited `:629` (the bound check) and `:638`. Both halves are real; the
  pair that produces the blast radius is `:637-638`, printed and confirmed as
  `gen.token.cancel();` then `gen.writer.discard();`.
- The `BindInstall::CloseWins` silent exit is `dispatch.rs:1195-1202` as a
  block, and the line that runs instead of a terminal is `:1199`
  (`run_route_gone`). Lens B's `:1199` is the precise site and is used below.
- `dispatch.rs` is 1,539 lines but decides every terminal in 1,497 production
  lines. Lens A cited the file total; lens B the production half. Both stated
  above.
- **Lens A's own heading count of CI-named test binaries is wrong and lens B
  corrects it.** Lens A's reachability evidence 3 says "Only two of this
  sub-part's five test binaries run in CI", and then its own body lists the
  CI-named binaries as `client`, `lifecycle`, `shm_failure_modes`, and
  `shm_soak`, none of which is a 2e binary. Lens B enumerates six binaries
  whose subject is the request path and finds **zero** named. Re-verified here:
  the 13 `mc-host` hits in `ci.yml` are `:87`, `:132`, `:133`, `:134`, `:168`,
  `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`, and `:461`, and none
  names `dispatch`, `routing`, `handler_contract`, `composite_routing`,
  `protocol_vectors`, or `broca_protocol`. Lens A's per-record
  `Existing check: ... Not in CI.` lines are correct; only its heading count was
  not.

## What this part is about

Six facts frame every record here. The first three are the reason this sub-part
was cataloged. The fourth is the bound that exists and the deadline that does
not. The fifth is a contract disagreement that a compiler enforces. The sixth is
the coverage position, which is the one place 2e beats both its siblings.

**An admitted routed request gets at most one terminal, not exactly one.** The
arbiter is sound: `Settlement` (`dispatch.rs:34-59`) is three fields, `won` is
mutated only by the `swap(true)` at `:408`, that swap happens under the async
`order` mutex (`:407-410`), and every emission site takes the same lock, so a
stream item can never follow a terminal and exactly one claimant wins among
handler completion, cancellation, route close, and generation teardown. What is
missing is the other half of exactly-once. **Five exits leave admitted work with
no terminal at all**, and each was verified individually.

1. `dispatch.rs:1058` — the non-panic join-error arm. `:1053` catches
   `join_err.is_panic()` and emits `internal_error`; the `Err(_)` arm at `:1058`
   removes the pending entry and returns. An aborted handler task settles
   nothing. Printed and confirmed as `Err(_) => { remove_pending(&gen_task,
   key); return; }`.
2. `dispatch.rs:637-638` — busy-reject exhaustion. Past the per-generation
   `MAX_INFLIGHT_BUSY_REJECTS` of 32 (`connection.rs:42`, used at `:244`) the
   code cancels the token and calls `gen.writer.discard()`, which drops **other
   correlations' already queued terminals**, not just the rejection that could
   not be emitted. This is the worst of the five by blast radius. The comment at
   `:630-636` argues the trade honestly and names the outcome, so it is a
   declared cost; nothing checks that the declared cost is the one that occurs.
3. `dispatch.rs:1164` — a bind callback that stopped, by panic, abort, or its
   own inner deadline. Route-gone still runs exactly once; no `Error` is
   emitted.
4. `dispatch.rs:1174` — a bind callback still executing at the lifecycle
   deadline. The fatal latch is already tripped, so the incarnation terminates
   and a terminal would be pointless.
5. `dispatch.rs:1199` — `BindInstall::CloseWins`, a close that raced the bind.
   Route-gone runs; no terminal.

Three of those five are `open_route` exits, out of seven total
(`dispatch.rs:1103-1239`), which makes the control path's worst case worse than
the routed path's. Protocol `:692` covers the retirement cases: "Any published
request lacking an observed terminal at close is `outcome_unknown`". It does not
cover `:1164`, `:1174`, or `:1199`, where the connection stays live and the
`route.open` correlation simply never settles until the caller's own 30-second
route deadline expires.

**A handler failure can reach the client as a success.** The whole success gate
for a unary response is `dispatch.rs:1031-1033`, printed and confirmed:

```
Ok(RequestOutcome::Response { body, binary })
    if body.len() <= crate::wire::MAX_BODY_LEN as usize => {
        Terminal::Response { body, binary }
    }
```

The predicate is an upper bound only, and `0 <= MAX_BODY_LEN` holds. A handler
that reserves output through `reserve_output` (`handler.rs:466`), fails partway,
and returns the buffer it never wrote into emits a **zero-length `Response`
terminal**. `OutputBuffer::len()` (`handler.rs:362-366`) returns the *declared*
`exact_len` for a direct output and the *written* length for an owned one, and
`extend_from_slice` and `resize` (`:381-396`) both refuse to grow past
`max_len` and both refuse outright when `direct.is_some()`, so a reserved and
unwritten buffer is a supported, silent state. The wire layer accepts the
result: `wire.rs:340` rejects a body only on a pure-header type
(`if ty.is_pure_header() && len != 0`, printed and confirmed), and `Response` is
not pure-header, so no lower bound on a declared `Response` length exists
anywhere in decode. The adjacent arms show the author reasoning carefully about
other shapes in the same match — `:1020` catches a unary response after
streaming, `:1035` catches an oversize body. Emptiness is the gap.

**This is the fourth part in this catalog to find an error path presenting to
its caller as a success, and it is worth saying plainly because the pattern is
now the catalog's most repeated finding.** Lens A records the ordinal and names
the two handler-side occurrences, Parts 4c and 4d, which found handlers
returning success without writing on the other side of this exact boundary; 2d
found the third shape, `host_shutdown` returning `Ok` on a JSON echo of its own
operation name. This synthesis verified the citation lens A makes for 4c and 4d
but did **not** re-derive the count across all parts, so the ordinal is
inherited and unconfirmed in the same way the lenses treat the
"fourth misleading comment" ordinal in `runtime.rs`. What is confirmed is the
mechanism at `:1031` and the wire layer's acceptance at `wire.rs:340`.

**Routed terminals carry no delivery acknowledgement, so acknowledged effects
are identically zero and only attempted are observable.** `settle` returns
`true` once `emit_reserved_frame` has *enqueued* the terminal
(`dispatch.rs:447-460`), and an `Err` from that call only cancels the generation
(`:458`). There is no ack frame, no write-completion callback, and no
per-correlation delivery record on the routed path. Only three emissions in the
whole sub-part carry a `written` hook, and all three are control or teardown
frames: `handle_host_shutdown` on both its paths (`:678-680`, `:743-756`),
`emit_authoritative_rejection` (`:814-816`), and `send_connection_goodbye`
(`:1474-1476`). Every routed terminal passes `written: None` (`:358`, and `:300`
when the caller supplies nothing).

The contrast inside the same file is what makes this a finding rather than an
observation: `dispatch.rs:646-651` describes the `CommitOnAck` hook where
"commit and host cancellation run inside the writer task at full-frame write
completion", and every earlier failure drops the hook unrun. The crate knows how
to condition an effect on delivery and does so for exactly one channel-0
operation. Per METHOD's effect-accounting rule the consequence is precise: on
the routed path the **acknowledged** count is identically zero, only
**attempted** is observable, per-identity oracles have no acknowledgement side
to use, and the `observed >= acknowledged` bound is vacuous here. Protocol
§10.1 makes an unobserved terminal `outcome_unknown` on the client side; the
host has no matching classification, so after a close the two ends cannot be
reconciled.

**Handler concurrency is bounded by four host-global semaphores with no
per-connection fairness, and no request deadline exists.** The four pools, with
construction at `runtime.rs:905-912` and defaults at `config.rs:131-132`:

| Bound | Value | Scope | Acquisition |
| --- | --- | --- | --- |
| `task_permits` | `max_handler_tasks` (default 256) minus reservations | host-global, general class | `try_acquire_owned` on the read loop |
| `reserved_task_permits` | 96 (Broca) | host-global, reserved class | same |
| `pending_permits` | `max_pending_requests` (default 1024) minus reservations | host-global, general class | same |
| `reserved_pending_permits` | 96 (Broca) | host-global, reserved class | same |

The acquisition discipline is the part that is unambiguously right and tested:
`try_acquire_owned` never waits, so the request is rejected pre-dispatch with
`server_busy` and zero handler invocation, and the comment at
`dispatch.rs:881-883` states the reason — acquiring inside the spawned task
would let a client pipeline unbounded tasks ahead of the gate
(`tests/dispatch.rs:295`, `:976`, `:1074`). The class comes from the route, not
the body: `route_tracker` returns `(TaskTracker, RouteClass)`
(`routing.rs:326-340`) and `dispatch.rs:873-879` selects the pool pair from it,
so the host never parses an application body to pick a class. The split into two
tasks per request is deliberate and load-bearing: the task permit lives in the
inner callback task (`:990`) so capacity frees the moment the handler returns,
while the pending permit lives in the outer settling task (`:933`) so it is held
across the egress wait.

What is absent is any bound on the handler itself. `HostTiming`
(`config.rs:199-218`) has seven fields and none of them bounds a request's
lifetime: `frame_deadline` bounds frames, `route_close_budget` applies only once
a close begins, and `lifecycle_callback_deadline` applies to `bind`,
`route_gone`, `initialize`, and `health`, never to `handle`. Protocol §11
assigns the 30-second request deadline to the *client*, so a client that dies
without sending `Cancel` leaves the host holding both permits indefinitely. And
because all four pools are host-global rather than per-generation, one
connection can consume every general slot: a module with a missing internal
timeout can hold all 256 general task permits, at which point every other
route's traffic gets `server_busy` while the host reports itself healthy.
Per-connection fairness is not a property of this layer, and lens A's own open
question records that no layer has been shown to supply it.

**A protocol statement names an API a `compile_fail` doctest now forbids.**
Protocol `:673` reads "Handler `Response(Vec<u8>)` becomes `Response`". The
current variant is `RequestOutcome::Response { body: OutputBuffer, binary }`
(`handler.rs:224`), `OutputBuffer`'s fields are all `pub(crate)` (`:332-335`),
and the doctest at `handler.rs:213-219` asserts that constructing
`RequestOutcome::Response { body: Vec::<u8>::new(), binary: false }` must fail
to compile. This is the sharpest disagreement in the sub-part because the two
sides are not merely unsynchronised, they are mechanically opposed: the document
describes a construction, and a check that **runs in CI** (`ci.yml:190`) fails
the build if that construction ever becomes possible. The mechanism the code
enforces is absent from the document — `OutputBuffer`, `reserve_output`, and
`output_from_writer` appear nowhere in `docs/mc-host-wire-protocol.md`, grepped,
zero hits.

Lens B established by history rather than inference that this is a deleted
mechanism and not one that never existed:
`git log -S'body: Vec<u8>,' -- crates/mc-host/src/handler.rs` returns `cf281ace`
(the commit that added `mc-host`) and `ef66e349`, and
`git log -S'```compile_fail' -- crates/mc-host/src/handler.rs` returns
`cf281ace` and `98b7270d`. The document line dates from `d0dbb25a` and has not
moved.

One residual of the opposite shape, recorded so a later pass does not miscount
it: the document names `McHandler` at nine sites (`:43`, `:292`, `:596`, `:600`,
`:626`, `:634`, `:685`, `:800`, `:906`) and no such type exists in this crate.
That is a **forward** reference, not a stale one — `handler.rs:3` says
`magic-context-c50.4` will adapt `McHandler` onto this boundary, while the code
carries the boundary that exists, `McHostHandler` (`:558`).

**Coverage: 37 in-crate and 84 integration tests, none CI-named, but 4
`compile_fail` doctests do run, so 2e owns 4 of the library's 6 CI-executed
source-resident checks.** The 37 in-crate tests are `control.rs` 23,
`routing.rs` 12, and `dispatch.rs` 2; `handler.rs` and `composite.rs` have
none. The 84 integration tests are spread over six binaries whose subject is
this sub-part — `tests/dispatch.rs` (20), `tests/composite_routing.rs` (16),
`tests/protocol_vectors.rs` (15), `tests/handler_contract.rs` (12),
`tests/routing.rs` (12), `tests/broca_protocol.rs` (9) — and CI names none of
them. So the sub-part is *well tested* and *barely gated*: 121 claim-bearing
tests, zero executed by CI.

The four doctests are the exception and they matter. All four are
`compile_fail`, all four are in `handler.rs`, and all four execute because
`handler.rs` is `pub mod` (`lib.rs:17`) and `ci.yml:190` runs
`cargo test -p mc-host --doc` under the step name "Rust lease non-escape",
printed and confirmed.

| Site | Forbids |
| --- | --- |
| `handler.rs:213-219` | `RequestOutcome::Response { body: Vec::<u8>::new(), .. }` |
| `handler.rs:425-427` | `ctx.corr` |
| `handler.rs:429-431` | `ctx.socket` |
| `handler.rs:433-435` | `ctx.credentials` |

Six compiled doctests exist in the whole `mc-host` library, all `compile_fail`:
these four plus `frame_channel.rs:296-301` and `:303-308`, which are 2b's and
are that sub-part's only CI-executed source-resident checks. 2d has none. So 2e
owns four of the six. The three `RequestCtx` doctests are weaker than the first
and worth separating: each asserts that a field name does not resolve, so a
field renamed rather than removed still fails them, which pins absence rather
than privacy. `handler.rs:213-219` is stronger, because `OutputBuffer`'s
`pub(crate)` fields make the failure a type error no rename can satisfy.

**Three quiet areas frame the fault map.** Stated here in full because each is
the gap between what the code decides and what any check proves, and all three
are carried in [existing-checks.md](existing-checks.md).

1. **`dispatch.rs` decides every terminal on 1,497 production lines and carries
   2 in-crate tests, both about length arithmetic.** Those 1,497 lines own
   `Settlement` (`:34`), `settle` (`:399`), `dispatch_request` (`:828`),
   `open_route` (`:1103`), `close_generation` (`:1394`),
   `force_close_all_routes` (`:1421`), and `handle_cancel` (`:1489`). The two
   tests at `:1502` and `:1524` cover `error_body_len` (`:115`). Neither runs in
   CI and neither touches a terminal. All five silent exits, the emptiness gap
   at `:1031`, and the missing acknowledgement at `:447-460` sit in the same
   file, so the three highest-consequence findings in this catalog all land
   where in-crate coverage is thinnest.
2. **The silent exits emit no terminal, no cause, and no counter.** At `:1058`,
   `:1164`, `:1174`, and `:1199` the code emits no frame, records no cause, and
   increments no metric; `remove_pending` (`:1097`) removes the entry and
   returns nothing. The comments at `:1162-1163` and `:1171-1173` argue each
   case correctly on ordering grounds, and the arguments are sound — running
   route-gone beside a still-executing bind would be worse than leaving the
   correlation unsettled. What is quiet is that the *chosen* outcome has no
   observation point: a caller learns only by its own deadline expiring, which
   is indistinguishable from a slow handler, and an operator learns nothing at
   all. `:637-638` compounds it by discarding unrelated queued terminals with
   the same absence of a counter. Contrast `ring_transport.rs:209-228`, which
   maintains four lifecycle counters for a strictly less consequential set of
   events.
3. **`routing.rs` holds 3 unconditional production panics under a
   process-global mutex with no poison recovery.** `:184`
   (`unreachable!("bind completion found route in {state:?}")`), `:446`
   (`panic!("{op}: registry lost route it owns")`), and the `assert_eq!` at
   `:447-450` all fire in release, all inside code holding the registry mutex,
   and the module doc at `:3-8` makes this registry the single owner of every
   route in the host. A panic there poisons the mutex, and unlike `client.rs`
   there is no `lock_unpoisoned` recovery: the next of 16 `.expect("registry
   lock")` sites converts one bad state transition into a cascade across every
   connection. `expect_occupant` (`:441`) is called on every occupant mutation,
   so it is the most-executed guard in the sub-part and the least
   characterised. Verified here by grep: `:184`, `:446`, and `:447` are the only
   panic-family sites in `routing.rs`'s production half, and `:506-507`'s two
   `panic!` calls are inside the test module.

## Reachability

**All fourteen records are `default-production`, and no record here is
`test-only` or `explicit-config-only`.** The label rests on three verified facts
rather than on a blanket preamble assertion, per METHOD rule 4.

1. **The routed request path is production.** The production binary is
   `crates/mc-module/src/bin/ck_mc_host/serve.rs`, which builds the composite at
   `:575` and calls `mc_host::run` at `:632`. Part 2b resolved the ring as
   `default-production` against three misleading signals, and `read_loop`
   (`connection.rs:373`) is the ring's only frame consumer, calling
   `dispatch_request` at `:467` and `handle_control` at `:462`.
2. **`RouteClass::Reserved` is production, not a test fixture.** The comment at
   `runtime.rs:118-119` claims the reserved pools are "Zero-permit when no
   module declared a reservation, and then unreachable because every route is
   general-class". That is not a reachability answer.
   `broca/mod.rs:164-177` declares `route_class: RouteClass::Reserved` with
   `RESERVED_PENDING_REQUESTS = 96` and `RESERVED_HANDLER_TASKS = 96`
   (`broca/config.rs:185`, `:188`), the comment at `broca/mod.rs:169-170` makes
   it deliberate and unconditional, and `serve.rs:575` composes that exact
   component. `RouteClass` is read back by dispatch to pick a permit pair
   (`handler.rs:60-64`), so reserved-class dispatch is a live path. Sub-part 2f
   reached the same verdict independently and cross-filed it as its lens B lead
   L2.
3. **Nothing in the five files is `cfg`-gated on the production path.** The
   sub-part's only `#[cfg(test)]` markers are the four module gates at
   `dispatch.rs:1498`, `routing.rs:435`, `:454`, `:477`, and `control.rs:710`,
   plus 2f's at `runtime.rs:1299` and `config.rs:463`. Sub-part 2f's
   construction conditionality map establishes independently that nothing in the
   host runtime is feature-gated or `cfg`-gated.

Two code points inside this `default-production` surface are entered only by a
failing host rather than by a configuration gate, and both are stated at the
record rather than relabelled: `dispatch.rs:1164` and `:1174`, whose enabling
state is the fatal latch inside `lifecycle_join` (`runtime.rs:186-207`).

## Index

Fourteen records, in the order lens A proposed them. Lens B proposed none by
design; it built the 20-claim register and the check inventory.

| Slug | Type | Confidence |
| --- | --- | --- |
| [req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame](#req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame) | safety | high |
| [req-a-a-routed-terminal-carries-no-delivery-acknowledgement](#req-a-a-routed-terminal-carries-no-delivery-acknowledgement) | safety | high |
| [req-a-a-response-publication-failure-never-reaches-the-settling-path](#req-a-a-response-publication-failure-never-reaches-the-settling-path) | safety | high |
| [req-a-a-handler-response-is-length-checked-and-never-content-checked](#req-a-a-handler-response-is-length-checked-and-never-content-checked) | safety | high |
| [req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired](#req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired) | safety | high |
| [req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining](#req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining) | safety | high |
| [req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes](#req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes) | safety | high |
| [req-a-a-handler-outliving-every-host-deadline-is-reached](#req-a-a-handler-outliving-every-host-deadline-is-reached) | reachability | high |
| [req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation](#req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation) | safety | high |
| [req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs](#req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs) | safety | high |
| [req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close](#req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close) | safety | medium |
| [req-a-three-control-rejection-paths-carry-three-different-bounds](#req-a-three-control-rejection-paths-carry-three-different-bounds) | safety | high |
| [req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait](#req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait) | safety | high |
| [req-a-both-admission-classes-and-the-rejection-bound-saturate](#req-a-both-admission-classes-and-the-rejection-bound-saturate) | reachability | high |

Semantics distribution: twelve `always`, two `sometimes`. No
`always-or-unreached`, no `reachable`, no `unreachable`. Type distribution:
twelve safety, two reachability, no liveness. Reachability distribution:
fourteen `default-production`. Confidence: thirteen high, one medium.

**The five group headings below are this synthesis's own**, chosen by shared
mechanism rather than by the order records were proposed. Grouping reorders the
records relative to the index; the index is the record-order artifact. Record
bodies are verbatim from lens A. Two formatting-only changes were applied
uniformly: fields are wrapped to about 80 columns, and evidence links are
rewritten from the lens file's relative form to `evidence/<slug>.md` so they
resolve from this directory. No wording was changed.

---

## Group A: the arbiter that holds

Two records that currently hold, and both are premises rather than findings.
The first is the exactly-one-claimant guarantee that `Settlement` provides, and
the second is that no emission reaches a retired generation or an
already-settled correlation. They are grouped because both are proved by the
same discipline: the `won.swap` under the async `order` mutex
(`dispatch.rs:407-410`) plus the unconditional recheck of
`gen.writer.is_retired() || gen.token.is_cancelled()` at each of the four
emission entry points. Both are stated so that a regression has something to
violate.

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

---

## Group B: exits that answer nothing

Three records on the missing half of exactly-once. The first is the disjunction
the pre-dispatch rejection path actually offers: emitted, or the generation is
retired with every other correlation's queued frames discarded. The second is
the three `open_route` exits that emit nothing on a connection that may stay
live. The third is the pending-entry sweep that `settle_route_work` performs and
`force_close_all_routes` does not. Grouped because all three are consequences of
choosing an ordering-safe silence over a terminal, and because in every case the
chosen outcome has no observation point.

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

> Synthesis note on this record's open question, carried here rather than edited
> into it. Sub-part 2f's construction conditionality map answers the adjacent
> question and not this one. 2f establishes that `shutdown_sequence`
> (`runtime.rs:936`) calls `force_close_all_routes` twice (`:1206`, `:1216`)
> with no enclosing timeout, and that `run` returns after
> `run_handler_shutdown` (`:1240`). It does **not** establish that the
> `GenerationCore` is dropped at either call site, because the connections map
> is cleared elsewhere. So the record's `medium` confidence and its open
> question both stand, and the question is now known to be answerable only from
> 2f's `runtime.rs:1144-1244`, not from `harness_closure.rs` as lens A guessed.

---

## Group C: a terminal that proves nothing

Three records on what a routed terminal does and does not establish. The first
is that it carries no delivery acknowledgement at all, so the host's
acknowledged effect count is identically zero. The second is that a publication
failure lands after the settling path has already returned success, so the host
believes the request was answered while the client believes nothing was. The
third is that the success gate checks only that the body fits, so a handler
failure can arrive as an empty success. Grouped because all three are about the
distance between "settled" and "answered", and because together they mean the
host's own record of a request's outcome cannot be reconciled with the client's.

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

---

## Group D: admission bounds and the deadline that does not exist

Three records on capacity. The first states the bound that exists and is
correctly acquired before any spawn, along with the fact that all four pools are
host-global. The second is the reachability of a handler outliving every
deadline the host configures, which is what makes the first bound reclaimable
only by handler cooperation. The third is the reachability of all five
saturation states, because a bound asserted only in theory is not a bound.
Grouped because the first is the premise the other two test, and because the
reserved carve-out's whole purpose is to survive the states the third record
must construct.

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

> Synthesis note resolving this record's open question, carried here rather than
> edited into it. **No layer supplies per-connection handler-capacity
> fairness.** Sub-part 2f enumerated every field of `HostLimits`, `HostTiming`,
> `LivenessPolicy`, `HostInit`, and `HostConfig` against its consumers, 21 keys
> in total, and the only per-connection capacity key is `writer_queue_frames`
> (`config.rs:141`, consumed at `connection.rs:145`), which bounds one
> generation's writer queue depth and not its dispatch share. `max_connections`
> (`config.rs:129`) bounds connection count at `runtime.rs:872` and `:914`. All
> four admission pools are constructed once at `runtime.rs:905-912` and stored
> on `HostShared`, which 2f establishes is frozen for the incarnation. So the
> record's `Impact:` sentence "if it is required, it is required somewhere else
> and nothing here supplies it" is now confirmed for the whole host, not merely
> for this layer.

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

---

## Group E: rejection, three shapes and three bounds

Three records on the fact that rejection is not uniform. The first is that one
shutdown condition evaluated at two call sites answers with two codes carrying
two different client retry rules. The second is that a channel-0 rejection is
bounded by one of three different counters depending on why it was rejected, and
only one of the three can prove its terminal reached the peer. The third is the
one policy in this area that is applied correctly and is applied twice by hand.
Grouped because all three are about the vocabulary and the accounting of saying
no, which the routed and control chains do differently at every level.

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

---

## Relationship map

Grouped by shared mechanism rather than by the headings above, because the
sharpest relationships cross groups. **Every dominance statement below is a
hypothesis** about which oracle subsumes which, offered to order the work, not a
verified claim. None has been tested, and none can be tested by anything CI runs
today: the four `compile_fail` doctests are this sub-part's only CI-executed
checks, and they bear on the handler API surface rather than on any record here.

- **One settlement primitive, read from four sides.**
  [req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame](#req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame),
  [req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation](#req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation),
  [req-a-a-routed-terminal-carries-no-delivery-acknowledgement](#req-a-a-routed-terminal-carries-no-delivery-acknowledgement),
  [req-a-a-response-publication-failure-never-reaches-the-settling-path](#req-a-a-response-publication-failure-never-reaches-the-settling-path).
  All four turn on what `won` means. The first two say it is a sound arbiter of
  *who* emits; the last two say it is silent about *whether the bytes left*.
  Hypothesis: one trace that records, per correlation, the `won` transition, the
  frame the winner enqueued, and the writer's own publication result
  *dominates all four*, because each of their oracles is a projection of that
  same trace. Nothing dominates them pairwise: adding a `written` hook to routed
  terminals would dominate the acknowledgement record and give the
  publication-failure record its missing evidence, but it says nothing about
  arbitration, and strengthening the arbiter says nothing about delivery. This
  is the argument for building the trace once rather than four fixtures.
- **Five silent exits, one missing observation point.**
  [req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired](#req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired),
  [req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining](#req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining),
  [req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close](#req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close).
  These three cover four of the five exits between them: `:637-638` for the
  first, `:1164`, `:1174`, and `:1199` for the second, and the abort that
  produces `:1058` for the third. Hypothesis: a per-exit counter or marker,
  incremented at each of the five sites, *dominates* the reachability half of
  all three, because every one of their oracles begins with "observe that this
  exit was taken". It dominates none of their safety halves: a counter at
  `:637-638` does not tell you which other correlations' frames the `discard()`
  dropped, a counter at `:1199` does not tell you whether the connection stayed
  live afterwards, and a counter at `:1058` does not tell you whether the
  pending entry was swept. Those three questions need three different oracles,
  which is why the pending-entry record is the only `medium` in the catalog.
- **Two hand-written copies of one policy.**
  [req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait](#req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait),
  [req-a-a-handler-response-is-length-checked-and-never-content-checked](#req-a-a-handler-response-is-length-checked-and-never-content-checked).
  Both are about what the dispatch layer checks in a handler's own output.
  `bounded_terminal_error` (`dispatch.rs:82`) is applied to error diagnostics at
  `:1045-1049` and re-implemented by hand at `:1206-1218`, while the success
  path at `:1031` applies one upper bound and nothing else. Hypothesis: a single
  `validate_handler_outcome` funnel consulted by all three sites *dominates the
  diagnostics record by construction*, since the two copies could not drift, and
  *dominates the emptiness record not at all*, because whether an empty body is
  a failure is a contract question no refactor answers. Lens B's open question
  says the same thing from the other direction: `handler.rs:220-235` does not
  state the intent.
- **One shutdown condition, two vocabularies, three bounds.**
  [req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes](#req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes),
  [req-a-three-control-rejection-paths-carry-three-different-bounds](#req-a-three-control-rejection-paths-carry-three-different-bounds).
  The first is about which code a rejection carries, the second about which
  counter bounds its emission and whether delivery can be proved. Hypothesis:
  an oracle that classifies every rejection by (cause, code, bounding counter,
  `written` hook present) *dominates both*, because both records are readings of
  the same four-tuple. Neither dominates the other: unifying the two codes would
  leave the three bounds untouched, and unifying the three bounds would leave
  the code divergence untouched. Note that only the oversize path can be proved
  delivered, which ties this cluster back to the acknowledgement record above.
- **The bound and the two states that test it.**
  [req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs](#req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs),
  [req-a-a-handler-outliving-every-host-deadline-is-reached](#req-a-a-handler-outliving-every-host-deadline-is-reached),
  [req-a-both-admission-classes-and-the-rejection-bound-saturate](#req-a-both-admission-classes-and-the-rejection-bound-saturate).
  Hypothesis: the saturation record's five-state campaign *dominates* the
  permit-pair record's oracle, because a campaign that reaches all five
  saturation states has necessarily observed both bounds binding in both
  classes. It does **not** dominate the parked-handler record, which is a claim
  about *duration* rather than about *count*: a campaign can saturate every pool
  with fast handlers and never produce a handler that outlives
  `lifecycle_callback_deadline`. Conversely the parked-handler state is the
  cheapest way to reach task saturation, since `tests/dispatch.rs:295` already
  parks a handler, so the two are cheapest to build together even though neither
  dominates the other.
