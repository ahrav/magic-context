# decoder-totality-over-arbitrary-bytes

## Discovery trigger

Three fuzz targets exist and each hands arbitrary bytes to a decoder, but no
record states the contract those targets are testing. Reading the decoders for
what they promise on hostile input turned up the gap: `RingGrant::decode`
carries three `.expect()` calls, `harness::read_u64` slice-indexes with
hand-computed offsets, and the only bound on any length-driven allocation is a
constant checked inside `validate`. Panic-freedom is asserted today by one test
that sweeps ten lengths and two fill bytes. That is a smoke test for a totality
claim, not evidence for it.

## Evidence trail

Three decode entry points, all in `crates/mc-shm-transport`:

- `harness.rs:30-104` `frame_descriptor` — gates on
  `bytes.len() != FRAME_DESCRIPTOR_BYTES` (`:31-33`), then reads fields at
  hand-written offsets (`:34-62`) and calls `FrameDescriptor::validate`
  (`:76`).
- `harness.rs:110-121` `provider_grant` — `RingGrant::decode_slice`
  (`backend/ring.rs:456-459`).
- `harness.rs:127-159` `provider_sample` — `SamplePrefix::snapshot`
  (`backend/sample.rs:41-71`) then `validate` (`:83-126`).

No accepted value escapes a partially checked state. `ValidatedFrame` is
constructed once, at `descriptor.rs:299-307`, after all fourteen guards
(`:223-297`). `ValidatedSample` is constructed once, at `sample.rs:122-125`,
after all nine (`:88-121`). Both have private fields and no other constructor.
`RingGrant` differs in shape but not in effect: the value is materialized at
`ring.rs:434-450` *before* `checked_layout()?` runs at `:451`, so a
geometry-invalid grant briefly exists as a value — it just cannot reach the
`Ok(grant)` at `:456`.

Panic sites reachable from a decode call:

- `ring.rs:432`, `:439`, `:444` — three `.expect()` calls, and the constant
  range indexes at `:426`, `:441`, `:441` that precede them. All operate on
  `[u8; GRANT_BYTES]` where `GRANT_BYTES` is the literal `58` at `ring.rs:29`.
  The field widths sum to `2 + 16 + 4 + 8 + 8 + 8 + 8 = 54`, plus four reserved
  bytes at `:415` and `:426`, for 58. Nothing asserts that relationship.
- `harness.rs:19-23` `read_u64` — `bytes[offset..offset + 8]`, a panicking
  index. Its only bound is the exact-length gate at `:31-33`. I computed the
  offsets: the last read is `spans_offset + 24 = 100`, ending at exactly 108,
  which equals `FRAME_DESCRIPTOR_BYTES`. The margin is zero bytes.
- `sample.rs:42-45` is the one decoder that cannot drift: it uses
  `payload.get(..SAMPLE_PREFIX_BYTES)`, which is non-panicking, and
  `SAMPLE_PREFIX_BYTES` (`:24`) is derived from `WIRE_V2_HEADER_BYTES` rather
  than written as a literal, so the `copy_from_slice` widths at `:48`, `:51`,
  `:54`, `:57`, `:60` track it.

Allocation: none of the three decoders allocates. Every intermediate is a
fixed-size array or a `Copy` struct. The first allocation driven by an
attacker-declared length is `lease.rs:178-179`, `vec![0u8; self.body_len]`, and
its bound is entirely the decoder's `body_len > MAX_FRAME_BYTES` rejection
(`descriptor.rs:238-240`, `sample.rs:103-105`) against `MAX_FRAME_BYTES` = 64
MiB (`arena.rs:4`).

## Failure scenario

Three shapes, none of which the current tests would catch.

1. An offset constant in `harness.rs` is edited upward without the matching
   change to `FRAME_DESCRIPTOR_BYTES`. `read_u64` then indexes past 108 and
   panics on *every* 108-byte input, including the corpus `valid` seed. This
   one is loud, because the corpus replay would fail immediately.
2. `GRANT_BYTES` is reduced — say a field is narrowed — without updating
   `decode`. The range index at `ring.rs:426` panics on every call. The failure
   is not input-dependent, so a fuzz campaign reports it as a crash on the
   first execution rather than as a malformed-input finding.
3. The `body_len <= MAX_FRAME_BYTES` guard is relaxed or reordered below the
   point where `body_len` is used. `lease.rs:179` then allocates whatever the
   peer declared, up to `u64::MAX` truncated to `usize`. Nothing between the
   descriptor field and the `vec!` re-checks the bound.

## Timing windows and dependencies

No timing window: all three decoders are pure functions over one immutable byte
slice, which is what `harness.rs:1-6` claims and what I confirmed — no file
descriptor, mapping, or thread effect in any of them. The dependencies are
compile-time constants: `WIRE_V2_HEADER_BYTES` and `MAX_SPANS`
(`descriptor.rs:10`, `:12`), `GRANT_BYTES` (`ring.rs:29`), `MAX_FRAME_BYTES`
(`arena.rs:4`). Two of the three width constants are derived from those and one,
`GRANT_BYTES`, is an independent literal. This record is the precondition for
`accepted-decode-consumes-its-declared-width`: exact-consumption reasoning is
only meaningful once every input is known to terminate in accept or reject.

## What a test must construct

No fault injection. Three additions to what exists. First, a length sweep over
`0..=2 * width` for each decoder rather than the ten sampled lengths at
`tests/contract.rs:743-768`, with several fill patterns and with structured
mutation of an accepted seed — the current sweep uses only `0x00` and `0xff`,
and neither reaches the arithmetic guards. Second, static assertions binding
each width constant to the sum of its field widths, so a narrowed field is a
compile error rather than a runtime index panic. Third, an allocation oracle:
assert that no accepted decode causes an allocation larger than
`MAX_FRAME_BYTES`, which requires observing `lease.rs:178` rather than the
decoder. Coverage check to emit: `shm_decode_reached_accept_path` per decoder,
so a campaign that only ever rejects is visible as such.

## Investigation log

### Q: Is any panic site reachable from arbitrary bytes at HEAD?

- Sources examined: `harness.rs` in full; `backend/ring.rs:410-488`;
  `backend/sample.rs:41-126`; `descriptor.rs:207-308`; `arena.rs:4`, `:44-70`;
  `lease.rs:178-179`; `tests/contract.rs:743-768`; `tests/fuzz_corpus.rs` in
  full.
- Findings: no, not at HEAD. I computed the harness offsets by hand and by
  program: schema `0..2`, wire header `2..23`, incarnation `23..39`, lane
  `39..43`, sequence `43..51`, body length `51..59`, allocation start `59..67`,
  allocation length `67..75`, span count `75`, spans `76..108`. The final byte
  read is index 107 and the gate admits exactly 108, so every `read_u64` is in
  bounds. The three `.expect()` calls in `ring.rs::decode` are on constant
  eight-, sixteen-, and four-byte ranges of a 58-byte array and are infallible.
  The accept-path `.expect()` calls in `harness.rs:81-87` are guarded by
  `validate`: `span(index)` is `Some` for `index < span_count`
  (`descriptor.rs:361-363`), and the two `checked_add`s cannot overflow because
  `validate` already bounded `spans[0].offset + spans[0].len <= arena_bytes`
  (`descriptor.rs:255-261`) and forced `spans[1].offset == 0` with
  `spans[1].len <= arena_bytes` (`:276-285`).
- Missing evidence: nothing for the reachability question. What is missing is
  any statement of the invariants that keep it true. `GRANT_BYTES` is a literal
  with no static tie to its field widths, and the harness offsets have zero
  slack against their length gate, so both are one edit away from an
  unconditional panic that no property currently forbids.
- Conclusion: resolved with answer. Totality holds at this commit and rests on
  three hand-maintained constants and one zero-margin offset computation. The
  record exists because the reasoning lives nowhere in the tree, and because
  the existing evidence — a ten-length two-fill sweep — is far weaker than the
  claim it is taken to support.
