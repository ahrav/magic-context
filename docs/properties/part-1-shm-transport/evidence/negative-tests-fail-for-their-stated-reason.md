# negative-tests-fail-for-their-stated-reason

## Discovery trigger

This property is derived from a defect that already occurred, not from a
hypothesis. Commit `daf6e244`, "fix(shm): track the ring layout total in the raw
descriptor test grant", records a test fixture that silently stopped testing what
it named. The two artifacts implicated — the addon descriptor boundary suite and
the fuzz corpus replay — were both re-read at `9c1eb4d1`.

## Evidence trail

### The realised defect

`daf6e244` (2026-08-26) describes the mechanism in its own message: the grant
image built by the raw N-API descriptor tests "hardcoded a total_bytes of arena
+ 12288, which assumed the control region ahead of the arena fit in two pages.
It now needs three, so RingGrant::decode recomputed the layout, disagreed, and
rejected the grant." It continues: "Only one test needs the grant to be valid —
the well-formed but unresolvable descriptor — so that test was the only one to
notice ... The other boundary cases expect a rejection and passed either way."

The fix introduced named geometry constants and
`GRANT_LAYOUT_OVERHEAD_BYTES = 16_384n` with a comment recording that the value
"must track `Layout::new(GRANT_DESCRIPTOR_DEPTH, GRANT_ARENA_BYTES).total`". It
added documentation, not an assertion. Nothing in the tree cross-checks the
constant against the layout it mirrors.

### Current state of the boundary suite

`packages/mc-shm-native/tests/mechanism.ts:138` opens
`describe("raw N-API descriptor boundary")` with
`DESCRIPTOR_ERROR = /invalid shared-memory descriptor/` at line 139 and a helper
`expectRejectedWithoutEffects` (lines 141-153) that defaults to that pattern.
Six cases follow:

| Line | Case | Asserted reason |
| --- | --- | --- |
| 155 | rejects non-object and structurally hostile arguments | generic `DESCRIPTOR_ERROR` |
| 178 | rejects every unsafe numeric representation before narrowing | generic `DESCRIPTOR_ERROR` |
| 214 | rejects malformed, non-ASCII, and aliased grant text | generic `DESCRIPTOR_ERROR` |
| 245 | accessor objects and proxies get one bounded redacted error | exact string equality with the generic message (line 262) |
| 278 | a wrong profile is refused before any attachment effect | `/shared-memory profile is unavailable/` |
| 288 | a well-formed but unresolvable descriptor fails without registry effects | `/shared-memory attachment failed/` |

The four generic cases cannot distinguish the rejection they name from a
grant-layout rejection, because `RingGrant::decode` failure maps to
`descriptor_error()` — the same message (`packages/mc-shm-native/src/lib.rs:500-512`).

Ordering matters here and refines the catalog's count. In `attach`, the profile
comparison is at `src/lib.rs:492`, before the two `RingGrant::decode` calls at
`:500` and `:507`. The wrong-profile case at line 278 therefore returns before
grant decode is ever reached and could not have been masked by a stale grant.
Of the six cases, four are maskable, one short-circuits earlier, and one — line
288, the only case that needs the grant to be *valid* — is the case that
detected the defect.

### Current state of the corpus replay

`crates/mc-shm-transport/tests/fuzz_corpus.rs` declares
`EXPECTED_SEEDS = ["empty", "all-zero", "all-ff", "valid", "near-valid"]`
(line 13) and replays every corpus file through the production decoder
(`replay`, lines 15-42). The only assertion on a decoder result is lines 33-35:

```rust
if path.file_name().is_some_and(|name| name == "valid") {
    assert!(accepted, "corpus seed {target}/valid must be accepted");
}
```

Nothing asserts that any seed is rejected. Lines 20-24 assert seed presence and
lines 38-41 assert the replayed count; line 36 is the counter increment, so the
catalog's `33-36` citation spans one line more than the assertion itself.

The gap is cheap to close and demonstrably real: the `empty` seed is 0 bytes in
all three corpora, and all three decoders reject a 0-byte input on structure —
`frame_descriptor` returns `false` on a length mismatch at
`src/harness.rs:31-33`, `provider_grant` returns `false` when
`RingGrant::decode_slice` errors (`:111-121`), and `provider_sample` returns
`false` when `SamplePrefix::snapshot` errors (`:128-130`). A guaranteed-rejected
seed exists in every target and no test asserts its rejection.

Three replay tests depend on this: `frame_descriptor_corpus_replays_without_panic`
(line 45), `provider_grant_corpus_replays_without_panic` (line 50), and
`provider_sample_corpus_replays_without_panic` (line 55).

## Failure scenario

A decoder change widens acceptance — a bounds check is dropped, or a length
equality becomes an inequality. Every corpus seed now decodes. `valid` is still
accepted, so lines 33-35 pass; `replayed` is unchanged, so lines 38-41 pass; no
panic occurs, so all three replay tests stay green. The corpus, whose stated
purpose is to pin decoder behaviour on hostile input, reports success on a
decoder that accepts everything.

The addon variant is the already-realised one: any fixture value that makes the
grant unconditionally invalid returns the four generic cases to green while they
exercise nothing but grant decode.

## Timing windows and dependencies

None. Both are static properties of the assertions. The realised defect
persisted for over a day purely because no assertion distinguished the intended
rejection from the accidental one; no interleaving was involved.

The dependency worth stating is directional: a fixture that duplicates
production geometry by hand (`GRANT_DESCRIPTOR_DEPTH`, `GRANT_ARENA_BYTES`,
`GRANT_LAYOUT_OVERHEAD_BYTES`) creates the maskable condition, and generic
rejection reasons make it undetectable. Either alone is survivable; together
they produce a silent degradation.

## What a test must construct

1. Per negative case in the boundary suite, a distinct expected reason. The four
   generic cases need a discriminator that the grant-decode path cannot produce
   — for example, asserting that the input which should fail on numeric
   narrowing fails *before* the grant fields are read at all.
2. A grant-fixture cross-check asserting `GRANT_LAYOUT_OVERHEAD_BYTES` equals
   the layout total the decoder recomputes, so the constant cannot drift again
   without a failure.
3. Per corpus target, at least one seed asserted rejected. `empty` is the
   zero-cost choice; a named rejection set covering `all-zero` and `all-ff`
   would be stronger, but those require establishing intent first.
4. A mutation-style control: widen a decoder's acceptance deliberately and
   assert at least one replay test fails. Without it the corpus assertions can
   pass by asserting nothing discriminating.

## Investigation log

The catalog records no open question for this property. The question resolved
during the trail is logged so the count in the catalog can be re-derived.

### Q: How many of the six boundary cases were actually masked by the stale grant, and does the corpus replay have any rejection oracle at all?

- Sources examined: `git show daf6e244` message and its diff against
  `packages/mc-shm-native/tests/mechanism.ts`; the current
  `raw N-API descriptor boundary` block (`mechanism.ts:138-299`); the `attach`
  validation order (`packages/mc-shm-native/src/lib.rs:470-548`);
  `crates/mc-shm-transport/tests/fuzz_corpus.rs` in full;
  `crates/mc-shm-transport/src/harness.rs:30-40` and `:110-135`; the corpus
  directory listings and file sizes.
- Findings: four of the six cases assert the generic descriptor message and are
  maskable; the wrong-profile case returns at `src/lib.rs:492-494`, before grant
  decode, so it is not; the unresolvable-descriptor case is the detector. The
  corpus replay has exactly one decoder-result assertion, and it is a positive
  one. A guaranteed-rejected seed (`empty`, 0 bytes) exists in all three
  corpora and is unasserted.
- Missing evidence: the decoders were not executed at `9c1eb4d1`, so the
  accept/reject verdict for `all-zero`, `all-ff`, and `near-valid` is not
  established here. Only `empty` is settled, and by structural reasoning from
  the length and snapshot guards rather than by running the test.
- Conclusion: resolved with answer, with one catalog correction. The catalog's
  "five of six boundary tests were rejecting inputs on grant-layout mismatch"
  overcounts by one; four is the maskable count, because the wrong-profile case
  short-circuits before grant decode. The commit message's "the other boundary
  cases" is the source of the five and is accurate as a statement about which
  cases did not notice.
