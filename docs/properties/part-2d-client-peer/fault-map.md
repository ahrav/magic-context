# Sub-part 2d fault-to-property map

For each of the 14 records, what must actually occur for a test to be
non-vacuous, and whether the harness can produce it today.

Same rules as the earlier parts. Safety checks must hold *while* their faults are
active. Liveness checks need a bounded fault-free window, stated in the units the
code bounds. Rare implementation branches need deterministic injection to be
reachable at all. Coverage checks assert independent preconditions, never the
violation.

Four framing points specific to this sub-part.

**First, the harness situation here is the inverse of 2b's, and that changes what
is cheap.** 2b's dominant obstacle was that nothing ran: 35 in-crate tests and no
CI job that builds the lib target. 2d has the same lib-target problem for its 40
in-crate tests, but it also has something 2b does not: a dedicated integration
binary, `crates/mc-host/tests/client.rs`, whose whole subject is this file, which
runs in CI three times (`ci.yml:132`, `:179`, `:187`), and all six of whose tests
exercise the client as a peer against a real host. So the availability column
below splits two ways rather than one: what a developer can construct locally
against the synthetic-inner harness, and what already runs against a real ring.

**Second, the single richest fixture in this sub-part is not a fault seam. It is
`test_inner` (`client.rs:2270`).** All 40 in-crate tests construct
`Arc::new(Inner { .. })` directly through it, with a pre-populated route set, so a
test can start from any `Inner` state without connecting. Several records are
therefore exercisable with no new infrastructure at all, because their oracles are
direct calls into `retire`, `settle_all`, `admit`, `validate_inbound`, or
`dispatch` on a hand-built `Inner`. That is why the leverage ranking below puts
direct-call oracles above every fault.

**Third, one capability this sub-part lacks does not exist anywhere in the tree,
but it blocks less than this file originally claimed.** There is no fake-host
fixture that can hand the client a chosen inbound frame over the ring.
`tests/support/echo_host.rs` (121 lines) is a **real** in-process host with an
echoing handler, and `tests/support/raw_client.rs` drives the **peer** side against
a real host, which is the mirror image of what 2d needs. Verified by reading both.
The original claim was that this blocks three records. **Disposition correction:
it blocks none of them outright.** Two of the three are constructible by *forging*
the frame instead of soliciting it: `inner.dispatch` takes an
`(EnvelopeHeader, Vec<u8>, ByteCharge)` triple directly and
`an_abandoned_control_open_releases_a_late_bound_route` (`client.rs:3503-3565`)
already hand-builds a `route.open` control `Response` and feeds it in. The third
was blocked on a premise that turned out to have no producer in the current host.
What the missing fixture still costs is *end-to-end confirmation* against a real
ring, which is a different and much weaker claim than first-time constructability.

**Fourth, the correlation-exhaustion state needs a seeded allocator, not a
fault.** This matters because it reads like the hardest thing on the list and is
one of the easiest. Reaching `u64::MAX` through real traffic needs 2^64
admissions; reaching it through the fixture needs one line, because
`max_correlation_is_used_once_then_exhausted` (`client.rs:2328`) already builds a
`Correlations` seeded near the top and
`real_admission_exhausts_after_max_without_second_charge_or_frame` (`:2338`)
already drives a real `admit` from there. See class **C4** and the note on the
demoted record below.

## Fault classes required

`C0` is listed first because it is the cheapest capability here and it is not a
fault at all. `C3` and `C4` are listed as classes for symmetry with the other
parts, but neither is really a fault either, and each row says so.

| Class | Description | Available today |
| --- | --- | --- |
| **C0** test execution in CI | A workflow job that builds and runs the checks a record's oracle would live in | **Partial, and the split is the whole story.** *Integration: yes.* `crates/mc-host/tests/client.rs` is named three times — `ci.yml:132` ("Mandatory ring client suite", Linux, job `shm-crash-recovery` at `:111`), `:178-179` (wrapped `--test client --test lifecycle`, Linux, job `shm-source-build` at `:137`), and `:187` ("Fixed-ring contracts (macOS)"). *In-crate: no.* All 40 in-crate tests execute in no job, because every `-p mc-host` invocation carries a `--test <name>` filter and never builds the lib target; the 13 `mc-host` hits are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`, `:461`, and `:168-169` are `cargo build`. *Doctests: none exist.* `grep -c '```'` over `client.rs` returns 0, so unlike 2b — whose two `compile_fail` doctests run at `ci.yml:190` — **zero checks resident in `client.rs` are CI-executed** |
| **C1** a host that exits without a channel-0 goodbye | The host's ring closing without a preceding channel-0 `Goodbye`, so `read.recv()` yields `None` and `ring_reader_loop` reaches `retire("eof")` (`client.rs:1987`) | **Partial, and the missing half is a fact rather than a seam.** The six integration tests already stop a real host through `host.shutdown_gracefully()`, so *a* host exit is constructible today and CI-protected. What is not established is whether a healthy host emits a channel-0 `Goodbye` **before** its ring closes. If it reliably does, the client sees `connection_goodbye` (`:1397`) rather than `eof` and the record it serves loses most of its force; if it does not, `eof` is the ordinary case. `docs/mc-host-wire-protocol.md` step 4 of graceful shutdown says the host sends a best-effort connection `Goodbye` after the drain, and "best-effort" is exactly the ambiguity. Resolving it is a 2a or 2b question and needs a host-side trace, not a fault |
| **C2** a ring fault behind the bridge | `RingClientEndpoint::send` (`ring_transport.rs:659`) or `try_recv_with` (`:694`) returning `Err`, so the bridge thread breaks at `client.rs:1874` or `:1887` | **No.** There is no seam. The endpoint is constructed inside the thread closure by `attach_with_descriptors` (`:1855`) and is not injectable from outside, the thread's `JoinHandle` is discarded at `:1895` so nothing can even observe which break fired, and no in-crate test constructs the bridge at all (zero hits for `start_ring_bridge` in `mod tests`). Corrupting a real ring from the host side would work in principle but is 2b's `R4`, which that fault map records as having no host-side producer either. This is the single blocking capability for the comparison half of one record and the runtime half of another |
| **C3** a host-originated `Cancel` | A well-formed pure-header `Cancel` frame arriving inbound, so `validate_inbound` falls to `_ => return Err(())` (`client.rs:2067`) | **Yes for the oracle, and no fault is needed.** `validate_inbound` (`:2006`) is a free function taking `&EnvelopeHeader`, and the test module already calls it directly at 41 sites, including `inbound_validation_enforces_the_direct_profile_table` (`:2658-2751`). A `Cancel` header is a value, so the classification claim is a one-line assertion. Only the *end-to-end* form — a real host emitting `Cancel` over the ring and the client retiring — needs the fake host this tree lacks, and that form is optional colour rather than the oracle |
| **C4** correlation exhaustion | `Correlations::allocate` (`client.rs:1735-1739`) returning `None` after `u64::MAX`, so `admit` maps it to `correlations_exhausted` (`:1177-1183`) and `restore`'s `u64::MAX` clause (`:1742-1744`) becomes live | **Yes, and it is a seeded allocator rather than a fault.** Two existing tests already build the state: `max_correlation_is_used_once_then_exhausted` (`:2328`) and `real_admission_exhausts_after_max_without_second_charge_or_frame` (`:2338`), which drives a real `admit` from a seeded `Correlations`. Reaching the state through real traffic needs 2^64 admissions and is not the route. Note that neither existing test asserts anything about `retired`, which is the half the normative document requires (`docs/mc-host-wire-protocol.md:654`) and the half the code does not do |
| **C5** route-map growth driven by a host | A host that binds every `route.open`, so `routes.insert(handle)` (`client.rs:507`) runs repeatedly, and two distinct `route.open` correlations answered with one identical `(channel, epoch)` | **Partial, and the two halves differ.** *Growth: yes but pointless as an oracle.* `echo_host.rs` and `TestHost` bind real routes, so a loop can grow the set — but there is no ceiling to drive it toward, so the oracle is the **absent capacity predicate at `:507`**, which is an enumeration, not a growth test. *Duplicate bind: yes, by forging rather than by soliciting.* Corrected during disposition: the duplicate does **not** need a host that answers two correlations with one handle, because `inner.dispatch` accepts a hand-built control `Response` and `client.rs:3503-3565` already does exactly that for a `route.open` body. Two `open_route` futures over a `Client` built on a synthetic `Inner` plus two forged responses carrying one `(channel, epoch)` produce the state. The `HashSet` merge semantics and the already-cached early return (`:1576-1578`) are separately reachable, and `a_duplicate_bind_terminal_never_closes_an_owned_route` (`:3587`) already reaches the second |
| **C6** a bridge-thread panic | A panic escaping the closure spawned at `client.rs:1854`, so the thread dies without reaching `:1890-1893` | **No, and it is unobservable as well as uninjectable.** There is no `catch_unwind` anywhere in `1-2264`, the thread's handle is discarded at `:1895`, and the thread is the sole producer of write completions (`:1872`), so a panic there is silent: every outbound frame then waits out its own `frame.deadline` at `:1960` and the setup socket closes by process teardown rather than by the goodbye at `:1891`. Contrast the reader task, where a panic **is** reachable in principle through the two `unreachable!()` arms (`:1440`, `:1457`) but is swallowed by `join_tasks_until`'s `let _ = task.await` (`:1691`) with no `retire`. Both need an injectable panic point that does not exist |

Two availability caveats cut across the classes.

**C2 and C6 share an observability problem, not just an injection problem.** Both
land on the detached bridge thread, whose handle is discarded and which has no
completion, status, or error channel other than the per-write `completed` sender
at `:1872`. So an oracle for either must observe the **caller's** disposition or
the **host's** setup socket, never the thread. That is the finding rather than an
obstacle to measuring it, and it is the same shape 2b recorded for `run_endpoint`,
whose `catch_unwind` result is discarded at `ring_transport.rs:279`.

**C1's ambiguity is inherited, and it propagates.** Until a host-side trace
settles whether a graceful host emits a channel-0 `Goodbye` before its ring
closes, every oracle that wants to distinguish a clean host exit from a transport
failure is measuring against an unknown baseline. That is why the record it serves
is `Partial` below rather than `Yes` on the strength of its static half.

## Map

All 14 records, in catalog index order. **"Non-vacuous today" means a developer
can construct the required state with the current harness.** It does not mean the
check runs anywhere: under `C0`, an in-crate oracle runs nowhere and only an
oracle placed in `tests/client.rs` is CI-protected.

Every record is `default-production`, so no row repeats an enabling configuration
gate. `Client::connect` is `pub` and ungated at `client.rs:306`, and three
production call sites outside this crate reach it
(`crates/mc-module/src/bin/ck-mc-host.rs:468`, `:500`, and
`crates/mc-module/src/historian_producer.rs:693`); see the reachability
resolution in `catalog.md` for the full argument.

### The retirement cause

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-a-retired-generation-forgets-why-it-retired | **No fault.** Two direct calls on a synthetic `Inner`: `retire(cause)` with `pending` empty, then any `admit` or `send_control`, asserting the returned code is `connection_retired` (`:1129`, `:1145`) or `generation_retired` (`:2237`) and never `cause`. The comparison run adds one pending entry so the same fault delivers `cause` through `settle_all`'s loop (`:1654-1664`). `test_inner` (`:2270`) supplies the state and `dropped_close_retires_and_repeated_close_joins_tasks` (`:3121`) already retires a synthetic inner | **Yes** — no fault, no fixture work. This is the cheapest record in the sub-part and its oracle is two assertions |
| client-a-a-clean-host-close-and-a-transport-failure-share-one-code | Split. The **static half** — that `:1987` passes the literal `"eof"` regardless of which of the five bridge exits closed the channel — is an enumeration over `:1866`, `:1874`, `:1877`, `:1883`, `:1887`, verified by reading the closure. The **comparison half** the record's recipe describes needs two runs: run A is `C1` and run B is `C2`. Run A is constructible but its baseline is the unresolved question in `C1`; run B has no seam | **Partial** — the static half is discharged by enumeration today; the two-run comparison needs `C2`, which has no seam, and a resolution of `C1`'s ambiguity |

### The departure signal

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye | **No fault for the attempt; the consequence needs more.** The structural claim — that the post-loop block at `:1890-1893` is outside every `break` and branches on nothing — is a read of the closure spawned at `:1854` and is discharged today. The *consequence* is not: `:1890` is `if let Ok(goodbye)` and `:1891` is `let _ = setup.write_all(..)`, so delivery is unproven, and the host's watcher is a `biased` select whose first arm is `peer_read_cancel.cancelled()` (`connection.rs:196-198`), so a generation already retired from ring evidence never evaluates `close != PeerClose::Goodbye` at all. Asserting the under-count needs the write to have landed *and* the watcher to have been armed, plus `C2` to force the fault | **Partial** — moved from `Yes` during disposition, and the only pessimistic movement in this pass. The `Check:` as written is discharged by enumeration; the `Impact:` is conditional on two facts this sub-part cannot establish |
| client-a-a-close-completes-before-its-setup-goodbye-is-written | Two independent preconditions, per the coverage rule: (a) `close()` returned with `within_deadline == true`, which `close_rejects_new_sends` (`tests/client.rs:228`) already produces against a real host in CI; and (b) the bridge thread still inside its loop body or its 50 µs sleep (`:1886`) at that instant. (a) is free. (b) has **no observation point** for the *ordering*: the handle is discarded at `:1895` and the thread exposes no status channel. Partial credit added during disposition for the thread's *termination*, which `tests/shm_soak.rs:35-52` and `tests/shm_failure_modes.rs:193-210` observe through the process thread count after real close cycles, in CI at `ci.yml:130-135` | **Partial** — unchanged verdict, better characterised. The ordering occurs on essentially every close, (a) is CI-protected, and the thread's exit is now known to be CI-observed; what remains unwitnessable is the instant of (b), which needs the `JoinHandle` retained or a test-only status hook |

### In-flight work

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome | **No fault for the per-identity oracle.** N pending entries on a synthetic `Inner` spanning `QUEUED`, `WRITING`, `WRITTEN`, and `CANCELLED`, then one `retire`, asserting the map is empty and each identity received exactly one settlement whose `NotSent` coincides exactly with a won `QUEUED -> CANCELLED` CAS (`:2225`). Two existing tests already drive that CAS from both sides — `cancel_winning_queued_prevents_writer_claim_and_frame` (`:2478`) and `writer_winning_cancel_is_outcome_unknown_and_queues_cancel` (`:2508`) — so the state construction is a fixture edit. The richer "kill the host with N pending" form additionally needs `C1` | **Yes** — the per-identity oracle needs no fault, and METHOD's effect-accounting rule makes it the primary check with the aggregate bound as the cheap screen |
| client-a-no-request-frame-carries-a-non-increasing-correlation | **No fault.** Concurrent `admit` callers plus two ordinary failure inputs to drive both `restore` sites: an oversize body for the encode-or-charge path (`:1196`) and a saturated `data_tx` for the try-send path (`:1209`). `data_capacity_spares_control_reserve_and_does_not_burn_correlation` (`:3155`) already reaches one. The `u64::MAX` clause of `restore`'s guard (`:1742-1744`) needs `C4`, which is a seeded allocator | **Yes** — every input is a fixture parameter, and the one exotic clause is reachable through the seeding pattern that already exists at `:2328` |

### The liveness path

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-a-failed-pong-enqueue-retires-the-generation-as-a-local-fault | **No fault seam, and the original recipe was impossible.** The encode branch (`:1329-1335`) cannot be entered for a `Pong`: `encode_owned_frame` (`wire.rs:571-601`) fails only on `body.len() > MAX_BODY_LEN` and the call passes `Vec::new()`. The record now targets the two branches that *do* run, both of which retire: exhaust `control_budget` (`:399`, funded by `CLIENT_CONTROL_QUEUED_BYTES` at `:76`) to reach `:1340-1347`, or fill `control_tx` to reach `:1355-1361`. Then deliver a `Ping` so the failure arrives through the `let _ =` at `:1390`. `control_exhaustion_retires_and_releases_all_queued_bytes` (`:3196`) already drives the charge branch from another caller | **Yes** — moved from `No` during disposition. The blocker was an unresolved reachability question about a branch that is provably unreachable; removing it leaves two constructible branches with an existing fixture for one of them |
| client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget | The bridge parked in `read_tx.blocking_send` (`:1882`) with the 256-slot inbound channel full — `CLIENT_DATA_QUEUE_FRAMES = 256` (`:59`) was printed and confirmed as the capacity at `:1850` — plus one control frame enqueued at `:1355`. Filling that channel requires `ring_reader_loop` to stop draining it, and the reader is spawned internally with no stall seam. Then a bounded fault-free window per METHOD's liveness rule: release the stall and poll until the write completes within one `frame.deadline` (`:1353`, 30 s per `:45`) | **No** — the precondition needs a way to stall the client's own reader task, which does not exist. `data_saturation_never_starves_a_control_frame` (`:3225`) covers queue-slot starvation, a different mechanism, and reaches admission rather than egress |

### The route cache

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-live-route-handles-are-bounded-only-by-the-host | **No fault.** The check is the absence of a capacity predicate on the insert path: `routes.insert(handle)` (`:507`) tests only `closed` (`:501`), a grep for `CLIENT_MAX_LIVE_ROUTES` returns zero hits, and the two `CLIENT_MAX_*` constants that exist (`:53`, `:55`) are consulted at `:1169` and `:1058` instead. All three facts were re-verified here. Driving real growth through `C5` is possible and proves nothing extra, because there is no ceiling to compare against | **Yes** — enumeration only. Note that the oracle proves an **absence**, so it is discharged by a census over the insert path rather than by a test that passes |
| client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle | Three clauses, and **all three are constructible on the synthetic inner** once the duplicate is forged rather than solicited. The **set semantics** — a repeated insert returns `false` and leaves the set unchanged, so `settle_route` (`:1623`) can remove it at most once — is a property of `HashSet<RouteHandle>` (`:944`). The **cleanup block** — `release_stranded_route` returning early at `:1576-1578` when the route is already cached — is already reached by `a_duplicate_bind_terminal_never_closes_an_owned_route` (`:3587`). The **two-successful-opens** clause needs two `open_route` futures over a `Client` built on a synthetic `Inner` (the struct literal at `:431` is reachable from `mod tests`) plus two forged control `route.open` `Response` bodies carrying one `(channel, epoch)`, fed through `inner.dispatch`. That exact forging already exists: `an_abandoned_control_open_releases_a_late_bound_route` (`:3503-3565`) hand-builds `{"op":"route.open","route_channel":..,"route_epoch":..}` at `:3547-3552` and dispatches it at `:3553-3565` | **Yes** — moved from `Partial` during disposition. The earlier `Partial` said this clause "needs the fake host this tree lacks", which contradicted leverage item 5 of this same file (`:326-331`), which proposes the forging route. Leverage item 5 was right |

### Host answers taken as proof

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-host-shutdown-success-rests-only-on-a-json-echo | **No fault for the check as written.** The acceptance predicate is total over responses: `host_shutdown` (`:576-615`) returns `Ok(())` if and only if the body parses as JSON with `op == "host.shutdown"` (`:598-606`), else `invalid_shutdown_response` (`:607-613`). Feeding it a chosen control `Response` body on a synthetic inner exercises both arms. The **"the stop was not real"** demonstration — answer the echo, keep serving, show the caller's next operation succeeds — needs a fake host | **Yes** for the predicate. Worth flagging that nothing exercises `host_shutdown` at any level today: no in-crate test calls it, and the six integration tests stop the host through `host.shutdown_gracefully()`, a harness path. So this is a `Yes` with zero existing coverage behind it |
| client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind | **Restated during disposition; no fault, and the original recipe has no producer.** The check as restated is an enumeration over the host's bind exits at `dispatch.rs:1177-1238`: `Installed` emits success (`:1178-1193`), `CloseWins` emits nothing (`:1195-1202`), `Reject` calls `take_rejected_bind` (`:1219`, cancelling and marking `Closing` per `routing.rs:191-205`) *before* `emit_error_terminal` (`:1229-1236`), and the stopped-callback arm emits nothing (`:1164-1170`). So no exit both installs a bind and answers with an error. `module_timeout` has no producer anywhere outside the client's own allowlist (`client.rs:518`), by grep. The **original** recipe — a peer that answers a retried code *and* binds — therefore requires a non-conforming peer, which is a fake host plus a framing decision | **Yes** for the restated check, by enumeration; moved from `No`. The blocked half is now explicitly a test of the client against a host protocol violation, which the biases section refers to a human rather than to a fixture |

### Inbound classification

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| client-a-a-host-originated-cancel-retires-the-generation | **No fault**, per `C3`. `validate_inbound` (`:2006`) is a free function and the test module calls it directly at 41 sites, so asserting that a `Cancel` header falls to `_ => return Err(())` (`:2067`) is one line, and asserting that `ring_reader_loop:1979` turns that into `retire("protocol_violation")` is a second read of an already-enumerated path. The end-to-end form needs the fake host and is optional | **Yes** — and it is currently unasserted. This synthesis verified that `inbound_validation_enforces_the_direct_profile_table` (`:2658-2751`) mentions exactly one of the five residue types, `FrameType::Request` at `:2750`, and says nothing about `Cancel` |
| client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production | **No fault.** Two things asserted together: a marker at `:1557` that must not fire during any production-path campaign, and the independent observation that `validate_inbound` returned `Err` for the same five frame types (`Request`, `Cancel`, `Pong`, `Hello`, `HelloAck`, per `wire.rs:52-63`). `dispatch`'s only non-test caller is `:1982`, so the production path is a single edge to check | **Yes** — enumeration plus a never-firing marker. Note the marker's placement constraint below: it belongs at the classification point, not after it |

**Totals: 10 fully non-vacuous today, 3 partial, 1 not constructible.** Revised
during disposition from 8 / 3 / 3; see
[portfolio-evaluation.md](portfolio-evaluation.md) for the four row moves. The ten
are `client-a-a-retired-generation-forgets-why-it-retired` in full, both
in-flight-work records, the route-bound record, the `host_shutdown` predicate,
both inbound-classification records, the reframed failed-`Pong`-enqueue record,
the duplicate-bind record, and the restated route-open retry record. The three
partial ones are the `eof` comparison, the close-ordering `sometimes`, and the
ring-failure departure record, whose consequence was demoted from proved to
conditional. The one blocked record is the `Pong` egress bound, which still has no
reader-stall seam.

Note the shape of that ten: **eight of them need no fault at all.** The earlier
text said six, which undercounted by two: every one of the eight rows that carried
a `Yes` before this disposition opens with "No fault", and the two rows that moved
to `Yes` need no fault either. Counting the rows that prescribe no fault or a pure
enumeration over the whole table gives ten of fourteen. That is what cataloging a
post-refactor client surface for the first time produces — most of these records
are statements about code that is missing, about a total classification function,
or about an ordering readable in another file — and it is the same shape 2b
reported.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically.

**The lens produced exactly one `sometimes` record and it complies with the
METHOD coverage rule, so it is not duplicated here.**
[client-a-a-close-completes-before-its-setup-goodbye-is-written](catalog.md#client-a-a-close-completes-before-its-setup-goodbye-is-written)
asserts two independent preconditions jointly: `close()` observed returning with
`within_deadline == true`, and the bridge thread observed still inside its loop
body or its sleep at that moment. Verified against the rule. It is not paired with
any `always(!X)`; neither precondition is a violation; and both are legal on a
correct build, because `join_tasks_until` (`:1677-1695`) is *specified* to join
only `[&self.writer, &self.reader]` (`:1682`) and the bridge is *specified* to
poll at 50 µs (`:1886`). The record's own `Required faults and enabling state:`
line already says "Assert both, never the misclassification itself". So it needs
no companion marker, and the canonical name below is a reference to that record
rather than a new check.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `client_retire_ran_with_an_empty_pending_map` | `retire` (`:1667`) executed while `pending` held no entries | The ordinary shape of any retirement on an idle connection. Records the precondition of the cause erasure without asserting that the cause was lost |
| `client_retire_ran_with_at_least_one_pending_entry` | `retire` executed with at least one pending entry, so `settle_all`'s loop (`:1654-1664`) delivered the cause to someone | The complementary legal case, and the one that shows the information exists at the moment it is discarded. Together the pair is the finding; neither alone is a defect claim |
| `client_reader_observed_the_inbound_channel_closed` | `read.recv()` returned `None` and `ring_reader_loop` reached `:1987` | Legal on every connection teardown, clean or otherwise. The precondition of the `eof` conflation, stated as the control-flow fact it is |
| `client_bridge_thread_left_its_loop_on_a_transport_break` | The bridge exited at `:1874`, `:1877`, `:1883`, or `:1887` rather than through the `:1866` loop condition | A legal outcome the code has four explicit branches for. Does **not** assert what the caller then observed |
| `client_bridge_thread_wrote_its_setup_goodbye` | `:1891` executed, attempting the `write_all` of the encoded goodbye | The deliberate current behaviour, unconditional by construction. Recording it is what makes the peer-death misattribution provable without asserting the misattribution |
| `client_close_returned_within_its_shutdown_deadline` | `close` returned with `within_deadline == true` (`:1677-1695`) | The success path of every ordinary close, already produced by `close_rejects_new_sends` (`tests/client.rs:228`) in CI |
| `client_settle_all_took_a_non_empty_pending_map` | `settle_all` executed `std::mem::take` (`:1651-1652`) over a non-empty map under the `admission` mutex | The designed bulk-settlement path. The precondition of the per-identity exactly-once oracle |
| `client_cancel_classification_lost_the_queued_cas` | `cancel_classification`'s `QUEUED -> CANCELLED` compare-exchange (`:2225`) failed, so `classify` (`:2215`) ran instead | Legal and the expected outcome whenever the writer's `claim_for_write` (`:1939-1945`) won the race. It is the precondition of `OutcomeUnknown` being correct, not of anything being wrong |
| `client_correlations_restore_rewound_the_last_allocation` | `restore` (`:1741-1747`) matched its guard and rewound `self.next` | Legal by design on both call sites (`:1196`, `:1209`), each of which precedes any delivery to `data_tx`. Records the rewind without asserting that a rewound value reached the wire |
| `client_send_control_returned_err_from_a_retiring_branch` | `send_control` returned `Err` from the charge branch (`:1340-1347`) or the try-send branch (`:1355-1361`), both of which retire | Legal: both are the specified behaviour on reserved-control exhaustion, and the comment at `:1336-1339` argues for exactly this pool choice. Renamed and retargeted during disposition: the original marker named the encode branch (`:1329-1335`) as "the one path that does not retire", and that branch is unreachable for a pure-header frame, so a marker there could never fire and its silence would have proved nothing |
| `client_ping_arm_discarded_a_send_control_error` | The `let _ = self.send_control(FrameType::Pong, ..)` at `:1390` received an `Err` | Legal by construction, since the call site binds the result to `_`. The independent companion to the marker above: together they witness that a probe went unanswered and that nothing at the probe's own call site recorded it |
| `client_bridge_thread_parked_in_blocking_send` | The bridge entered `read_tx.blocking_send` (`:1882`) on a full 256-slot channel | Ordinary backpressure, and exactly the design the reserved control pool exists to survive on the admission side. The precondition of the egress bound, not a claim that the bound was exceeded |
| `client_route_insert_returned_false` | `routes.insert(handle)` (`:507`) returned `false`, so the handle was already present | A legal `HashSet` outcome. Records the merge without asserting cross-caller interference |
| `client_route_open_inserted_without_a_capacity_test` | A successful `open_route` reached `:507` having consulted `closed` (`:501`) and no length predicate | True of every insert today and legal, since no cap exists. This is the honest form of the unbounded-routes finding: a fact about the code path, not an outcome |
| `client_open_route_retried_after_a_host_terminal` | `open_route` retried at `:511-525` after one of the four allowlisted codes | Legal and the documented remedy. The precondition of the attempted-versus-acknowledged accounting, with no claim about how many binds the host made |
| `client_host_shutdown_accepted_an_op_echo` | `host_shutdown` returned `Ok(())` on the `op == "host.shutdown"` predicate (`:598-606`) | The ordinary success path. Recording that the echo is the whole local evidence is the finding; asserting the host did not stop is not something the client can observe |
| `client_validate_inbound_rejected_a_residue_frame_type` | `validate_inbound` returned `Err` from `:2067` for one of `Request`, `Cancel`, `Pong`, `Hello`, `HelloAck` | Legal and the specified behaviour for four of the five. It is the independent companion to the never-firing marker at `:1557`, and it is what makes that marker's silence meaningful rather than vacuous |

One record's oracle is a marker that must **not** fire, and it is listed
separately because it is not a coverage check.
[client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production](catalog.md#client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production)
needs a marker at `client.rs:1557` that stays silent for a whole production-path
campaign, paired with `client_validate_inbound_rejected_a_residue_frame_type`
above. The pairing is what distinguishes "the arm is unreachable" from "the
campaign never sent a residue frame type", and without the companion the silence
proves nothing.

**Anti-patterns to avoid in this sub-part specifically.** Five pairings are
forbidden by METHOD's rule, and each is tempting here because in every case the
defect is easier to name than its precondition.

- Do not pair `always(post_retirement_code_names_the_cause)` with
  `sometimes(post_retirement_code_is_a_constant)`. The second marker can only
  fire by observing the erasure, and the erasure is total: `Inner` (`:934-960`)
  has no cause field, so the "violation" is the only behaviour there is. Assert
  `client_retire_ran_with_an_empty_pending_map` and
  `client_retire_ran_with_at_least_one_pending_entry` instead: two independent
  legal preconditions, both present on a correct build.
- Do not pair `always(!clean_goodbye_after_a_transport_failure)` with
  `sometimes(clean_goodbye_after_a_transport_failure)`. Assert
  `client_bridge_thread_left_its_loop_on_a_transport_break` and
  `client_bridge_thread_wrote_its_setup_goodbye` as two independent facts. The
  post-loop block is unconditional by construction (`:1890-1893`), so a marker
  that requires the *conjunction to be wrong* is asserting the defect.
- Do not pair `always(not_sent_implies_never_published)` with
  `sometimes(not_sent_for_a_delivered_request)`. The second can only fire by
  observing the replay hazard, which is the one outcome this client is designed to
  make impossible. Assert `client_cancel_classification_lost_the_queued_cas`,
  which is the legal half of the same race and is present on every correct run.
- Do not pair `always(routes.len() <= CLIENT_MAX_LIVE_ROUTES)` with
  `sometimes(routes.len() > CLIENT_MAX_LIVE_ROUTES)`. There is no such constant,
  so the `always` half is vacuous and the `sometimes` half can never fire against
  a bound that does not exist — the pairing would read as passing coverage
  forever, which is exactly the failure mode 2b recorded for the quarantine
  assertions. Assert `client_route_open_inserted_without_a_capacity_test`.
- Do not pair `unreachable(dispatch_catch_all)` with
  `sometimes(dispatch_catch_all_entered)`. That is the same illegal shape in
  location form. Pair the never-firing marker at `:1557` with
  `client_validate_inbound_rejected_a_residue_frame_type` instead.

Two further constraints on marker placement here.

**Place a marker where its precondition becomes true, not where the code finishes
depending on it.** The bridge thread reaches `:1890-1893` on every exit and then
closes the socket, so a marker placed after `:1893` cannot distinguish a
transport break from cancellation. It belongs at each `break` site.

**Do not place any marker after `join_tasks_until` returns.** `client.rs:1691` is
`let _ = task.await` after an abort, so a panicking reader or writer task is
swallowed there with no `retire` and no error value. A marker after the join sees
an orderly close on every path, panicking or not.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put the fake host
at the top, and that is the wrong answer here.

**The cheapest item on this list is not a fault and not a new test. It is running
the 40 in-crate tests that already exist.** State that plainly, because the
natural reading of a 14-record catalog is that new tests are the bottleneck. They
are not, and 2d is in a strictly better position than 2b was, because it already
has a CI-protected integration binary to put new oracles into.

1. **`C0`, running the existing in-crate suite in CI.** A workflow change and
   nothing else: add an `mc-host` lib target invocation alongside the existing
   `--test` steps. It unblocks **zero** new records and protects **40 existing
   test functions**, all of which were individually confirmed to be real test
   `fn`s. The proof that the wiring cost is small is already in the workflow:
   `cargo test -p mc-host --doc` runs at `ci.yml:190`, so the lib **doc** target
   is built today and the lib **test** target is not. Everything below is
   second-order until this changes for any oracle placed in-crate. The alternative
   for a given record is to place its oracle in `tests/client.rs`, which is
   CI-protected today, and that is the right call for anything needing a real
   host.

2. **Enumeration oracles, no fault and no fixture.** Four records are discharged
   by reading the tree rather than by running anything, each costing one pass:
   `client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye` (the
   post-loop block is outside every `break`, and `connection.rs:200` gates the
   counter on the message),
   `client-a-live-route-handles-are-bounded-only-by-the-host` (no capacity
   predicate at `:507`; zero hits for `CLIENT_MAX_LIVE_ROUTES`),
   `client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production`
   (`dispatch`'s only non-test caller is `:1982`, and `validate_inbound:2067`
   rejects all five residue types), and the static half of
   `client-a-a-clean-host-close-and-a-transport-failure-share-one-code` (five
   bridge exits, one handler at `:1987`). Their value is that they **are** the
   sub-part's findings, and a census check in CI is cheaper than a test and
   catches the reintroduction case.

3. **Direct-call oracles on the synthetic-inner harness that already exists.**
   Four more records need no new infrastructure whatsoever, because `test_inner`
   (`:2270`) already builds arbitrary `Inner` states and the suite already calls
   `retire`, `admit`, `dispatch`, and `validate_inbound` directly:
   `client-a-a-retired-generation-forgets-why-it-retired` (two assertions),
   `client-a-a-host-originated-cancel-retires-the-generation` (one assertion on a
   `Cancel` header, and currently absent — verified),
   `client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome`
   (a fixture edit over the two existing CAS-race tests at `:2478` and `:2508`),
   and `client-a-no-request-frame-carries-a-non-increasing-correlation` (a fixture
   edit over `:3155`). **This is the highest-value tier**, because it converts four
   records from `not yet` to exercised at fixture cost, and it is ranked below the
   enumerations only because those cost less still.

4. **`C4`, a seeded allocator rather than a fault.** Seeding `Correlations` near
   `u64::MAX` through the pattern already used at `:2328` and `:2338` makes the
   `u64::MAX` clause of `restore`'s guard (`:1742-1744`) live, completing the
   correlation record's second window. It also reconstructs the record lens A
   demoted: `client-a-correlation-exhaustion-does-not-retire-the-generation`,
   which held that `admit` returns `correlations_exhausted` (`:1177-1183`) with
   `SendOutcome::NotSent` and calls no `retire`, contrary to
   `docs/mc-host-wire-protocol.md:654`. Lens A demoted it as the lowest-impact
   finding in the pass because reaching the state needs 2^64 admissions, and lens
   B preserved its full substance and test recipe as claim C3. **Ranked here
   deliberately**, because the demotion was about impact and not about cost: the
   state is a one-line fixture seeding and the two existing tests both stop one
   assertion short of it, neither asserting anything about `retired`. If a later
   pass wants the fifteenth record, this is the cheapest thing in the catalog to
   reinstate.

5. **A forged control `route.open` response on the synthetic inner.** That gives
   `client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle` its
   two-successful-opens clause without a real host, by feeding `dispatch` two
   control `Response` bodies carrying one `(channel, epoch)`. Ranked below tier 3
   because it needs a body-construction helper the suite does not have, and
   `parse_route_open` (`:2167-2206`) validates only shape so the helper is small.
   **Disposition note: the helper largely exists.**
   `an_abandoned_control_open_releases_a_late_bound_route` (`:3503-3565`) already
   builds a `route.open` response body by hand at `:3547-3552` and dispatches it
   at `:3553-3565`, so this tier is a copy plus a second `open_route` future over
   a `Client` built on the synthetic `Inner`. This item is also what corrected the
   map row above, which had claimed the same clause needed a fake host. Two places
   in one file disagreed and the ranking was right.

6. **A bridge-thread observation point.** Retaining the `JoinHandle` in `Inner`,
   or exposing a test-only thread-state signal, supplies precondition (b) of
   `client-a-a-close-completes-before-its-setup-goodbye-is-written` — the one
   `sometimes` record, currently unwitnessable rather than unreachable. It is a
   production code change, which is why it is ranked here and not higher, and the
   catalog makes no changes. Note that joining under the existing 5 s shutdown
   budget would also *close* the window the record describes, so the observation
   and the remedy are the same edit; that is a design decision for a human.

7. **`C2`, a ring-fault seam behind the bridge.** The only route to the comparison
   half of `client-a-a-clean-host-close-and-a-transport-failure-share-one-code`
   and to the runtime confirmation of the departure-signal record. It needs an
   injectable failure inside `RingClientEndpoint::send` or `try_recv_with`, which
   is a production seam, and 2b's fault map records the host-side analogue (`R4`)
   as equally unavailable. Pair it with a host-side trace resolving `C1`, because
   without that baseline the comparison has nothing to compare against.

8. **A reader-stall seam.** The only route to
   `client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget`,
   because filling the 256-slot inbound channel (`:59`, `:1850`) requires
   `ring_reader_loop` to stop draining it and the reader is spawned internally.
   Ranked below `C2` because it serves one record where `C2` serves two.

9. **A fake host that answers chosen frames.** The expensive item, and the one
   this tree has no starting point for: `echo_host.rs` is a real host and
   `raw_client.rs` is the peer side. It would give the retry, duplicate-bind,
   `host_shutdown`, and `Cancel` records their end-to-end forms. Three cautions
   before anyone starts, the third added during disposition. First, all four of
   those records already have a cheaper valid oracle in tiers 2, 3, and 5, so the
   fake host buys end-to-end confirmation rather than first-time constructability;
   the original text said "three of those four", and after the retry record was
   restated it is four of four. Second, the retry record's remaining half needs a
   peer that answers a retried terminal *after* installing a bind, which no
   conforming host does — `take_rejected_bind` runs before `emit_error_terminal`
   at `dispatch.rs:1219` and `:1229` — so the fixture would be simulating a host
   protocol violation. Third, and consequently, building it is downstream of a
   framing decision a human owns: whether defending this client against a lying
   host is in scope at all. See the biases section of
   [portfolio-evaluation.md](portfolio-evaluation.md).

10. **An injectable panic point.** Last, because it serves the two records this
    catalog does **not** contain: a bridge-thread panic (`C6`) and a reader-task
    panic through the `unreachable!()` arms at `:1440` and `:1457`. Both are
    recorded as quiet areas in
    [existing-checks.md](existing-checks.md) rather than as records, because
    neither is injectable and, for the bridge, neither is observable. If a panic
    seam is ever added for another reason, both should be revisited: the reader
    case in particular is the one inbound fault that does **not** retire the
    generation, since `join_tasks_until` swallows the `JoinError` at `:1691` and
    every pending caller then waits out its own deadline.
