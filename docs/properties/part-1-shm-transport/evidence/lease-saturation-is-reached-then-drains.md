# lease-saturation-is-reached-then-drains

## Citation refresh, 2026-08-31 (eventfd rewrite)

PR #131 (merge `5d638e3e8`) replaced the polling wake mechanism with sparse
eventfd doorbells and moved every cited `ring.rs` line. All citations below
were re-verified against HEAD. The situation and the marker are unchanged; the
drain half gains a wake step, noted where it matters.

## Discovery trigger

`receive-resumes-when-lease-capacity-clears` is only meaningful if the lease set ever
actually fills while frames are waiting. In the shipped host that never happens: the
endpoint loop holds at most one of eight leases and releases it before returning. So a
recovery property written against lease saturation would pass forever in the
configuration that ships, testing nothing. This record makes the precondition a
first-class obligation instead of an assumption buried in another record's enabling
state.

## Evidence trail

- The situation has two independent halves, and the first gate reads only the first of
  them. `crates/mc-shm-transport/src/backend/ring.rs:1063-1068` returns `Ok(None)` on
  `active >= self.grant.max_leases` **before** reading `consumed` or `published`, so
  "every lease is out" is decided without reference to whether anything is queued.
  Frames queued behind it are counted separately, in `SLOT_PUBLISHED`
  (`ring.rs:1284-1293`).
- The counter that reaches the cap: incremented at `ring.rs:1117`
  (`active_leases.fetch_add(1, Relaxed)`) as part of the same block that stores
  `SLOT_RECEIVER_LEASED` and advances `consumed` (`:1115-1117`); decremented only at
  `ring.rs:1234` (`fetch_sub(1, Relaxed)`) inside `release`, after the
  `SLOT_RECEIVER_LEASED → SLOT_RELEASE_PENDING` compare-exchange at `:1212-1219`.
- The drain half reaches the ring through `crates/mc-shm-transport/src/lease.rs:184-190`
  `release_once`, from either the explicit `release()` (`:160-161`) or `Drop`
  (`:203-204`). Either path decrements once, guarded by the local `released` flag.
  New with the eventfd mechanism: the same `release` then signals both the
  `capacity_ready` and `data_ready` doorbells (`ring.rs:1236-1241`), so a consumer
  parked in `wait_for_data` during saturation is woken into the drained state
  rather than observing it on a later poll.
- Observability. Both halves are visible in one `conservation()` snapshot
  (`ring.rs:1250-1333`): `descriptors.receiver_leased` for the held set
  (`:1304-1313`) and `descriptors.published` for the queued backlog (`:1284-1293`).
  The marker therefore needs no new instrumentation, only a snapshot at the moment
  of the `Ok(None)`.
- Where it is reachable today: only `lease_limited_profile()`
  (`crates/mc-shm-transport/tests/ring.rs:22-34`) with `max_leases: 1` and
  `descriptor_depth: 2`, used by
  `lease_limit_reports_backpressure_then_recovers_after_release` (`:272-286`). That
  test does construct saturation and does drain it, so the situation is reached once,
  in one synthetic profile, with a cap of one.
- Where it is not reachable: the shipped host. `max_leases` is `MC_HOST_RING_DEPTH`,
  which is 8 (`crates/mc-shm-transport/src/profile.rs:652`, `:655-670`), and
  `receive_one` acquires at most one lease per call and releases it on every path —
  the oversized-control rejection
  (`crates/mc-host/src/ring_transport.rs:507-509`), the normal path (`:546-548`),
  and `Drop` on every error return. One of eight cannot saturate.
- Why a marker rather than a trusted precondition: `max_leases: 1` collapses "at the
  cap" and "one lease held" into the same observation, so a campaign can believe it
  reached saturation while only ever having reached "a lease exists". A cap above one is
  what makes the situation distinct, and nothing today constructs one.

## Failure scenario

For a coverage record this section states what it means if the situation never occurs.

If `shm_lease_saturation_observed_then_drained` never fires, then
`receive-resumes-when-lease-capacity-clears` is vacuous: the saturation gate at
`ring.rs:1063` was never taken with a frame pending, so no assertion about resuming
after saturation was ever evaluated. Its check semantics are `always-or-unreached`
precisely because of this, and an unreached verdict is only honest if something
reports the unreachedness. Without the marker the campaign reports a pass, and the
pass means the gate returned `Ok(None)` for the *other* reason — an empty ring —
which is the exact ambiguity that made the existing test's `is_none()` assertion
weak in the first place. Under the eventfd mechanism the unreached state also hides
a wake path: a saturated ring is exactly the state in which `data_available`
(`ring.rs:1160-1172`) parks a `wait_for_data` consumer, so a campaign that never
saturates also never exercises the release-signals-parked-waiter edge
(`:1236-1241`) under lease pressure.

A never-fired marker also carries a second, larger message worth reading rather than
suppressing: the shipped host configuration cannot exercise lease backpressure at all.
That is a statement about the deployment, not a defect. It says the eight-lease cap and
the lease-release machinery under it are dead weight in the current topology, and it
tells a reviewer that any confidence in lease backpressure comes from a profile with a
cap of one and a depth of two, not from the profile the host uses.

## Timing windows and dependencies

No race window, because the counter is incremented and decremented by the same
thread-confined receiver and read `Relaxed` at `:1062`. The situation is a state, and
both halves are observable in a single snapshot. The ordering that matters is between
the two halves: the backlog must exist **while** the cap is held, so the snapshot must
be taken at the `Ok(None)`, not before the last acquire and not after the first release.
Taken too early, `descriptors.published` counts frames that will be acquired into the
leased set; taken too late, the cap is already cleared. Dependencies: a profile whose
`max_leases` is small enough to reach and strictly greater than one, and at least one
frame published beyond the leased set, which requires `descriptor_depth > max_leases` so
the extra publication has a slot. `lease_limited_profile()` satisfies the second with
depth 2 and cap 1 but fails the first, so a new profile is required rather than a reuse.

## What a test must construct

Acquire leases until `active_leases == max_leases` against a profile with a cap of at
least two, with at least one further frame published and unacquired, then observe
`try_receive() == Ok(None)`, then release. Emit the marker
`shm_lease_saturation_observed_then_drained` at the point where a single
`conservation()` snapshot shows `descriptors.receiver_leased == max_leases` **and**
`descriptors.published >= 1`, and where a later snapshot after release shows
`receiver_leased < max_leases`. Both facts in the first snapshot are legal on a correct
system — the comment at `ring.rs:1064-1067` states that a full lease set is
backpressure rather than a fault — and the second snapshot is ordinary progress, so the
marker fires on a correct implementation and never requires a defect. It is not the
negation of any `always` check in this catalog: the violation it pairs with,
"receive never resumes", is a distinct predicate and is not asserted here.

This refines `shm_lease_set_saturated`, already declared in `fault-map.md` as "every
receive lease was held simultaneously". The refinement is deliberate. Saturation alone
does not witness that anything was waiting, and a saturation event with an empty ring
would still leave the recovery property untested. The name is kept distinct so the two
are not conflated, and `shm_lease_set_saturated` should be treated as superseded by it
rather than emitted alongside it.

## Investigation log

### Q: Is lease saturation reachable in any shipped configuration, and is a cap of one sufficient to witness it?

- Sources examined: `ring.rs:766-846`, `:848-911`, `:913-997`; `lease.rs:170-221`;
  `crates/mc-host/src/ring_transport.rs:32`, `:41-58`, `:455-534`;
  `tests/ring.rs:28-55`,
  `:278-293`.
- Findings: not reachable in the shipped host, for a structural reason rather than a
  tuning one — `receive_one` is written to hold exactly one lease for the duration of one
  call. A cap of one is not sufficient to witness the situation, because at that cap
  "saturated" and "one lease held" are the same observation, and the interesting
  behaviour of the gate at `:772` is a comparison against a bound greater than one. Both
  halves of the situation are observable through `conservation()` without new
  instrumentation, which makes the marker cheap.
- Missing evidence: whether the addon receive path can saturate. It retains leases
  deliberately — `poll` forgets the lease and completes through the addon's own identity
  table, per the reachability analysis in
  `release-authority-bound-to-lease-ownership` — so it is the one shipped consumer that
  plausibly reaches the cap. That path was not traced end to end and is recorded as an
  open question rather than claimed.
- Conclusion: resolved with answer — the situation is reachable only synthetically
  today, a cap above one is required for the marker to mean anything, and the marker's
  most valuable outcome may be never firing, because that reports a shipped topology in
  which lease backpressure is unexercised.

### 2026-08-31: re-derivation against the eventfd doorbell mechanism

- Sources examined: `crates/mc-shm-transport/src/backend/ring.rs:1055-1075`,
  `:1115-1117`, `:1160-1172`, `:1212-1241`, `:1250-1333`;
  `crates/mc-shm-transport/src/lease.rs:160-204`;
  `crates/mc-host/src/ring_transport.rs:496-548`;
  `crates/mc-shm-transport/src/profile.rs:652-670`;
  `crates/mc-shm-transport/tests/ring.rs:22-34`, `:272-286`.
- Findings: the situation, both observable halves, the `sometimes` semantics, and
  the shipped-host unreachability finding all survive PR #131; only line numbers
  moved. The former `DESCRIPTOR_DEPTH` constant in `ring_transport.rs` is gone;
  the depth-and-lease bound now comes from `MC_HOST_RING_DEPTH` in
  `profile.rs:652`. The drain half gained a mechanism note: the pre-eventfd
  argument was that the caller polls again after the release; at HEAD the release
  signals both doorbells, so a parked `wait_for_data` waiter is woken sparsely,
  and a saturated ring is precisely the state that parks such a waiter. That
  does not change this record's marker, which is state-based, but it is the
  reason the paired recovery record now carries a separate wake arm.
- Missing evidence: unchanged — the addon lease-retention path remains untraced.
- Conclusion: resolved with answer — the record survives with citations
  re-anchored; no semantic change to the marker.
