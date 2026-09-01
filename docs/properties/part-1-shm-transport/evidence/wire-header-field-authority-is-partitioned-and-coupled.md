# wire-header-field-authority-is-partitioned-and-coupled

## Discovery trigger

The transport and the host each validate part of the same 21-byte header, and
neither states which part is its own. Reading the two sites side by side shows
the split is total by accident of two independently maintained lists, and that
the layers are joined by exactly one shared check plus a pair of separately
defined constants that happen to be equal. That is a division of responsibility
with no declaration and no cross-check, so either side can widen without the
other noticing.

## Evidence trail

Byte offsets follow the wire-v2 layout as parsed in
`crates/mc-host/src/wire.rs:319-357`.

| Bytes | Field | Transport, `descriptor.rs` | Host `decode_header`, `wire.rs` | Host `validate_inbound_header`, `frame_channel.rs` |
| --- | --- | --- | --- | --- |
| 0..4 | `len` | `== body_len` (`:414-422`) | `ty.is_pure_header() && len != 0` (`:340-342`) | `> MAX_BODY_LEN` (`:59-61`) |
| 4 | `ver` | `== 2` (`:420`) | `header_len_for_version` (`:292-297`, `:311`) | none |
| 5 | `ty` | none | `FrameType::from_u8` (`:320-321`) | pure-header flag pairing (`:62-68`), consumer role (`:69-74`) |
| 6 | `flags` | none | reserved bits, reserved priority, reserved admission class, `Sheddable` on an illegal type (`:322-339`) | pure-header must not be binary, last, or non-`Normal` (`:62-68`) |
| 7..9 | `channel` | none | `channel == 0 && epoch != 0` (`:345-347`); `channel != 0 && epoch == 0` (`:352-354`) | none |
| 9..13 | `epoch` | none | same pair as `channel` | none |
| 13..21 | `corr` | none | read only (`:355-357`) | none |

One shm-local gate sits outside both functions: a channel-0 `Request` whose `len`
exceeds `MAX_CONTROL_BODY_LEN` (`wire.rs:374`, 65 536) is answered with
`InboundEvent::Rejected` rather than a close
(`crates/mc-host/src/ring_transport.rs:474-485`). The TCP path that duplicated
that rule by hand at `tcp_frame_channel.rs:198` is gone: `ed487e11` deleted
`tcp_frame_channel.rs` when it made the ring transport mandatory, so that third
per-transport copy no longer exists in `crates/mc-host/src`.

`corr` is deliberately unvalidated: `connection.rs:418-420` records that the
correlation is trustworthy from the header alone. Every other field is claimed by
exactly one layer, with `len` and `ver` claimed by both.

Three couplings join the layers.

1. **`declared_len == body_len` is load-bearing, not cosmetic.** The host charges
   ingress `header.len as usize` (`ring_transport.rs:489`) and then copies
   `self.body_len` bytes (`lease.rs:178-181`, `:191-194`). Those are two
   different values from two different places in the descriptor. They agree only
   because `descriptor.rs:295` forces them equal.
2. **Two equal constants in two crates.** `MAX_FRAME_BYTES` is 64 MiB
   (`crates/mc-shm-transport/src/arena.rs:4`) and bounds `body_len`
   (`descriptor.rs:236-239`). `MAX_BODY_LEN` is 64 MiB
   (`wire.rs:371`, from `MAX_FRAME_BODY_LEN` at `:35`) and bounds `header.len`
   (`frame_channel.rs:59-61`). Given coupling 1, the host's bound is exactly
   redundant on this path today. Nothing asserts the equality.
3. **`ver` is checked twice.** Both layers require 2, with different
   consequences; see
   [header-rejection-effect-does-not-depend-on-the-catching-layer](header-rejection-effect-does-not-depend-on-the-catching-layer.md).

The transport applies the same two checks on publish as on receive
(`backend/ring.rs:1171-1187`, `ProducerError::WireHeaderMismatch`), and a
producer may replace the header freely until commit
(`ring.rs:1328-1337`). So the transport's rule is symmetric and narrow in both
directions: two fields, never bytes 5 through 20.

## Failure scenario

Drop coupling 1 — relax `descriptor.rs:295` to accept any `declared_len` — and
the two lengths separate. A peer publishes a 64 MiB body with `len` set to 0 in
the header. `decode_header` accepts it as long as the type is not pure-header.
`validate_inbound_header` sees `0 > MAX_BODY_LEN` as false. The ingress charge is
zero permits (`:455`), and `lease.to_vec()` then allocates and copies 64 MiB
(`lease.rs:179`). The ingress budget, whose whole purpose is to bound resident
inbound bytes, is bypassed by a header field the host trusts and the transport
would no longer check. The reverse direction is a smaller loss: `len` far above
the real body over-charges and under-delivers.

Drift in the other direction is quieter. Raise `MAX_BODY_LEN` above
`MAX_FRAME_BYTES` and `frame_channel.rs:59-61` becomes unreachable on the
shared-memory path while remaining live on TCP, so the shm bound silently becomes
the transport's alone. Lower `MAX_FRAME_BYTES` and the host's check keeps
passing frames the transport already rejected, which is harmless but means the
host's own bound has stopped being tested by any shm case.

Removing a host check for a field the transport never checked hands that field
straight to the connection engine. The concrete ones are `channel` and `epoch`:
without `wire.rs:345-354`, a routed channel with a zero epoch names no bindable
route and reaches routing as an unmatched frame, and a control channel with a
nonzero epoch reaches it as a route claim on channel 0.

## Timing windows and dependencies

No timing window. This is a static partition over a frozen 21-byte local copy
(`ring.rs:804`). Depends on
[wire-header-validation-precedes-every-consumer-action](wire-header-validation-precedes-every-consumer-action.md)
for the ordering that makes the partition meaningful; a total partition applied
after the body is admitted would not help.

## What a test must construct

Two assertions, neither of which exists.

First, totality and charge agreement, per delivered frame: for every
`InboundEvent::Frame` the endpoint emits, assert the ingress permits taken equal
`body.len()`. That is the assertion coupling 1 exists to guarantee, and it is
cheap because both numbers are already in scope at `ring_transport.rs:527-532`.

Second, a composition sweep. `harness::frame_descriptor`
(`crates/mc-shm-transport/src/harness.rs:29-100`) already feeds 21 arbitrary
header bytes into `validate` from fuzz input (`:35-36`) and asserts only span
and body-length facts about accepted descriptors; it never hands an accepted
`wire_header` to a decoder. Extending it is not possible in place, because
`mc-host` depends on `mc-shm-transport` (`crates/mc-host/Cargo.toml:25`) and not
the reverse, and only `mc-shm-transport` has a `fuzz` directory. The check
belongs in a host-side target that calls `harness::frame_descriptor`'s decode
and then `decode_header` plus `validate_inbound_header`, asserting that every
accepted descriptor's header is either protocol-legal or rejected. The equality
of the two 64 MiB constants is a one-line static assertion in `mc-host`.

## Investigation log

### Q: Is the partition actually total, or is some field unchecked by both layers?

- Sources examined: `descriptor.rs:207-298` in full; `wire.rs:306-368` in full;
  `frame_channel.rs:58-76` in full; `ring_transport.rs:503-505`.
- Findings: total except `corr`, which is unchecked by design and documented as
  such at `connection.rs:418-420`. Every other field has at least one owner. No
  field has an owner in the transport beyond `len` and `ver`.
- Conclusion: resolved. The gap is not an unchecked field; it is that the split
  is undeclared and uncross-checked, and that one transport check the host relies
  on for its ingress accounting is not documented as a host precondition
  anywhere.
