# Lens A, sub-part 2d: the client as a protocol peer

Attention focus: what `crates/mc-host/src/client.rs` assumes about the host, what
it does when those assumptions break, and whether it upholds the duties the wire
protocol places on a peer. The host side of every contract named here is already
cataloged by Parts 1, 2a, 2b, and 2c and is cited, not re-derived.

Code read at `feat/shared-memory-release-gate-audit`, `e447c927`. Every line
reference below was checked against that tree.

## Reachability resolution, done once and applied per record

Every record in this file is labelled `default-production`, and the label rests on
the same four verified facts rather than on a preamble assertion:

1. `Client::connect` is `pub` at `client.rs:306` and carries no `cfg` gate.
2. It reaches the ring through `connect_info` (`client.rs:343`), then
   `start_ring_bridge` (`client.rs:378`), then
   `RingClientEndpoint::attach_with_descriptors` (`client.rs:1855`,
   defined `ring_transport.rs:636`). None of those is `cfg`-gated.
3. Production callers exist outside this crate.
   `crates/mc-module/src/bin/ck-mc-host.rs:468` and `:500` call
   `Client::connect`, and that binary is described by its own manifest as "the
   production lifecycle/serve executable"
   (`crates/mc-module/Cargo.toml:18-19`). `ManagedConnector::connect` at
   `crates/mc-module/src/historian_producer.rs:693` calls it as well, and is not
   inside a test module. `docs/mc-host-wire-protocol.md:808` names
   `HistorianProducer` as a `mc_host::Client` consumer.
4. The doc comment "Thread-confined peer endpoint for integration tests" at
   `ring_transport.rs:626` is therefore **wrong about reachability**, confirming
   the sibling finding the task prompt flagged. `RING_PROFILE` being spelled
   `"mc-host-test-ring-v1"` (`ring_transport.rs:31`) is likewise a misleading
   name, not a gate.

Where a record's own trigger is narrower than the connect path, the record says so
in its `Required faults and enabling state:` line. No record here is
`test-only`; two code points are noted as production-unreachable inside a
`default-production` module, and those are typed `reachability` with
`unreachable` semantics.

## Client state machine map

There is no reconnect state inside `client.rs`. The whole file is one generation.

| Phase | Entry | Code | Exit on success | Exit on failure |
| --- | --- | --- | --- | --- |
| Discover | `connect` | `:306-343` | `ConnectionInfo` | `handshake_timeout`, `discovery_failed` |
| Dial | `connect_info` | `:347-350` | connected `UnixStream` | `handshake_timeout`, `dial_failed` |
| Authenticate | `authenticate_client` | `:358-364` | `daemon_ver` | `handshake_timeout`, `authentication_failed` |
| Activate and grant | `activate_client` | `:366-369` | descriptor plus 2 fds | `setup_failed` |
| Attach ring | `start_ring_bridge` | `:378-384`, `:1842-1901` | bridge thread ready | `setup_failed` |
| Spawn I/O | writer, reader | `:409-417` | two `JoinHandle`s | none |
| Post-setup recheck | `retired` load | `:425-430` | `Ok(Client)` | `connection_retired` |
| Steady state | `open_route`, `request`, `request_stream`, `cancel`, `host_status`, `host_shutdown` | `:445-668` | per call | per call |
| Route teardown | `close_route` | `:565-573` | route `Goodbye` acked | `shutdown_timeout` |
| Owner close | `close` | `:671-721` | routes drained, tasks joined | `shutdown_timeout` |
| Involuntary retire | `retire` | `:1667-1675` | n/a | terminal |

Four distinct budgets bound the phases: a single 2-second absolute handshake
deadline started **before** discovery (`:314`), a 30-second frame deadline
(`:45`), a 30-second route-open deadline including backoff (`:47`), and a
5-second shutdown deadline (`:51`). These match the protocol's own table at
`docs/mc-host-wire-protocol.md:736-743` exactly.

### Retirement is the only involuntary transition, and it has four causes

`retire` (`:1667`) is idempotent through `retired.swap` (`:1668`), sets `closed`
(`:1671`), settles every pending entry (`:1672`), clears the route cache
(`:1673`), and cancels the token (`:1674`). Its callers and codes:

| Code | Site | Meaning |
| --- | --- | --- |
| `connection_goodbye` | `:1397` | inbound channel-0 `Goodbye` |
| `protocol_violation` | `:1979`, `:1557` | `validate_inbound` rejected a frame |
| `eof` | `:1987` | the inbound channel from the bridge thread closed |
| `write_failed` | `:1954`, `:1963` | a ring write did not complete |
| `control_capacity_exhausted` | `:1341`, `:1356` | reserved control admission failed |
| `invalid_route_response` | `:486` | a successful `route.open` named no route |
| `stranded_route_cleanup_failed` | `:1588` | a late-bind `Goodbye` could not be queued |
| `owner_drop`, `owner_close_dropped`, `shutdown_timeout` | `:744`, `:766`, `:676` | local lifecycle |

The code is passed to `settle_all(code)` (`:1672`) and becomes each pending
caller's `CallError::code()`. It is **not stored on `Inner`**; `Inner`'s fields
(`:934-960`) hold no cause. See `client-a-a-retired-generation-forgets-why-it-retired`
and `client-a-a-clean-host-close-and-a-transport-failure-share-one-code`.

### What persists across a reconnect

Nothing. `client.rs` has no reconnect path. Recovery is the caller's:
`ProducerConnector::reconnect` at
`crates/mc-module/src/historian_producer.rs:699` is a separate trait method, and
`ManagedConnector::connect` (`:693`) builds a fresh `Client`. A fresh `Client`
means a fresh `Inner` (`client.rs:387-407`) with `Correlations::new(1)`
(`:393`, `:1731`), an empty `routes` set (`:397`), an empty `pending` map
(`:395`), and four fresh `ByteCounter`s (`:398-401`). Correlations restarting at
1 is correct rather than a watermark violation, because the host's watermark is
per generation (`docs/mc-host-wire-protocol.md:656`) and a new connection is a
new generation.

`docs/mc-host-wire-protocol.md:12` diagrams a client `Recovering` state with
"bounded backoff, reread file". The Rust client implements no such state. See
the contract leads.

## Assumptions about the host

Ordered by how much the client stakes on an unvalidated host claim.

| # | Host claim | Client validation | Verdict |
| --- | --- | --- | --- |
| 1 | `host.shutdown` succeeded | body echoes `{"op":"host.shutdown"}` only (`:598-613`) | **unvalidated effect.** The doc comment at `:575` calls `Ok` "the stop linearization point the native lifecycle owner waits on". A JSON echo is the entire evidence. See `client-a-host-shutdown-success-rests-only-on-a-json-echo`. |
| 2 | this `(channel, epoch)` is yours | `op`, nonzero `u16` channel, nonzero `u32` epoch (`:2167-2206`) | **partial.** No check that the handle is not already live; `routes.insert` (`:507`) on a `HashSet` silently merges. See `client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle`. |
| 3 | `route.open` failed with `module_timeout` | code matched against a four-item allowlist, then retried (`:511-525`) | **trusted as proof of no bind.** See `client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind`. |
| 4 | `host.status` health | `deny_unknown_fields`, `op` echo, health in `{ok,degraded,failing}` (`:620-663`) | **validated.** `metrics` is opaque but byte-bounded by `:2015`. |
| 5 | terminal error text | code filtered to `[A-Za-z0-9_.-]`, 128 bytes (`:2248-2259`); message discarded (`:169-175`) | **validated and redacted.** Good. |
| 6 | frame header well-formed | `validate_inbound` (`:2006-2082`) enforces the §6.3 identity table per type | **validated**, and stricter than the doc for one type. See `client-a-a-host-originated-cancel-retires-the-generation`. |
| 7 | body length matches header | rechecked in the reader (`:1978`) after the bridge already decoded it | **validated twice.** |
| 8 | channel-0 body within §7.1 | `header.len > MAX_CONTROL_BODY_LEN` rejected on the header (`:2015`) | **validated**, with the allocation rationale at `:2010-2014`. |
| 9 | a `Push` is meaningful | none; dropped at `:1405` with no counter | **discarded silently.** Doc `:256` calls `Push` "reserved ... host does not emit it in this profile", so compliant, but unobservable if it ever happens. |

The producer shape the task asked about (advancing durable state on an
acknowledgement truthful about nothing) is present as assumption 1, and it is the
most consequential finding in the table.

## Observations

All references verified at `e447c927`.

**O1. The retirement cause is not retained.** `retire` (`client.rs:1667`) takes a
`&'static str` and forwards it only to `settle_all` (`:1672`). `Inner`
(`:934-960`) has no field for it. Any caller arriving after retirement gets the
constant `"connection_retired"` from `admit` (`:1126-1131`) or
`"generation_retired"` from `send_control` (`:1327`, via `retired_error` at
`:2234`). So the cause is observable only by a caller that already held a pending
entry at the instant of retirement.

**O2. `eof` conflates a healthy host exit with a ring transport failure.**
`ring_reader_loop` calls `retire("eof")` at `:1987` when `read.recv()` yields
`None`. That channel closes when the bridge thread leaves its loop, which happens
on: an `endpoint.send` failure (`:1870-1874`), `write_rx` disconnection (`:1877`),
`read_tx.blocking_send` failure (`:1882`), a `try_recv_with` error (`:1887`), or
cancellation (`:1866`). A host that exits without sending a channel-0 `Goodbye`
produces the same `Ok(None)`-then-close sequence. Part 2b's
`ring-a-publish-failure-is-reported-as-a-clean-peer-close` is the host-side half:
the host converts its own publish failure into a clean close, so the client's
`eof` is the only signal it gets for either case.

**O3. The bridge thread writes a setup-socket `Goodbye` on every exit path.**
`client.rs:1890-1893` runs `encoded_goodbye` then `shutdown(Both)`
unconditionally after the loop, including after the transport-failure `break`s at
`:1874`, `:1883`, and `:1887`. On the host side `connection.rs:199-206` observes
that socket and calls `record_peer_death()` **only** when the close is not
`Goodbye` (`:200`). So a client whose ring collapsed departs looking clean, and
the host's peer-death counter under-reports transport faults.

**O4. `close()` can cancel the writer without ever sending the connection
`Goodbye`.** In `close` (`:671`), the per-route `Goodbye` loop `break`s on the
first failure at `:696`, the connection `Goodbye` at `:699-710` is guarded by
`result.is_ok()`, and `self.inner.cancel.cancel()` at `:711` runs regardless.
The bridge thread then still writes its setup-socket `Goodbye` (O3), so the host
sees a clean setup close with no frame-level connection `Goodbye`.

**O5. The bridge thread is detached and never joined.**
`std::thread::Builder::spawn` at `:1852-1894` discards the `JoinHandle` (only
`map_err` is applied, `:1895`). `join_tasks_until` (`:1677-1695`) joins the
writer and reader Tokio tasks only (`:1682`). So `close()` returning `Ok` does
not prove the setup-socket `Goodbye` reached the socket, nor that the thread
exited. It also busy-polls: `Ok(None)` sleeps 50 microseconds (`:1886`), so one
idle connection spins an OS thread at roughly 20 kHz.

**O6. Correlation allocation and enqueue are atomic.** In `admit` (`:1119`), the
`correlations` guard is taken at `:1176` and lives to the end of the function
(`:1217`). Allocation (`:1177`), frame encoding (`:1186`), and
`data_tx.try_send` (`:1207`) all happen under it, with the `admission` mutex
(`:1140`) and the `pending` mutex (`:1141`) held too. Enqueue order therefore
equals allocation order, which is exactly what
`docs/mc-host-wire-protocol.md:656` obliges of a sender.

**O7. `Correlations::restore` is guarded to the last allocation and to
never-sent frames.** `restore` (`:1741-1747`) only rewinds when
`self.next == correlation + 1`, or for the `u64::MAX` exhaustion case. Its two
call sites are `:1196` (frame encode or byte charge failed) and `:1209`
(`data_tx.try_send` failed, which returns the frame to the caller rather than
delivering it). Neither can follow a frame reaching the writer.

**O8. Correlation exhaustion returns an error and leaves the generation live.**
`Correlations::allocate` returns `None` after `u64::MAX` (`:1735-1739`, via
`checked_add`). `admit` maps that to `correlations_exhausted` (`:1177-1183`) and
returns. No `self.retire(...)` on that path.
`docs/mc-host-wire-protocol.md:654` says "before another request, sender MUST
retire the generation and reconnect."

**O9. A failed `Pong` enqueue is discarded.** `dispatch`'s `Ping` arm at
`:1388-1396` writes `let _ = self.send_control(...)`. Two of `send_control`'s
three failure modes do retire the generation loudly (`:1341`, `:1356`), but the
encode failure at `:1329-1335` returns `Err` without retiring, and the
already-retired early return at `:1326` is benign. So an encode failure drops the
`Pong` with no local trace while the host's probe runs down.

**O10. Inbound backpressure stalls outbound, including the `Pong`.**
`writer_loop` hands bytes to the bridge (`:1947-1956`) then awaits `completed_rx`
under `timeout_at(frame.deadline, ...)` (`:1957-1961`). Only the bridge thread
sends that completion (`:1872`), and the bridge can be parked in
`read_tx.blocking_send` (`:1882`) when the 256-slot inbound channel
(`:1850`) is full. Control frames carry `deadline = now + CLIENT_FRAME_TIMEOUT`
(`:1353`), so the client tolerates a 30-second egress stall before
`retire("write_failed")` (`:1963`). The per-write ring bound is separately
2 seconds, hardcoded in `RingClientEndpoint::send`
(`ring_transport.rs:663-667`), and ignores the frame deadline entirely.

**O11. Live routes are unbounded.** `CLIENT_MAX_PENDING_REQUESTS` (`:53`) caps
`pending` at `:1169`; `CLIENT_MAX_LIVE_STREAMS` (`:55`) caps `streams` at
`:1058`. There is no `CLIENT_MAX_LIVE_ROUTES`; `routes.insert` at `:507` is
unguarded. Reapers exist: `settle_route` (`:1623`), `retire` (`:1673`), and
`close` (`:684`). `docs/mc-host-wire-protocol.md:658` requires finite limits for
"live connections, routes, pending correlations, handler tasks, queued requests,
and aggregate buffered bodies" and names routes explicitly.

**O12. A duplicate host bind collapses.** `routes` is a `HashSet<RouteHandle>`
(`:944`), so re-inserting a live handle at `:507` is a no-op and two callers hold
one entry. `settle_route` (`:1623`) removes it once, settling both callers'
pending work and leaving the second caller with `route_not_live` thereafter.
`release_stranded_route` cannot clean it either: it returns early when the route
is already cached (`:1576-1578`), which is the correct behaviour for the case
§8.2 describes but means a genuine duplicate bind is never released.

**O13. `open_route` retries on four host terminals.** `:511-525` retries when
`outcome == Terminal` and the code is one of `unknown_module`,
`module_reloading`, `target_unavailable`, or `module_timeout`, with 25 ms
doubling backoff capped at 500 ms, inside the 30-second absolute deadline. Each
retry allocates a fresh correlation through `unary` (`:461-472`), so the watermark
is safe, but each is a fresh `route.open` attempt.

**O14. Every in-flight request is classified, never lost.** `settle_all`
(`:1649`) takes the whole map under the `admission` mutex (`:1651-1652`) and runs
`cancel_classification` (`:1655`, defined `:2223`) per entry: a successful
`QUEUED -> CANCELLED` CAS yields `NotSent`, anything else falls through to
`classify` (`:2215`), which maps `WRITING`/`WRITTEN` to `OutcomeUnknown`. So a
host death fails every pending call with a classification, and the client never
retries a request body: `request` (`:532`) is documented "The body is never
replayed" and there is no retry loop outside `open_route`.

**O15. A single malformed frame retires the whole generation.**
`ring_reader_loop:1978-1981` retires on `validate_inbound` failure or a body
length mismatch, taking every unrelated route with it. This is fail-closed and
matches the doc's §6.3 disposition column.

**O16. `validate_inbound` rejects a host-originated `Cancel`.** Its match arms
cover `Response|Error` (`:2022`), `StreamData|StreamEnd` (`:2038`), `Push`
(`:2050`), `Ping` (`:2057`), and `Goodbye` (`:2062`); everything else falls to
`_ => return Err(())` at `:2067`. `FrameType::Cancel` (`wire.rs:58`) is in that
residue. `docs/mc-host-wire-protocol.md:269` lists what is role-invalid, and
host-originated `Cancel` is not on the list; `:280` gives `Cancel` a
"stale route or unknown/terminal correlation is idempotent no-op" disposition
rather than a close. A consequence is that `dispatch`'s catch-all
`_ => self.retire("protocol_violation")` at `:1557` is unreachable from the
production reader.

**O17. The reserved control byte pool is separate, deliberately.**
`CLIENT_CONTROL_QUEUED_BYTES` (`:76`) funds `control_budget` (`:399`, `:949`),
distinct from `queue_budget` (`:398`). The comment at `:63-76` argues the case at
length. `docs/mc-host-wire-protocol.md:746` says the opposite: "Data and
reserved-control frames share one queued-byte budget; reserved admission is not a
byte-budget bypass."

## Candidate properties

Fourteen records. Where a record depends on a host-side behaviour already
cataloged, the sibling record is cited in `Confidence:` rather than re-derived.

A fifteenth candidate, `client-a-correlation-exhaustion-does-not-retire-the-generation`,
was drafted and then demoted rather than dropped. It held that after allocating
`u64::MAX` the client returns `correlations_exhausted` (`client.rs:1177-1183`) and
leaves `retired == false`, contrary to `docs/mc-host-wire-protocol.md:654`. It is
the lowest-impact finding in this pass, because reaching the state needs 2^64
admissions, and its whole substance is the contract disagreement, which is carried
in full by lead L2 below. Demoting it keeps the record count inside the brief's
range without losing the finding. If a synthesis pass would rather have fourteen
plus this one, the material is in L2 and the record can be reconstructed from it.

### client-a-a-retired-generation-forgets-why-it-retired

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts what a caller arriving after retirement can learn about the cause
Guarantee: A caller that arrives after the generation retires can determine that it retired but never why.
Check: `always` — whenever `retire` has run and a subsequent `admit` or `send_control` rejects a call, the returned `CallError::code()` is one of the two constants `connection_retired` (`client.rs:1129`) or `generation_retired` (`:2237`), and never the `&'static str` that `retire` was called with. `always` because the condition is evaluable at every post-retirement call, and the property is about a total function from state to observable code rather than about one window.
Fault/timing angle: The distinguishing information exists for exactly the duration of `settle_all`'s loop (`:1654-1664`). A caller holding a pending entry at that instant sees the cause; a caller that calls one instruction later does not.
Required faults and enabling state: Retire the generation by any of the eight cited causes with the `pending` map empty, then issue any call. Compare against the same fault with one pending request outstanding.
Confidence: high — [evidence](evidence/client-a-a-retired-generation-forgets-why-it-retired.md). Verified that `Inner` (`:934-960`) has no cause field, that `retire` (`:1667-1675`) forwards `code` only to `settle_all`, and that both post-retirement rejection sites use constants.
Existing check: none. `dropped_close_retires_and_repeated_close_joins_tasks` (`:3121`) exercises retirement but asserts nothing about cause visibility.
Impact: An operator or a recovery policy cannot tell a host reload from a ring fault after the fact. Combined with Part 2b's finding that the host reports itself healthy on ring unavailability, neither side of the connection retains the diagnosis.
Open questions:
- Should `Inner` carry a `retire_cause: OnceLock<&'static str>` so late callers get the real code? This changes the public `CallError` code set, so it is a compatibility decision. (needs human input)

### client-a-a-clean-host-close-and-a-transport-failure-share-one-code

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives the bridge thread's four distinct break paths and compares the resulting caller-visible code
Guarantee: A pending caller cannot distinguish a host that shut down without a channel-0 Goodbye from a ring transport failure, because both retire the generation with the code `eof`.
Check: `always` — whenever `ring_reader_loop` reaches `:1987`, the code passed to `retire` is the literal `"eof"` regardless of which of the five bridge-thread exits at `:1866`, `:1874`, `:1877`, `:1883`, or `:1887` closed the channel. `always` because it is a claim about a single code path's constant, checkable on every entry.
Fault/timing angle: None. This is a static property of the code, and the two operational causes it merges are unrelated in time.
Required faults and enabling state: Two runs with one pending request each. Run A: host exits after its drain without emitting a channel-0 Goodbye. Run B: fail `RingClientEndpoint::send` or `try_recv_with` so the bridge breaks at `:1874` or `:1887`. Assert both callers observe `CallError::code() == "eof"`.
Confidence: high — [evidence](evidence/client-a-a-clean-host-close-and-a-transport-failure-share-one-code.md). Verified all five bridge exits funnel into the same channel closure and that only `:1987` handles it. Part 2b's `ring-a-publish-failure-is-reported-as-a-clean-peer-close` establishes the host-side half.
Existing check: none.
Impact: This is the significant finding the task anticipated. A recovery policy that wants to back off on transport faults but reconnect promptly on a host reload has no signal to branch on, and Part 2b established the host's own diagnostics are equally silent, so the fault is invisible from both ends.
Open questions:
- Does a healthy host emit a channel-0 Goodbye before its ring closes? `docs/mc-host-wire-protocol.md` step 4 of graceful shutdown says the host sends best-effort connection Goodbye after the drain, which would give `connection_goodbye` instead. Whether that step is reliably reached before the ring drops is a 2a or 2b question, not answerable from `client.rs`. (unresolved, needs a host-side trace)

### client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test observes the setup socket after a forced ring failure
Guarantee: The client's setup-socket departure signal does not distinguish a clean exit from a transport failure, so the host's peer-death accounting under-reports ring faults.
Check: `always` — whenever the bridge thread leaves its `while` loop at `client.rs:1866`, it reaches `:1890-1893` and attempts `encoded_goodbye` followed by `shutdown(Both)`, with no branch on why the loop ended. `always` because the post-loop block is unconditional and evaluable on every thread exit.
Fault/timing angle: None for the write itself. The consequence lands on the host, whose watcher at `connection.rs:199-206` calls `record_peer_death()` only for a non-`Goodbye` close (`:200`).
Required faults and enabling state: Force the ring endpoint to fail after activation, so the bridge breaks at `:1874` or `:1887`. Observe the host's setup socket and assert whether `record_peer_death` fired.
Confidence: high — [evidence](evidence/client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye.md). Verified the post-loop block is outside every `break` and that `connection.rs:200` gates the peer-death counter on the message.
Existing check: `setup_socket.rs:820` and `:824` assert `observe_peer` returns `Goodbye` and `UnexpectedEof` respectively, but nothing ties either to a client transport state.
Impact: The host metric intended to count dead peers counts only peers that failed to complete a socket write. A fleet losing rings would look like a fleet of well-behaved clients.
Open questions:
- Should the bridge thread suppress the goodbye on its failure `break`s so the host classifies correctly? That makes a transport fault look like an abrupt EOF, which is the honest signal. (needs human input)

### client-a-a-close-completes-before-its-setup-goodbye-is-written

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — nothing constructs the ordering
Guarantee: The window in which `close()` has returned `Ok` while the detached bridge thread has not yet written its setup-socket Goodbye is genuinely reachable, so a clean client close can be observed by the host as an abrupt EOF.
Check: `sometimes` — at least once per campaign, observe the joint state: `close()` has returned, `join_tasks_until` reported both Tokio tasks joined, and the bridge thread has not yet executed `client.rs:1891`. `sometimes` rather than `reachable` because the lines at `:1890-1893` are executed on essentially every shutdown; what must be produced is the operational *ordering* in which the owner outruns them, and location coverage cannot witness that.
Fault/timing angle: The whole record. `close` cancels at `:711`, joins only writer and reader at `:1682`, and returns. The bridge thread observes `cancel.is_cancelled()` at `:1866` only at the top of its next iteration, after up to a 50-microsecond sleep (`:1886`) or a full in-flight ring write.
Required faults and enabling state: Independent preconditions, per the coverage-check rule: (a) `close()` observed returning with `within_deadline == true`; (b) the bridge thread observed still inside its loop body or its sleep at that moment. Assert both, never the misclassification itself.
Confidence: high — [evidence](evidence/client-a-a-close-completes-before-its-setup-goodbye-is-written.md). Verified `join_tasks_until` (`:1677-1695`) iterates only `[&self.writer, &self.reader]` and that the spawn at `:1852` discards its handle.
Existing check: none.
Impact: A clean shutdown is recorded by the host as a peer death, which is the exact inverse of the previous record. Together they mean the host's `record_peer_death` signal is uncorrelated with reality in both directions.
Open questions:
- Should `Inner` hold the bridge thread's `JoinHandle` so `close` can join it under the same 5-second budget? That budget is already shared with route teardown. (needs human input)

### client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `dropped_unary_future_cleans_pending_and_possibly_sent_request` (`client.rs:3090`) and `a_dropped_sender_after_an_absent_entry_reports_the_send_outcome` (`:3014`) cover single-request classification, not bulk settlement on host death
Guarantee: When the host dies, every pending request is failed exactly once with a send outcome that is `NotSent` only if its bytes provably never reached the writer, and no pending request is silently dropped or retried.
Check: `always` — after any `retire`, the `pending` map is empty and, per pending identity, exactly one settlement was delivered whose outcome is `NotSent` if and only if `cancel_classification` (`client.rs:2223`) won the `QUEUED -> CANCELLED` CAS. Per METHOD's effect-accounting rule the per-identity check is primary; the cheap screen is that observed host-side effects lie between the count of `NotSent` settlements subtracted from the total and the total. `always` because it must hold at every retirement.
Fault/timing angle: The CAS at `:2225` races `claim_for_write` at `:1942`, which is the writer's own `QUEUED -> WRITING` transition. A frame claimed by the writer but not yet completed must classify `OutcomeUnknown`, which `classify` (`:2215`) delivers by mapping both `WRITING` and `WRITTEN` there.
Required faults and enabling state: Kill the host with N pending requests spanning all four publish states. Assert one settlement per identity and that no `NotSent` claim was issued for a frame the host actually received.
Confidence: high — [evidence](evidence/client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome.md). Verified `settle_all` drains under the `admission` mutex, that `finish_pending` is the single settlement funnel, and that no retry path exists outside `open_route`.
Existing check: `cancel_winning_queued_prevents_writer_claim_and_frame` (`:2478`) and `writer_winning_cancel_is_outcome_unknown_and_queues_cancel` (`:2508`) cover the CAS race for one request; status `unaudited`.
Impact: If a `NotSent` were ever issued for a delivered request, the caller would replay a side-effecting operation. This is the client's core replay-safety guarantee.
Open questions: None.

### client-a-no-request-frame-carries-a-non-increasing-correlation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `max_correlation_is_used_once_then_exhausted` (`client.rs:2328`) and `data_capacity_spares_control_reserve_and_does_not_burn_correlation` (`:3155`) cover allocation and rewind in isolation
Guarantee: The sequence of `Request` correlations the client places on the wire is strictly increasing, so a conforming host's per-generation watermark never closes the generation on this client.
Check: `always` — for every pair of `Request` frames the writer completes in order, the second correlation is strictly greater than the first, across control (`0/0`) and routed identities alike, since both draw from one `Correlations` (`client.rs:393`). `always` because the host evaluates it on every ingress frame (`docs/mc-host-wire-protocol.md:656`).
Fault/timing angle: Two windows. First, `admit` must not release the `correlations` guard between allocation and enqueue; it does not (`:1176-1217`). Second, `restore` must never rewind past a frame already handed to the writer; its guard (`:1742-1744`) plus the fact that a failed `try_send` returns the frame (`:1207`) prevents that.
Required faults and enabling state: Concurrent `request`, `request_stream`, `open_route`, `host_status`, and `host_shutdown` callers, interleaved with encode failures (oversize body) and `data_tx` saturation to drive both `restore` sites. Record the correlation of each frame as the writer completes it.
Confidence: high — [evidence](evidence/client-a-no-request-frame-carries-a-non-increasing-correlation.md). Verified guard scope by reading `admit` end to end, and verified both `restore` call sites precede any delivery to `data_tx`. Part 2a's `request-correlation-strictly-increases-per-generation` is the host-side enforcement this satisfies.
Existing check: `max_correlation_is_used_once_then_exhausted` (`:2328`); status `unaudited`.
Impact: A violation is a host-side generation close before dispatch (`docs/mc-host-wire-protocol.md:882`, vector V44), taking every unrelated route down. I found no path that produces one.
Open questions: None.

### client-a-a-dropped-pong-is-never-observable-to-the-client

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo` (`client.rs:2754`) covers the success path only
Guarantee: When the client fails to enqueue a Pong for a reason that does not retire the generation, it records nothing, so a well-behaved host retires the generation for a missed probe while the client still believes it is healthy.
Check: `always-or-unreached` — whenever `send_control` returns `Err` from its encode branch (`client.rs:1329-1335`) while called from the `Ping` arm (`:1390`), no counter, log, or state change results, because the result is bound to `_`. `always-or-unreached` because the encode branch may never run against a conforming host, but the swallowing must be safe if it does.
Fault/timing angle: The window is one host probe interval. The client learns only when the host's own retirement arrives as an `eof` or `connection_goodbye`, by which point the cause is lost; see `client-a-a-retired-generation-forgets-why-it-retired`.
Required faults and enabling state: Inject an `encode_owned_frame` failure for a `Pong`, or drive the reserved control channel to a state where the Pong path is refused without retiring. Assert that no observable client state changed.
Confidence: medium — [evidence](evidence/client-a-a-dropped-pong-is-never-observable-to-the-client.md). The swallowing at `:1390` is verified. I could not construct an `encode_owned_frame` failure for a pure-header frame whose flags `validate_inbound` already accepted, so the reachability of the failing branch is unresolved and the confidence reflects that, not the code reading.
Existing check: `a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo` (`:2754`); status `unaudited`.
Impact: The client's only protocol obligation toward host liveness fails silently. Part 2a's `a-timely-pong-sustains-the-generation-within-a-bounded-round` is the host-side liveness property this could break.
Open questions:
- Can `encode_owned_frame` reject a flag byte that `validate_inbound:2073-2080` accepted? If not, this branch is unreachable and the record should be downgraded. (unresolved, needs a `wire.rs` read that 2b owns)

### client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test stalls inbound delivery and measures Pong egress
Guarantee: Once inbound delivery backpressures, an enqueued Pong waits on the same bridge thread that is parked delivering inbound frames, and the client tolerates that for the full 30-second frame deadline before reacting.
Check: `always` — with the inbound channel full and the bridge parked in `read_tx.blocking_send` (`client.rs:1882`), a control frame enqueued at `:1355` is not written until either the bridge resumes or `timeout_at(frame.deadline, completed_rx)` (`:1960`) expires, where `frame.deadline` is `now + CLIENT_FRAME_TIMEOUT` (`:1353`, 30 s per `:45`). State the bound in the unit the code bounds: one frame deadline, not "eventually". `always` because the dependency holds on every control write once the precondition is met.
Fault/timing angle: The bridge thread is the sole producer of write completions (`:1872`) and the sole consumer of the write channel, so any inbound stall is also an egress stall. This is the client-side mirror of Part 2b's `ring-a-ingress-wait-holds-a-lease-while-servicing-egress`.
Required faults and enabling state: Bounded fault-free window, per METHOD's liveness rule. Stall `ring_reader_loop` so the 256-slot inbound channel (`:1850`) fills, enqueue a Pong, release the stall, then poll until the write completes within an explicit bound of one frame deadline.
Confidence: high — [evidence](evidence/client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget.md). Verified the bridge is the single completion producer, that `writer_loop` awaits it before dequeuing the next frame, and that `RingClientEndpoint::send`'s own bound is a hardcoded 2 s (`ring_transport.rs:663-667`) that ignores the frame deadline.
Existing check: `data_saturation_never_starves_a_control_frame` (`:3225`) covers queue-slot starvation, which is a different mechanism; status `unaudited`.
Impact: Whether the host retires the generation first depends on its probe interval against 30 seconds. If the probe is shorter, an inbound stall presents to the operator as a liveness failure rather than as backpressure.
Open questions:
- What is the host's probe interval and deadline? Part 2a owns the liveness probe; the comparison against `CLIENT_FRAME_TIMEOUT` needs that number. (unresolved, needs the 2a figure)

### client-a-live-route-handles-are-bounded-only-by-the-host

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test opens routes to exhaustion
Guarantee: The client imposes no limit on concurrently live route handles, so the only bound on its route cache is the host's willingness to keep binding.
Check: `always` — every successful `open_route` inserts into `routes` at `client.rs:507` with no capacity predicate anywhere on that path, in contrast to `pending` (`:1169`) and `streams` (`:1058`). `always` because the absence is a total property of the insert path.
Fault/timing angle: None. The growth is caller-driven, not race-driven.
Required faults and enabling state: A host that binds every `route.open`. Open routes in a loop without closing and observe `routes` growth against the absent cap.
Confidence: high — [evidence](evidence/client-a-live-route-handles-are-bounded-only-by-the-host.md). Verified only two `CLIENT_MAX_*` constants exist (`:53`, `:55`) and that neither is consulted at `:507`. Contract side at `docs/mc-host-wire-protocol.md:658`, which names routes in its finite-limits list.
Existing check: none.
Impact: Unbounded caller-driven growth with no local reaper is the recurring shape this catalog has found in every part. Here the damage is transitive: each entry corresponds to a host channel and route permit, so a looping caller exhausts host resources rather than its own.
Open questions:
- Does the host cap concurrent routes per generation, and does it answer `target_unavailable` on exhaustion as `docs/mc-host-wire-protocol.md:658` implies? If so the transitive bound is real, though undeclared on this side. (unresolved, needs the 2e or 2f route-admission figure)

### client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `a_duplicate_bind_terminal_never_closes_an_owned_route` (`client.rs:3587`) covers the unmatched-terminal case, not two successful opens returning one handle
Guarantee: If the host answers two `route.open` requests with the same `(channel, epoch)`, the client conflates them into one cache entry, and one `close_route` settles both callers' work while neither bind is separately released.
Check: `always` — whenever `parse_route_open` yields a handle already present in `routes`, `routes.insert` (`client.rs:507`) returns `false` and the set is unchanged, so `settle_route` (`:1623`) can remove it at most once and `release_stranded_route` returns early at `:1576-1578`. `always` because the set semantics hold on every insert.
Fault/timing angle: None required, but the damage compounds if the two opens overlap: the second caller receives `Ok(handle)` for a route the first caller can close underneath it.
Required faults and enabling state: A host, or a fake peer, that answers two distinct `route.open` correlations with an identical `route_channel` and `route_epoch`. Assert both callers received `Ok`, that `routes.len() == 1`, and that one `close_route` settles both callers' pending requests.
Confidence: high — [evidence](evidence/client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle.md). Verified `routes` is a `HashSet<RouteHandle>` (`:944`), that `parse_route_open` (`:2167-2206`) validates only shape, and that the early return at `:1576` is the intended behaviour for the §8.2 case and therefore blocks cleanup here too.
Existing check: `a_duplicate_bind_terminal_never_closes_an_owned_route` (`:3587`); status `unaudited`.
Impact: A host bug or a hostile peer at the setup path turns into cross-caller interference inside one client: caller A's `close_route` silently settles caller B's requests with `route_gone`. Part 2c established that epochs are host-minted and that the activation token cannot gate mapping, so the client has no independent basis to reject a repeated handle.
Open questions:
- Should `open_route` retire on a duplicate handle, the way it already retires on an unparseable one (`:486`)? Both are host protocol violations the client cannot name a remedy for. (needs human input)

### client-a-host-shutdown-success-rests-only-on-a-json-echo

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test supplies a well-formed echo from a host that did not stop
Guarantee: `host_shutdown` returns `Ok` on the strength of a response body echoing its own operation name, and nothing in the client verifies the host actually stopped.
Check: `always` — `host_shutdown` (`client.rs:576-615`) returns `Ok(())` if and only if the response body parses as JSON with `op == "host.shutdown"` (`:598-606`); no other host state is consulted, and the connection is left open by design (`:575`). `always` because the acceptance predicate is total over responses.
Fault/timing angle: None inside the client. The window that matters is between the host writing the response and the host actually stopping, which the doc's shutdown ordering places at steps 3 through 9 (`docs/mc-host-wire-protocol.md`, section 12).
Required faults and enabling state: A fake peer that answers `{"op":"host.shutdown"}` and then continues serving. Assert `host_shutdown` returns `Ok` and that the caller's next operation still succeeds, which is the observable form of "the stop was not real".
Confidence: high — [evidence](evidence/client-a-host-shutdown-success-rests-only-on-a-json-echo.md). Verified the predicate, and verified that the `Ok` is load-bearing for a downstream owner because the doc comment at `:575` declares it "the stop linearization point the native lifecycle owner waits on".
Existing check: none found for `host_shutdown` in `client.rs`'s test module.
Impact: This is the shape a sibling part found on a producer that advanced a durable checkpoint on an acknowledgement truthful about nothing. Here the acknowledgement gates a lifecycle owner's belief that a daemon stopped, which is the precondition for starting a replacement. A stale echo could produce two live daemons.
Open questions:
- Does the host emit the `host.shutdown` response strictly after its stop is committed, as `:575` claims? That is a 2a or 2e claim about the host's control handler and is not verifiable from `client.rs`. (unresolved, needs the host-side handler)
- Does any caller of `host_shutdown` treat `Ok` as authority to launch a replacement daemon? `crates/mc-module/src/bin/ck-mc-host.rs` is the likely site and is outside this sub-part's scope. (unresolved, needs 2f or a mc-module pass)

### client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives the retry loop against a host that binds after answering one of the four codes
Guarantee: `open_route` retries after four specific host terminal codes, and each retry is a fresh `route.open` attempt whose safety depends entirely on those codes proving no route was bound.
Check: `always` — for a sequence of `open_route` attempts ending in success, the number of routes the host bound for that call is exactly one. Per METHOD's effect-accounting rule, track attempted and acknowledged separately: attempts equal loop iterations at `client.rs:461`, acknowledged failures equal the retried terminals at `:511-519`, and host-side binds must equal one, not the attempt count. The aggregate bound is the cheap screen; the per-attempt check is the oracle.
Check semantics rationale: `always` because it must hold for every `open_route` call, not merely be witnessed once.
Fault/timing angle: The retry is gated on `outcome == Terminal` (`:512`), so an `OutcomeUnknown` never retries. The risk is confined to whether `module_timeout` is a completed rejection or a host-side deadline that leaves module work in flight.
Required faults and enabling state: A fake peer that answers `route.open` with `Error{code:"module_timeout"}` and then also binds a route and emits a late `Response` on `0/0`. Count host-side binds against client-side handles, and check whether `release_stranded_route` (`:1572`) reclaims the extra.
Confidence: medium — [evidence](evidence/client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind.md). The retry predicate and the fresh-correlation-per-attempt behaviour are verified. Whether `module_timeout` is authoritative about the bind is a host-side question I could not resolve, which is why this is medium and why the guarantee is worded as a dependency rather than a defect.
Existing check: `an_abandoned_control_open_releases_a_late_bound_route` (`:3503`) covers the late-bind remedy that would partially mitigate this; status `unaudited`.
Impact: If `module_timeout` is a deadline rather than a rejection, each retry can strand a host route and channel permit, bounded only by the 30-second route-open deadline divided by the backoff. The mitigation at `:1572` works only while the generation stays live.
Open questions:
- Is `module_timeout` emitted after the host proves no bind occurred? `docs/mc-host-wire-protocol.md:658` reserves `target_unavailable` for route admission and gives each code "exactly one recovery rule in Section 10.2", which suggests the codes are meant to be authoritative, but does not state it for `module_timeout`. (unresolved, needs the 2e control-handler pass)

### client-a-a-host-originated-cancel-retires-the-generation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `inbound_validation_enforces_the_direct_profile_table` (`client.rs:2658`) exercises `validate_inbound` broadly; whether it asserts the `Cancel` disposition is unverified
Guarantee: The client treats a host-originated `Cancel` as a framing violation that retires the whole generation, although the protocol's role table does not list host-originated `Cancel` as role-invalid and assigns `Cancel` an idempotent no-op disposition.
Check: `always` — for `header.ty == FrameType::Cancel` (`wire.rs:58`), `validate_inbound` (`client.rs:2006`) has no matching arm and falls to `_ => return Err(())` at `:2067`, so `ring_reader_loop:1979` retires with `protocol_violation`. `always` because the classification is total over inbound frame types.
Fault/timing angle: None.
Required faults and enabling state: A fake peer that sends a well-formed pure-header `Cancel` on a live route with a pending correlation. Assert the client retires rather than treating it as a no-op.
Confidence: high — [evidence](evidence/client-a-a-host-originated-cancel-retires-the-generation.md). Verified `validate_inbound`'s arms are exactly `Response|Error`, `StreamData|StreamEnd`, `Push`, `Ping`, `Goodbye`, plus the catch-all, and that `Cancel` is therefore in the residue. Contract side at `docs/mc-host-wire-protocol.md:269` and `:280`.
Existing check: `inbound_validation_enforces_the_direct_profile_table` (`:2658`); status `unaudited`, and its coverage of `Cancel` specifically is unverified.
Impact: If a host ever emits `Cancel`, every route on the generation dies. If a host never does, the strictness is free and the finding is a documentation defect rather than a code defect. Which of those holds is the open question.
Open questions:
- Is host-originated `Cancel` legal in this profile? `docs/mc-host-wire-protocol.md:269` enumerates role-invalid frames and omits `Cancel`, while `:280` gives `Cancel` a no-op disposition without naming a direction. The doc is ambiguous and the code is strict. (needs human input)

### client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — reached only by the test module's 16 direct `dispatch` calls
Guarantee: `dispatch`'s catch-all retirement arm is unreachable from the production reader, because `validate_inbound` already rejects every frame type that would land there.
Check: `unreachable` — the statement at `client.rs:1557` is never executed on the `ring_reader_loop` path. `unreachable` rather than `always(!X)` because the subject is a specific code location that must not execute, which is exactly METHOD's criterion.
Fault/timing angle: None.
Required faults and enabling state: No fault. The check is a marker at `:1557` that must not fire during any production-path campaign, combined with the independent observation that `validate_inbound` returned `Err` for the same frame types.
Confidence: high — [evidence](evidence/client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production.md). Verified that `dispatch` handles `Ping`, `Goodbye`, `Push`, `Response|Error|StreamEnd`, and `StreamData`, that its catch-all therefore covers `Request`, `Cancel`, `Pong`, `Hello`, and `HelloAck` (`wire.rs:52-63`), and that `validate_inbound:2067` rejects all five. Confirmed `dispatch`'s only non-test caller is `:1982`.
Existing check: none as a guard. The 16 test call sites listed in the evidence file reach `dispatch` directly, bypassing validation.
Impact: Low on its own. It matters as a structural fact: the tests exercise a dispatch surface the production reader cannot reach, so a regression that loosened `validate_inbound` would be caught by nothing, and the duplicated classification at `:1557` and `:2067` can drift.
Open questions: None.

## Contract-vs-code leads

Five disagreements against `docs/mc-host-wire-protocol.md`. Per METHOD rule 3
each is reported with both sides cited and none is resolved in the doc's favour.
The docs may lag the refactor; where the code carries an explicit rationale, that
is noted.

**L1. The reserved control byte budget is separate, not shared.** Doc `:746`:
"Data and reserved-control frames share one queued-byte budget; reserved
admission is not a byte-budget bypass." Code: `control_budget` (`client.rs:399`,
`:949`) is a distinct `ByteCounter` funded by `CLIENT_CONTROL_QUEUED_BYTES`
(`:76`), separate from `queue_budget` (`:398`). The comment at `:63-76` argues
the shared design was actively harmful: "sharing one pool let legitimate large
bodies turn into a self-inflicted connection teardown." This looks like the doc
lagging a deliberate fix, and the fix looks right, but the doc is normative and
the TypeScript client is bound by the same sentence. Consequence if the two
clients diverge here: they have different self-teardown thresholds under
identical load.

**L2. Correlation exhaustion must retire the generation.** Doc `:654`:
"`u64::MAX` may identify one final request; before another request, sender MUST
retire the generation and reconnect." Code: `Correlations::allocate`
(`client.rs:1735-1739`) stops at `u64::MAX` through `checked_add`, which satisfies
the no-reuse half of the same sentence, but `admit` (`:1177-1183`) then returns
`correlations_exhausted` with `SendOutcome::NotSent` and calls no `retire`. The
`retired` flag stays false, so `daemon_id` and `host_status` still work and the
connection looks healthy from every public accessor. Two sites a few lines away do
retire on an unrecoverable capacity failure (`:1341`, `:1356`), so the pattern
exists in the file and is simply not applied here.

Consequence: `NotSent` means provably-never-sent and therefore safe to retry, per
`docs/mc-host-wire-protocol.md:62` and the `SendOutcome::NotSent` doc at
`client.rs:117-118`. So a caller with an ordinary retry loop spins forever against a
connection that can never serve another request and will never retire itself, and a
caller that keys reconnection off retirement never reconnects. Reaching the state
needs 2^64 admissions, so the practical severity is low; the shape, a permanent
local capacity failure reported as a retryable per-call error, is the part worth
carrying forward. The demoted record's test recipe was: build an `Inner` whose
`Correlations` starts at `u64::MAX` using the fixture pattern from
`max_correlation_is_used_once_then_exhausted` (`:2328`), consume the last
correlation through a real `admit`, then assert both `correlations_exhausted` and
`retired == false`.

Whether the deviation is deliberate is unresolved. The comment block at `:418-424`
shows the author reasoning explicitly about which side owns recovery, and argues
there for surfacing failure eagerly rather than deferring it, which is the reverse
of what this path does. Nothing in the file mentions exhaustion, and `grep` for
`correlations_exhausted` finds only `:1180`. (needs human input)

**L3. Live routes must be finitely bounded.** Doc `:658`: "Implementations MUST
use finite limits for live connections, routes, pending correlations, handler
tasks, queued requests, and aggregate buffered bodies." Code bounds pending
(`:1169`) and streams (`:1058`) but not routes (`:507`). See
`client-a-live-route-handles-are-bounded-only-by-the-host`.

**L4. The client has no `Recovering` state.** Doc section 12 diagrams
`Connected --> Recovering: connection failure` and
`Recovering --> Discovering: bounded backoff, reread file`. Code: `client.rs`
has no reconnect path at all; `retire` (`:1667`) is terminal for the `Client`
value. Recovery lives in `crates/mc-module/src/historian_producer.rs:699`. The
comment at `client.rs:418-424` shows this is understood and that at least one
caller does not recover on the post-setup race path: "the historian does not
reconnect on that path, so a daemon reload race would abort the run instead of
establishing a replacement." Whether the doc means the state machine is the
client library's or the consumer's is unresolved.

**L5. Host-originated `Cancel` disposition is ambiguous.** Doc `:269` enumerates
role-invalid frames and omits `Cancel`; `:280` gives `Cancel` an idempotent-no-op
disposition without naming a direction. Code retires the generation
(`client.rs:2067`, `:1979`). See `client-a-a-host-originated-cancel-retires-the-generation`.

One near-miss worth recording as checked-and-clear: doc `:654` says "A
correlation MUST NOT be reused, even after terminal completion", and
`Correlations::restore` (`client.rs:1741`) does rewind the allocator. It is not a
violation, because both call sites (`:1196`, `:1209`) precede any delivery to the
writer channel, so no `Request` frame ever carried the rewound value. The doc's
rule is about wire use; the code's rewind is about allocation bookkeeping. See
`client-a-no-request-frame-carries-a-non-increasing-correlation`.

## Open questions

Carried from the records, plus what this lens could not reach.

1. Does a healthy host reliably emit a channel-0 `Goodbye` before its ring
   closes? If yes, `client-a-a-retired-generation-forgets-why-it-retired` and
   `client-a-a-clean-host-close-and-a-transport-failure-share-one-code` lose most of their
   impact, because the client
   would see `connection_goodbye` rather than `eof`. This is a 2a or 2b question.
   (unresolved, needs a host-side trace)
2. What is the host's liveness probe interval and deadline, in the same units as
   `CLIENT_FRAME_TIMEOUT`? `client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget`'s
   severity depends entirely on that
   comparison. (unresolved, needs the 2a figure)
3. Is `module_timeout` authoritative that no route was bound? See
   `client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind`.
   (unresolved, needs the 2e control-handler pass)
4. Can `encode_owned_frame` reject a flag byte that `validate_inbound` accepted?
   `client-a-a-dropped-pong-is-never-observable-to-the-client`'s reachability turns on it.
   (unresolved, needs a `wire.rs` read that
   2b owns)
5. Does the host bound concurrent routes per generation?
   `client-a-live-route-handles-are-bounded-only-by-the-host`'s transitive
   bound turns on it. (unresolved, needs 2e or 2f)
6. Does any consumer of `host_shutdown`'s `Ok` use it as authority to start a
   replacement daemon? `client-a-host-shutdown-success-rests-only-on-a-json-echo`'s impact
   turns on it, and the likely site
   (`crates/mc-module/src/bin/ck-mc-host.rs`) is outside 2d. (unresolved, needs
   a mc-module pass)
7. Should the setup-socket departure signal distinguish a transport failure from
   a clean exit? `client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye` and
   `client-a-a-close-completes-before-its-setup-goodbye-is-written` are inverses of each other and one design
   decision resolves both. (needs human input)
8. Is `client.rs`'s inline test module executed anywhere? The rescope document
   established at `part-2-rescope/scope-map-and-risk-ranking.md:504-508` that CI
   never runs an unfiltered `-p mc-host` or `--lib` invocation. If that holds,
   every `Existing check:` line in this lens points at a local-only test. I did
   not re-verify the CI workflow myself. (unresolved, needs the 2f CI pass)
