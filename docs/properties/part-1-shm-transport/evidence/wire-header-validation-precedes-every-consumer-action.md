# wire-header-validation-precedes-every-consumer-action

## Discovery trigger

`ValidatedFrame` is named as though the whole descriptor has been checked, and
`ReceiveLease::wire_header` (`crates/mc-shm-transport/src/lease.rs:163-165`)
hands out 21 bytes with no qualification. But the transport's `validate` reads
only two of those bytes' worth of meaning
(`crates/mc-shm-transport/src/descriptor.rs:414-422`): the little-endian `len`
at offsets 0..4 must equal `body_len`, and `wire_header[4]` must be 2. Bytes 5
through 20 — type, flags, channel, epoch, correlation — pass through the trust
boundary untouched inside a type whose name says otherwise. The property is
therefore not "the host validates headers" but "nothing downstream of the
transport acts on those bytes, or on the body they describe, before the host's
two gates have run".

## Evidence trail

One receive is `receive_one` (`crates/mc-host/src/shm_provider.rs:546-619`). Its
ordering, read directly:

1. `:555-561` `rings.second.try_receive()` yields a lease or `Ok(false)`. Inside
   the transport, `try_receive` compare-exchanges the slot `PUBLISHED →
   RECEIVER_HELD` (`backend/ring.rs:790-799`), takes one
   `std::ptr::read_volatile` snapshot of the entire descriptor (`:802`),
   validates it (`:804`), and on success copies `validated.wire_header()` into
   the lease (`:836`). The snapshot matters: every later reader sees that local
   copy, not shared memory, so there is no time-of-check window between the
   transport's two checks and the host's.
2. `:562-563` `decode_header(&lease.wire_header())`, mapped to
   `ReadClose::Corrupt("invalid shared-memory header")`.
3. `:564` `validate_inbound_header(header)?`
   (`crates/mc-host/src/frame_channel.rs:58-76`).
4. `:565-576` the control-channel body cap. This is the first place a header
   field crosses into the connection engine: it sends
   `InboundEvent::Rejected { corr: header.corr }`.
5. `:578-603` the ingress admission loop, charging `header.len as usize`
   (`:580`).
6. `:604-606` `lease.to_vec()`, the body copy.
7. `:607-609` release, then `:612-617` `inbound.send(InboundEvent::Frame(...))`.

Steps 2 and 3 strictly precede 4 through 7 in straight-line code with `?` on
each. The `validate_inbound_header` doc comment (`frame_channel.rs:54-57`) states
the intent explicitly: classification uses the header alone, before any body
admission, so a role-invalid type with a large declared body cannot hold ingress
budget through the frame deadline. The shared-memory path honors that; the TCP
path places the same two calls in the same order
(`crates/mc-host/src/tcp_frame_channel.rs:188`, `:196`, `:198`).

Two of `decode_header`'s gates are dead on this path. `WIRE_V2_HEADER_BYTES` is
21 (`descriptor.rs:10`) and `HEADER_LEN` is 21 (`wire.rs:28`), so
`bytes.len() < FROZEN_PREFIX_LEN` (`wire.rs:307-309`) and `bytes.len() < need`
(`:312-317`) are both statically false for a fixed 21-byte array. Truncation is
a stream concern only.

## Failure scenario

The ordering is the only thing standing between a peer-authored header and a
resource commitment. If the ingress charge at `:580` moved above the two gates,
a peer could declare a 64 MiB body on a `Response` — a type the consumer role
forbids (`frame_channel.rs:69-74`) — and hold 64 MiB of ingress permits for the
whole frame deadline before the type check retired the generation. If
`lease.to_vec()` moved above them, the same frame would force a 64 MiB
allocation and copy. If the `InboundEvent::Rejected` send at `:569-574` moved
above `:564`, `header.corr` would settle a correlation on a frame whose type is
never checked; `connection.rs:418-420` comments that the correlation is
trustworthy from the header alone, which is true only because the type and
channel have already been validated by then.

## Timing windows and dependencies

No concurrency window. The descriptor snapshot at `ring.rs:802` is one volatile
read of the whole struct, so the 21 header bytes are frozen locally before the
transport's own checks and cannot change under either layer. That is what makes
this a pure ordering property rather than a race.

Scope note on the other consumer of the same accessor: the addon publishes
`lease.wire_header()` straight to JavaScript as a `Buffer`
(`packages/mc-shm-native/src/lib.rs:859`) with no native validation at all, and
the decode happens in TypeScript at
`packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:305` through
`decodeHeader` (`.../protocol.ts:266-294`, which calls `validateHeader`,
`:161-231`). That path reads `channel.from_host`, so its headers are
host-authored and the trust direction is reversed; it is not the same exposure.
It does show that the accessor itself carries no validation obligation, so each
consumer supplies its own.

Depends on `no-frame-observable-before-commit` for the premise that an accepted
lease corresponds to a committed frame.

## What a test must construct

A peer-side publish whose 21 header bytes satisfy exactly the transport's two
checks — `declared_len == body_len` and `wire_header[4] == 2` — and violate one
host rule, paired with an assertion that no consumer effect occurred. The
observable effects to pin at zero are: no ingress permit consumed for
`header.len`, no `InboundEvent` of any kind delivered on `inbound`, and no body
allocation. `crates/mc-host/tests/shm_failure_modes.rs:195`
`corrupt_peer_frame_quarantines_exact_charges_and_returns_ready` already
constructs one such frame — a `Response` with `len: 0` — but asserts only the
downstream quarantine, so it cannot distinguish "rejected before the charge"
from "rejected after it". Setting `len` to `MAX_BODY_LEN` on that same frame and
asserting the ingress budget never dips is the discriminating case.

## Investigation log

### Q: Does any code between `try_receive` and the two gates read a header field?

- Sources examined: `shm_provider.rs:546-619` in full; `backend/ring.rs:760-844`;
  `lease.rs:94-197`.
- Findings: no. Between the lease returning and `:562` the only operations are
  the `else { return Ok(false) }` on an empty ring and the borrow of
  `lease.wire_header()` itself. Inside the transport, the fields read after the
  snapshot are the descriptor's own — identity, spans, `body_len` — never
  header bytes 5 through 20.
- Conclusion: resolved. The ordering holds as written; what is missing is any
  test that would fail if it stopped holding.
