# wire-header-fully-validated-before-any-consumer-acts

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

`FrameDescriptor::validate` carries a 21-byte `wire_header`
(`crates/mc-shm-transport/src/descriptor.rs:294`, length constant at `:10`) and
inspects exactly five of those bytes (`:414-422`). The other sixteen are copied
into `ValidatedFrame` (`:425`) and handed to a consumer untouched. The transport
crate cannot inspect them even in principle: `crates/mc-shm-transport/Cargo.toml`
depends on `getrandom`, `libc`, `serde`, and `iceoryx2`, while
`crates/mc-host/Cargo.toml:25` depends on the transport, so the dependency edge
runs host-to-transport and `FrameType`, `Flags`, and `PROTOCOL_VERSION` are
unreachable from the validating crate. The interesting property is therefore not
either layer's check list but the composition: which layer owes which field, and
whether the owed check runs before anything acts on the frame.

## Evidence trail

Transport side, receiver direction. `Ring::try_receive` snapshots the shared
descriptor with one `read_volatile` (`backend/ring.rs:802`), validates it
(`:804`), and on failure quarantines the ring and returns
`RingError::Descriptor` (`:806-809`). Inside `validate`, the only header checks
are `declared_len` from bytes 0..4 against `body_len`, and `wire_header[4] != 2`,
both yielding `DescriptorError::WireHeaderMismatch` (`descriptor.rs:414-422`,
variant documented at `:565`). Bytes 5 through 20 — type, flags, channel, epoch,
correlation — are never read. The same two checks appear on the producer side in
`commit_reservation` (`ring.rs:1172-1180`, `ProducerError::WireHeaderMismatch`)
and a third time in the iceoryx backend (`backend/iceoryx.rs:257-262`). The
literal `2` in all three places mirrors `PROTOCOL_VERSION` (`wire.rs:25`) with no
shared definition, and `MAX_FRAME_BYTES` (`arena.rs:4`) mirrors
`MAX_FRAME_BODY_LEN` (`wire.rs:35`); both pairs are 64 MiB today and neither pair
is cross-checked.

Host side. `decode_header` (`crates/mc-host/src/wire.rs:306-368`) reads the
frozen prefix, dispatches header length on `ver` through `header_len_for_version`
(`:292-297`), then rejects an unknown type byte (`:320-321`), reserved flag bits
(`:323-325`), a reserved priority (`:326-328`), a reserved admission class
(`:329-331`), `Sheddable` on a type other than `Push`/`StreamData` (`:332-339`),
a pure-header type with a nonzero length (`:340-342`), and the two channel/epoch
cross-rules (`:345-354`). Correlation (`:355-357`) is accepted unconditionally.
`validate_inbound_header` (`frame_channel.rs:58-76`) then adds the 64 MiB body
cap, the pure-header flag rule, and the consumer-role type whitelist.

Ordering. `receive_one` (`ring_transport.rs:455-534`) runs `try_receive` (`:464`),
`decode_header` (`:471`), `validate_inbound_header` (`:473`), the channel-0
control cap (`:565`), the ingress charge loop (`:488-518`), the body copy
(`:520`), the completion (`:607`), and the send to the consumer (`:527-532`), in
that order. Nothing between `:464` and `:473` reads payload bytes, so both header
gates precede every charge, copy, and dispatch. The obligation is stated in the
doc comment on `validate_inbound_header` (`frame_channel.rs:53-57`): a
role-invalid type with a large declared body must not hold ingress budget or an
allocation through the frame deadline. That deadline is real — the charge loop at
`:579-603` can spin until `frame_deadline`.

Rejection consequence. Both gates map to `ReadClose::Corrupt`
(`ring_transport.rs:472-473`, variant at `frame_channel.rs:37`). `Corrupt` is not
in the clean set (former `shm_provider.rs:498`), so `run_endpoint` returns `false` and
the spawn wrapper takes `recovery.report_suspect(custody)` instead of
`custody.release()` (former `:364-371`). `report_suspect`
(former `provider_recovery.rs:360-397`) starts a recovery episode whose `cleanup` may
answer `Reclaimed`, `StaleRetry`, or `Uncertain` (former `:94-103`); only `Uncertain`
isolates. A header rejection therefore does not quarantine directly — it closes
the generation and hands the decision to the controller. The receive lease drops
unreleased and releases itself (`lease.rs:215-221`).

The documented transport contract does not assign these fields to anyone:
`docs/mc-host-shm-transport.md:13` says the receiver "snapshots and validates
descriptor metadata", and the header's own fields are not mentioned.

## Failure scenario

Three drifts break the composition without breaking either layer's tests. First,
moving the charge or the copy above `:562` gives an attacker-declared length the
power to hold up to 64 MiB of ingress budget for a full frame deadline on a frame
whose type is already known-illegal — the exact outcome the doc comment forbids.
Second, a consumer that reads `ValidatedFrame::wire_header()` without running
both host gates acts on sixteen unvalidated bytes; the transport's success return
is not evidence about them. Third, a version 3 that relocates `len` or `ver`
inside the header — the extension point at `wire.rs:292-297` exists precisely to
allow this — leaves `descriptor.rs:414-419` validating whatever now occupies
offsets 0..5, silently, since the transport cannot see the version registry.

## Timing windows and dependencies

No interleaving is required; the property is an ordering over one synchronous
path, and it holds at HEAD. The window that makes it load-bearing is the charge
loop (`ring_transport.rs:488-518`), bounded by `frame_deadline`: anything moved
above it inherits that hold time. Depends on
`receive-failure-leaves-no-wedged-slot` for the slot state after a rejection, and
on `quarantine-authority-survives-peer-writes` for the premise that a peer can
author descriptor bytes at all — both mappings are `PROT_READ|PROT_WRITE`
(`ring.rs:229`, `:258`).

## What a test must construct

A hostile producer that writes the shared descriptor page directly, because the
producer API cannot express these frames: `TestShmPeer::send`
(`ring_transport.rs:659-673`) builds the header with `EnvelopeHeader::encode`
(`wire.rs:205-215`) and commits `body.len()`, so `commit_reservation` rejects any
length disagreement before publication. With direct page authorship, one frame
per field class — unknown type byte, reserved flag bit 6 or 7, reserved priority
`0b11`, reserved admission `0b11`, `Sheddable` on `Request`, pure-header with a
body, nonzero epoch on channel 0, zero epoch on a routed channel, role-invalid
type — asserting for each that the close is `Corrupt`, that the ingress budget's
used-byte count is unchanged across the rejection, and that no
`InboundEvent::Frame` was emitted. The last two assertions are what pin the
ordering; asserting only the rejection would survive a reordering.
`crates/mc-host/tests/shm_failure_modes.rs:195-241` already covers one field
(type) end to end, including the suspect-and-isolate tail, and can be
generalised. A static counterpart is worth more than a fault harness here: assert
that every reader of `ValidatedFrame::wire_header()` outside a test reaches
`decode_header` and `validate_inbound_header`.

## Investigation log

### Q: Can a rejected header hold ingress budget or a receive lease past the rejection?

- Sources examined: former `shm_provider.rs:555-618` for the full order,
  `ring_transport.rs:488-518` for the charge loop, `lease.rs:215-221` for lease drop,
  `frame_channel.rs:53-57` for the documented obligation.
- Findings: no. The charge is acquired at `:580`, strictly after both gates, and
  the only earlier resource is the receive lease itself, which `Drop` releases.
  The `?` at `:563` and `:564` returns before `deadline` is even computed
  (`:578`), so the frame-deadline hold cannot be reached by an invalid header.
- Missing evidence: the control-cap branch at `:565-576` releases the lease
  explicitly and answers `Rejected` rather than closing, which is a fourth
  disposition beyond accept, `Corrupt`, and drop. Whether a peer can profit by
  parking correlations through that branch was not investigated.
- Conclusion: the ordering claim is established at HEAD by direct read. The
  record is about keeping it, not about a live defect.
