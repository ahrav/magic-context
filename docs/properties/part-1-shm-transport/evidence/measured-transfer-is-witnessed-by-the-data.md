# measured-transfer-is-witnessed-by-the-data

## Discovery trigger

Every `Measurement` emitted by the hardware envelope bench carries a `checksum`
field (`benches/hardware_envelope.rs:50`), and the report presents arms
side by side. A checksum in a transfer benchmark is normally the one field that
proves the transfer happened, so each arm's checksum was traced to the value it
is computed from.

## Evidence trail

The ring family — `h1_raw_descriptor_ring_payload_touch`,
`direct_producer_leased_receiver`, `ring`, and the three copied ablations, all
dispatched to `run_ring` at `benches/hardware_envelope.rs:165-170` — computes
its checksum at `:401-403`:

```rust
let checksum = iterations
    .wrapping_mul(payload_len as u64)
    .wrapping_mul(0x5a);
```

The inputs are the two loop parameters and the fill byte. No delivered byte
participates. `:404` then passes the value through `black_box`, which prevents
the compiler from folding it but does not make it an observation.

The consumer does compute a real checksum. `ring_consumer` at `:440-445`
iterates the lease segments and evaluates `black_box(span.checksum())` at
`:444`. The result is discarded on the spot; it is never compared, accumulated,
or returned. On the copied-receiver path the bytes are copied by
`lease.to_vec()` at `:436` and only `is_err()` is inspected, so the copied
bytes are never examined either.

The other arm families do checksum real data:

- `run_stream_pair` (`unix_socket`, `tcp`) accumulates over the bytes read back
  at `:516`: `checksum.wrapping_add(response.iter().map(...).sum::<u64>())`.
- `run_iceoryx` accumulates over the received lease segment at `:587-594`.
- `run_h0` reports `(*line).load(Ordering::Relaxed)` at `:309`, which is the
  final ping-pong counter, not a checksum over any payload. `h0` transfers no
  payload, so there is nothing for it to witness.

The consequence is that the `checksum` column mixes three unrelated quantities:
a closed form over parameters (ring family), a byte sum (stream and iceoryx
families), and a protocol counter (h0). Within the ring family the value is a
constant for a given `(iterations, payload_bytes)` pair, so all six ring-family
arms report the identical checksum regardless of whether the receiver leased or
copied.

One partial oracle does exist and should not be overstated away: total delivery
failure is caught by the child exit status rather than the checksum. If
`try_receive` never yields, `ring_consumer` returns `2` at `:432`,
`wait_child` reports it at `:393`, and `run_ring` returns
`Err("ring peer failed")` at `:395`. So a frame that is never delivered fails
the arm. A frame that is delivered with wrong bytes does not.

## Failure scenario

A defect corrupts payload bytes between `reservation.write(source)` (`:390`)
and the consumer's view of the segment. The consumer computes
`span.checksum()` at `:444` over the corrupted bytes and throws the result
away. `lease.release()` succeeds, the child exits `0`, and the parent computes
`iterations * payload_len * 0x5a` at `:401-403`. The emitted record is
bit-identical to a correct run: same `elapsed_ns` distribution, same counters,
same checksum. The `ring` arm is `selectable: true` (`:219`), so this is the
arm a shipping decision would rest on.

## Timing windows and dependencies

None required to reach the gap; it is present in every invocation. A corruption
window is required only to demonstrate the impact, and the corruption need not
be timed: any deterministic mutation of the delivered bytes reproduces the
identical checksum.

The one dependency worth naming is that the corruption must not stall delivery.
If it also prevents `try_receive` from yielding, the exit-status oracle at
`:393-395` catches it and the checksum gap is masked.

## What a test must construct

1. A run of the `ring` arm with one delivered byte mutated after commit and
   before the consumer reads it, asserting that the reported `checksum`
   differs from the unmutated run. This fails today by construction.
2. A cross-arm comparability assertion: for a fixed `(iterations, payload)`,
   assert the ring-family checksum is not equal to the value produced by the
   same payload through `run_stream_pair`, or else assert that both are defined
   over the same quantity. Either outcome is informative; the current state is
   that the field is not comparable and nothing says so.
3. A wiring change is implied for both: the consumer's `span.checksum()` at
   `:444` must be accumulated and returned across the fork boundary, since the
   process that sees the bytes is the child and the process that emits the
   record is the parent.

## Investigation log

The catalog records no open question for this property. The question actually
resolved during the trail is logged so the reasoning is reproducible.

### Q: Does any arm's reported checksum depend on delivered bytes, and is the ring arm's value therefore comparable to the stream arms'?

- Sources examined: `benches/hardware_envelope.rs` in full, specifically
  `run_h0` (`:269-315`), `run_ring` (`:351-413`), `ring_consumer`
  (`:415-452`), `run_stream_pair` (`:487-529`), `run_iceoryx` (`:531-598`),
  and the `Measurement` struct (`:35-54`).
- Findings: the stream arms and the iceoryx arm compute their checksum from
  received bytes. The ring family does not; its value is a pure function of
  `iterations`, `payload_len`, and the literal `0x5a`. `h0` reports a protocol
  counter. The consumer's genuine `span.checksum()` is computed at `:444` and
  discarded.
- Missing evidence: nothing. Every arm's checksum expression was read directly
  at `9c1eb4d1` and no arm dispatches through a path not listed above.
- Conclusion: resolved. No ring-family arm's checksum is witnessed by delivered
  data, and the field is not comparable across arm families. Total
  non-delivery is still caught, by the child exit status rather than by the
  checksum.
