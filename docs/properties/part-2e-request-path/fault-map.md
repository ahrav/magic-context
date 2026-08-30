# Sub-part 2e fault-to-property map

For each of the 14 records, what must actually occur for a test to be
non-vacuous, and whether the harness can produce it today.

Same rules as the earlier parts. Safety checks must hold *while* their faults are
active. Liveness checks need a bounded fault-free window, stated in the units the
code bounds; this sub-part has no liveness record, so that rule does not bind
here. Rare implementation branches need deterministic injection to be reachable
at all. Coverage checks assert independent preconditions, never the violation.

Four framing points specific to this sub-part.

**First, the harness position is the exact inverse of 2b's and 2d's, and it
changes what is cheap.** 2b's and 2d's dominant obstacle was that their in-crate
suites run nowhere. 2e has that problem too, for all 37 in-crate tests and all
84 integration tests. What 2e has that neither sibling has is a *rich local
harness*: six integration binaries totalling 4,993 lines, a `TestHost`, and
handler fixtures that can panic, park, reject a bind, return an oversize body, or
shrink a limit. So almost every fault in the table below is constructible by
writing a handler, and the binding constraint is CI execution rather than
constructability. That is why the leverage ranking puts the workflow change
first and handler-authored faults second.

**Second, the richest fixture here is the handler trait itself.** A test handler
is an arbitrary `McHostHandler` implementation (`handler.rs:558`), and the
dispatch layer's contract with it is exactly what the catalog interrogates. A
handler can panic in `handle` (`:1053`), panic or block in `bind` (`:1164`,
`:1174`), reserve output and not write it (`:1031`), return a multi-megabyte
error message (`:1045`), or hold its permits past every host deadline. Six of
the fourteen records need nothing but a hostile handler. No injection seam, no
production edit, no new infrastructure.

**Third, the one thing this sub-part cannot observe is its own private state.**
`gen.pending` is private to the crate, no in-crate test constructs a
`GenerationCore`, and no integration test can reach the map. That single absence
is what blocks the pending-entry record outright and is why it is the catalog's
only `medium` confidence record.

**Fourth, six of the fourteen records are discharged wholly or partly by
enumeration, and that is a property of the findings rather than a shortcut.**
The catalog's three sharpest findings are all statements about code that is
*missing*: no lower bound at `:1031`, no `written` hook on a routed terminal, no
request field in `HostTiming`. An absence is proved by a census over the path,
not by a fault. Saying so is what keeps the fault map from over-ordering the
work.

## Fault classes required

`C0` is listed first because it is the cheapest capability here and it is not a
fault at all. `C1` and `C7` are the two classes that unblock the most records,
and both are handler-authored.

| Class | Description | Available today |
| --- | --- | --- |
| **C0** test execution in CI | A workflow job that builds and runs the checks a record's oracle would live in | **Partial, and the split is unusual.** *Doctests: yes.* Four `compile_fail` doctests in `handler.rs` (`:213-219`, `:425-427`, `:429-431`, `:433-435`) execute at `ci.yml:190` under the step name "Rust lease non-escape", so 2e owns four of the six CI-executed source-resident checks in the library. *In-crate: no.* All 37 execute in no job, because every `-p mc-host` invocation carries a `--test <name>` filter and never builds the lib target; the 13 `mc-host` hits are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`, `:461`, and `:168-169` are `cargo build`. *Integration: no.* CI names `client`, `lifecycle`, `shm_failure_modes`, and `shm_soak`; it names none of the six binaries whose subject is the request path, so all 84 run locally only |
| **C1** a hostile handler `handle` | A handler that reserves an `OutputBuffer` and returns `RequestOutcome::Response` without writing (`dispatch.rs:1031`), returns an oversize body (`:1035`), returns a multi-megabyte `Error` message (`:1045`), streams then returns a unary `Response` (`:1020`), or parks indefinitely | **Yes, and it is the cheapest capability in the sub-part.** The handler is a trait the test supplies. `tests/dispatch.rs:295` already parks one in a "hang" mode and `:665` already returns an oversize body, so both extreme shapes have precedent. The reserve-without-write shape is supported by construction: `OutputBuffer::extend_from_slice` and `resize` (`handler.rs:381-396`) refuse to grow past `max_len` and refuse outright when `direct.is_some()`, so a reserved and unwritten buffer is a legal state |
| **C2** a direct-output serializer that mismatches its declared length | A handler calling `RequestCtx::output_from_writer` with an `exact_len` its serializer does not satisfy, so `reservation.commit(body_len)` rejects on `cursor != body_len` (`mc-shm-transport/src/backend/ring.rs:1363-1367`, `ProducerError::Underfill`) | **Yes, and no injection seam is needed, which is the surprising part.** The mismatch is authored in the handler, and the failure occurs inside the writer at `ring_transport.rs:580-593`, long after `settle` returned at `dispatch.rs:460`. What a test *cannot* do is observe the host attributing the loss, because `publish_one` (`ring_transport.rs:564-566`) returns `Err` without running the `written` hook and without touching the settlement. That absence is the record, not an obstacle to it |
| **C3** a bind callback that stops or overruns | A handler `bind` that panics, is aborted, or self-bounds its own inner deadline, reaching `dispatch.rs:1164`; or one still executing at `lifecycle_callback_deadline` (30 s default, `config.rs:225`), reaching `:1174` | **Yes for both, with one caveat on cost.** `bind` is handler-supplied and `tests/handler_contract.rs:229` already drives a rejecting bind, so a panicking or blocking one is a fixture edit. The `:1174` form additionally requires the run to wait out `lifecycle_callback_deadline`, so a shrunk `HostTiming` is needed to keep the test fast. Both exits trip the fatal latch inside `lifecycle_join` (`runtime.rs:186-207`), so the host terminates and the oracle must be read from the client's side or from the latch |
| **C4** a close that races an in-flight bind | A generation teardown or forced drain concurrent with a bind, producing `BindInstall::CloseWins` at `dispatch.rs:1195-1202` with the silent exit at `:1199` | **No deterministically.** `routing.rs:619` reaches the registry-level close-versus-bind race in-crate, so the *registry* half is covered, but driving `open_route` into `CloseWins` needs the close to be marked between `reserve` (`:1127`) and `install_bound` (`:1178`), a window with no seam. `routing.rs:408-413` marks mid-bind routes close-requested rather than draining them, which is what makes the state legal; producing it on demand needs either an injection point or a blocking bind plus a concurrent shutdown, which is racy rather than deterministic |
| **C5** busy-reject exhaustion under contended egress | More than 32 concurrent no-dispatch rejections per generation, all blocked on a saturated egress byte budget, so the 33rd reaches `dispatch.rs:637-638` and the code cancels the token and calls `gen.writer.discard()` | **Yes by composition, and both halves already exist separately.** `MAX_INFLIGHT_BUSY_REJECTS = 32` (`connection.rs:42`, used at `:244`); `tests/dispatch.rs:788` already saturates the egress budget; and admission failure needs only a closed route or an exhausted permit pool, which `:271` and `:295` already produce. What no fixture has is the two composed with a slow-reading peer so the 32 do not drain. Observing *which other correlations'* queued terminals the `discard()` dropped needs a per-correlation egress trace the harness does not have |
| **C6** a non-panic join error on the request task | The handler task aborted rather than panicked, so `dispatch.rs:1053`'s `is_panic()` guard fails and the `Err(_)` arm at `:1058` removes the pending entry and returns with no terminal | **Partial.** The producer is `force_close_all_routes` (`:1421-1452`), which aborts before waiting, so the state is reachable through a forced shutdown past the drain deadline. What is not available is the *observation*: the arm emits nothing, records nothing, and increments nothing, so a test can only infer it from a correlation that never settles, which is indistinguishable from a slow handler. This is the same shape as `C4`: the state is producible, the exit is unobservable |
| **C7** permit saturation in all five states | General pending, general task, reserved pending, reserved task, and per-generation `busy_rejects` exhaustion | **Yes, and the pieces all exist.** `tests/dispatch.rs:295` shrinks `max_pending_requests` and parks a handler; `:976` and `:1074` saturate both classes' pending pools; Broca's live 96/96 reserved declaration (`broca/config.rs:185`, `:188`) makes the reserved class real. Task-permit exhaustion needs more than `max_handler_tasks` concurrent *executing* handlers, which is why a shrunk limit plus parked handlers is the route rather than volume. The fifth state is `C5` |
| **C8** a draining host with both request kinds pipelined | `shared.draining` set or `shared.shutdown` cancelled, with a routed request and a `route.open` arriving behind it, so `dispatch.rs:844` answers `server_busy` and `:1112` answers `target_unavailable` | **Yes.** An authenticated `host.shutdown` or an external shutdown signal reaches both fences, and `handle_host_shutdown`'s write hook sets `draining` and `freeze_admission` inside the writer task (`:752-753`) so the commit point and the fence coincide, which makes the ordering deterministic rather than racy. The harness already stops hosts gracefully |
| **C9** a forced shutdown past the drain deadline | `force_close_all_routes` (`dispatch.rs:1421-1452`) aborting outer tasks whose pending keys no `settle_route_work` sweep collected | **Producible, not observable.** Sub-part 2f establishes that `shutdown_sequence` calls `force_close_all_routes` twice (`runtime.rs:1206`, `:1216`) with no enclosing timeout, and `tests/lifecycle.rs:678` and `:714` already build the non-yielding-callback shape that reaches the forced path. The blocker is that `gen.pending` is private to the crate and no in-crate test constructs a `GenerationCore`, so nothing can assert the map's emptiness. This is the single blocking capability in the sub-part |

Three availability caveats cut across the classes.

**C4, C6, and C9 share an observability problem, not an injection problem.** All
three land on an exit that emits no frame, records no cause, and increments no
counter. So an oracle for any of them must observe either the *client's*
disposition, which cannot distinguish an abandoned correlation from a slow
handler, or *host-private state*, which is unreachable. That is the finding
rather than an obstacle to measuring it, and it is the same shape 2d recorded for
the detached bridge thread.

**C0's split is favourable and should not be over-read.** Four CI-executed
doctests is genuinely more than either sibling has, but all four bear on the
handler API *surface* — they forbid a `Vec<u8>` body and three field accesses —
and none of them touches a record in this catalog. The sub-part's CI-executed
coverage of its own findings is zero.

**C3's cost is a configuration choice, not a capability.** Both bind exits are
constructible today, but the `:1174` form waits out
`lifecycle_callback_deadline`. `tests/dispatch.rs:295` already demonstrates the
remedy by shrinking a limit, so this is a fixture parameter rather than a gap.

## Map

All 14 records, in catalog index order. **"Non-vacuous today" means a developer
can construct the required state with the current harness.** It does not mean the
check runs anywhere: under `C0`, an in-crate or integration oracle runs nowhere,
and only a doctest is CI-protected.

Every record is `default-production`, so no row repeats an enabling
configuration gate. The routed path is reached by `read_loop`
(`connection.rs:373`) calling `dispatch_request` at `:467`, the production binary
is `crates/mc-module/src/bin/ck_mc_host/serve.rs` (composite at `:575`,
`mc_host::run` at `:632`), and `RouteClass::Reserved` is live because
`broca/mod.rs:164-177` declares it; see the reachability resolution in
`catalog.md` for the full argument.

### The arbiter

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame | **`C1` plus a client `Cancel` plus a route `Goodbye`.** A handler that both streams and returns a unary `Response`, with three settlement claimants in flight at once. Two of the three races already exist: `tests/dispatch.rs:358` and `:453` race cancel against completion, and `:835` closes a route over admitted work. The third claimant, generation teardown, is `C8`'s shutdown | **Yes** — every claimant is producible from the existing harness, and the oracle is a count of terminal-typed frames per `(channel, epoch, corr)` plus the ordering assertion that no `StreamData` follows a terminal |
| req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation | Split. The **enumeration half** — that all four emission entry points recheck `gen.writer.is_retired() \|\| gen.token.is_cancelled()` (`dispatch.rs:195-197`, `:277-282`, `:323-325`, `:519-524` plus `:531-536`) — is a census over the file. The **interleaving half** needs a terminal's byte charge acquired before a cancellation and consumed after it, which requires a saturated egress budget (`tests/dispatch.rs:788`) plus a teardown landing inside the budget wait | **Partial** — the enumeration is discharged today; the charge-straddling interleaving has no deterministic seam, because `StreamSink::reserve`'s two rechecks bracket an await whose completion a test cannot schedule |

### Exits that answer nothing

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired | **`C5`.** A saturated egress byte budget plus a client pipelining more than 32 requests that fail admission. Both halves exist separately — `tests/dispatch.rs:788` saturates the budget, `:271` and `:295` produce admission failure — and the composition adds a slow-reading peer so the 32 in-flight rejections do not drain | **Yes** for the disjunction the check states: either a terminal is queued, or `gen.token.is_cancelled()` and the writer is discarding, both observable. The **blast radius** in the record's `Impact:` — which *other* correlations' queued frames the `discard()` dropped — needs a per-correlation egress trace the harness does not have |
| req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining | Three exits, two costs. `C3` gives both bind-stop forms: a panicking `bind` reaches `:1164` immediately, and a blocking `bind` reaches `:1174` after `lifecycle_callback_deadline`, so a shrunk `HostTiming` keeps it fast. `C4` gives `CloseWins` at `:1199` and has no seam | **Partial** — two of three exits are constructible from a hostile `bind` today, and `tests/handler_contract.rs:229` already drives a rejecting bind so the fixture shape exists. The third needs the close to be marked between `reserve` (`:1127`) and `install_bound` (`:1178`), which is racy rather than deterministic |
| req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close | **`C9`.** A forced shutdown past the drain deadline with requests in flight, so `force_close_all_routes` (`:1421-1452`) aborts outer tasks whose keys no `settle_route_work` sweep collected (`:1332-1342`, removal at `:1374-1380`). The state is producible: `tests/lifecycle.rs:678` and `:714` build the non-yielding-callback shape | **No** — the state is producible and the postcondition is not observable. `gen.pending` is private to the crate, no in-crate test constructs a `GenerationCore`, and no integration test can reach the map. This is the only fully blocked record in the sub-part and the only `medium` confidence one |

### A terminal that proves nothing

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| req-a-a-routed-terminal-carries-no-delivery-acknowledgement | **No fault.** The check is a census of every `written:` construction in the sub-part: three hooks exist — `handle_host_shutdown` (`:678-680`, `:743-756`), `emit_authoritative_rejection` (`:814-816`), `send_connection_goodbye` (`:1474-1476`) — and every routed terminal passes `written: None` (`:358`, `:300`). Per METHOD's effect accounting the derived assertion is that acknowledged effects are identically zero | **Yes** — enumeration only, and the oracle proves an **absence**, so it is discharged by a census over the emission paths rather than by a test that passes. A census check in CI would catch the reintroduction case |
| req-a-a-response-publication-failure-never-reaches-the-settling-path | **`C2`.** A handler calling `output_from_writer` with an `exact_len` its serializer does not match, so `commit` returns `ProducerError::Underfill` inside the writer at `ring_transport.rs:580-593`, after `settle` already returned `true` at `dispatch.rs:460` | **Yes** — the fault is authored in the handler and needs no seam. What the test observes is the *asymmetry*: the host records a settlement, the client sees a clean close, and no `Error` terminal follows. Part 2b's `ring-a-publish-failure-is-reported-as-a-clean-peer-close` already establishes the close half |
| req-a-a-handler-response-is-length-checked-and-never-content-checked | **`C1`, plus enumeration.** The census half is that the only predicate at `:1031` is `body.len() <= MAX_BODY_LEN`, with no lower-bound, emptiness, or declared-versus-written comparison anywhere on the path to `emit_reserved_frame`. The construction half is a handler that reserves an `OutputBuffer`, takes an early error return without writing, and still returns `Response` | **Yes** — both halves. `tests/dispatch.rs:665` already covers the ceiling from the other direction, and the wire layer's acceptance is settled by reading `wire.rs:340`, which rejects a body only on a pure-header type |

### Admission bounds and the missing deadline

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs | **`C7` for the bounds, enumeration for the acquisition site.** A client pipelining more requests than `max_handler_tasks` on one route plus a slow-reading peer so the pending count exceeds the task count. The class-separation half already has four tests (`tests/dispatch.rs:976`, `:1074`, `tests/handler_contract.rs:323`, `:636`). The "acquired before the spawn rather than inside it" half is a read of `dispatch.rs:884-896` against `:932` | **Yes** — the divergence between the two counts under a slow peer is the one genuinely new construction, and it follows from the split at `:933` versus `:990`, which the record already states |
| req-a-a-handler-outliving-every-host-deadline-is-reached | **`C1`.** A handler whose `handle` blocks with no internal timeout, its route and generation still live and no `Cancel` outstanding, for longer than `max(frame_deadline, lifecycle_callback_deadline, route_close_budget)`. `tests/dispatch.rs:295` already parks a handler to occupy a permit, so the state is constructed incidentally today | **Yes** — and the only cost is wall-clock, since at defaults the bound to exceed is 30 s. A shrunk `HostTiming` makes it fast. Note that the oracle also asserts an **absence** — that no `timeout` or `timeout_at` in `dispatch.rs` wraps the handler callback — which is enumeration |
| req-a-both-admission-classes-and-the-rejection-bound-saturate | **`C7`.** All five states in one campaign: general pending, general task, reserved pending, reserved task, `busy_rejects`. Pending in both classes is already reached by `tests/dispatch.rs:295`, `:976`, `:1074`. Task saturation needs a shrunk `max_handler_tasks` plus parked handlers. `busy_rejects` needs `C5`'s contended egress | **Yes** — every piece has an existing fixture and the work is composing them into one campaign. The reserved *task* state is the one with no precedent, and it is the half that matters, because the carve-out exists specifically to survive general-load saturation |

### Rejection, three shapes and three bounds

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes | **`C8`.** An authenticated `host.shutdown` or an external shutdown signal, with a client pipelining both a routed request and a `route.open` behind it. The ordering is deterministic rather than racy, because `handle_host_shutdown`'s write hook sets `draining` and `freeze_admission` inside the writer task (`:752-753`), so the commit point and the fence coincide | **Yes** — and the oracle is two codes read from one client, which is the cheapest end-to-end assertion in the sub-part. Currently unasserted: the record's `Existing check:` is `none` |
| req-a-three-control-rejection-paths-carry-three-different-bounds | Split. The **classification half** — semantic rejections through `emit_error_terminal` inside a pending-permit-holding task (`connection.rs:638-655`), capacity rejections through `emit_rejection`, oversize rejections through `emit_authoritative_rejection` (`connection.rs:430-450`), and only the third carrying `written_tx` — is enumeration over three call sites. The **bound half** needs concurrent floods of malformed control bodies, oversize control bodies, and requests past the pending bound, one of which is `C5` | **Partial** — the classification and the `written`-hook asymmetry are discharged by reading today, and `tests/routing.rs:98` and `:212` already exercise the semantic path. Asserting that each of the three counters actually binds needs the three floods composed on one generation, which no fixture builds |
| req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait | **`C1` plus `C3`.** A handler returning a multi-megabyte error message, at pending-pool or route-pool saturation, with a slow-reading peer so the terminals queue; and a `BindOutcome::Reject` carrying the same oversize pair, to reach the second capping site at `:1206-1218`. `tests/handler_contract.rs:229` already carries a handler code to the client through a rejected bind | **Yes** — both sites are reachable from handler-authored values, and the record's second assertion, that the two capping sites use identical limits, is enumeration. The bind copy currently has no test at all |

**Totals: 10 fully non-vacuous today, 3 partial, 1 not constructible.** The ten
are the arbiter's at-most-one record, all three of Group C, the pre-dispatch
rejection disjunction, both admission-bound records plus the saturation
reachability record, the divergent-codes record, and the diagnostics cap. The
three partial ones are the no-emission-after-retirement record (enumeration yes,
charge-straddling interleaving no), the `route.open` record (two exits of three),
and the three-control-bounds record (classification yes, joint saturation no).
The one blocked record is the pending-entry sweep, blocked on observability
rather than on producibility.

Note the shape of that ten: **six of them are discharged wholly or partly by
enumeration**, because six of the fourteen records are statements about code that
is missing — no lower bound at `:1031`, no `written` hook on a routed terminal,
no request field in `HostTiming`, no capacity predicate distinguishing the two
`open_route` silent exits, no shared definition behind the two diagnostic caps,
no `timeout` around the handler callback. That is what cataloging a
terminal-arbitration surface for the first time produces, and it is the same
shape 2b and 2d reported.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and
never constructed dynamically.

**Lens A produced exactly two `sometimes` records and both comply with the
METHOD coverage rule, so neither is duplicated here.** Verified against the rule
individually.

[req-a-a-handler-outliving-every-host-deadline-is-reached](catalog.md#req-a-a-handler-outliving-every-host-deadline-is-reached)
asserts a conjunction of three independent legal facts: a handler has held its
task and pending permits for longer than
`max(frame_deadline, lifecycle_callback_deadline, route_close_budget)`,
`route_tracker` still reports the route live, and the pending entry is unsettled.
Each is legal on a correct build, because `HostTiming` (`config.rs:199-218`) is
*specified* to carry no request field and protocol §11 assigns the request
deadline to the client. It is not paired with any `always(!X)`, and none of its
three conjuncts is a violation. So it needs no companion marker.

[req-a-both-admission-classes-and-the-rejection-bound-saturate](catalog.md#req-a-both-admission-classes-and-the-rejection-bound-saturate)
asserts that each of five saturation states occurs at least once. All five are
legal designed outcomes: `try_acquire_owned` is *specified* to fail rather than
wait (`dispatch.rs:881-883`), and `busy_rejects` exhaustion is *specified* to
cancel and discard (`:630-636`). The one pairing to be careful about is with
[req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired](catalog.md#req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired),
which is `always(terminal queued OR generation retired)`. `busy_rejects`
exhaustion is the *precondition of the second disjunct*, not the negation of the
`always`, so the pair is legal and is not the forbidden
`always(!X)`/`sometimes(X)` shape. Recorded explicitly because it is the one
place in this sub-part where the illegal pairing would be easy to write by
accident.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `req_settlement_won_swap_succeeded` | The `won.swap(true)` at `dispatch.rs:408` returned `false`, so this claimant is the winner | The ordinary shape of every settled request. Records that arbitration happened without asserting how many claimants there were |
| `req_settlement_won_swap_lost` | The same swap returned `true`, so another claimant had already won | Legal and expected whenever cancel, close, or teardown races completion. The pair is the finding; neither alone is a defect claim |
| `req_stream_item_emitted_before_a_terminal` | A `StreamData` was emitted under the `order` lock and `streamed` was stored at `:599` before release | The designed streaming path. The precondition of the `has_streamed` read at `:418` being meaningful |
| `req_terminal_enqueued_with_no_written_hook` | A routed terminal reached the writer queue with `written: None` (`:358`) | True of every routed terminal today and legal, since no hook exists. This is the honest form of the acknowledgement finding: a fact about the emission path, not an outcome |
| `req_control_terminal_enqueued_with_a_written_hook` | One of the three control or teardown emissions attached a `written` hook (`:678-680`, `:814-816`, `:1474-1476`) | The complementary legal case, and the one that shows the crate knows how to condition an effect on delivery. Together the pair is the finding |
| `req_publication_failed_after_a_recorded_settlement` | `publish_one` returned `Err` (`ring_transport.rs:564-566`) for a correlation whose `won` was already `true` | Legal: the two events are unordered by construction, and the record's whole point is that nothing relates them. Does **not** assert what the client then observed |
| `req_response_accepted_at_the_length_gate` | A `RequestOutcome::Response` satisfied `body.len() <= MAX_BODY_LEN` at `:1031` and became a `Terminal::Response` | The ordinary success path. Recording that the length predicate is the whole gate is the finding; asserting the handler failed is not something dispatch can observe |
| `req_output_buffer_was_reserved_and_unwritten` | An `OutputBuffer` reached `:1031` with a declared `exact_len` and nothing written into it | A legal state by construction (`handler.rs:381-396`). The independent companion to the check above, and what makes its silence meaningful |
| `req_emit_rejection_acquired_a_busy_permit` | `emit_rejection` took one of the 32 `busy_rejects` permits (`connection.rs:244`) | The ordinary rejection path on a healthy generation. The precondition of the exhaustion arm |
| `req_emit_rejection_found_the_busy_bound_exhausted` | `emit_rejection` reached `dispatch.rs:637-638` and cancelled the token then discarded the queue | A declared outcome the comment at `:630-636` argues for explicitly. Records the blast radius' precondition without asserting which other correlations lost frames |
| `req_open_route_returned_without_a_terminal` | `open_route` returned through `:1164`, `:1174`, or `:1199` | Legal on all three: two are gated on the fatal latch, and the third is the specified `CloseWins` ordering. This is the counter the quiet-area section says does not exist |
| `req_open_route_answered_its_correlation` | `open_route` returned through `:1112-1122`, `:1127-1137`, `:1178-1193`, or `:1204-1237` | The four answering exits. The complementary legal case; the pair is what makes the silent exits countable rather than inferred |
| `req_request_join_error_was_not_a_panic` | The `Err(_)` arm at `:1058` ran, so the handler task was aborted rather than panicking | Legal whenever `force_close_all_routes` aborted the task. Does **not** assert that the pending entry leaked |
| `req_settle_route_work_swept_a_pending_key` | `settle_route_work` removed a key at `:1374-1380` that its aborted task had not removed | The designed sweep, whose own comment says "Aborted tasks never removed their own pending entries". The precondition of the asymmetry with `force_close_all_routes` |
| `req_permit_acquired_before_the_spawn` | Both `try_acquire_owned` calls (`:884`, `:896`) succeeded on the read loop before `spawn_tracked` at `:932` | True of every admitted request and legal by design (`:881-883`). The honest form of "the bound is not bypassable by pipelining" |
| `req_reserved_class_permit_acquired` | A route whose stored `RouteClass` is `Reserved` drew from `reserved_pending_permits` or `reserved_task_permits` (`:873-879`) | Legal and live, because `broca/mod.rs:164-177` declares 96/96. Contradicts `runtime.rs:118-119`'s "unreachable" comment as a byproduct, which is why it is worth placing |
| `req_shutdown_fence_refused_a_routed_request` | `dispatch.rs:844` answered `server_busy` while `draining` was set | The specified behaviour. Records one half of the divergence |
| `req_shutdown_fence_refused_a_route_open` | `dispatch.rs:1112` answered `target_unavailable` under the same condition | The other half. The pair is the finding; neither code alone is wrong |
| `req_handler_diagnostic_was_substituted` | `bounded_terminal_error` (`:82`) replaced an over-cap code or message wholesale with `internal_error` | The designed truncation-by-substitution. Records the cap firing without asserting an uncapped string ever escaped |
| `req_bind_rejection_diagnostic_was_substituted` | The hand-written copy at `:1211` substituted for the same reason | The independent companion, and the one with no test today. Together they witness that both copies of the policy are live |

**Anti-patterns to avoid in this sub-part specifically.** Four pairings are
forbidden by METHOD's rule, and each is tempting here because in every case the
defect is easier to name than its precondition.

- Do not pair `always(every_admitted_request_gets_a_terminal)` with
  `sometimes(a_request_got_no_terminal)`. The `always` is **false as stated** —
  the guarantee is at-most-one, not exactly-one — so the pairing would encode the
  wrong contract and its marker could only fire by observing one of five
  deliberate exits. Assert `req_open_route_returned_without_a_terminal` and
  `req_open_route_answered_its_correlation` as two independent legal facts, and
  `req_request_join_error_was_not_a_panic` for the fifth exit.
- Do not pair `always(response_body_is_non_empty)` with
  `sometimes(empty_response_terminal)`. There is no such lower bound at `:1031`,
  so the `always` half is vacuous and the `sometimes` half would report the
  ordinary success path as a defect. Assert
  `req_response_accepted_at_the_length_gate` and
  `req_output_buffer_was_reserved_and_unwritten` instead: two legal facts whose
  conjunction is the finding.
- Do not pair `always(settled_implies_delivered)` with
  `sometimes(settled_but_not_delivered)`. The host has no delivery signal at all
  on the routed path, so the second marker cannot be placed anywhere that could
  observe it. Assert `req_terminal_enqueued_with_no_written_hook` and
  `req_control_terminal_enqueued_with_a_written_hook`, which are both readable at
  the emission site.
- Do not pair `unreachable(writer_discard_on_a_live_generation)` with
  `sometimes(writer_discard_entered)`. `:638` is a specified outcome, not a
  forbidden location, so `unreachable` is the wrong semantics per METHOD's first
  coverage rule. Assert `req_emit_rejection_acquired_a_busy_permit` and
  `req_emit_rejection_found_the_busy_bound_exhausted`.

Two further constraints on marker placement here.

**Place a marker where its precondition becomes true, not where the code finishes
depending on it.** `remove_pending` (`:1097`) is called on all five outer-task
exits, so a marker there cannot distinguish which exit ran. Each of the five
needs its own site: `:935`, `:958`, `:1059`, `:1066`, and the abort case's sweep
at `:1374-1380`.

**Do not place any marker after `settle` returns.** `settle` completes at
`:460` once `send_before` returns `Ok`, and the publication failure occurs later
in the endpoint thread with no ordering between them. A marker after `settle`
sees success on every path, published or not, which is exactly the record's
point.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability.

**The cheapest item on this list is not a fault and not a new test. It is
running the 121 tests that already exist.** State that plainly, because the
natural reading of a 14-record catalog is that new tests are the bottleneck. They
are not: this sub-part has the richest local harness of the three and the same
zero CI execution of it.

1. **`C0`, running the existing suites in CI.** A workflow change and nothing
   else: add an unfiltered `-p mc-host` invocation, or name the six binaries whose
   subject is the request path. It unblocks **zero** new records and protects
   **121 existing test functions**, including the 20 in `tests/dispatch.rs` that
   are the real coverage for this sub-part's arbitration claims. The proof that
   the wiring cost is small is already in the workflow: `ci.yml:190` builds and
   runs the lib **doc** target today and no step builds the lib **test** target.
   Everything below is second-order until this changes.

2. **Enumeration oracles, no fault and no fixture.** Five records are discharged
   wholly or in their load-bearing half by reading the tree, each costing one
   pass: `req-a-a-routed-terminal-carries-no-delivery-acknowledgement` (three
   `written` hooks, none routed),
   `req-a-a-handler-response-is-length-checked-and-never-content-checked` (one
   predicate at `:1031`; `wire.rs:340` accepts the result), the enumeration half
   of `req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation`
   (four entry points, all rechecking), the classification half of
   `req-a-three-control-rejection-paths-carry-three-different-bounds` (three call
   sites, one `written_tx`), and the absence half of
   `req-a-a-handler-outliving-every-host-deadline-is-reached` (seven `HostTiming`
   fields, no request field). Their value is that they **are** the sub-part's
   findings, and a census check in CI is cheaper than a test and catches the
   reintroduction case.

3. **`C1`, a hostile handler.** **This is the highest-value tier**, and it is
   ranked below the enumerations only because those cost less still. Writing one
   handler unblocks four records at fixture cost: the reserve-without-write shape
   gives
   `req-a-a-handler-response-is-length-checked-and-never-content-checked` its
   construction half, the stream-then-unary shape gives
   `req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame` its third
   claimant, the multi-megabyte-error shape gives
   `req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait` its
   request-error half, and the parked shape gives
   `req-a-a-handler-outliving-every-host-deadline-is-reached` its whole state.
   `tests/dispatch.rs:295` and `:665` already demonstrate two of the four shapes,
   so this is an edit rather than an invention.

4. **`C2`, a mismatched direct-output serializer.** One handler using
   `output_from_writer` with a wrong `exact_len` discharges
   `req-a-a-response-publication-failure-never-reaches-the-settling-path`
   outright, with no injection seam, because the failure occurs naturally inside
   the writer at `ring_transport.rs:580-593`. Ranked here because it needs a
   handler shape the suite does not currently have, unlike tier 3's four.

5. **`C8`, a draining host with both request kinds.** Two codes read from one
   client discharges
   `req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes`, which
   currently has no check at any level. Deterministic rather than racy, because
   the write hook sets the fence inside the writer task (`:752-753`). Cheap, and
   ranked below tier 4 only because it needs a two-request pipeline rather than a
   single handler.

6. **`C3`, a hostile `bind`.** A panicking `bind` reaches `dispatch.rs:1164`
   immediately and a blocking one reaches `:1174` under a shrunk
   `lifecycle_callback_deadline`, giving
   `req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining` two of
   its three exits. Ranked here because both exits trip the fatal latch
   (`runtime.rs:186-207`), so the test must tolerate a terminating host, which is
   a harness consideration the other tiers do not have.

7. **`C7` and `C5`, one composed saturation campaign.** A shrunk configuration
   plus parked handlers plus a saturated egress budget plus a slow-reading peer
   reaches all five saturation states, which discharges
   `req-a-both-admission-classes-and-the-rejection-bound-saturate`, the bound
   half of `req-a-handler-concurrency-is-bounded-by-two-class-scoped-permit-pairs`,
   the exhaustion arm of
   `req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired`, and
   the bound half of
   `req-a-three-control-rejection-paths-carry-three-different-bounds`. Four
   records from one campaign is the best ratio on this list; it is ranked seventh
   because the campaign is the most expensive fixture, not because it is
   optional. Every piece has precedent: `tests/dispatch.rs:295`, `:788`, `:976`,
   `:1074`.

8. **A per-correlation egress trace.** The only route to the blast-radius half of
   the pre-dispatch rejection record: which *other* correlations' queued
   terminals `gen.writer.discard()` (`:638`) dropped. It needs the writer queue's
   contents to be observable per correlation, which no current harness provides.
   Ranked above the two remaining capabilities because it confirms the
   highest-consequence `Impact:` sentence in the catalog.

9. **A deterministic close-versus-bind seam.** The only route to `CloseWins` at
   `:1199` through `open_route`, completing the `route.open` record's third exit.
   It needs the close to be marked between `reserve` (`:1127`) and
   `install_bound` (`:1178`). `routing.rs:619` already covers the registry-level
   race, so what is missing is the dispatch-level composition rather than the
   registry mechanics.

10. **Observability of `gen.pending`.** Last, because it is the only fully
    blocked record and it needs either a crate-internal test that constructs a
    `GenerationCore` or a test-only accessor.
    `req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close` is
    producible today through `tests/lifecycle.rs:678` and `:714` and assertable
    nowhere. Note that its own open question — whether the forced path drops the
    `GenerationCore` immediately, making the leak unobservable and therefore
    harmless — is answerable from sub-part 2f's `runtime.rs:1144-1244` without
    any new capability, and that is the cheaper thing to do first.
