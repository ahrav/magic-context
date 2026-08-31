# receive-resumes-when-lease-capacity-clears

## Discovery trigger

`try_receive` returns `Ok(None)` for two structurally different reasons and carries no
way to tell them apart. One means "every lease is out, frames are waiting"; the other
means "there is nothing here". The existing lease-limit test asserts only
`is_none()`, so its oracle is satisfied by either. That is the exact shape the
portfolio evaluation flagged: an assertion that cannot distinguish backpressure from
emptiness cannot prove that saturation ends.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:773-779` — the saturation gate. It
  loads `active_leases` and returns `Ok(None)` when `active >= self.grant.max_leases`,
  **before** reading `consumed` or `published`. The comment at `:775-777` states the
  intent: a full lease set is backpressure, not a fault, and published frames stay
  queued until a lease is released and the caller polls again.
- `ring.rs:781-786` — the emptiness gate. It loads `consumed` and `published` and
  returns `Ok(None)` when they are equal. Same return value, unrelated cause, and
  reached only when the first gate did not fire.
- `ring.rs:825-828` — the lease accounting the first gate reads:
  `state = SLOT_RECEIVER_LEASED`, `consumed = sequence` with `Release`, and
  `active_leases.fetch_add(1, Relaxed)`. The counter lives on the consumer page and is
  touched only by the receiver.
- `ring.rs:904-908` — the only decrement: `release` stores `completion_sequence` with
  `Release`, then `active_leases.fetch_sub(1, Relaxed)`. It runs after the
  `SLOT_RECEIVER_LEASED → SLOT_RELEASE_PENDING` compare-exchange at `:886-893`, so a
  duplicate release cannot decrement twice.
- `crates/mc-shm-transport/src/lease.rs:173-175`, `:198-206`, `:215-221` — release
  reaches the ring through `release_once`, guarded by a local `released` flag, from
  either the explicit `release()` or `Drop`. Either path clears one lease.
- The available witness for "frames were queued": `ring.rs:913-997` `conservation()`
  counts each slot by state, including `SLOT_PUBLISHED` into `descriptors.published`
  (`:948-957`) and `SLOT_RECEIVER_LEASED` into `descriptors.receiver_leased`
  (`:968-977`). So `published >= 1` at the moment of the `None` is observable, which is
  precisely the fact the current test does not check. Caveat carried from
  `reservation-charge-visible-with-non-free-state`: `conservation()` may be test-only,
  and its `bytes.free` is derived rather than observed (`:991-995`).
- Existing check: `lease_limit_reports_backpressure_then_recovers_after_release`
  (`crates/mc-shm-transport/tests/ring.rs:278-293`), against
  `lease_limited_profile()` with `descriptor_depth: 2` and `max_leases: 1`
  (`tests/ring.rs:28-55`). It publishes two frames, takes one lease, asserts
  `ring.try_receive().unwrap().is_none()` (`:285-288`), releases, and asserts the next
  receive yields the byte `2` (`:290-291`). The recovery half is real. The saturation
  half is not: at that assertion nothing pins that a frame was pending, so an
  implementation that had lost the second publication entirely would satisfy it up to
  the recovery line.
- The shipped host cannot reach saturation at all. `receive_one` acquires at most one
  lease per call and releases it before returning, on every path: the oversized-control
  rejection at `crates/mc-host/src/ring_transport.rs:475-477`, the normal path at
  `:604-609`, and `Drop` on every error return. `max_leases` is `DESCRIPTOR_DEPTH`,
  which is 8 (`ring_transport.rs:32`, `:47-50`), so the endpoint loop holds at most one
  of eight. Saturation is reachable only through a synthetic profile or a caller that
  retains leases.

## Failure scenario

1. A receiver holds `max_leases` leases while the producer has published further
   frames. Those frames sit in `SLOT_PUBLISHED` with `consumed < published`.
2. `try_receive` takes the gate at `:772` and returns `Ok(None)`. The caller sees the
   same value it would see on an idle channel.
3. The receiver releases a lease. `active_leases` drops below `max_leases` and
   `completion_sequence` is published for the released sequence.
4. A defect in the release path — the decrement missed, `release_once`'s flag
   inverted, or the gate comparison off by one in the closing direction — leaves
   `active_leases` at or above `max_leases` permanently.
5. Every later `try_receive` returns `Ok(None)`. The channel is dead and its only
   signal is the value that also means "idle". In the host, `receive_one` returns
   `Ok(false)` (`ring_transport.rs:468-470`), the endpoint loop keeps polling
   (`:520-534`), no error is raised, no quarantine occurs, and no counter moves. This is
   the same silent-capacity-loss signature as
   `attach-reconciles-or-refuses-stale-shared-cursors`, reached without any crash.

## Timing windows and dependencies

There is no race window: the counter is incremented and decremented by the same
thread-confined receiver, both `Relaxed`, and read `Relaxed` at `:771`. The property is
about state, not ordering. The bounded fault-free window is therefore short and
exactly statable: once a release has returned `Ok`, the **next single** `try_receive`
must deliver, because both gates are pure reads of state the release already updated.
No polling, no sleep, no deadline. Cross-process changes nothing here, since
`active_leases` is receiver-local. Dependencies: saturation must be constructed with a
profile whose `max_leases` is small enough to reach, and at least one frame must be
published beyond the leased set, or the second gate fires first and the test proves
nothing about the first. The reachability caveat above is a dependency on the
configuration, not on timing: in the shipped host topology this window never opens.

## What a test must construct

Saturation with a witnessed backlog, then a single-call recovery assertion. Extend the
existing test rather than replacing it. At the moment of the `None`, assert
`conservation()` reports `descriptors.receiver_leased == max_leases` and
`descriptors.published >= 1`. That converts `is_none()` from an ambiguous value into a
statement about a specific state, and it is the assertion that distinguishes saturation
from an empty ring. Then release exactly one lease and assert that the immediately
following `try_receive` returns `Some`, that its identity's sequence equals the
pre-saturation `consumed + 1`, and that its body equals the frame that was pending — so
recovery cannot be satisfied by delivering some other frame or by skipping one. Assert
`active_leases` is back to `max_leases - 1` by way of
`descriptors.receiver_leased`. Add a multi-lease arm, since `max_leases: 1` makes
"below the cap" and "zero" the same number and hides an off-by-one: with
`max_leases: 4`, take four, assert `None`, release one, assert exactly one further
receive succeeds and the next returns `None` again. Coverage check to emit:
`shm_lease_saturation_observed_then_drained`, which is the situation record
`lease-saturation-is-reached-then-drains` and is what keeps this property from passing
vacuously in a configuration that can never saturate.

## Investigation log

### Q: Can the two `Ok(None)` causes be distinguished by any current caller, and is saturation reachable in the shipped topology?

- Sources examined: `ring.rs:766-846`, `:848-911`, `:913-997`; `lease.rs:170-221`;
  `crates/mc-host/src/ring_transport.rs:32`, `:41-58`, `:455-534`, `:378-452`;
  `tests/ring.rs:28-55`, `:278-293`.
- Findings: no caller can distinguish the two causes from the return value; the only
  distinguishing evidence is `conservation()`, and no existing test uses it at the
  point of a `None`. Saturation is reachable in-crate only through
  `lease_limited_profile()`. In the host, `receive_one` holds at most one of eight
  leases and always releases before returning, so the first gate cannot fire. That
  makes the property conditional in the shipped configuration, and it is why the check
  semantics are `always-or-unreached` rather than `always`: the obligation is real, and
  the situation must be constructed rather than assumed.
- Missing evidence: whether any intended consumer retains leases across calls. The
  addon does exactly that — `poll` forgets the lease and tracks the identity in its own
  table, per the reachability analysis in `release-authority-bound-to-lease-ownership` —
  which suggests the addon path can saturate where the Rust host cannot. That path was
  not traced end to end here and is left as an open question rather than asserted.
- Conclusion: resolved with answer — the gap in the existing oracle is exactly the
  missing "a frame was pending" fact, the fix is a state assertion at the `None` plus a
  single-call recovery assertion, and the reachability finding changes the semantics to
  `always-or-unreached` and makes the coverage marker mandatory.
