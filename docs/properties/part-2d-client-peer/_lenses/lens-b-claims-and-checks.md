# Part 2d lens B: claim register and existing-check inventory

Attention focus: what this sub-part *promises* a peer and a caller, and what
mechanically holds each promise. Claim sources are the doc comments in
`crates/mc-host/src/client.rs`, the error and close-reason strings it emits, and
`docs/mc-host-wire-protocol.md`, which is the normative peer contract and the
primary claim source here. No property records; no evidence files. Method
contract in [../../METHOD.md](../../METHOD.md).

Scope: `crates/mc-host/src/client.rs` (3,998 lines), re-derived with `wc -l` at
`HEAD`. Production is `1-2264`; `#[cfg(test)] mod tests` runs `2266-3998`, which
is 1,733 lines, 43 percent of the file.

Provenance. Code read from `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"). Both facts confirmed with `git branch
--show-current` and `git log -1`, matching the re-scope map
(`../../part-2-rescope/scope-map-and-risk-ranking.md:7-9`). Every line reference
below was printed from that tree before being written.

**The docs may lag the refactor, and on this surface they do.** Per METHOD rule
3 the documentation establishes the obligation and never the satisfaction, so
each claim below carries its implementing code or the marker `NOT FOUND`. A doc
statement about a mechanism the refactor deleted is recorded in its own section
as a first-class finding, not as a stale-doc footnote.

## Sibling leads verified and folded in

The task handed down five findings from lens A. All five hold at `HEAD`. Line
references were re-derived rather than copied, and three corrections came out of
that re-derivation.

| Lens A lead | Verdict at `HEAD` |
| --- | --- |
| Correlation exhaustion does not retire the generation, contrary to the protocol document | confirmed. `Correlations::allocate` stops at `u64::MAX` (`client.rs:1735-1739`); `admit` maps `None` to `correlations_exhausted` (`:1177-1183`) and calls no `retire`. Registered as **C3**, implementing code `NOT FOUND`; the demoted record's test recipe is preserved there |
| The protocol document names routes in its bounding claim, but `routes` has no cap at its insertion point | confirmed. `routes: Mutex<HashSet<RouteHandle>>` (`:944`), `routes.insert(handle)` (`:507`) with no length test. `pending` is capped at `:1169`, `streams` at `:1058`. Registered as **C4** |
| `retire`'s cause is never stored, so a late caller gets a constant | confirmed. `retire(&self, code: &'static str)` (`:1667`) forwards the cause only to `settle_all` (`:1672`); `Inner`'s fields (`:934-960`) hold no cause slot. Late callers get `connection_retired` (`:1129`, `:1145`) or `generation_retired` (`:2237`). Registered as **C8** |
| The bridge writes a setup-socket goodbye unconditionally after every exit | confirmed. `encoded_goodbye` then `shutdown(Both)` at `:1890-1893`, after the loop closes at `:1889`, so every `break` at `:1874`, `:1877`, `:1883`, and `:1887` reaches it. `connection.rs:200` calls `record_peer_death()` only when the close is not `Goodbye`. Registered as **C5** |
| A detached bridge thread has its handle discarded, busy-polls at 50 microseconds, and is never joined | confirmed. `std::thread::Builder::new()` at `:1852`, `.spawn(` at `:1854`, and the only thing applied to the result is `.map_err(...)` at `:1895`. `Ok(None) => std::thread::sleep(Duration::from_micros(50))` at `:1886`. `join_tasks_until` (`:1677-1695`) iterates `[&self.writer, &self.reader]` only (`:1682`). Registered as **C6** |

**Three line-reference corrections to lens A**, recorded per METHOD rule 1 so a
synthesis pass does not inherit them.

1. Lens A's `## What persists across a reconnect` cites
   `docs/mc-host-wire-protocol.md:12` for the client `Recovering` state. `:12`
   is "This document is the direct-only wire authority." The `Recovering`
   transitions are at `:762-764`, and the exact quoted string "bounded backoff,
   reread file" is at **`:764`**. Lens A's own lead L4 cites "section 12"
   correctly; only the line number in the earlier section is wrong.
2. Lens A's leads L1 and O17 cite `docs/mc-host-wire-protocol.md:746` for the
   shared queued-byte budget. That line is blank. The sentence "Data and
   reserved-control frames share one queued-byte budget; reserved admission is
   not a byte-budget bypass" is at **`:745`**. Off by one.
3. Lens A's lead L2 cites `docs/mc-host-wire-protocol.md:62` for `NotSent`
   meaning provably-never-sent. `:62` is the `terminal` bullet. The `not_sent`
   definition is at **`:60`**.

Lens A's other doc citations were spot-checked and hold: `:256` (`Push`
reserved), `:269` (role-invalid enumeration), `:280` (`Cancel` disposition),
`:654` (correlation allocation), `:656` (ingress watermark), `:658` (finite
limits), `:808` (`HistorianProducer` as a `mc_host::Client` consumer). The
deadline table lens A cites as `:736-743` has its header at `:735`, its separator
at `:736`, and its seven data rows at `:737-743`.

## Claims register

20 claims, ordered by consequence. `Where stated` is the claim source;
`Implementing code` is where the obligation is discharged, or `NOT FOUND`. Doc
references without a file are `docs/mc-host-wire-protocol.md`.

### C1 — `host_shutdown` returning `Ok` is the stop linearization point

Where stated: `client.rs:575`, verbatim — "The host commits the stop only after
the complete `host.shutdown` response frame reaches the socket, so `Ok` here is
the stop linearization point the native lifecycle owner waits on; the connection
itself stays open." Backed by `:532-557` (§7.6, the `open ->
response_in_flight -> committed` latch) and V45 (`:883`).

Implementing code: `host_shutdown` (`client.rs:576-614`). The whole local
evidence is a JSON echo: `serde_json::from_slice` then `value.get("op") == "host.shutdown"`
(`:598-606`), else `invalid_shutdown_response` (`:607-613`). The
commit-after-acknowledgement property is entirely host-side; nothing in this
sub-part observes the latch, the publication removal, or the instance-lock
release that `:557` names as the actual stop verification.

Existing check: none. No in-crate test and none of the six `tests/client.rs`
tests calls `host_shutdown`; the integration tests use
`host.shutdown_gracefully()` (a harness path) instead.

### C2 — the three send outcomes are exact, and only proven pre-send failures may be retried

Where stated: `:60-62` (the definitions), `:699-708` (the outcome table plus
"Managed Rust and TypeScript clients retry only proven pre-send failures ...
Outer caller policy MUST NOT silently multiply client retries"), `:703` ("no"
generic replay for `outcome_unknown`), V30 (`:868`), V37 (`:875`), and
`client.rs:117-121` ("Request bytes provably never reached the writer" /
"Some request bytes may have reached the peer without a terminal" / "Matching
host terminal was observed"), `:531` ("The body is never replayed").

Implementing code: `SendOutcome` (`client.rs:116-123`) with `as_str`
(`:127-133`) pinning `not_sent` / `outcome_unknown` / `terminal`;
`cancel_classification` (`:2223`) and `classify` (`:2215`) map `QUEUED` to
`NotSent` and `WRITING`/`WRITTEN` to `OutcomeUnknown`; the writer's
`claim_for_write` gate (`:1939-1945`) and `state.store(WRITTEN, ...)` (`:1967`)
are what make the classification byte-truthful on the ring path. No retry loop
exists outside `open_route` (`:511-525`).

Existing check: `tests/client.rs` asserts an outcome in five of six tests
(`:131`, `:171-174`, `:207`, `:240`); `outcome_spellings_are_exact`
(`client.rs:3993`) pins the three strings.

### C3 — `u64::MAX` may identify one final request, then the sender MUST retire the generation

Where stated: `:654`, verbatim — "A correlation MUST NOT be reused, even after
terminal completion. `u64::MAX` may identify one final request; before another
request, sender MUST retire the generation and reconnect." Also V22 (`:860`),
"Use once, then retire/reconnect generation before another request".

Implementing code: **half found, half NOT FOUND.** The no-reuse half is
discharged: `Correlations::allocate` (`client.rs:1735-1739`) uses `checked_add`
and returns `None` forever after `u64::MAX`. The MUST-retire half is `NOT
FOUND`: `admit` (`:1177-1183`) returns `correlations_exhausted` with
`SendOutcome::NotSent` and calls no `retire`, so `retired` stays false and
`daemon_id`, `host_status`, and every public accessor keep reporting a healthy
connection. The pattern exists two dozen lines away — `send_control` retires on
its own unrecoverable capacity failure at `:1341` and `:1356` — and is simply
not applied here. A grep for `correlations_exhausted` across the tree returns
only `client.rs:1180`.

Consequence, preserved from the demoted sibling record: `NotSent` means
provably-never-sent and therefore safe to retry (`:60`, `client.rs:117`), so a
caller with an ordinary retry loop spins forever against a connection that can
never serve another request and will never retire itself, and a caller that keys
reconnection off retirement never reconnects. Reaching the state needs 2^64
admissions, so practical severity is low; the shape — a permanent local capacity
failure reported as a retryable per-call error — is what carries forward.

Test recipe, preserved verbatim from the demoted record
`client-a-correlation-exhaustion-does-not-retire-the-generation`: build an
`Inner` whose `Correlations` starts at `u64::MAX` using the fixture pattern from
`max_correlation_is_used_once_then_exhausted` (`client.rs:2328`), consume the
last correlation through a real `admit`, then assert both
`correlations_exhausted` and `retired == false`.

Existing check: partial and on the wrong half.
`max_correlation_is_used_once_then_exhausted` (`:2328`) and
`real_admission_exhausts_after_max_without_second_charge_or_frame` (`:2338`)
both cover the no-reuse half and the absence of a second charge or frame.
Neither asserts anything about `retired`.

### C4 — implementations MUST use finite limits for live routes

Where stated: `:658`, verbatim — "Implementations MUST use finite limits for
live connections, routes, pending correlations, handler tasks, queued requests,
and aggregate buffered bodies." Routes are named explicitly. V28 (`:866`) is the
scenario.

Implementing code: **NOT FOUND for routes.** `pending` is capped by
`CLIENT_MAX_PENDING_REQUESTS` (`client.rs:53`) at `:1169`; `streams` is capped by
`CLIENT_MAX_LIVE_STREAMS` (`:55`) at `:1058`; queued frames and bytes are capped
by `CLIENT_DATA_QUEUE_FRAMES` (`:59`), `CLIENT_QUEUED_BYTES` (`:69`),
`CLIENT_CONTROL_QUEUED_BYTES` (`:76`), `CLIENT_INBOUND_FRAME_BYTES` (`:86`), and
`CLIENT_RETAINED_RESPONSE_BYTES` (`:93`). There is no `CLIENT_MAX_LIVE_ROUTES`.
`routes.insert(handle)` (`:507`) tests only `closed` (`:501`), never
`routes.len()`. The bound is transitive only: the host owns channel allocation
(`:619`, `:626`) and returns terminal `target_unavailable` when all channels are
live or retired, so route growth is bounded by a limit stated in another
component and enforced nowhere in this file.

Existing check: none. Reapers are exercised — `settle_route` (`:1623`), `retire`
(`:1673`), `close` (`:684`) — but no test drives the route set toward any
ceiling, because there is none to drive it toward.

### C5 — a clean `Goodbye` and an unexpected setup-socket loss are distinct

Where stated: `:296`, verbatim — "Clean `Goodbye` followed by joined teardown is
orderly connection close." `:691` — "Unexpected setup-socket EOF has equivalent
retirement effect but no peer drain guarantee." `:563` — "Runtime ring
corruption or unexpected setup-socket EOF also retires the connection."

Implementing code: **NOT FOUND, and the code actively defeats the distinction on
the client's departure.** `start_ring_bridge`'s thread body writes
`encoded_goodbye` and then `shutdown(Both)` at `client.rs:1890-1893`,
unconditionally, after the `while` loop closes at `:1889`. Every exit reaches
it: an `endpoint.send` failure (`:1873-1875`), `write_rx` disconnection
(`:1877`), a `read_tx.blocking_send` failure (`:1882-1884`), a `try_recv_with`
error (`:1887`), and ordinary cancellation (`:1866`). The host reads that socket
in `connection.rs:199-206` and calls `peer_ring.record_peer_death()` only when
`close != PeerClose::Goodbye` (`:200`). So a client whose ring collapsed departs
looking clean, and the host's peer-death counter under-reports transport faults.

Existing check: none. No test inspects the setup socket after a client-side ring
failure, and the in-crate suite never constructs a bridge thread at all.

### C6 — connection close is a bounded, joined teardown

Where stated: `:691`, verbatim — "Connection close is Goodbye on channel 0,
epoch 0, correlation 0, followed by joined ring teardown and setup-socket
close." `:741` bounds it at "one 5 s absolute deadline"; `client.rs:51` is the
matching `CLIENT_SHUTDOWN_TIMEOUT`.

Implementing code: **partial, with the bridge half NOT FOUND.** `close`
(`client.rs:671-721`) sends route `Goodbye`s, then the connection `Goodbye` under
`result.is_ok()`, then cancels, then calls `join_tasks_until` (`:1677-1695`).
That function iterates exactly `[&self.writer, &self.reader]` (`:1682`) and
aborts on deadline overrun (`:1687-1691`). Nothing joins the bridge OS thread,
because its `JoinHandle` was discarded at `:1852-1895` — the only combinator
applied to `spawn`'s result is `.map_err` at `:1895`. So `close()` returning
`Ok` proves the two Tokio tasks finished; it does not prove the setup-socket
`Goodbye` of C5 reached the socket, nor that the thread exited. The same thread
busy-polls at 50 microseconds (`:1886`), so one idle connection spins an OS
thread at roughly 20 kHz for its whole lifetime.

Existing check: `close_rejects_new_sends` (`tests/client.rs:227-243`) and
`dropped_close_retires_and_repeated_close_joins_tasks` (`client.rs:3121`) cover
the task half. Nothing observes the thread.

### C7 — retirement immediately invalidates routes, pending correlations, and caches

Where stated: `:751`, verbatim — "Any EOF, authentication failure, framing
corruption, liveness failure, or explicit connection close retires the
connection generation. Client MUST immediately invalidate its routes, pending
correlations, capability/catalog caches, and late responses." Also `:656`
("No frame from an old generation, wrong channel/epoch, unknown correlation, or
terminal correlation may affect current work").

Implementing code: `retire` (`client.rs:1667-1675`) — idempotent through
`retired.swap` (`:1668`), sets `closed` (`:1671`), `settle_all(code)` (`:1672`),
`routes.clear()` (`:1673`), `cancel.cancel()` (`:1674`). Late-response fencing
is separate: `PendingKey` carries channel and epoch (`:1406-1410`), so a
stale-epoch terminal cannot match.

Existing check: strong. `settle_all` and the epoch fence are covered by
`admission_winning_is_settled_by_close` (`:2456`),
`stale_epoch_terminal_cannot_settle_reused_channel` (`:3270`), and
`epoch_is_part_of_pending_key` (`:3959`). All in-crate.

### C8 — a retirement cause is a stable bounded code

Where stated: `client.rs:183` ("Stable bounded error code"), `:142` ("Managed
call failure. Formatting never includes payload or identity data"), and V24
(`:862`, "bounded counters remain observable"). `retire`'s own signature makes
the claim structurally: it takes a `&'static str` cause (`:1667`).

Implementing code: **NOT FOUND for retention.** The cause reaches
`settle_all(code)` (`:1672`) and becomes each already-pending caller's
`CallError::code()`, and nothing else. `Inner`'s fields (`:934-960`) hold no
cause slot. A caller arriving after retirement gets the constant
`connection_retired` from `admit` (`:1129`, `:1145`) or `generation_retired`
from `send_control` via `retired_error` (`:1327`, `:2237`). So eight distinct
causes — `connection_goodbye` (`:1397`), `protocol_violation` (`:1557`, `:1979`),
`eof` (`:1987`), `write_failed` (`:1954`, `:1963`),
`control_capacity_exhausted` (`:1341`, `:1356`), `invalid_route_response`
(`:486`), `stranded_route_cleanup_failed` (`:1588`), and the three local
lifecycle codes (`:676`, `:744`, `:766`) — collapse to two constants for every
caller that was not already pending at the instant of retirement.

Existing check: partial and only on the constants.
`close_wins_against_admission_blocked_on_pending` (`:2365`) asserts
`connection_retired` at `:2408`; another test asserts `generation_retired` at
`:2556` and `:3043`. Nothing asserts what a late caller can learn about the
cause.

### C9 — data and reserved-control frames share one queued-byte budget

Where stated: `:745`, verbatim — "Data and reserved-control frames share one
queued-byte budget; reserved admission is not a byte-budget bypass. Data traffic
cannot consume control slots."

Implementing code: **contradicted, deliberately and with a written rationale.**
`control_budget` is a distinct `ByteCounter` funded by
`CLIENT_CONTROL_QUEUED_BYTES` (`client.rs:76`), constructed at `:399` and
declared at `:949`, separate from `queue_budget` (`:398`, `:945`).
`send_control` charges the reserved pool at `:1340` with the comment at
`:1336-1339`: "The reserved pool, not the shared one: a control charge failing
here retires the whole generation, so charging it against bytes that ordinary
requests can legitimately occupy turned a busy connection into a self-inflicted
teardown." The constant's own doc at `:63-70` says the same. Note that the
*second* half of `:745`, "Data traffic cannot consume control slots", **is**
satisfied — `CLIENT_CONTROL_QUEUE_FRAMES` (`:61`) funds a separate `control_tx`
(`:956`). Only the shared-byte-pool half is contradicted. Sibling lead L1 owns
this from the design side; it is registered here because the doc is normative and
binds the TypeScript client by the same sentence.

Existing check: `data_capacity_spares_control_reserve_and_does_not_burn_correlation`
(`:3155`) and `data_saturation_never_starves_a_control_frame` (`:3225`) assert
the *separation*, which is the code's behaviour and the doc's negation. In-crate.

### C10 — exhausting the control reserve retires the generation and settles pending work deterministically

Where stated: `:745` — "Exhausting control reserve retires the generation and
deterministically settles pending work."

Implementing code: `send_control` (`client.rs:1340-1347` on byte-charge failure,
`:1355-1362` on channel-full), both calling `self.retire("control_capacity_exhausted")`
and returning `SendOutcome::Terminal`. Determinism comes from `settle_all`
(`:1649-1665`) taking the whole map under the `admission` mutex.

Existing check: `control_exhaustion_retires_and_releases_all_queued_bytes`
(`:3196`) and `route_settlement_never_floods_the_reserved_control_queue`
(`:2621`). Both in-crate.

### C11 — every operation owns one absolute deadline and per-stage timers do not multiply it

Where stated: `:731`, verbatim — "Every operation owns one absolute deadline;
per-stage timers MUST NOT multiply it." The seven defaults are `:737-743`. Also
`:745` — "Backoff counts the first attempt, and retry delay or a later stage
never resets the owning deadline."

Implementing code: `client.rs:43-51` declares the five budgets and they match the
doc table exactly. `connect` starts the handshake clock *before* discovery
(`:314`) with the rationale at `:307-313`; each stage then spends
`saturating_duration_since` off that one deadline (`:351`, `:365`, `:522`).
`open_route`'s backoff is clamped to `remaining` (`:522-524`) inside the
30-second absolute deadline. `deadline_at` (`:1996-2003`) converts a
caller-supplied timeout with `checked_add` and returns typed `invalid_timeout`
(`:2000`) rather than panicking, with the rationale at `:1992-1995`.

Existing check: `request_deadline_is_one_absolute_owner_and_honors_overrides`
(`tests/client.rs:187-225`) is the only CI-executed deadline proof, and it covers
the request domain only. `an_out_of_range_timeout_is_rejected_instead_of_panicking`
(`client.rs:2856`) covers `deadline_at`. Nothing covers the handshake budget's
pre-discovery start.

### C12 — a `Pong` exactly echoes the `Ping`'s version, flags, channel, epoch, and correlation

Where stated: `:681` — "client returns Pong with identical version, flags,
channel, epoch, and correlation", V35 (`:873`), and `client.rs:1316-1318`:
"`flags` is explicit because a `Pong` must echo the `Ping`'s flags exactly
(conformance vector V35), and §6.1 lets a conforming peer pick any valid
priority - so no single flag byte is correct for every control frame."

Implementing code: `dispatch`'s `Ping` arm (`client.rs:1387-1396`) passes
`header.flags` through unchanged and `FrameId::control(header.corr)`, with the
`// V35` comment at `:1389`. Note the call is `let _ = self.send_control(...)`
(`:1390`), so an encode failure (`:1329-1335`, the one `send_control` path that
does not retire) drops the `Pong` with no local trace.

Existing check:
`a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo`
(`client.rs:2754`). In-crate. Also driven indirectly by
`ring_stream_and_control_traffic_share_one_live_generation`
(`tests/client.rs:61`), which configures a real `LivenessPolicy`
(`:64-68`) and is CI-executed.

### C13 — Ping/Pong is owned independently of application waits, and stream saturation must not block it

Where stated: `:683`, verbatim — "Managed Rust and TypeScript readers own
Ping/Pong independently of application waits and stream consumption. A Ping
during a unary or streaming request MUST produce Pong without settling,
cancelling, or delaying the application request. Stream queue saturation MUST
NOT block this liveness path."

Implementing code: **partial.** The reserved control channel (`client.rs:956`,
`:61`) and reserved byte pool (`:76`) keep the `Pong` admissible under data
saturation, and `ring_reader_loop` (`:1976-1988`) dispatches without awaiting any
application consumer. But egress is not independent: `writer_loop` hands bytes to
the single bridge thread (`:1947-1956`) then awaits `completed_rx` under
`timeout_at(frame.deadline, ...)` (`:1957-1961`), and only that thread sends the
completion (`:1872`). The thread can be parked in `read_tx.blocking_send`
(`:1882`) when the 256-slot inbound channel (`:1850`) is full, so a stalled
inbound consumer delays the `Pong` for up to `CLIENT_FRAME_TIMEOUT` (`:1353`),
which is 30 seconds.

Existing check: `data_saturation_never_starves_a_control_frame`
(`client.rs:3225`) covers the admission half.
`ring_stream_and_control_traffic_share_one_live_generation`
(`tests/client.rs:61-108`) covers the concurrent-progress half against a real
host and a real 20 ms `ping_interval`, and it is CI-executed. Neither drives the
bridge thread into `blocking_send` backpressure.

### C14 — the reader validates every header field before the body is used, and enforces the channel-0 cap on the header

Where stated: `:236` — "A reader MUST read the prefix, reject unsupported
version, read the remaining 16 header bytes, validate the complete header, and
only then allocate/read the body." `:294` — "The receiver MUST validate all
offsets, lengths, sequence metadata, header fields, and descriptor identity
before exposing a scoped receive lease." `:321` caps a channel-0 body at 65,536
bytes. V16 (`:854`).

Implementing code: `validate_inbound` (`client.rs:2006-2082`), called first in
`ring_reader_loop` (`:1978`) alongside a `body.len() != header.len` recheck. The
channel-0 cap is enforced on the header at `:2015` with the allocation rationale
at `:2010-2014`: "Rejecting on the header keeps one oversize control response
from being allocated and retained at all — `parse_route_open` ignores unknown
fields, so a padded response would otherwise open a route and leave the
generation live while holding roughly 64 MiB." The per-type identity table is
`:2019-2068` and the pure-header flag check follows at `:2069`.

Existing check: `inbound_validation_enforces_the_direct_profile_table`
(`client.rs:2658`) is the densest single test in the sub-part, 96 lines. In-crate.

### C15 — a host-originated `Request` is role-invalid and closes the generation

Where stated: `:269`, verbatim — "A consumer-originated `Response`, `Push`,
`StreamData`, `StreamEnd`, or `Error`, and every host-originated `Request`, are
role-invalid. The receiver MUST close the generation rather than extend this
profile implicitly." V42 (`:880`). `:267` adds `Hello`/`HelloAck`.

Implementing code: `validate_inbound`'s catch-all `_ => return Err(())`
(`client.rs:2067`), reached by `ring_reader_loop` and turned into
`retire("protocol_violation")` (`:1979`). The arms that precede it cover
`Response|Error` (`:2022`), `StreamData|StreamEnd` (`:2038`), `Push` (`:2050`),
`Ping` (`:2057`), and `Goodbye` (`:2062`), so `Request`, `Pong`, `Cancel`,
`Hello`, and `HelloAck` all land in the residue. **Over-broad for one type:**
`FrameType::Cancel` is in that residue, and `:280` gives host-originated
`Cancel` an idempotent-no-op disposition rather than a close, while `:269` does
not list it as role-invalid. Sibling record
`client-a-a-host-originated-cancel-retires-the-generation` owns that half.

Existing check: `inbound_validation_enforces_the_direct_profile_table`
(`:2658`). In-crate.

### C16 — the writer verifies `len` against the body, publishes exactly once, and keeps one FIFO writer per direction

Where stated: `:298`, verbatim — "Writers MUST verify header `len` equals body
length, reserve enough bounded ring capacity for the complete frame, fill the
reservation, and publish exactly once. Each direction has one logical writer and
FIFO publication order. A failed or underfilled reservation aborts without
publication." `:656` adds that the ingress watermark "obligates the sender to
write `Request` frames in allocation order."

Implementing code: one `writer_loop` task (`client.rs:409-411`) draining
`data_rx` and `control_rx` into one `RingWrite` channel, so there is exactly one
logical writer. Allocation order equals enqueue order because `admit` holds the
`correlations` guard (`:1176`) across allocation (`:1177`), encoding (`:1186`),
and `data_tx.try_send` (`:1207`) with the `admission` and `pending` mutexes also
held (`:1140-1141`). Exactly-once publication is the `claim_for_write` CAS gate
(`:1939-1945`) plus `state.store(WRITTEN, ...)` (`:1967`). `decode_outbound`
(`:1903`) re-derives the header and body split on the bridge side.

Existing check: `cancel_winning_queued_prevents_writer_claim_and_frame`
(`:2478`), `writer_winning_cancel_is_outcome_unknown_and_queues_cancel`
(`:2508`), `a_pre_cancelled_unary_never_enqueues_a_frame` (`:2898`),
`a_pre_cancelled_stream_never_enqueues_a_frame` (`:2867`). All in-crate. Nothing
asserts FIFO across the two queues.

### C17 — an unmatched control `Response` naming a route is a late bind the client must release

Where stated: `:650`, verbatim in part — "The client MUST therefore treat an
unmatched control `Response` that names a route as a late bind it cannot own and
apply the same remedy. A bind already present in the client route cache belongs
to a caller that received it and MUST NOT be released this way." `:648` gives the
remedy: "Client sends best-effort route `Goodbye`; if it cannot queue cleanup
safely, it closes the connection." AE8 (`:833`).

Implementing code: `release_stranded_route` (`client.rs:1572-1600`) with its doc
comment at `:1561-1571` citing §8.2 directly, the already-cached early return at
`:1576-1578` (verified: `if lock_unpoisoned(&self.routes).contains(&route) { return; }`) discharging the second sentence, and
`retire("stranded_route_cleanup_failed")` (`:1588`) discharging the
close-on-failure clause. A body naming no route is left alone (`:1565-1566`).

Existing check: `an_abandoned_control_open_releases_a_late_bound_route`
(`:3503`) and `a_duplicate_bind_terminal_never_closes_an_owned_route` (`:3587`).
Both in-crate, and together the largest pair in the suite at 84 and 44 lines.

### C18 — call formatting never includes payload or identity data, and codes are bounded

Where stated: `client.rs:142` ("Managed call failure. Formatting never includes
payload or identity data"), `:183` ("Stable bounded error code"), `:188`
("Bounded redacted message"), `:250` ("Response bytes. The client does not
interpret application payloads"), and V24 (`:862`). `:337` makes `code` stable
and `message` diagnostic normatively.

Implementing code: `bounded_code` (`client.rs:2248-2259`) filters to
`[A-Za-z0-9_.-]` and truncates at `MAX_ERROR_CODE_BYTES` = 128 (`:112`);
`host_terminal`'s message handling (`:169-175`) with
`MAX_ERROR_MESSAGE_BYTES` = 512 (`:113`); `invalid_identity` (`:2125`, `:2161`)
as the fallback code.

Existing check: `terminal_formatting_redacts_peer_message_and_body`
(`:3978`, in-crate) and
`ring_terminal_is_typed_redacted_and_generation_remains_usable`
(`tests/client.rs:110-146`), which plants the sentinel
`CANARY-TERMINAL-BODY-7f31` (`:118`) and asserts it is absent from both `Debug`
and `Display` (`:133`). The second is CI-executed and is the strongest redaction
proof in the sub-part.

### C19 — `Push` is reserved, decoded and fenced, and never emitted by this host

Where stated: `:256` — "reserved | decoded and fenced; host does not emit it in
this profile". `:279` gives it a "client drops absent/stale route" disposition.

Implementing code: `validate_inbound` accepts it structurally (`client.rs:2050`)
and `dispatch` discards it with `FrameType::Push => {}` (`:1405`). The frame's
`ByteCharge` is dropped with the arm, so accounting is uniform. Nothing counts
the event, so a host that began emitting `Push` would be invisible.

Existing check: `inbound_validation_enforces_the_direct_profile_table`
(`:2658`) covers the structural half. No test drives the `dispatch` arm.

### C20 — discovery and authentication obligations, discharged outside this sub-part

Where stated: `:86-96` (descriptor-anchored snapshot, reject non-2
`wire_version` before opening the setup socket, "A client MUST NOT validate by
pathname and then reopen that pathname"), `:214` (constant-time server proof,
then daemon ID, then daemon version, "It MUST emit no `ClientAuth` until all
three checks succeed"), V1-V7 (`:839-845`), V51 (`:927`).

Implementing code: **not in this sub-part.** `connect` (`client.rs:306-344`)
delegates the whole snapshot to `read_for_client` (`connection_file.rs`, 2c
scope) inside `spawn_blocking` and maps any failure to `discovery_failed`
(`:341-342`); `connect_info` delegates the handshake to `authenticate_client`
(`auth.rs`, 2c scope) at `:358-364` and maps failure to
`authentication_failed` (`:363`). What 2d owns is the budget wrapper: one
deadline (C11), the `CLIENT_DISCOVERY_SLOTS` = 64 cap on concurrent snapshots
(`:104`) with its permit moved into the closure so a detached worker still
counts (`:106-107`, `:328-331`, `:335`), and the failure-code mapping.

Existing check: `authenticates_attaches_ring_routes_unary_and_closes`
(`tests/client.rs:30-59`) drives the whole path against a real host and asserts
the publication carries `setup_socket` and no `endpoints` key (`:35-36`). CI-executed.
Nothing in this sub-part tests the discovery-slot cap.

## Contract-vs-code leads

Recorded with both sides cited, not resolved. Four leads that sibling lens A did
not raise, plus a pointer to the five it did.

Lens A's L1 through L5 (separate control byte budget, correlation exhaustion,
unbounded routes, absent `Recovering` state, ambiguous host-originated `Cancel`)
are folded into C9, C3, C4, the note below, and C15 respectively. The four below
are new.

**L1 — the `CLIENT_FRAME_TIMEOUT` contract is stated in terms of a reader this
client no longer has.** `client.rs:44` reads "Deadline for a frame after its
first header byte. Idle header waits are unbounded", and `:738` states the same
normatively: "frame completion after first header byte | one 30 s absolute
deadline; idle first-header wait is unbounded". Neither is discharged by the ring
path, because the client never sees a first header byte. `ring_reader_loop`
receives an already-decoded `(EnvelopeHeader, Vec<u8>, ByteCharge)` triple from
the bridge (`:1977`) with no timeout at all, and the constant's only production
uses are the *writer's* per-frame publication deadline (`:1353`, and
`frame.deadline` at `:1960`). So the 30-second budget survives as a real bound,
but it bounds outbound publication rather than inbound frame completion, and the
"idle first-header wait is unbounded" half now describes an unbounded
`read.recv().await` that has no header/body distinction to be unbounded between.
Recorded again in the deleted-mechanism section, because the reader it describes
was deleted by `ed487e11`.

**L2 — `host_shutdown` and `close` disagree about which deadline they own.**
`host_shutdown` (`client.rs:585`) computes `Instant::now() + CLIENT_SHUTDOWN_TIMEOUT`
and passes it as a *request* deadline into `unary`. `:740` gives the request
domain "one caller-overridable 30 s absolute deadline" and `:741` gives client
shutdown a separate 5 s one, and `:731` says the domains are separate.
`host_shutdown` is an ordinary channel-0 request that happens to be about
shutdown; giving it the shutdown budget makes a host that is slow to acknowledge
fail at 5 seconds with `deadline_expired` and `SendOutcome::OutcomeUnknown`,
which by C1 means the caller cannot tell whether the stop committed. Whether the
5 s choice is deliberate is unresolved: there is no comment at `:585`, and
`close` (`:673`) uses the same constant for its own genuinely-shutdown budget.

**L3 — the two `unreachable!()` sites are production panics reachable only if
`validate_inbound` and `dispatch` disagree.** `client.rs:1440` and `:1457` are
the catch-all arms of the terminal match inside `dispatch`, and they are the only
`unreachable!` in the file's production half; there is no `assert!`,
`debug_assert!`, or `panic!` anywhere in `1-2264`. Both are guarded by the outer
`FrameType::Response | FrameType::Error | FrameType::StreamEnd` arm at `:1406`,
so they are unreachable today. They become reachable if a future arm is added to
`:1406` without a matching arm inside, and a panic there kills the reader task,
which by C7 means no `retire` runs and every pending caller hangs to its own
deadline instead of being settled. `:296` and `:724` both promise that a framing
fault retires the generation; a reader panic is the one inbound fault that does
not. Nothing in the file states the coupling between the two match sites.

**L4 — `settle_all`'s single code cannot express a mixed close.** `close`
(`client.rs:671-721`) walks the route `Goodbye` loop and `break`s on the first
failure (`:696`), guards the connection `Goodbye` on `result.is_ok()`
(`:699-710`), then cancels unconditionally (`:711`). `:691` requires that at
close "Any published request lacking an observed terminal at close is
`outcome_unknown`; queued requests proven unpublished are `not_sent`", which is
per-request and is satisfied by `cancel_classification` (`:2223`). But the
*code* string is one value for the whole map (`:1672`), so a close that failed
partway reports `shutdown_timeout` or `owner_close` to callers whose real
disposition differed. This is the same shape as C8 seen from the close side
rather than the retire side.

## Documentation describing deleted mechanisms

`ed487e11` removed 351 lines from `client.rs` and added 137. The deletions are
the client's byte-stream half: `NEGOTIATION_CORRELATION`, `READ_BUFFER_BYTES`
("Matches the framing layer's `tcp_frame_channel` read buffer"),
`reader_loop<R: AsyncRead>`, `read_active_frame`, `read_exact_until`,
`read_body_until`, `drain_until`, `negotiate_tcp`, `read_setup_frame`,
`read_setup_exact`, and three tests including
`an_unsupported_version_fails_at_the_frozen_prefix` and
`idle_header_is_unbounded_then_partial_frame_has_one_deadline`.
`FIRST_APPLICATION_CORRELATION` went from 2 to 1 (`client.rs:111`) because the
negotiation request that owned correlation 1 is gone.

**Five statements describe those deleted mechanisms. One is in `client.rs`; four
are in the normative document.**

1. **`client.rs:44`** — "Deadline for a frame after its first header byte. Idle
   header waits are unbounded." The client has no first header byte. The deleted
   `read_active_frame` and `read_exact_until` were what made this true. See lead
   L1.
2. **`:738`** — "frame completion after first header byte | one 30 s absolute
   deadline; idle first-header wait is unbounded". Same mechanism, stated
   normatively for both managed clients. Neither managed client reads a byte
   stream any more.
3. **`:724`** — "malformed framing / EOF | no terminal possible | classify
   pending writes from byte evidence; invalidate generation". There is no byte
   evidence on the ring path. A ring write either completes or does not, and the
   client's classification is the three-state `publish` atomic
   (`client.rs:1939-1967`, `:2215-2231`), not a count of bytes that reached a
   socket. The classification obligation survives; the evidence it names does
   not.
4. **`:852` (V14)** — "Partial header/body EOF | Close as corruption; pending
   write outcomes use byte evidence". Same, as a conformance vector. A partial
   header or body EOF is not constructible against the ring, because `:294` says
   "A published ring descriptor names one complete header and body."
5. **`:296`** — the client-side retirement list still contains "truncated
   declared frame" alongside items that are live on the ring path (unexpected
   setup-socket EOF, invalid ring descriptor, unsupported version, unknown type,
   invalid flags, nonzero channel-0 epoch, zero epoch on a routed channel,
   pure-header body, oversize declaration). A truncated declared frame is
   unreachable on the client's inbound path for the reason `:294` gives, so this
   is a partially inherited list. Counted once.

**Checked and clear, so a synthesis pass does not double-count.** The document's
transport-selector, provider-registration, and alternate-backend statements are
all *negative* claims the deletion made true, not descriptions of surviving
machinery: `:29` ("Remote transport is unsupported"), `:594` ("There is no
provider registration socket or transport-selection handshake"), `:263-264`
(`Hello`/`HelloAck` retained as reserved-and-role-invalid numeric assignments
only). `:936` states the governing rule: "Any disagreement with old published or
private behavior is migration history, not permission to add a compatibility
branch."

**One residual of the opposite shape.** `:762-764` diagrams a client
`Recovering` state, and `client.rs` has no reconnect path — but no reconnect path
was deleted either. `git diff` of `ed487e11` shows no removed reconnect
function. So this is a contract gap, carried by sibling lead L4, not a
deleted-mechanism finding. Recovery lives in
`crates/mc-module/src/historian_producer.rs:699`.

## Conventionally-enforced-only claims

Six claims stated somewhere and checked mechanically nowhere, or checked only by
name.

1. **The three send-outcome spellings are duplicated in TypeScript as string
   literals.** `client.rs:129-131` mints `not_sent`, `outcome_unknown`,
   `terminal`; `packages/plugin/src/shared/mc-host-client/errors.ts:12` restates
   them as a `readonly string[]` and `:38` as a union type. `client.rs:126`
   calls the spellings "Stable spelling used by cross-language recovery policy",
   and TypeScript retry policy branches on them
   (`mc-host-client/client.ts:323`, `:331`). Two definitions, no cross-check.
   `outcome_spellings_are_exact` (`client.rs:3993`) pins the Rust half only, and
   it never runs in CI.
2. **The five client budgets are literals restated in the normative deadline
   table.** `client.rs:41-51` against `:737-743`. All five agree today, verified
   line by line. No test parses either side, so they agree by discipline.
3. **The `host.shutdown` and `host.status` operation names are byte literals in
   three places each.** `client.rs:584` (`br#"{"op":"host.shutdown"}"#`), `:604`
   (the echo comparison), and `:530`/`:551` in the document. Same for
   `host.status` at `:643`, `:655`. A rename on either side changes the wire and
   fails no build.
4. **`MAX_ERROR_CODE_BYTES` = 128 and `MAX_ERROR_MESSAGE_BYTES` = 512 are stated
   nowhere normative.** `client.rs:112-113`. `:337` says "Error `code` is
   stable; `message` is diagnostic unless this document states exact text", and
   V24 (`:862`) requires bounded observability, but neither fixes a number. The
   TypeScript client's own bounds are independent.
5. **`CLIENT_DISCOVERY_SLOTS` = 64 is justified against Tokio's default
   512-thread blocking pool in prose only.** `client.rs:96-104`. The reasoning is
   explicit and good — "Sized well above the connects a process makes at once ...
   while staying far below Tokio's default 512-thread blocking pool" — and
   nothing asserts either number, so a runtime configured with a smaller blocking
   pool silently invalidates the argument.
6. **The 50-microsecond bridge poll is a bare literal.** `client.rs:1886` is
   `Duration::from_micros(50)`, not a named constant, and it is numerically the
   same value as `POLL_INTERVAL` (`ring_transport.rs:33`), which the sibling 2b
   lens records as one literal already serving three different waits. This is a
   fourth use with no shared definition.

## Existing-check inventory

Every status is `unaudited`. Per METHOD an existing check never removes a
property from the catalog; adequacy belongs to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for guards.

### In-crate tests (clustered, counts, line ranges; CI status)

**40 in-crate tests, all inside one `mod tests` at `client.rs:2266-3998`,
spanning `:2328` to `:3993`. None of them runs in CI.** The reason is
structural, not an omission: every `-p mc-host` invocation in `ci.yml` carries a
`--test <name>` filter, which selects one integration binary and excludes the lib
target. Re-derived here rather than copied: `grep -n 'mc-host'
.github/workflows/ci.yml` returns `:87`, `:132`, `:133`, `:134`, `:168`, `:169`,
`:178`, `:187`, `:190`, `:211`, `:361`, `:442`, `:461`, and none is an
unfiltered or `--lib` run.

**All 40 drive a synthetic `Inner`.** The fixture is `test_inner` (`:2270`),
which constructs `Arc::new(Inner { ... })` directly (`:2280`) with a
pre-populated route set (`:2290`). A grep of the test module for
`Client::connect`, `RingClientEndpoint`, `start_ring_bridge`, or `TestHost`
returns **zero** hits. So no in-crate test exercises `connect` (`:306`),
`connect_info` (`:347`), the bridge thread (`:1852-1895`), or the real ring.

| Cluster | Tests | Sites |
| --- | --- | --- |
| Stream lifecycle, deadline watchers, queued-item charges | **9** | `:2564`, `:2810`, `:2867`, `:3304`, `:3381`, `:3426`, `:3631`, `:3717`, `:3834` |
| Cancellation versus writer and terminal races | **6** | `:2478`, `:2508`, `:2532`, `:2922`, `:2965`, `:3014` |
| Byte budgets and capacity-class separation | **5** | `:2621`, `:3155`, `:3196`, `:3225`, `:3777` |
| Redaction, spellings, typed rejection, charge release | **5** | `:2856`, `:3052`, `:3949`, `:3978`, `:3993` |
| Route lifecycle and late bind | **4** | `:3503`, `:3587`, `:3896`, `:3959` |
| Close and admission races | **3** | `:2365`, `:2414`, `:2456` |
| Inbound validation and control echo | **3** | `:2658`, `:2754`, `:3270` |
| Drop semantics | **3** | `:2898`, `:3090`, `:3121` |
| Correlation allocation and exhaustion | **2** | `:2328`, `:2338` |
| Total | **40** | |

**`#[ignore]`: none found. `should_panic`: none found.** Grepped the whole file.

### Integration tests (with CI named/unnamed status and workflow line refs)

**`crates/mc-host/tests/client.rs` holds 6 tests in 243 lines, and it is named in
CI three times.** This makes 2d unusually better covered than its siblings: 2b's
lens records that no integration binary is dedicated to that sub-part at all,
while 2d has one whose whole subject is this file.

| Workflow site | Command | Platform |
| --- | --- | --- |
| `ci.yml:132` | `cargo nextest run -p mc-host --test client`, step "Mandatory ring client suite" | Linux, job `shm-crash-recovery` (`:111`) |
| `ci.yml:178-179` | `cargo nextest run -p mc-host \` / `--test client --test lifecycle` (one wrapped command) | `if: runner.os == 'Linux'`, job `shm-source-build` (`:137`) |
| `ci.yml:187` | `cargo nextest run -p mc-host --test client --test lifecycle`, step "Fixed-ring contracts (macOS)" | `if: runner.os == 'macOS'`, same job |

**Peer role versus fixture role: 6 of 6 exercise the client as a peer; 0 use it
purely as a fixture.** Every test constructs `Client::connect(host.publication_path())`
and asserts on the client's own observable behaviour, not on host state reached
through it.

| Test | Line | What it proves about the client as a peer |
| --- | --- | --- |
| `authenticates_attaches_ring_routes_unary_and_closes` | `:31` | discovery, authentication, ring attach, `daemon_id` match, route open, unary round trip, route close, owner close (C20, C6) |
| `ring_stream_and_control_traffic_share_one_live_generation` | `:62` | Ping/Pong under a real 20 ms `LivenessPolicy` (`:64-68`) concurrent with a hanging stream and an unrelated unary (C12, C13) |
| `ring_terminal_is_typed_redacted_and_generation_remains_usable` | `:111` | host `Error` becomes a typed terminal, the sentinel body is absent from `Debug` and `Display` (`:133`), and the generation survives (C18, C2) |
| `caller_cancellation_is_correlation_scoped` | `:149` | caller cancellation yields `NotSent` or `OutcomeUnknown` and leaves later requests independent (C2) |
| `request_deadline_is_one_absolute_owner_and_honors_overrides` | `:188` | the caller-overridable request deadline, `deadline_expired` with `OutcomeUnknown` (C11) |
| `close_rejects_new_sends` | `:228` | post-close sends return `client_closed` with `NotSent` (C6) |

One test additionally makes two host-side fixture assertions:
`authenticates_attaches_ring_routes_unary_and_closes` reads the publication and
asserts `setup_socket` is present and `endpoints` is absent (`:35-36`). That is
the only host-shape assertion in the binary.

**`Client::connect` also appears in 7 other integration binaries, where the
client is the fixture rather than the subject.** Counts by `grep -c`:
`lifecycle.rs` 7 (named, `ci.yml:179`, `:187`), `shm_failure_modes.rs` 9 (named,
`:133`), `host_roundtrip.rs` 3 (unnamed), `activation.rs` 2 (unnamed),
`composite_routing.rs` 1 (unnamed), `protocol_vectors.rs` 1 (unnamed),
`shm_soak.rs` 1 (partial, `:134-135` names one `--exact` test). Plus the shared
harness `tests/support/mod.rs` and `tests/support/synapse.rs`. So 8 of the 24
integration binaries touch `client.rs` at all, and 4 of those 8 are named in CI.

### Doctests

**None found, and the absence is load-bearing.** `grep -c '```'
crates/mc-host/src/client.rs` returns **0**: there is no code fence, `text`
fence, or `compile_fail` block anywhere in the file's 3,998 lines.

This matters because `cargo test -p mc-host --doc` **does** run in CI
(`ci.yml:190`, step "Rust lease non-escape") and builds the lib target's
doctests. The sibling 2b lens established that its two `compile_fail` doctests
(`frame_channel.rs:296-301`, `:303-308`) are therefore the only checks in that
sub-part's own source that CI executes. 2d has no equivalent: **zero checks
resident in `client.rs` itself are executed by CI.** The sub-part's entire
CI-executed coverage is the 6 integration tests in `tests/client.rs`.

### TypeScript-side gates

**No TypeScript gate bears on `client.rs`, and two gates are easy to mistake for
one that does.** Recorded explicitly so a synthesis pass does not credit them.

| Gate | Command | Line | Why it does not cover this sub-part |
| --- | --- | --- | --- |
| Plugin shared-memory contracts (Bun) | `bun test packages/plugin/src/shared/mc-host-client` | `:211` | tests `McHostClient`, the *TypeScript* managed client (`:23`). It is a sibling peer implementation of the same normative contract, not this Rust file. Its `errors.ts:12`, `:38` is the duplicate of the send-outcome spellings in conventionally-enforced claim 1 |
| mc-host client interop (Bun + Node 24) | `bun run --cwd packages/plugin test:mc-host-client:node` | `:461`, job `:442-443` | resolves to `bun scripts/run-mc-host-client-node.ts smoke` (`packages/plugin/package.json:43`). Drives the TypeScript client against a real host, so it exercises the *host*, not `mc_host::Client` |
| Plugin shared-memory lifetime (Node 24) | `bun run --cwd packages/plugin test:mc-shm:node` | `:214` | native lease and channel lifetime across the runtime boundary; 2b scope |
| mc-host release contract drift gate | `bun run release:contract:check` | `:87`, `:109` | pins the four byte-coupled forms of the release contract, including "the `include!`-able Rust constants that feed production epoch values" (comment at `:105-108`). Verified not to reach here: `grep -rn 'include!' crates/mc-host/src/` returns **zero** hits, so no constant in `client.rs` is under this gate |

The consequence for claims C2 and C9 is that the two managed clients are bound by
one normative sentence each and checked by two independent, uncoupled suites.
C9 is already a live divergence: the Rust client keeps a separate control byte
pool and the document's shared-pool sentence still binds the TypeScript side, so
the two clients can have different self-teardown thresholds under identical load.

### Production assertions and guards (clustered)

**Assertion density in the production half (`1-2264`) is zero, and enforcement is
entirely by returned value and typed state.**

**`assert!` / `assert_eq!` / `assert_ne!`: none found. `debug_assert!`: none
found. `panic!`: none found. `todo!` / `unimplemented!`: none found.
`.unwrap()`: none found.** Every `unwrap` in the file is inside `mod tests`.

**`unreachable!()`: 2.** `client.rs:1440` and `:1457`, both catch-all arms of the
terminal-type match inside `dispatch`, guarded by the outer
`Response | Error | StreamEnd` arm at `:1406`. See lead L3 for the coupling
nobody states and the consequence of a reader-task panic.

**`.expect(`: 3, in two clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Semaphore invariant | 1 | `:331` `"discovery semaphore is never closed"` |
| Pending-map invariant | 2 | `:1476` and `:1526`, both `"entry exists"` |

The two `"entry exists"` labels are the load-bearing ones: each follows a
`pending.remove(&key)` on a path that already matched the entry under the same
guard. Neither has a dedicated check. `:331`'s semaphore is the
`DISCOVERY_SLOTS` static (`:106-107`), which is never closed because it is a
`LazyLock` with no drop path.

**`catch_unwind`: none found.** There is no panic boundary in this file, unlike
`ring_transport.rs`, which has two (`ring_transport.rs:279-290`, `:560-563`). A
panic in `writer_loop` or `ring_reader_loop` therefore propagates as a
`JoinError` into `join_tasks_until` (`:1687-1691`), which aborts and swallows it
(`let _ = task.await`, `:1691`), and no `retire` runs.

**`let _ =` (discarded results): 17.** Clustered by what is being discarded:

| What is discarded | Sites |
| --- | --- |
| Control-frame enqueue, including the `Pong` of C12 | `:1390`, `:1498`, `:1543` |
| Caller settlement sends (receiver may be gone) | `:1442`, `:1459`, `:1595`, `:1599`, `:1970` |
| Local cancellation calls | `:867`, `:1099`, `:1104`, `:1721` |
| Bridge-thread I/O, including the setup `Goodbye` of C5 | `:1860`, `:1872`, `:1891`, `:1893` |
| Aborted join result | `:1691` |

The four bridge-thread discards are the consequential ones: `:1891` discards the
`write_all` of the setup-socket `Goodbye`, so even the departure signal C5
describes is best-effort with no local record of whether it left.

**Checked and saturating arithmetic: 9.** `checked_add` at `:1737`
(`Correlations::allocate`, the C3 mechanism), `:1742` (`restore`'s guard),
`:1765` (`ByteCounter::charge`), and `:1997` (`deadline_at`, the typed
`invalid_timeout` rejection). `saturating_duration_since` at `:351`, `:365`,
`:522` (the C11 budget arithmetic). `saturating_sub` at `:1609`
(`release_stream`) and `:1804` (charge release).

**Typed rejection guards.** Enforcement is entirely by returned value.
`client.rs` mints **72 distinct snake_case string literals** in its production
half. Of those, the close-and-error vocabulary is: 8 retirement causes
(`connection_goodbye`, `protocol_violation`, `eof`, `write_failed`,
`control_capacity_exhausted`, `invalid_route_response`,
`stranded_route_cleanup_failed`, plus the three local lifecycle codes
`owner_drop`, `owner_close_dropped`, `shutdown_timeout`), 5 handshake failures
(`handshake_timeout`, `discovery_failed`, `dial_failed`,
`authentication_failed`, `setup_failed`), 2 post-retirement constants
(`connection_retired`, `generation_retired`), and 14 per-call local codes.
`lock_unpoisoned` (`:2242-2246`) converts every mutex poisoning into
`PoisonError::into_inner`, so a panic while holding any `Inner` mutex is
recovered rather than propagated — which is what makes the absent `catch_unwind`
consequential rather than merely unusual.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The bridge OS thread is unjoined, unobserved, and untested by anything.**
   `client.rs:1852-1895` spawns it, discards the handle, and the whole file has
   no other reference to it. It owns three things nothing else can: the ring
   attach (`:1855`), the completion signal every outbound frame waits on
   (`:1872`), and the setup-socket departure the host reads as its peer-death
   discriminator (`:1890-1893`). No in-crate test constructs it (zero hits for
   `start_ring_bridge` in `mod tests`), and no integration test observes it —
   the six `tests/client.rs` tests exercise it only transitively, and none
   inspects the setup socket or thread state. Three separate claims depend on
   it: C5's Goodbye-versus-EOF distinction, C6's joined teardown, and C13's
   liveness independence. All three are unchecked at that seam. It also
   busy-polls at 50 microseconds (`:1886`) for the life of every connection,
   which nothing measures.

2. **The retirement cause is discarded at exactly the point where it is the only
   diagnostic.** `retire` (`:1667`) receives one of eight distinct causes and
   keeps none (C8). The eight causes are not interchangeable: `eof` (`:1987`)
   and `connection_goodbye` (`:1397`) differ by whether the host exited cleanly,
   and `write_failed` (`:1954`, `:1963`) versus `protocol_violation` (`:1979`)
   differ by which side broke the contract. `Inner` (`:934-960`) has room for a
   field and does not have one. Two tests assert the two *constants* (`:2408`,
   `:2556`) and thereby pin the loss in place rather than exposing it. The
   observation window is `settle_all`'s loop (`:1654-1664`): a caller pending at
   that instant learns the cause, one arriving an instruction later cannot.

3. **The route map is the one unbounded collection, and the bound it lacks is
   the one the document names.** `routes.insert` (`:507`) is the only insertion
   into an `Inner` collection with no capacity test, while `pending` (`:1169`)
   and `streams` (`:1058`) both have one and `:658` lists routes alongside both.
   Compounding it, `routes` is a `HashSet<RouteHandle>` (`:944`), so a duplicate
   host bind silently merges two callers onto one entry — and
   `release_stranded_route`'s already-cached early return (`:1576-1578`), which
   is correct for the §8.2 case, means a genuine duplicate is never released
   either. Nothing tests either the growth or the merge; the two route tests
   that exist (`:3503`, `:3587`) cover the late-bind path instead, and neither
   runs in CI.

4. **`host_shutdown` is the highest-consequence public method and has no test at
   any level.** `client.rs:576-614` is the stop linearization point by its own
   doc comment (`:575`), and no in-crate test and none of the six CI-executed
   integration tests calls it. The integration suite stops the host through
   `host.shutdown_gracefully()`, a harness path. So the JSON-echo validation
   (`:598-613`), the `invalid_shutdown_response` branch (`:607-613`), and the
   5-second-budget choice of lead L2 are all unexercised.

5. **`connect`'s partial-failure ladder has eight exits and no coverage of
   seven.** `:306-344` and `:347-384` produce `handshake_timeout` at five
   distinct sites (`:330`, `:340`, `:349`, `:354`, `:361`), `discovery_failed`
   at two (`:341`, `:342`), `dial_failed` (`:350`),
   `authentication_failed` (`:363`), and `setup_failed` at three (`:369`,
   `:372`, `:375`). The post-setup retirement recheck at `:425-430` — whose
   comment at `:418-424` explicitly notes "the historian does not reconnect on
   that path, so a daemon reload race would abort the run instead of
   establishing a replacement" — is the most consequential of them. Only the
   success path is tested, by `authenticates_attaches_ring_routes_unary_and_closes`
   (`tests/client.rs:31`). The in-crate suite cannot reach any of them, because
   it never calls `connect`.

6. **The `CLIENT_DISCOVERY_SLOTS` cap has a long written justification and no
   check.** `:96-107` argues the 64-permit design carefully, including the
   subtle part — the permit is moved into the blocking closure (`:335`) so a
   detached worker still counts against the cap. Nothing tests that a detached
   worker holds its permit, and nothing tests the exhaustion path, which by
   design surfaces as `handshake_timeout` (`:330`) rather than a distinct code
   and is therefore indistinguishable from a slow mount in production.

7. **`Push` arrives, is validated, and vanishes without a counter.** `:2050`
   accepts it structurally and `:1405` is `FrameType::Push => {}`. `:256` says
   the host "does not emit it in this profile", so the arm is compliant, but if
   a future host began emitting `Push` the client would discard every frame with
   no local trace at all. Nothing drives the `dispatch` arm.

8. **The two `unreachable!()` sites are the only production panic sites in the
   file and the file has no panic boundary.** `:1440`, `:1457`, with no
   `catch_unwind` anywhere in `1-2264` and `lock_unpoisoned` (`:2242`)
   recovering every poisoning rather than propagating. A panic in the reader
   task is the one inbound fault that does not retire the generation, so
   `join_tasks_until` swallows it at `:1691` and every pending caller waits out
   its own deadline. See lead L3.

## Open questions

- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs all 40 in-crate checks above, which is 40 of the sub-part's 46
  claim-bearing tests. The 2b inventory records the same question as unresolved
  (`../../part-2b-ring-datapath/_lenses/lens-b-claims-and-checks.md:756-760`),
  as does the 4e inventory across five sub-parts. A synthesis pass must not
  decide it silently. (needs human input)
- Is `host_shutdown`'s use of `CLIENT_SHUTDOWN_TIMEOUT` as a *request* deadline
  (`client.rs:585`) deliberate? Lead L2. `:731` separates the request and
  shutdown deadline domains, and no comment at `:585` explains the choice.
  (needs human input)
- Should the setup-socket departure distinguish a transport failure from a clean
  exit (C5), and should `close` prove the bridge thread exited (C6)? These are
  inverses and one design decision resolves both, as sibling lens A's open
  question 7 already states. Carried forward unresolved. (needs human input)
- Is the deviation in C3 deliberate? The comment block at `client.rs:418-424`
  shows the author reasoning explicitly about which side owns recovery and
  arguing for surfacing failure eagerly, which is the reverse of what the
  exhaustion path does. Nothing in the file mentions exhaustion. Carried forward
  from sibling lead L2. (needs human input)
- Does the document's `Recovering` state (`:762-764`) describe the client
  library's obligation or the consumer's? Recovery lives in
  `crates/mc-module/src/historian_producer.rs:699`, outside 2d. Carried forward
  from sibling lead L4. (unresolved, needs a mc-module pass)
- Should the deleted-mechanism findings be documentation corrections or property
  records? Items 3 and 4 of that section (`:724`, `:852`) name "byte evidence"
  as the classification input, and the surviving mechanism — the three-state
  `publish` atomic (`client.rs:2215-2231`) — is stronger than byte evidence, not
  weaker. A correction that simply deletes the phrase would lose the fact that
  the obligation is now discharged by a different and better mechanism.
  (needs human input)
- Are `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`)
  required status checks for merge? This decides whether `--test client`'s three
  named invocations are gates or advisory, which is the difference between 2d
  being well covered and merely well tested. Unverifiable from workflow content;
  it is repository settings. Carried forward from
  `../../part-2-rescope/scope-map-and-risk-ranking.md:750-752`.
- Can a panic in `writer_loop` or `ring_reader_loop` leave the generation live
  and every pending caller waiting? Lead L3 argues yes from the absence of a
  `catch_unwind` and the `let _ = task.await` at `:1691`, but proving it needs a
  panic seam that does not exist. (unresolved, needs an injectable panic point)
