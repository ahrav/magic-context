# ingress-charge-matches-the-bytes-copied-from-shared-storage

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

`receive_one` charges the ingress budget from the header
(`crates/mc-host/src/ring_transport.rs:489`, `ingress.try_charge(header.len as
usize)`) and then copies the body from the descriptor
(`:520`, `lease.to_vec()`). Those are two different numbers from two different
places: `header.len` is bytes 0..4 of the peer-authored wire header, and
`to_vec` allocates and fills `self.body_len`
(`crates/mc-shm-transport/src/lease.rs:178-196`), which came from the
descriptor's `body_len` field (`backend/ring.rs:828-835`). The host never
compares them. The equality is supplied entirely by a check in the other crate.

## Evidence trail

The only place the two are tied together is `FrameDescriptor::validate`
(`descriptor.rs:414-422`): `declared_len` is decoded from `wire_header[0..4]` and
compared with `body_len`, and disagreement returns
`DescriptorError::WireHeaderMismatch`. `Ring::try_receive` calls that validation
at `backend/ring.rs:804` and refuses to produce a lease otherwise (`:806-809`).
So by the time `ring_transport.rs:471` decodes the header, `header.len ==
body_len` is already true — proved in `mc-shm-transport`, consumed in `mc-host`,
with no assertion, comment, or type linking the two.

Downstream of the charge, nothing re-derives it. `InboundFrame::owned`
(`frame_channel.rs:478-490`) stores the header, the body vector, and the
`ByteCharge` side by side without comparing `header.len` to `body.len()`. The
charge is what the budget later releases, so a divergence would be a durable
accounting error rather than a transient one.

The producer path cannot create a divergence: `commit_reservation` applies the
same equality to the header it is about to publish
(`backend/ring.rs:1172-1180`), and `set_wire_header` (`:1326-1333`) only replaces
the bytes that `commit_reservation` then re-checks. `TestShmPeer::send`
(`ring_transport.rs:659-673`) goes through exactly that path. The divergence is
reachable only by a peer writing the shared descriptor page directly, which the
mapping permits: both `Mapping::create` and `Mapping::attach` map
`PROT_READ|PROT_WRITE` (`backend/ring.rs:229`, `:258`) and the required seals are
`F_SEAL_GROW|SHRINK|SEAL` with no `F_SEAL_WRITE` (`:1709`).

The peer-side consumer shows what not delegating looks like. In
`packages/plugin/src/shared/mc-host-client/transport-provider.ts:406-426` the
provider lease path sums the segment byte lengths, rejects
`segmentBytes !== reported` (`:407-409`), charges `reported` (`:412`), and then
rejects `safeHeader.len !== reported` (`:425`). The same relationship the Rust
host takes on trust is re-established locally there, twice.

## Failure scenario

A peer writes a descriptor whose `body_len` and span lengths describe 64 bytes
while `wire_header[0..4]` declares 64 MiB, then publishes. If
`descriptor.rs:420` were relaxed, weakened to a `<=`, or moved behind a feature
gate, the host would charge 64 MiB of ingress budget and copy 64 bytes. The
`ByteCharge` travels with the frame and releases 64 MiB, so the arithmetic still
balances — the damage is that a peer sets the host's admission accounting from a
field with no relation to the bytes it moved. Sustained, that is a
budget-exhaustion primitive costing the attacker almost nothing: the ingress wait
loop (`ring_transport.rs:488-518`) is what other receives block on, and the
`Overloaded` close it produces (`:590`) is classified clean (`:498`), so the
pressure looks like honest backpressure rather than an attack. The mirror-image
relaxation is equally available: declaring a small length and describing a large
body undercharges, and `to_vec` still copies the large body.

## Timing windows and dependencies

No timing window in the accept path; the charge and the copy are consecutive
statements. The exposure window is the drift interval between crates. The two
constants that bound the fields — `MAX_FRAME_BYTES` (`arena.rs:4`) and
`MAX_FRAME_BODY_LEN` (`wire.rs:35`) — are independently defined 64 MiB values,
and the dependency edge runs host-to-transport (`crates/mc-host/Cargo.toml:25`),
so the transport cannot import either the constant or the header type it is
validating. Depends on `wire-header-fully-validated-before-any-consumer-acts` for
the ordering that puts the charge after the header gates, and on
`quarantine-authority-survives-peer-writes` for the writable-control-page
premise.

## What a test must construct

An assertion at the point of admission is enough and needs no hostile peer: for
every `InboundEvent::Frame` the shared-memory read path emits, the charged byte
count equals `body.len()`. That check passes today, and it is the check that
fails the moment `descriptor.rs:420` is relaxed — which makes it the pin the gap
asks for. Pair it with a direct descriptor-page write that lies about the
declared length, asserting the close is `Corrupt` and that the ingress budget's
used count is unchanged, so the transport-side gate has an executed negative case
instead of being inferred from the host's success. `existing-checks.md:168`
records that the wire-header setter has no test at all, so neither side of this
equality is currently exercised negatively.

## Investigation log

### Q: Does anything downstream of the charge re-derive `header.len` from the body, so that a divergence would still be caught?

- Sources examined: `ring_transport.rs:519-532`, `frame_channel.rs:478-490` for
  `InboundFrame::owned`, `lease.rs:178-196` for `to_vec`, and the `segmented`
  constructor at `frame_channel.rs:493-501`.
- Findings: no. `to_vec` checks its own internal consistency — the spans must sum
  to `body_len` (`:192-194`) — but `body_len` is the descriptor's field, so this
  re-proves the descriptor against itself and never against the header.
  `InboundFrame::owned` performs no comparison. The `#[allow(dead_code)]` on
  `segmented` (`frame_channel.rs:492`) confirms the shared-memory path uses the
  owned constructor.
- Missing evidence: whether any consumer above `InboundEvent` compares
  `header.len` to the body it receives. That is Part 2 surface and was not read.
- Conclusion: within Part 1's boundary the equality has exactly one enforcement
  point, in the crate that does not own the header format.
