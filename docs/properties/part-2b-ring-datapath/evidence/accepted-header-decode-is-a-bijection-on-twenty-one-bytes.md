# accepted-header-decode-is-a-bijection-on-twenty-one-bytes

Carried into this sub-part from the superseded `part-2b-wire-and-channels`,
where it was record 2 of `_lenses/lens-a-wire-format.md` (`L243-290`). **Every
citation in this record was re-verified against `HEAD` = `e447c927` at carry
time and none needed repair**, which makes it the only one of the four carried
records that survived the refactor with an intact reference set.

## Discovery trigger

`encode` and `decode_header` are two independently hand-written offset maps over
the same 21 bytes. Nothing in the type system, and no assertion anywhere in the
tree, ties them together. The module header at `wire.rs:16-18` promises a frozen
prefix and by extension a stable layout, and that promise is only as strong as
the agreement between two lists of literal ranges.

## Evidence trail

**The two offset maps, printed side by side at carry time.**

| Field | `encode` writes | `decode_header` reads |
| --- | --- | --- |
| `len` | `buf[0..4]` (`:207`) | `bytes[0], [1], [2], [3]` (`:319`) |
| `ver` | `buf[4]` (`:208`) | `bytes[4]` (`:310`) |
| `ty` | `buf[5]` (`:209`) | `bytes[5]` (`:321`) |
| `flags` | `buf[6]` (`:210`) | `bytes[6]` (`:322`) |
| `channel` | `buf[7..9]` (`:211`) | `bytes[7], [8]` (`:343`) |
| `epoch` | `buf[9..13]` (`:212`) | `bytes[9], [10], [11], [12]` (`:344`) |
| `corr` | `buf[13..21]` (`:213`) | `bytes[13]`..`[20]` (`:355-357`) |

`encode` is `wire.rs:205-215`, inside the `impl EnvelopeHeader` block opened at
`:203`. Its buffer is `[0u8; HEADER_LEN]` (`:206`) and
`HEADER_LEN` is 21 (`:28`). The seven written ranges cover `0..21` with no gaps
and no overlaps: 4 + 1 + 1 + 1 + 2 + 4 + 8 = 21. The seven read ranges are the
same seven, written independently as separate expressions. Both endianness
directions use `to_le_bytes` and `from_le_bytes` respectively, matching the
module header's "Little-endian" at `:16`.

**Nothing couples them.** There is no offset table, no `const` array of field
positions, no `#[repr(C)]` struct overlay, and no test that asserts the decode
side's offsets. The coupling is the literal text of two functions eleven lines
apart.

**What the existing tests do and do not cover.**

- `little_endian_and_frozen_prefix_layout` (`wire.rs:703-719`) is the strongest.
  It builds a header, calls `encode`, and asserts each of the seven ranges
  against distinctive values: `&buf[9..13] == &[7, 8, 9, 10]` at `:716` and
  `&buf[13..21] == &[11, 12, 13, 14, 15, 16, 17, 18]` at `:717`, then
  `buf.len() == HEADER_LEN` at `:718`. Because the values ascend and are
  distinct, a transposition inside `epoch` or `corr` would fail this test today.
  **But it asserts on `encode` only.** No assertion in it touches
  `decode_header`, so a drifted read offset passes.
- `round_trip_request` (`:680-690`) constructs one header, encodes, decodes, and
  asserts `h == decoded` (`:689`). One fixture.
- `round_trip_all_frame_types` (`:693` onward) loops `0u8..=11` over frame types
  and round-trips each. Twelve fixtures, varying only `ty`.

So the encode-direction offsets are pinned with distinctive values, the
decode-direction offsets are pinned by nothing, and the round-trips would pass
under any pair of *mutually consistent* offset maps, including a wrong one.

**Nothing asserts that decode stops at 21.** `decode_header` takes `&[u8]` and
gates on `bytes.len() < need`, a lower bound only. A longer slice is accepted and
the bytes past 20 are never read, which is correct, but no test appends trailing
bytes and asserts the result is unchanged. In practice all three production
callers pass exactly 21 bytes (see the reachability note in `catalog.md`), so the
trailing-byte case is currently structural rather than live.

**Reachability.** Decode direction: the three production `decode_header` call
sites, `ring_transport.rs:503`, `ring_transport.rs:730` and `client.rs:1978`.
Encode direction: `EnvelopeHeader::encode` at `wire.rs:205`, reached from
`encode_owned_frame`, whose `EnvelopeHeader { .. }.encode()` chain is `:584-593`
with the call at `:593`, and from `encode_split_frame`, whose chain is `:622-631`
with the call at `:631`, plus that function's small-body delegation to
`encode_owned_frame` at `:615`. Those two encoders are called from
`dispatch.rs:292`, `:329`, `:723`, `:802`, `:1458`, `connection.rs:779`, `:866`,
`client.rs:1329` and `:2092`. None is `cfg`-gated.

## Failure scenario

A same-width transposition that both directions share. Concretely: someone
reorders the struct fields and updates `encode` to write `epoch` before
`channel`, then updates `decode_header` to read them in the same swapped order.
Every existing test still passes, because every one of them round-trips through
both functions. `little_endian_and_frozen_prefix_layout` would catch it, but only
because its fixture happens to use ascending distinctive values, and it asserts
`encode` alone, so the mirror-image error — decode reading `epoch` from `7..9`
while `encode` still writes `channel` there — is invisible to it as well.

The consequence is not a local bug. It is an interoperability break with a peer
that implements the documented layout at
`docs/mc-host-wire-protocol.md:226-234`. The frame satisfies all eleven decode
gates on both sides, so nobody closes the generation; the two hosts simply
disagree about which route the frame belongs to. On the host side that lands as
a frame delivered to the wrong `(channel, epoch)`, which the routing registry
either drops as unmatched or, worse, delivers to a live occupant of a different
connection's slot.

A narrower version of the same failure is an *inert* byte: a field whose decode
range accidentally overlaps a neighbour, so one byte influences two fields and
another influences none. The round-trips still pass whenever the fixture's
overlapping bytes happen to agree.

## Timing windows and dependencies

None. Both functions are pure and total over fixed-width data. The dependency is
purely textual: two lists of literal ranges that must agree, with no mechanism
enforcing agreement.

The one cross-record dependency is on
[decode-header-is-total-over-arbitrary-bytes](decode-header-is-total-over-arbitrary-bytes.md).
That record's eleven-gate postcondition is what defines "accepted" here. This
record says nothing about rejected inputs.

## What a test must construct

Three oracles, all in-crate in `wire.rs`'s test module, all cheap.

1. **Round-trip in the decode-first direction.** For every accepted 21-byte
   input, `decode_header(bytes).unwrap().encode() == bytes`. Note the direction:
   the existing tests go encode-first from a constructed struct, which cannot
   reach a byte pattern the struct cannot represent. Decode-first starts from
   bytes and is the direction that pins the read offsets.
2. **Per-bit influence.** For each of the 168 bits in an accepted seed, flip it
   and assert the result is either a rejection or a decoded value that differs
   from the seed's. This is the oracle that catches both inert bytes and aliased
   ranges, and it is the one no existing test approximates. It is cheapest to
   write together with the totality record's structured-mutation sweep, since
   both walk the same bit space from the same seed.
3. **Trailing-byte independence.** For an accepted 21-byte seed and arbitrary
   extra bytes, `decode_header(&seed) == decode_header(&[seed, extra].concat())`.

Getting an accepted seed needs care: the eleven gates constrain flags, type,
and the channel-and-epoch pairing, so a naive arbitrary 21 bytes is almost
always rejected. The practical shape is to generate a legal `EnvelopeHeader`
through `hdr_with_epoch` (`wire.rs:654-671`), encode it, and mutate from there —
which is exactly what makes this a decode-first round-trip rather than an
encode-first one.

No fault injection, no fixture host, no CI-visible cost beyond the lib target
that no job builds.

## Investigation log

### Q: Should `encode` and `decode_header` be generated from one offset table so a transposition is impossible by construction?

- Sources examined: `wire.rs:205-216` (`encode`), `:306-368` (`decode_header`),
  `:185-201` (`EnvelopeHeader`), `:16-18` (the frozen-prefix promise),
  `:292-297` (`header_len_for_version`), `docs/mc-host-wire-protocol.md:222-234`
  (§6.1's normative offset table).
- Findings: the duplication is real and unenforced, and the normative source of
  truth is the table in §6.1 at `:226-234`, which is prose. A single in-code
  offset table would make transposition unrepresentable, and the seven ranges are
  simple enough that a `const [(usize, usize); 7]` plus two loops would express
  it. The counter-consideration is that `header_len_for_version` (`:292-297`)
  already anticipates versions with different widths, so a single flat table
  would have to be per-version, and a per-version table is a larger change than
  the transposition risk it removes. A cheaper intermediate exists and was not
  evaluated by the lens: keep both functions and add the decode-first round-trip
  plus per-bit oracle from this record, which detects the drift without
  restructuring.
- Missing evidence: whether more than one envelope version is actually planned.
  `header_len_for_version` supports exactly one (`PROTOCOL_VERSION`, `:294`) and
  the eight lens A records that enumerated version dispatch were left as salvage,
  so the question was never resolved in this catalog.
- Conclusion: needs human input. The test-side fix in this record is strictly
  cheaper and should land regardless; whether the structural fix is worth it
  depends on the version roadmap, which is not in the tree.
