# ring-a-segmented-inbound-body-has-no-production-producer

## Discovery trigger

`docs/mc-host-shm-transport.md:19` says the receiver "validates the descriptor
and header before exposing a scoped lease", and
`docs/mc-host-wire-protocol.md:294` repeats the obligation as a MUST. The
frame-channel module doc says the same thing more strongly
(`crates/mc-host/src/frame_channel.rs:8-10`): "Receive bytes are visible only
through a lexical `ReceiveLease`; contiguous consumers use the explicit copying
adapter before entering asynchronous work." Tracing what the host actually hands
the connection engine showed the segmented, non-copying half of that design has
no producer.

## Evidence trail

**The two body shapes.** `frame_channel.rs:446-450`:

```
enum ReceiveBody {
    Segmented(Vec<u8>, Vec<u8>),
    Owned(Vec<u8>),
}
```

**The two constructors.** `InboundFrame::owned` (`:462-474`) and
`InboundFrame::segmented` (`:476-490`). The second carries:

```
#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]
pub(crate) fn segmented(
```

**Caller enumeration.** `InboundFrame::segmented` has **zero** call sites in the
tree, including tests. The only `InboundFrame` constructor call on the host
inbound path is `ring_transport.rs:552`:

```
inbound.send(Ok(InboundEvent::Frame(InboundFrame::owned(
    header, body, charge, copies,
))))
```

So `ReceiveBody::Segmented` is unconstructible in production, and the
suppression reason is false at `HEAD`: the shared-memory backend supplies
`owned`, not a wrapped body.

**What that strands downstream.** `with_lease` (`:506-513`):

```
pub fn with_lease<T>(&self, decode: impl for<'lease> FnOnce(ReceiveLease<'lease>) -> T) -> T {
    match &self.body {
        ReceiveBody::Owned(body) => decode(ReceiveLease::contiguous(body)),
        ReceiveBody::Segmented(first, second) => {
            decode(ReceiveLease::segmented(first, Some(second)))
        }
    }
}
```

The second arm is dead. So is the `Segmented` arm of `into_owned`
(`:523-528`). And so is the `None` arm of the connection engine's adapter,
`connection.rs:583-587`:

```
frame.with_lease(|lease| match lease.contiguous_bytes() {
    Some(body) => decode(body),
    None => decode(&lease.to_owned(&copies)),
})
```

`contiguous_bytes` (`frame_channel.rs:364-366`) returns `Some` exactly when
`second.is_none()`, which `ReceiveLease::contiguous` (`:317-319`) always
arranges. So the `None` arm never runs, and the doc comment above it
(`connection.rs:577-579` — "A body that wraps the ring arena end flattens
through the explicit copying adapter first") describes a path that cannot be
taken, because the flattening already happened one layer down.

**Where the flattening actually happens.** `receive_one` collapses the span
structure with `lease.to_vec()` at `ring_transport.rs:543-545`, before the host
ever sees it. `ReceiveLease::to_vec`
(`crates/mc-shm-transport/src/lease.rs`; not re-swept post-#131) walks
the spans and copies each into one contiguous `Vec`. The transport
does produce two spans when a body straddles the arena wrap
(`ring.rs:1105-1112` sets `second` when `validated.span_count() == 2`), so the
segmented case is real at the transport layer and is erased at the host boundary.

**The same erasure on the peer side.** `RingClientEndpoint::try_recv_with`
(`ring_transport.rs:723-739`) also calls `lease.to_vec()` at `:735`. So neither
end of the in-process pair ever observes span structure.

**Three sibling abstractions in the same position.** All test-only, all with no
production caller:

- `frame_channel::LeaseTracker` (`:398-444`), including its `close()` gate at
  `:418-426` whose doc claims "Close never reports reusable storage while any
  lexical lease is live". Referenced only at
  `frame_channel/contract_tests.rs:531`, `:675`, `:691`.
- `frame_channel::ProducerReservation` (`:117-226`). Referenced only at
  `contract_tests.rs:531`, `:564`, `:598`, `:607`, `:622`. `ring_transport.rs`
  imports `mc_shm_transport::backend::ring::ProducerReservation` instead
  (`ring_transport.rs:15`).
- `ProducedBody` (`:231-288`), whose `into_charge` (`:283-287`) has no caller at
  all. Its doc at `:113-115` states the design intent that is now unexercised:
  the charge "moves into `ProducedBody` on success and drops immediately on
  constructor failure, overflow, underfill, explicit abort, or ordinary drop.
  This makes charge return an ownership property instead of a caller convention."

The ring path does not use that ownership property. It uses the transport's own
reservation, whose charge return is the transport's `Drop`
(`ring.rs:1814` onward), and the host's outbound `ByteCharge` is dropped
explicitly at `ring_transport.rs:600`.

## Failure scenario

No runtime defect. Every inbound frame is copied exactly once, `CopyCounter`
records exactly one (`ring_transport.rs:549-550`), and the accounting is
truthful.

The consequences are about what is not tested and what a reader will believe.

First, the zero-copy design the module doc describes is not the design in use.
`frame_channel.rs:8-10` says receive bytes are "visible only through a lexical
`ReceiveLease`" — true of the *type*, false of the *storage*: the lease the
engine sees borrows the host's own `Vec`, so its `!Send` and non-`'static`
bounds (enforced by the two compile-fail doctests at `:296-308`) protect against
escaping a copy, not against escaping shared memory. The protection that matters,
not holding a reference into peer-writable storage, is Part 1's
`no-rust-reference-over-peer-writable-payload` and it is satisfied by the copy at
`:544`, not by the lease type.

Second, the wrap-around case is untested end to end at the host boundary. A body
straddling the arena wrap produces two spans in the transport, and the host's
only handling is `to_vec`'s loop. If that loop were wrong — say it mis-ordered the
spans — the host would deliver a corrupted body and nothing in `mc-host` would
notice, because the only assertion on segment structure is
`contract_tests.rs:141`, on a hand-built frame:

```
frame.with_lease(|lease| assert_eq!(lease.segment(0), Some(&b"in"[..])));
```

Third, a stale suppression reason is how a genuinely dead branch survives review.
`#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]`
reads as a justification, so a reviewer skips it. The reason was true when the
shm provider wrapped bodies; the refactor changed the backend and left the
reason.

## Timing windows and dependencies

No timing window. Static producer enumeration.

Dependencies:

- Part 1's `no-rust-reference-over-peer-writable-payload` is satisfied by the
  copy, and this record identifies which mechanism actually satisfies it.
- Part 1's `ingress-charge-matches-the-bytes-copied-from-shared-storage` is
  `Reaches production: yes` and covers the charge-versus-copy accounting; this
  record establishes that there is exactly one copy to account, always.
- `ring-a-ingress-wait-holds-a-lease-while-servicing-egress` shares the same
  window, since the copy at `:544` is what finally ends the lease's life.

## What a test must construct

The `reachable` check as stated cannot pass, so the useful constructions are the
two things the dead path was standing in for.

1. **Wrap-around body, end to end.** Fill the arena so the next body straddles
   the wrap point, publish it peer-to-host, and assert the host delivers the
   exact bytes. This exercises `to_vec`'s two-span loop
   (`lease.rs`; not re-swept post-#131) through the production path, which is
   the real
   obligation. The arena is `mc_shm_transport::MIN_ARENA_BYTES` (asserted at
   `ring_transport.rs:905`) and the descriptor depth is 8 (`:903`), so filling it
   is a matter of publishing and releasing enough frames to advance the write
   cursor near the end.
2. **Copy count is exactly one.** Already covered by
   `copied_control_frame_records_one_host_adapter_copy`
   (`ring_transport.rs:961-1005`), which asserts
   `frame.copy_counter().copies() == 1` at `:1004`. That test does not run in CI.

Then, separately, a decision on the three dormant abstractions. If they are to
be kept, the honest marking is `#[expect(dead_code, reason = ...)]` with a true
reason, so the build fails when a production caller appears or the reason stops
holding. If they are to go, deleting `InboundFrame::segmented`,
`ReceiveBody::Segmented`, `LeaseTracker`, `frame_channel::ProducerReservation`,
and `ProducedBody` removes about 200 lines of `frame_channel.rs` and roughly the
contract-test blocks at `contract_tests.rs:527-700`.

## Investigation log

### Q: Is the segmented path intended to return, or should the dormant abstractions be deleted together?

- Sources examined: `frame_channel.rs:1-10` (module doc), `:110-115`
  (`ProducerReservation`'s charge-ownership doc), `:395-397` (`LeaseTracker`'s
  "Testable close gate used by transport implementations"), `:446-490`
  (`ReceiveBody` and both constructors), `:506-534` (`with_lease`,
  `into_owned`); `ring_transport.rs:15` (which reservation type the ring
  actually imports), `:543-556` (the copy and the `owned` construction);
  `connection.rs:577-587`; `contract_tests.rs:527-700` (the
  `ownership_contract` module).
- Findings: the three dormant abstractions form a coherent design that a
  *different* backend would have used — one that hands the host raw spans and lets
  the host own the reservation and the lease bookkeeping. The ring backend does
  not: it owns its own reservation type and its own lease, and it copies at the
  boundary. `LeaseTracker::close`'s doc at `:415-417` even names the constraint
  that made it necessary: "U1 has no backend wait primitive, so active storage
  takes the allowed bounded-quarantine branch." The ring backend does have a wait
  primitive of a sort, the `try_receive` lease-saturation return
  (`ring.rs:1063-1068`), so the constraint no longer applies.
- Missing evidence: whether a second backend is planned.
  `docs/mc-host-shm-transport.md:7` says there is no alternate shared-memory
  backend and the `mandatory-ring-architecture` gate enforces it, which argues
  against retention. But the re-scope also notes that
  `frame_channel_contract_suite!` was designed for two implementations and now has
  one, so the whole `frame_channel` abstraction is in the same position: kept for
  a generality that was removed.
- Conclusion: needs human input, and it is the same decision as whether
  `frame_channel`'s transport-agnostic shape is still earning its keep. Recorded
  as a scoping observation rather than resolved, because deleting a 200-line
  abstraction is a design call.

### Q: Does the host boundary satisfy the docs' scoped-lease obligation?

- Sources examined: `docs/mc-host-shm-transport.md:19`;
  `docs/mc-host-wire-protocol.md:294`; `ring.rs:1076-1134` (the transport's
  validate-then-lease sequence); `ring_transport.rs:503-505` (the host's header
  validation) and `:543-548` (copy then release);
  `frame_channel.rs:290-314` (the `ReceiveLease` type and its two compile-fail
  doctests).
- Findings: the obligation is satisfied at the layer it names. The transport
  validates offsets, lengths, sequence metadata, header fields, and descriptor
  identity (`ring.rs:1093-1100`) before constructing the lease at `:1119-1133`, which
  is exactly what `:294` requires. The host then adds its own header validation
  at `:503-505`. What the docs do not say, and a reader would not infer, is that
  the host does not pass that lease along: it copies and releases, and the
  `ReceiveLease` the connection engine handles is a different type in a different
  crate (`frame_channel.rs:309` versus
  `crates/mc-shm-transport/src/lease.rs:90`) over host-owned storage.
- Missing evidence: none.
- Conclusion: resolved with answer. The obligation holds; the docs conflate two
  layers and two identically-named types. Recorded as lead L1 in the lens file.
