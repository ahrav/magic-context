# neither-direction-starves-the-other

## Citation refresh, 2026-08-30

The ring-transport refactor (`0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`)
renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs`. Host-side citations below
were re-anchored against `ring_transport.rs` at `e447c927`.

Where the cited construct survives, the citation names `ring_transport.rs` and a
line re-verified against that commit. Where it does not, the original reference is
kept and prefixed `former`, so it reads as pre-refactor evidence rather than a
current location. A `former` line number is never a claim about the tree today.
Every `provider_recovery.rs` reference is `former` by definition: that module has
no successor. See the refresh note in [../catalog.md](../catalog.md).

## Discovery trigger

The host drives both directions of a duplex ring pair from one task on one thread. The
code says so, and it says why: a comment at `ring_transport.rs:410-414` claims
"directions alternate under sustained inbound traffic ... so a peer that refills the
inbound ring as slots release cannot starve responses, Pings, and close frames while
host-to-peer capacity is free". That is a liveness claim about a single-threaded loop,
stated in a comment, asserted nowhere. Every shared-memory host test is strict
request-response lockstep, so no test has ever had frames in flight in both directions
at once.

## Evidence trail

- `crates/mc-host/src/ring_transport.rs:254-259` — the endpoint runs on a dedicated OS
  thread named `mc-host-shm-endpoint` carrying a `new_current_thread` Tokio runtime.
  `:351-361` runs `run_endpoint` under `block_on` inside `catch_unwind`. One task, one
  thread, both directions.
- `:473-544` — the loop. Each iteration does at most one `receive_one` (`:476-486`) and
  at most one `publish_one` (`:538`).
- `:507-513` — the alternation the comment claims. When a frame was received, the loop
  takes at most one queued outbound frame with a non-blocking `queue.try_recv().ok()`.
  This is the inbound-cannot-starve-outbound direction, and it holds: a receive is
  always followed by an outbound attempt.
- `:520-534` — when nothing was received, a `biased` `select!` waits on discard,
  finish, root, `queue.recv()`, and a `POLL_INTERVAL` sleep. `POLL_INTERVAL` is 50
  microseconds (`:33`).
- **First starvation path, outbound blocks inbound.** `publish_one` at `:538` is a
  synchronous function. It calls `publish_direct` (`:665-678`) or `publish_owned`
  (`:680-691`), both of which call `Ring::reserve_until` (`:669`, `:685`) with a
  deadline of `now + frame_deadline` (`:644`). `reserve_until` busy-retries in the
  calling thread, sleeping 50 microseconds per attempt under `ColdParkWake`
  (`crates/mc-shm-transport/src/backend/ring.rs:747-753`), which is the profile the
  host selects (`:80`). There is no `.await` anywhere in that path, so while the
  outbound ring is full no `try_receive` runs at all. The stall is bounded by
  `frame_deadline` per frame, and on expiry `publish_one` returns `Err`, the loop
  cancels and returns `false` (`:546-550`), and the close is unclean and reports a
  suspect (`:347-354`).
- **Second starvation path, inbound blocks outbound.** `receive_one` ends with
  `inbound.send(Ok(InboundEvent::Frame(..))).await` (`:617-622`) on the bounded channel
  created at `:291` with `mpsc::channel(ctx.queue_frames)`. That await has no timeout
  and is not inside a `select!`, so it parks until the application drains the channel or
  the receiver is dropped. While parked, the endpoint publishes nothing. The bound comes
  from the far side instead: a sender whose queue stays full past its deadline retires
  the generation itself (`crates/mc-host/src/frame_channel.rs:812-824`, the
  `timeout_at` arm at `:815` and the `retired`/`generation` cancel at `:819-823`), where
  the deadline is `admission_deadline()` built from the same `frame_deadline`
  (`:783-785`). So the symptom is a retired generation, not a hang.
- **Where the design does defend itself.** The ingress-budget wait inside `receive_one`
  explicitly services outbound frames rather than blocking on the budget alone:
  `:592-602` calls `queue.try_recv()` and `publish_one` on each turn, sleeping
  `POLL_INTERVAL` only when the outbound queue is empty (`:601`). The comment at
  `:592-594` states the reason. That path is the counterexample to the claim that the
  loop never yields to the other direction, and it is why the property is a bounded
  ratio rather than a flat prohibition.
- Lease pressure is not the mechanism. `receive_one` holds at most one lease and
  releases it on every path (`:566-568`, `:604-609`, `Drop` on error), out of
  `max_leases == 8` (`:54`, `:91-94`).
- Existing check: none. Every host shared-memory test is lockstep. In
  `qualified_provider_grants_activates_correlates_and_closes`
  (`crates/mc-host/tests/shm_transport.rs:189-271`) each `peer.send` is immediately
  followed by `peer.recv(BUDGET)`, five times. `TestShmPeer` itself only offers the
  lockstep shape: `send` reserves, writes, and commits in one call
  (`ring_transport.rs:659-673`) and `recv` polls to a deadline (`:762-776`). The transport
  test `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:581-618`) uses a single ring in a single
  direction.

## Failure scenario

1. The peer offers inbound frames continuously and the host has responses queued, so
   both directions have work.
2. The peer stops draining host-to-peer, or drains it slower than the host fills it.
   The outbound ring reaches depth or its arena fills.
3. The next `publish_one` enters `reserve_until` and spins there. For up to
   `frame_deadline` the host performs no `try_receive`, so inbound frames accumulate in
   `SLOT_PUBLISHED`.
4. The peer's own `reserve_until` on its producer ring now fails: the inbound ring is at
   depth because nobody is consuming it. The peer sees `Deadline` from a healthy
   transport whose only problem is that the host is parked on the other lane.
5. Symmetrically, if the application stops draining the `inbound` channel, the endpoint
   parks in `inbound.send().await` and publishes nothing until the outbound sender's own
   admission timeout retires the generation. Either way one direction's pressure ends
   the other direction's progress, and both terminate as transport faults.

## Timing windows and dependencies

Three bounds define the property and all three are configuration, not constants in this
file. The outbound stall is bounded by `frame_deadline` per publish attempt
(`:465`, `:644`). The inbound stall is bounded by the sender's admission timeout, the
same `frame_deadline` (`frame_channel.rs:783-785`). The idle poll granularity is
`POLL_INTERVAL`, 50 microseconds (`:55`), which also sets the retry spacing inside
`reserve_until`. Because the endpoint owns its own thread and its own current-thread
runtime, none of this blocking harms other host tasks — the damage is confined to the
opposite lane of the same endpoint, which is exactly the scope of this property.
Dependency: the situation requires frames genuinely in flight in both directions at
once, which today is never constructed; that precondition is carried as
`duplex-overlap-is-reached`. The property is only meaningful for a peer that is
draining at all. A peer that has stopped draining permanently is the dead-peer case and
belongs to `dead-peer-charges-are-reclaimed-or-declared`.

## What a test must construct

Simultaneous offered load in both directions, then removal of the pressure, then a
bounded drain assertion. The peer side needs a shape `TestShmPeer` does not have today:
independent send and receive threads, or a non-blocking `try_send`/`try_recv` pair, so
the peer can hold frames outstanding in both directions rather than alternating. The
oracle has two parts. Non-starvation under load: over a measurement window in which
both directions have frames offered continuously, both directions must complete at least
one frame — a ratio bound with an explicit constant, for example neither direction
completing fewer than one frame per K completions of the other, with K chosen from
`frame_deadline / POLL_INTERVAL` and recorded in the test. Bounded drain after
pressure stops: stop offering on both sides, poll until stable within an explicit bound,
then assert both queues are empty, `conservation()` reports all descriptors free on both
rings, and neither direction reported a close. The second arm is the refutable one and
must not be satisfied by a generous timeout: assert the drain completed strictly inside
the bound. A third arm pins the second starvation path directly: stop draining the
`inbound` channel while outbound frames are queued, and assert the observable outcome
is the sender's admission timeout rather than an unbounded stall. Coverage check to
emit: `shm_both_directions_in_flight`.

## Investigation log

### Q: Can a single-threaded endpoint loop starve one direction, and if so which one?

- Sources examined: `crates/mc-host/src/ring_transport.rs:33`, `:75-100`, `:287-397`,
  `:459-544`, `:455-534`, `:536-578`, `:665-691`, `:711-777`;
  `crates/mc-host/src/frame_channel.rs:770-826`, `:838-880`;
  `crates/mc-shm-transport/src/backend/ring.rs:738-759`, `:766-846`;
  `crates/mc-host/tests/shm_transport.rs:189-271`.
- Findings: yes, and the two directions are not symmetric. Inbound cannot starve
  outbound through the receive path, because every received frame is followed by one
  non-blocking outbound attempt (`:507-513`) and the ingress-budget wait also services
  outbound (`:592-602`) — the comment's claim is accurate for the case it describes.
  Outbound *can* starve inbound, because `publish_one` blocks the single thread inside
  `reserve_until` with no yield, for up to `frame_deadline` per frame. And inbound
  *can* starve outbound through a path the comment does not cover: the unbounded
  `inbound.send().await` at `:612-617`, which is neither timed nor selected against the
  outbound queue. Neither stall is infinite — the first ends in an unclean close, the
  second in the sender's admission timeout — so the accurate statement is bounded
  starvation with a fault-shaped outcome, not a deadlock.
- Missing evidence: the numeric ratio. `frame_deadline` is caller-supplied
  (`ProviderContext`), so the worst-case service ratio between the lanes cannot be
  derived from this crate alone; a test must pin it from the configuration it runs
  under. Also untested rather than unknown: whether the addon endpoint, which drives the
  same rings from JavaScript, has the same shape.
- Conclusion: resolved with answer — one direction can starve the other, in both
  directions, by two distinct mechanisms, and the comment at `:508-512` is true only of
  the receive-then-publish alternation and not of the two blocking paths. The property
  must therefore be a bounded ratio plus a bounded post-pressure drain, and the
  duplex-overlap situation must be constructed before either can be measured.
