# core-revision-locator-roundtrip-inverse

## Discovery trigger

`format_revision_locator` (`crates/mc-core/src/claim_operation.rs:197-208`) and
`parse_revision_locator` (`:211-232`) are a declared pair: one renders
`<publicId>/r<revision>/<sha256>` and the other parses and validates it. A
render/parse pair either is a mutual inverse on its valid domain or it is a
latent bug, because the same locator string crosses a durability boundary: it is
written into an effect row and re-parsed on replay at `:564-579`. The fixture
test asserts one direction (`format(parse(s)) == s`) for each valid case and
never the other, which is the gap that made this worth recording.

## Evidence trail

`format_revision_locator`:

- `crates/mc-core/src/claim_operation.rs:198` — requires
  `is_valid_public_claim_id(&locator.public_claim_id)`.
- `:199` — requires `(1..=MAX_SAFE_INTEGER).contains(&locator.revision)`.
- `:200` — requires `is_lower_hex(&locator.content_digest, 64)`.
- `:204-207` — renders `format!("{}/r{}/{}", ...)`. Rust's integer `Display` for
  a positive `i64` never emits a leading zero and never emits a sign, so the
  rendered revision segment is always a bare digit run with a non-zero first
  digit.

`parse_revision_locator`:

- `:212-215` — splits on `/` and takes exactly three segments.
- `:216` — rejects a fourth segment and rejects an invalid public claim id.
- `:219` — strips the mandatory `r` prefix; a missing `r` yields `None` via `?`.
- `:220` — rejects an empty digit run, a leading `0`, and any non-ASCII-digit
  byte.
- `:223` — `digits.parse::<i64>().ok()?`. A digit run too long for `i64`
  overflows and is caught by `.ok()`, so there is no panic and no wraparound.
- `:224` — requires `(1..=MAX_SAFE_INTEGER).contains(&revision)` and
  `is_lower_hex(content_digest, 64)`.

The two validators are the same predicates in the same order, which is why the
pair is inverse:

| Predicate | format | parse |
| --- | --- | --- |
| public claim id shape | `:198` | `:216` |
| revision in `1..=MAX_SAFE_INTEGER` | `:199` | `:224` |
| digest is 64 lowercase hex | `:200` | `:224` |
| no leading zero in revision | implied by `Display` | `:220` |
| exactly three segments | implied by `format!` | `:212-216` |

`is_lower_hex` (`:173-178`) is shared by both directions, which is the point of
its doc comment at `:168-172`: "The claim-operation contract, the intent ledger,
and the claim mirror all fence on identities in this format. They share one
definition so a change to the length or charset cannot leave one layer accepting
IDs another rejects." Note the length check at `:174` is `text.len()`, a byte
count, but the charset check at `:176-177` restricts to ASCII digits and `a`-`f`,
so byte length equals character length for every accepted string. A multi-byte
character would fail the charset check before the byte-length check could
mislead.

`is_valid_public_claim_id` (`:181-185`) requires the literal prefix `mcm_`
(`:39`) followed by exactly 32 lowercase hex characters.

Fixture coverage, enumerated:

- `revisionLocators.valid` cases each assert `parse` succeeds, the three
  components match, and `format_revision_locator(&parsed)` reproduces the
  original string (`:761-779`). That is `format ∘ parse == id` on strings.
- `revisionLocators.invalid` has 8 entries, which cover: the empty string; an id
  with no revision or digest segment; `r0` (zero revision); `r01` (leading zero);
  `2` (missing the `r`); a 63-character digest; a trailing `/extra` fourth
  segment; and a wrong `mcl_` prefix. That is a well-chosen rejection set.
- Nothing asserts `parse ∘ format == id` on a constructed `RevisionLocator`.

## Failure scenario

The consequential direction is the untested one. Suppose a future change widens
`format_revision_locator`'s accepted revision range, or renders the revision with
padding, or the `r` prefix is changed on one side only. `format` then produces a
string that `parse` rejects.

That matters because the locator crosses a durability boundary in exactly that
direction. `decode_effect` (`crates/mc-core/src/claim_operation.rs:564-579`)
re-parses a stored `revisionLocator` and returns
`MalformedResult("result effect {index} carries an invalid revision locator")`
when the parse fails. So a locator that formats but does not parse turns a valid
stored effect row into a decode failure on replay: the write succeeds, and the
read of the same bytes by the same build fails. The result envelope becomes
undecodable, which under a fail-closed decoder means the whole replay path for
that command is lost.

The other direction fails more quietly. If `parse` accepted a string that
`format` renders differently (for example if `parse` tolerated a leading zero,
which `:220` currently forbids), then two distinct strings would denote the same
locator, and any code comparing locator strings for equality rather than
comparing parsed values would see two different identities for one revision.
`ClaimOperationResultEffect.revision_locator` (`:515`) stores the raw `String`,
not the parsed struct, so string comparison is the likely usage.

## Timing windows and dependencies

None. Both functions are pure and total, with no clock, no allocation beyond the
output string, and no panic path (`:223` catches the overflow).

Dependency: `is_lower_hex` (`:173-178`) and `is_valid_public_claim_id`
(`:181-185`) are shared with other fencing layers per the doc at `:168-172`, so a
change to either predicate affects this property and the claim-mirror layer at
once. That coupling is deliberate and is the reason the property is worth pinning
here rather than only in `mc-store`.

## What a test must construct

1. A generator over `RevisionLocator` values: `public_claim_id` from the valid
   shape plus mutations (wrong prefix, uppercase hex, 31 and 33 hex characters,
   empty); `revision` over `{i64::MIN, -1, 0, 1, 2, MAX_SAFE_INTEGER,
   MAX_SAFE_INTEGER + 1, i64::MAX}`; `content_digest` over 63, 64, and 65
   characters, all-lowercase-hex and with an uppercase or non-hex character
   injected.
2. Direction one: for every generated locator, if
   `format_revision_locator(&l)` is `Some(s)` then
   `parse_revision_locator(&s) == Some(l)`.
3. Direction two: for every generated string (including the formatted outputs and
   fuzzed mutations of them), if `parse_revision_locator(s)` is `Some(l)` then
   `format_revision_locator(&l) == Some(s.to_string())`.
4. A negative-domain agreement clause: for every generated locator,
   `format_revision_locator(&l).is_none()` if and only if the locator violates at
   least one of the three shared predicates. This catches a drift where one
   direction's validation is relaxed.
5. String mutations that specifically probe the segment structure: an extra `/`,
   a missing `/`, an empty middle segment, a segment containing a `/`-adjacent
   empty string, and a very long digit run (thousands of digits) to exercise the
   overflow path at `:223`.

Semantics: `always`. Both directions are evaluated on every effect row carrying a
locator, so the inverse relation must hold at every evaluation. There is no
optional path to guard with `always-or-unreached` and no situation to reach.

## Investigation log

### Q: Can the revision parse at `:223` panic or wrap?

- Sources examined: `crates/mc-core/src/claim_operation.rs:219-224`.
- Findings: `:220` restricts the digit run to ASCII digits and rejects an empty
  run and a leading zero, so the string handed to `parse` is a bare non-negative
  decimal. `str::parse::<i64>` returns `Err(ParseIntError)` on overflow rather
  than wrapping, and `:223` converts that to `None` with `.ok()?`. So a digit run
  of any length is safe. The subsequent range check at `:224` then rejects
  anything above `MAX_SAFE_INTEGER`, so even a successfully parsed `i64` above
  `2^53 - 1` is refused.
- Missing evidence: none.
- Conclusion: resolved with answer. No panic, no wrap. The double guard
  (`parse` overflow plus the explicit range check) is deliberate belt-and-braces
  and both layers are needed: `parse` alone would admit `i64::MAX`, and the range
  check alone would be unreachable for an overflowing string.

### Q: Does the byte-length check in `is_lower_hex` create a multi-byte hazard?

- Sources examined: `crates/mc-core/src/claim_operation.rs:173-178`.
- Findings: `:174` compares `text.len()`, which is the UTF-8 byte length, against
  `expected_len`. `:175-177` then requires every byte to be an ASCII digit or
  `b'a'..=b'f'`. Any multi-byte character contributes at least one byte outside
  that set, so the charset check rejects it regardless of what the length check
  concluded. The two checks are combined with `&&` and Rust evaluates them
  left to right, so a 64-byte string of multi-byte characters passes the length
  check and is then rejected by the charset check. No hazard.
- Missing evidence: none.
- Conclusion: resolved with answer. The byte-length check is safe here because
  the charset restriction makes byte length and character length coincide for
  every accepted input. Worth recording explicitly, because the same idiom
  written with only a length check would be a real defect and a future reader
  should not have to re-derive why this one is fine.
