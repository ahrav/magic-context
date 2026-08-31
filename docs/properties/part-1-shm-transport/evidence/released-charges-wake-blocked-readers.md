# released-charges-wake-blocked-readers

## Discovery trigger

Fix commit `d9d3e632b` "Wake blocked ring readers when released byte charges
free capacity". Before it, the bridge's charge wait was a 50-microsecond
sleep loop; the eventfd rewrite made the wait blocking, which turned a missed
wake from wasted CPU into a hang. Lead only; mechanism re-verified at HEAD.

## Evidence trail

- The bridge admits an inbound frame only under a `ByteCounter` charge. The
  `charge` closure (`crates/mc-host/src/client.rs:1869-1902`) loops: refuse
  frames wider than capacity (`:1870-1872`), try `read_budget.charge(bytes)`
  (`:1873-1875`), then block in `poll` on `worker_wake` plus the setup socket
  (`:1879-1901`) and drain the eventfd on wake (`:1899-1901`).
- Waiting there is deliberate backpressure: `endpoint.try_recv_with` advances
  the consumed cursor, so refusing a charge would discard a valid response
  (comment at `:1863-1868`).
- The wake edge is wired at bridge start: `read_budget.set_wake(&wake_fd)`
  (`:1821`, setter at `:1683-1685`) stores a `Weak<OwnedFd>` in the counter.
- The release side is `ByteCharge::drop` (`:1711-1725`): decrement `used`,
  then, if a wake is registered and still alive, `signal_eventfd(&wake)`
  (`:1722`). Charges are dropped by the downstream consumer of the frame
  queue, a different thread from the bridge.
- The registration is per-counter and last-writer-wins (`set_wake` overwrites
  the `Mutex<Option<Weak<OwnedFd>>>`), and `read_budget` is per-connection
  (`:352-358`), so one bridge per counter holds at HEAD.

## Failure scenario

The read budget is exhausted by in-flight frames. The bridge parks in the
charge poll. The consumer finishes a frame and drops its `ByteCharge`. If
that drop did not signal, nothing else does on an otherwise idle channel:
`worker_wake`'s other writers are the write queue (`:1764-1773`), so a
read-heavy peer with no outbound writes leaves the bridge parked forever.
Every subsequent inbound frame sits in the ring unread; the producer
eventually exhausts and reports deadline errors. A wedged reader presents as
a slow peer.

## Timing windows and dependencies

Signal-before-park: `ByteCharge::drop` can run between the failed
`read_budget.charge` and the bridge's `poll`. The eventfd absorbs that race —
the write leaves the counter nonzero, so the later `poll` returns
immediately; there is no armed-epoch protocol here and none is needed because
the eventfd itself is level-observable state. Bounded window: one poll wakeup
plus one loop iteration per released charge. Dependency: the drop-side signal
fires only when `set_wake` ran first; the ordering is enforced by
construction (`:1821` precedes thread spawn at `:1824`).

## What a test must construct

Genuine budget exhaustion with the bridge parked in the charge poll, then a
charge drop from another thread, then bounded resumption — receipt of the
next frame within an explicit deadline. Nothing does this today: the
`ByteCounter` tests (`:3805-3891`, `:3953`) are synchronous accounting
checks, and both ring-bridge tests keep the budget at
`CLIENT_INBOUND_FRAME_BYTES` with small frames, so the poll arm never
executes. The situation needs a shrunken budget (a constructor exists,
`ByteCounter::new`) and a frame stream wider than it.

## Investigation log

### Q: can `saturating_sub` in the drop hide a lost-capacity defect?

- Sources examined: `:1715-1717`.
- Findings: under-subtraction is impossible; over-subtraction saturates at
  zero and would over-free capacity, the opposite failure. Out of scope for
  this record; the charge-conservation records own it.
- Conclusion: resolved with answer — different property.

### Q: is a poisoned wake mutex a hang path?

- Sources examined: `lock_unpoisoned` usage at `:1713`, `:1719`.
- Findings: poison is bypassed, not propagated; the signal still fires.
- Conclusion: resolved with answer — no.
