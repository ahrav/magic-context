# accepted-decode-consumes-its-declared-width

## Discovery trigger

`harness::provider_grant` asserts that an accepted grant re-encodes to the
identical input bytes, and the doc comment calls that "proving exact consumption
with no ignored or defaulted region". That is the strongest oracle anywhere in
the decode surface, so the question is what it actually establishes and whether
the other two decoders have anything equivalent. They do not, and the three
decoders do not even share one length policy: two demand an exact width and the
third accepts a prefix plus declared body and deliberately ignores the rest.

## Evidence trail

Three different length contracts, all in `crates/mc-shm-transport`:

- `RingGrant::decode_slice` (`backend/ring.rs:456-459`) converts the slice with
  `bytes.try_into()`, so anything other than 58 bytes is `InvalidGrant`.
  Truncation and suffix are both rejected. The four reserved bytes must be zero
  (`:426-428`) and `encode` writes them as zero (`:415`).
- `harness::frame_descriptor` (`harness.rs:31-33`) rejects any length other than
  `FRAME_DESCRIPTOR_BYTES`. Exact width, both directions.
- `SamplePrefix::snapshot` (`backend/sample.rs:41-45`) accepts any payload at
  least `SAMPLE_PREFIX_BYTES` long and reads only the prefix; bytes past it are
  never inspected here. `validate` then rejects only when
  `SAMPLE_PREFIX_BYTES + body_len > allocation_len` (`:116-121`). Allocation
  bytes past the declared body are documented capacity slack (`sample.rs:4-7`,
  `:78-82`) and are excluded from `body_range()` (`:153-157`).

What the round-trip assertion at `harness.rs:112-116` proves. `decode` reads all
54 non-reserved bytes into seven fields with no lossy transform, and `encode`
(`ring.rs:406-417`) writes exactly those seven fields back plus four zero bytes.
So the assertion establishes two things as a tripwire: every one of the 58 input
bytes is either bound to a decoded field or pinned to a constant, and no byte is
read-and-discarded or defaulted on the way out. It also catches a widened length
policy, because `encode` returns 58 bytes and the comparison is against the full
input slice — a decoder that accepted 59 bytes and ignored the last would fail
the length half of `assert_eq!`.

What it does not cover. It says nothing about whether the decoded values are
legal; that is `checked_layout` (`ring.rs:461-478`), a separate concern with its
own tests. It never evaluates on a short input, because `try_into` rejects
before the assertion — truncation is covered instead by
`tests/ring.rs:487-492`. It cannot detect a *reordering* of two same-width
fields, since encode and decode would move together. And it has no counterpart
for the other two decoders: `FrameDescriptor` has no encoder anywhere in the
library, so the 108-byte encoding exists only as read offsets inside
`harness.rs`, and `SamplePrefix` cannot have a byte-exact oracle at all because
its contract permits trailing slack.

Existing checks. `tests/ring.rs:479-509`
`grant_slice_rejects_every_truncation_point_and_one_byte_suffix` sweeps every
`cut in 0..58` (`:487-492`), a one-byte suffix (`:494-499`), and empty (`:500-504`).
`tests/ring.rs:512` `golden_grant_fixture_matches_the_frozen_ring_profile_encoding`
re-asserts the round-trip on one fixture (`:529-533`).
`tests/iceoryx.rs:164`, deleted with the backend by `0f336d3c` and resolving
against `9c1eb4d1`, covered the sample policy properly: every truncation point
below the prefix yields `Truncated` (`:180-186`), every truncation inside the
declared body yields `InvalidAllocation` (`:187-194`), and a one-byte suffix is
asserted *accepted* with `body_range()` unchanged (`:196-206`). Nothing asserts
the frame-descriptor encoding consumes its declared width.

## Failure scenario

The uncovered direction is the frame descriptor. Suppose an offset constant in
`harness.rs` is changed so that a region is read twice and another is never read
— for instance `body_len` and `allocation_start` both taken from
`lane_offset + 12`. The length gate still admits exactly 108 bytes, every
`read_u64` stays in bounds, `validate` still runs, and the corpus `valid` seed
still decodes to a consistent tuple because in that seed the two fields differ.
Actually it would then fail `validate`, so the corpus test catches this one seed
— but a seed where the two fields coincide would pass, and 32 bytes of the input
would no longer influence any decision. The fuzz campaign would keep reporting
coverage over a byte range that has become inert, and nothing would say so.

The sample decoder has the mirror risk. If `validate` stopped bounding
`body_end` against `allocation_len` (`sample.rs:119-121`), the declared body
would extend past the allocation and `body_range()` would name bytes outside it.
`harness.rs:136-139` does assert `range.end <= bytes.len()`, so the fuzz target
covers this; the production caller's equivalent is
`tests/iceoryx.rs:78-106`, deleted by `0f336d3c`.

## Timing windows and dependencies

No timing window; all three are pure byte decoders. The dependency is on the
width constants and on which of them is derived: `SAMPLE_PREFIX_BYTES`
(`sample.rs:24`) and `FRAME_DESCRIPTOR_BYTES` (`harness.rs:16-17`) are computed
from `WIRE_V2_HEADER_BYTES`, while `GRANT_BYTES` (`ring.rs:29`) is an
independent literal. This record depends on
`decoder-totality-over-arbitrary-bytes`: exact consumption is only meaningful
for inputs that terminate. It is distinct from
`fuzz-harness-encoding-tracks-the-production-descriptor`, which asks whether the
108-byte shape corresponds to anything production reads; this record asks only
whether the declared width is fully consumed.

## What a test must construct

No fault injection. Three additions. First, a byte-influence oracle for the
frame descriptor: for each of the 108 positions, flip one bit in an accepted
seed and assert the decoded field tuple changes or the input is rejected. A
position where neither happens is an ignored region. That is the property the
grant gets for free from its encoder and the descriptor cannot get any other
way. Second, extend the same oracle to the grant's 58 positions, which
strengthens the current one-fixture round-trip into a per-byte claim and covers
reserved bytes 55 through 57 that `tests/ring.rs:402-403` leaves untouched.
Third, a policy assertion per decoder stating which of exact-width or
prefix-plus-slack it implements, so a future change from one to the other fails
a test instead of silently widening acceptance. Coverage check to emit:
`shm_decode_accepted_with_trailing_slack`, which fires only for the sample
decoder and must never fire for the other two.

## Investigation log

### Q: Can the grant round-trip assertion ever fail on an accepted input at HEAD?

- Sources examined: `harness.rs:110-121`; `backend/ring.rs:406-417`, `:425-459`,
  `:461-478`, `:29`; `tests/ring.rs:470-544`; `backend/sample.rs:41-126`;
  `tests/iceoryx.rs:164-229`, `:78-106` (deleted by `0f336d3c`, resolving against
  `9c1eb4d1`); `tests/contract.rs:548-596`.
- Findings: no. `encode` and `decode` are exact inverses over the seven fields
  at HEAD, and the reserved region is constrained to the one value `encode`
  emits, so the assertion is a tautology on every accepted input. That is not a
  criticism — it is the correct shape for a regression tripwire — but it does
  mean the assertion discovers nothing during a campaign and can only fire after
  a source edit makes the two functions disagree. I also confirmed that the
  length half of the comparison is load-bearing: `encode` yields `[u8; 58]`, so
  any widened acceptance in `decode_slice` would fail on length alone.
- Missing evidence: no byte-influence oracle exists for either the frame
  descriptor or the sample prefix, and none for the grant beyond the tautology.
  The reserved-byte test perturbs only index 54.
- Conclusion: resolved with answer. Exact consumption holds for all three
  decoders under their own stated policies, and the policies differ by design.
  The record exists because only one of the three has any oracle for it, that
  oracle cannot fail without a source change, and the policy differences are
  stated in prose comments rather than asserted anywhere.
