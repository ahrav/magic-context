# ring-a-ingress-wait-holds-a-lease-while-servicing-egress

Re-derived 2026-08-31 against the eventfd transport (PR #131, merge
`5d638e3e8`). The polling-era evidence quoted a `try_charge` retry loop with a
`tokio::time::sleep(POLL_INTERVAL)` arm; that loop and the constant no longer
exist (`ring_transport.rs:798-806` asserts the constant's absence), and every
line reference below was re-verified at HEAD `ec0f1bbe1`. The polling-era
derivation is retained in the investigation log's history note.

## Discovery trigger

The METHOD contract requires at least one `sometimes` situation-coverage
record per lens, and mapping the inbound lifecycle produced an obvious
candidate: the one place on the host path where a shared-memory lease is held
across a potentially long wait. `receive_one` takes a lease at
`crates/mc-host/src/ring_transport.rs:496-501` and does not release it until
`:546-548`, with an ingress-charge wait in between that can run for the whole
`frame_deadline`. That wait services queued outbound frames while it parks,
and the joint state — lease held, budget saturated, egress published from
inside the wait — is what nothing constructs.

## Evidence trail

**The lease is live across the whole wait.** Bound at `:496-501`, released at
`:546-548`. Between them (`ring_transport.rs:519-542`):

```
let deadline = Instant::now() + frame_deadline;
let charge = ingress.charge(header.len);
tokio::pin!(charge);
let charge = loop {
    tokio::select! {
        biased;
        () = read_cancel.cancelled() => return Err(ReadClose::Cancelled),
        charge = &mut charge => break charge,
        () = tokio::time::sleep_until(deadline) => {
            // The peer and transport are healthy; only the ingress budget is
            // saturated. Overloaded retires the generation without branding
            // it corrupt, so the admission charge releases cleanly.
            return Err(ReadClose::Overloaded);
        }
        queued = queue.recv() => match queued {
            Some(queued) => {
                if publish_one(&rings.first, queued, frame_deadline, publish_hook).is_err() {
                    return Err(ReadClose::Corrupt("shared-memory publish failed"));
                }
            }
            None => return Err(ReadClose::Cancelled),
        }
    }
};
```

Post-#131 the wait parks instead of polling: `ByteBudget::charge`
(`crates/mc-host/src/wire.rs:397-407`) is `acquire_many_owned` on a tokio
semaphore, so the future queues and resolves when another holder's
`ByteCharge` drops its permits. Egress servicing is likewise event-driven —
`queue.recv()` is an async receive, not the polling-era `try_recv` — so an
outbound frame queued at any point during the wait is published from inside
it (`:533-540`).

**The lease budget.** Eight, pinned by the profile rather than by file-local
constants post-#131: `ring_profile_pins_per_connection_grant_geometry`
(`ring_transport.rs:901-907`) asserts `profile.descriptor_depth() == 8` and
`profile.max_leases() == 8` (`:903-904`).

**How the ring reports saturation.** `Ring::try_receive`
(`crates/mc-shm-transport/src/backend/ring.rs:1055-1074`):

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
(`ring.rs:1073-1074`, `if consumed == published { return Ok(None); }`).
`receive_one` collapses both to `Ok(false)` at `:500-501`, and `run_endpoint`
treats `Ok(false)` as an idle direction. So from the host's point of view
"the peer sent nothing" and "I have no lease slots left" are the same
observation.

**Two budgets at different scopes.** The ingress budget is process-wide: a
single `ByteBudget` constructed once at `runtime.rs:761-767` from
`config.limits.max_resident_bytes` minus the egress reservation, the scratch
reservation, the catalog resident bytes, and the retained reservations. It is
cloned into every connection at `connection.rs:113`. `max_leases` is
per-connection, fixed by the profile. So a lease held for a process-wide
reason consumes a per-connection slot, and pressure originating in an
unrelated part of the host can drive one connection's peer into lease
saturation.

**Why the preconditions are independent.** The check asserts them jointly,
which is what makes it a coverage check rather than a violation assertion.
Three were drafted in the polling era; the second turned out to be unreachable
and was dropped, and the reasoning is kept because it is the load-bearing
finding of this record:

1. The `charge` future is pending. Reached whenever the semaphore cannot
   supply `header.len` permits immediately.
2. `active_leases == max_leases` on the peer-to-host consumer page. **Dropped
   as unreachable.** `receive_one` is single-threaded, holds at most one lease
   at a time, and releases or drops it on every return path, and
   `run_endpoint` calls `receive_one` serially (`:386-397`), so the host's
   contribution to `active_leases` is bounded by one against a budget of
   eight.
3. At least one outbound frame published from inside the wait, at `:533-540`.
   Requires a frame on the sender queue while the charge is pending; post-#131
   the `queue.recv()` arm makes this an arrival, not a poll coincidence.

A polling-era sub-precondition — a second loop iteration with an empty queue,
to cover the `POLL_INTERVAL` sleep — has no post-#131 counterpart and is
withdrawn; there is no sleep arm left to cover. The resume path worth covering
instead is the charge future waking when another holder's `ByteCharge` drops.

## Failure scenario

Not a violation; an untested operational state. If it is never reached, three
mechanisms are never exercised together:

- The `Overloaded` exit at `:527-532`, whose `ReadClose::Overloaded` doc
  (`frame_channel.rs:40-43`) asserts "the peer and the transport are healthy,
  so retirement is clean backpressure, not a structural fault". Under a held
  lease and a quarantined ring that assertion is false, which is the subject
  of `ring-a-lease-release-failure-is-observable-only-on-the-success-path`.
- The outbound-servicing arm at `:533-540`. The polling-era comment that
  justified it ("a slow ingress drain holds only this receive, not the
  connection's sends") was removed with the rewrite; the surviving statement
  of the same intent is `run_endpoint`'s alternation comment at `:416-420`.
  If the arm never runs under real pressure, the claim is unverified. Note
  that this is the site whose publish failure produces `ReadClose::Corrupt`
  (`:536`) while the main loop's produces `CleanEof` — the asymmetry in
  `ring-a-publish-failure-is-reported-as-a-clean-peer-close` — and reaching
  this state is what makes that asymmetry observable.
- The lease's long hold itself, which is the longest any host code holds a
  reference into shared storage, and therefore the widest window for Part 1's
  `quarantine-authority-survives-peer-writes` scenario.

**New with #131: the wait is also a wake dependency.** In the polling era the
wait made progress on its own clock; now it resolves only when (a) a
`ByteCharge` drop wakes the semaphore queue, (b) an outbound frame arrives,
(c) `read_cancel` fires, or (d) the deadline expires. A lost semaphore wake is
foreclosed by tokio's semaphore (permits released on drop wake the queued
acquire), but the *shape* changed: a stall here now presents as a silent park
that ends in `Overloaded` at the deadline rather than as visible spinning,
so the `Overloaded` exit is also the backstop for any wake defect in this
select, and a campaign that never constructs the state never exercises that
backstop.

## Timing windows and dependencies

Window: up to `frame_deadline`, the connection's per-frame timing budget,
passed into `prepare` (`ring_transport.rs:217-221`) and thence to
`run_endpoint`. The absolute deadline is taken once at `:519`; the wait parks
between wakes rather than polling.

Dependencies:

- `ring-a-lease-release-failure-is-observable-only-on-the-success-path` cannot
  be falsified until this state is reached, because its untracked drop-path
  returns are exactly the ones inside this wait (`:525`, `:531`, `:539`).
- `ring-a-publish-failure-is-reported-as-a-clean-peer-close` needs this state
  to observe its `Corrupt`-versus-`CleanEof` asymmetry.
- Part 1 holds `lease-saturation-is-reached-then-drains`,
  `receive-resumes-when-lease-capacity-clears`, and
  `backpressure-converges-in-a-bounded-reclaim-window` at the transport layer,
  all marked `Reaches production: no` when written. None covers the host's
  held lease across an ingress wait.

## What a test must construct

Preconditions, asserted jointly so the marker fires on a correct
implementation:

1. The `charge` future pends for the frame in hand. `ByteBudget::new(0)`
   already does this in `budget_wait_observes_read_cancellation`
   (`ring_transport.rs:1028`), and a nonzero-but-too-small budget is the more
   realistic form.
2. At least one outbound frame queued while the charge pends, so `:533-540`
   runs. `frame_sender(1, ..)` plus one queued frame before entering
   `receive_one` supplies it; the inline tests already build the sender-queue
   pair this way (`:988`, `:1023-1024`).
3. A budget release that lets the charge resolve, so the success exit is
   covered too: release the held `ByteCharge`, then assert the frame is
   delivered with `copy_counter().copies() == 1`, rather than covering only
   the `Overloaded` exit.

The two existing inline tests are each one precondition short.
`copied_control_frame_records_one_host_adapter_copy` (`:961-1005`) uses
`ByteBudget::new(1024)` (`:994`), so the charge resolves immediately and the
wait is never entered. `budget_wait_observes_read_cancellation`
(`:1008-1043`) uses `ByteBudget::new(0)` (`:1028`) and does park in the wait,
but its sender queue is empty (`:1023-1026`), so `:533-540` never runs and the
test exits through cancellation rather than through the publish arm or the
success path. Combining them is a small change to an existing test.

Neither runs in CI, since every `-p mc-host` invocation in `ci.yml` filters to
an integration binary.

## Investigation log

### 2026-08-31: eventfd reconciliation (PR #131)

- Sources examined: `ring_transport.rs:487-558` (`receive_one` at HEAD
  `ec0f1bbe1`), `:359-485` (`run_endpoint`), `:901-907` (the geometry test),
  `:961-1043` (the two inline tests), `wire.rs:379-425` (`ByteBudget`,
  `charge`, `try_charge`), `runtime.rs:761-767` (the budget construction),
  `connection.rs:113` (the per-connection clone).
- Findings: the `try_charge` poll loop is gone. The wait is now one biased
  `select!` (`:522-542`) over the pinned `charge` future, `read_cancel`, an
  absolute `sleep_until` deadline, and an async `queue.recv()`; egress
  servicing became event-driven and the `POLL_INTERVAL` sleep arm has no
  counterpart. The record's guarantee, `sometimes` semantics, and the two
  surviving preconditions transfer unchanged; the polling-era third
  sub-precondition (a second iteration covering the sleep) is withdrawn as
  objectless. The lease-hold window is unchanged in shape: bound at
  `:496-501`, released at `:546-548`, live across the whole wait.
- Missing evidence: none for the mechanics.
- Conclusion: resolved with answer — mechanism description and citations
  replaced; guarantee kept. History: the pre-#131 version of this file quoted
  the `try_charge` loop with its `tokio::time::sleep(POLL_INTERVAL)` arm
  (then-`:488-518`, publish branch then-`:504-509`, sleep then-`:514`,
  constant then-`:33`, 50 microseconds) and described the wait as "a busy-ish
  poll rather than a park"; all of that was true of `e447c927` and is
  preserved here as history rather than restated as fact.

### Q: Can the host's own consumption reach `active_leases == max_leases`?

- Sources examined (re-checked at HEAD): `ring.rs:1055-1074` (the saturation
  check and its comment), `ring.rs:1117` (`active_leases.fetch_add`),
  `ring_transport.rs:487-558` (`receive_one`, which holds exactly one lease
  and releases or drops it on every return path), `:386-397` (`run_endpoint`
  calls `receive_one` serially).
- Findings: no. `receive_one` holds at most one lease at a time and every
  return path either releases explicitly (`:509`, `:548`) or drops the lease
  (`:525`, `:531`, `:539`), and `Drop` releases. `run_endpoint` never has two
  `receive_one` calls in flight. So the host's contribution to `active_leases`
  is bounded by one, and the eight-slot budget exists for a consumer that
  leases concurrently — which the peer side does not do either, since
  `RingClientEndpoint::try_recv_with` (`:723-739`) also holds one at a time.
- Missing evidence: whether any consumer in the system leases concurrently.
  The native side is Part 1 scope and was not read in this pass.
- Conclusion: resolved with answer, and it changed the record. The eight-lease
  saturation precondition is unreachable from the host, so it was dropped from
  the check rather than writing a coverage marker that can never fire. The
  record was renamed from
  `ring-a-lease-saturation-coincides-with-a-held-ingress-wait` to
  `ring-a-ingress-wait-holds-a-lease-while-servicing-egress` and its `Check:`
  narrowed, with the dropped clause stated in the record's
  `Fault/timing angle:` rather than deleted. Recorded here rather than
  silently reworded, per the method's rule against restating an unconfirmed
  claim as fact.

### Q: Should `receive_one` distinguish "ring empty" from "leases saturated"?

- Sources examined (re-checked at HEAD): `ring.rs:1063-1068` (saturation
  returns `Ok(None)`), `ring.rs:1073-1074` (empty returns `Ok(None)`),
  `ring_transport.rs:496-501` (both collapse to `Ok(false)`), `:399-404`
  (what `run_endpoint` does with `Ok(false)`: check `read_cancel`, then arm
  the data wait).
- Findings: given the previous answer, the distinction is currently moot for
  the host, because the host can never be lease-saturated. It would matter for
  a consumer that leases concurrently, and it would matter for diagnostics if
  the host ever grew one. One post-#131 wrinkle: the collapse now also feeds
  `arm_data_wait`, whose `data_available` check is the transport's own view,
  so the two layers at least agree on what "nothing deliverable" means.
- Missing evidence: none needed.
- Conclusion: resolved. The question is real but its priority is low, and the
  answer is that the collapse is harmless under the current
  single-active-lease design. Downgraded from the concern it looked like on
  first reading.
