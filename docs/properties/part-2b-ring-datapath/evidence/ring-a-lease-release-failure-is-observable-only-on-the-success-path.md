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
(`crates/mc-host/src/ring_transport.rs:487-558`) binds the lease at `:496-501`:

```
let Some(lease) = rings.second.try_receive()
    .map_err(|_| ReadClose::Corrupt("shared-memory receive failed"))?
else { return Ok(false); };
```

From `:496` the lease is live until it is either explicitly released or dropped.

**The two explicit releases, both of which report.**

Oversize channel-0 rejection, `:506-517`:

```
lease.release()
    .map_err(|_| ReadClose::Corrupt("shared-memory completion failed"))?;
```

Delivery path, `:546-548`: the identical form.

**The three returns that hold a lease and drop it.**

- `:525` — the charge-wait `select!`'s `read_cancel.cancelled()` arm returns
  `Err(ReadClose::Cancelled)`. (Post-#131 the ingress wait is one `select!`
  over an async charge, `:522-542`, not a poll loop with an inner select.)
- `:527-532` — the absolute frame deadline expires, returning
  `Err(ReadClose::Overloaded)` at `:531`.
- `:539` — the sender queue closes while the charge is pending, returning
  `Err(ReadClose::Cancelled)`.

All three return while `lease` is a live local, so `ReceiveLease`'s `Drop` runs.
`crates/mc-shm-transport/src/lease.rs:201-206`:

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

**Three further paths worth naming, all of which do report.** `:543-545`
(`lease.to_vec()` failure, mapped to
`ReadClose::Corrupt("shared-memory lease failed")`), `:535-537` (a publish
failure raised from inside the wait, mapped to
`ReadClose::Corrupt("shared-memory publish failed")` while the lease is still
live and then dropped), and `:551-556`
(`inbound.send` failure, mapped to `ReadClose::Cancelled`). The last is after
the explicit release at `:548`, so no lease is live.

**What can make a release fail.** `Ring::release` (`ring.rs:1175-1210`,
continuing past the excerpt) returns `Err` on:

- quarantine — `ring.rs:1176-1178`, `LeaseError::Quarantined`;
- wrong incarnation — `:1179-1181`, and again at `:1202-1204` against the slot descriptor;
- wrong lane — `:1182-1184`, and again at `:1205-1207` against the descriptor;
- sequence zero — `:1186-1188`, `InvalidSequence`;
- sequence ahead of `consumed` — `:1193-1196`, `InvalidSequence`;
- duplicate release — `lease.rs:185-187`, `DuplicateRelease`, raised before the
  callback is even invoked.

Quarantine is the reachable one from a host's point of view, because
`Ring::try_receive` calls `enter_quarantine()` itself on descriptor-validation
failure (`ring.rs:1093-1100`).

**Why the untracked paths are the dangerous ones.** The lease slot budget is
eight, pinned by the profile post-#131 and asserted at
`ring_transport.rs:903-904`.
`try_receive` refuses to hand out a ninth lease and returns `Ok(None)`
(`ring.rs:1063-1068`), which `receive_one` returns as `Ok(false)`, which
`run_endpoint` treats as an idle direction. So eight silent release failures
convert the peer-to-host direction into a permanently idle-looking channel, and
the host has no signal distinguishing that from a quiet peer. That is the
mechanism behind the impact claim.

## Failure scenario

Concrete construction. Two frames in flight on the peer-to-host direction.

1. The peer publishes frame A with a valid descriptor, then frame B with a
   corrupt descriptor.
2. The host's `receive_one` takes a lease on A at `:496-501`. The ingress budget
   is saturated, so it parks in the charge wait at `:522-542`.
3. Something else in the host frees budget slowly, so the charge stays pending.
   Meanwhile nothing has yet touched B.
4. The frame deadline expires. `:527-532` returns
   `Err(ReadClose::Overloaded)`. The lease on A drops, `release_once` runs, and
   the ring is not quarantined yet, so it succeeds. No failure to hide.

To actually produce the failure, the quarantine must precede the drop, which
means step 2's lease must be held while a *different* receive path quarantines.
Since `receive_one` is single-threaded on the endpoint thread, the only way is
the peer writing the shared `quarantined` byte directly, which is exactly Part
1's `quarantine-authority-survives-peer-writes` scenario: the flag lives in
shared memory (written by `enter_quarantine`, `ring.rs:1373-1378`) and every
gate re-reads it, so a peer can set it
between the host's `try_receive` and the host's release.

So the reachable construction is: peer publishes a frame, host takes a lease and
enters the budget wait, peer sets the quarantine flag, host's deadline expires,
lease drops, `release_once` returns `Err(LeaseError::Quarantined)`, discarded.
The host reports `Overloaded`, which `connection.rs:404` maps to
`ReadExit::Peer`, a clean silent retirement. The lease slot is never returned,
but since the whole connection is retiring and the charge releases at
`ring_transport.rs:276` regardless, the immediate impact is bounded.

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

The window is `:496` to `:548`, which under a saturated ingress budget is up to
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
   `pub` fields (`ring_transport.rs:653`, `:655`).
2. An ingress budget too small for the frame in hand, so `receive_one` parks in
   the charge wait at `:522-542`. `ByteBudget::new(0)` is already used this way
   by the inline test `budget_wait_observes_read_cancellation`
   (`ring_transport.rs:1028`).
3. An oracle that can see the discarded `Result`. Since `Drop` discards it, the
   test cannot observe it directly. Two options: assert the *consequence* —
   `active_leases` on the consumer page did not decrease — or add a
   `#[cfg(debug_assertions)]` counter inside `ReceiveLease::drop` for failed
   drop-path releases. The second is the honest oracle; the first is a proxy that
   also fires for unrelated reasons.

The existing inline test at `:1008-1043` already builds items 2 and the
cancellation trigger, so it is one peer-side write away from being the harness.

Existing checks: `crates/mc-shm-transport/tests/ring.rs:240`
`quarantine_rejects_all_operations_and_reports_conservation` covers the
transport returning `Err(LeaseError::Quarantined)` from `release`. Nothing covers
the host's handling of it on the drop paths.

## Investigation log

### Q: Should the `Overloaded` and `Cancelled` paths release explicitly and upgrade a release failure to `Corrupt`?

- Sources examined: `ring_transport.rs:496-557` (all return points),
  `lease.rs:184-206` (`release_once` and `Drop`),
  `frame_channel.rs:33-48` (the `ReadClose` doc comments, especially
  `Overloaded`'s claim at `:40-43`), `ring.rs:1175-1210` (release validation).
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

- Sources examined: the three untracked returns (`:525`, `:531`, `:539`) and
  what each returns; `run_endpoint:406-411` (every `Err(close)` from
  `receive_one` ends the loop); `ring.rs:1063-1068` (lease saturation as
  `Ok(None)`).
- Findings: no. All three untracked paths return `Err(ReadClose::..)`, and
  `run_endpoint` responds by sending the close, cancelling `retired` and `root`,
  and returning at `:406-411`. So a silent release failure always coincides with the
  connection ending. The eight-slot exhaustion scenario I first considered would
  need a release failure on a path that continues the loop, and there is none.
- Missing evidence: none.
- Conclusion: resolved. The impact is bounded to one lost diagnostic per
  retiring connection, not a cumulative slot leak. The record's `Impact:` field
  in the lens file overstates this and should be read together with this entry;
  the corrected reading is recorded here rather than silently reworded, per the
  method's rule about not restating an unconfirmed claim as fact.
