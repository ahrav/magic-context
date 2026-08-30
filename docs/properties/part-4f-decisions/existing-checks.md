# Part 4f existing-check inventory

Every claim-bearing check for the decision layer and the two harness codecs: the
four files of `src/codec/` (`mod.rs` 299, `opencode.rs` 2,186, `pi.rs` 1,499,
`sidecar.rs` 339, **4,323** together), `selection.rs` (3,365), `boundary.rs`
(3,053), `scheduler.rs` (1,449), `config.rs` (1,229) and `caveman.rs` (651).
Nine units, **14,070 production lines** for the brief's named set. Adding the two
files the scope map assigns to 4f but the brief does not name, `ck_wire.rs`
(1,279) and `session_resolver.rs` (70), gives **15,419**. Every count was
re-derived at `HEAD`. The sub-part owns what the crate decides and what it says
to the outside world: the reduction selector, the protected-tail and trigger
boundary, the pass scheduler and its TTL parse, the per-leaf configuration trust
policy, caveman compression, and the native-to-CK-to-native round trip for both
harnesses.

Provenance. `HEAD` is `e447c927` ("refactor(shm): trim final review leftovers").
The CI reference drift the lenses record is a pure file move across
`76cd6f41..HEAD`: the only `mc-module` test invocation,
`cargo test -p mc-module --test lifecycle_cli`, is `ci.yml:168` at `76cd6f41` and
`ci.yml:172` at `HEAD`, and the build-only step above it is `:165` and `:169`
respectively. Both were confirmed directly in the working tree at `HEAD`, and the
`run:` text is byte-identical at both commits. Both numberings are cited wherever
a step appears, matching 4e's convention
(`../part-4e-rendering/existing-checks.md:18-27`).

An existing check does not remove a property from the catalog. **Every status
below is `unaudited`**: test adequacy belongs to
`/testing:invariant-test-review`, and production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## Three scope resolutions, recorded rather than assumed

1. **There is no top-level `src/sidecar.rs`. The file is `src/codec/sidecar.rs`**
   (339 lines), which the scope map lists under 4f at `:616`. Verified against a
   full listing of `crates/mc-module/src/` at `HEAD`. It is already inside
   `codec/`, so it adds no file to the brief's set, and it is the one file in
   scope with no tests of its own.
2. **`ck_wire.rs` and `session_resolver.rs` are 4f and are not in the brief's
   list.** The scope map assigns both to 4f (`:614`, `:617`), and 4e's inventory
   explicitly excludes `ck_wire.rs` from itself as "4f (`:619`)"
   (`../part-4e-rendering/existing-checks.md:32-33`). The brief's "and the
   decision regions in the Part 4 scope map" pulls them in. Every count below is
   therefore given twice, for the brief-named files and for full scope-map 4f.
3. **`caveman.rs` is claimed by both 4e and 4f, and its single test is
   double-counted across the two inventories.** The scope map lists it under 4e
   (`:590`), 4e's inventory counts its one test inside its own 35 file-local tests
   (`../part-4e-rendering/existing-checks.md:438`), and the brief assigns the file
   to 4f. This is not resolved here. It is recorded so a later pass adding 4e's
   277 to any figure below knows the overlap is exactly one in-crate test plus 651
   production lines, and so the quiet area on `caveman.rs` is read as a
   restatement of 4e's quiet area 3 rather than as a new finding.

## Two corrections to references handed to this synthesis

Made per METHOD.md rule 1 and recorded rather than silently applied.

- **The brief's premise about the release-behaviour divergence needs one
  correction, and it sharpens the finding rather than softening it.**
  `codec/opencode.rs:251` is *not* the dangerous assertion. Its condition,
  `replace_from <= messages.len()`, is re-checked by the language one line later:
  the slice `&messages[replace_from..]` at `:258` is an index-out-of-range panic
  on exactly that condition. So a violated `:251` fails loudly in **every**
  profile and the assertion only buys a better message. **`:252` is the silent
  one.** Same function, adjacent line, asserting `replace_from <=
  prior.order.len()`, and its only consumer is
  `prior.order.iter().take(replace_from)` at `:265`, where `take` saturates. A
  violated `:252` in release yields a short sidecar with no signal at all. All
  four lines were re-read at `HEAD`.
- **The three `decode_*_with_sidecar` forms and
  `decode_opencode_with_sidecar_and_base` are not four entry points. They are
  three.** The re-export list at `codec/mod.rs:5-11` carries exactly
  `decode_opencode_with_sidecar`, `decode_opencode_with_sidecar_and_base` and
  `decode_pi_with_sidecar` matching that shape, and `_and_base` is one of the
  three rather than a fourth. The golden-coverage table below enumerates all
  three explicitly so a mechanical recount does not arrive at four.

## The coverage fact that frames this inventory, and how the number was obtained

**192 in-crate tests reach full scope-map 4f: 153 file-local tests across the ten
4f files that have any, plus 39 of the 280 tests in `transform.rs`'s flat
`mod tests`. Restricted to the brief's named files the figure is 164, being 146
file-local plus 18. `codec/sidecar.rs` has zero tests. There is no integration
test in scope, and none of the 192 runs in CI.**

That is the headline. The attribution behind it is mechanical rather than
asserted, and it is stated in full so a reader can reproduce it.

**File-local tests were counted directly, not derived.** Every line matching
`#[test]` or `#[tokio::test]` per file, each attribute then resolved forward to
its following `fn` line. A second broader scan for the same attributes anywhere
on a line returned identical per-file counts, so no attribute is hidden behind a
sibling attribute such as `#[ignore]`. Re-counted independently at `HEAD` for
this file:

| File | Tests |
| --- | --- |
| `selection.rs` | **37** |
| `boundary.rs` | **29** |
| `config.rs` | **26** |
| `codec/opencode.rs` | **17** |
| `scheduler.rs` | **16** |
| `codec/pi.rs` | **14** |
| `codec/mod.rs` | **6** |
| `ck_wire.rs` | **6** |
| `caveman.rs` | **1** |
| `session_resolver.rs` | **1** |
| `codec/sidecar.rs` | **0** |

Brief-named files sum to `37 + 29 + 26 + 17 + 16 + 14 + 6 + 1 + 0` = **146**.
Adding `ck_wire.rs`'s 6 and `session_resolver.rs`'s 1 gives **153**.

`transform.rs` needs derivation, and the method is the same four steps 4b and 4e
used, so the three inventories are comparable
(`../part-4b-transform/existing-checks.md:63-79`,
`../part-4e-rendering/existing-checks.md:83-110`):

1. **Enumerate.** All `#[test]` and `#[tokio::test]` attributes. Re-counted
   independently at `HEAD`: **285** total, **280** at or after the flat module
   `pub(crate) mod tests` (`:12626`), therefore **5** in `mod nudge_formula_tests`.
   These are exactly 4b's and 4e's figures.
2. **Resolve.** Each attribute resolved forward to its `fn` line, giving 280 test
   functions. First is
   `claude_code_cache_ttl_mapper_is_lossy_because_provider_vocabulary_is_limited`
   at `:12645`; last is
   `channel2_directive_id_hashes_session_and_arming_watermark_deterministically`
   at `:29425`. Both match 4b and 4e.
3. **Brace-match.** Each body brace-matched to its closing line with string
   literals, char literals and line comments stripped, so a test's extent is its
   real body rather than the gap to the next attribute.
4. **Match.** Each body matched against a 4f symbol rule.

**The 4f symbol rule is stated in full, and this is the one respect in which this
attribution is stronger than 4e's.** 4e recorded that its curated 62-identifier
list was "not reproducible from this file" and called that the sharpest limit on
its whole attribution (`../part-4e-rendering/existing-checks.md:818-822`). The 4f
rule is **10 module-path prefixes** plus **8 named items**, and nothing else:

- Module paths: `selection::`, `crate::selection`, `boundary::`,
  `crate::boundary`, `scheduler::`, `crate::scheduler`, `codec::`,
  `crate::codec`, `caveman::`, `crate::caveman`.
- Named items: `decode_opencode`, `decode_pi`, `encode_opencode`, `encode_pi`,
  `stamp_block_identity`, `decoded_block_fingerprint`, `block_is_unchanged`,
  `project_messages`.
- **A hit counts as behaviour only when it is a call or a module constant.** A
  bare type mention is tracked separately, for the reason below.

The result is not one number but a set of tiers, and they **bracket** the truth
rather than pin it:

| Tier | Tests | What it measures |
| --- | --- | --- |
| Reach | ***unusable*** (206-210) | Every whole-pass driver executes 4f production lines, because `transform` consults `selection`, `boundary`, `scheduler` and `codec` on every pass |
| Type-mention | ***unusable*** (87) | Names any 4f type, including fixture literals |
| **Behaviour, full 4f** | **39** | Calls a 4f function or reads a 4f module constant in its own body |
| **Behaviour, brief-named files** | **18** | Same rule with `ck_wire::project_messages` removed |
| Behaviour, non-driver | 15 | Of the 39, those outside 4b's driver set |

**Both discarded tiers are unusable for one structural reason, and it is the
third direction the same inflation has arrived from.** 4f is the decision layer
every other pass consults, so a rule that keys on presence rather than on a call
cannot separate subject from scaffolding. The type-mention tier returns 87
because 55 of the 280 tests construct `ck_wire::CkWireBlock` / `CkKind` /
`ProviderExtras` / `HarnessMeta` fixtures and 8 construct
`crate::config::McModuleConfig`; those are fixture literals for tests about
something else. Worse, the shared fixture driver `run`
(`transform.rs:14331-14338`) takes `d: &[ReductionDecision]` in its own signature
at `:14331`, so any rule mentioning `ReductionDecision` promotes the entire driver
population. The reach tier fails the same way from the other end: a 4f reach count
is approximately the whole driver population. **This is the same inflation 4e
reported for its helper fixpoint returning 190 and 4d for its 232-test reach
tier** (`../part-4e-rendering/existing-checks.md:124-136`). **Use 39 for
behaviour and 18 for the brief-named subset.** Both discarded numbers are stated
so a later pass does not recompute one and treat it as a finding.

### The 39 tests 4f draws from `transform.rs`

4f does draw from that module, so the reconciliation below is required rather
than vacuous. The 39, by the 4f unit they name:

| 4f unit named | Tests | `fn` lines |
| --- | --- | --- |
| `ck_wire::project_messages` | 26 | `:14585`, `:15064`, `:15086`, `:15105`, `:15262`, `:15355`, `:15412`, `:18360`, `:18700`, `:18850`, `:21462`, `:22321`, `:23138`, `:25459`, `:25525`, `:25655`, `:25695`, `:27150`, `:27216`, `:27338`, `:27431`, `:27528`, `:27619`, `:27807`, `:27940`, `:28388` |
| `codec::*` (`decode_opencode`, the encode entry points) | 7 | `:16287`, `:17100`, `:18491`, `:18592`, `:20276`, `:27807`, `:27940` |
| `selection::*` | 7 | `:15795`, `:15984`, `:16019`, `:23735`, `:23834`, `:23985`, `:27216` |
| `caveman::*` | 2 | `:25459`, `:25655` |
| `scheduler::*` function | 1 | `:12704` (`parse_cache_ttl`, `ttl_execute_fired`) |
| `scheduler::` constant | 1 | `:12923` (`MIN_PLAUSIBLE_CONTEXT_LIMIT`) |
| `boundary::*` | **0** | none found |

Rows overlap, so the column sums exceed 39. **`boundary.rs` is named by no test
in `transform.rs`'s flat module**, which is worth stating plainly: the boundary
unit's only in-crate evidence is its own 29 file-local tests and three Rust-only
goldens.

## The three-way reconciliation, which resolves its siblings rather than contradicting them

**Neither sibling figure is wrong, no correction is issued to either, and 4f's 39
is not a third disjoint claim on the 280.** All three inventories agree on the
same 285 attributes and the same 280 in the flat module, and each independently
reports its own broadest tier as unusable for the same structural reason. 4f's 39
decomposes onto 4b's five-bucket partition
(`../part-4b-transform/existing-checks.md:68-74`), which sums to 280 and was
re-verified arithmetically here:

| Bucket | Tests |
| --- | --- |
| Drive a whole pass | 210 |
| Unit-test a 4b helper only | 16 |
| Unit-test a 4e helper only | 22 |
| Both helper families | 5 |
| Neither, unclassified | 27 |

4b's 226 is `210 + 16`. 4e's 237 is `210 + 22 + 5`. The shared 210 is counted by
both and exclusive to neither, so `4b ∪ 4e` is `226 + 237 - 210 = 253`, leaving
27. 4f lands on that partition as follows:

| 4f's 39 | Tests | Where it already sits |
| --- | --- | --- |
| Inside 4b's driver set | **24** | Inside the 210, and therefore **already counted in both** 4b's 226 and 4e's 237. 4f adds no new test here; this is triple-shared evidence |
| Outside the driver set, inside 4e's op-specific 25 | **6** | `:18360`, `:18850`, `:22321`, `:27150`, `:27216`, `:28388`. Already counted in 4e's 237, in its `22 + 5` helper buckets |
| Outside both | **9** | `:12923`, `:15064`, `:15086`, `:18700`, `:21462`, `:25459`, `:25525`, `:25655`, `:25695`. The only candidates for an attribution neither sibling made |

**Three consequences, stated so no reader double-counts.**

- **A reader adding 226, 237 and 39 to get 502 has counted the 210 drivers three
  times and six further tests twice.** The union of all three parts over
  `transform.rs` is between **253 and 262** of 280, and the "belongs to no part"
  remainder falls from 27 to between **18 and 27**.
- **The 9 must lie inside 4b's 70 non-driver tests** (`16 + 22 + 5 + 27`). Which
  bucket each occupies cannot be pinned, because 4b's file does not enumerate its
  buckets and states at `:79` that "the 27 unclassified tests were not hand-read".
  That is the sole reason the union is a range rather than a number, and it is
  recorded as an open question rather than resolved. Two of the 9 do match 4b's
  description of the 27 as "small serde, timing, geometry and TTL unit tests":
  `:12923` is a context-limit geometry unit test, and `:12704` is a TTL unit test,
  though `:12704` is itself a driver.
- **8 of 4e's 25 op-specific tests are 4f-behaviour tests**: `:14585`, `:18360`,
  `:18850`, `:22321`, `:27150`, `:27216`, `:27338`, `:28388`. So 4e's op-specific
  bucket is not 4e-exclusive either. Every one of the eight calls
  `ck_wire::project_messages` while asserting a render property.

**One residual disagreement is recorded rather than resolved, exactly as 4e did
with its own. Four driver detectors now exist and none agrees.** 4b reports
**210**; 4e's lens C reported **207** and recorded the gap as a detector edge
(`../part-4e-rendering/existing-checks.md:57-60`); reproducing 4b's *stated*
literal rule here, a body calling `run(`, `transform(`,
`transform_with_projection(` or `apply_once_with_estimator(`, returns **206**; and
substituting a transitive helper fixpoint for that literal rule returns **196**.
**No correction was issued to any sibling.** The edge is in how a driver call is
spelled, not in what counts as a driver, and it moves the 24/15 split above by at
most a few tests. It is recorded because four sibling documents now report four
different numbers for one set.

## Integration tests and CI status

**Integration tests in 4f scope: none found. None of the 192 in-crate tests runs
in CI.**

All seven integration binaries under `crates/mc-module/tests/` were scanned at
`HEAD` for 4f module paths and named codec, config and wire items:

| Binary | Lines | 4f hits | Verdict |
| --- | --- | --- | --- |
| `direct_host.rs` | 438 | 2 | Both are the JSON string `"render_config"` (`:114`, `:177`), a config-identity field, not `config.rs`. **Out of scope.** 4e recorded the same two false positives |
| `boundary_counter_durability.rs` | 64 | 0 | **Name false positive.** Its one test (`:12`) exercises `ModuleMeta::boundary_divergence_pending_count` durability across a store reopen (`:19-25`). It never touches `boundary.rs` |
| `broca_roundtrip.rs` | 198 | 0 | **Name false positive.** An `mc_host` RPC subscribe-and-stream round trip (`:8-10`), not a codec round trip |
| `prepared_output.rs` | 282 | 0 | 4d |
| `host_adapter.rs` | 173 | 0 | — |
| `lifecycle_cli.rs` | 635 | 0 | Part 2a |
| `release_contract_conformance.rs` | 147 | 0 | Credential and closure-digest contracts. See below |

**4b has two integration tests driving a real transform
(`../part-4b-transform/existing-checks.md:51`) and 4d has ten. 4e has zero. 4f
has zero.** The decision layer every pass consults, the two codecs that own the
bytes entering and leaving the crate, and the crate's only trust-policy
enforcement point all have no coverage outside their own `mod tests`.

**CI, verified at `HEAD` against all five files in `.github/workflows/`**
(`ci.yml`, `claude-code-review.yml`, `historian-eval.yml`,
`retrieval-benchmark.yml`, `shm-hardening-optin.yml`):

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`,** `ci.yml:172` at `HEAD` and
   `:168` at `76cd6f41`. `--test lifecycle_cli` selects one integration binary and
   does **not** build the `--lib` target, so no in-crate 4f test is compiled, let
   alone run.
2. **The other `mc-module` step is build-only:**
   `cargo build -p mc-module --bin ck-mc-host`, `ci.yml:169` at `HEAD` and `:165`
   at `76cd6f41`. No `--release`, so the artifact CI produces is a debug build.
   This is the fact the guards section turns on.
3. **There is no `cargo test -p mc-module --lib`, no
   `cargo nextest run -p mc-module`, and no `--workspace` Rust test job.**
4. **`scripts/test-rust.sh` would cover 4f and no workflow invokes it.** It runs
   `cargo nextest run --workspace` plus `cargo test --workspace --doc` (`:8-10`),
   with a `cargo test` fallback, and is wired into root `package.json` as
   `test:rust` and into `check:all`. Neither name appears in any workflow; the
   single grep hit is a comment at `ci.yml:378` describing what a contributor's
   local pass covers.

### `release_contract_conformance.rs` does not run, its own header argues it must, and running it would not cover this scope

Three facts, and they compose into a conclusion neither the brief nor the scope
map stated in full.

- **It does not run.** The binary is not selected by `--test lifecycle_cli`, no
  other workflow step names it, and no `--workspace` Rust test job exists. Its
  three tests are at `:16`
  `credential_constants_match_the_release_contract`, `:47` and `:129`.
- **Its own header argues its drift must fail the build.** `:1-8`, read directly
  at `HEAD`, states that each equality is "load-bearing at runtime", that "a
  drifted fingerprint label mismatches every presented credential fingerprint,
  and a drifted canonical encoding makes every qualified closure digest
  unverifiable at spawn", and concludes "so the drift must fail the build, not the
  deployment". **The drift fails no build.** The scope map already raised this as
  needing human input (`:681`); this pass confirms the mechanism rather than
  resolving the question.
- **Its content reaches no 4f file, so even running it would not cover this
  scope.** Zero 4f module paths or named items appear in it. It imports
  `mc_host::broca::subprocess` constants and `mc_host::harness_closure`, and reads
  `mc_module::release_contract::RELEASE_CONTRACT_JSON` (`:19`), a `pub mod` at
  `lib.rs:43` that is not a 4f file. It is inventoried here because the brief
  names it, not because a 4f property depends on it.

One qualification keeps the finding honest: a different, TypeScript-side contract
check does run. `bun run release:contract:check` is `ci.yml:109` and `ci.yml:384`,
resolving to `bun scripts/generate-mc-host-release-manifest.ts --check`. That
gates the generated manifest. It does not compile or execute the Rust encoder
whose agreement with the manifest is what `release_contract_conformance.rs`
asserts. So the contract has a gate, and the Rust half of it does not.

**Consequence for every 4f record.** `Exercised: partial` means "a test exists on
a developer's machine", and for the one guard whose test is
`#[cfg(debug_assertions)]`-gated (`codec/opencode.rs:2077`) it means "a test
exists that a release-profile run cannot compile". METHOD.md's `Exercised`
vocabulary does not distinguish either from `not yet`. 4b, 4c, 4d, 4e, the scope
map (`:681`) and both 4f sibling lenses have all raised it. It is recorded here as
needing a human ruling, not resolved.

## TypeScript-side gates

**4f has exactly one CI-gated TypeScript check that shares a fixture with this
Rust code, and it tests a parallel TypeScript implementation rather than the Rust
code. No case of "each half tested against a fake of the other" was found
anywhere in 4f.** That pattern is 4d's
(`../part-4e-rendering/existing-checks.md:322`).

`ci.yml:257` runs `bun run test`, which root `package.json` defines as
`sh scripts/test-shard.sh packages/plugin && bun run --cwd packages/pi-plugin test && bun run --cwd packages/cli test && bun run --cwd packages/retina-local-fs test`.
`ci.yml:317` runs the pi-plugin suite again directly. `bun test` from a package
root recursively discovers every `*.test.ts` beneath it, so the gates below do run
on every pull request.

| Gate | Relationship to the Rust code | What it actually tests |
| --- | --- | --- |
| `packages/plugin/src/shared/prompt-surface.test.ts:105` | **Parallel implementations against a shared frozen fixture. Does not execute Rust** | Named "matches the Rust cache_ttl resolver over shared routing vectors". Reads `crates/mc-module/testdata/cache-ttl-routing-vectors.json` at `:110` and runs the TypeScript `resolveCacheTtl` over all 5 cases. The Rust leg is `config.rs:760` `cache_ttl_resolution_matches_shared_typescript_vectors`, reading the same file at `:762` |
| `packages/pi-plugin/src/resolvers.test.ts`, `packages/plugin/src/hooks/magic-context/event-resolvers.test.ts` | **Parallel implementation only. No shared artifact** | Both name `resolveCacheTtl`; neither reads `cache-ttl-routing-vectors.json`. They test the TypeScript resolver against their own expectations |
| `packages/plugin/src/hooks/magic-context/compartment-trigger.test.ts`, `packages/pi-plugin/src/context-handler.test.ts` | **Parallel implementations only. No shared artifact, no Rust reference** | The TypeScript `checkCompartmentTrigger` and `resolveProtectedTailBoundary` originals `boundary.rs` was ported from. `boundary.rs`'s three goldens (`:2247`, `:2285`, `:2329`) are replayed by Rust only |
| `packages/plugin/src/hooks/magic-context/module-wire.test.ts` | **Parallel implementation only** | Imports the TypeScript `encodeOpenCodeMessagesToCk` (`:18`). It does not invoke `codec/opencode.rs` |

**The asymmetry is the finding, and it is sharper here than in 4e.** For the one
two-legged fixture, `cache-ttl-routing-vectors.json` (5 cases, verified at
`HEAD`), **the leg that runs in CI is the TypeScript one and the Rust leg runs
nowhere**, so a Rust-side `resolve_cache_ttl` regression is invisible to CI. For
every other cross-language fixture in 4f the pattern is worse: the fixture is
one-legged, replayed by Rust only, and the Rust leg does not run either.

| Fixture | Rust consumer | TypeScript consumer | Generator |
| --- | --- | --- | --- |
| `cache-ttl-routing-vectors.json` | `config.rs:762` | `prompt-surface.test.ts:110` | none found in `gen/` |
| `scheduler-golden.json` | `scheduler.rs:1051` | **none** | `gen/gen-scheduler-golden.ts` |
| `selection-golden.json` | `selection.rs:1733` | **none** | `gen/gen-selection-golden.ts` |
| `boundary-golden.json` | `boundary.rs:2159` | **none** | `gen/gen-boundary-golden.ts` |
| `caveman-golden.json` | `caveman.rs:628` | **none** | `caveman.ts`, per 4e |
| `codec/opencode-golden.json` | `codec/mod.rs:57` | **none** | `testdata/codec/gen-opencode-golden.ts` |
| `codec/pi-golden.json` | `codec/mod.rs:180` | **none** | `testdata/codec/gen-pi-golden.ts` |
| `codec/serve-native-golden.json` | `codec/mod.rs:103` | **none** | none found |

**No 4f fixture has a provenance guard, and no workflow or npm script regenerates
any of them.** This is the one place 4f is strictly weaker than 4e: 4e at least
has `tail_hygiene.rs:1035-1039`, an `assert_eq!` recomputing the fixture input
hash against a `provenance.input_sha256` field, with a dedicated mutation test at
`:1099`. Verified here that no 4f file contains any `provenance`, `input_sha256`
or `generator_version` fixture assertion; the only `provenance` matches in 4f are
`config.rs`'s production `CacheTtlProvenance` enum (`:151`, `:159-166`, `:204`)
and its test at `:745`, which concern the origin of a config value and not of a
fixture. Both codec goldens do carry `generated_from` and `projection_oracle`
top-level fields, and **neither is deserialized**: `codec/mod.rs`'s
`OpenCodeGolden` (`:28-34`) and `PiGolden` (`:41-47`) declare only `coverage`,
`missing_capture_classes` and `cases`. Both fields are inert documentation,
confirmed by reading both fixtures at `HEAD`. A 4f fixture that no longer matches
its generator is caught by review alone.

**One documented Rust-versus-TypeScript divergence is intentional and has no
cross-language check.** `config.rs:8` states the module "intentionally keeps
stricter model-selection policy than the current TypeScript implementation". Four
further comments assert TypeScript agreement (`:24`, `:35`, `:38`, `:41`) and
three Rust tests check named schema values (`:837`, `:843`, `:1088`). No
TypeScript test parses `config.rs`, and the divergence itself, being a deliberate
inequality, is asserted by nothing on either side.

## In-crate tests, clustered with line ranges

Counted directly at `HEAD`. The test-module line is given because four test-only
regions sit **above** the main test module and would derail a mechanical recount
keyed on a file's first `#[cfg(test)]`: `config.rs` carries one at `:268` and
`:715` before its module at `:805-806`, and `boundary.rs` carries them at `:737`
and at `:1009` (indented, inside an item) before its module at `:1974-1975`. This
is the same hazard 4e recorded for `tail_hygiene.rs:38`
(`../part-4e-rendering/existing-checks.md:61-65`).

| File | Test module | Tests | Line range of test `fn`s | What they cover |
| --- | --- | --- | --- | --- |
| `selection.rs` | `:1413` | **37** | `:1573`-`:3349` | `:1732` the TypeScript selector golden; `:1858`-`:2486` band, force, emergency and supersession batching; `:2537` the `region_hint` UTF-16 cap and surrogate back-off; `:2552`-`:2762` the `provider_executed`, `frozen_arc` and dynamic-protection filters; `:2836` drop beats edit marker; `:2885` payload purity; `:3107`-`:3300` the duplicate-safe-tool family; `:3349` defer produces nothing |
| `boundary.rs` | `:1975` | **29** | `:2174`-`:3042` | `:2174` constants match TypeScript; `:2247`, `:2285`, `:2329` the three goldens; `:2473`-`:2772` the backward reasoning fence and fold-only guard; `:2809`-`:2877` wrap-up watermarks; `:2911`, `:2924` determinism and anchor monotonicity; `:2966`-`:3042` trigger and ordinal-zero edges |
| `config.rs` | `:806` | **26** | `:721`-`:1191` | `:760` the shared TypeScript cache-TTL vectors; `:797`, `:811`, `:829`, `:876`, `:913`, `:930`, `:981`, `:1096`, `:1166` the per-leaf trust tiering; `:837`, `:843`, `:1088` schema agreement; `:999`-`:1051` guidance override resolution; `:1181`, `:1191` JSONC stripping and the mtime cache |
| `codec/opencode.rs` | `:1323` | **17** | `:1413`-`:2157` | `:1413`-`:1978` fresh-part completeness, adjacency deletion, native-extras survival, polarity round trip, reasoning exemptions; `:1860` compaction as a boundary; `:2079` the duplicate-id guard, debug-only; `:2113` incremental sidecar pins; `:2157` typed wire projection |
| `scheduler.rs` | `:919` | **16** | `:1050`-`:1437` | `:1050` the golden; `:1206`-`:1257` band geometry and the durable-overflow arm; `:1270`-`:1397` deferral, latch lifecycle, determinism, vocabulary mapping; `:1417`-`:1437` the never-TTL family |
| `codec/pi.rs` | `:1079` | **14** | `:1083`-`:1487` | `:1121` split-pipe ids; `:1153`-`:1231` adjacency deletion and survivor extras; `:1277`-`:1404` multi-part, image, opaque and empty-error tool results; `:1427`, `:1447`, `:1470` frozen and untouched replay; `:1487` compaction as a boundary signal |
| `codec/mod.rs` | `:14` | **6** | `:55`-`:290` | `:55` and `:178` the two harness round-trip goldens; `:93` the serve-native golden; `:129` fresh-prefix synthetic isolation; `:216` leading-block removal without reindex drift; `:290` a fixture-builder shape check |
| `ck_wire.rs` | `:740` | **6** | `:782`-`:1226` | `:782` retained-byte accounting; `:1023`-`:1128` arc identity and the user-carried tool-result accept and reject cases; `:1155` opaque and media inside tool-result content; `:1226` incremental prefix reuse |
| `caveman.rs` | `:613` | **1** | `:626` (extent `:626-650`) | The 42-case differential golden. The only test in 651 lines. Shared with 4e |
| `session_resolver.rs` | `:57` | **1** | `:61` (`#[tokio::test]`, attribute `:60`) | `unsupported_mapping_is_local_absence`. The supported-mapping path has no test |
| `codec/sidecar.rs` | **none** | **0** | — | **No test module and no test.** See quiet area 1 |

### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]`: none found in any 4f file.** Verified by matching both `#[ignore]`
and `#[ignore = "..."]`, the form 4e recorded that a bare grep misses. The 4f draw
from `transform.rs` does include one ignored test, `:28388`
`full_module_pass_timing_fixture` (attribute `:28387`), which 4e also counts.

**`should_panic`: none found in any 4f file.** One test nevertheless has a panic
oracle, written a way a `should_panic` grep misses:
`codec/opencode.rs:2079` `whole_array_tool_use_guard_rejects_both_id_collision_directions`
uses `std::panic::catch_unwind` at `:2106` and asserts `.is_err()`. It is the only
`catch_unwind` in 4f, and it carries `#[cfg(debug_assertions)]` at `:2077`, which
the guards section turns on.

**Property, mutation and concurrency tooling: none found.** Zero occurrences of
`proptest`, `quickcheck`, `loom`, `shuttle` or `miri` across all eleven 4f files.
No coverage configuration exists in the repository, so every placement statement
in this file is structural rather than measured. No `mc-module` entry in
`.config/nextest.toml`, so no 4f test is serialized, grouped or timeout-adjusted.

## Production assertions and guards, clustered

Measured over production halves only, meaning each file up to its test-module line
as listed above, with the four pre-module `#[cfg(test)]` regions
(`config.rs:268`, `:715`, `boundary.rs:737`, `:1009`) treated as test-only.

**Runtime assertions: three, all `debug_assert!`, all compiled out of release, all
in one file.** Verified at `HEAD` by matching `debug_assert` across every 4f
production half, which returns exactly these three lines and nothing in the other
ten files.

| Site | Guard | Release behaviour | Test |
| --- | --- | --- | --- |
| `codec/opencode.rs:251` | `debug_assert!(replace_from <= messages.len())` | **Still panics, elsewhere, in every profile.** The slice `&messages[replace_from..]` at `:258` is an index-out-of-range panic on the same condition. The assertion buys a better message for a failure that is not silent | **none** |
| `codec/opencode.rs:252` | `debug_assert!(replace_from <= prior.order.len())` | **Silent.** The only consumer of `replace_from` against `prior.order` is `prior.order.iter().take(replace_from)` at `:265`, and `take` saturates. A violation yields a short sidecar with no signal | **none** |
| `codec/opencode.rs:466` | `debug_assert!(duplicates.is_empty(), "OpenCode serialization produced duplicate tool_use ids: {duplicates:?}")`, the whole body of `assert_unique_tool_use_ids` (`:462-470`) | **No enforcement at all.** The function becomes a no-op, though `duplicate_tool_use_locations(messages)` at `:465` still runs and its result is discarded | `:2079`, debug-gated at `:2077` |

**The release-behaviour divergence, stated as the correction at the top of this
file establishes it.** Three separable facts, each verified line by line:

1. **`:251` is not the dangerous one.** Its condition is re-checked by the
   language at `:258`, so a violated `:251` fails loudly in every profile.
2. **`:252` is the silent one.** Same function, adjacent line, no release
   equivalent, and `take` at `:265` converts a violated precondition into a
   silently truncated sidecar. **Neither `:251` nor `:252` has a test**:
   `decode_opencode_sidecar_incremental` has exactly one test,
   `incremental_sidecar_carries_pins_across_three_generations`
   (`codec/opencode.rs:2113`), which calls it three times with `replace_from` of
   **1, 2 and 2** (`:2128`, `:2139`, `:2151`), all in range. Its single production
   caller is `lib.rs:12578`, outside 4f.
3. **`:466` enforces nothing in release, and its only test is debug-gated.** This
   is the mirror image of 4e's belt and it is worse. 4e's
   `enforce_unique_tool_use_ids` has two arms, a `debug_assert!` and a
   `#[cfg(not(debug_assertions))]` repair path, each with its own test
   (`../part-4e-rendering/existing-checks.md:207-247`). The encode-side
   `assert_unique_tool_use_ids` has **one** arm, so in release it neither enforces
   nor repairs. Three production call sites depend on it:
   `codec/opencode.rs:370` inside the encode path, plus `lib.rs:12985` and
   `lib.rs:21308`. Its only test carries `#[cfg(debug_assertions)]` at `:2077`, so
   it does not compile in a release test build. **Whichever profile ships, the
   guard's shipped behaviour has no test.**

**Verified: no `cfg(not(debug_assertions))` exists anywhere in 4f.** Matched
across all four `codec/` files, `config.rs`, `scheduler.rs`, `boundary.rs`,
`selection.rs`, `caveman.rs`, `ck_wire.rs` and `session_resolver.rs`: zero
occurrences. **So no release-arm counterpart exists for any of the three
assertions**, and unlike 4e there is no second arm whose behaviour a release run
could observe. The divergence risk in 4f is concentrated entirely in one codec
file, which is worth recording as a positive about the other ten: `config.rs`,
`scheduler.rs`, `boundary.rs`, `selection.rs` and `caveman.rs` contain no
`debug_assert!` and no `#[cfg(debug_assertions)]` production code, and their
clamps (`config.rs:47`, `:570`, `:591`, `:595`, `:607`; `boundary.rs:346`) and
totality guards (`scheduler.rs:385-419`, `boundary.rs:340-342`,
`selection.rs:1001-1009`) are unconditional expressions that behave identically in
both profiles.

**One qualification on that guard list, added by a disposition pass, because the
list reads as complete and is not.** The guards enumerated above are unconditional
and do behave identically in both profiles; that part stands. What the list does
not say is that the guard set itself has a hole. `BoundaryContext::trigger_budget`
is read at `boundary.rs:377-379` and again at `:756-761` through `unwrap_or_else`
with **no `is_finite` gate on the `Some` arm**, unlike `context_limit`,
`execute_threshold_percentage`, and `usage_percentage`, which are gated at
`:339-341`, `:363-372`, and `:926-931`. A `Some(f64::NAN)` therefore reaches
`:802`'s `tail_size_bar: trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER`, a bare
multiply with no `max` or `min` to absorb it, and the NaN lands in a struct whose
own doc comment (`:322-324`) says it is surfaced through the transform response's
historian diagnostics. So the profile-independence claim is correct and the
completeness impression it creates is not: this is a missing guard rather than a
conditional one, which is why it does not appear in a `debug_assertions` census at
all. Owned by
[dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic](catalog.md#dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic).

**Zero unconditional runtime assertions in the 4f production halves.** Verified by
matching `assert!`, `assert_eq!` and `assert_ne!` excluding `debug_assert` across
every production half: no match in any of the eleven files. **Zero compile-time
`const _` assertions in scope.** This matches 4e's finding for its own scope.

**Panicking sites: two, so 4f is unlike 4e, which had none.**

| Site | Form | Reachability |
| --- | --- | --- |
| `selection.rs:1258` | `PassClass::Defer => unreachable!("defer returned early")` | A genuine production `unreachable!` on a closed-enum match arm. Its safety rests on an earlier early return, which is exactly the shape METHOD.md reserves `unreachable` semantics for. `defer_pass_produces_nothing` (`:3349`) is the nearest test |
| `scheduler.rs:875` | `.unwrap_or_else(\|err\| panic!("invalid regex {source:?}: {err}"))` in `compile_case_insensitive` (`:871-876`) | Infallible by construction. The parameter is `source: &'static str` (`:871`) and both callers map over literal constant tables, `OVERFLOW_PATTERN_SOURCES` (`:882`) and `LIMIT_EXTRACTION_PATTERN_SOURCES` (`:897`). Not reachable from configuration or provider text |

**`.expect(`: four, in four distinct files.** `scheduler.rs:910`
`"valid 413 regex"`; `selection.rs:837` `"owner checked above"`;
`caveman.rs:299` `"cursor is on a character boundary"`; `ck_wire.rs:320`
`"flat projection differential bytes must serialize"`. **Two name a contract no
test asserts directly**: `"owner checked above"` and
`"flat projection differential bytes must serialize"`. `caveman.rs:299`'s label is
a UTF-8 boundary invariant on a hand-rolled cursor walk in a file with one test.

**`.unwrap()`: 26 in production halves, and all but one are regex compilation.**
`boundary.rs` 8 (`:1931`, `:1936`, `:1945`, `:1951`, `:1956`, `:1961`, `:1966`,
`:1971`), `caveman.rs` 17, `selection.rs` 1. Every regex site is a
`Regex::new(...)` over a literal pattern inside a `get_or_init`. The exception is
`selection.rs:607`, `serde_json::to_string(k).unwrap()` inside `canonical_json`,
on a map key. Zero `.unwrap()` in all four `codec/` files, `config.rs`,
`scheduler.rs`, `ck_wire.rs` and `session_resolver.rs` production halves.

**`let _`: three.** `codec/sidecar.rs`, `boundary.rs` and `ck_wire.rs` carry one
each. Comparable to 4e's one, below 4c's six.

**Typed rejection guards.** With no unconditional assertion anywhere, 4f
enforcement is a returned value or a `Result`. `ck_wire.rs`'s `project_messages`
is the only in-scope decoder returning `Result`, and it rejects three classes;
both directions are covered by its own tests, `:1061` for the accept case and
`:1128` for the reject case (`:1122` and `:1149` assert `UnpairedToolResult`,
verified at `HEAD`). `config.rs:568-570` clamps to
`MAX_EXECUTE_THRESHOLD_PERCENTAGE` (`:28`, `= 90.0`), the one numeric ceiling in
the trust policy, and `project_threshold_may_only_raise` (`:829`) is its test.

**Diagnostics that replace a guard.** `warn_ignored_project_key`
(`config.rs:575-581`) is the only reporting channel in the part, and it is called
for **six** pointers only (`config.rs:520`, `:538`, `:539`, `:540`, `:556`,
`:561`). At least six further leaves are dropped from the project tier with no
warning at all: `/historian/model`, `/historian/fallback_models`,
`/historian/module_model`, `/historian/module_fallback_models`, `/cache_ttl`, and
the object form of `/execute_threshold_percentage`. No clamp anywhere in
`config.rs` reports itself.

## Codec golden coverage

**Both harness directions have a golden, both goldens are one case each, their
oracle is derived from the test's own input, and each clears one required block
class through a missing-capture-classes mechanism.** All of the following was read
directly at `HEAD`, including both fixtures.

| Codec path | Golden | Cases | Oracle |
| --- | --- | --- | --- |
| `decode_opencode` then `encode_opencode` | `codec/opencode-golden.json` at `codec/mod.rs:57`, test `:55` | **1** | Decode twice and compare (`:80-81`), encode twice and compare (`:86-87`), then `encoded == strip_opencode_compaction(case.messages)` (`:88`) |
| `decode_pi` then `encode_pi` | `codec/pi-golden.json` at `codec/mod.rs:180`, test `:178` | **1** | Same shape: `:203-204`, `:209-210`, then `encoded == strip_pi_compaction(case.entries)` (`:211`) |
| `encode_opencode_with_session`, m0/m1/synthetic prefix | `codec/serve-native-golden.json` at `codec/mod.rs:103`, test `:93` | 1 | Field by field against `golden.m0`, `golden.m1`, `golden.synthetic_todo`, then `&encoded[3..] == golden.messages` (`:122-125`) |

**The directions with no golden at all**, established from the golden module's
`use super` list (`codec/mod.rs:24-26`, which is exactly `decode_opencode`,
`decode_pi`, `encode_opencode`, `encode_opencode_with_session`, `encode_pi`)
against the crate's re-export list (`:5-11`):

| Entry point or path | Golden | Notes |
| --- | --- | --- |
| `decode_opencode_with_sidecar` | **none** | Re-exported at `codec/mod.rs:6`, absent from `:24-26` |
| `decode_opencode_with_sidecar_and_base` | **none** | Same. One of the three `decode_*_with_sidecar` forms, not a fourth entry point |
| `decode_pi_with_sidecar` | **none** | Re-exported at `codec/mod.rs:10`, absent from `:24-26`. These three are the complete set of `decode_*_with_sidecar` forms |
| `encode_opencode_with_session_exemptions` | **none** | Re-exported at `codec/mod.rs:7`, absent from `:24-26` |
| `decode_opencode_sidecar_incremental` | **none** | Hand-built only, `codec/opencode.rs:2113`, with in-range arguments 1, 2, 2 |
| All of `codec/sidecar.rs`: `decoded_block_fingerprint` (`:151`), `stamp_block_identity` (`:158`), `has_stamped_block_identity` (`:188`), `block_is_unchanged` (`:192`), `match_block_metas` (`:229`), `stable_hash` (`:292`), `stable_hash_prefix` (`:298`) | **none** | No direct test anywhere in the crate. Reached only transitively from `codec/opencode.rs:553-554`, `:742`, `:763` and `codec/pi.rs:303-304`, `:372`, `:463`, so their only exercise is the two one-case goldens |
| Compaction extraction, both harnesses | **excluded by construction** | `strip_opencode_compaction` (`:273-281`) and `strip_pi_compaction` (`:283-288`) **remove compaction from the expected value before comparison at `:88` and `:211`**. Covered by hand-built tests only: `codec/opencode.rs:1860`, `codec/pi.rs:1487` |

**The gate is designed to pass without a class, and the two cleared classes are
`subtask` and `redacted_thinking`.** The scope map asked whether the `coverage` and
`missing_capture_classes` manifest "admits an unclassified block shape silently"
(`:641-644`). `assert_coverage_or_recorded_missing` (`codec/mod.rs:254-271`) fails
only on a required class present in **neither** list (`:262-266`), so listing a
required class in `missing_capture_classes` clears it. Reading both fixtures at
`HEAD`:

| Golden | Required classes | Covered | Passing only by being declared missing |
| --- | --- | --- | --- |
| `opencode-golden.json` | 12 (`codec/mod.rs:63-74`) | 11 | **`subtask`** |
| `pi-golden.json` | 13 (`codec/mod.rs:185-198`) | 12 | **`redacted_thinking`** |

So two block classes the test itself declares required have no golden coverage in
either direction, and the gate is green. `redacted_thinking` is the more
load-bearing of the two: it is an Anthropic-signed block class, and 4e's records
turn on signed-block handling.

**The encode-direction oracle is self-referential, and it belongs here as a
sampling limit rather than as coverage.** For both harnesses the expected value is
a transformation of the test's own input, not an independently generated expected
output. That proves round-trip identity over unmodified content. It cannot detect
a decode error the encoder symmetrically reverses, because both halves are the code
under test. Each fixture carries a `projection_oracle` field naming an intended
external oracle, and nothing deserializes it.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **`codec/sidecar.rs` is the only file in 4f with zero tests, and it owns the
   block identity everything downstream keys on.** 339 lines, no `#[cfg(test)]`,
   no `mod tests`, no test attribute; verified by direct count at `HEAD`.
   `stamp_block_identity` (`:158`), `decoded_block_fingerprint` (`:151`) and
   `block_is_unchanged` (`:192`) have no direct test anywhere in the crate, and
   neither do `has_stamped_block_identity` (`:188`), `match_block_metas` (`:229`),
   `stable_hash` (`:292`) or `stable_hash_prefix` (`:298`). Every exercise they get
   is transitive, through `codec/opencode.rs:553-554`, `:742`, `:763` and
   `codec/pi.rs:303-304`, `:372`, `:463`, which means through the two one-case
   goldens above. `block_is_unchanged` decides whether a decoded block is treated
   as unchanged and therefore whether native extras replay verbatim, so a
   fingerprint that silently collides or silently differs changes served bytes. The
   scope map predicted this exactly, calling it "the untested block-identity
   stamper" (`:622`, `:639-641`). Confirmed, and it is the quietest area in the
   sub-part.

2. **`caveman.rs` is 651 lines behind one snapshot test, and 4f cannot see the
   consumer 4e found.** `differential_golden_matches_typescript_oracle` (`:626`,
   extent `:626-650`) replays 42 frozen cases from `caveman-golden.json` (`:628`)
   and is the entire check on the file. The fixture is generated from `caveman.ts`,
   has **no TypeScript consumer**, and no workflow regenerates it, so the
   compatibility contract the header names (`:3-6`) is a snapshot rather than the
   live oracle. The file also carries 17 of the 26 production `.unwrap()` calls in
   4f and the `.expect("cursor is on a character boundary")` at `:299` on a
   hand-rolled UTF-8 cursor walk. **This is a restatement of 4e's quiet area 3
   (`../part-4e-rendering/existing-checks.md:719-729`), not an independent
   finding**, repeated because the brief assigns the file to 4f. 4e adds the part
   4f cannot see: caveman output feeds the hygiene metric through
   `tail_hygiene.rs:422-429`, which the 12-case parity golden cannot reach, so the
   compression and the metric consuming it are each pinned by a fixture and never
   checked together.

3. **The codec goldens are one case each, with a self-referential oracle and a
   gate built to pass without a required class.** Three independent weaknesses on
   the two checks that stand for the entire native-to-CK-to-native contract: one
   case in `opencode-golden.json` and one in `pi-golden.json`; `subtask` and
   `redacted_thinking` cleared through `assert_coverage_or_recorded_missing`
   (`codec/mod.rs:254-271`); and the expected value at `:88` and `:211` derived
   from the input by `strip_opencode_compaction` / `strip_pi_compaction`. Five
   further exported codec entry points have no golden at all, all of
   `codec/sidecar.rs` has none, and compaction extraction is excluded from the
   oracle by construction. **These two tests carry 3,685 lines of
   `codec/opencode.rs` plus `codec/pi.rs` production code.**

4. **`codec/opencode.rs:252` is the only guard in 4f whose violation is silent in
   release, and it sits one line from one that is not.** `:251` is re-checked by
   the slice at `:258`; `:252` is consumed by `take` at `:265`, which saturates.
   Neither has a test, and the only test of the function passes in-range values.

5. **`assert_unique_tool_use_ids` enforces nothing in a release build and has no
   release-arm test.** `codec/opencode.rs:462-470`, three production callers
   (`:370`, `lib.rs:12985`, `lib.rs:21308`), one test gated
   `#[cfg(debug_assertions)]` (`:2077`), and no `cfg(not(debug_assertions))`
   anywhere in 4f. Unlike 4e's belt it has no repair arm, so the encode-side
   duplicate-id contract is unenforced in the profile a release artifact ships.

6. **`boundary.rs` is named by no test in `transform.rs`'s flat module.** 3,053
   lines whose only in-crate evidence is its own 29 file-local tests and three
   Rust-only goldens. Of the 39 tests 4f draws from `transform.rs`, zero name a
   `boundary::` symbol, so no whole-pass test asserts anything about where the
   protected-tail split lands.

7. **`selection.rs:1258` is a live production `unreachable!` whose safety rests on
   a non-local early return.** 4e recorded zero panicking sites in its 9,304
   lines; 4f has this one plus the infallible-by-construction `scheduler.rs:875`.

8. **`session_resolver.rs` is 70 lines with one test covering the absence case
   only.** `unsupported_mapping_is_local_absence` (`:61`). The supported-mapping
   path has no test in the file.

9. **The one two-legged cross-language fixture is gated only on the leg that is
   not this crate.** `cache-ttl-routing-vectors.json` has 5 cases. The TypeScript
   leg (`prompt-surface.test.ts:105`) runs on every pull request via `ci.yml:257`;
   the Rust leg (`config.rs:760`) runs nowhere.

10. **No 4f fixture has a provenance guard and no workflow regenerates any of
    them.** Eight fixtures, zero hash checks, and the two `generated_from` and
    `projection_oracle` fields that exist are not deserialized
    (`codec/mod.rs:28-34`, `:41-47`).

11. **`config.rs`'s per-leaf trust tiering is the crate's only security-shaped
    policy and its deliberate divergence from TypeScript is asserted by nothing.**
    Nine of its 26 tests check tiering (`:797`, `:811`, `:829`, `:876`, `:913`,
    `:930`, `:981`, `:1096`, `:1166`), the densest per-leaf coverage in 4f. But
    `:8`'s claim that the module "intentionally keeps stricter model-selection
    policy than the current TypeScript implementation" is an inequality no test on
    either side evaluates.

12. **No integration coverage of the decision layer, the codecs, or the trust
    policy.** Zero of the seven integration binaries reach 4f, against 4b's two
    and 4d's ten. Two of the seven have names suggesting otherwise and do not
    deliver: `boundary_counter_durability.rs` tests a store counter, and
    `broca_roundtrip.rs` tests an RPC stream.

## Registered claims that no record owns

**Added by a disposition pass.** Two claims were registered in the claims lens
with implementing code identified and a testable property spelled out, and then
became no record in `catalog.md`. Neither is a synthesis oversight of the ordinary
kind — a claim nobody noticed — because both were written up in full at
[`_lenses/lens-c1-claims-and-config.md:360-384`](_lenses/lens-c1-claims-and-config.md),
including the reason each one matters. They fell through an **ownership** gap, and
the disposition's job is to close it by naming one owner rather than to mine them.

**Both are assigned to 4f.** The ambiguity was real and worth stating so the next
pass does not re-open it. `caveman.rs` is claimed by both 4e and 4f — this
inventory's own scope resolution 3 says so — and the caveman claim's *mechanism*
lives at `transform.rs:6339-6358`, which is 4b's file. The `smart_drops` claim's
flag is parsed in `config.rs` (4f) and consumed in `transform.rs` (4b). So each
claim straddles two sub-parts, which is precisely why neither got picked up. 4f
takes both, for one reason that applies to both: **4f owns the decision, and the
other part owns the application.** The caveman claim is a claim about what
`caveman::compress` returns for a given depth, and `compress` is in 4f's
brief-named file set. The `smart_drops` claim is a claim about what a flag resolved
by `config.rs` does to output, and `config.rs` is 4f's. Each record will need a
cross-part citation into `transform.rs`; that is a citation, not shared ownership.

| # | Claim | Source | Implementing code | Why it never became a record, and what it needs |
| --- | --- | --- | --- | --- |
| C1-29 | Caveman tier shifts are path-independent: compressing the original at the final depth gives byte-identical output to shifting through intermediate depths | `CONFIGURATION.md:740` | Real, and outside 4f: `transform.rs:6339` reads `row.source_bytes` and `:6358` calls `caveman::compress(&source, level)` on the pristine text, and `:6352-6354` refuses a non-increasing depth | The property is asserted nowhere. `caveman.rs`'s only test (`:626`, extent `:626-650`) replays 42 single-shot cases from `caveman-golden.json` against `Lite`, `Full`, and `Ultra` independently; it never applies two compressions in sequence. **The claim is load-bearing exactly because `compress` is not idempotent by construction**: `apply_ultra_connectives` (`:472`) and `apply_ultra_abbreviations` (`:501`) rewrite words into symbols that a second pass would read as different input, so compressing an already-cavemaned string is not a no-op and the persisted-original design is what makes the claim true. A record needs one oracle over pairs of depths: `compress(compress(t, Lite), Ultra) != compress(t, Ultra)` is the interesting inequality, and the guarantee is that the *production path* never takes the left-hand form. That is a `safety` claim about `transform.rs`'s read of `source_bytes`, checkable by a direct call, no fault |
| C1-30 | With `smart_drops` off, the messages sent to the model are byte-identical to the age-based-only behaviour, so the feature is inert | `CONFIGURATION.md:763` | `NOT FOUND` as a byte-equality check. The flag defaults `false` (`config.rs:135`) and is settable from either tier (`:467-469`, `:541-543`) | **This is the strongest testable statement in the entire configuration document and nothing takes it**, which is the reason it deserves a record more than most: a single flag flip gives a free differential oracle over the emitted message array, with no fixture beyond two resolutions of the same config. It never became a record because the flag is 4f's and the emitted array is 4b's, and neither part reached across. A record needs the flag off and on over one identical input, and byte equality of the served array in the off case against a build with the feature's code path removed or bypassed. Note the interaction with `dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list`, which observes that a *project* config can turn `smart_drops` on against `CONFIGURATION.md:767`'s statement that it is intentionally off; that record covers who may set the flag and this one would cover what the flag does when unset |

Neither is mined here, per METHOD rule 6 and the disposition's scope. Both are
queued in [portfolio-evaluation.md](portfolio-evaluation.md) with the owner
recorded, so the next pass has one place to look and one part to look in.

## Sampling limits on this inventory

Seven limits, stated so a later pass does not read absence as absence of risk.

- **The 39-test figure is a symbol match over parsed test bodies, not coverage
  instrumentation.** The repository has no coverage measurement, so every
  placement statement in this file is structural. Obtained directly at `HEAD`: the
  285 attribute count, the 280 plus 5 split, the first and last `fn` lines, all
  eleven per-file test counts, all eleven scope line counts, the zero `#[ignore]`
  and zero `should_panic` results, the three `debug_assert` sites and the absence
  of `cfg(not(debug_assertions))`, the two panicking sites, both `ci.yml` line
  numbers, both goldens' case counts and coverage arrays, the five
  `cache-ttl-routing-vectors.json` cases, and every cited line.
- **The 4f symbol rule is reproducible, and that is the one respect in which this
  attribution is stronger than 4e's.** A later pass recomputing 39 should get 39
  from the ten module paths and eight named items above, applied to brace-matched
  bodies with literals stripped, counting calls and module constants only.
- **Two tiers are reported and discarded**: the type-mention tier at 87 and the
  reach tier at 206 to 210. Both are artifacts of 4f being the decision layer
  every pass consults, exactly as 4e's 190 was an artifact of 4e being the terminal
  stage. Neither is a finding.
- **Four driver detectors disagree: 210 (4b), 207 (4e's lens C), 206 (4b's stated
  literal rule reproduced here), 196 (a transitive helper fixpoint).** The 24/15
  split of 4f's 39 shifts by a few tests under each. **No correction was issued to
  any sibling.**
- **The union of the three parts over `transform.rs` can only be bracketed at 253
  to 262 of 280**, because 4b does not enumerate its buckets and states at `:79`
  that the 27 unclassified tests were not hand-read. The orphan remainder is
  therefore between 18 and 27 rather than a number.
- **`caveman.rs`'s single test is counted by both this file and 4e's**, so 4e's 277
  and any figure here overlap by exactly one in-crate test plus 651 production
  lines.
- **Whether the two codec goldens exercise a given production path was inferred
  from the golden module's `use super` list (`codec/mod.rs:24-26`) and the
  re-export list (`:5-11`), not from execution.** Five exported entry points and
  all of `codec/sidecar.rs` are recorded as having no golden on that basis.
- **Whether a never-executed test counts as `Exercised: partial` is unresolved, and
  it governs all 192 checks above.** For `codec/opencode.rs:2079` the question is
  sharper: the test does not compile in a release test build. 4b, 4c, 4d, 4e, the
  scope map (`:681`) and both 4f sibling lenses raised it. It needs a human ruling,
  not a synthesis decision.
