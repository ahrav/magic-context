# queued-write-needs-no-second-wake

## Discovery trigger

Fix commit `ad5bef49e` "prevent queued ring writes from waiting for a second
wake". Lead only; the mechanism was re-read at HEAD.

## Evidence trail

- The client ring bridge is one thread multiplexing writes and reads
  (`crates/mc-host/src/client.rs:1805` `start_ring_bridge`). Each loop pass
  takes at most one queued write via `write_rx.try_recv()` (`:1847-1861`),
  then drains inbound, then decides whether to block.
- Writers signal the bridge's private `worker_wake` eventfd once per enqueue
  (`RingWriteSender::try_send`, `:1764-1768`). Eventfds coalesce: eight
  enqueues before the bridge polls produce one readable edge, and
  `drain_eventfd` (`:1800-1803`) consumes it whole.
- The fix is the `wrote` flag: set after a successful send (`:1846`,
  `:1858`), checked at `:1913-1915` — `if wrote { continue; }` — so a pass
  that completed a write skips `arm_data_wait` and the blocking poll
  (`:1916-1937`) entirely and immediately re-polls the write queue.
- Without it, the bridge would process one write, find the coalesced eventfd
  already drained, arm the data doorbell, and block on
  `[worker_wake, data_ready, setup]` (`:1921-1928`) while seven writes sit in
  the queue with no future edge to deliver them.
- `RingWriteSender::drop` also signals (`:1771-1774`), so channel teardown
  cannot strand the final pass.

## Failure scenario

A caller enqueues a burst of writes, then goes quiet. One write is sent; the
rest wait for the next unrelated event — an inbound frame, a capacity signal,
or peer death. Writes complete with unbounded latency or time out at their
deadlines (`endpoint.send(header, body, deadline)`, `:1850-1852`), reported
as transport failures on a healthy channel.

## Timing windows and dependencies

The window opens when more than one write is queued before the bridge drains
`worker_wake`, and closes only on the next external edge. Bounded liveness
claim at HEAD: k queued writes complete in k loop passes with no signal after
the first, because every pass that writes continues and every continue
re-polls the queue. The bound is in loop passes, not wall time; a pass can
still block inside `endpoint.send`'s own capacity wait, which is
`capacity-recheck-after-a-wake-race`'s territory.

## What a test must construct

Multiple writes enqueued without per-write wakes, at most one edge delivered,
then per-write bounded completion. Exists:
`ring_bridge_drains_inbound_and_queued_writes`
(`crates/mc-host/src/client.rs:4003-4076`) pushes eight writes directly into
`write.tx` — bypassing `RingWriteSender::try_send`, so zero worker_wake edges
(`:4041`) — publishes one inbound frame and signals one explicit edge
(`:4060-4062`), then bounds every completion at 250 ms (`:4069-4075`). Not
yet constructed: the same starvation with the inbound direction idle (the
existing test's one edge doubles as the wake; a variant with no inbound
frame at all would isolate the `wrote` path).

## Investigation log

### Q: does `continue` after a write starve inbound frames instead?

- Sources examined: loop order `:1846-1915`.
- Findings: the inbound drain (`endpoint.try_recv_with`, `:1903-1911`) runs
  before the `wrote` check, so every pass services at most one write and one
  inbound frame; neither side can monopolize a pass. The pre-fix test name,
  `ring_bridge_drains_inbound_between_sustained_writes`, pinned the inbound
  half; the renamed test pins both.
- Missing evidence: none.
- Conclusion: resolved with answer — no.

### Q: is one write per pass a throughput ceiling worth recording?

- Sources examined: `:1847-1861`; `CLIENT_DATA_QUEUE_FRAMES` queue bound.
- Findings: deliberate shape, bounded queue, no evidence of a measured
  problem; a per-pass batch would change deadline fairness.
- Missing evidence: none.
- Conclusion: resolved with answer — not a property; noted as context only.
