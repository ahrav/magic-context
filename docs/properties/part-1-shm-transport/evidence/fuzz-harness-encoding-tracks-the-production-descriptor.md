# fuzz-harness-encoding-tracks-the-production-descriptor

## Discovery trigger

`src/harness.rs` decodes a frame descriptor out of a byte slice at hand-written
offsets, but production never decodes descriptor bytes at all — it reads a
`#[repr(C)]` struct out of the mapping and converts it field by field. So the
fuzz target's 108-byte encoding is a harness-private shape with no counterpart in
the object. That is defensible if the byte-to-field map covers the field space
production can present. Checking whether it does turned up two answers: the map
is exactly a bijection, and the call convention around it pins two of the three
inputs to constants.

## Evidence trail

The arithmetic, which I computed by hand and confirmed with a program that
replicates the struct definitions:

- `harness.rs:16-17` defines `FRAME_DESCRIPTOR_BYTES = 2 + WIRE_V2_HEADER_BYTES
  + 16 + 4 + 8 + 8 + 8 + 8 + 1 + 32`. With `WIRE_V2_HEADER_BYTES = 21`
  (`descriptor.rs:10`) that is 108.
- `size_of::<SharedDescriptor>()` (`backend/ring.rs:57-71`) is **120**, alignment
  8, so 12 bytes are padding: one byte at offset 39, four at `44..48`, seven at
  `81..88`.
- Production field offsets inside that struct: `schema_version` 0,
  `wire_header` 2, `incarnation` 23, `lane` 40, `sequence` 48, `body_len` 56,
  `allocation_start` 64, `allocation_len` 72, `span_count` 80, `span_offsets`
  88, `span_lengths` 104.
- Harness byte offsets (`harness.rs:34-62`): schema `0..2`, wire header `2..23`,
  incarnation `23..39`, lane `39..43`, sequence `43..51`, body length `51..59`,
  allocation start `59..67`, allocation length `67..75`, span count `75`, spans
  `76..108`.

Only the first three regions coincide. Every field from `lane` onward sits at a
different offset, and the span region is laid out differently in kind: the
harness reads it interleaved as offset, length, offset, length (`:53-62`), while
the struct groups it as `span_offsets: [u64; 2]` then `span_lengths: [u64; 2]`
(`:69-70`).

None of that is a defect, because no production reader ever sees either byte
shape as bytes. `SharedDescriptor::snapshot()` (`ring.rs:88-106`) converts named
fields into a `FrameDescriptor`, and its two call sites are the typed reads at
`ring.rs:802-804` and `ring.rs:1125-1128`. What matters is coverage of the field
tuple, and there the map is exact: the ten field widths total
`16 + 168 + 128 + 32 + 4 * 64 + 8 + 256 = 864` bits, and 108 bytes is 864 bits.
Every field's full domain is reachable and no input bit is wasted, so fuzzing the
108-byte encoding is coverage-equivalent to fuzzing the typed struct's named
fields.

The call convention is where coverage is lost. `validate` takes three inputs —
`self`, `expected`, and `arena_bytes` (`descriptor.rs:332-336`) — and in
production all three are independent: the descriptor is peer-controlled, while
`expected` is built from the grant and the local cursor (`ring.rs:803`,
`:1126`) and `arena_bytes` comes from the grant. The harness collapses two of
them. `harness.rs:76` passes `identity`, which is the *decoded* identity built at
`:63`, so on the accept path the three identity comparisons at
`descriptor.rs:354-362` are satisfied by construction. The reject path at
`:98-102` supplies one foreign identity, differing only in `lane ^ 1`, which
reaches the lane guard at `descriptor.rs:357-359` and therefore never reaches the
incarnation guard at `:354-356` or the expected-sequence guard at `:360-362`. The
same collapse is in `provider_sample`: `harness.rs:132` passes
`prefix.identity()` and `:149-153` flips only the lane. `arena_bytes` is pinned
to `MAX_FRAME_BYTES` at `harness.rs:76`, which is the gap
`validated-spans-are-disjoint-and-inside-the-arena` already owns.

Existing checks. The width constant is derived from `WIRE_V2_HEADER_BYTES`, and
`MAX_SPANS` is coupled by type: the two-element array literal at `harness.rs:53`
would fail to compile if `MAX_SPANS` changed, as would `from_untrusted`'s
argument list if a field were added. `tests/contract.rs:683-708` sweeps
`FRAME_DESCRIPTOR_BYTES` and `FRAME_DESCRIPTOR_BYTES + 1`. Nothing asserts that
the sum of the read regions equals the constant, and nothing asserts the
incarnation and sequence guards are reachable from the fuzz target.

## Failure scenario

The 12 padding bytes are the shape the encoding cannot represent, and they are
the one part of the shared descriptor with no decode contract at all.
`commit_reservation` builds a `SharedDescriptor` as a struct literal
(`ring.rs:1183-1195`) and writes it whole with `write_volatile` at `:1204`, so
the padding bytes in the mapping take whatever the source location held.
`snapshot()` reads only named fields, so no reader can be influenced by them.
That makes the padding harmless today and structurally unlike the grant's four
reserved bytes, which `decode` requires to be zero
(`ring.rs:430-432`). The failure shape is a future layout version that starts
using one of the three padding runs: the fuzz corpus has no bit for it, the
harness constant would not change, and the new field would be exercised by
nothing.

The offset drift shape is separate and sharper. Because the harness offsets are
independent literals rather than derived from the field list, a reordering that
preserves the total — swapping the `body_len` and `allocation_start` reads, for
instance — keeps the length gate satisfied, keeps every `read_u64` in bounds, and
keeps the bit count at 864. The seeds decide whether anything notices. The
checked-in `valid` seed carries `body_len` 8 and `allocation_start`
`MAX_FRAME_BYTES - 4`, so that particular swap would break it and
`tests/fuzz_corpus.rs:33-35` would fail; a seed whose two fields agreed would
not.

## Timing windows and dependencies

No timing window; this is a static agreement between a constant, a set of read
offsets, and a struct definition. Dependencies are `WIRE_V2_HEADER_BYTES` and
`MAX_SPANS` (`descriptor.rs:10`, `:12`), the argument list of
`FrameDescriptor::from_untrusted` (`:309-318`), and the field list of
`SharedDescriptor` (`ring.rs:57-71`). This record sits with
`one-profile-name-denotes-one-geometry` and
`negative-tests-fail-for-their-stated-reason` in the cluster where one value is
maintained in several places and a stale copy silently weakens a test. It is
distinct from `accepted-decode-consumes-its-declared-width`, which asks whether
the declared 108 bytes are fully consumed; this record asks whether 108 is the
right number and whether the three inputs are varied.

## What a test must construct

No fault injection. Four things. Assert `FRAME_DESCRIPTOR_BYTES` equals the sum
of the widths of the fields `from_untrusted` accepts, as a static assertion, so
the constant cannot go stale. Assert per-byte influence: flip one bit at each of
the 108 positions in an accepted seed and require the decoded tuple to change or
the input to be rejected, which pins the offsets against reordering in a way no
seed-dependent check can. Decouple the identity input: derive `expected` from
part of the fuzz input rather than from the decoded descriptor, so the
incarnation and expected-sequence guards become reachable — today they are
covered only by the tabled unit cases at `tests/contract.rs:63`. And state the
padding's status, either as a declared reserved region that must be zero, in
which case the encoding needs 120 bytes and the corpus needs regenerating, or as
explicitly meaningless, in which case a comment at `ring.rs:1204` should say so.
Coverage checks to emit: `shm_fuzz_expected_identity_differed_in_incarnation` and
`shm_fuzz_expected_identity_differed_in_sequence`, both of which are independent
preconditions rather than violations, so they fire on a correct decoder and
witness that the campaign is exploring the two-input space.

## Investigation log

### Q: Is the 108-byte encoding coverage-equivalent to the 120-byte struct?

- Sources examined: `harness.rs` in full; `backend/ring.rs:57-71`, `:88-106`,
  `:109-115`, `:142-184`, `:802-804`, `:1125-1130`, `:1183-1204`,
  `:1598-1618`; `descriptor.rs:8-12`, `:291-301`, `:309-336`;
  `tests/contract.rs:46-59`, `:63`, `:683-708`; `tests/fuzz_corpus.rs` in full;
  `fuzz/corpus/frame_descriptor/valid` decoded field by field.
- Findings: yes for the field tuple, no for the call convention. The bit count is
  exactly 864 either way, so the byte-to-field map is a bijection and no field
  domain is unreachable. I confirmed `size_of::<SharedDescriptor>() = 120` and
  the eleven field offsets by running a program that replicates the struct, and
  cross-checked the result against the checked-in grant seed: its `total_bytes`
  is `0x0400_4000` = 67,125,248, which `Layout::new(32, 64 MiB)` reproduces only
  if `size_of::<DescriptorSlot>()` is 256, which in turn requires the 120-byte
  descriptor. The seed is accepted by
  `tests/fuzz_corpus.rs`, so the arithmetic is confirmed by a passing test and
  not only by my program. The call-convention collapse is the real finding:
  `expected` is the decoded identity on the accept path and differs only in one
  lane bit on the reject path, so two of the five identity guards are never
  exercised by either fuzz target.
- Missing evidence: nothing for the equivalence question. What is missing is any
  assertion of it — no static tie between the constant and the field list, no
  per-byte influence check, and no statement anywhere that the harness encoding
  is deliberately not the shared struct's byte image.
- Conclusion: resolved with answer. The encoding is adequate and the constant is
  correct at this commit. The record exists because the adequacy rests on a bit
  count nobody has written down, because the offsets are literals with
  seed-dependent protection, and because the fuzz targets vary one of `validate`'s
  three inputs while production varies all three.
