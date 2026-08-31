# ring-a-lease-release-failure-is-observable-only-on-the-success-path

## Discovery trigger

Part 1 holds `release-failure-is-observable` as a liveness record with `medium`
confidence, and its host-side anchor was `shm_provider.rs:365`, which the
refactor destroyed. Re-deriving the host side against `receive_one` shows the
surviving behaviour is not a single guarantee but an asymmetry: the two paths
that release explicitly report a failure, and the three that drop the lease
cannot.

## Evidence trail

**Where the lease is held.** `receive_one`
(`crates/mc-host/src/ring_transport.rs:455-534`) binds the lease at `:464-470`:

```
let Some(lease) = rings.second.try_receive()
    .map_err(|_| ReadClose::Corrupt("shared-memory receive failed"))?
else { return Ok(false); };
```

From `:464` the lease is live until it is either explicitly released or dropped.

**The two explicit releases, both of which report.**

Oversize channel-0 rejection, `:474-485`:

```
lease.release()
    .map_err(|_| ReadClose::Corrupt("shared-memory completion failed"))?;
```

Delivery path, `:522-524`: the identical form.

**The three returns that hold a lease and drop it.**

- `:492-494` — `read_cancel.is_cancelled()` inside the ingress-budget loop
  returns `Err(ReadClose::Cancelled)`.
- `:495-500` — the absolute frame deadline expires, returning
  `Err(ReadClose::Overloaded)`.
- `:511-515` — the inner `select!`'s `read_cancel.cancelled()` arm returns
  `Err(ReadClose::Cancelled)`.

All three return while `lease` is a live local, so `ReceiveLease`'s `Drop` runs.
`crates/mc-shm-transport/src/lease.rs:215-221`:

```
impl Drop for ReceiveLease<'_> {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.release_once();
        }
    }
}
```

The `let _ =` is the whole finding: the release does happen, and its `Result` is
discarded.

**Two further paths worth naming, both of which do report.** `:519-521`
(`lease.to_vec()` failure, mapped to
`ReadClose::Corrupt("shared-memory lease failed")`) and `:527-532`
(`inbound.send` failure, mapped to `ReadClose::Cancelled`). The second is after
the explicit release at `:524`, so no lease is live.

**What can make a release fail.** `Ring::release` (`ring.rs:849-880`, continuing
past the excerpt) returns `Err` on:

- quarantine — `ring.rs:850-851`, `LeaseError::Quarantined`;
- wrong incarnation — `:853-854`, and again at `:876-877` against the slot descriptor;
- wrong lane — `:856-857`, and again at `:879-880` against the descriptor;
- sequence zero — `:860-862`, `InvalidSequence`;
- sequence ahead of `consumed` — `:868-870`, `InvalidSequence`;
- duplicate release — `lease.rs:198-201`, `DuplicateRelease`, raised before the
  callback is even invoked.

Quarantine is the reachable one from a host's point of view, because
`Ring::try_receive` calls `enter_quarantine()` itself on descriptor-validation
failure (`ring.rs:803-812`).

**Why the untracked paths are the dangerous ones.** The lease slot budget is
`max_leases = DESCRIPTOR_DEPTH = 8` (`ring_transport.rs:32`, `:50`).
`try_receive` refuses to hand out a ninth lease and returns `Ok(None)`
(`ring.rs:770-778`), which `receive_one` returns as `Ok(false)`, which
`run_endpoint` treats as an idle direction. So eight silent release failures
convert the peer-to-host direction into a permanently idle-looking channel, and
the host has no signal distinguishing that from a quiet peer. That is the
mechanism behind the impact claim.

## Failure scenario

Concrete construction. Two frames in flight on the peer-to-host direction.

1. The peer publishes frame A with a valid descriptor, then frame B with a
   corrupt descriptor.
2. The host's `receive_one` takes a lease on A at `:464`. The ingress budget is
   saturated, so it enters the loop at `:488-518`.
3. Something else in the host frees budget slowly, so the loop keeps polling.
   Meanwhile nothing has yet touched B.
4. The frame deadline expires. `:495-500` returns
   `Err(ReadClose::Overloaded)`. The lease on A drops, `release_once` runs, and
   the ring is not quarantined yet, so it succeeds. No failure to hide.

To actually produce the failure, the quarantine must precede the drop, which
means step 2's lease must be held while a *different* receive path quarantines.
Since `receive_one` is single-threaded on the endpoint thread, the only way is
the peer writing the shared `quarantined` byte directly, which is exactly Part
1's `quarantine-authority-survives-peer-writes` scenario: the flag lives in
shared memory (`ring.rs:1033`) and every gate re-reads it, so a peer can set it
between the host's `try_receive` and the host's release.

So the reachable construction is: peer publishes a frame, host takes a lease and
enters the budget wait, peer sets the quarantine flag, host's deadline expires,
lease drops, `release_once` returns `Err(LeaseError::Quarantined)`, discarded.
The host reports `Overloaded`, which `connection.rs:404` maps to
`ReadExit::Peer`, a clean silent retirement. The lease slot is never returned,
but since the whole connection is retiring and the charge releases at
`ring_transport.rs:291` regardless, the immediate impact is bounded.

The unbounded version needs the release failure to occur without the connection
retiring, which none of the three untracked paths permit: all three return an
`Err(ReadClose::..)` that ends the read loop. So the strand is per-connection and
terminal, not cumulative across a connection's life.

That materially lowers the severity from the first reading, and it is worth
recording plainly rather than overstating: the asymmetry is real, and its worst
consequence is a lost diagnostic on a connection that is already retiring, plus
the loss of any signal that the ring was quarantined rather than merely
overloaded. The `Overloaded` versus `Corrupt` distinction matters because
`ReadClose::Overloaded`'s own doc comment (`frame_channel.rs:40-43`) asserts "the
peer and the transport are healthy, so retirement is clean backpressure, not a
structural fault". On this path the transport is quarantined, so that assertion
is false.

## Timing windows and dependencies

The window is `:464` to `:524`, which under a saturated ingress budget is up to
the connection's `frame_deadline`. That is the longest a lease is held anywhere on
the host path, and it is the same window as
`ring-a-ingress-wait-holds-a-lease-while-servicing-egress`.

Dependencies:

- Part 1's `release-failure-is-observable` is the record this re-anchors. Its
  host-side citation `shm_provider.rs:365` should become the asymmetry described
  here rather than a single site.
- Part 1's `quarantine-authority-survives-peer-writes` supplies the only
  reachable fault.
- `ring-a-ingress-wait-holds-a-lease-while-servicing-egress` is the `sometimes`
  record that must fire before this one is falsifiable.

## What a test must construct

Preconditions, all three needed:

1. An attached peer that can write the shared lifecycle page directly, to set
   the quarantine flag mid-lease. `crates/mc-shm-transport/tests/ring.rs` already
   manipulates ring internals, so the capability exists in that crate; on the
   host side it would need the `RingClientEndpoint`'s `Ring` values, which are
   `pub` fields (`ring_transport.rs:629`, `:631`).
2. An ingress budget too small for the frame in hand, so `receive_one` enters
   the loop at `:488`. `ByteBudget::new(0)` is already used this way by the
   inline test `budget_wait_observes_read_cancellation`
   (`ring_transport.rs:949`).
3. An oracle that can see the discarded `Result`. Since `Drop` discards it, the
   test cannot observe it directly. Two options: assert the *consequence* —
   `active_leases` on the consumer page did not decrease — or add a
   `#[cfg(debug_assertions)]` counter inside `ReceiveLease::drop` for failed
   drop-path releases. The second is the honest oracle; the first is a proxy that
   also fires for unrelated reasons.

The existing inline test at `:928-965` already builds items 2 and the
cancellation trigger, so it is one peer-side write away from being the harness.

Existing checks: `crates/mc-shm-transport/tests/ring.rs:256`
`quarantine_rejects_all_operations_and_reports_conservation` covers the
transport returning `Err(LeaseError::Quarantined)` from `release`. Nothing covers
the host's handling of it on the drop paths.

## Investigation log

### Q: Should the `Overloaded` and `Cancelled` paths release explicitly and upgrade a release failure to `Corrupt`?

- Sources examined: `ring_transport.rs:464-533` (all nine return points),
  `lease.rs:198-221` (`release_once`, `release`, `Drop`),
  `frame_channel.rs:33-48` (the `ReadClose` doc comments, especially
  `Overloaded`'s claim at `:40-43`), `ring.rs:849-880` (release validation).
- Findings: the argument for upgrading is that `Overloaded`'s documented meaning
  is a positive claim about transport health, and on a quarantined ring that claim
  is false, which propagates into `connection.rs:404`'s classification and from
  there into whether the close is treated as backpressure or as a fault. The
  argument against is that the generation is retiring on all three paths anyway,
  so the only thing lost is a diagnostic. That makes it a reporting fix rather
  than a safety fix.
- Missing evidence: whether anything downstream of `ReadExit::Peer` distinguishes
  backpressure from corruption. `connection.rs:401-404` collapses `CleanEof`,
  `Corrupt`, `Io`, and `Overloaded` into the same `ReadExit::Peer`, so at that
  level the distinction is already discarded — which means upgrading the cause
  would change nothing observable unless the classification is also split.
- Conclusion: resolved with a nuance that changes the priority. Because
  `connection.rs:401-404` already collapses `Corrupt` and `Overloaded` into one
  `ReadExit`, upgrading the cause on the drop paths buys nothing today. The
  asymmetry is a latent reporting gap that becomes live only if the close
  taxonomy is split. Recorded at its true weight rather than inflated.

### Q: Can a silent release failure strand a lease slot across a connection's life, rather than only at its end?

- Sources examined: the three untracked returns (`:493`, `:499`, `:513`) and
  what each returns; `run_endpoint:400-405` (every `Err(close)` from
  `receive_one` ends the loop); `ring.rs:770-778` (lease saturation as
  `Ok(None)`).
- Findings: no. All three untracked paths return `Err(ReadClose::..)`, and
  `run_endpoint` responds by sending the close, cancelling `retired` and `root`,
  and returning at `:404`. So a silent release failure always coincides with the
  connection ending. The eight-slot exhaustion scenario I first considered would
  need a release failure on a path that continues the loop, and there is none.
- Missing evidence: none.
- Conclusion: resolved. The impact is bounded to one lost diagnostic per
  retiring connection, not a cumulative slot leak. The record's `Impact:` field
  in the lens file overstates this and should be read together with this entry;
  the corrected reading is recorded here rather than silently reworded, per the
  method's rule about not restating an unconfirmed claim as fact.
