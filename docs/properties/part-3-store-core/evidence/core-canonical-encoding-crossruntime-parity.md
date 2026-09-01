# core-canonical-encoding-crossruntime-parity

## Discovery trigger

`crates/mc-core/src/claim_operation.rs:1-4` opens by declaring the file "the
Rust twin of
`packages/plugin/src/features/magic-context/memory/claim-operation-contract.ts`"
and states that "Both runtimes are proven against the golden corpus". That is a
cross-runtime byte-equality claim carrying digest-fencing weight, so the first
question is whether the two implementations agree on the cases where naive
implementations diverge. The classic divergence for a JavaScript twin is object
key ordering: JavaScript's default string comparison is UTF-16 code-unit order,
which misorders astral-plane characters relative to high BMP characters,
whereas Rust's `str` ordering is UTF-8 byte order, which equals code-point
order.

## Evidence trail

The Rust side:

- `crates/mc-core/src/claim_operation.rs:12` documents "objects: keys sorted by
  Unicode code point (Rust `str` ordering)".
- `crates/mc-core/src/claim_operation.rs:124` implements it as
  `let sorted: BTreeMap<&String, &Value> = entries.iter().collect();`. `BTreeMap`
  orders by `Ord for String`, which is lexicographic over UTF-8 bytes. For
  well-formed UTF-8 this is exactly code-point order.
- `crates/mc-core/src/claim_operation.rs:86-99` escapes only `"`, `\`, and
  code points below `0x20`, the last as lowercase `\u00xx` via
  `write!(out, "\\u{:04x}", c as u32)` at `:93`.
- `crates/mc-core/src/claim_operation.rs:66-84` is the number vocabulary: an
  i64 path range-checked to `±MAX_SAFE_INTEGER` at `:68-70`, a u64 path bounded
  at `:72-78`, and an f64 path at `:79-83` rejecting non-finite, fractional,
  and out-of-range values.

The TypeScript side, read to confirm rather than assume:

- TS `:51-52` carries the comment "Unicode code-point comparison (== UTF-8 byte
  order, unlike JS `<` which compares UTF-16 code units and misorders
  astral-plane keys)".
- TS `:53-63` defines `compareCodePoints`, which spreads both strings into code
  points with `[...left]` and compares `codePointAt(0)` pairwise (TS `:58-60`),
  falling back to length at TS `:62`.
- TS `:120` uses it: `Object.keys(record).sort(compareCodePoints)`. So the
  agreement with Rust is deliberate, not accidental.
- TS `:102` rejects non-safe integers with `Number.isSafeInteger`.
- TS `:107-108` notes `String(-0) === "0"` so negative zero normalises.
- TS `:66-78` defines `isWellFormedUnicode`, and TS `:81-83` throws for a
  string containing a lone surrogate.
- TS `:115-118` throws for an object whose prototype is neither
  `Object.prototype` nor null.

The fixture pins the discriminating case. Decoding the `astral-key-order` entry
in
`packages/plugin/src/features/magic-context/memory/fixtures/claim-operation-contract-v1.json`
gives keys `U+0041` (`A`), `U+FFFD`, and `U+1F600` with the pinned canonical
output `{"A":3,"\u{FFFD}":1,"😀":2}`. That is code-point order
(0x41 < 0xFFFD < 0x1F600). UTF-16 code-unit order would place `😀` second,
because its lead surrogate is `0xD83D` (55357), which is below `0xFFFD`
(65533). So the fixture case genuinely distinguishes the two orderings, and a
regression to a naive sort on either side would fail it.

Fixture breadth, enumerated: 5 `canonicalization` cases
(`scalars-and-key-order`, `unicode-and-escapes`, `astral-key-order`, `numbers`,
`nesting`) and 2 `invalidCanonical` cases (`float` = `1.5`,
`beyond-safe-integer` = `9007199254740993`).

## Failure scenario

A refactor replaces the `BTreeMap` collect at
`crates/mc-core/src/claim_operation.rs:124` with a `Vec` plus a sort that uses
some other comparator, or the TypeScript side loses `compareCodePoints` in a
lint-driven simplification to a bare `.sort()`. Either change produces different
canonical bytes for an object whose keys straddle the BMP/astral boundary.

Different canonical bytes mean a different SHA-256 through
`protocol_digest` (`claim_operation.rs:158-161`), and therefore a different
`compute_claim_operation_request_digest` (`:164-166`). The consequences follow
the digest's two jobs. First, replay detection: the intent ledger stages a
command under its request digest
(`ClaimIntentStageRequest`, `:405-413`), so the same semantic command retried
after a lost response computes a different identity in the other runtime and is
staged a second time instead of being recognised as a replay. Second, the
mutation-token fence: `compute_claim_mutation_token_digest` (`:264-268`)
digests the token's seven fields, so a fence computed by one runtime and
checked by the other mismatches and a legitimate mutation is rejected.

The failure only manifests for keys in the discriminating region, which is why
a corpus that covers only ASCII keys would not see it. The existing fixture
does cover it, which is the strength this record exists to preserve.

## Timing windows and dependencies

None. This is a cross-runtime equivalence over pure functions, not a race. No
fault injection, no interleaving, no clock.

The dependency worth naming is on the fixture-generation workflow: the corpus is
shared by both runtimes, so a case added on one side must be regenerated for
the other. That is a process dependency rather than a runtime one.

## What a test must construct

A differential generator, not a fixed list. The fixture already carries the
hand-picked discriminating cases; the property test should widen coverage:

1. Object keys drawn from the discriminating regions: `U+E000`..`U+FFFF`
   (high BMP, single UTF-16 unit) and `U+10000`+ (astral, surrogate pair), plus
   pairs that share a prefix and differ only past it, plus keys where one is a
   prefix of the other (to exercise the length fallback at TS `:62` and the
   `BTreeMap` shorter-is-less rule).
2. Integers at exactly `MAX_SAFE_INTEGER`, `-MAX_SAFE_INTEGER`,
   `MAX_SAFE_INTEGER + 1`, `-(MAX_SAFE_INTEGER + 1)`, `0`, `-0`, and floats
   with zero fraction such as `1e3` and `-1e3`.
3. Strings containing every code point below `0x20`, `U+007F`, `U+2028`,
   `U+2029`, `"`, `\`, and astral text.
4. Nested arrays and objects to depth 3 or more, since `encode_canonical_value`
   recurses at `:119` and `:132`.
5. Restrict the comparison to values Rust can represent. Rust `&str` cannot
   hold a lone surrogate, so the TypeScript-only rejection at TS `:81-83` has
   no Rust counterpart and is not a divergence. Likewise TS `:115-118`
   (non-plain prototypes) has no `serde_json::Value` analogue.
6. Assert both directions: equal output bytes when both accept, and equal
   accept/reject verdicts.

Semantics: `always`. Every staged command digests through this path, so the
equivalence must hold at every evaluation. There is no optional path and no
situation to reach, only an input domain to cover.

## Investigation log

### Q: Is the `U+FFFD` key in the `astral-key-order` fixture deliberate?

- Sources examined: the decoded fixture keys (`U+0041`, `U+FFFD`, `U+1F600`),
  the pinned canonical string, TS `:66-78` (`isWellFormedUnicode`), and TS
  `:81-83` (the lone-surrogate rejection).
- Findings: `U+FFFD` is a legitimate assignable character and is an effective
  discriminator, since it sits above the surrogate range in code-point order but
  its single UTF-16 unit (65533) sits above a lead surrogate (55357). So the
  case works. The alternative reading is that an earlier generator emitted a
  lone surrogate or a `U+E000`-style private-use character and something in the
  toolchain replaced it with the replacement character. `U+E000` would
  discriminate identically, which makes the two hypotheses observationally
  equivalent from the fixture alone. Note that the TypeScript encoder would
  *throw* on a lone surrogate (TS `:81-83`), so the fixture could not have been
  generated with one in place.
- Missing evidence: the generator source and revision history for this fixture
  entry.
- Conclusion: unresolved, needs the fixture generator's history. The case
  discriminates correctly either way, so this is a maintenance clarity concern
  rather than a correctness one. Recording it so a future editor does not
  "clean up" the replacement character and silently destroy the discriminating
  power of the case.

### Q: Is the two-case rejection surface (`invalidCanonical`) intended to be that narrow?

- Sources examined: the fixture's `invalidCanonical` array (`float` = `1.5`,
  `beyond-safe-integer` = `9007199254740993`),
  `crates/mc-core/src/claim_operation.rs:79-83`,
  `crates/mc-core/src/claim_operation.rs:737-747`
  (`non_canonical_numbers_are_rejected`), TS `:102-105`.
- Findings: the two cases cover the fractional path and the magnitude path,
  which are the two rejection reasons `number_as_safe_integer` can produce for
  a value JSON can express. Non-finite values cannot appear in JSON text at
  all, so the `is_finite()` check at `:80` is defensive against a
  programmatically constructed `Value` rather than against parsed input. The
  `-(MAX_SAFE_INTEGER + 1)` boundary and the u64 upper path at `:72-78` are
  untested by the fixture.
- Missing evidence: whether a programmatically constructed non-finite
  `serde_json::Number` is even representable (serde_json normally refuses to
  construct one).
- Conclusion: needs human input on whether to widen the fixture. The property
  test proposed above covers the untested boundaries regardless, which is the
  cheaper path than editing a shared cross-runtime fixture.
