# neither-direction-starves-the-other

## Citation refresh, 2026-08-31 (eventfd rewrite)

PR #131 (merge `5d638e3e8`) replaced the polling wake mechanism with sparse
eventfd doorbells. `POLL_INTERVAL` is gone from production and survives only
in `crates/mc-host/tests/support/process_resources.rs:75`, a test-support
poll constant. The endpoint loop, `receive_one`, and the peer harness
(`TestShmPeer` is now `RingClientEndpoint`) were rewritten; every line below
was re-verified against HEAD. `POLL_INTERVAL`-based derivations in this file
are replaced; where prior text is kept for history it is explicitly marked
pre-eventfd.

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
code says so, and it says why: a comment at `ring_transport.rs:416-420` claims
"directions alternate under sustained inbound traffic ... so a peer that refills the
inbound ring as slots release cannot starve responses, Pings, and close frames while
host-to-peer capacity is free". That is a liveness claim about a single-threaded loop,
stated in a comment, asserted nowhere. Every shared-memory host test is strict
request-response lockstep, so no test has ever had frames in flight in both directions
at once.

## Evidence trail

- `crates/mc-host/src/ring_transport.rs:238-243` — the endpoint runs on a dedicated OS
  thread named `mc-host-shm-endpoint` carrying a `new_current_thread` Tokio runtime.
  `:264-274` runs `run_endpoint` under `block_on` inside `catch_unwind`. One task, one
  thread, both directions.
- `:384-484` — the loop. Each iteration does at most one `receive_one` (`:387-396`)
  and at most one `publish_one` (`:479`).
- `:415-421` — the alternation the comment claims. When a frame was received, the loop
  takes at most one queued outbound frame with a non-blocking `queue.try_recv().ok()`.
  This is the inbound-cannot-starve-outbound direction, and it holds: a receive is
  always followed by an outbound attempt.
- `:428-474` — when nothing was received, the loop arms the data doorbell with
  `arm_data_wait` (`:429`) and enters a `biased` `select!` (`:441-474`) over discard,
  finish, read-cancel, `queue.recv()`, and `readiness.readable()` on an `AsyncFd`
  wrapping the duplicated `data_ready` eventfd (`:371-374`). There is no idle sleep
  and no poll interval: the loop is woken by the peer's doorbell signal or by its own
  cancellation and queue events.
- **First starvation path, outbound blocks inbound.** `publish_one` at `:560` is a
  synchronous function. It calls `publish_direct` (`:604-616`) or `publish_owned`
  (`:619-630`), both of which call `Ring::reserve_until` (`:608`, `:624`) with a
  deadline of `now + frame_deadline` (`:583`). `reserve_until`
  (`crates/mc-shm-transport/src/backend/ring.rs:980-1048`) parks the calling thread
  on the `capacity_ready` doorbell (`:1035`) between rechecks. There is no `.await`
  anywhere in that path, so while the outbound ring is full no `try_receive` runs at
  all. The stall is bounded by `frame_deadline` per frame, and on expiry
  `publish_one` returns `Err` and the loop cancels and returns
  (`ring_transport.rs:479-483`).
- **Second starvation path, inbound blocks outbound.** `receive_one` ends with
  `inbound.send(Ok(InboundEvent::Frame(..))).await` (`:551-556`) on the bounded
  channel created at `:230` with `mpsc::channel(queue_frames)`. That await has no
  timeout and is not inside a `select!`, so it parks until the application drains the
  channel or the receiver is dropped. While parked, the endpoint publishes nothing.
  The bound comes from the far side instead: a sender whose queue stays full past its
  deadline retires the generation itself (`crates/mc-host/src/frame_channel.rs:640-652`,
  the `timeout_at` arm at `:643` and the `retired`/`generation` cancel at `:647-650`),
  where the deadline is `admission_deadline()` (`:613-615`) built from the same
  `frame_deadline` (`ring_transport.rs:229`). So the symptom is a retired generation,
  not a hang.
- **Where the design does defend itself.** The ingress-budget wait inside
  `receive_one` explicitly services outbound frames rather than blocking on the
  budget alone: the select at `:523-541` includes a `queue.recv()` arm that calls
  `publish_one` (`:533-538`). Under eventfd it is a pure select with no sleep arm.
  That path is the counterexample to the claim that the loop never yields to the
  other direction, and it is why the property is a bounded ratio rather than a flat
  prohibition.
- Lease pressure is not the mechanism. `receive_one` holds at most one lease and
  releases it on every path (`:507-509`, `:546-548`, `Drop` on error), out of
  `max_leases == 8` (`crates/mc-shm-transport/src/profile.rs:652`, `:655-670`).
- Existing check: none. Every host shared-memory test is lockstep. The peer harness
  `RingClientEndpoint` offers `send` that reserves, writes, and commits in one
  blocking call (`ring_transport.rs:684-700`), `recv` that blocks in `wait_for_data`
  to a deadline (`:702-716`), and a non-blocking `try_recv` (`:718-721`); nothing in
  the suites drives send and receive concurrently. The transport test
  `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:551-592`) uses a single ring in a single
  direction.

## Failure scenario

1. The peer offers inbound frames continuously and the host has responses queued, so
   both directions have work.
2. The peer stops draining host-to-peer, or drains it slower than the host fills it.
   The outbound ring reaches depth or its arena fills.
3. The next `publish_one` enters `reserve_until` and parks on the `capacity_ready`
   doorbell. For up to `frame_deadline` the host performs no `try_receive`, so
   inbound frames accumulate in `SLOT_PUBLISHED`. Unlike the pre-eventfd design,
   the host is not spinning: it is asleep in `wait_until` (`ring.rs:1035`) and only
   the peer's release (which signals `capacity_ready`, `ring.rs:1236-1241`) or the
   deadline wakes it. A lost or skipped wake therefore presents as the full
   `frame_deadline` stall even if capacity cleared earlier.
4. The peer's own `reserve_until` on its producer ring now parks too: the inbound
   ring is at depth because nobody is consuming it, and the host, being parked on
   the other lane, never leases a frame and never signals the peer's
   `capacity_ready`. The peer sees `Deadline` from a healthy transport whose only
   problem is that the host is parked on the other lane.
5. Symmetrically, if the application stops draining the `inbound` channel, the endpoint
   parks in `inbound.send().await` and publishes nothing until the outbound sender's own
   admission timeout retires the generation. Either way one direction's pressure ends
   the other direction's progress, and both terminate as transport faults.

## Timing windows and dependencies

Two bounds define the property and both are configuration, not constants in this
file. The outbound stall is bounded by `frame_deadline` per publish attempt
(`ring_transport.rs:583`). The inbound stall is bounded by the sender's admission
timeout, the same `frame_deadline` (`frame_channel.rs:613-615`, wired at
`ring_transport.rs:229`). The former third quantity, the 50-microsecond
`POLL_INTERVAL` idle-poll granularity, no longer exists: waits park on eventfd
doorbells (`ring.rs:1035`, `:1149`) and the corresponding floor is doorbell wake
latency, which the code does not constant-bound. Because the endpoint owns its own
thread and its own current-thread runtime, none of this blocking harms other host
tasks — the damage is confined to the opposite lane of the same endpoint, which is
exactly the scope of this property. Dependency: the situation requires frames
genuinely in flight in both directions at once, which today is never constructed;
that precondition is carried as `duplex-overlap-is-reached`. The property is only
meaningful for a peer that is draining at all. A peer that has stopped draining
permanently is the dead-peer case and belongs to
`dead-peer-charges-are-reclaimed-or-declared`.

## What a test must construct

Simultaneous offered load in both directions, then removal of the pressure, then a
bounded drain assertion. The peer side needs a shape `RingClientEndpoint` does not
have today: independent send and receive threads, or a non-blocking send to pair
with the existing `try_recv`, so the peer can hold frames outstanding in both
directions rather than alternating. The oracle has two parts. Non-starvation under
load: over a measurement window in which both directions have frames offered
continuously, both directions must complete at least one frame — a ratio bound with
an explicit constant, for example neither direction completing fewer than one frame
per K completions of the other, with K pinned from the test's own `frame_deadline`
configuration and recorded in the test; there is no code-derived K because the only
per-lane bound the code enforces is `frame_deadline` itself. Bounded drain after
pressure stops: stop offering on both sides, poll until stable within an explicit
bound, then assert both queues are empty, `conservation()` reports all descriptors
free on both rings, and neither direction reported a close, strictly inside the
bound. Under eventfd the drain arm doubles as a lost-wake detector: a parked
`reserve_until` whose `capacity_ready` signal was skipped converts a sub-deadline
drain into a `frame_deadline`-shaped stall, so the drain bound must be set well
below `frame_deadline` to distinguish a wake from a timeout. A third arm pins the
second starvation path directly: stop draining the `inbound` channel while outbound
frames are queued, and assert the observable outcome is the sender's admission
timeout rather than an unbounded stall. Coverage check to emit:
`shm_both_directions_in_flight`.

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

### 2026-08-31: re-derivation against the eventfd doorbell mechanism

- Sources examined: `crates/mc-host/src/ring_transport.rs:359-485`, `:487-558`,
  `:560-630`, `:684-721`, `:799-806`;
  `crates/mc-shm-transport/src/backend/ring.rs:384-467`, `:828-854`, `:980-1048`,
  `:1138-1158`, `:1236-1241`, `:1418-1432`, `:1622`;
  `crates/mc-host/src/frame_channel.rs:613-615`, `:640-652`.
- Findings: both starvation mechanisms survive PR #131 unchanged in shape.
  `publish_one` is still synchronous on the endpoint thread; its wait is now a
  parked `capacity_ready.wait_until` instead of a 50-microsecond retry sleep, so
  the outbound-blocks-inbound stall is identical in bound (`frame_deadline`) but
  different in failure texture: a lost `capacity_ready` wake presents as the full
  deadline. The untimed `inbound.send().await` is unchanged. The idle loop no
  longer sleeps at all; it arms `arm_data_wait` and parks in a select over the
  `AsyncFd`-wrapped doorbell, so the pre-eventfd `frame_deadline / POLL_INTERVAL`
  ratio derivation has no referent. A repo test pins the removal:
  `shared_memory_workers_have_no_periodic_polling` (`ring_transport.rs:799-806`).
  `POLL_INTERVAL` survives only in
  `crates/mc-host/tests/support/process_resources.rs:75`.
- Missing evidence: unchanged from the prior section — the numeric ratio K remains
  a configuration decision, and doorbell wake latency has no code-stated constant
  bound to substitute for the old poll quantum.
- Conclusion: resolved with answer — the guarantee and both starvation mechanisms
  survive; only the bound derivation changes. K must be pinned by the test from
  `frame_deadline` alone, and the drain arm gains a second job as a lost-wake
  detector.
