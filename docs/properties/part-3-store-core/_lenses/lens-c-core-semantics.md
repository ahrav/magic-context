# Lens C: domain semantics and determinism in `mc-core` and `mc-tokenizer`

Attention focus: the claim-operation domain model, the decay curve, and
tokenizer determinism. Storage and SQL concerns are deliberately out of scope;
two sibling lenses own them.

Files read at HEAD `ed487e11`:

| File | Lines | Read |
| --- | --- | --- |
| `crates/mc-core/src/claim_operation.rs` | 878 | full |
| `crates/mc-core/src/decay.rs` | 302 | full |
| `crates/mc-core/src/lib.rs` | 338 | full |
| `crates/mc-tokenizer/src/lib.rs` | 85 | full |
| `crates/mc-tokenizer/tests/token_golden.rs` | 73 | full |

Supporting files read for cross-runtime and reachability evidence:
`packages/plugin/src/features/magic-context/memory/claim-operation-contract.ts`,
`packages/plugin/src/features/magic-context/memory/fixtures/claim-operation-contract-v1.json`,
`crates/mc-tokenizer/testdata/token-golden.json`,
`crates/mc-tokenizer/assets/claude.tiktoken`,
`crates/mc-module/src/decay_render.rs`, `crates/mc-module/src/memory_render.rs`.

## Observations

### Test inventory in `mc-core` (task item 6)

There is no `crates/mc-core/tests/` directory; `ls` reports
`No such file or directory`. All `mc-core` tests are in-crate `#[cfg(test)]`
modules, and there are three of them:

- `crates/mc-core/src/claim_operation.rs:672` — 9 `#[test]` functions
  (lines 684, 718, 737, 749, 760, 788, 803, 832, 847).
- `crates/mc-core/src/decay.rs:147` — 8 `#[test]` functions
  (lines 154, 165, 176, 186, 194, 201, 208, 246).
- `crates/mc-core/src/lib.rs:162` — 14 `#[test]` functions
  (lines 176, 186, 197, 207, 218, 228, 238, 249, 260, 280, 290, 301, 313, 325).

**31 tests total, all in-crate. Integration-test count: none found.** The
survey's "no `crates/mc-core/tests/`" reading is correct but must not be
reported as "no tests"; the crate is comparatively well covered for a pure
layer. Two of the three modules are anchored to an external golden fixture
(`claim_operation.rs:676`, `decay.rs:252`), so their strength is bounded by the
fixture corpus rather than by the assertions.

### Decay: shape, inputs, and clock source (task item 2)

`decay.rs` is four public functions over a shared kernel:

- `z_value` (`decay.rs:63-71`), private. Computes the half-life-scaled age
  `z = a / H` where `a = (compartment_index.max(1) - 1) as f64`
  (`decay.rs:65`), `p = budget_pressure.max(P_FLOOR)` (`decay.rs:67`),
  `f = 2^((imp - 50)/D)` (`decay.rs:68`), `h = (H50 * f) / p` (`decay.rs:69`).
- `tier` (`decay.rs:77-90`), a five-way step function over the boundaries
  `Z1..Z4` (`decay.rs:30-36`).
- `should_archive` (`decay.rs:95-104`), `z >= Z4 + G * o` with
  `o = anchor_overlap.clamp(0.0, 1.0)` (`decay.rs:102`).
- `rendered_tier` (`decay.rs:109-124`), returns 5 when archiving
  (`decay.rs:121`) and otherwise `tier(..).min(4)` (`decay.rs:123`).
- `compute_budget_pressure` (`decay.rs:130-145`), one forward pass summing
  `TIER_COST` for non-archived natural tiers (`decay.rs:140-142`), divided by
  the budget and floored at `P_FLOOR` (`decay.rs:144`).

**Clock source: none. There is no clock, no timestamp, and no time type
anywhere in `decay.rs`.** The only "time" input is `compartment_index: u32`, a
1-based ordinal position from newest (`decay.rs:51`, `decay.rs:75`). The
module doc calls this "compartment age" (`decay.rs:6`), which is ordinal age,
not elapsed wall-clock time. Nothing in the file reads `SystemTime`,
`Instant`, or an injected clock; there is no `use std::time` import. The
result is therefore **reproducible for a fixed input tuple**
`(compartment_index, importance, budget_pressure, anchor_overlap)`: the
functions are pure `f64` arithmetic with no interior mutability, no ambient
state, and no allocation.

Two qualifications on that reproducibility:

1. The reproducibility is *intra-implementation*, which is exactly what the
   module doc claims (`decay.rs:17-19`): same code, same inputs, same result.
   Bit-exact agreement with the TypeScript reference is a development
   cross-check via `decay_golden_matches_reference` (`decay.rs:246`), not a
   runtime invariant. The doc states this explicitly and the code matches.
2. `2f64.powf` (`decay.rs:68`) is not guaranteed bit-identical across libm
   implementations by the Rust standard library. On a fixed target and
   toolchain it is stable, but a cross-platform bit-exactness claim about
   `powf` is not established by anything I read. Recorded as an open question
   rather than asserted either way.

Boundary behaviour, verified by running the extracted kernel in a scratch
program outside the repository (see
`evidence/core-decay-newest-compartment-tier-floor.md` for the transcript):

| Input | Result | Note |
| --- | --- | --- |
| `index = 0` | `z = 0`, `tier = 1` | `.max(1)` (`decay.rs:65`) silently maps out-of-domain 0 to newest |
| `importance` outside `1..100` | clamped (`decay.rs:57-59`) | total, saturating, `i32::MIN`/`i32::MAX` safe |
| `budget_pressure = NaN` | `p = 0.1` | `f64::max` returns the non-NaN operand |
| `budget_pressure <= 0` or `-inf` | `p = 0.1` | floored |
| `budget_pressure = +inf`, `index = 1` | `z = 0.0/0.0 = NaN`, `tier = 5` | **breaks the "newest is tier 1" invariant** |
| `budget_pressure = +inf`, `index >= 2` | `z = +inf`, `tier = 5`, archived | consistent |
| `anchor_overlap = NaN` | `o = NaN` (`f64::clamp` propagates NaN) | `z >= NaN` is false, so **nothing ever archives** |
| `index = u32::MAX`, `imp = 100`, `p = 0.1` | `tier = 5`, archived | finite demotion holds here |

`compute_budget_pressure` is total and never returns NaN: a NaN or `+inf`
budget both collapse to `P_FLOOR` through `decay.rs:144`. It *can* return
`+inf` when `history_budget` is positive but subnormal (measured:
`history_budget = 5e-324` yields `p = inf`), which is the enabling state for
the `index = 1` failure above. `TIER_COST` indexing at `decay.rs:141` is
guarded by `natural_tier < 5` at `decay.rs:140`, so the index is always
`1..=4` and cannot panic; slot 0 is documented as unused (`decay.rs:41`).

### Decay reachability

The only in-tree production caller is
`crates/mc-module/src/decay_render.rs:19`, which calls
`compute_budget_pressure` at `decay_render.rs:279` behind a
`history_budget > 0.0` gate (`decay_render.rs:278`) and `rendered_tier` at
`decay_render.rs:291` with a **hardcoded `anchor_overlap` of `0.0`**
(`decay_render.rs:295`). It also pre-clamps importance to `1..100` with a
default of 50 (`decay_render.rs:270-272`). So the decay curve is
default-production, but the `anchor_overlap` degrees of freedom are not
reachable from `mc-module` today. `decay.rs:94` documents that as intentional
("anchors not yet a first-class storage primitive").

### The claim-operation model (task item 1)

`claim_operation.rs` is an encoding and identity contract, not a state
machine. It defines three closed enums and no transition function:

- `ClaimIntentState` (`claim_operation.rs:370-377`): `Staged`,
  `ContextCommitted`, `Acknowledged`, `TerminalRejected`. Closed, `Copy`, with
  `parse` (`:380`), `as_str` (`:390`), and one predicate `is_unresolved`
  (`:399-401`, true for `Staged | ContextCommitted`).
- `ClaimIntentAckKind` (`claim_operation.rs:425-432`): `ContextCommitted`,
  `Acknowledged`, `TerminalRejected`. The doc comment at `:425` calls this
  "One legal acknowledgement transition."
- `ClaimResultOutcome` (`claim_operation.rs:483-488`): `Applied`, `Stale`,
  `Noop`. `parse` is private (`:491`, no `pub`); `as_str` is public (`:500`).

The load-bearing observation: **`ClaimIntentAckKind` names only the target
state, never the source state.** There is no `(from, to)` legality relation,
no `can_transition`, and no guard anywhere in `mc-core`. An
acknowledgement that would move `Acknowledged` back to `ContextCommitted`, or
`TerminalRejected` to `Acknowledged`, is fully representable at this layer:
`ClaimIntentAckRequest` (`:437-446`) carries a `kind` and a `request_digest`
but no expected-current-state field. So an illegal transition is
representable, and ordering between acknowledgements matters to the domain but
is not enforced by the type. Whatever enforces it lives in `mc-store` (the
sibling lens's territory); this lens records the gap and the lead.

The three enums are all closed (no `#[non_exhaustive]`), so downstream crates
match exhaustively and adding a state is a compile-time breaking change. That
is a genuine strength worth pinning.

Identity and encoding surface, all pure and clock-free:

- `canonical_json_encode` (`:141`) over the vocabulary at `:6-15`. Object keys
  are sorted through `BTreeMap<&String, &Value>` (`:124`), which is UTF-8 byte
  order and therefore Unicode code-point order, matching the doc at `:12`.
- `number_as_safe_integer` (`:66-84`): three paths (i64, u64, f64). The f64
  path rejects non-finite, fractional, and `|v| > MAX_SAFE_INTEGER` (`:80`).
- `encode_canonical_string` (`:86-99`): escapes only `"`, `\`, and `< 0x20`.
- `is_lower_hex` (`:173-178`), `is_valid_public_claim_id` (`:181-185`).
- `format_revision_locator` (`:197-208`) and `parse_revision_locator`
  (`:211-232`), a mutually inverse pair on the valid domain. `parse` rejects
  empty digits, a leading `0`, and non-digits (`:220`), and range-checks
  `1..=MAX_SAFE_INTEGER` (`:224`); `format` applies the same range check
  (`:199`) and never emits a leading zero.
- `compute_applicability_heads_digest` (`:272-282`): sorts by stream key only
  (`:276`) using the stable `sort_by`.
- `decode_claim_operation_result` (`:597-670`): strict, `deny_unknown_fields`
  in spirit via the explicit allowlists (`:606-613`, `:540-546`), version-pinned
  (`:628`), fails closed on unknown outcome (`:633-637`).

Two acceptance gaps in the decoder:

1. **`payload` is passed through unvalidated** (`:666`,
   `record.get("payload").cloned().unwrap_or(Value::Null)`). A stored envelope
   whose payload contains `1.5` or `9007199254740993` decodes successfully even
   though `canonical_json_encode` would reject it (`:107-109`). So
   `decode_claim_operation_result` accepts a strict superset of what the
   canonical encoder can produce; decode-then-re-encode is not total.
2. **No cross-field rule couples `staleReason` to `outcome`** (`:638-646`).
   `outcome = "applied"` with a non-null `staleReason`, and
   `outcome = "stale"` with a null `staleReason`, both decode.

### The pass classifier and its reachability (`lib.rs`)

`classify` (`lib.rs:116-160`) is an ordered first-match router over 11
booleans (`ClassifierInput`, `lib.rs:42-80`) returning one of five
`PassPlan` variants (`lib.rs:84-97`). Eight rules at `lib.rs:118`, `:122`,
`:126`, `:130`, `:134`, `:138`, `:142`, `:146`, `:152`, and the fallthrough at
`:159`. The function is total (every path returns), pure, clock-free, and the
whole input domain is `2^11 = 2048` points, which makes exhaustive
enumeration the natural oracle. Ordering matters and is documented at
`lib.rs:99-115`; the safety-critical fact is that `MigrateHard` (the only
destructive clear-then-Hard plan, `lib.rs:87-88`) is guarded to fire solely on
`is_legacy_baseline`, with any other unrecognised shape routed to
`Reject` (`lib.rs:129-132`).

**Reachability finding: `classify`, `ClassifierInput`, and `PassPlan` have no
caller outside `mc-core`'s own test module.** A repo-wide `rg` for
`ClassifierInput|PassPlan|mc_core::classify` over `*.rs` returns hits only in
`crates/mc-core/src/lib.rs`. `mc-module` has its own unrelated
`src/classify.rs`, and `mc-host` has an unrelated `window.classify`. The
`mc-core` re-exports that *are* consumed in production are
`claim_operation::*` (`crates/mc-store/src/lib.rs`,
`crates/mc-module/src/memory_tool.rs:19`,
`crates/mc-module/src/m1_compose.rs:5`,
`crates/mc-module/src/classify.rs:176`) and `CoreState`
(`crates/mc-module/src/tail_hygiene.rs:6`). So classifier records are
`test-only`, and that must be labelled honestly rather than assumed.

### Tokenizer determinism (task item 3)

`estimate_tokens` (`mc-tokenizer/src/lib.rs:73-78`) is `count_ordinary` over a
`OnceLock<CoreBPE>` (`:46-68`) built from a vocab embedded with `include_str!`
(`:37`) plus a fixed `pat_str` (`:43-44`). No file read, no network, no clock,
no randomness. Empty input short-circuits to 0 (`:74-75`).

Determinism inputs I verified rather than assumed:

- The vendored vocab has **64,995 lines, all exactly two space-separated
  fields, zero duplicate token-byte keys, and zero duplicate ranks** (ranks
  span 5..64,999, so the space is sparse). Because there are no duplicate
  keys, the `encoder.insert` at `:61` is order-insensitive, so the
  `FxHashMap` build is reproducible regardless of iteration order. Had
  duplicates existed, last-line-wins would have made the encoder depend on
  file line order.
- `tiktoken-rs` is hard-pinned `=0.11.0` (`mc-tokenizer/Cargo.toml`), but
  `fancy-regex` is a transitive dependency pinned only by `Cargo.lock`. The
  Cargo.toml comment says as much and calls a bump "a renderer change". A
  `cargo update` inside `fancy-regex`'s semver range can move Unicode category
  tables for `\p{L}` and `\p{N}`, which changes pre-tokenization and therefore
  the token IDs. That is a real determinism dependency the golden is meant to
  guard.
- Five `expect` calls in the vocab loader (`:55`, `:56`, `:59`, `:60`, `:66`)
  panic on first use if the embedded asset is malformed. Reachable only by
  editing the asset, so this is a build-integrity guard, not a runtime hazard.
  Note `:54-56` reads exactly two fields and silently ignores any third, so a
  three-field line would not be rejected.

### What the golden vector does and does not pin (task item 3)

`token-golden.json` is a flat array of **36 cases**, each with exactly the keys
`{label, text, ids}` (verified by enumerating the key union). It covers ASCII,
contractions, whitespace runs, digits, punctuation, code, JSON, paths,
special-token substrings as literals, Latin accents, CJK, emoji with ZWJ
sequences, Cyrillic/Greek, RTL scripts, zero-width and format characters,
control characters, astral plane, a long repetition, and two realistic
transcript blobs. Across all 36 cases the corpus exercises **564 distinct
token IDs out of 64,995 vocab entries, about 0.87%**.

`token_golden.rs` asserts the full ID sequence (`:26-45`), that
`estimate_tokens` equals `ids.len()` (`:47-57`), the empty case (`:59-62`), and
1000 repeat calls in one process (`:64-73`).

What it would catch: any merge-table or pre-tokenizer regression that changes
the encoding of one of those 36 strings, including a count-coincident merge bug
(because it compares IDs, not counts). That is a genuinely strong choice and
`token_golden.rs:6-9` states the reasoning correctly.

What it would **not** catch:

1. **A silent move of the oracle.** The fixture carries no version, no
   `ai-tokenizer` release, no vocab digest, and no generator timestamp. It is
   generated *from* the TypeScript tokenizer by `gen/gen-token-golden.ts`, so
   if the TypeScript reference changes and anyone regenerates, the fixture
   moves with it and the test stays green. The golden pins Rust-to-TS
   agreement at an unrecorded point in time, not agreement with a named
   tokenizer version.
2. **Anything outside the 36 strings**, which is 99.13% of the vocab. A merge
   rule that only fires for byte sequences absent from the corpus is invisible.
3. **Cross-process or cross-build reproducibility.**
   `deterministic_across_calls` (`:64-73`) calls `estimate_tokens` 1000 times
   in one process after the `OnceLock` is already warm. It proves the memoised
   path is pure. It cannot observe a difference between the first call and
   later calls, cannot observe two processes disagreeing, and cannot observe a
   nondeterministic encoder *build*, because the build happens exactly once
   per process by construction.
4. **Cross-platform divergence**, except on whichever platform CI happens to
   run. `.github/workflows/ci.yml` runs the Rust jobs on `ubuntu-latest`; the
   only `matrix.os` job is the shared-memory source build. There is no
   big-endian, musl, or macOS/Windows tokenizer job, and no aarch64 job for
   this crate.
5. **A dependency bump within semver**, unless the bump happens to alter one of
   the 36 cases. Since `fancy-regex` is unpinned in the manifest, a Unicode
   table update affecting a code point absent from the corpus passes.
6. **The `estimate_tokens("") == 0` short-circuit diverging from
   `count_ordinary("")`.** The test asserts the short-circuited value, so a
   change in the underlying engine's empty-input behaviour is masked.

One nuance worth recording as a strength: the corpus contains one NFD string
(`combining-marks`, `"é à ñ ö café Ǻ"`, verified not NFC) alongside several NFC
strings, so it does exercise the fact that the tokenizer does not normalise.
But it never contains the *same* text in both NFC and NFD form, so it does not
actually pin "normalisation changes the encoding" as a relation; it only
happens to include one decomposed sample.

### Cross-runtime canonicalization: verified agreement (task item 4)

The TypeScript twin
(`packages/plugin/src/features/magic-context/memory/claim-operation-contract.ts`)
does **not** use JavaScript's default string sort. It defines
`compareCodePoints` (TS `:53-63`) that iterates `[...left]` code points and
compares `codePointAt(0)`, with the comment "== UTF-8 byte order, unlike JS `<`
which compares UTF-16 code units and misorders astral-plane keys" (TS
`:51-52`), and uses it at `Object.keys(record).sort(compareCodePoints)`
(TS `:120`). So the Rust `BTreeMap` ordering and the TS ordering agree by
deliberate design, and the fixture pins it: the `astral-key-order` case has
keys `U+0041`, `U+FFFD`, `U+1F600` with canonical output
`{"A":3,"\u{FFFD}":1,"😀":2}`. That ordering is code-point order; UTF-16 code
unit order would put `😀` (lead surrogate `0xD83D` = 55357) *before* `U+FFFD`
(65533). The fixture case therefore genuinely discriminates the two orderings.
This is a strength, not a gap, and I am recording it as a property to keep
rather than a defect.

Two deliberate asymmetries that are correct, not bugs:

- TS rejects ill-formed Unicode via `isWellFormedUnicode` (TS `:65-78`, thrown
  at TS `:81-83`). Rust `&str` cannot hold a lone surrogate, so the Rust side
  needs no equivalent check. The accepted *domains* differ; the accepted
  *outputs* do not.
- TS rejects non-plain-prototype objects (TS `:114-117`). `serde_json::Value`
  has no prototype concept, so there is nothing to reject.

Number vocabulary parity holds on inspection: TS uses
`Number.isSafeInteger` (TS `:102`) and normalises `-0` to `"0"` via `String(-0)`
(TS `:106-108`); Rust's `number_as_safe_integer` (`:66-84`) accepts the same
set, and `-0.0` takes the f64 path (`fract() == 0.0`, `abs() == 0.0`) and
encodes as `0`. Both runtimes reject `1.5` and `9007199254740993`, which are the
only two `invalidCanonical` fixture cases.

### Algebraic relations the code actually intends (task item 4)

Present and intended:

- **Object key-order independence** of `canonical_json_encode`
  (`claim_operation.rs:124`): permuting an object's insertion order must not
  change the output bytes.
- **Permutation invariance** of `compute_applicability_heads_digest`
  (`:276`) over head lists with *distinct* stream keys. The doc at `:270-271`
  says "sorted by stream key".
- **`format_revision_locator` and `parse_revision_locator` are mutually
  inverse** on the valid domain (`:197-232`).
- **Monotonicity** of the decay curve in age (non-decreasing tier) and in
  importance (non-increasing tier) and in pressure (non-decreasing tier),
  stated as invariants at `decay.rs:12-13` and sampled by the tests at
  `decay.rs:165`, `:176`, `:186`.
- **`rendered_tier` agrees with `should_archive`**: exactly 5 when archiving,
  at most 4 otherwise (`decay.rs:109-124`).
- **Idempotence of clamping**: `clamp_importance` and the `anchor_overlap`
  clamp are idempotent on their outputs.

Deliberately **not** intended, and I am not inventing them:

- `sort_by` at `:276` compares the key only and is stable, so a head list with
  duplicate stream keys is *not* permutation-invariant: `[("a",1),("a",2)]` and
  `[("a",2),("a",1)]` digest differently. JavaScript's `Array.prototype.sort`
  has been stable since ES2019 and the TS twin uses the same key-only
  comparator (TS `:243-245`), so the two runtimes agree on this too. Nothing
  in either implementation dedupes or rejects duplicate keys. I record the
  invariance property scoped to *distinct* keys and flag duplicates as an
  unresolved domain question, not as a law.
- No sub-additivity, monotonicity, or concatenation law for token counts. BPE
  merges cross pre-tokenizer piece boundaries in ways that make
  `count(a + b) <= count(a) + count(b)` unproven from anything I read. I am
  explicitly declining to record it.
- No commutativity or idempotence claim for intent acknowledgements. The
  domain plainly cares about order (`Staged` precedes `ContextCommitted`
  precedes `Acknowledged`), so an order-independence law would be wrong.

## Operation model map

### Staged-intent lifecycle as modelled in `mc-core`

```
                 ClaimIntentState (claim_operation.rs:370-377)
                 ---------------------------------------------
   [stage]  ──▶  Staged ─────────────┐
                   │                 │
                   ▼                 ▼
             ContextCommitted   TerminalRejected  (terminal)
                   │
                   ▼
              Acknowledged  (terminal; transport settlement, :368-369)

   is_unresolved() == { Staged, ContextCommitted }        (:399-401)
```

`ClaimIntentAckKind` (`:425-432`) enumerates the three non-`Staged` states as
acknowledgement targets. What is **absent** from `mc-core`:

| Question | Answer in `mc-core` |
| --- | --- |
| Is the operation set closed? | Yes. All three enums are plain closed Rust enums; no `#[non_exhaustive]`. |
| Are preconditions encoded? | No. `ClaimIntentAckRequest` (`:437-446`) has no expected-current-state field. |
| Is the `(from, to)` relation encoded? | No. No transition table, no guard, no `can_transition`. |
| Is an illegal transition representable? | Yes. `Acknowledged -> ContextCommitted` and `TerminalRejected -> Acknowledged` are constructible values. |
| Does ordering matter? | Yes to the domain, no to the types. Ordering is unenforced here. |
| Where must enforcement live? | `mc-store` (sibling lens). Lead recorded below. |

### Result-envelope decode as a state transform

`decode_claim_operation_result` (`:597-670`) transforms stored bytes into
`ClaimOperationResult`. It is a strict recogniser on five of six fields and a
pass-through on the sixth:

| Field | Rule | Line |
| --- | --- | --- |
| unknown top-level keys | rejected | `:614-621` |
| `resultEncodingVersion` | must equal 1 | `:622-632` |
| `outcome` | must parse to `applied`/`stale`/`noop` | `:633-637` |
| `staleReason` | string or null, **uncoupled from `outcome`** | `:638-646` |
| `effects` | array; each entry allowlisted, locator re-parsed | `:647-654`, `:536-593` |
| `generations` | object of safe integers | `:655-661` |
| `payload` | **unvalidated pass-through** | `:666` |

### Decay curve as a total function

```
(index: u32, importance: i32, pressure: f64, overlap: f64)
        │            │             │              │
    .max(1)-1    clamp 1..100   .max(0.1)    .clamp(0,1)   <- NaN passes through
        └────────────┴─────────────┘              │
                     z = a/H                      │
                        │                          │
             tier: 5 steps on Z1..Z4      threshold Z4 + G*o
                        │                          │
                        └──── rendered_tier ───────┘
                              5 if archiving, else min(tier,4)
```

Total over every representable input tuple: no panic, no index-out-of-bounds,
no division by an integer zero. It can, however, produce `z = NaN` (the
`0.0/0.0` case at `pressure = +inf`, `index <= 1`), and NaN silently falls
through every comparison to the `else` arm.

### The pass classifier as an ordered router

Eight guards, first match wins, no fallthrough gaps:

| # | Guard | Plan | Line |
| --- | --- | --- | --- |
| 1 | `!initialized` | `Hard` | `:118` |
| 2 | `is_legacy_baseline` | `MigrateHard` (destructive) | `:122` |
| 2b | `cached_m1_missing` | `Hard` | `:126` |
| 2c | `!valid_m0m1_shape` | `Reject` | `:130` |
| 3 | `render_config_changed` | `Hard` | `:134` |
| 4 | `hard_fold_requested` | `Hard` | `:138` |
| 5 | `reconcile_pending && !boundary_present` | `Hard` | `:142` |
| 6 | `reconcile_pending` | `Defer` | `:146` |
| 7 | `boundary_present && bust_opportunity && (m1_revision_changed \|\| reductions_pending)` | `Soft` | `:152` |
| 8 | otherwise | `Defer` | `:159` |

## Candidate properties

### core-decay-newest-compartment-tier-floor

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `decay.rs:154-162` asserts `tier(1, imp, p) == 1` for
`imp` in `{1, 50, 100}` and `p` in `{0.1, 1.0, 5.0}` only, so the non-finite
pressure case is unexercised.
Guarantee: the newest compartment always renders at tier 1, for every
importance and every pressure value the public API accepts.
Check: `always` — for all `importance: i32` and all `budget_pressure: f64`
including non-finite values, `tier(1, importance, budget_pressure) == 1` and
`rendered_tier(1, importance, budget_pressure, 0.0) == 1`. `always` is right
because `tier` is a total pure function evaluated on every render pass; there
is no optional path and no situation to reach, only an input domain to cover.
Fault/timing angle: none. Pure arithmetic, no interleaving.
Required faults and enabling state: `budget_pressure = f64::INFINITY`, which
`compute_budget_pressure` (`decay.rs:130-145`) returns when `history_budget`
is positive but subnormal (measured at `5e-324`). No fault injection needed;
the input alone is the enabling state.
Confidence: high — [evidence](evidence/core-decay-newest-compartment-tier-floor.md).
I extracted the exact kernel from `decay.rs:56-124` into a scratch program and
measured `tier(1, 50, f64::INFINITY) == 5`, `should_archive == false`,
`rendered_tier == 4`, with `z = 0.0/0.0 = NaN`.
Existing check: `crates/mc-core/src/decay.rs:154` `newest_compartment_is_tier_1`
covers three finite pressures. Status `unaudited`.
Impact: the newest, most relevant compartment renders as an anchor-level P4
summary instead of the verbose P1 form, silently dropping the most recent
session content from the prompt. Because `rendered_tier` returns 4 while
`tier` returns 5, the two functions also disagree, so any caller that reads
`tier` directly to decide archival diverges from the renderer.
Open questions:
- Is a subnormal `history_budget` reachable from configuration, or is the
  budget always a whole-token count bounded well away from zero? Requires
  tracing `history_budget_tokens` back to its config surface, which is
  `mc-module` territory. (unresolved, needs an `mc-module` config trace)
- Should `tier` reject or clamp a non-finite `budget_pressure` at the API
  boundary rather than relying on `f64::max`? (needs human input)

### core-decay-tier-ladder-monotone-and-archive-agreement

Type: safety
Reachability: default-production
Status: active
Exercised: partial — monotonicity is sampled at three fixed slices
(`decay.rs:165`, `:176`, `:186`) and the tier cap at one slice (`decay.rs:201`);
no test walks the joint grid.
Guarantee: the tier ladder is monotone in all three arguments, and
`rendered_tier` returns 5 exactly when `should_archive` is true and at most 4
otherwise.
Check: `always` — over a swept grid of `index`, `importance`, and finite
`pressure`: (a) `tier` is non-decreasing in `index`, (b) non-increasing in
`importance`, (c) non-decreasing in `pressure`, and (d)
`rendered_tier(i, m, p, o) == 5` if and only if `should_archive(i, m, p, o)`,
else `rendered_tier(i, m, p, o) <= 4`. `always` because every clause must hold
at every evaluation; these are not optional paths.
Fault/timing angle: none.
Required faults and enabling state: none. Plain input sweep. The grid must
include the intended disagreement window where `tier == 5` but
`should_archive == false`, which needs `anchor_overlap > 0`.
Confidence: high — [evidence](evidence/core-decay-tier-ladder-monotone-and-archive-agreement.md).
I confirmed the disagreement window empirically: at `importance = 50`,
`pressure = 1.0`, `anchor_overlap = 1.0`, indices 64 through 119 give
`tier == 5`, `should_archive == false`, `rendered_tier == 4`, which is the
documented P4 protection at `decay.rs:94` and `:107-108`.
Existing check: `crates/mc-core/src/decay.rs:165`, `:176`, `:186`, `:201`.
Status `unaudited`.
Impact: a monotonicity break means a compartment gets *more* verbose as it
ages or *less* protected as its importance rises, which is a direct
contradiction of the council-validated model at `decay.rs:12-13`. An
agreement break means the renderer and any archival consumer disagree about
whether a compartment is retired.
Open questions:
- Is `tier() == 5` a legitimate public answer, or should the archive-candidate
  boundary be expressed only through `should_archive`? The two disagree by
  design today. (needs human input)

### core-decay-budget-pressure-range-totality

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `decay.rs:208-221` asserts only that a tighter budget
raises pressure and that the loose case is at least `P_FLOOR`.
Guarantee: `compute_budget_pressure` is total, never returns NaN, and always
returns a value at or above `P_FLOOR`.
Check: `always` — for every compartment slice and every `history_budget: f64`
including 0, negative, subnormal, `f64::MAX`, `+inf`, and NaN:
`!result.is_nan() && result >= P_FLOOR`. Additionally record whether
`result.is_finite()`; if the contract intends finiteness, assert it too.
`always` because the function is called once per render pass and its output
feeds every subsequent tier decision.
Fault/timing angle: none.
Required faults and enabling state: none for the NaN and non-positive cases.
The `+inf` output needs a positive subnormal budget.
Confidence: high — [evidence](evidence/core-decay-budget-pressure-range-totality.md).
Measured: `history_budget` of NaN and `+inf` both yield exactly `0.1`
(`P_FLOOR`), so the NaN clause holds; `5e-324` and `f64::MIN_POSITIVE` both
yield `+inf`, so the finiteness clause does not hold. `TIER_COST` indexing at
`decay.rs:141` is guarded by `decay.rs:140` and cannot panic.
Existing check: `crates/mc-core/src/decay.rs:208`
`pressure_self_tunes_toward_budget`. Status `unaudited`.
Impact: an `+inf` pressure propagates into `z_value` and produces the
`core-decay-newest-compartment-tier-floor` failure. A NaN pressure would be
worse, collapsing every comparison, but the `f64::max` at `decay.rs:144`
already prevents it.
Open questions:
- Does the contract intend `compute_budget_pressure` to be finite, or is
  `+inf` an accepted "archive everything" signal? The doc at `decay.rs:127-129`
  discusses overshoot but not saturation. (needs human input)

### core-decay-archive-termination-bound

Type: safety
Reachability: test-only
Status: active
Exercised: partial — `decay.rs:194-198` asserts termination at one point,
`should_archive(100_000, 100, 1.0, 0.0)`, with `anchor_overlap` fixed at 0.
Guarantee: every compartment eventually archives; no input produces an
immortal row.
Check: `always` — for every `importance` and every finite `pressure >= P_FLOOR`
and every `anchor_overlap` the API accepts, there exists a finite `index` at
which `should_archive` is true; equivalently, assert
`should_archive(u32::MAX, importance, pressure, overlap)` holds for the whole
swept parameter set. `always` rather than a liveness check because the
quantity is a pure function of an ordinal index, not a process that must make
progress over time; there is no fault-free window to bound.
Fault/timing angle: none.
Required faults and enabling state: `anchor_overlap = f64::NAN`. Rust's
`f64::clamp` propagates NaN, so the clamp at `decay.rs:102` returns NaN, the
comparison `z >= Z4 + G * NaN` is false for every `z`, and nothing archives.
Confidence: high — [evidence](evidence/core-decay-archive-termination-bound.md).
Measured: `f64::NAN.clamp(0.0, 1.0)` returns NaN, and
`should_archive(100_000, 100, 1.0, f64::NAN) == false`, directly contradicting
the "finite demotion even at importance 100" invariant at `decay.rs:12-13`.
Reachability is `test-only` because the sole in-tree caller,
`crates/mc-module/src/decay_render.rs:295`, hardcodes `0.0`; only a direct
library call can supply NaN today.
Existing check: `crates/mc-core/src/decay.rs:194`
`finite_demotion_at_max_importance`, one point, `anchor_overlap = 0.0`.
Status `unaudited`.
Impact: unbounded retention. Session history never archives, so the rendered
prompt grows without limit and the budget guard at
`crates/mc-module/src/decay_render.rs:331-347` becomes the only backstop. If
anchors become a first-class primitive as `decay.rs:94` anticipates, a NaN or
uninitialised overlap becomes production-reachable.
Open questions:
- When anchor overlap becomes a real storage primitive, where should the
  overlap value be validated: at the storage boundary or inside
  `should_archive`? (needs human input)

### core-canonical-encoding-crossruntime-parity

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the fixture pins 5 canonicalization cases and 2 rejection
cases (`claim_operation.rs:718-747`), including one astral key-order case that
genuinely discriminates code-point from UTF-16 ordering.
Guarantee: the Rust and TypeScript canonical encoders accept exactly the same
values and emit byte-identical output, so a digest computed on either side
fences correctly against the other.
Check: `always` — for every value in the shared canonical vocabulary,
`canonical_json_encode(v)` in Rust equals `canonicalJsonEncode(v)` in
TypeScript byte for byte, and the accepted sets coincide: both accept a value
or both reject it. Restrict the comparison to values Rust can represent, since
Rust `&str` cannot hold a lone surrogate that TypeScript can. `always` because
every staged command digests through this path.
Fault/timing angle: none. This is a cross-runtime equivalence, not a race.
Required faults and enabling state: a generator that emits values spanning the
discriminating regions: object keys straddling the BMP/astral boundary
(`U+E000`..`U+FFFF` versus `U+10000`+), keys differing only past a shared
prefix, integers at exactly `±(2^53 - 1)` and `±2^53`, `-0`, floats with zero
fraction such as `1e3`, control characters `U+0000`..`U+001F`, `U+2028`,
`U+2029`, and unpaired-surrogate-free astral text.
Confidence: high — [evidence](evidence/core-canonical-encoding-crossruntime-parity.md).
I read the TypeScript twin and confirmed it uses an explicit `compareCodePoints`
(TS `:53-63`) at TS `:120`, not the default sort, so the agreement with Rust's
`BTreeMap` ordering (`claim_operation.rs:124`) is deliberate. I decoded the
`astral-key-order` fixture keys as `U+0041`, `U+FFFD`, `U+1F600` and confirmed
the pinned canonical output is in code-point order, which UTF-16 order would
reverse for the last two.
Existing check: `crates/mc-core/src/claim_operation.rs:718`
`canonical_bytes_and_request_digests_match_fixture` and `:737`
`non_canonical_numbers_are_rejected`, both fixture-driven. Status `unaudited`.
Impact: a divergence means the two runtimes compute different request digests
for the same semantic command, so the intent ledger's replay detection and the
mutation-token fence both misfire: a replay looks like a new command, or two
different commands collide on one identity.
Open questions:
- Is the `U+FFFD` key in the `astral-key-order` fixture deliberate, or is it a
  mangled `U+E000` or lone surrogate from an earlier generator run? It
  discriminates correctly either way, but the intent matters for future edits.
  (unresolved, needs the fixture generator's history)
- Only two `invalidCanonical` cases exist (`1.5` and `9007199254740993`). Is
  the rejection surface intended to be that narrow? (needs human input)

### core-result-decode-acceptance-boundary

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `claim_operation.rs:847-877` covers 2 valid and 5 invalid
fixture envelopes. Neither valid case has a non-canonical payload, and no case
pairs an `applied` outcome with a non-null `staleReason`.
Guarantee: `decode_claim_operation_result` accepts exactly the envelopes the
canonical encoder can produce, and the accepted envelope is internally
consistent.
Check: `always` — for every input string `s`: if
`decode_claim_operation_result(s)` succeeds then (a)
`canonical_json_encode(serde_json::from_str(s))` also succeeds, and (b) the
decoded `stale_reason` is `Some` if and only if the decoded outcome is `Stale`.
Both clauses are stated as `always(!X)` style conditions on the accepted
value, not as `unreachable`, because the forbidden thing is a *state* (an
accepted-but-non-canonical envelope) with no dedicated code point that must
not execute.
Fault/timing angle: none.
Required faults and enabling state: a stored envelope whose `payload` contains
a fractional number, a number beyond `±(2^53 - 1)`, or a nested object with
such a number. Writing such an envelope requires a producer that does not
canonicalize, which is the interesting fault: an older writer, a
hand-repaired row, or a future encoding version.
Confidence: high — [evidence](evidence/core-result-decode-acceptance-boundary.md).
Verified by reading: `claim_operation.rs:666` clones `payload` with no
validation, while `:107-109` rejects the same value inside
`canonical_json_encode`. `staleReason` at `:638-646` is validated only for
type. I confirmed the two fixture valid cases have payloads
`{"claim":{...},"kind":"revised"}` and `null`, both canonical, and that
`staleReason` is null on `applied` and a string on `stale`, so the fixture
happens to be consistent and therefore cannot detect the missing rule.
Existing check: `crates/mc-core/src/claim_operation.rs:847`
`stored_results_decode_and_reencode_byte_identically`. Status `unaudited`.
Impact: a non-canonical payload round-trips through the ledger and then fails
at re-encoding time in whatever layer next digests it, turning a write-time
validation miss into a later, harder-to-attribute failure. An `applied`
outcome carrying a stale reason, or a `stale` outcome carrying none, misleads
every consumer that branches on the pair, including
`crates/mc-store/src/lib.rs:3943` which treats `Applied | Noop` as one class.
Open questions:
- Is `payload` intentionally opaque, so that non-canonical payloads are
  legal by design and only the envelope is canonical? The module doc at
  `claim_operation.rs:6-15` describes one vocabulary for all values, which
  suggests not. (needs human input)
- Should `staleReason` be modelled as data on the `Stale` variant rather than a
  sibling field, making the inconsistent pair unrepresentable? (needs human
  input)

### core-applicability-heads-order-independence

Type: safety
Reachability: default-production
Status: active
Exercised: partial — 2 fixture cases (`claim_operation.rs:803-822`): the empty
list and one two-element list. No case permutes the same list, so the
invariance is asserted nowhere.
Guarantee: the applicability-heads digest depends only on the set of
`(streamKey, seq)` pairs, not on the order in which they are supplied, when
stream keys are distinct.
Check: `always` — for every head list with pairwise-distinct stream keys and
every permutation of it, `compute_applicability_heads_digest` returns the same
digest. Scoped to distinct keys deliberately: the sort at
`claim_operation.rs:276` compares the key only and `sort_by` is stable, so
duplicate keys make the digest order-sensitive by construction, and asserting
invariance there would assert a law the code does not claim.
Fault/timing angle: none.
Required faults and enabling state: none. A permutation generator over
distinct-key lists. A separate `sometimes` marker should record whether a
duplicate-key list ever reaches the function in production, since that is the
case where the property is genuinely undefined.
Confidence: high — [evidence](evidence/core-applicability-heads-order-independence.md).
Verified by reading `claim_operation.rs:275-281`: the sort key is
`left.0.cmp(&right.0)`, the stream key alone. Confirmed the TypeScript twin
uses the same key-only comparator over a copied array (TS `:243-245`) and that
`Array.prototype.sort` is stable in ES2019 and later, so the two runtimes agree
on duplicate handling as well as on the distinct-key case.
Existing check: `crates/mc-core/src/claim_operation.rs:803`
`applicability_and_policy_head_digests_match_fixture`. Status `unaudited`.
Impact: an order-sensitive digest makes the mutation token
(`claim_operation.rs:238-246`) fence on an accident of enumeration order, so a
caller that lists the same heads in a different order sees a spurious fence
mismatch and retries or rejects a legitimate mutation.
Open questions:
- Can a duplicate stream key occur in a real head list? If it can, the digest
  is ill-defined and the function should dedupe or reject rather than silently
  depend on input order. Resolving it needs the head-collection query in
  `mc-store`, which is a sibling lens's file. (unresolved, needs the
  `mc-store` head-collection query)

### core-revision-locator-roundtrip-inverse

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the fixture (`claim_operation.rs:760-786`) asserts
`format(parse(s)) == s` for each valid case and rejection for 8 invalid
strings, but never asserts `parse(format(l)) == Some(l)` for a generated
locator.
Guarantee: `format_revision_locator` and `parse_revision_locator` are mutually
inverse on the valid domain, and both reject exactly the same invalid domain.
Check: `always` — for every `RevisionLocator` value: if
`format_revision_locator(&l)` is `Some(s)` then
`parse_revision_locator(&s) == Some(l)`; and for every string `s`, if
`parse_revision_locator(s)` is `Some(l)` then
`format_revision_locator(&l) == Some(s.to_string())`. `always` because both
directions are evaluated on every effect row that carries a locator
(`claim_operation.rs:564-579`).
Fault/timing angle: none.
Required faults and enabling state: none. A generator over the three
components, including `revision` at 0, 1, `MAX_SAFE_INTEGER`,
`MAX_SAFE_INTEGER + 1`, and `i64::MAX`; digests of length 63, 64, 65; digests
with uppercase hex; and ids with the wrong prefix or wrong length.
Confidence: high — [evidence](evidence/core-revision-locator-roundtrip-inverse.md).
Verified by reading both functions: the range check
`(1..=MAX_SAFE_INTEGER).contains(&revision)` appears identically at
`claim_operation.rs:199` and `:224`; the leading-zero and non-digit rejections
at `:220` exclude exactly the strings `format` cannot emit; `is_lower_hex`
(`:173-178`) is shared by both. The parse of a very long digit run overflows
and is caught by `.ok()?` at `:223`, so there is no panic.
Existing check: `crates/mc-core/src/claim_operation.rs:760`
`revision_locators_match_fixture`. Status `unaudited`.
Impact: a locator that formats but does not parse, or parses but reformats
differently, breaks effect-row validation at
`claim_operation.rs:564-579`, where a stored locator is re-parsed and the
envelope is rejected if the parse fails. A one-sided inverse turns a valid
stored effect into a `MalformedResult`.
Open questions: None.

### core-intent-ack-transition-legality-gap

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing in `mc-core` asserts transition legality, because
`mc-core` does not model it. `crates/mc-store/tests/claim_intent_ledger.rs`
exercises acknowledgements, but auditing whether it covers illegal transitions
belongs to the sibling lens.
Guarantee: an acknowledgement only advances an intent along a legal edge; a
resolved intent is never reopened and a terminal state is never left.
Check: `always` — for every observed acknowledgement, the pair
`(state_before, kind)` lies in the legal set
`{(Staged, ContextCommitted), (Staged, TerminalRejected),
(ContextCommitted, Acknowledged), (ContextCommitted, TerminalRejected)}`,
plus whatever idempotent replay edges the design intends. Expressed as
`always(pair in legal_set)`, not `unreachable`, because the forbidden thing is
a *state pair* with no dedicated code point in `mc-core` that must not
execute; there is no transition function to place a marker in.
Fault/timing angle: a concurrent or replayed acknowledgement. Two
acknowledgements for the same `(producer, operation_key)` racing, or one
retried after its response was lost, is exactly the window where a backwards
edge appears. `ClaimIntentAckRequest` (`claim_operation.rs:437-446`) carries
no expected-current-state, so the request itself cannot express the fence.
Required faults and enabling state: a lost acknowledgement response followed
by a retry with a different `kind`; two producers acknowledging the same
command identity; an acknowledgement arriving after the intent already reached
`Acknowledged` or `TerminalRejected`.
Confidence: medium — [evidence](evidence/core-intent-ack-transition-legality-gap.md).
High confidence that `mc-core` does not model the relation: I read every line
of `claim_operation.rs` and there is no transition function, no guard, and no
expected-state field; `is_unresolved` (`:399-401`) is the only state predicate.
Medium overall because whether the *system* enforces legality depends on
`mc-store`, which this lens does not own and did not read.
Existing check: none in `mc-core`. `crates/mc-store/tests/claim_intent_ledger.rs`
exists and touches acknowledgements; its coverage is the sibling lens's call.
Status `unaudited`.
Impact: a backwards or terminal-escaping transition makes the intent ledger
lie about whether a command's context mutation happened, which is the ledger's
entire purpose. A reopened `TerminalRejected` intent could be re-applied; an
`Acknowledged` intent knocked back to `ContextCommitted` could be
double-applied.
Open questions:
- Is transition legality enforced in `mc-store` SQL, and if so is the guard a
  `CHECK`, a conditional `UPDATE ... WHERE state = ?`, or application logic?
  (unresolved, needs the `mc-store` claim-intent-ledger lens)
- Should `ClaimIntentAckRequest` carry an expected-current-state so the fence
  is expressible in the wire contract rather than only in storage? (needs
  human input)

### core-pass-classifier-destructive-clear-guard

Type: safety
Reachability: test-only
Status: active
Exercised: partial — 14 hand-written cases at `lib.rs:176-337` cover each rule
at least once, including `unknown_shape_rejects_never_clears` (`:207`), but the
2048-point input domain is never enumerated.
Guarantee: the destructive clear-then-Hard plan fires only on the exact legacy
single-baseline shape, and a `Soft` plan never fires without the boundary
present.
Check: `always` — enumerate all `2^11 = 2048` `ClassifierInput` values and
assert: (a) `classify(i) == MigrateHard` implies `i.is_legacy_baseline`;
(b) `classify(i) == Reject(_)` implies `i.initialized && !i.is_legacy_baseline
&& !i.cached_m1_missing && !i.valid_m0m1_shape`; (c) `classify(i) == Soft`
implies `i.boundary_present && i.bust_opportunity && (i.m1_revision_changed ||
i.reductions_pending)`; (d) `!i.boundary_present` implies
`classify(i) != Soft`. `always` over an exhaustively enumerated finite domain,
which makes this the cheapest complete oracle in the whole part.
Fault/timing angle: none. `classify` is a pure total function of 11 booleans.
Required faults and enabling state: none. Exhaustive enumeration only.
Confidence: high — [evidence](evidence/core-pass-classifier-destructive-clear-guard.md).
I read all eight guards and confirmed the ordering claims at `lib.rs:99-115`
match the code at `:118`, `:122`, `:126`, `:130`, `:134`, `:138`, `:142`,
`:146`, `:152`, `:159`. Reachability is `test-only`: a repo-wide `rg` for
`ClassifierInput|PassPlan|mc_core::classify` over `*.rs` returns hits only
inside `crates/mc-core/src/lib.rs`; the `classify` symbols found in
`crates/mc-module/src/classify.rs` and
`crates/mc-host/tests/support/perf_measurement.rs:426` are unrelated
functions.
Existing check: `crates/mc-core/src/lib.rs:176-337`, 14 tests.
Status `unaudited`.
Impact: if `MigrateHard` ever escaped its guard, a session with an
unrecognised frozen-set shape would have its durable frozen units cleared
rather than cleanly rejected, which is the exact outcome `lib.rs:53-56` and
`:129-130` are written to prevent. Because the classifier has no production
caller, today the blast radius is confined to whatever adopts it next, which
is precisely when an exhaustive check is cheapest to install.
Open questions:
- Is `classify` dead code awaiting adoption, or has `mc-module` diverged with a
  second copy of this routing logic? If the latter, the two must be compared,
  because a silent divergence between an unused reference implementation and
  the live router is worse than no reference at all. (unresolved, needs an
  `mc-module` routing comparison)

### tokenizer-cross-process-determinism

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `token_golden.rs:64-73` repeats 1000 calls in a single
process after the `OnceLock` is warm, which proves memoised purity and nothing
about a second process or a second build.
Guarantee: for fixed text, `estimate_tokens` and `encode_ordinary` return
identical results across processes, machines, and rebuilds of the same pinned
dependency set.
Check: `always` — for a corpus of texts, the encoding produced in a freshly
spawned process equals the encoding recorded from a prior process, and the
first call in a process equals every later call. Pair it with a `sometimes`
marker that the corpus actually exercised a cold first call, since that is a
situation, not a location.
Fault/timing angle: the cold-start window. The `OnceLock` at
`mc-tokenizer/src/lib.rs:47` builds the encoder exactly once per process, so
any build-order sensitivity is observable only on the first call and is
invisible to an in-process repeat loop.
Required faults and enabling state: a second process, and ideally a second
target. A dependency-bump scenario is the realistic fault: `fancy-regex` is
transitive and pinned only by `Cargo.lock`, so a `cargo update` can move
`\p{L}` and `\p{N}` classification.
Confidence: high — [evidence](evidence/tokenizer-cross-process-determinism.md).
I verified the vocab has 64,995 lines, all with exactly two fields, zero
duplicate token-byte keys, and zero duplicate ranks, so the `insert` at
`mc-tokenizer/src/lib.rs:61` is order-insensitive and the encoder build is
reproducible. I confirmed there is no clock, no randomness, no file read, and
no network in the crate, and that the vocab is embedded with `include_str!`
(`:37`).
Existing check: `crates/mc-tokenizer/tests/token_golden.rs:64`
`deterministic_across_calls`. Status `unaudited`.
Impact: `crates/mc-module/src/tail_hygiene.rs:85` and the m0 composer use
`estimate_tokens` for budget fitting, and `mc-tokenizer/src/lib.rs:13-19`
states that a resume must produce byte-identical m0. A per-process count
difference changes the tier or truncation decision, changes the rendered m0
bytes, and busts the cached prefix on resume, which is the failure the whole
cache-stability core exists to prevent.
Open questions:
- Is `f64`-free integer counting enough to make the tokenizer bit-portable
  across architectures, or does `fancy-regex` carry any target-dependent
  behaviour? Nothing I read suggests it does, but nothing establishes it
  either. (unresolved, needs a second-architecture run)

### tokenizer-golden-oracle-provenance

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the fixture records only `{label, text, ids}` per case,
verified by enumerating the key union across all 36 cases. No version, no
vocab digest, no generator stamp.
Guarantee: the differential golden pins agreement with a *named, recorded*
version of the TypeScript `ai-tokenizer` claude encoding and the vendored
vocab, so a change in either oracle is visible rather than absorbed by
regeneration.
Check: `reachable` — a check that the provenance fields exist and are
executed against the current artifacts: assert the fixture carries the
`ai-tokenizer` version and a digest of `assets/claude.tiktoken`, and that the
test compares the recorded digest to the embedded asset's actual digest.
`reachable` is the right semantics because this is location coverage: a
specific verification step must execute. It is not `sometimes`, because there
is no operational state to reach; the step either runs or does not exist.
Fault/timing angle: none at runtime. The window is the development workflow:
regenerating the fixture after an upstream change.
Required faults and enabling state: an upstream `ai-tokenizer` change plus a
regeneration of the fixture, or an edit to the vendored vocab, with the test
still green.
Confidence: high — [evidence](evidence/tokenizer-golden-oracle-provenance.md).
I enumerated the fixture's key union across all 36 cases and it is exactly
`{label, text, ids}`. `token_golden.rs:14-19` deserialises only those three
fields, so even if provenance were added it would be ignored. The fixture is
generated from the TypeScript reference by `gen/gen-token-golden.ts`
(`token_golden.rs:3-4`), which is the regeneration path that would absorb an
oracle change.
Existing check: `crates/mc-tokenizer/tests/token_golden.rs:26`, `:47`, `:59`,
`:64`. All four compare against the fixture; none validates the fixture's own
provenance. Status `unaudited`.
Impact: the golden's stated purpose (`mc-tokenizer/src/lib.rs:16-19`) is
faithfulness to the TypeScript tokenizer. Without provenance the test proves
only self-consistency with the last regeneration, so a silent upstream drift
plus a routine regeneration leaves a green suite and a Rust port that is now
faithful to a different oracle than the plugin runs. Combined with 0.87% vocab
coverage (564 of 64,995 token IDs across the 36 cases), the residual risk is
larger than the green check suggests.
Open questions:
- Does `ai-tokenizer` expose a version constant the generator can stamp into
  the fixture? (unresolved, needs the `ai-tokenizer` package surface)
- Should the vocab asset carry a checked-in digest so an accidental edit fails
  the build rather than silently changing every count? (needs human input)

## Contract-vs-code leads

1. **`ClaimIntentAckKind` is documented as "One legal acknowledgement
   transition" (`claim_operation.rs:425`) but encodes only a target state.**
   The doc asserts legality; the type cannot express it, since
   `ClaimIntentAckRequest` (`:437-446`) has no source-state field. Both sides
   cited, unresolved in favour of neither. Enforcement, if any, is in
   `mc-store`.

2. **`decay.rs:12-13` claims "finite demotion even at importance 100" as an
   invariant that "holds by the same construction".** It does not hold for
   `anchor_overlap = f64::NAN`, because `f64::clamp` propagates NaN
   (`decay.rs:102`) and the comparison at `:103` then always fails. The
   documented invariant is unconditional; the code's is conditional on a
   non-NaN overlap. Not production-reachable today
   (`decay_render.rs:295` passes `0.0`), but the doc overstates.

3. **`decay.rs:75` and `:51` document `compartment_index` as 1-based, and
   `decay.rs:65` silently accepts 0** by mapping it to the newest position via
   `.max(1)`. The contract says 1-based; the code is total over `u32` and
   conflates 0 with 1. No panic, but an off-by-one caller gets a plausible
   wrong answer instead of an error.

4. **`mc-core/src/lib.rs:26-27` insists an item ordinal is "Monotonic absolute
   ordinal — strictly increasing across the lineage, NEVER positional", while
   the decay curve's `compartment_index` is explicitly positional** (1-based
   from newest, `decay.rs:51`) and `decay_render.rs:267` computes it as
   `v2_total - v2_ordinal`. These are two different index notions in one crate
   with similar names. Not a defect, but a naming hazard worth a doc note, and
   a real risk if a future caller passes a `CkItem::ordinal` where a
   `compartment_index` is expected.

5. **`claim_operation.rs:6-15` describes one canonical vocabulary for "values",
   yet `decode_claim_operation_result` exempts `payload` from it**
   (`:666`). Either the payload is intentionally opaque and the doc should say
   so, or the decoder should validate it.

6. **`mc-tokenizer/src/lib.rs:16-19` says determinism holds because
   "tiktoken-rs + fancy-regex are version-pinned".** Only `tiktoken-rs` is
   pinned in the manifest (`=0.11.0`); `fancy-regex` is transitive and pinned
   solely by `Cargo.lock`. The Cargo.toml comment is accurate about this
   ("Cargo.lock is the pin"); the lib.rs doc comment overstates by naming both
   as pinned.

7. **`decay.rs:127-129` describes `compute_budget_pressure` overshoot
   behaviour but not saturation.** The function can return `+inf`
   (measured, positive subnormal budget), which the doc does not contemplate
   and which breaks the tier-1 floor for the newest compartment.

## Open questions

1. Is a subnormal or otherwise pathological `history_budget` reachable from the
   configuration surface? Tracing `history_budget_tokens` from config through
   `memory_render.rs:304` is `mc-module` work, outside this lens's files.
   (unresolved, needs an `mc-module` config trace)
2. Is `mc_core::classify` dead code awaiting adoption, or has `mc-module`
   grown a second copy of the routing logic? A silent divergence between an
   unused reference implementation and the live router is the worse outcome.
   (unresolved, needs an `mc-module` routing comparison)
3. Can a duplicate stream key reach `compute_applicability_heads_digest`? If
   yes, the digest is order-sensitive and therefore ill-defined.
   (unresolved, needs the `mc-store` head-collection query)
4. Is `ClaimResultOutcome::Noop` exercised anywhere? The `mc-core` golden
   corpus never mentions `noop` (verified by searching the fixture text), yet
   `crates/mc-store/src/lib.rs:3943` branches on
   `ClaimResultOutcome::Applied | ClaimResultOutcome::Noop` and
   `crates/mc-store/tests/claim_intent_ledger.rs:100` constructs a `noop`
   result. So the variant is production-meaningful and covered by an
   `mc-store` test but not by the contract corpus that is supposed to pin the
   encoding. Whether that matters is the sibling lens's call.
   (unresolved, needs the `mc-store` claim-mirror lens)
5. Does `2f64.powf` (`decay.rs:68`) give bit-identical results across the
   targets this ships to? The module doc only claims intra-implementation
   determinism (`decay.rs:17-19`), which is satisfied, so this matters only if
   a cross-target byte-identity claim is ever made.
   (unresolved, needs a second-architecture run)
6. Should `staleReason` be data on the `Stale` variant rather than a sibling
   field, so the inconsistent pair is unrepresentable? (needs human input)
7. Should `tier` and `should_archive` be reconciled so that `tier() == 5`
   implies archival, or is the P4-protection disagreement the intended public
   contract? (needs human input)
