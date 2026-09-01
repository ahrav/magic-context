# Lens B: the frame channel abstraction and the egress path

Scope: `crates/mc-host/src/frame_channel.rs`,
`crates/mc-host/src/frame_channel/contract_tests.rs`,
`crates/mc-host/src/tcp_frame_channel.rs`, with `crates/mc-host/src/wire.rs`
and `crates/mc-host/src/shm_provider.rs` as boundary context. The second
channel implementation lives in `shm_provider.rs`, so this lens reads its
egress functions even though the file sits outside the nominal scope list.

Part 2a already owns the writer task's abort chain, the discard-versus-retired
token split, completion-hook panics, permit release under abort, and the
read-exit close disposition. Those are not repeated here. Where a record
touches the same machinery from the channel side, the relationship is stated.

## Observations

- O1: The send side is a concrete `struct FrameSender` (cloneable) plus a
  transport-owned `SenderQueue`, both produced by one factory
  `frame_sender(queue_frames, generation, admission_timeout)`. There is no
  send-side trait, so an implementation cannot substitute admission,
  queueing, or ticket semantics; it can only substitute the loop that drains
  `SenderQueue` [frame_channel.rs:758-882].
- O2: The receive side *is* a trait, `pub(crate) trait FrameReceiver` with a
  single `recv()` returning `Result<InboundEvent, ReadClose>`, plus a
  `DynFrameReceiver`/`BoxedReceiver` erasure pair [frame_channel.rs:574-604].
- O3: The queue is a `tokio::sync::mpsc::channel::<QueuedOutboundFrame>` of
  exactly `queue_frames` slots [frame_channel.rs:862]. `writer_queue_frames`
  defaults to 64 and `HostLimits::validate` rejects zero
  [config.rs:141, config.rs:154-160].
- O4: Two implementations drain that queue. TCP: `write_frames`
  [tcp_frame_channel.rs:313-404], reached for every accepted connection at
  [connection.rs:178]. Shared memory: `run_endpoint` plus `publish_one`
  [shm_provider.rs:460-544, shm_provider.rs:621-663], reached only through
  `TransportProviders::with_injected` [transport_provider.rs:180], whose only
  in-tree callers are under `crates/mc-host/tests/`.
- O5: Exactly one `ChannelFactory` implementation exists,
  `TcpChannelFactory` [tcp_frame_channel.rs:429], and the shared contract
  suite is instantiated exactly once, for TCP
  [contract_tests.rs:456-458]. The shared-memory implementation runs none of
  the nine contract scenarios.
- O6: TCP passes one configuration value into three roles. `frame_deadline`
  becomes the sender's `admission_timeout` [tcp_frame_channel.rs:80], the
  reader's absolute per-frame deadline [tcp_frame_channel.rs:169], and the
  writer's `write_deadline` [tcp_frame_channel.rs:90]. The shared-memory
  provider does the same with `ctx.frame_deadline` [shm_provider.rs:307].
- O7: The frame state machine is a 4-valued `AtomicU8`: `QUEUED`,
  `CANCELLED`, `PUBLISHED`, `COMPLETE` [frame_channel.rs:706-709].
  `FrameSendTicket::cancel` collapses it to 2 values by testing only
  `QUEUED` [frame_channel.rs:747-755], so `PossibleSend` covers `CANCELLED`,
  `PUBLISHED`, and `COMPLETE` alike.
- O8: `begin_publication` is the irreversible boundary: one CAS
  `QUEUED -> PUBLISHED`, then `on_publish` once [frame_channel.rs:718-730].
  Both implementations call it and skip the frame when it returns false
  [tcp_frame_channel.rs:336-338, shm_provider.rs:627-629].
- O9: TCP writes `bytes` then `tail` as two `write_all` calls inside one
  `tokio::time::timeout(write_deadline, ...)`, raced against
  `discard.cancelled()` [tcp_frame_channel.rs:366-378]. Any non-`Ok(Ok(()))`
  result, or a discard win, cancels `retired` and `generation` and breaks the
  loop [tcp_frame_channel.rs:379-388].
- O10: TCP takes the completion instant inside the timeout arm, immediately
  when `write_all` returns, and the code comments say why: a preemption
  between the write and the result check must not push `completed_at` past a
  peer answer the bytes themselves caused
  [tcp_frame_channel.rs:362-365, tcp_frame_channel.rs:376]. The shared-memory
  implementation instead calls `Instant::now()` after publication, after
  `decode_header` and after the `publish_hook` callback
  [shm_provider.rs:652-659].
- O11: A `DirectFrame` on TCP is always flattened by `into_owned()` into a
  fresh `Vec` before any byte is written [tcp_frame_channel.rs:347-354,
  frame_channel.rs:640-649]. The shared-memory path instead serializes
  straight into a ring reservation [shm_provider.rs:665-678].
- O12: When a frame carries both `direct` and `bytes`, TCP silently discards
  `bytes` and clears `tail` [tcp_frame_channel.rs:351-354]; shared memory
  silently ignores `bytes`/`tail` and publishes the direct frame
  [shm_provider.rs:645-648]. `OutboundFrame` documents no precedence rule
  [frame_channel.rs:696-704].
- O13: `CopyCounter` is threaded only through the receive path
  (`ReceiveLease::to_owned` is its sole `record_copy` caller inside the
  module) [frame_channel.rs:90-92, frame_channel.rs:370-378]. `DirectFrame`
  holds no counter, so the TCP egress flatten at
  [frame_channel.rs:640-649] copies a body into owned storage and records
  nothing, while the doc says "TCP and compatibility adapters add exactly one
  for each body they copy into owned semantic storage"
  [frame_channel.rs:78-81].
- O14: `frame_channel::ProducerReservation` and `ProducedBody`
  [frame_channel.rs:110-288] have no non-test callers. The shared-memory
  provider uses a *different* type of the same name,
  `mc_shm_transport::backend::ring::ProducerReservation`
  [shm_provider.rs:20, shm_provider.rs:693]. The module doc nonetheless
  presents the cursor-and-exact-commit producer as part of the channel
  contract [frame_channel.rs:8-9].
- O15: `validate_inbound_header` is genuinely shared: both implementations
  call it on the header alone before any body admission
  [frame_channel.rs:58-76, tcp_frame_channel.rs:196, shm_provider.rs:564].
  It does not check `len == 0` for pure-header types, but `decode_header`
  already rejects that upstream [wire.rs:340-342], and both implementations
  decode before validating.
- O16: The oversize-control rejection is duplicated, not shared: the same
  predicate `ty == Request && channel == 0 && len > MAX_CONTROL_BODY_LEN`
  appears in both implementations [tcp_frame_channel.rs:198,
  shm_provider.rs:565].
- O17: TCP defers the body drain to the *next* `recv()` under the rejected
  frame's own absolute deadline, which started at that frame's first header
  byte [tcp_frame_channel.rs:44-45, tcp_frame_channel.rs:97-112,
  tcp_frame_channel.rs:201]. Shared memory has no drain at all: it releases
  the ring lease and reports the rejection [shm_provider.rs:566-575].
  `ReadClose::RejectedDrainFailed` therefore has exactly one producer
  [tcp_frame_channel.rs:110] and cannot arise on the shared-memory path.
- O18: The reader emits the authoritative rejection off-task
  (`spawn_tracked`) and returns to `recv()` without awaiting it, so the drain
  is not serialized behind the terminal's own admission [connection.rs:436-463].
  A `written` oneshot carries the terminal's flush signal so a later drain
  failure can fence it [connection.rs:395, connection.rs:449-450,
  connection.rs:1263-1268].
- O19: The `written` hook is load-bearing for lifecycle state, not only
  telemetry: [lifecycle.rs:1934] uses it to call `commit.acknowledge()`, and
  [connection.rs:1263-1268] uses it to signal the rejected-frame terminal
  flush.
- O20: Shared-memory egress is coupled to ingress arrivals. After any
  received frame the loop takes at most one queued outbound frame, and only
  with `try_recv` [shm_provider.rs:507-513]. During the ingress-budget wait
  it publishes at most one frame per 50 microsecond poll and otherwise calls
  the blocking `std::thread::sleep` [shm_provider.rs:592-602,
  shm_provider.rs:55]. The blocking sleep is contained because the endpoint
  owns a dedicated thread and a `new_current_thread` runtime
  [shm_provider.rs:319-324].
- O21: TCP cancels `retired` on every exit path, including the fallthrough
  after the loop [tcp_frame_channel.rs:402], then shuts down the write half
  [tcp_frame_channel.rs:403]. `run_endpoint` cancels `retired` on only two of
  its six exits [shm_provider.rs:500, shm_provider.rs:539]; the exits at
  [shm_provider.rs:517], [shm_provider.rs:522], [shm_provider.rs:527], and
  [shm_provider.rs:530] return without it.
- O22: Once `finish` is cancelled, TCP's `biased` select can never poll
  `queue.recv()` again, so every later iteration uses `try_recv` and breaks on
  an empty queue [tcp_frame_channel.rs:319-333]. Shared memory latches the
  same behaviour through a `finishing` flag [shm_provider.rs:514-518].
- O23: Admission-deadline expiry is generation-fatal, not local backpressure:
  the timeout arm cancels both `retired` and `generation`
  [frame_channel.rs:819-823], which the test at
  [tcp_frame_channel.rs:1100-1127] asserts.
- O24: Neither implementation validates the caller-supplied header's `len`
  against the bytes it emits. TCP writes `bytes` and `tail` verbatim
  [tcp_frame_channel.rs:369-374]. Shared memory recomputes `body_len` from
  the actual slices and passes the caller's header through unchanged
  [shm_provider.rs:681-689], so a mismatch is committed rather than rejected.
  `DirectFrame::new` takes `header` and `body_len` as independent arguments
  [frame_channel.rs:616-626].

## Channel contract map

- C1: **Outbound admission** (`FrameSender::send_ticket_before`) — concrete,
  shared by both implementations; not substitutable. Bounded FIFO mpsc,
  deadline-bounded, and generation-fatal on expiry
  [frame_channel.rs:800-826].
- C2: **Publication boundary** (`begin_publication`) — shared; both
  implementations honour the CAS and the once-only `on_publish`
  [frame_channel.rs:718-730, tcp_frame_channel.rs:336, shm_provider.rs:627].
- C3: **Frame ordering** — TCP: sequential `write_all` on one task, with a
  hard break on any interruption [tcp_frame_channel.rs:366-388]. Shared
  memory: one ring reservation committed as a unit, so no partial frame is
  ever observable [shm_provider.rs:680-691]. Both preserve order; only TCP can
  leave a truncated frame on the medium.
- C4: **Completion notification** (`written`) — TCP: instant captured at
  `write_all` return, before the result check
  [tcp_frame_channel.rs:366-377, tcp_frame_channel.rs:393-395]. Shared
  memory: instant captured after commit, after header decode, and after the
  `publish_hook` [shm_provider.rs:652-659]. Divergent precision under the
  same declared contract [frame_channel.rs:702].
- C5: **Direct (borrowed) frame publication** — TCP: flattened to an owned
  `Vec` first, so no zero-copy benefit and no counted copy
  [tcp_frame_channel.rs:347-354]. Shared memory: written into the reservation,
  genuinely zero-copy [shm_provider.rs:665-678].
- C6: **Exact-length enforcement for direct bodies** — TCP: `ExactWriter`
  rejects overfill and underfill [frame_channel.rs:652-693]. Shared memory:
  `reservation.commit(body_len)` plus `ReservationWriter`
  [shm_provider.rs:676, shm_provider.rs:695-708]. Both enforce
  serializer-versus-`body_len`; neither enforces `body_len` against
  `header.len`.
- C7: **Writer-exit signal** (`retired`) — TCP: unconditional
  [tcp_frame_channel.rs:402]. Shared memory: four of six exits omit it
  [shm_provider.rs:517, 522, 527, 530]. Consumers treat `is_retired()` as a
  gate [dispatch.rs:195, dispatch.rs:266, dispatch.rs:311, dispatch.rs:690,
  connection.rs:1284].
- C8: **Graceful finish** — both: drain what `try_recv` can see, then exit
  [tcp_frame_channel.rs:325-328, shm_provider.rs:514-518]. Neither waits for
  in-flight admissions.
- C9: **Inbound structural validation** — shared through
  `validate_inbound_header` [frame_channel.rs:58-76].
- C10: **Oversize-control handling** — duplicated predicate, divergent
  realignment: TCP drains under the frame's residual deadline and can fail
  with `RejectedDrainFailed`; shared memory releases the lease and cannot
  [tcp_frame_channel.rs:198-201, shm_provider.rs:565-576].
- C11: **Egress progress independence** — TCP: a queued frame is published as
  soon as the writer task is scheduled. Shared memory: bounded by inbound
  arrival rate and a 50 microsecond poll [shm_provider.rs:507-513,
  shm_provider.rs:520-533].
- C12: **Copy accounting** — receive side only; egress copies are invisible
  [frame_channel.rs:78-92, frame_channel.rs:370-378].

## Candidate properties

### header-len-equals-emitted-body-on-every-published-frame

Type: safety
Reachability: default-production — the TCP writer at
[tcp_frame_channel.rs:369-374] publishes `bytes` and `tail` verbatim for every
connection started at [connection.rs:178].
Status: active
Exercised: not yet — no test constructs an `OutboundFrame` whose header `len`
disagrees with `bytes.len() + tail.len() - HEADER_LEN`, nor a `DirectFrame`
whose `header.len` disagrees with its `body_len` argument.
Guarantee: every byte sequence the channel publishes is a frame whose header
`len` field equals the number of body bytes that follow it on the medium.
Check: `always` — evaluate at the publication boundary on every frame, because
a single mismatch permanently desynchronizes the peer's framing and every
later frame on that connection is misparsed.
Fault/timing angle: none. This is a pure encoding-agreement property with no
timing window; it fires on the first mismatched frame.
Required faults and enabling state: no fault. An `OutboundFrame` constructed
with a header whose `len` differs from the emitted body length, or a
`DirectFrame::new(header, body_len, _)` where `header.len != body_len`
[frame_channel.rs:616-626].
Confidence: high — [evidence](evidence/header-len-equals-emitted-body-on-every-published-frame.md).
I read both publication paths and found no comparison of `header.len` against
emitted length. TCP writes the caller's bytes unexamined
[tcp_frame_channel.rs:369-374]. Shared memory derives `body_len` from the
slices and forwards the header untouched [shm_provider.rs:681-689], so it
commits the mismatch instead of rejecting it. `ExactWriter`
[frame_channel.rs:652-693] constrains the serializer against `body_len` only,
never against `header.len`.
Existing check: none for the invariant itself. `wire.rs` encoders derive
`len` from the body they are handed [wire.rs:542-620], which is why no current
caller trips it; that is a caller property, not a channel check.
Impact: stream-alignment corruption at the peer, which the protocol names as
the precise failure the single-writer rule exists to prevent
[docs/mc-host-wire-protocol.md:295]. The peer reads body bytes as a header and
closes the generation without an `Error`, so the host sees an unexplained
close.
Open questions:
- Should the check live in the channel (reject at admission) or stay a caller
  obligation with a debug assertion? (needs human input)

### frame-bytes-never-interleave-on-any-writer-exit-path

Type: safety
Reachability: default-production — `write_frames` is the writer for every
accepted TCP connection [connection.rs:178, tcp_frame_channel.rs:90].
Status: active
Exercised: partial — `partial_writes_finish_one_frame_before_the_next`
[tcp_frame_channel.rs:1002-1028] proves the byte-at-a-time interleaving case
with two clean frames. No test interrupts a partial write with `discard` or
the write deadline and then observes what reaches the medium.
Guarantee: for any two frames published on one connection, every byte of the
earlier frame reaches the transport before any byte of the later one; an
interrupted frame is followed by no further frame bytes at all.
Check: `always` — must hold on every published pair, since one interleaving
is unrecoverable for the peer.
Fault/timing angle: the window is inside
`tokio::time::timeout(write_deadline, ...)` at
[tcp_frame_channel.rs:366-378], between the two `write_all` calls for `bytes`
and `tail`, and at any partial-write suspension point inside either. A
`discard` win or a deadline expiry drops that future mid-write.
Required faults and enabling state: a peer that stops reading so the socket
blocks mid-frame, plus either `discard()` [frame_channel.rs:774-776] or a
`write_deadline` expiry; then a second frame already queued behind it.
Confidence: high — [evidence](evidence/frame-bytes-never-interleave-on-any-writer-exit-path.md).
The guarantee rests on three independent structural facts, all verified: one
task owns the socket (`write_frames` takes `stream` by value,
[tcp_frame_channel.rs:313-315]); the two `write_all` calls are sequential
within one task; and every abnormal outcome `break`s the loop rather than
continuing, at [tcp_frame_channel.rs:379-388]. Ordering is preserved by
*termination*, not by resumption. That is why the protocol's stronger clause
matters (below).
Existing check: `partial_writes_finish_one_frame_before_the_next`
[tcp_frame_channel.rs:1002-1028], `writer_serializes_frames_and_flushes_queue_on_close`
[tcp_frame_channel.rs:1031-1059], and the shared
`contract_concurrent_send_receive_preserves_fifo_admission` scenario
[contract_tests.rs:117-152]. Status: unaudited.
Impact: if it ever fails, the peer misparses body bytes as a header
[docs/mc-host-wire-protocol.md:295]. Note the derived exposure: on the abandon
path the medium carries a *truncated* frame, and the peer's correct reading of
that is "EOF inside frame", a `Corrupt` close
[docs/mc-host-wire-protocol.md:293].
Open questions:
- [docs/mc-host-wire-protocol.md:295] says "after a partial write, the writer
  MUST continue that same frame's remaining bytes before emitting any other
  frame". The code abandons instead of continuing. Abandoning emits no other
  frame, so the literal clause holds; is abandonment the intended reading?
  (needs human input)

### an-admitted-frame-is-published-or-its-loss-is-observable

Type: safety
Reachability: default-production — the `finish` path is
[tcp_frame_channel.rs:325-328], reached whenever `FrameSender::finish()`
[frame_channel.rs:770-772] runs during shutdown.
Status: active
Exercised: partial — `graceful_finish_drains_admitted_frames_before_close`
[contract_tests.rs:298-320] admits all frames *before* calling `finish()`, so
it never exercises an admission concurrent with the finish latch.
Guarantee: a frame for which `send`/`send_ticket_before` returned `Ok` is
either published to the transport or its non-publication is observable to the
caller.
Check: `always` — per admitted frame. Counting attempted versus published
aggregates can cancel, so the oracle is per-frame identity: for each admitted
correlation, exactly one of {peer observed it, caller observed a
non-publication signal}.
Fault/timing angle: the race is between a producer completing `tx.send` and
the writer's `try_recv` returning `Empty`. Once `finish` is cancelled the
`biased` select never polls `queue.recv()` again
[tcp_frame_channel.rs:319-333], so a frame admitted microseconds after an
empty `try_recv` is dropped with the queue receiver.
Required faults and enabling state: a handler still emitting when
`FrameSender::finish()` is called, with the queue momentarily empty.
Confidence: high — [evidence](evidence/an-admitted-frame-is-published-or-its-loss-is-observable.md).
`Ok` from `send_ticket_before` means only "accepted into the mpsc"
[frame_channel.rs:815-818]. Three paths then drop an admitted frame without
publishing: the finish/`try_recv`-empty break [tcp_frame_channel.rs:325-328],
the discard break [tcp_frame_channel.rs:322], and any write failure or
deadline expiry, which breaks and drops the remaining queue
[tcp_frame_channel.rs:379-388, tcp_frame_channel.rs:400-401]. On the discard
and write-failure paths the loss *is* observable, because `retired` is
cancelled [tcp_frame_channel.rs:402]. On the finish path `retired` is also
cancelled at 402, so a caller polling `is_retired()` can learn; a caller
holding only a `FrameSendTicket` cannot, because `cancel()` on a dropped
frame still reports `NotSent` correctly only if the state is still `QUEUED`.
Existing check: `graceful_finish_drains_admitted_frames_before_close`
[contract_tests.rs:298-320]. Status: unaudited; it does not cover the race.
Impact: a terminal `Response`, `Error`, or `Goodbye` silently never reaches
the peer. Because `written` is also dropped, any state machine keyed to the
hook stalls; see the hook record and Part 2a's
`shutdown-commits-exactly-once-on-write-ack`.
Open questions:
- Is dropping a post-`finish` admission intended, given the code comment
  "exit without waiting for senders an inert handler may still hold"
  [tcp_frame_channel.rs:323-324]? If so, should `send` fail fast once `finish`
  is latched instead of returning `Ok`? (needs human input)

### completion-hook-runs-at-most-once-and-only-after-a-complete-write

Type: safety
Reachability: default-production — hooks are supplied on production paths at
[connection.rs:1263-1268] and [lifecycle.rs:1934], and run at
[tcp_frame_channel.rs:393-395].
Status: active
Exercised: partial — `completion_hooks_fire_once_in_order_without_claiming_receipt`
[contract_tests.rs:205-247] proves once-each and admission order on the success
path only. No test asserts the hook does *not* run after a failed or
deadline-expired write.
Guarantee: a frame's `written` hook runs at most once, and never unless every
byte of that frame reached local egress.
Check: `always-or-unreached` — the hook is optional (`Option<Box<...>>`,
[frame_channel.rs:703]) and most frames supply none, so the property must be
safe when the path is skipped rather than required to execute.
Fault/timing angle: the gap between `completion.store(COMPLETE, Release)`
[tcp_frame_channel.rs:389-392] and `written(completed_at)`
[tcp_frame_channel.rs:393-395] is not atomic, so an observer of `COMPLETE`
can act before the hook has run.
Required faults and enabling state: for the "never after failure" half, a
stalled peer plus `write_deadline` expiry, or `discard()` mid-write, with a
hook attached.
Confidence: high — [evidence](evidence/completion-hook-runs-at-most-once-and-only-after-a-complete-write.md).
At-most-once is structural: the hook is moved out of the frame by
destructuring [tcp_frame_channel.rs:340-346] and each frame is dequeued from
the mpsc exactly once. Not-after-failure is also structural: `written` is
reached only past the `!matches!(result, Ok(Ok(())))` break
[tcp_frame_channel.rs:384-388]. The consequence is that the hook is
at-most-once, *not* exactly-once: on every break path it is dropped unrun.
Existing check: `completion_hooks_fire_once_in_order_without_claiming_receipt`
[contract_tests.rs:205-247]. Status: unaudited. It also documents the correct
weaker claim in its own name and doc comment
[contract_tests.rs:202-204]: completion is local egress, not peer receipt.
Impact: the hook is load-bearing. [lifecycle.rs:1934] acknowledges the
shutdown commit from it and [connection.rs:1263-1268] signals the
rejected-frame terminal flush from it, so a dropped hook stalls those state
machines rather than merely losing telemetry.
Open questions:
- The two implementations disagree on the instant's precision: TCP
  deliberately samples inside the write arm [tcp_frame_channel.rs:362-377]
  while shared memory samples after the publish hook
  [shm_provider.rs:652-659]. Is the sampling point part of the contract?
  (needs human input)

### cancel-never-reports-possible-send-for-a-proven-unwritten-frame

Type: safety
Reachability: default-production — `FrameSendTicket` is `Clone`
[frame_channel.rs:741-744] and `cancel()` is public
[frame_channel.rs:747-755].
Status: active
Exercised: yes — but as codified current behaviour, not as the property.
`cancellation_classifies_before_and_after_publication_without_double_release`
asserts `NotSent` then, on a second call for the same never-published frame,
`PossibleSend` [contract_tests.rs:577, contract_tests.rs:582].
Guarantee: `SendOutcome::PossibleSend` is returned only when at least one byte
of the frame may have reached the transport.
Check: `always` — evaluate on every `cancel()` return, because the outcome
directly drives whether a caller may retry.
Fault/timing angle: none required. Two clones of one ticket, or one clone
called twice, is sufficient.
Required faults and enabling state: no fault. Call `cancel()` twice on a
ticket for a frame that was cancelled before publication.
Confidence: high — [evidence](evidence/cancel-never-reports-possible-send-for-a-proven-unwritten-frame.md).
`cancel()` succeeds only on the CAS `QUEUED -> CANCELLED`
[frame_channel.rs:749-754]; every other state, including `CANCELLED`, falls
to `PossibleSend`. The state atomic distinguishes four values
[frame_channel.rs:706-709] but `cancel()` reads none of them, so it cannot
tell "already cancelled, definitely unwritten" from "published". I verified
the existing test encodes exactly this at [contract_tests.rs:577-582].
Existing check: [contract_tests.rs:565-604]. Status: unaudited. It asserts
the current behaviour, so it would not fail if the behaviour is wrong.
Impact: [docs/mc-host-wire-protocol.md:785] requires "queued requests proven
unwritten are `not_sent`", and [docs/mc-host-wire-protocol.md:56] defines
`not_sent` as "sender proves zero bytes ... reached the socket". Misreporting
a proven-unwritten frame as `PossibleSend` forces `outcome_unknown`
[docs/mc-host-wire-protocol.md:57], which by
[docs/mc-host-wire-protocol.md:797] forbids replay. The failure direction is
safe (lost retries, never duplicated effects), but it silently degrades
availability for the exact case the protocol carves out as retryable.
Open questions:
- Should `cancel()` be idempotent (re-report `NotSent` when the state is
  already `CANCELLED`), and should it expose `COMPLETE` distinctly from
  `PUBLISHED`? (needs human input)

### queued-egress-charges-are-bounded-by-depth-times-write-deadline

Type: liveness
Reachability: default-production — `write_deadline` is `frame_deadline`
[tcp_frame_channel.rs:90] and the queue holds `writer_queue_frames` frames,
64 by default [config.rs:141].
Status: active
Exercised: partial — `stalled_consumer_write_retires_generation_and_frees_charges`
[tcp_frame_channel.rs:1061-1097] proves the single-frame case: one stalled
write hits the deadline, the generation retires, and the charge is freed. No
test measures the hold time with a full queue.
Guarantee: after the last frame is admitted, every egress byte charge held by
one connection's writer is released within `writer_queue_frames *
write_deadline` plus the in-flight frame's remainder.
Check: `always` — the bound must hold for every connection. State the bound in
the unit the code bounds: the per-frame `write_deadline`
[tcp_frame_channel.rs:369] multiplied by the queue depth
[frame_channel.rs:862], because the deadline is armed per frame, not per
queue.
Fault/timing angle: a peer that reads just fast enough that each frame
completes shortly before its own deadline. Every frame then resets the clock,
so the queue's aggregate hold is depth times deadline rather than one
deadline.
Required faults and enabling state: a full writer queue whose frames carry
egress charges, plus a peer draining slowly rather than stalling outright. A
fully stalled peer is the *easy* case: the head frame times out and the whole
queue drops.
Confidence: high — [evidence](evidence/queued-egress-charges-are-bounded-by-depth-times-write-deadline.md).
The deadline wraps one frame's writes [tcp_frame_channel.rs:369-374] and is
re-armed each loop iteration. Charges are dropped per frame on success
[tcp_frame_channel.rs:398] and en masse when the queue receiver drops
[tcp_frame_channel.rs:400-401].
Existing check: [tcp_frame_channel.rs:1061-1097]. Status: unaudited; single
frame only.
Impact: [tcp_frame_channel.rs:307-312] claims "The deadline bounds how long
one consumer can hold shared egress-budget charges: a peer that stops reading
would otherwise pin its queued frames' charges forever and stall every other
generation's emissions." The plural "its queued frames' charges" overstates
what a per-frame deadline delivers by a factor of the queue depth. With the
defaults that is 64x. Since the egress budget is shared across generations
[connection.rs:1242-1247], the real cross-generation stall bound is 64
deadlines, not one.
Open questions:
- Is a whole-queue deadline (or a queue-drain deadline armed once at the first
  stall) the intended semantics, or is depth-times-deadline acceptable given
  the budget size? (needs human input)

### admission-deadline-expiry-retires-the-whole-generation

Type: safety
Reachability: default-production — the timeout arm is
[frame_channel.rs:819-823], reached whenever the queue stays full past the
caller's deadline.
Status: active
Exercised: yes — `queue_admission_uses_the_remaining_operation_deadline`
[tcp_frame_channel.rs:1100-1127] asserts the deadline is honoured exactly and
that `generation.is_cancelled()` follows.
Guarantee: a full writer queue at the caller's deadline retires the entire
generation; it is never reported as recoverable local backpressure.
Check: `always` — on every admission timeout, because the alternative
(returning a retryable error while leaving the generation live) would let a
caller loop on a wedged writer.
Fault/timing angle: the window is the whole `timeout_at(deadline,
tx.send(queued))` [frame_channel.rs:815]. The `biased` select checks
`retired.cancelled()` first [frame_channel.rs:813-814], so an
already-retired generation returns `WriterGone` without a second
cancellation.
Required faults and enabling state: `writer_queue_frames` frames already
queued and the head write not completing, plus one more admission attempt.
Confidence: high — [evidence](evidence/admission-deadline-expiry-retires-the-whole-generation.md).
Verified the timeout arm cancels `retired` then `generation`
[frame_channel.rs:820-821] and returns `WriterGone`. Also verified the
coupling that makes this reachable: `admission_timeout` is the same
`frame_deadline` value as the write deadline [tcp_frame_channel.rs:80,
tcp_frame_channel.rs:90], so an admission can only time out if the head frame
is itself within one deadline of failing.
Existing check: [tcp_frame_channel.rs:1100-1127]. Status: unaudited.
Impact: correct and deliberate, but it makes queue depth a correctness
parameter rather than a throughput parameter: a burst that exceeds
`writer_queue_frames` while the peer is slow kills the connection. The frame
dropped on this path also loses its `on_publish` and `written` hooks
[frame_channel.rs:806-811], since `queued` is dropped when the `tx.send`
future is dropped.
Open questions: None.

### every-writer-exit-cancels-the-retired-token

Type: safety
Reachability: default-production for the TCP writer
[tcp_frame_channel.rs:402]; test-only for the shared-memory writer, whose
only reachable entry is `TransportProviders::with_injected`
[transport_provider.rs:180] with in-tree callers confined to
`crates/mc-host/tests/`. `InjectedProvider` is a `pub trait`
[transport_provider.rs:112], so an external embedder could reach it.
Status: active
Exercised: partial — three contract scenarios assert `is_retired()` after an
exit [contract_tests.rs:257, contract_tests.rs:284, contract_tests.rs:341],
but only against the TCP factory [contract_tests.rs:456-458].
Guarantee: when a channel's writer loop returns, `retired` is cancelled, so
`FrameSender::is_retired()` reports the writer's absence.
Check: `always` — on every writer-loop exit, because callers use
`is_retired()` as a pre-emission gate.
Fault/timing angle: none for TCP. For shared memory the window is any of the
four exits that skip the cancellation [shm_provider.rs:517, 522, 527, 530].
Required faults and enabling state: for shared memory, reach `finishing` with
an empty queue, or cancel `discard`, or cancel the generation root, or close
the queue.
Confidence: high — [evidence](evidence/every-writer-exit-cancels-the-retired-token.md).
TCP satisfies it unconditionally: the cancellation sits after the loop
[tcp_frame_channel.rs:402], so every `break` reaches it. `run_endpoint`
cancels `retired` at only [shm_provider.rs:500] and [shm_provider.rs:539]; the
four `return true` sites bypass it. I confirmed the practical mitigation:
`queue: SenderQueue` is owned by `run_endpoint` [shm_provider.rs:462], so
returning drops the receiver and later `tx.send` calls fail with
`WriterGone` [frame_channel.rs:817-818]. So sends still fail; only the
`is_retired()` predicate lies.
Existing check: [contract_tests.rs:257, 284, 341], TCP only. Status:
unaudited.
Impact: five production sites gate on `is_retired()` [dispatch.rs:195,
dispatch.rs:266, dispatch.rs:311, dispatch.rs:690, connection.rs:1284]. On the
shared-memory path they would pass the gate, build and charge a frame, and
only then discover `WriterGone`, wasting an egress charge acquisition per
attempt. This is the channel-side counterpart to Part 2a's
`the-writer-task-is-abortable-through-a-stated-owner`; that record owns the
abort chain, this one owns the exit signal.
Open questions:
- Should `retired.cancel()` move into a guard whose `Drop` fires on every
  return, so a new implementation cannot omit it? (needs human input)

### every-egress-body-copy-is-counted

Type: safety
Reachability: default-production — `DirectFrame::into_owned` runs for every
direct frame on TCP [tcp_frame_channel.rs:347-354], and direct frames are
produced on the routed response path [dispatch.rs:334].
Status: active
Exercised: not yet — the only copy-count assertions are on the receive side
[contract_tests.rs:609-656, shm_provider.rs:902].
Guarantee: `CopyCounter` counts every explicit transport-byte copy the host
performs, in both directions, so a zero count proves a copy-free path.
Check: `always` — evaluated per frame that crosses a copy boundary. A
`sometimes` marker would only prove the counter can move, not that it is
complete.
Fault/timing angle: none. This is an accounting-completeness property.
Required faults and enabling state: no fault. Publish a direct frame over TCP
and observe the counter.
Confidence: high — [evidence](evidence/every-egress-body-copy-is-counted.md).
`DirectFrame` carries no `CopyCounter` field [frame_channel.rs:609-613] and
`into_owned` performs a full `Vec` build and serialize with no
`record_copy` [frame_channel.rs:640-649]. The only `record_copy` caller in the
module is `ReceiveLease::to_owned` [frame_channel.rs:376]; the only other is
the shared-memory receive path [shm_provider.rs:610-611]. So the counter is
structurally ingress-only.
Existing check: none on egress. Receive-side coverage at
[contract_tests.rs:609-656] and [shm_provider.rs:859-903]. Status: unaudited.
Impact: [frame_channel.rs:78-81] declares the counter as the "Observable count
of explicit transport-byte copies" where "Direct/leased paths leave this at
zero". On TCP a direct frame is always copied
[tcp_frame_channel.rs:347-354], so the counter reports zero for a path that
copies every body. Any zero-copy conformance claim measured with this counter
is unfalsifiable on egress.
Open questions:
- Is the counter scoped to ingress by design? The doc phrase "into owned
  semantic storage" arguably excludes an egress staging buffer. If so, the
  name and doc should say so. (needs human input)

### oversize-control-drain-shares-the-frames-absolute-deadline

Type: safety
Reachability: default-production — the drain is armed at
[tcp_frame_channel.rs:201] and executed at [tcp_frame_channel.rs:97-112] for
any channel-0 `Request` declaring more than 65,536 bytes
[tcp_frame_channel.rs:198].
Status: active
Exercised: partial — `drain_discards_exactly_declared_bytes_and_realigns`
[tcp_frame_channel.rs:731-770] and
`receiver_reports_rejection_then_drains_without_allocation_and_realigns`
[tcp_frame_channel.rs:773-808] prove realignment and zero budget hold.
`receiver_reports_failed_drain_as_rejected_drain_failure`
[tcp_frame_channel.rs:811-834] proves the EOF case. None exercises deadline
exhaustion during the drain.
Guarantee: the header read and the subsequent drain of up to 64 MiB together
complete within one `frame_deadline`, or the generation closes with
`RejectedDrainFailed`; the drain never allocates the body and never holds
ingress budget.
Check: `always` — on every oversize-control rejection, because a drain that
neither completes nor fails leaves the stream misaligned.
Fault/timing angle: the deadline is `Instant::now() + frame_deadline` sampled
at the first header byte [tcp_frame_channel.rs:169] and reused verbatim for
the drain [tcp_frame_channel.rs:201, tcp_frame_channel.rs:124-127]. Header
bytes that trickle in consume the drain's budget. The drain must then move up
to `MAX_BODY_LEN` in the remainder.
Required faults and enabling state: a peer that sends the 21-byte header
slowly, then trickles a large declared body. Required throughput for success is
`declared / (frame_deadline - header_time)`.
Confidence: high — [evidence](evidence/oversize-control-drain-shares-the-frames-absolute-deadline.md).
Verified the single shared `deadline` value across both phases. Verified the
mitigation that keeps this from being worse: the reader emits the
authoritative rejection off-task with `spawn_tracked` and does not await it
[connection.rs:436-463], so the terminal's own admission (itself up to one
`admission_timeout`) does not consume the drain window. Also verified this is
a documented design, not a discovered bug: "drains and discards the declared
bytes under the frame's absolute deadline"
[docs/mc-host-wire-protocol.md:318]. The property therefore asserts the bound.
Existing check: [tcp_frame_channel.rs:731-770, 773-808, 811-834]. Status:
unaudited.
Impact: an honest but slow peer that trips the control cap is closed with
`RejectedDrainFailed` rather than merely rejected. That is the intended
defence, but it means the *effective* control-cap rejection path has a
throughput requirement no configuration surface names.
Open questions:
- `ReadClose::RejectedDrainFailed` has exactly one producer
  [tcp_frame_channel.rs:110] and cannot arise on the shared-memory path,
  which releases the lease instead [shm_provider.rs:566-568]. Is
  `ReadExit::PeerKeepQueue` [connection.rs:404-408] therefore
  transport-specific by design?

### every-channel-implementation-runs-the-shared-contract-suite

Type: reachability
Reachability: test-only — the suite is a `#[cfg(test)]` module
[frame_channel.rs:27-28] instantiated at [contract_tests.rs:456-458].
Status: active
Exercised: partial — the suite exists and nine scenarios run, but against one
of the two implementations.
Guarantee: every type that drains a `SenderQueue` and implements
`FrameReceiver` is registered with `frame_channel_contract_suite!`, so a
second implementation cannot silently provide weaker semantics than the first.
Check: `reachable` — this is code-location coverage: the assertion is that the
suite body executes once per implementation. Situation coverage is not the
question; the scenarios themselves supply that.
Fault/timing angle: none.
Required faults and enabling state: none. A `ChannelFactory` implementation
for the shared-memory endpoint, which would require a synchronous-ring
`PeerDriver` [contract_tests.rs:63-79].
Confidence: high — [evidence](evidence/every-channel-implementation-runs-the-shared-contract-suite.md).
Grepped for `impl.*ChannelFactory` and `frame_channel_contract_suite!` across
`crates/`: exactly one implementation [tcp_frame_channel.rs:429] and one
instantiation [contract_tests.rs:457]. The module doc states the intent
directly: "a later provider registers by instantiating
[`frame_channel_contract_suite!`] with its own factory"
[contract_tests.rs:5-6]. The shared-memory endpoint is that later provider and
it has not registered.
Existing check: [contract_tests.rs:456-458], TCP only. Status: unaudited.
Impact: this is the mechanism that would have caught most of the divergences
in this lens. Specifically, `completion_hooks_fire_once_in_order_without_claiming_receipt`
[contract_tests.rs:205-247] would exercise the shared-memory hook timing,
`discard_drops_queued_frames_and_releases_charges`
[contract_tests.rs:322-349] would exercise the `retired`-on-exit gap at
[shm_provider.rs:522], and
`cancellation_before_admission_leaves_the_frame_unpublished`
[contract_tests.rs:249-268] asserts `is_retired()` at
[contract_tests.rs:257].
Open questions:
- Is a `ChannelFactory` for the shared-memory endpoint feasible without a
  real ring, or does it need the out-of-process harness in
  `crates/mc-host/tests/support/shm_process.rs`? (needs human input)

### shm-egress-progress-does-not-depend-on-inbound-arrivals

Type: liveness
Reachability: test-only — reachable only through
`TransportProviders::with_injected` [transport_provider.rs:180], whose in-tree
callers are all under `crates/mc-host/tests/`. `ShmProvider`'s only
constructor is `for_qualified_test_profile` [shm_provider.rs:156], and
`prepare` additionally requires Linux and an exact offer match
[shm_provider.rs:288-289].
Status: active
Exercised: not yet — no test saturates inbound while measuring outbound
drain rate.
Guarantee: after inbound traffic stops, every frame already admitted to the
writer queue is published within a bounded number of loop iterations, and
while inbound traffic continues, outbound publication rate is not capped by
the inbound arrival rate.
Check: `always` — stated as a bounded liveness claim. Run under sustained
inbound load, stop the inbound pressure, then poll until the queue is empty
within an explicit bound expressed in loop iterations and `POLL_INTERVAL`
units [shm_provider.rs:55], not as an unbounded "eventually".
Fault/timing angle: the coupling is [shm_provider.rs:507-513]: when a frame
was received, the loop takes at most one outbound frame and only with
`try_recv`. During an ingress-budget wait it publishes at most one frame per
`POLL_INTERVAL` [shm_provider.rs:592-602].
Required faults and enabling state: a peer that keeps the inbound ring full
while the host has more than one frame queued outbound; plus, for the harder
case, a saturated ingress budget so the [shm_provider.rs:579-603] wait loop is
entered.
Confidence: medium — [evidence](evidence/shm-egress-progress-does-not-depend-on-inbound-arrivals.md).
The 1:1 alternation is explicit and commented as deliberate
[shm_provider.rs:508-512], so the intent is anti-starvation in the other
direction: guaranteeing responses are not blocked *by* egress contention. What
I have not established is the resulting egress rate ceiling under sustained
inbound load, because that depends on ring geometry I did not measure. The
interaction that makes it matter is verified though: admission expiry retires
the generation [frame_channel.rs:819-823], so a depressed drain rate converts
into connection loss rather than latency.
Existing check: none. The shared-memory endpoint runs no contract scenario
[contract_tests.rs:456-458]. Status: not applicable, none found.
Impact: a peer that streams requests hard could hold the host's outbound queue
near full; the next admission then retires the generation
[frame_channel.rs:819-823]. Under TCP the writer task is independent of the
reader, so the same load does not throttle egress. Two implementations, two
different overload behaviours, one declared contract.
Open questions:
- What is the actual egress ceiling? Needs a measured drain rate against a
  full inbound ring; I did not run the shared-memory harness.
- Is the blocking `std::thread::sleep` at [shm_provider.rs:601] safe? It looks
  contained because the endpoint owns a dedicated thread and a
  `new_current_thread` runtime [shm_provider.rs:319-324], so it cannot stall
  other generations, but it does stall this generation's own timers.

## Contract-vs-code leads

- L1: **Writers must verify header `len` equals body length.**
  Contract: "Writers MUST verify header `len` equals body length"
  [docs/mc-host-wire-protocol.md:295]. Code: no such verification exists on
  either publication path [tcp_frame_channel.rs:369-374,
  shm_provider.rs:681-689], and `DirectFrame::new` accepts `header` and
  `body_len` as independent arguments [frame_channel.rs:616-626]. The
  obligation is currently discharged by convention in the `wire.rs` encoders
  [wire.rs:542-620], not by the channel that the MUST addresses.

- L2: **Proven-unwritten must classify as `not_sent`.**
  Contract: "queued requests proven unwritten are `not_sent`"
  [docs/mc-host-wire-protocol.md:785]; `not_sent` is "sender proves zero
  bytes ... reached the socket" [docs/mc-host-wire-protocol.md:56]. Code: a
  second `cancel()` on a ticket for a frame cancelled before publication
  returns `PossibleSend` [frame_channel.rs:747-755], and
  [contract_tests.rs:582] asserts exactly that.

- L3: **The write deadline's claimed scope.**
  Code comment: "The deadline bounds how long one consumer can hold shared
  egress-budget charges" [tcp_frame_channel.rs:307-312]. Code: the deadline is
  armed per frame [tcp_frame_channel.rs:369] against a queue of
  `writer_queue_frames` frames [frame_channel.rs:862, config.rs:141], so the
  aggregate bound is depth times deadline.

- L4: **`CopyCounter`'s claimed completeness.**
  Doc: "Observable count of explicit transport-byte copies. Direct/leased
  paths leave this at zero. TCP and compatibility adapters add exactly one for
  each body they copy into owned semantic storage"
  [frame_channel.rs:78-81]. Code: TCP's direct path always copies
  [tcp_frame_channel.rs:347-354, frame_channel.rs:640-649] and records
  nothing; `DirectFrame` holds no counter [frame_channel.rs:609-613].

- L5: **The module doc describes a producer no implementation uses.**
  Doc: "Direct producers fill bounded transport spans through a cursor and
  commit one exact length" [frame_channel.rs:8-9]. Code:
  `frame_channel::ProducerReservation`/`ProducedBody`
  [frame_channel.rs:110-288] have no callers outside
  [contract_tests.rs:460-562]. The shared-memory provider uses a
  same-named but distinct type from the ring backend [shm_provider.rs:20,
  shm_provider.rs:693].

- L6: **Undocumented precedence when a frame carries both encodings.**
  `OutboundFrame` documents no relationship between `direct` and
  `bytes`/`tail` [frame_channel.rs:696-704]. Both implementations silently
  prefer `direct` and discard `bytes`/`tail`
  [tcp_frame_channel.rs:351-354, shm_provider.rs:645-648]. A caller that sets
  both loses the owned bytes with no error.

- L7: **Completion-instant sampling point.**
  TCP documents the sampling point as load-bearing: taken "the moment
  `write_all` returns — not after the result check — so a preemption between
  them cannot push `completed_at` past a peer answer that the bytes
  themselves caused" [tcp_frame_channel.rs:362-365]. Shared memory samples
  after commit, after `decode_header`, and after the `publish_hook`
  [shm_provider.rs:652-659], which is exactly the ordering the TCP comment
  argues against.

## Open questions

1. Is the send side deliberately un-abstracted? A `FrameReceiver` trait
   exists [frame_channel.rs:574-576] but no `FrameSender` trait, so admission
   and ticket semantics are fixed while the drain loop is free. That is the
   shape that let the two drain loops diverge. (needs human input)
2. Is the shared-memory endpoint intended to be production-reachable? Its
   only constructor is `for_qualified_test_profile` [shm_provider.rs:156],
   which pins the reachability labels above. If it is, every `test-only` label
   in this lens needs revisiting and the contract-suite gap becomes urgent.
3. `HostLimits::validate` rejects `writer_queue_frames == 0`
   [config.rs:154-160], which is what stops `mpsc::channel(0)`
   [frame_channel.rs:862] from panicking. I did not verify that every path
   reaching `frame_sender` has passed `validate()`. Unresolved, needs a
   construction-path audit of `ProviderContext::queue_frames`
   [transport_provider.rs:337-343].
4. What observes `COMPLETE` [frame_channel.rs:709]? It is stored by both
   implementations [tcp_frame_channel.rs:389-392, shm_provider.rs:652] and
   read by `cancel()` only implicitly, as "not `QUEUED`". If nothing reads it
   distinctly, the four-state machine is really three states plus a write-only
   marker. Unresolved, needs a reader audit outside this lens's scope.
5. Does any caller depend on `send()` returning `Ok` as evidence of
   publication? The distinction matters for the
   `an-admitted-frame-is-published-or-its-loss-is-observable` record and lives
   in `dispatch.rs`, outside this lens.
