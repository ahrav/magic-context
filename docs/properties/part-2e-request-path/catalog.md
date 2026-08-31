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
handler completion, cancellation, route close, and generation teardown. The whole
arbiter is `settle` at `:399-500`, and its first two statements are the lock and
the swap. What is missing is the other half of exactly-once. **Five exits leave
work with no terminal at all.** Each was verified individually, and **this
disposition classified them, because they are not all about the same thing and the
original list read as though they were.** Exactly one concerns an admitted routed
request's settlement; one is pre-dispatch, before any settlement exists; and three
are control-channel `route.open` exits.

1. `dispatch.rs:1058` — the non-panic join-error arm, and **the only one of the
   five about admitted routed settlement**. `:1053` catches
   `join_err.is_panic()` and emits `internal_error`; the `Err(_)` arm at `:1058`
   removes the pending entry and returns *before* the `settle` call at `:1063`,
   so an aborted handler task settles nothing. Printed and confirmed as
   `Err(_) => { remove_pending(&gen_task, key); return; }`. **No record in this
   catalog asserts the silence here.** The pending-entry record covers the
   `remove_pending` at `:1059`, which is the entry's removal, not the missing
   terminal; see the gaps queued in
   [portfolio-evaluation.md](portfolio-evaluation.md).
2. `dispatch.rs:637-638` — busy-reject exhaustion, which is **pre-dispatch**: the
   rejection never became an admitted request and no `Settlement` exists for it.
   Past the per-generation `MAX_INFLIGHT_BUSY_REJECTS` of 32
   (`connection.rs:42`, used at `:244`) the code cancels the token and calls
   `gen.writer.discard()`, which drops **other correlations' already queued
   terminals**, not just the rejection that could not be emitted. This is the
   worst of the five by blast radius, and its blast radius is precisely the reason
   it is not confined to the pre-dispatch request that triggered it. The comment
   at `:630-636` argues the trade honestly and names the outcome, so it is a
   declared cost; nothing checks that the declared cost is the one that occurs.
3. `dispatch.rs:1164` — **a control `route.open` exit**: a bind callback that
   stopped, by panic, abort, or its own inner deadline. Route-gone still runs
   exactly once; no `Error` is emitted.
4. `dispatch.rs:1174` — **a control `route.open` exit**: a bind callback still
   executing at the lifecycle deadline. The fatal latch is already tripped, so
   the incarnation terminates and a terminal would be pointless.
5. `dispatch.rs:1199` — **a control `route.open` exit**: `BindInstall::CloseWins`,
   a close that raced the bind. Route-gone runs; no terminal.

So the at-most-one guarantee is satisfied by all five, each by emitting zero, but
they do not share a subject. Three of the five are `open_route` exits, out of
seven total (`dispatch.rs:1103-1239`), which makes the control path's worst case
worse than the routed path's. Protocol `:692` covers the retirement cases: "Any
published request lacking an observed terminal at close is `outcome_unknown`". It
does not cover `:1164`, `:1174`, or `:1199`, where the connection stays live and
the `route.open` correlation simply never settles until the caller's own
30-second route deadline expires.

**An empty success is accepted end to end, and nothing below dispatch can reject
it.** The whole success gate for a unary response is `dispatch.rs:1031-1033`,
printed and confirmed:

```
Ok(RequestOutcome::Response { body, binary })
    if body.len() <= crate::wire::MAX_BODY_LEN as usize => {
        Terminal::Response { body, binary }
    }
```

The predicate is an upper bound only, and `0 <= MAX_BODY_LEN` holds. A handler
that reserves **owned** output through `reserve_output` (`handler.rs:466`), fails
partway, and returns the buffer it never wrote into emits a **zero-length
`Response` terminal**. `OutputBuffer::len()` (`handler.rs:361-366`) returns the
*written* `body.len()` for an owned buffer and the *declared* `direct.len` for a
direct one, and `extend_from_slice` and `resize` (`:381-396`) both refuse to grow
past `max_len` and both refuse outright when `direct.is_some()`, so a reserved and
unwritten owned buffer is a supported, silent state. The wire layer accepts the
result: `wire.rs:340` rejects a body only on a pure-header type
(`if ty.is_pure_header() && len != 0`, printed and confirmed), and `Response` is
not pure-header (`:86-88`), so no lower bound on a declared `Response` length
exists anywhere in decode. Neither does the Rust client impose one:
`validate_inbound`'s `Response | Error` arm (`client.rs:2022-2031`) checks
`corr != 0` and the binary-flag-on-channel-0 rule and nothing about length. The
adjacent arms show the author reasoning carefully about other shapes in the same
match — `:1020` catches a unary response after streaming, `:1035` catches an
oversize body. Emptiness is the gap.

**Two scope corrections, both applied during disposition.** First, this is
*empty-response acceptance*, not a handler failure presenting as a success. The
handler that returns `RequestOutcome::Response` has explicitly selected the
variant `handler.rs:220-225` documents as "Unary success"; nothing in the
observable state says a failure occurred, so calling it an error path is not
established, and whether an empty `Response` is a defect at all is an open
question this catalog cannot settle. Second, the *direct*-output form is not part
of this gap: a declared `exact_len` that the serializer never satisfies is caught,
at publication rather than at the gate, with `ProducerError::Underfill` — which is
[req-a-a-response-publication-failure-never-reaches-the-settling-path](#req-a-a-response-publication-failure-never-reaches-the-settling-path)'s
subject. The owned path is the one where declared and written are the same field
and zero is legal.

**Cross-part note, replacing an unverified ordinal.** The original text called
this "the fourth part in this catalog to find an error path presenting to its
caller as a success" and conceded in the same paragraph that the count was
inherited and never re-derived. The ordinal is **removed** rather than confirmed,
for three reasons. METHOD rule 2 forbids clearing an open question by assertion,
and the catalog had already marked this one unverified. After the narrowing above,
the 2e instance is not an error path at all, so it cannot be the fourth of
anything. And the sites the ordinal grouped do not share an oracle: Part 4c's and
4d's are write paths that report success without persisting, whose oracle is to
re-read the store after a successful response; 2d's `host_shutdown` accepts a JSON
echo of its own operation name, whose oracle is to keep serving after answering
and show the caller's next call succeeds; and this one is an empty body that every
layer accepts, whose oracle is a census of the gate. Part 4c's own disposition
made exactly this correction one layer up, removing a third site from an
equivalence for having a different oracle. Three mechanisms with three oracles are
worth a reader's attention as a recurring *shape*; they are not worth a count, and
a count is what made the claim unverifiable.

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
describes a construction, and a check that **runs in CI** (`ci.yml:175`) fails
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

**One correction to that framing, applied during disposition, and it is the only
CI-executed check on any record in this catalog.** "Zero executed by CI" is true
of the 121 tests in the five source files and six subject binaries. It is not true
of this sub-part's *record coverage*, because one record is asserted exactly by a
test in a binary CI does name.
`tests/lifecycle.rs:570-651` `shutdown_refuses_new_routes_and_new_routed_work`
drives a `route.open` and a routed request into one draining host and asserts
`target_unavailable` and `server_busy` respectively, which is
[req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes](#req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes)
in full; `lifecycle` runs at `ci.yml:168-169` on Linux. The former macOS run of
the same pair was removed with every other macOS job by PR #131 (merge
`5d638e3e8`); `ci.yml` at HEAD contains only `ubuntu-latest` jobs. The
binary was excluded from the six because its *subject* is the host lifecycle
rather than the request path, which is a defensible scope call and is exactly how
the check went uncredited. Counting by binary subject rather than by assertion is
what produced the error.

The four doctests are the exception and they matter. All four are
`compile_fail`, all four are in `handler.rs`, and all four execute because
`handler.rs` is `pub mod` (`lib.rs:17`) and `ci.yml:175` runs
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

**The two records carried in later, in
[Group F](#group-f-composite-route-ownership-and-panic-containment), are also
`default-production`, and their label was verified at carry time rather than
inherited from this section.** Fact 1 above already establishes the routed path;
what those two additionally need is that the composite itself is on it, and it is:
`serve.rs:575` constructs `StaticComposite::new(...)` and `:632` passes that value
to `mc_host::run`, both re-printed at carry time. `composite.rs` contains **zero
`#[cfg]` attributes** of any kind, which is the strongest form of the claim
available for one file and is consistent with the inventory's note that the file
has no test module. So all sixteen records in this sub-part are
`default-production`, and none is `test-only` or `explicit-config-only`.

## Index

Fourteen records from this sub-part's own lens passes, in the order lens A
proposed them. Lens B proposed none by design; it built the 20-claim register and
the check inventory. **Two further records were carried into this sub-part in a
later pass**, from the superseded pre-refactor `part-2b-wire-and-channels`; they
are the last two rows and they live in
[Group F](#group-f-composite-route-ownership-and-panic-containment). Sixteen
records in total.

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
| [composite-route-entry-is-removed-by-exactly-one-route-gone](#composite-route-entry-is-removed-by-exactly-one-route-gone) | safety | high |
| [composite-panic-containment-covers-only-optional-health-and-shutdown](#composite-panic-containment-covers-only-optional-health-and-shutdown) | safety | high |

The last two rows are the carried records. They keep their original unprefixed
slugs so the carry stays visible against the fourteen `req-a-` records this
sub-part derived itself.

Semantics distribution: twelve `always`, two `sometimes`. No
`always-or-unreached`, no `reachable`, no `unreachable`. Type distribution:
twelve safety, two reachability, no liveness. Reachability distribution:
fourteen `default-production`. Confidence: thirteen high, one medium.

The two carried records add **2 safety** and semantics **2 `always`**, both
`default-production` and both high confidence, so the sixteen-record totals are
**fourteen safety, two reachability, no liveness**; semantics **fourteen
`always`, two `sometimes`**; reachability **sixteen `default-production`**; and
confidence **fifteen high, one medium**.

**The five group headings below are this synthesis's own**, chosen by shared
mechanism rather than by the order records were proposed. Grouping reorders the
records relative to the index; the index is the record-order artifact. Record
bodies are verbatim from lens A. Two formatting-only changes were applied
uniformly: fields are wrapped to about 80 columns, and evidence links are
rewritten from the lens file's relative form to `evidence/<slug>.md` so they
resolve from this directory. No wording was changed.

A sixth group,
[Group F](#group-f-composite-route-ownership-and-panic-containment), was appended
in a later pass for the two carried records. It sits after the relationship map
rather than in sequence with the five, for the reason given in its preamble.

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
Exercised: not yet — no test inspects `gen.pending` after a forced close.
Guarantee: Every entry inserted into `gen.pending` is removed either by the
outer dispatch task on each of its exits, or by the route close that aborted
that task.
Check: `always` — after a generation quiesces, assert `gen.pending` is empty.
`always` on an emptiness postcondition rather than `unreachable` on a leak site,
because a stranded entry is a forbidden *state* with no dedicated detection point,
which METHOD's first coverage rule assigns to `always(!X)`.
Fault/timing angle: `remove_pending` is called on all five outer-task exits
(`dispatch.rs:935`, `:958`, `:1059`, `:1066`). The abort case is covered by
`settle_route_work`'s explicit sweep of the keys it collected
(`:1332-1342`, removal at `:1374-1380`), whose comment states "Aborted tasks
never removed their own pending entries". `force_close_all_routes`
(`:1421-1452`) aborts the same tasks and performs **no** equivalent sweep.
Required faults and enabling state: A forced shutdown past the drain deadline
with requests in flight, so `force_close_all_routes` aborts outer tasks whose
keys no `settle_route_work` collected. **Placement constraint, established during
disposition:** the oracle must live in-crate. `mod connection` is private
(`lib.rs:24`), so no integration test can name `GenerationCore`, but `pending` is
`pub` on it (`connection.rs:95`) and therefore directly readable and insertable
from any in-crate test.
Confidence: medium — [evidence](evidence/req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close.md).
The sweep asymmetry is verified by reading both functions. What I could not
verify is whether the forced path is always followed by the whole
`GenerationCore` being dropped, which would make the leak unobservable; that
depends on `runtime.rs:1144-1244`, which is sub-part 2f. **One premise of the
original record was wrong and is corrected here: the map is not unobservable.**
The claim that "the map is private to the crate" and that "no in-crate test
constructs a `GenerationCore`" is false on the second half.
`connection.rs:946-963` (`shutdown_registration_rejection_leaves_no_graceful_drain_work`)
constructs a complete `GenerationCore` today, all eleven fields, using
`frame_sender` for the writer, and asserts against it. So the postcondition is
assertable; what it costs is placing the oracle in a lane CI does not run, which
is a trade rather than a block.
Existing check: none for this record's postcondition.
`connection.rs:946-963` is not a check of it — it constructs a `GenerationCore`
for an unrelated claim — but it is the construction proof this record's oracle
needs. Status `unaudited`.
Impact: Bounded by the pending-permit pool in the worst case, so this is not
unbounded growth. The consequence is a stale `PendingEntry` holding a
`CancellationToken` and an `Arc<Settlement>` for the remaining life of the
generation, which makes `handle_cancel` for that key a live no-op against an
already-dead task.
Open questions:
- Does the forced path always drop the `GenerationCore` immediately afterwards?
  `close_generation` removes the connection at `dispatch.rs:1409-1413`, but
  `force_close_all_routes` does not call it. (unresolved, needs sub-part 2f)
- Should the oracle be an in-crate test that reads `pending` directly, or should
  a test-only accessor expose it so the integration binaries CI might one day run
  can assert it? The first is free and runs nowhere; the second is a production
  edit. (needs human input)

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
third is that the success gate checks only that the body fits, so a zero-length
`Response` is accepted by every layer from the gate to the client. Grouped
because all three are about the distance between "settled" and "answered", and
because together they mean the host's own record of a request's outcome cannot be
reconciled with the client's. The third record's original framing — a handler
*failure* arriving as a success — was narrowed during disposition to
empty-response acceptance; see its `Confidence:` line.

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
No test constructs a handler that reserves owned output and returns `Response`
without writing.
Guarantee: The dispatch layer validates a handler `Response` against the frame
size ceiling and nothing else, so a handler that reserved owned output and wrote
nothing produces a well-formed zero-length `Response` terminal that every layer
below accepts.
Check: `always` — for every `RequestOutcome::Response` accepted at
`dispatch.rs:1031`, the only predicate applied is
`body.len() <= MAX_BODY_LEN`; assert there is no lower-bound, emptiness, or
declared-versus-written comparison anywhere on the path to
`emit_reserved_frame`. `always` because the check runs on every unary success.
Fault/timing angle: None. This is a static gap in the guard, not a race.
Required faults and enabling state: A handler that reserves an **owned**
`OutputBuffer` through `reserve_output`, takes an early return without writing,
and still returns `RequestOutcome::Response`. The owned path is the whole record:
`OutputBuffer::len()` (`handler.rs:361-366`) returns the *written* `body.len()`
for an owned buffer and the *declared* `direct.len` for a direct one, so only the
owned shape reaches `:1031` reporting zero.
Confidence: high — [evidence](evidence/req-a-a-handler-response-is-length-checked-and-never-content-checked.md).
**Narrowed during disposition, and the narrowing changed what the record claims.**
What is verified is that an **empty success is accepted end to end**, at five
independent points: an owned reservation starts empty
(`dispatch.rs:537-542`, `Vec::with_capacity` with no writes), `len()` reports the
written length for it (`handler.rs:361-366`), the gate accepts zero
(`dispatch.rs:1031-1034`), `Response` is not a pure-header type so decode rejects
a body only for `Cancel`/`Ping`/`Pong`/`Goodbye` (`wire.rs:48-88`, rule at
`:340-342`), and the Rust client's `validate_inbound` imposes no minimum on a
`Response` (`client.rs:2022-2031`, which checks only `corr != 0` and the
binary-flag-on-channel-0 rule). What is **not** established is that this is a
handler *failure* surfacing as a success: the handler explicitly returned the
variant `handler.rs:220-225` documents as "Unary success", so nothing in the
observable state distinguishes a failed reservation from a deliberate empty
result. That question is upstream of the record and is referred to a human.
Existing check: `tests/dispatch.rs:665` for the ceiling. Status unaudited. Not
in CI.
Impact: An empty `Response` is indistinguishable from a legitimately empty result
at every layer that could reject it, so a handler that abandons its output
mid-request and still reports success is invisible. The severity depends entirely
on whether an empty `Response` is a supported outcome, which nothing states.
Note what this record does **not** cover after narrowing: the *direct*-output
underfill, where a declared `exact_len` is never satisfied, is caught — it fails
at publication with `ProducerError::Underfill` rather than at this gate, which is
[req-a-a-response-publication-failure-never-reaches-the-settling-path](#req-a-a-response-publication-failure-never-reaches-the-settling-path)'s
territory. The gap here is specifically the owned path, where declared and written
are the same field and zero is legal.
Open questions:
- Is a zero-length `Response` a defect or a supported outcome?
  `handler.rs:220-235` does not state the intent, and
  `OutputBuffer::is_empty()` (`:368-370`) exists as public API, which weakly
  suggests emptiness is a state callers are expected to reason about rather than
  an error. Settling this decides whether this record is a missing guard or a
  documentation gap. (needs human input)
- Does any client treat an empty-body `Response` as a protocol violation? The
  Rust client does not (`client.rs:2022-2031`, verified). The TypeScript peer is
  Part 5's surface. (unresolved, needs a Part 5 check)

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
Exercised: yes — `tests/lifecycle.rs:570` (re-located at HEAD)
`shutdown_refuses_new_routes_and_new_routed_work` asserts both codes against one
draining host, and `lifecycle` is CI-executed on Linux (`ci.yml:168-169`);
`ci.yml` has no macOS jobs after PR #131 (merge `5d638e3e8`)
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
Existing check: **corrected during disposition from "none".**
`tests/lifecycle.rs:570-651` `shutdown_refuses_new_routes_and_new_routed_work`
asserts this property exactly and in the record's own shape: it holds a drain open
with a parked handler (`:584-600`), spawns the shutdown (`:605`), waits for the
publication to be unlinked (`:608-615`), then sends a `route.open` and asserts
`open_error.error_code() == "target_unavailable"` (`:620-632`) and sends a routed
request on the still-live route and asserts
`request_error.error_code() == "server_busy"` (`:634-651`). Both codes, one
draining host, one test. Status `unaudited`. **In CI**, unlike every other check
this catalog cites: `ci.yml:168-169` runs `--test client --test lifecycle` on
Linux. The former macOS run of the same pair was removed by PR #131 (merge
`5d638e3e8`), which left `ci.yml` Linux-only.
Impact: Protocol §10.2 tells a client to retry `target_unavailable` "with new
correlation under bounded route deadline" and `server_busy` "with backoff". A
draining host therefore invites un-backed-off `route.open` retries from exactly
the clients it is trying to shed, while backing off their routed traffic. The
divergence is not merely unchecked, it is **pinned by a CI-executed test**, so it
is current intended behaviour unless someone changes both the code and that test.
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
verified claim. None has been tested. **Corrected during disposition: one record
is CI-tested, though no dominance statement is.** The four `compile_fail` doctests
bear on the handler API surface rather than on any record here, but
`tests/lifecycle.rs:570-651` asserts the divergent-codes record exactly and runs
at `ci.yml:178-179` and `:187`. That record appears in the fourth cluster below,
and its presence there is the only place a hypothesis could be checked against
something CI executes today.

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
  first, and `:1164`, `:1174`, and `:1199` for the second. **The third does not
  cover `:1058`, and the original text said it did.** It cites `:1059`, the
  `remove_pending` on the same match arm, which is the pending entry's removal
  rather than the absent terminal; `:1058` returns before `settle` at `:1063`, and
  it is the only one of the five silent exits that concerns an admitted routed
  request's settlement. Nothing here asserts that silence, which is a queued gap.
  Hypothesis: a per-exit counter or marker, incremented at each of the five sites,
  *dominates* the reachability half of all three, because every one of their
  oracles begins with "observe that this exit was taken". It dominates none of
  their safety halves: a counter at `:637-638` does not tell you which other
  correlations' frames the `discard()` dropped, a counter at `:1199` does not tell
  you whether the connection stayed live afterwards, and a counter at `:1058` does
  not tell you whether the pending entry was swept. Those three questions need
  three different oracles, which is why the pending-entry record is the only
  `medium` in the catalog.
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

---

## Group F: composite route ownership and panic containment

Two records on `crates/mc-host/src/composite.rs`, the static three-child
composition every production host runs. **Both were carried into this sub-part
from the superseded pre-refactor sub-part `part-2b-wire-and-channels`**, where
they were records 10 and 11 of `_lenses/lens-c-negotiation-provider.md`. See
[../part-2b-wire-and-channels/README.md](../part-2b-wire-and-channels/README.md)
for that directory's disposition.

They were orphaned rather than retired, and the mechanism was a route that was
recorded and then not walked. The re-scope retired the `wire-and-channels` label,
moved `composite.rs` into this sub-part's scope, and named carrying these two
forward as one of this sub-part's three attention focuses. That did not happen.
This sub-part's two lens passes went to dispatch, control decode, routing and
handler concurrency: all fourteen records above carry the `req-a-` prefix, and
neither composite property appears among them. `composite.rs` appears in the rest
of this catalog only in the scope sentence and in two test-inventory notes
recording that the file has no test module of its own. So the scope moved, the
absorbing sub-part's lenses did not re-derive these properties, and the two sat
uncovered.

**This group sits after the relationship map because it was carried in a later
pass, and the relationship map above does not cover it.** No dominance relation
is claimed between these two and the fourteen. One relationship is worth stating
and is not a dominance claim: the first record's subject is the route map that
`handle` consults, and `handle` is the composite's leg of the same dispatch path
[req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame](#req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame)
governs one layer up. A leaked map entry does not break that record's
at-most-one guarantee; it routes a *reused* handle to a stale child, which is a
different failure with the same input.

**Why these two were the cheapest salvage in that directory.** `composite.rs` is
byte-identical between the lens-era commit and `HEAD`: `git rev-parse` returns
blob `6858246d` for `crates/mc-host/src/composite.rs` at `1c193ae0`, `793a973e`
and `e447c927` alike, and `wc -l` gives 390 at all three. Their existing check,
`tests/composite_routing.rs`, is likewise blob `2201b830` at all three commits at
1,049 lines. Both records' `composite.rs` citations were re-verified line by line
at carry time and **every one holds**.

**Citations repaired at carry time, per METHOD rule 1.** One, in the second
record. Its `Existing check:` cited
`tests/composite_routing.rs:1028-1060` for the optional-child health panic on the
tertiary child. The file is 1,049 lines, so `:1060` overruns the end of the file
by eleven lines; the test is
`a_panicking_synapse_health_reports_failing_without_unwinding`, whose
`#[tokio::test]` is at `:1028`, whose `fn` is at `:1029`, and which ends at
`:1049`, the last line of the file. The corrected span is `:1028-1049`. This is
the one drift the earlier triage did not predict: it recorded that both records'
subjects and both existing checks were byte-identical and concluded that "neither
needs a citation refresh", which is true of the file contents and false of this
one span, because the span was already wrong when the lens wrote it rather than
made wrong by a change. Everything else in both records verified unchanged.

**Reachability for both rests on one chain, re-verified at carry time rather
than inherited.** The production binary is
`crates/mc-module/src/bin/ck_mc_host/serve.rs`, which constructs
`StaticComposite::new(...)` at `:575` and passes that value to `mc_host::run` at
`:632`; both lines were re-printed here. `composite.rs` contains **zero `#[cfg]`
attributes**, verified by grep, so no part of the file is gated. That is a
stronger statement than the equivalent for most files in this sub-part, and it is
consistent with the check inventory's note that `composite.rs` has no test module.
Fact 1 of the [Reachability](#reachability) section establishes the routed path
that reaches `handle` and `route_gone`. The one asymmetry worth naming is inside
the surface rather than at its edge, and it is the second record's subject: the
primary child's `health` at `:312` is *not* wrapped, while the two optional
children's are at `:318` and `:321`.

### composite-route-entry-is-removed-by-exactly-one-route-gone

Type: safety
Reachability: default-production — the composite is constructed at
`serve.rs:575` and handed to `mc_host::run` at `:632`. Its `bind`, `handle` and
`route_gone` are the composite's leg of the routed path Fact 1 of
[Reachability](#reachability) establishes, and the route map they share
(`composite.rs:112`, initialized at `:134`) is plain `Mutex<HashMap<..>>` state
with no gate. `composite.rs` has zero `#[cfg]` attributes.
Status: active
Exercised: partial — one rejected-bind case is covered; panic and
close-wins-bind are not.
Guarantee: Every route-map entry the composite inserts is removed exactly once,
so the map's size is bounded by the set of live plus closing routes.
Check: `always` — for every `RouteHandle` the composite inserts, the number of
removals is exactly one, and no removal precedes the owning child's `route_gone`
returning. Per-handle accounting is the primary oracle; total map size is a
cheap screen, since an insert and an unrelated remove cancel in the total.
Fault/timing angle: the removal is deliberately after the child callback
[composite.rs:297-303], so `handle` for a handle mid-`route_gone` still resolves
to the correct child [277-287]. That window is intentional and already covered.
Required faults and enabling state: the three non-success bind outcomes the
comment at composite.rs:262-265 names — a `BindOutcome::Reject`, a panicking
`bind`, and close-wins-bind — each of which must still produce exactly one
`route_gone`. The insert at composite.rs:266-269 happens before the `await` at
271-273, so a panicking `bind` leaves the entry behind and the host's route-gone
obligation is the only thing that reclaims it.
Confidence: high — [evidence](evidence/composite-route-entry-is-removed-by-exactly-one-route-gone.md).
Read the insert, the removal, and the unmapped arms of `handle` [282-285] and
`route_gone` [295]. The unmapped `route_gone` returns without touching the map,
so a spurious callback cannot remove another handle's entry. Every citation in
this record was re-verified line by line at carry time and none needed repair.
Two additions from that pass, both strengthening the record rather than changing
it. The **at-most-one** half now has a named enforcer on the runtime side:
`run_route_gone` short-circuits at `dispatch.rs:1256-1258` when
`registry.mark_gone_started` (`routing.rs:377-390`) reports the flag already set,
returning without invoking the child callback at all, so the composite's removal
returning without invoking the child callback at all, so the composite's removal
statement at `:299-302` cannot run twice for one handle. **The at-least-one half
has three
exceptions, all fatal-latched, listed in the open questions below.
Existing check: `tests/composite_routing.rs:485-531` pins exactly one
`route_gone` for a rejected bind;
`tests/composite_routing.rs:532-600` pins that a closed handle cannot dispatch
to stale child ownership. Neither runs in CI: the binary is unnamed, per
[existing-checks.md](existing-checks.md). Status unaudited. Both spans
re-verified at carry time: `rejected_broca_bind_gets_exactly_one_broca_route_gone`
has its attribute at `:485` and its `fn` at `:486`, and
`a_closed_route_handle_cannot_dispatch_to_stale_child_ownership` has its attribute
at `:532` and its `fn` at `:533`.
Impact: a bind path that never yields `route_gone` leaks one map entry per
connection for the host's lifetime, and the leaked entry keeps routing a reused
handle to a stale child.
Open questions:
- Does the host guarantee `route_gone` after a panicking `bind`, or only after
  `Reject` and close? The comment claims all three; the runtime side is outside
  this lens. **Resolved at carry time, and the answer is yes.** The runtime side
  is `dispatch.rs`, which is inside *this* sub-part's scope rather than outside
  it, so the question was answerable here and was not asked. A panic in `bind`
  propagates out of the spawned task, because `panic_boundary::redact_sync`
  (`panic_boundary.rs:52-55`) only marks the panic-hook depth and does not
  `catch_unwind`; `lifecycle_join` observes `is_panic()` at `runtime.rs:187`,
  trips the fatal latch at `:192-193`, and returns
  `Err(LifecycleFailure { stopped: true })` at `:194`; and `dispatch.rs:1164`
  matches that arm and calls `run_route_gone` at `:1166`. All three outcomes the
  comment at `composite.rs:262-265` names do produce exactly one `route_gone`.
- **A new question, opened by that resolution.** There are three further bind or
  close outcomes the composite's comment does not name, and on each the map entry
  is never removed: `dispatch.rs:1174`, where the bind is still executing past
  `lifecycle_callback_deadline` and the comment at `:1171-1173` deliberately
  declines to run `route_gone`; `dispatch.rs:1440-1444`, where a dispatch task did
  not stop before route-gone and the function returns before the `run_route_gone`
  at `:1446`; and `run_route_gone` returning `false` at `:1276`, where the child's
  own callback did not return. All three trip the fatal latch, so the leak is
  bounded by a terminating incarnation rather than by the host's lifetime, which
  is a weaker bound than this record's `Impact:` assumes but not an unbounded one.
  Is that bound intended as the answer, or should the composite's map be dropped
  wholesale on a fatal latch? (needs human input)

### composite-panic-containment-covers-only-optional-health-and-shutdown

Type: safety
Reachability: default-production — same construction chain, `serve.rs:575` and
`:632`. Every one of the eleven child call positions enumerated below is an
unconditional statement in `composite.rs`, which has zero `#[cfg]` attributes, so
none of the contained or uncontained sites is gated.
Status: active
Exercised: partial — both contained categories have dedicated tests; no test
pins that the other categories deliberately escalate.
Guarantee: A child panic is contained exactly where the composite can still
serve the host without that child, and escalates to the runtime's fatal cell
everywhere else; the set of contained call sites is closed.
Check: `always` — a panic in an optional child's `health` yields a `Failing`
report for that child and the primary's report still decides the aggregate; a
panic in any child's `shutdown` still drains every remaining child; and a panic
in any other child callback reaches the runtime.
Fault/timing angle: `catch_child_panic` wraps each individual poll
[composite.rs:160-171], so a child that panics after an `await` is still caught.
`shutdown` collects notes and re-raises one aggregate panic only after all three
drains [composite.rs:370-388], which is what keeps the instance fence held until
every child's background work has stopped.
Required faults and enabling state: a panicking child in each of the nine
uncontained positions listed in O17, plus the two contained ones. The primary's
`health` at composite.rs:312 is the one asymmetry a test should pin explicitly,
because the surrounding comment [306-311] only discusses optional children.
Confidence: high — [evidence](evidence/composite-panic-containment-covers-only-optional-health-and-shutdown.md).
Enumerated every child call in the file and checked each for a
`catch_child_panic` wrapper. This is deliberately a *containment* property and
does not restate part 2a's
`every-callback-invocation-is-inside-the-redaction-guard`, which is about the
redaction hook rather than about unwinding. The enumeration was re-derived
independently at carry time and O17's count of nine uncontained positions is
confirmed exactly: `install_connection_key` (`:194-196`), `manifest`
(`:201-203`), `resources` (`:211-213`), `initialize` (`:223-225`), `activate`
(`:235-237`), `bind` (`:271-273`), `handle` (`:279-281`), `route_gone`
(`:292-294`), and the primary's `health` (`:312`). The two contained positions are
the optional children's `health` (`:318`, `:321`) and all three `shutdown` calls
(`:374`, `:378`, `:382`).
Existing check: `tests/composite_routing.rs:851-885` and `:886-917` cover
shutdown panic and error; `tests/composite_routing.rs:986-1027` and `:1028-1049`
cover optional-child health panics;
`tests/composite_routing.rs:918-985` covers the non-graceful incarnation. None
runs in CI: the binary is unnamed, per
[existing-checks.md](existing-checks.md). Status unaudited. **One citation
repaired at carry time:** the last of the health-panic spans is `:1028-1049`, not
`:1028-1060`. The file is 1,049 lines, so the lens's end bound overran it by
eleven; the test is `a_panicking_synapse_health_reports_failing_without_unwinding`
(attribute `:1028`, `fn` `:1029`) and it ends on the file's final line. The other
four spans verified exactly.
Impact: adding a `catch_child_panic` to a callback the runtime treats as fatal
would silently convert a host-fatal invariant break into a degraded mode;
removing one from `shutdown` would release the instance fence with a child's
work still live.
Open questions: None.
