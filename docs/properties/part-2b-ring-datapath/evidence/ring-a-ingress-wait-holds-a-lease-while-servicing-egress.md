# ring-a-ingress-wait-holds-a-lease-while-servicing-egress

## Discovery trigger

The METHOD contract requires at least one `sometimes` situation-coverage record
per lens, and mapping the inbound lifecycle produced an obvious candidate: the
one place on the host path where a shared-memory lease is held across a
potentially long wait. `receive_one` takes a lease at
`crates/mc-host/src/ring_transport.rs:464` and does not release it until `:524`,
with an ingress-budget retry loop in between that can run for the whole
`frame_deadline`. That loop's comments describe two interacting mechanisms whose
joint state nothing appears to construct.

## Evidence trail

**The lease is live across the whole wait.** Bound at `:464-470`, released at
`:522-524`. Between them:

```
// ring_transport.rs:487-518
let deadline = StdInstant::now() + frame_deadline;
let charge = loop {
    if let Some(charge) = ingress.try_charge(header.len as usize) {
        break charge;
    }
    if read_cancel.is_cancelled() {
        return Err(ReadClose::Cancelled);
    }
    if StdInstant::now() >= deadline {
        // The peer and transport are healthy; only the ingress budget is
        // saturated. Overloaded retires the generation without branding
        // it corrupt, so the admission charge releases cleanly.
        return Err(ReadClose::Overloaded);
    }
    // The budget wait services queued outbound frames: a slow ingress
    // drain holds only this receive, not the connection's sends, which
    // would otherwise miss their deadlines behind it.
    match queue.try_recv() {
        Ok(queued) => {
            if publish_one(&rings.first, queued, frame_deadline, publish_hook).is_err() {
                return Err(ReadClose::Corrupt("shared-memory publish failed"));
            }
        }
        Err(_) => {
            tokio::select! {
                biased;
                () = read_cancel.cancelled() => return Err(ReadClose::Cancelled),
                () = tokio::time::sleep(POLL_INTERVAL) => {}
            }
        }
    }
};
```

**The lease budget.** `max_leases: DESCRIPTOR_DEPTH` (`:50`) and
`DESCRIPTOR_DEPTH: usize = 8` (`:32`). `ring_profile_pins_per_connection_grant_geometry`
(`:821-827`) asserts both are 8.

**How the ring reports saturation.** `Ring::try_receive`
(`crates/mc-shm-transport/src/backend/ring.rs:766-778`):

```
let active = unsafe { (*consumer).active_leases.load(Ordering::Relaxed) };
if active >= self.grant.max_leases {
    // A full lease set is backpressure, not a fault: published
    // frames stay queued until a lease is released and the caller
    // polls again.
    return Ok(None);
}
```

`Ok(None)` is the same value the ring returns when it is genuinely empty
(`ring.rs:783-785`, `if consumed == published { return Ok(None); }`).
`receive_one` collapses both to `Ok(false)` at `:468-470`, and `run_endpoint`
treats `Ok(false)` as an idle direction. So from the host's point of view "the
peer sent nothing" and "I have no lease slots left" are the same observation.

**Two budgets at different scopes.** The ingress budget is process-wide: a single
`ByteBudget` constructed once at `runtime.rs:896-902` from
`config.limits.max_resident_bytes` minus the egress reservation, the scratch
reservation, the catalog resident bytes, and the retained reservations. It is
cloned into every connection at `connection.rs:144`. `max_leases` is
per-connection, fixed by the profile. So a lease held for a process-wide reason
consumes a per-connection slot, and pressure originating in an unrelated part of
the host — Synapse parse scratch draws on a separate reserved slice per
`docs/mc-host-wire-protocol.md:423`, but the general pool is shared — can drive
one connection's peer into lease saturation.

**Why the preconditions are independent.** The check asserts them jointly, which
is what makes it a coverage check rather than a violation assertion. Three were
drafted; the second turned out to be unreachable and was dropped, and the
reasoning is kept here because it is the load-bearing finding of this record:

1. `receive_one` is inside the loop at `:488-518`. Reached whenever
   `try_charge` fails once.
2. `active_leases == max_leases` on the peer-to-host consumer page. Requires the
   peer to have published at least eight frames that the host has leased and not
   released. Since `receive_one` is single-threaded and releases before
   returning, the host holds at most one lease at a time — so this precondition
   is about the *peer's* view of the host's consumer page, which counts only the
   host's outstanding leases.
3. At least one outbound frame published from inside the wait, at `:504-509`.
   Requires a queued outbound frame at the moment the loop polls.

Precondition 2 needs care, and reading it closely changes the record's shape.
`active_leases` is incremented at `ring.rs:828` when a lease is issued and
decremented on release. `receive_one` holds exactly one lease and releases it
before returning `Ok(true)`, and `run_endpoint` calls `receive_one` serially. So
`active_leases` on the peer-to-host direction never exceeds **one** on the host
side. The eight-slot budget is therefore never approached by the host's own
consumption.

That means precondition 2 as first stated is unreachable, and the honest version
of the record drops it. What remains reachable and worth covering is
preconditions 1 and 3 jointly: a lease held across a saturated ingress budget
while the loop publishes outbound frames. That is the state the two comments at
`:496-499` and `:501-503` describe, and it is the state that exercises the
`Overloaded` exit, the outbound-servicing interleave, and the lease's long hold
together.

## Failure scenario

Not a violation; an untested operational state. If it is never reached, three
mechanisms are never exercised together:

- The `Overloaded` exit at `:495-500`, whose `ReadClose::Overloaded` doc
  (`frame_channel.rs:40-43`) asserts "the peer and the transport are healthy, so
  retirement is clean backpressure, not a structural fault". Under a held lease
  and a quarantined ring that assertion is false, which is the subject of
  `ring-a-lease-release-failure-is-observable-only-on-the-success-path`.
- The outbound-servicing interleave at `:504-509`, which the comment at
  `:501-503` says prevents the connection's sends from missing their deadlines
  behind a slow ingress drain. If it never runs under real pressure, the claim is
  unverified. Note that this is the site whose publish failure produces
  `ReadClose::Corrupt` while the main loop's produces `CleanEof` — the asymmetry
  in `ring-a-publish-failure-is-reported-as-a-clean-peer-close`, and reaching this
  state is what makes that asymmetry observable.
- The lease's long hold itself, which is the longest any host code holds a
  reference into shared storage, and therefore the widest window for Part 1's
  `quarantine-authority-survives-peer-writes` scenario.

## Timing windows and dependencies

Window: up to `frame_deadline`, the connection's per-frame timing budget
(`connection.rs:146`, `shared.timing.frame_deadline`, passed into `prepare` at
`:148` and thence to `run_endpoint` at `ring_transport.rs:284-285`). The loop
polls every `POLL_INTERVAL` (`:33`, 50 microseconds) when no outbound frame is
queued, so the wait is a busy-ish poll rather than a park.

Dependencies:

- `ring-a-lease-release-failure-is-observable-only-on-the-success-path` cannot be
  falsified until this state is reached, because its three untracked returns are
  exactly the ones inside this loop.
- `ring-a-publish-failure-is-reported-as-a-clean-peer-close` needs this state to
  observe its `Corrupt`-versus-`CleanEof` asymmetry.
- Part 1 holds `lease-saturation-is-reached-then-drains`,
  `receive-resumes-when-lease-capacity-clears`, and
  `backpressure-converges-in-a-bounded-reclaim-window` at the transport layer,
  all marked `Reaches production: no` when written. None covers the host's held
  lease across an ingress wait.

## What a test must construct

Preconditions, all three asserted jointly so the marker fires on a correct
implementation:

1. `try_charge` fails for the frame in hand. `ByteBudget::new(0)` already does
   this in `budget_wait_observes_read_cancellation`
   (`ring_transport.rs:949`), and a nonzero-but-too-small budget is the more
   realistic form. `RingFactory` exposes it as `cfg.budget_bytes`
   (`frame_channel/contract_tests.rs:499`).
2. At least one queued outbound frame at the moment the loop polls, so
   `:504-509` runs. `frame_sender(1, ..)` plus one `send_ticket_before` before
   entering `receive_one` supplies it. The inline tests already build the
   sender-queue pair this way (`:908-909`, `:944-945`).
3. The loop iterates at least twice, so the `POLL_INTERVAL` sleep at `:514` is
   exercised as well as the publish branch. Achieved by queueing exactly one
   outbound frame and letting the second iteration find the queue empty.

Then release budget and assert the frame is delivered with
`copy_counter().copies() == 1`, so the success exit is covered too, rather than
only the `Overloaded` exit.

The two existing inline tests are each one precondition short.
`copied_control_frame_records_one_host_adapter_copy` (`:881-926`) uses
`ByteBudget::new(1024)` (`:915`) so the loop is never entered.
`budget_wait_observes_read_cancellation` (`:928-965`) uses
`ByteBudget::new(0)` (`:949`) and does enter the loop, but its
`frame_sender(1, ..)` queue is empty (`:944-945`), so `:504-509` never runs and
the test exits through cancellation rather than through the publish branch or the
success path. Combining them is a small change to an existing test.

Neither runs in CI, since every `-p mc-host` invocation in `ci.yml` filters to an
integration binary.

## Investigation log

### Q: Can the host's own consumption reach `active_leases == max_leases`?

- Sources examined: `ring.rs:766-778` (the saturation check and its comment),
  `ring.rs:828` (`active_leases.fetch_add`), `lease.rs:198-221`
  (`release_once` and `Drop`, which is where the decrement happens via the
  callback), `ring_transport.rs:455-534` (`receive_one`, which holds exactly one
  lease and releases or drops it on every return path),
  `ring_transport.rs:378-452` (`run_endpoint`, which calls `receive_one`
  serially).
- Findings: no. `receive_one` holds at most one lease at a time and every one of
  its nine return points either releases explicitly (`:477`, `:524`) or drops the
  lease (`:493`, `:499`, `:513`, `:521`), and `Drop` releases. `run_endpoint`
  never has two `receive_one` calls in flight. So the host's contribution to
  `active_leases` is bounded by one, and the eight-slot budget exists for a
  consumer that leases concurrently — which the peer side does not do either,
  since `RingClientEndpoint::try_recv_with` (`:694-709`) also holds one at a
  time.
- Missing evidence: whether any consumer in the system leases concurrently.
  `packages/mc-shm-native/src/lib.rs:312` releases `active.identity`, suggesting a
  single-active model there too, but that file is Part 1 scope and I did not read
  it.
- Conclusion: resolved with answer, and it changed the record. The eight-lease
  saturation precondition is unreachable from the host, so I dropped it from the
  check rather than writing a coverage marker that can never fire. The record was
  renamed from `ring-a-lease-saturation-coincides-with-a-held-ingress-wait` to
  `ring-a-ingress-wait-holds-a-lease-while-servicing-egress` and its `Check:`
  narrowed to preconditions 1 and 3, with the dropped clause stated in the
  record's `Fault/timing angle:` rather than deleted. Recorded here rather than
  silently reworded, per the method's rule against restating an unconfirmed claim
  as fact.

### Q: Should `receive_one` distinguish "ring empty" from "leases saturated"?

- Sources examined: `ring.rs:770-778` (saturation returns `Ok(None)`),
  `ring.rs:783-785` (empty returns `Ok(None)`), `ring_transport.rs:464-470`
  (both collapse to `Ok(false)`), `ring_transport.rs:392-399` (what
  `run_endpoint` does with `Ok(false)`: nothing but check `read_cancel`).
- Findings: given the previous answer, the distinction is currently moot for the
  host, because the host can never be lease-saturated. It would matter for a
  consumer that leases concurrently, and it would matter for diagnostics if the
  host ever grew one. So this is a latent API gap, not a live one.
- Missing evidence: none needed.
- Conclusion: resolved. The question is real but its priority is low, and the
  answer is that the collapse is harmless under the current single-active-lease
  design. Downgraded from the concern it looked like on first reading.
