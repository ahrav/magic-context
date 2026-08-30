# Sub-part 2d property catalog: the host's own client as a protocol peer

Scope: the client the host crate ships and that production binaries use to speak
to a host, about 3,998 lines centred on `crates/mc-host/src/client.rs`. That
count was re-derived with `wc -l` at `HEAD` and the file is the crate's largest.
Production occupies `1-2264`; `#[cfg(test)] mod tests` occupies `2266-3998`,
which is 1,733 lines, 43 percent of the file.

Boundary context, read but not cataloged: `ring_transport.rs` for
`RingClientEndpoint` and its 2-second per-write bound, `setup_socket.rs` for the
encoded goodbye, `connection.rs` for the host-side peer watcher, and
`docs/mc-host-wire-protocol.md` as the normative peer contract. Parts 1, 2a, 2b,
and 2c own the host halves of every contract named here and are cited rather
than re-derived.

**This is a post-refactor surface.** The client's byte-stream half was deleted
and its ring half is what remains, so several normative statements still describe
a reader that no longer exists. Four commits carry the refactor, and all four
subjects were re-verified with `git log -1` at authoring time:

| Commit | Subject |
| --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` |
| `d8bde128` | `feat(host): add authenticated ring setup socket` |
| `793a973e` | `build(shm): require packaged native transport` |
| `ed487e11` | `refactor(host): make ring transport mandatory` |

`ed487e11` is the one that matters most here: it removed 351 lines from
`client.rs` and added 137, deleting `reader_loop<R: AsyncRead>`,
`read_active_frame`, `read_exact_until`, `read_body_until`, `drain_until`,
`negotiate_tcp`, `read_setup_frame`, `read_setup_exact`,
`NEGOTIATION_CORRELATION`, `READ_BUFFER_BYTES`, and three tests. It also moved
`FIRST_APPLICATION_CORRELATION` from 2 to 1 (`client.rs:111`), because the
negotiation request that owned correlation 1 is gone.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"), confirmed with
`git branch --show-current` and `git log -1`. Both lens agents read and verified
their line references at that commit. Scope and CI findings come from
[../part-2-rescope/scope-map-and-risk-ranking.md](../part-2-rescope/scope-map-and-risk-ranking.md).

**Lens B re-derived every citation lens A made and corrected three, so lens B's
line numbers win wherever the two differ.** All three are in the normative
document and none changes a finding.

- The client `Recovering` state is at `docs/mc-host-wire-protocol.md:762-764`,
  and the quoted string "bounded backoff, reread file" is at `:764`. Lens A's
  earlier section cited `:12`, which is "This document is the direct-only wire
  authority". Lens A's own lead L4 cites section 12 correctly.
- The shared queued-byte sentence is at `:745`, not `:746`. `:746` is blank.
  Verified by printing `:745`, which reads "Data and reserved-control frames
  share one queued-byte budget; reserved admission is not a byte-budget bypass."
- The `not_sent` definition is at `:60`, not `:62`. `:62` is the `terminal`
  bullet.

This synthesis re-verified the citations it repeats and adds two corrections of
its own, both recorded where they land: the count of CI-named fixture binaries
in [existing-checks.md](existing-checks.md), and the coverage of `Cancel` by
`inbound_validation_enforces_the_direct_profile_table`, resolved below.

## What this part is about

Eight facts frame every record here. The first two are the reason this sub-part
was cataloged, and the third is worth stating precisely because it is the strong
part.

**A clean host close and a transport failure share one code.** All four
bridge-thread fault exits collapse to the same caller-visible outcome, and so
does a host exiting without a channel-0 goodbye. The bridge thread's loop
(`client.rs:1866-1889`) leaves by five routes: an `endpoint.send` failure
(`:1873-1875`), `write_rx` disconnection (`:1877`), a `read_tx.blocking_send`
failure (`:1882-1884`), a `try_recv_with` error (`:1887`), and ordinary
cancellation at the loop head (`:1866`). Every one of them closes the inbound
channel, and `ring_reader_loop` has exactly one handler for that: `read.recv()`
yielding `None` reaches `inner.retire("eof")` at `:1987`. A host that exits after
its drain without emitting a channel-0 `Goodbye` produces the identical
`Ok(None)`-then-close sequence, so `eof` is the only signal for either case.
Worse, the retirement cause is never stored. `retire` (`:1667-1675`) takes a
`&'static str` and forwards it only to `settle_all` (`:1672`); `Inner`'s fields
(`:934-960`) hold no cause slot, which this synthesis confirmed by printing the
struct. So only a caller holding a pending entry at the instant of
`settle_all`'s loop (`:1654-1664`) sees any cause at all, and everyone arriving
later gets the constant `connection_retired` from `admit` (`:1129`, `:1145`) or
`generation_retired` from `send_control` via `retired_error` (`:1327`, `:2237`).
Eight cause categories, spelled with ten distinct literals — `connection_goodbye`
(`:1397`), `protocol_violation` (`:1557`, `:1979`), `eof` (`:1987`),
`write_failed` (`:1954`, `:1963`), `control_capacity_exhausted` (`:1341`,
`:1356`), `invalid_route_response` (`:486`),
`stranded_route_cleanup_failed` (`:1588`), and the three local lifecycle codes
`owner_drop` (`:744`), `owner_close_dropped` (`:766`), and `shutdown_timeout`
(`:676`) — collapse to two constants.

**The peer-death counter is uncorrelated with reality in both directions.** The
bridge thread writes a setup-socket goodbye unconditionally after every exit.
`:1890-1893` runs `encoded_goodbye` then `shutdown(Both)` outside the `while`
loop that closes at `:1889`, with no branch on why the loop ended, so a client
whose ring collapsed departs looking clean. On the host side
`connection.rs:199-206` observes that socket and calls `record_peer_death()`
**only** when `close != PeerClose::Goodbye` (`:200`), which this synthesis
printed and confirmed. So the host skips its peer-death record even on a real
ring fault. The inverse also holds: `close()` cancels at `:711` and then joins
only the two Tokio tasks (`join_tasks_until`, `:1677-1695`, iterating
`[&self.writer, &self.reader]` at `:1682`), while the detached bridge thread
observes cancellation only at the top of its next iteration, so a clean owner
close can outrun its own goodbye and present to the host as an abrupt EOF. And
sub-part 2b established the other end of the same blind spot: a host that cannot
create shared-memory objects reports `state: "healthy"` with `error_class: null`
while refusing every connection. Neither side of this connection retains the
diagnosis.

**In-flight requests are handled correctly.** This is the strong part and it is
worth stating plainly, because the rest of this section is failure attribution.
`settle_all` (`:1649`) takes the whole pending map under the `admission` mutex
(`:1651-1652`, verified by printing the `std::mem::take` under
`lock_unpoisoned(&self.admission)`), so settlement is atomic against admission
rather than racing it. Per entry it runs `cancel_classification` (`:2223`), whose
`QUEUED -> CANCELLED` compare-exchange (`:2225`) races the writer's own
`claim_for_write` gate (`:1939-1945`); the loser falls through to `classify`
(`:2215`), which maps both `WRITING` and `WRITTEN` to `OutcomeUnknown`.
`NotSent` is therefore issued only when the CAS won, which means the bytes
provably never left. And no request body is ever replayed: `request` is
documented "The body is never replayed" (`:531`) and the only retry loop in the
file is `open_route`'s (`:511-525`).

**The correlation watermark cannot be violated by this client.** One allocator
serves control and routed requests alike, constructed as
`Correlations::new(FIRST_APPLICATION_CORRELATION)` at `:393`. Allocation and
enqueue are atomic under the correlations guard: `admit` takes it at `:1176` and
holds it through allocation (`:1177`), frame encoding (`:1186`), and
`data_tx.try_send` (`:1207`), with the `admission` and `pending` mutexes held too
(`:1140-1141`). Enqueue order therefore equals allocation order, which is exactly
what `docs/mc-host-wire-protocol.md:656` obliges of a sender. The rewind path
cannot break it either: `Correlations::restore` (`:1741-1747`) only rewinds when
`self.next == correlation.checked_add(1)`, or for the `u64::MAX` exhaustion case,
and both call sites (`:1196`, `:1209`) precede any delivery to the writer.

**Pending state is bounded except routes.** Pending requests are capped at 1,024
by `CLIENT_MAX_PENDING_REQUESTS` (`:53`) at `:1169`; live streams at 64 by
`CLIENT_MAX_LIVE_STREAMS` (`:55`) at `:1058`; and four byte counters are capped
by construction — `queue_budget`, `control_budget`, `_read_budget`, and
`retained_budget` (`:398-401`, declared `:945-954`). The route map (`:944`, a
`Mutex<HashSet<RouteHandle>>`) has no cap at its insertion point (`:507`), which
tests only `closed` (`:501`) and never `routes.len()`. A grep for
`CLIENT_MAX_LIVE_ROUTES` across the file returns zero hits. The bound is
transitive only, resting on the host's willingness to keep allocating channels,
against a protocol document that names routes explicitly at `:658`:
"Implementations MUST use finite limits for live connections, routes, pending
correlations, handler tasks, queued requests, and aggregate buffered bodies."

**A detached bridge thread is never joined.** `std::thread::Builder::new()` at
`:1852` spawns at `:1854` and the only combinator applied to the result is
`.map_err(...)` at `:1895`, so the `JoinHandle` is discarded. It busy-polls:
`Ok(None) => std::thread::sleep(Duration::from_micros(50))` at `:1886`, so one
idle connection spins an OS thread at roughly 20 kHz for its whole lifetime. It
owns three things nothing else can reach — the ring attach (`:1855`), the
completion signal every outbound frame waits on (`:1872`), and the setup-socket
departure the host reads as its peer-death discriminator (`:1890-1893`) — and it
is tested at no level. A grep of `mod tests` for `start_ring_bridge`,
`RingClientEndpoint`, `Client::connect`, or `TestHost` returns zero hits, and none
of the six integration tests observes the thread or the socket.

**Coverage: 40 in-crate tests, none in CI, all driving a synthetic inner.** The
count was re-derived here by grepping `#[test]` and `tokio::test` from `:2266`
onward, and it matches lens B exactly at 40; an initial pass of this synthesis
under-counted at 38 by missing `#[tokio::test(flavor = ..., worker_threads = 2)]`
forms, which is recorded so a later pass does not repeat it. All 40 live in one
`mod tests` at `:2266-3998` and all 40 build their subject through `test_inner`
(`:2270`), which constructs `Arc::new(Inner { .. })` directly with a
pre-populated route set. So there are **zero hits for the real `connect`
(`:306`), `connect_info` (`:347`), or bridge entry points**. None of the 40 runs
in CI, and the reason is structural: every `-p mc-host` invocation in `ci.yml`
carries a `--test <name>` filter, which selects one integration binary and never
builds the lib target. Re-verified at `HEAD`: the 13 `mc-host` hits are `:87`,
`:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`,
`:442`, and `:461`, and `:168-169` are `cargo build`.

Six integration tests in `crates/mc-host/tests/client.rs` (243 lines) do run, and
the binary is named in CI three times: `ci.yml:132` ("Mandatory ring client
suite", Linux, job `shm-crash-recovery`), `:179` (inside a wrapped
`cargo nextest run -p mc-host --test client --test lifecycle`, Linux, job
`shm-source-build`), and `:187` ("Fixed-ring contracts (macOS)"). All three
commands were printed and confirmed. **All six exercise the client as a peer**
rather than as a fixture: each constructs `Client::connect(host.publication_path())`
and asserts on the client's own observable behaviour.

**Zero doctests, so no check resident in `client.rs` is CI-executed.**
`grep -c '```'` over the file returns 0: there is no code fence, `text` fence, or
`compile_fail` block anywhere in its 3,998 lines. This matters because
`cargo test -p mc-host --doc` **does** run, at `ci.yml:190` under the step name
"Rust lease non-escape", and it builds the lib target's doctests. Sub-part 2b has
two `compile_fail` doctests (`frame_channel.rs:296-301`, `:303-308`) and they are
its only CI-executed source-resident checks. 2d has no equivalent. The sub-part's
entire CI-executed coverage is the six integration tests.

**Five normative doc statements describe a byte-stream reader the refactor
deleted.** One is in the code, four are in the normative document, and all five
were printed and confirmed.

1. `client.rs:44` — "Deadline for a frame after its first header byte. Idle
   header waits are unbounded." The client has no first header byte;
   `ring_reader_loop` receives an already-decoded
   `(EnvelopeHeader, Vec<u8>, ByteCharge)` triple from the bridge (`:1977`). The
   deleted `read_active_frame` and `read_exact_until` were what made the sentence
   true. `CLIENT_FRAME_TIMEOUT` (`:45`) survives as a real bound, but it bounds
   the *writer's* per-frame publication (`:1353`, `:1960`).
2. `docs/mc-host-wire-protocol.md:738` — "frame completion after first header
   byte | one 30 s absolute deadline; idle first-header wait is unbounded". The
   same mechanism, stated normatively for both managed clients, neither of which
   reads a byte stream any more.
3. `:724` — "malformed framing / EOF | no terminal possible | classify pending
   writes from byte evidence; invalidate generation". There is no byte evidence
   on the ring path. The surviving classifier is the three-state `publish` atomic
   (`client.rs:1939-1967`, `:2215-2231`), which is *stronger* than byte evidence,
   not weaker. The obligation survives; the evidence it names does not.
4. `:852` (conformance vector V14) — "Partial header/body EOF | Close as
   corruption; pending write outcomes use byte evidence". Not constructible
   against the ring, because `:294` says "A published ring descriptor names one
   complete header and body."
5. `:296` — the client-side retirement list still contains "truncated declared
   frame" alongside items that are live on the ring path. Printed in full and
   confirmed: unexpected setup-socket EOF, invalid ring descriptor, unsupported
   version, unknown type, invalid flags, nonzero channel-0 epoch, zero epoch on a
   routed channel, pure-header body, and body declaration above 64 MiB are all
   reachable; a truncated declared frame is not, for the reason `:294` gives.

Lens B checked the opposite direction too, so a later pass does not double-count:
the document's transport-selector, provider-registration, and alternate-backend
statements (`:29`, `:594`, `:263-264`) are *negative* claims the deletion made
true, not descriptions of surviving machinery.

### One correction this synthesis resolved

Lens A recorded that whether
`inbound_validation_enforces_the_direct_profile_table` (`client.rs:2658`) covers
the `Cancel` disposition was unverified. It does not. The test runs `:2658-2751`,
from its `fn` line to its closing brace, and grepping that body for `Cancel`,
`Request`, `Pong`, `Hello`, and `HelloAck` returns exactly one hit,
`FrameType::Request` at `:2750`. So of the five frame types that land in
`validate_inbound`'s residue, the densest test in the sub-part asserts one. This
tightens
[client-a-a-host-originated-cancel-retires-the-generation](#client-a-a-host-originated-cancel-retires-the-generation)
and [client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production](#client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production);
the record text is preserved verbatim from lens A and this correction is carried
here rather than edited into it.

## Reachability

**All fourteen records are `default-production`, and no record here is
`test-only`.** The label rests on four verified facts rather than on a blanket
preamble assertion, per METHOD rule 4.

1. `Client::connect` is `pub` at `client.rs:306` and carries no `cfg` gate.
2. It reaches the ring through `connect_info` (`:343`), then `start_ring_bridge`
   (`:378`), then `RingClientEndpoint::attach_with_descriptors` (`:1855`,
   defined `ring_transport.rs:636`). None is `cfg`-gated.
3. Production callers exist outside this crate.
   `crates/mc-module/src/bin/ck-mc-host.rs:468` and `:500` call
   `Client::connect`, and that binary is described by its own manifest as "the
   production lifecycle/serve executable" (`crates/mc-module/Cargo.toml:18-19`).
   `ManagedConnector::connect` (`crates/mc-module/src/historian_producer.rs:693`)
   calls it too, outside any test module, and
   `docs/mc-host-wire-protocol.md:808` names `HistorianProducer` as a
   `mc_host::Client` consumer.
4. The doc comment "Thread-confined peer endpoint for integration tests"
   (`ring_transport.rs:626`) is therefore wrong about reachability, and
   `RING_PROFILE = "mc-host-test-ring-v1"` (`ring_transport.rs:31`) is a
   misleading name rather than a gate. Sub-part 2b reached the same two verdicts
   independently.

Two code points are production-*unreachable* inside this
`default-production` surface, and both are typed `reachability` with
`unreachable` semantics at the record rather than relabelled: `dispatch`'s
catch-all at `:1557`, and — noted but not cataloged as its own record — the two
`unreachable!()` arms at `:1440` and `:1457`.

## Index

Fourteen records, in the order lens A proposed them. Lens B proposed none by
design; it built the 20-claim register and the check inventory.

| Slug | Type | Confidence |
| --- | --- | --- |
| [client-a-a-retired-generation-forgets-why-it-retired](#client-a-a-retired-generation-forgets-why-it-retired) | safety | high |
| [client-a-a-clean-host-close-and-a-transport-failure-share-one-code](#client-a-a-clean-host-close-and-a-transport-failure-share-one-code) | safety | high |
| [client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye](#client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye) | safety | high |
| [client-a-a-close-completes-before-its-setup-goodbye-is-written](#client-a-a-close-completes-before-its-setup-goodbye-is-written) | reachability | high |
| [client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome](#client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome) | safety | high |
| [client-a-no-request-frame-carries-a-non-increasing-correlation](#client-a-no-request-frame-carries-a-non-increasing-correlation) | safety | high |
| [client-a-a-dropped-pong-is-never-observable-to-the-client](#client-a-a-dropped-pong-is-never-observable-to-the-client) | safety | medium |
| [client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget](#client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget) | liveness | high |
| [client-a-live-route-handles-are-bounded-only-by-the-host](#client-a-live-route-handles-are-bounded-only-by-the-host) | safety | high |
| [client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle](#client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle) | safety | high |
| [client-a-host-shutdown-success-rests-only-on-a-json-echo](#client-a-host-shutdown-success-rests-only-on-a-json-echo) | safety | high |
| [client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind](#client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind) | safety | medium |
| [client-a-a-host-originated-cancel-retires-the-generation](#client-a-a-host-originated-cancel-retires-the-generation) | safety | high |
| [client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production](#client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production) | reachability | high |

Semantics distribution: eleven `always`, one `always-or-unreached`, one
`sometimes`, one `unreachable`. Type distribution: eleven safety, two
reachability, one liveness.

**The seven group headings below are this synthesis's own**, chosen by shared
mechanism rather than by the order records were proposed. Grouping reorders the
records relative to the index; the index is the record-order artifact. Record
bodies are verbatim from lens A. Two formatting-only changes were applied
uniformly: fields are wrapped to about 80 columns, and in
[client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind](#client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind)
lens A's separate `Check semantics rationale:` field is folded into the `Check:`
line, which is where METHOD puts the rationale. No wording was changed.

---

## Group A: the retirement cause, erased twice

Two records on the same discarded `&'static str`. The first is that the cause is
never stored, so only a caller already pending at the instant of settlement can
ever learn it. The second is that even that caller learns little, because the one
code it receives, `eof`, is shared by a healthy host exit and a ring transport
failure. They are grouped because both turn on `retire` (`client.rs:1667`)
forwarding its cause to `settle_all` and nowhere else, and because together they
mean the client retains no diagnosis of its own death.

### client-a-a-retired-generation-forgets-why-it-retired

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts what a caller arriving after retirement can
learn about the cause
Guarantee: A caller that arrives after the generation retires can determine that
it retired but never why.
Check: `always` — whenever `retire` has run and a subsequent `admit` or
`send_control` rejects a call, the returned `CallError::code()` is one of the two
constants `connection_retired` (`client.rs:1129`) or `generation_retired`
(`:2237`), and never the `&'static str` that `retire` was called with. `always`
because the condition is evaluable at every post-retirement call, and the
property is about a total function from state to observable code rather than
about one window.
Fault/timing angle: The distinguishing information exists for exactly the
duration of `settle_all`'s loop (`:1654-1664`). A caller holding a pending entry
at that instant sees the cause; a caller that calls one instruction later does
not.
Required faults and enabling state: Retire the generation by any of the eight
cited causes with the `pending` map empty, then issue any call. Compare against
the same fault with one pending request outstanding.
Confidence: high — [evidence](evidence/client-a-a-retired-generation-forgets-why-it-retired.md).
Verified that `Inner` (`:934-960`) has no cause field, that `retire`
(`:1667-1675`) forwards `code` only to `settle_all`, and that both
post-retirement rejection sites use constants.
Existing check: none. `dropped_close_retires_and_repeated_close_joins_tasks`
(`:3121`) exercises retirement but asserts nothing about cause visibility.
Impact: An operator or a recovery policy cannot tell a host reload from a ring
fault after the fact. Combined with Part 2b's finding that the host reports
itself healthy on ring unavailability, neither side of the connection retains the
diagnosis.
Open questions:
- Should `Inner` carry a `retire_cause: OnceLock<&'static str>` so late callers
  get the real code? This changes the public `CallError` code set, so it is a
  compatibility decision. (needs human input)

### client-a-a-clean-host-close-and-a-transport-failure-share-one-code

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives the bridge thread's four distinct break paths
and compares the resulting caller-visible code
Guarantee: A pending caller cannot distinguish a host that shut down without a
channel-0 Goodbye from a ring transport failure, because both retire the
generation with the code `eof`.
Check: `always` — whenever `ring_reader_loop` reaches `:1987`, the code passed to
`retire` is the literal `"eof"` regardless of which of the five bridge-thread
exits at `:1866`, `:1874`, `:1877`, `:1883`, or `:1887` closed the channel.
`always` because it is a claim about a single code path's constant, checkable on
every entry.
Fault/timing angle: None. This is a static property of the code, and the two
operational causes it merges are unrelated in time.
Required faults and enabling state: Two runs with one pending request each. Run
A: host exits after its drain without emitting a channel-0 Goodbye. Run B: fail
`RingClientEndpoint::send` or `try_recv_with` so the bridge breaks at `:1874` or
`:1887`. Assert both callers observe `CallError::code() == "eof"`.
Confidence: high — [evidence](evidence/client-a-a-clean-host-close-and-a-transport-failure-share-one-code.md).
Verified all five bridge exits funnel into the same channel closure and that only
`:1987` handles it. Part 2b's
`ring-a-publish-failure-is-reported-as-a-clean-peer-close` establishes the
host-side half.
Existing check: none.
Impact: This is the significant finding the task anticipated. A recovery policy
that wants to back off on transport faults but reconnect promptly on a host
reload has no signal to branch on, and Part 2b established the host's own
diagnostics are equally silent, so the fault is invisible from both ends.
Open questions:
- Does a healthy host emit a channel-0 Goodbye before its ring closes?
  `docs/mc-host-wire-protocol.md` step 4 of graceful shutdown says the host sends
  best-effort connection Goodbye after the drain, which would give
  `connection_goodbye` instead. Whether that step is reliably reached before the
  ring drops is a 2a or 2b question, not answerable from `client.rs`.
  (unresolved, needs a host-side trace)

---

## Group B: the departure signal, wrong in both directions

Two records that are exact inverses. A client whose ring collapsed still writes a
clean goodbye, so the host under-counts peer deaths. A client that closes cleanly
can outrun that same goodbye, so the host over-counts them. Grouped because one
design decision resolves both, and because both turn on the same unconditional
post-loop block at `client.rs:1890-1893` being read by the same host gate at
`connection.rs:200`.

### client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test observes the setup socket after a forced ring failure
Guarantee: The client's setup-socket departure signal does not distinguish a
clean exit from a transport failure, so the host's peer-death accounting
under-reports ring faults.
Check: `always` — whenever the bridge thread leaves its `while` loop at
`client.rs:1866`, it reaches `:1890-1893` and attempts `encoded_goodbye` followed
by `shutdown(Both)`, with no branch on why the loop ended. `always` because the
post-loop block is unconditional and evaluable on every thread exit.
Fault/timing angle: None for the write itself. The consequence lands on the host,
whose watcher at `connection.rs:199-206` calls `record_peer_death()` only for a
non-`Goodbye` close (`:200`).
Required faults and enabling state: Force the ring endpoint to fail after
activation, so the bridge breaks at `:1874` or `:1887`. Observe the host's setup
socket and assert whether `record_peer_death` fired.
Confidence: high — [evidence](evidence/client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye.md).
Verified the post-loop block is outside every `break` and that
`connection.rs:200` gates the peer-death counter on the message.
Existing check: `setup_socket.rs:820` and `:824` assert `observe_peer` returns
`Goodbye` and `UnexpectedEof` respectively, but nothing ties either to a client
transport state.
Impact: The host metric intended to count dead peers counts only peers that
failed to complete a socket write. A fleet losing rings would look like a fleet
of well-behaved clients.
Open questions:
- Should the bridge thread suppress the goodbye on its failure `break`s so the
  host classifies correctly? That makes a transport fault look like an abrupt
  EOF, which is the honest signal. (needs human input)

### client-a-a-close-completes-before-its-setup-goodbye-is-written

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — nothing constructs the ordering
Guarantee: The window in which `close()` has returned `Ok` while the detached
bridge thread has not yet written its setup-socket Goodbye is genuinely
reachable, so a clean client close can be observed by the host as an abrupt EOF.
Check: `sometimes` — at least once per campaign, observe the joint state:
`close()` has returned, `join_tasks_until` reported both Tokio tasks joined, and
the bridge thread has not yet executed `client.rs:1891`. `sometimes` rather than
`reachable` because the lines at `:1890-1893` are executed on essentially every
shutdown; what must be produced is the operational *ordering* in which the owner
outruns them, and location coverage cannot witness that.
Fault/timing angle: The whole record. `close` cancels at `:711`, joins only
writer and reader at `:1682`, and returns. The bridge thread observes
`cancel.is_cancelled()` at `:1866` only at the top of its next iteration, after
up to a 50-microsecond sleep (`:1886`) or a full in-flight ring write.
Required faults and enabling state: Independent preconditions, per the
coverage-check rule: (a) `close()` observed returning with
`within_deadline == true`; (b) the bridge thread observed still inside its loop
body or its sleep at that moment. Assert both, never the misclassification
itself.
Confidence: high — [evidence](evidence/client-a-a-close-completes-before-its-setup-goodbye-is-written.md).
Verified `join_tasks_until` (`:1677-1695`) iterates only
`[&self.writer, &self.reader]` and that the spawn at `:1852` discards its handle.
Existing check: none.
Impact: A clean shutdown is recorded by the host as a peer death, which is the
exact inverse of the previous record. Together they mean the host's
`record_peer_death` signal is uncorrelated with reality in both directions.
Open questions:
- Should `Inner` hold the bridge thread's `JoinHandle` so `close` can join it
  under the same 5-second budget? That budget is already shared with route
  teardown. (needs human input)

---

## Group C: in-flight work, which the client gets right

Two records that currently hold, and both are premises rather than findings. The
first is the client's core replay-safety guarantee: every pending request is
settled exactly once with an outcome that is `NotSent` only when the bytes
provably never left. The second is that no request frame can carry a
non-increasing correlation, so a conforming host's per-generation watermark never
closes the generation on this client. Grouped because both are proved by the same
locking discipline inside `admit` (`client.rs:1119-1217`) and both are stated so
that a regression has something to violate.

### client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `dropped_unary_future_cleans_pending_and_possibly_sent_request`
(`client.rs:3090`) and
`a_dropped_sender_after_an_absent_entry_reports_the_send_outcome` (`:3014`) cover
single-request classification, not bulk settlement on host death
Guarantee: When the host dies, every pending request is failed exactly once with
a send outcome that is `NotSent` only if its bytes provably never reached the
writer, and no pending request is silently dropped or retried.
Check: `always` — after any `retire`, the `pending` map is empty and, per pending
identity, exactly one settlement was delivered whose outcome is `NotSent` if and
only if `cancel_classification` (`client.rs:2223`) won the `QUEUED -> CANCELLED`
CAS. Per METHOD's effect-accounting rule the per-identity check is primary; the
cheap screen is that observed host-side effects lie between the count of
`NotSent` settlements subtracted from the total and the total. `always` because
it must hold at every retirement.
Fault/timing angle: The CAS at `:2225` races `claim_for_write` at `:1942`, which
is the writer's own `QUEUED -> WRITING` transition. A frame claimed by the writer
but not yet completed must classify `OutcomeUnknown`, which `classify` (`:2215`)
delivers by mapping both `WRITING` and `WRITTEN` there.
Required faults and enabling state: Kill the host with N pending requests
spanning all four publish states. Assert one settlement per identity and that no
`NotSent` claim was issued for a frame the host actually received.
Confidence: high — [evidence](evidence/client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome.md).
Verified `settle_all` drains under the `admission` mutex, that `finish_pending`
is the single settlement funnel, and that no retry path exists outside
`open_route`.
Existing check: `cancel_winning_queued_prevents_writer_claim_and_frame` (`:2478`)
and `writer_winning_cancel_is_outcome_unknown_and_queues_cancel` (`:2508`) cover
the CAS race for one request; status `unaudited`.
Impact: If a `NotSent` were ever issued for a delivered request, the caller would
replay a side-effecting operation. This is the client's core replay-safety
guarantee.
Open questions: None.

### client-a-no-request-frame-carries-a-non-increasing-correlation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `max_correlation_is_used_once_then_exhausted`
(`client.rs:2328`) and
`data_capacity_spares_control_reserve_and_does_not_burn_correlation` (`:3155`)
cover allocation and rewind in isolation
Guarantee: The sequence of `Request` correlations the client places on the wire
is strictly increasing, so a conforming host's per-generation watermark never
closes the generation on this client.
Check: `always` — for every pair of `Request` frames the writer completes in
order, the second correlation is strictly greater than the first, across control
(`0/0`) and routed identities alike, since both draw from one `Correlations`
(`client.rs:393`). `always` because the host evaluates it on every ingress frame
(`docs/mc-host-wire-protocol.md:656`).
Fault/timing angle: Two windows. First, `admit` must not release the
`correlations` guard between allocation and enqueue; it does not (`:1176-1217`).
Second, `restore` must never rewind past a frame already handed to the writer;
its guard (`:1742-1744`) plus the fact that a failed `try_send` returns the frame
(`:1207`) prevents that.
Required faults and enabling state: Concurrent `request`, `request_stream`,
`open_route`, `host_status`, and `host_shutdown` callers, interleaved with encode
failures (oversize body) and `data_tx` saturation to drive both `restore` sites.
Record the correlation of each frame as the writer completes it.
Confidence: high — [evidence](evidence/client-a-no-request-frame-carries-a-non-increasing-correlation.md).
Verified guard scope by reading `admit` end to end, and verified both `restore`
call sites precede any delivery to `data_tx`. Part 2a's
`request-correlation-strictly-increases-per-generation` is the host-side
enforcement this satisfies.
Existing check: `max_correlation_is_used_once_then_exhausted` (`:2328`); status
`unaudited`.
Impact: A violation is a host-side generation close before dispatch
(`docs/mc-host-wire-protocol.md:882`, vector V44), taking every unrelated route
down. I found no path that produces one.
Open questions: None.

---

## Group D: the liveness path and its two silences

Two records on the `Pong`, which is the client's only protocol obligation toward
host liveness. The first is that a `Pong` the client fails to enqueue leaves no
trace at all, because the call site binds the result to `_`. The second is that a
`Pong` it does enqueue can wait a full 30-second frame deadline, because the one
thread that would publish it may be parked delivering inbound frames. Grouped
because both make the same probe late for different reasons, and because the
client's own view of its liveness is unchanged in both cases.

### client-a-a-dropped-pong-is-never-observable-to-the-client

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo`
(`client.rs:2754`) covers the success path only
Guarantee: When the client fails to enqueue a Pong for a reason that does not
retire the generation, it records nothing, so a well-behaved host retires the
generation for a missed probe while the client still believes it is healthy.
Check: `always-or-unreached` — whenever `send_control` returns `Err` from its
encode branch (`client.rs:1329-1335`) while called from the `Ping` arm (`:1390`),
no counter, log, or state change results, because the result is bound to `_`.
`always-or-unreached` because the encode branch may never run against a
conforming host, but the swallowing must be safe if it does.
Fault/timing angle: The window is one host probe interval. The client learns only
when the host's own retirement arrives as an `eof` or `connection_goodbye`, by
which point the cause is lost; see
`client-a-a-retired-generation-forgets-why-it-retired`.
Required faults and enabling state: Inject an `encode_owned_frame` failure for a
`Pong`, or drive the reserved control channel to a state where the Pong path is
refused without retiring. Assert that no observable client state changed.
Confidence: medium — [evidence](evidence/client-a-a-dropped-pong-is-never-observable-to-the-client.md).
The swallowing at `:1390` is verified. I could not construct an
`encode_owned_frame` failure for a pure-header frame whose flags
`validate_inbound` already accepted, so the reachability of the failing branch is
unresolved and the confidence reflects that, not the code reading.
Existing check: `a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo`
(`:2754`); status `unaudited`.
Impact: The client's only protocol obligation toward host liveness fails
silently. Part 2a's `a-timely-pong-sustains-the-generation-within-a-bounded-round`
is the host-side liveness property this could break.
Open questions:
- Can `encode_owned_frame` reject a flag byte that `validate_inbound:2073-2080`
  accepted? If not, this branch is unreachable and the record should be
  downgraded. (unresolved, needs a `wire.rs` read that 2b owns)

### client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test stalls inbound delivery and measures Pong egress
Guarantee: Once inbound delivery backpressures, an enqueued Pong waits on the
same bridge thread that is parked delivering inbound frames, and the client
tolerates that for the full 30-second frame deadline before reacting.
Check: `always` — with the inbound channel full and the bridge parked in
`read_tx.blocking_send` (`client.rs:1882`), a control frame enqueued at `:1355`
is not written until either the bridge resumes or
`timeout_at(frame.deadline, completed_rx)` (`:1960`) expires, where
`frame.deadline` is `now + CLIENT_FRAME_TIMEOUT` (`:1353`, 30 s per `:45`). State
the bound in the unit the code bounds: one frame deadline, not "eventually".
`always` because the dependency holds on every control write once the
precondition is met.
Fault/timing angle: The bridge thread is the sole producer of write completions
(`:1872`) and the sole consumer of the write channel, so any inbound stall is
also an egress stall. This is the client-side mirror of Part 2b's
`ring-a-ingress-wait-holds-a-lease-while-servicing-egress`.
Required faults and enabling state: Bounded fault-free window, per METHOD's
liveness rule. Stall `ring_reader_loop` so the 256-slot inbound channel (`:1850`)
fills, enqueue a Pong, release the stall, then poll until the write completes
within an explicit bound of one frame deadline.
Confidence: high — [evidence](evidence/client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget.md).
Verified the bridge is the single completion producer, that `writer_loop` awaits
it before dequeuing the next frame, and that `RingClientEndpoint::send`'s own
bound is a hardcoded 2 s (`ring_transport.rs:663-667`) that ignores the frame
deadline.
Existing check: `data_saturation_never_starves_a_control_frame` (`:3225`) covers
queue-slot starvation, which is a different mechanism; status `unaudited`.
Impact: Whether the host retires the generation first depends on its probe
interval against 30 seconds. If the probe is shorter, an inbound stall presents
to the operator as a liveness failure rather than as backpressure.
Open questions:
- What is the host's probe interval and deadline? Part 2a owns the liveness
  probe; the comparison against `CLIENT_FRAME_TIMEOUT` needs that number.
  (unresolved, needs the 2a figure)

---

## Group E: the route cache, unbounded and collapsing

Two records on the one `Inner` collection with no capacity predicate. The first
is the missing bound, which the normative document names explicitly. The second
is the identity collapse: because the cache is a `HashSet`, a host that answers
two `route.open` requests with one `(channel, epoch)` merges two callers onto one
entry, and the cleanup path that would normally release a stray bind is the exact
path that returns early. Grouped because both are properties of
`routes.insert(handle)` at `client.rs:507`, one about how many entries it admits
and one about what an entry means.

### client-a-live-route-handles-are-bounded-only-by-the-host

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test opens routes to exhaustion
Guarantee: The client imposes no limit on concurrently live route handles, so the
only bound on its route cache is the host's willingness to keep binding.
Check: `always` — every successful `open_route` inserts into `routes` at
`client.rs:507` with no capacity predicate anywhere on that path, in contrast to
`pending` (`:1169`) and `streams` (`:1058`). `always` because the absence is a
total property of the insert path.
Fault/timing angle: None. The growth is caller-driven, not race-driven.
Required faults and enabling state: A host that binds every `route.open`. Open
routes in a loop without closing and observe `routes` growth against the absent
cap.
Confidence: high — [evidence](evidence/client-a-live-route-handles-are-bounded-only-by-the-host.md).
Verified only two `CLIENT_MAX_*` constants exist (`:53`, `:55`) and that neither
is consulted at `:507`. Contract side at
`docs/mc-host-wire-protocol.md:658`, which names routes in its finite-limits
list.
Existing check: none.
Impact: Unbounded caller-driven growth with no local reaper is the recurring
shape this catalog has found in every part. Here the damage is transitive: each
entry corresponds to a host channel and route permit, so a looping caller
exhausts host resources rather than its own.
Open questions:
- Does the host cap concurrent routes per generation, and does it answer
  `target_unavailable` on exhaustion as `docs/mc-host-wire-protocol.md:658`
  implies? If so the transitive bound is real, though undeclared on this side.
  (unresolved, needs the 2e or 2f route-admission figure)

### client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `a_duplicate_bind_terminal_never_closes_an_owned_route`
(`client.rs:3587`) covers the unmatched-terminal case, not two successful opens
returning one handle
Guarantee: If the host answers two `route.open` requests with the same
`(channel, epoch)`, the client conflates them into one cache entry, and one
`close_route` settles both callers' work while neither bind is separately
released.
Check: `always` — whenever `parse_route_open` yields a handle already present in
`routes`, `routes.insert` (`client.rs:507`) returns `false` and the set is
unchanged, so `settle_route` (`:1623`) can remove it at most once and
`release_stranded_route` returns early at `:1576-1578`. `always` because the set
semantics hold on every insert.
Fault/timing angle: None required, but the damage compounds if the two opens
overlap: the second caller receives `Ok(handle)` for a route the first caller can
close underneath it.
Required faults and enabling state: A host, or a fake peer, that answers two
distinct `route.open` correlations with an identical `route_channel` and
`route_epoch`. Assert both callers received `Ok`, that `routes.len() == 1`, and
that one `close_route` settles both callers' pending requests.
Confidence: high — [evidence](evidence/client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle.md).
Verified `routes` is a `HashSet<RouteHandle>` (`:944`), that `parse_route_open`
(`:2167-2206`) validates only shape, and that the early return at `:1576` is the
intended behaviour for the §8.2 case and therefore blocks cleanup here too.
Existing check: `a_duplicate_bind_terminal_never_closes_an_owned_route`
(`:3587`); status `unaudited`.
Impact: A host bug or a hostile peer at the setup path turns into cross-caller
interference inside one client: caller A's `close_route` silently settles caller
B's requests with `route_gone`. Part 2c established that epochs are host-minted
and that the activation token cannot gate mapping, so the client has no
independent basis to reject a repeated handle.
Open questions:
- Should `open_route` retire on a duplicate handle, the way it already retires on
  an unparseable one (`:486`)? Both are host protocol violations the client
  cannot name a remedy for. (needs human input)

---

## Group F: a host answer taken as proof

Two records where the client converts a host message into a belief about host
state it never verifies. `host_shutdown` returns `Ok` on a JSON echo of its own
operation name, and its doc comment declares that `Ok` the stop linearization
point a lifecycle owner waits on. `open_route` retries after four terminal codes
on the premise that each proves no route was bound. Grouped because both are
trust decisions rather than mechanisms, and because in both cases the fact the
client needs lives on the host side and the record's own open question says so.

### client-a-host-shutdown-success-rests-only-on-a-json-echo

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test supplies a well-formed echo from a host that did not
stop
Guarantee: `host_shutdown` returns `Ok` on the strength of a response body
echoing its own operation name, and nothing in the client verifies the host
actually stopped.
Check: `always` — `host_shutdown` (`client.rs:576-615`) returns `Ok(())` if and
only if the response body parses as JSON with `op == "host.shutdown"`
(`:598-606`); no other host state is consulted, and the connection is left open
by design (`:575`). `always` because the acceptance predicate is total over
responses.
Fault/timing angle: None inside the client. The window that matters is between
the host writing the response and the host actually stopping, which the doc's
shutdown ordering places at steps 3 through 9
(`docs/mc-host-wire-protocol.md`, section 12).
Required faults and enabling state: A fake peer that answers
`{"op":"host.shutdown"}` and then continues serving. Assert `host_shutdown`
returns `Ok` and that the caller's next operation still succeeds, which is the
observable form of "the stop was not real".
Confidence: high — [evidence](evidence/client-a-host-shutdown-success-rests-only-on-a-json-echo.md).
Verified the predicate, and verified that the `Ok` is load-bearing for a
downstream owner because the doc comment at `:575` declares it "the stop
linearization point the native lifecycle owner waits on".
Existing check: none found for `host_shutdown` in `client.rs`'s test module.
Impact: This is the shape a sibling part found on a producer that advanced a
durable checkpoint on an acknowledgement truthful about nothing. Here the
acknowledgement gates a lifecycle owner's belief that a daemon stopped, which is
the precondition for starting a replacement. A stale echo could produce two live
daemons.
Open questions:
- Does the host emit the `host.shutdown` response strictly after its stop is
  committed, as `:575` claims? That is a 2a or 2e claim about the host's control
  handler and is not verifiable from `client.rs`. (unresolved, needs the
  host-side handler)
- Does any caller of `host_shutdown` treat `Ok` as authority to launch a
  replacement daemon? `crates/mc-module/src/bin/ck-mc-host.rs` is the likely site
  and is outside this sub-part's scope. (unresolved, needs 2f or a mc-module
  pass)

### client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives the retry loop against a host that binds
after answering one of the four codes
Guarantee: `open_route` retries after four specific host terminal codes, and each
retry is a fresh `route.open` attempt whose safety depends entirely on those
codes proving no route was bound.
Check: `always` — for a sequence of `open_route` attempts ending in success, the
number of routes the host bound for that call is exactly one. Per METHOD's
effect-accounting rule, track attempted and acknowledged separately: attempts
equal loop iterations at `client.rs:461`, acknowledged failures equal the retried
terminals at `:511-519`, and host-side binds must equal one, not the attempt
count. The aggregate bound is the cheap screen; the per-attempt check is the
oracle. `always` because it must hold for every `open_route` call, not merely be
witnessed once.
Fault/timing angle: The retry is gated on `outcome == Terminal` (`:512`), so an
`OutcomeUnknown` never retries. The risk is confined to whether `module_timeout`
is a completed rejection or a host-side deadline that leaves module work in
flight.
Required faults and enabling state: A fake peer that answers `route.open` with
`Error{code:"module_timeout"}` and then also binds a route and emits a late
`Response` on `0/0`. Count host-side binds against client-side handles, and check
whether `release_stranded_route` (`:1572`) reclaims the extra.
Confidence: medium — [evidence](evidence/client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind.md).
The retry predicate and the fresh-correlation-per-attempt behaviour are verified.
Whether `module_timeout` is authoritative about the bind is a host-side question
I could not resolve, which is why this is medium and why the guarantee is worded
as a dependency rather than a defect.
Existing check: `an_abandoned_control_open_releases_a_late_bound_route` (`:3503`)
covers the late-bind remedy that would partially mitigate this; status
`unaudited`.
Impact: If `module_timeout` is a deadline rather than a rejection, each retry can
strand a host route and channel permit, bounded only by the 30-second route-open
deadline divided by the backoff. The mitigation at `:1572` works only while the
generation stays live.
Open questions:
- Is `module_timeout` emitted after the host proves no bind occurred?
  `docs/mc-host-wire-protocol.md:658` reserves `target_unavailable` for route
  admission and gives each code "exactly one recovery rule in Section 10.2",
  which suggests the codes are meant to be authoritative, but does not state it
  for `module_timeout`. (unresolved, needs the 2e control-handler pass)

---

## Group G: inbound strictness and its unreachable twin

Two records on `validate_inbound` (`client.rs:2006-2082`) and the `dispatch`
catch-all behind it. The first is that the validator is stricter than the
document for exactly one frame type, `Cancel`, and retires the whole generation
for it. The second is the consequence: because the validator rejects every type
`dispatch`'s catch-all would handle, that catch-all is unreachable from the
production reader, and the classification is duplicated at two sites that can
drift. Grouped because they are the same `match` residue read from two
directions, and because this synthesis's correction above bears on both.

### client-a-a-host-originated-cancel-retires-the-generation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `inbound_validation_enforces_the_direct_profile_table`
(`client.rs:2658`) exercises `validate_inbound` broadly; whether it asserts the
`Cancel` disposition is unverified
Guarantee: The client treats a host-originated `Cancel` as a framing violation
that retires the whole generation, although the protocol's role table does not
list host-originated `Cancel` as role-invalid and assigns `Cancel` an idempotent
no-op disposition.
Check: `always` — for `header.ty == FrameType::Cancel` (`wire.rs:58`),
`validate_inbound` (`client.rs:2006`) has no matching arm and falls to
`_ => return Err(())` at `:2067`, so `ring_reader_loop:1979` retires with
`protocol_violation`. `always` because the classification is total over inbound
frame types.
Fault/timing angle: None.
Required faults and enabling state: A fake peer that sends a well-formed
pure-header `Cancel` on a live route with a pending correlation. Assert the
client retires rather than treating it as a no-op.
Confidence: high — [evidence](evidence/client-a-a-host-originated-cancel-retires-the-generation.md).
Verified `validate_inbound`'s arms are exactly `Response|Error`,
`StreamData|StreamEnd`, `Push`, `Ping`, `Goodbye`, plus the catch-all, and that
`Cancel` is therefore in the residue. Contract side at
`docs/mc-host-wire-protocol.md:269` and `:280`.
Existing check: `inbound_validation_enforces_the_direct_profile_table` (`:2658`);
status `unaudited`, and its coverage of `Cancel` specifically is unverified.
Impact: If a host ever emits `Cancel`, every route on the generation dies. If a
host never does, the strictness is free and the finding is a documentation defect
rather than a code defect. Which of those holds is the open question.
Open questions:
- Is host-originated `Cancel` legal in this profile?
  `docs/mc-host-wire-protocol.md:269` enumerates role-invalid frames and omits
  `Cancel`, while `:280` gives `Cancel` a no-op disposition without naming a
  direction. The doc is ambiguous and the code is strict. (needs human input)

> Synthesis note, resolving this record's `Existing check:` caveat rather than
> editing it. The coverage is now verified and the answer is no.
> `inbound_validation_enforces_the_direct_profile_table` runs `:2658-2751`, and
> grepping that body for `Cancel`, `Request`, `Pong`, `Hello`, and `HelloAck`
> returns exactly one hit, `FrameType::Request` at `:2750`. So the test asserts
> one of the five residue types and says nothing about `Cancel`. The record's
> `Exercised: partial` remains correct as written; what changes is that the
> uncertainty is closed against the pessimistic reading.
>
> A second count correction, carried here rather than edited into the next
> record. Lens A's
> [client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production](#client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production)
> says the test module reaches `dispatch` at 16 sites. Grepping `dispatch(` from
> `:2266` onward returns **15**. The finding is unaffected, since the record's
> claim is that the production reader cannot reach `:1557` while the test module
> can; only the count moves. The 15 sites are listed in that record's evidence
> file.

### client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — reached only by the test module's 16 direct `dispatch` calls
Guarantee: `dispatch`'s catch-all retirement arm is unreachable from the
production reader, because `validate_inbound` already rejects every frame type
that would land there.
Check: `unreachable` — the statement at `client.rs:1557` is never executed on the
`ring_reader_loop` path. `unreachable` rather than `always(!X)` because the
subject is a specific code location that must not execute, which is exactly
METHOD's criterion.
Fault/timing angle: None.
Required faults and enabling state: No fault. The check is a marker at `:1557`
that must not fire during any production-path campaign, combined with the
independent observation that `validate_inbound` returned `Err` for the same frame
types.
Confidence: high — [evidence](evidence/client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production.md).
Verified that `dispatch` handles `Ping`, `Goodbye`, `Push`,
`Response|Error|StreamEnd`, and `StreamData`, that its catch-all therefore covers
`Request`, `Cancel`, `Pong`, `Hello`, and `HelloAck` (`wire.rs:52-63`), and that
`validate_inbound:2067` rejects all five. Confirmed `dispatch`'s only non-test
caller is `:1982`.
Existing check: none as a guard. The 16 test call sites listed in the evidence
file reach `dispatch` directly, bypassing validation.
Impact: Low on its own. It matters as a structural fact: the tests exercise a
dispatch surface the production reader cannot reach, so a regression that
loosened `validate_inbound` would be caught by nothing, and the duplicated
classification at `:1557` and `:2067` can drift.
Open questions: None.

---

## Relationship map

Grouped by shared mechanism rather than by the headings above, because the
sharpest relationships cross groups. **Every dominance statement below is a
hypothesis** about which oracle subsumes which, offered to order the work, not a
verified claim. None has been tested, and none can be tested by anything CI runs
today: this sub-part has zero CI-executed source-resident checks, and its six
CI-executed integration tests touch none of these records directly.

- **One erased cause, read from four sides.**
  [client-a-a-retired-generation-forgets-why-it-retired](#client-a-a-retired-generation-forgets-why-it-retired),
  [client-a-a-clean-host-close-and-a-transport-failure-share-one-code](#client-a-a-clean-host-close-and-a-transport-failure-share-one-code),
  [client-a-a-dropped-pong-is-never-observable-to-the-client](#client-a-a-dropped-pong-is-never-observable-to-the-client),
  [client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye](#client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye).
  All four are the same defect at different layers. `retire` keeps no cause
  (`client.rs:1667-1675`); five bridge exits produce one code (`:1987`); a
  dropped `Pong` produces no code at all (`:1390`); and the departure signal the
  host reads carries no cause either (`:1890-1893`). Hypothesis: storing the
  retirement cause on `Inner` and surfacing it through `CallError`
  *dominates* the first two, because each of their oracles reduces to "a
  post-retirement caller can name the cause". It dominates neither of the other
  two: a swallowed `Pong` never reaches `retire`, and the setup-socket signal is
  read by the host, not by a caller. Fixing the bridge's five exits to carry
  distinct codes without storing the cause dominates nothing, because the
  distinction would still be visible only inside `settle_all`'s loop.
- **One unjoined thread, three claims.**
  [client-a-a-close-completes-before-its-setup-goodbye-is-written](#client-a-a-close-completes-before-its-setup-goodbye-is-written),
  [client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye](#client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye),
  [client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget](#client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget).
  Every one of these turns on the bridge thread spawned at `:1852` with its
  handle discarded at `:1895`. It owns the ring attach (`:1855`), the sole write
  completion (`:1872`), and the departure write (`:1891`), and nothing observes
  any of the three. Hypothesis: retaining the `JoinHandle` and joining it under
  the existing 5-second shutdown budget *dominates* the close-ordering record
  outright, since the window it describes is exactly what a join closes. It
  dominates the ring-failure record only halfway: joining proves the write was
  attempted but not that its content distinguished the cause. It dominates the
  Pong-egress record not at all, because that record is a bound on time under
  backpressure and a join says nothing about it.
- **The route cache as one entry point.**
  [client-a-live-route-handles-are-bounded-only-by-the-host](#client-a-live-route-handles-are-bounded-only-by-the-host),
  [client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle](#client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle),
  [client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind](#client-a-route-open-retries-treat-four-host-terminals-as-proof-of-no-bind).
  All three land on `routes.insert(handle)` (`:507`) and on what the host is
  trusted to have done before it. Hypothesis: adding a `CLIENT_MAX_LIVE_ROUTES`
  predicate at `:507` dominates the first record and *nothing else*, which is
  worth stating because the three read as one cluster. A cap does not change
  `HashSet` merge semantics and does not make a retried `route.open` prove
  anything. Conversely, replacing the `HashSet` with a map keyed by the caller's
  identity would dominate the duplicate-bind record and give the retry record its
  missing accounting, because both need to distinguish two binds that currently
  hash equal.
- **Two premises that hold, stated so a regression has something to break.**
  [client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome](#client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome),
  [client-a-no-request-frame-carries-a-non-increasing-correlation](#client-a-no-request-frame-carries-a-non-increasing-correlation).
  Both are proved by the same locking discipline: `admit` holds the
  `correlations`, `admission`, and `pending` guards across allocation, encoding,
  and enqueue (`:1140-1141`, `:1176-1217`), and `settle_all` takes the whole
  pending map under `admission` (`:1651-1652`). Hypothesis: an oracle that
  records the correlation of every frame the writer completes, alongside the
  settlement each pending identity received, *dominates both*, because the
  monotonicity claim and the exactly-once-settlement claim are two readings of
  the same trace. Nothing dominates them separately, which is the argument for
  building that trace once rather than two fixtures.
- **Classification duplicated at two sites.**
  [client-a-a-host-originated-cancel-retires-the-generation](#client-a-a-host-originated-cancel-retires-the-generation),
  [client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production](#client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production).
  `validate_inbound:2067` and `dispatch:1557` both classify the same five frame
  types, and only the first is reachable from the reader. Hypothesis: a single
  table-driven classifier consulted by both sites would dominate the second
  record by construction, since the arm could not drift out of agreement. It
  dominates the first not at all: whether `Cancel` belongs in the residue is a
  contract question that no refactor answers, and the document is ambiguous
  (`docs/mc-host-wire-protocol.md:269` versus `:280`).
