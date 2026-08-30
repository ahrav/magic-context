# grant-reserved-bytes-are-rejected-unless-zero

## Discovery trigger

`RingGrant::decode` opens with a check that four bytes are zero, before it reads
any field. That is unusual enough to trace: it is the only reserved region in the
whole decode surface that carries an enforced value, and it is checked ahead of
even the layout version. The question it raises is forward-facing rather than
adversarial. If a later layout version assigns meaning to those bytes, what
happens to a reader that predates the assignment, and what happens to a reader
that decodes and re-encodes?

## Evidence trail

References are to `crates/mc-shm-transport/src/backend/ring.rs`.

- `GRANT_BYTES` is the literal `58` at `:30`. The seven encoded fields occupy
  `2 + 16 + 4 + 8 + 8 + 8 + 8 = 54` bytes, leaving `54..58`.
- `encode` (`:410-421`) writes the fields into `0..54` and then writes
  `0u32.to_le_bytes()` into `54..58` at `:419`. The write is unconditional; there
  is no field behind it.
- `decode` (`:429-457`) rejects first: `if bytes[54..58] != [0; 4] { return
  Err(RingError::InvalidGrant); }` at `:430-432`. This precedes the
  `layout_version` read at `:439` and the `checked_layout()?` call at `:455`.
- `checked_layout` (`:465-482`) is where `layout_version != LAYOUT_VERSION`
  rejects (`:466`, against `LAYOUT_VERSION = 2` at `:27`), and it returns the
  same `RingError::InvalidGrant`. Every grant rejection in this decoder collapses
  to one error variant, so a reserved-byte failure and a wrong-version failure
  are indistinguishable to the caller.

Existing checks are real and narrower than they look.

- `tests/ring.rs:392` `attach_rejects_unsealed_objects_and_tampered_grants`
  builds nine tampered grants and asserts each decodes to
  `Err(RingError::InvalidGrant)` at `:426`. One of them is the reserved case:
  `reserved[54] = 1` at `:413-414`. Bytes 55, 56, and 57 are never perturbed.
  This case genuinely pins the guard — with `:430-432` removed, that input would
  decode successfully because its `0..54` region is untouched and its geometry is
  valid — but it pins only one of the four bytes, and it asserts the shared
  category rather than a reason.
- The checked-in fuzz seed `fuzz/corpus/provider_grant/near-valid` differs from
  `valid` in exactly one place: byte 54 is `0x01` instead of `0x00`. I compared
  the two files byte by byte. So the corpus reserved case exists, and
  `tests/fuzz_corpus.rs` runs it — but `:33-35` asserts acceptance only for the
  seed named `valid` and never asserts that any seed is rejected, so the
  `near-valid` seed's outcome is unchecked. That is the same hole
  `negative-tests-fail-for-their-stated-reason` records for the corpus as a
  whole; this is the concrete instance of it.
- `harness::provider_grant` (`harness.rs:110-121`) asserts an accepted grant
  re-encodes byte-exactly (`:112-116`). Because `encode` zeroes `54..58`
  unconditionally, that assertion is what would catch a `decode` that started
  reading a field out of the reserved region without a matching `encode` change.

The contrast worth recording: the frame descriptor's shared image has an
unconstrained equivalent. `SharedDescriptor` (`:57-71`) is `#[repr(C)]`, and I
measured its layout — 120 bytes with 12 bytes of padding, at offset 39, at
`44..48`, and at `81..88`. `commit_reservation` writes the struct whole with
`write_volatile` at `:1204`, and `snapshot()` (`:88-106`) reads only the eleven
named fields. So those 12 bytes are neither given a defined value on write nor
constrained on read, which is the opposite discipline from the grant's four.

## Failure scenario

The forward-compatibility case, in two directions.

Old reader, new sender. Layout version 3 assigns a meaning to byte 54. A
version-2 reader rejects the grant at `:430-432` and never reaches the version
check, so it fails closed. That is the correct outcome and is the reason the
strict-zero rule is worth having. The cost is diagnostic: the error is
`InvalidGrant`, identical to a corrupt geometry, so an operator cannot tell "peer
speaks a newer layout" from "peer sent garbage".

New sender, old relay. Some component decodes a version-3 grant and re-encodes it
to pass along. `encode` has no knowledge of the new field and writes zeros at
`:419`, silently stripping it. The receiving end then sees a well-formed grant
with the new field cleared rather than a rejection. The only thing standing
against this is the round-trip assertion in the fuzz harness, which would fail
the moment `decode` read a reserved byte into a field that `encode` did not write
back — so the assertion is doing forward-compatibility work that its comment
does not claim.

The adversarial case is weak by comparison and worth saying so. A peer setting a
reserved byte gains nothing: the grant is rejected, and the reserved region does
not participate in geometry. The value of the guard is that it keeps the four
bytes reserved in fact rather than only in intent.

## Timing windows and dependencies

No timing window; `decode` is a pure function over a fixed-size array. The
dependencies are two hand-maintained constants and their relationship:
`GRANT_BYTES = 58` (`:30`) and the seven field widths, which sum to 54. Nothing
in the tree asserts `GRANT_BYTES - 54 == 4`, so narrowing a field would leave
five reserved bytes with only four checked, and the fifth would become an
unvalidated hole that `encode` still zeroes. This record shares the
"one value, several hand-maintained copies" shape with
`one-profile-name-denotes-one-geometry`, and its round-trip dependence puts it
next to `accepted-decode-consumes-its-declared-width`.

## What a test must construct

No fault injection. Four things. Assert each of the four reserved positions
independently — set byte 55, 56, and 57 in turn, not only 54. Assert the
rejection reason distinctly, which requires either a reserved-specific error
variant or a test that observes the guard rather than the category; today every
grant failure returns `InvalidGrant`, so a reason-specific assertion is not
possible without a source change and that is the finding. Add a static assertion
tying `GRANT_BYTES` to the field-width sum plus the reserved width. And assert
the `near-valid` corpus seed is rejected, which turns the existing seed into
evidence instead of a file that merely runs. Coverage check to emit:
`shm_grant_rejected_on_reserved_bytes`, distinct from a geometry rejection, so a
campaign can show the guard was reached.

## Investigation log

### Q: Does anything today pin the reserved-byte guard, and to what precision?

- Sources examined: `backend/ring.rs:27`, `:30`, `:410-421`, `:429-463`,
  `:465-482`, `:57-71`, `:88-106`, `:1183-1204`; `harness.rs:110-121`;
  `tests/ring.rs:392-467`, `:470-500`, `:503-544`; `tests/fuzz_corpus.rs` in
  full; both `fuzz/corpus/provider_grant/valid` and `near-valid` compared byte by
  byte.
- Findings: yes, at one-byte precision. `tests/ring.rs:413-414` is a genuine
  pin — removing `:430-432` makes that assertion fail — but it exercises only
  index 54, and it asserts the category `InvalidGrant` that eight other tampered
  cases in the same loop also expect. The corpus `near-valid` seed is the same
  case in byte form and is unasserted. I also confirmed the descriptor-side
  contrast by measuring `size_of::<SharedDescriptor>()` at 120 against the
  packed field sum of 108, so the padding claim is a measurement rather than an
  inference.
- Missing evidence: nothing for the guard's current behaviour. What is missing is
  any statement of the forward-compatibility intent. The doc comment at
  `:423-428` says decode "rejects reserved-byte tampering", which frames the
  guard as an adversarial control; the re-encode stripping hazard is the more
  likely way the four bytes cause trouble, and nothing addresses it.
- Conclusion: resolved with answer. The guard holds and is pinned at one byte out
  of four. The record exists for the forward direction: the strict-zero rule is
  the right choice for a reader, `encode`'s unconditional zeroing is the wrong
  behaviour for a relay, and the only thing currently connecting the two is a
  fuzz assertion whose stated purpose is exact consumption.
