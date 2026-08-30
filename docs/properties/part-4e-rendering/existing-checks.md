# Part 4e existing-check inventory

Every claim-bearing check for rendered output, tag numbering, and the nudge
overlay: `transform.rs:7511-12623` (5,113 lines) plus six whole files the scope
map assigns to this sub-part, `tail_hygiene.rs` (1,278), `decay_render.rs` (849),
`caveman.rs` (651), `memory_render.rs` (538), `classify.rs` (490) and
`prompt_surface.rs` (385). Seven units, **9,304 production lines**, re-derived at
`HEAD` and matching the scope map
(`../part-4-module/_lenses/scope-map-and-risk-ranking.md:587-595`). The sub-part
owns the terminal stage of every transform pass: the two process-global tag
caches, tag minting and the mint frontier, overlay application and the
tag-imitation defence, the user-hint lexical search, the Channel-1 and Channel-2
decisions, surface strips, the m0/m1 splice, the tail-hygiene metric, caveman
compression, the prompt-surface asset selection, and the two output-integrity
guards.

Provenance. `HEAD` is `e447c927` ("refactor(shm): trim final review leftovers").
`.github/workflows/ci.yml` differs across `76cd6f41..HEAD`, and the one step that
matters here moved: the `mc-module` test invocation
`cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at `76cd6f41` and
`ci.yml:172` at `HEAD`. Both were confirmed directly, the second in the working
tree and the first through `git show 76cd6f41:.github/workflows/ci.yml`, and both
are cited wherever the step appears. The build step above it moved the same way:
`cargo build -p mc-module --bin ck-mc-host` is `:165` at `76cd6f41` and `:169` at
`HEAD`. Lens A cites `ci.yml:164-165` and lens C cites `:169`; those are the
`run:` block and its command line for one step at the two commits. All of them
describe two steps; only the file moved.

Two files the task brief and one sibling lens place in this scope are **not**
4e, and the exclusions are recorded rather than argued: `src/injection.rs` (911)
is 4b (`scope-map-and-risk-ranking.md:526`), whose inventory already counts its
18 tests (`../part-4b-transform/existing-checks.md:45`), and `src/ck_wire.rs`
(1,279) is 4f (`:619`). Both are cited below only where a 4e property depends on
them.

Four corrections to references handed to this synthesis, made per METHOD.md rule
1 and recorded rather than silently applied.

- **Lens C reports `should_panic`: none found in any 4e file. That is wrong, and
  the one that exists is load-bearing.** `transform.rs:21503` carries
  `#[should_panic(expected = "served output contains duplicate tool_use ids")]`
  on `duplicate_tool_use_belt_panics_in_test_builds` (`:21504`), which is one of
  4e's own 25 op-specific tests and the only check on the debug arm of the
  duplicate-id belt. Verified by grepping all seven units: exactly one
  `should_panic` in the sub-part, at `:21503`. The count below is **1**, not 0.
  Lens C's neighbouring observation still holds: the two `catch_unwind` sites at
  `:14314` and `:14321` wrap `assert_no_orphaned_tool_arcs` rather than
  production code.
- **Lens C's helper population is 115 by its own detector and 130 by an
  independent recount.** Recounting non-test `fn` lines inside the flat test
  module (`pub(crate) mod tests` at `:12626`) at `HEAD`, after resolving all 280
  test attributes to their `fn` lines, returns 130. The difference is a detector
  definition question, most likely `fn` items inside `impl` blocks in the test
  module. It changes no count in this file, and it is recorded because 4d hit the
  same class of discrepancy (117 versus 119) and a later pass comparing the
  inventories would otherwise see an unexplained gap.
- **Lens C's whole-pass driver count is 207 where 4b reports 210.** Lens C
  recorded this itself as a three-test detector edge on how the driver call is
  written, not a scope disagreement. It is repeated here because the
  reconciliation section below turns on the 210.
- **`tail_hygiene.rs`'s test module is `:724`, not the file's first
  `#[cfg(test)]`.** The first `#[cfg(test)]` in the file is at `:38`, on the
  test-only `HygieneBand::as_str` helper. Lens C's `:724` is correct; the note
  exists so a mechanical recount keyed on the first `#[cfg(test)]` line does not
  diverge.

An existing check does not remove a property from the catalog. **Every status
below is `unaudited`**: test adequacy belongs to
`/testing:invariant-test-review`, and production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory, and how the number was obtained

**277 in-crate tests reach this scope: 237 of the 280 tests in `transform.rs`'s
flat `mod tests`, plus the 5 in `mod nudge_formula_tests`, plus 35 file-local
tests in the six other 4e units. Of the 237, only 25 name a 4e-owned symbol in
their own body. There is no integration test in scope at all, and none of the
277 runs in CI.**

That is the headline. The attribution behind it is mechanical rather than
asserted, and it is stated in full so a reader can reproduce it.

`transform.rs` is 29,439 lines. Its test module is flat (`pub(crate) mod tests`
at `:12626`, no inner `mod`) and is read as evidence by both 4b and 4e, so a
test's subject cannot be read off its location. The attribution reproduces 4d's
four-step method so the inventories are comparable
(`../part-4d-facade/existing-checks.md:63-83`):

1. **Enumerate.** All `#[test]` and `#[tokio::test]` attributes. Re-counted
   independently at `HEAD`: **285** total, **280** at or after `:12626`, and
   therefore **5** in `mod nudge_formula_tests` (`:9629`). These are exactly 4b's
   figures (`../part-4b-transform/existing-checks.md:55-62`).
2. **Resolve.** Each attribute resolved forward to its following `fn` line,
   giving 280 test functions in the flat module. First is
   `claude_code_cache_ttl_mapper_is_lossy_because_provider_vocabulary_is_limited`
   at `:12645`; last is
   `channel2_directive_id_hashes_session_and_arming_watermark_deterministically`
   at `:29425`. Both re-derived at `HEAD`; both match 4b.
3. **Brace-match.** Each body brace-matched to its closing line with string
   literals stripped, so a test's extent is its real body rather than the gap to
   the next attribute.
4. **Match and fixpoint.** A curated set of **62** 4e-owned production
   identifiers — the splice, overlay, tag-cache, mint, hygiene, hint, strip and
   serialized-output-cache entry points and their constants — matched inside each
   body, then a fixpoint taken over the **115 non-test helper functions** in the
   flat test module, so a test that reaches the renderer only through a fixture
   driver is attributed transitively. See the correction above: a recount of that
   helper population returns 130. The curated 62-identifier list is lens C's and
   is not itself reproducible from this file, which is the sharpest sampling
   limit on the whole attribution.

The result is not one number but four tiers, and they **bracket** the truth
rather than pin it:

| Tier | Tests | What it measures |
| --- | --- | --- |
| **Reach** | **237** of 280 | Drives a whole pass, or names a 4e symbol transitively. Executes at least one line of 4e production code |
| Op-specific, helper fixpoint | ***unusable*** (190) | See below |
| **Op-specific, direct body match** | **25** | Names a 4e-owned render, tag, hygiene, overlay or hint symbol in its own body |
| **Name rule** | **89** | Test name contains a 4e-distinctive term |

**Two things about these numbers a later pass must not misread.**

**First, the fixpoint tier is unusable here, and the reason is structural rather
than accidental.** It returns 190. The shared fixture driver `run`
(`transform.rs:14331-14338`, which calls `transform` at `:14334`) transitively
names nearly every 4e symbol, because a whole pass renders output: any test that
drives a pass reaches the splice, the overlay application, the tag caches and the
hygiene metric. So the fixpoint promotes 165 whole-pass drivers into an
"op-specific" bucket that means nothing. **This is the same inflation sub-part 4d
reported** (`../part-4d-facade/existing-checks.md:95-103`), arriving from the
opposite direction: 4d's 232-test reach tier was inflated because 4d owns the
response vocabulary the whole crate speaks, and 4e's fixpoint tier is inflated
because 4e is the terminal stage every pass must traverse. **Use 237 for reach
and 25 for op-specific.** The 89-test name rule sits between them and is the
cheapest independent check on both.

**Second, 25 op-specific tests over 9,304 production lines is the real coverage
statement of this sub-part**, and the 237 must not be read as contradicting it.
237 tests execute 4e lines; 25 were written about 4e behaviour. The gap is 212
tests that render output incidentally while asserting something else.

### Reconciling sub-part 4b's "226 of 280", so a reader does not think one is wrong

**Neither figure is wrong, and no correction is issued to 4b. The two numbers
share 210 tests.** 4b's lens C partitioned the same 280 tests into five disjoint
buckets (`../part-4b-transform/existing-checks.md:68-74`), and the partition sums
to 280, which was re-verified arithmetically here:

| Bucket | Tests |
| --- | --- |
| Drive a whole pass | 210 |
| Unit-test a 4b helper only | 16 |
| Unit-test a 4e helper only | 22 |
| Both helper families | 5 |
| Neither, unclassified | 27 |

4b's 226 is `210 + 16`. The symmetric 4e figure from the same partition is
`210 + 22 + 5 = 237`, which is exactly the reach tier derived independently
above. 4b said so itself at `:73-74`: "Because a pass also renders output, the
210 traverse 4e as well and are shared evidence, not 4b-exclusive."

| Figure | Value | What it is |
| --- | --- | --- |
| 4b scope | 226 | 210 shared drivers + 16 4b-only |
| 4e scope | **237** | 210 shared drivers + 22 4e-only + 5 both |
| Shared | 210 | Counted by both parts, exclusive to neither |
| Union | **253** | `226 + 237 - 210` |
| Neither | 27 | 4b's unclassified bucket: small serde, timing, geometry and TTL unit tests |

So the two inventories together account for 253 of `transform.rs`'s 280 tests,
and the remaining 27 belong to neither part. **A reader adding 226 and 237 to get
463 has double-counted the 210 drivers.**

One residual disagreement is recorded rather than resolved. Lens C's own
whole-pass driver detector returned **207**, a three-test edge against 4b's 210,
and lens C recorded it (`_lenses/lens-c-claims-and-checks.md:345-349`) rather
than absorbing it. The edge is in how the driver call is written, not in what
counts as a driver, and it changes no tier in this file: 237 decomposes as either
`210 + 22 + 5` on 4b's partition or `207 + 30` on lens C's. Both arrive at 237.

The other place the two passes disagree is the size of the "4b-only" and
"4e-only" buckets, and that is definitional rather than an error. Lens C's 4b
symbol set was the full 300 identifiers defined in `transform.rs:1-7510` plus the
seven 4b files, which is much wider than the "4b-only symbol" rule 4b's lens
used, so the direct-match buckets are not comparable to 4b's 16 and 22. The tier
that *is* comparable, the shared driver count, agrees to within three tests.

## Debug versus release: the sharpest finding in this sub-part

This gets its own section because it is the one place in the catalog so far where
**the observable content of the served array depends on the build profile**, and
because the inventory consequence is counterintuitive: broad test coverage of one
of these guards actively masks its total absence from production.

Two distinct axes are at work and conflating them produces the wrong conclusion:

| Axis | Gate | Present in a debug shipped binary? | Present in a release shipped binary? | Present in a `cargo test` build? |
| --- | --- | --- | --- | --- |
| Test-only code | `#[cfg(test)]` | **No** | **No** | Yes, either profile |
| Debug-only code | `cfg(debug_assertions)` | Yes | **No** | Debug yes, release no |

`assert_no_orphaned_tool_arcs` sits on the first axis and the duplicate-id belt's
loud arm sits on the second. A reader who files both under "not in release" will
conclude that a debug build detects orphan arcs. It does not.

### The duplicate-`tool_use` belt: two arms, one compiled

`enforce_unique_tool_use_ids` (`transform.rs:11231-11305`) is the last
transformation applied to the whole array, called once at `:12147`. It contains
two mutually exclusive arms:

| Arm | Gate | Behaviour on a duplicate `tool_use` id |
| --- | --- | --- |
| debug | `debug_assert!` at `:11246`, message `"served output contains duplicate tool_use ids: {duplicates:?}"` at `:11248`; the early return is `#[cfg(debug_assertions)]` at `:11303` | Panics. The pass aborts. No array is served |
| release | `#[cfg(not(debug_assertions))]` at `:11251`, block extending to `:11302` | Removes the later owner and its adjacent result (`:11258-11277`), drops any message the removal emptied (`:11297-11299`), and returns the modified array |

**The release-only drop path is `transform.rs:11251-11302`**, verified line by
line at `HEAD`, and it is the only code in 4e that removes content from the
served array on a profile-dependent basis.

Four consequences:

1. **The prose describes the arm that does not ship.** `:11227-11228` says "debug
   and test builds fail at the first violation so the originating path is fixed",
   and `:11230` frames the release repair as the alternative to "trapping a live
   session in a deterministic provider-400 loop". So the split is deliberate.
   What the prose does not say is that the release arm removes content with no
   record.
2. **The only report of a release-build content removal is a stderr line.**
   `eprintln!` at `:11241-11245` emits `mc-module: duplicate_tool_use_id
   session={} id={} message_index={} block_index={} action=drop_later`.
   `BuiltOutput` (`:11001-11006`) carries `messages`, `cache_entries`,
   `cache_stats` and `timings`, and no field names a dropped block or a dropped
   message.
3. **Each arm's test compiles only in the profile the other arm needs.**
   `duplicate_tool_use_belt_panics_in_test_builds` (`:21504`, with the
   `#[should_panic]` at `:21503`) covers debug.
   `duplicate_tool_use_belt_drops_later_owner_and_result_in_release` (`:21514`)
   carries `#[cfg(not(debug_assertions))]` at `:21512`, so it does not compile
   under a default `cargo test`. Whichever arm ships, its test is the one a
   developer does not run by default.
4. **CI builds debug.** `cargo build -p mc-module --bin ck-mc-host` (`:165` at
   `76cd6f41`, `:169` at `HEAD`) carries no `--release`, so the artifact CI
   produces selects the panicking arm. Whether the *distributed* `ck-mc-host` is
   a release build is unresolved and needs the release pipeline; lens A and lens
   C both left the same question open.

### Orphan-arc pairing detection is `#[cfg(test)]`, and broad test coverage masks that

`assert_no_orphaned_tool_arcs` is `#[cfg(test)]` at `transform.rs:11171`, and its
only call site outside the test module is itself `#[cfg(test)]` at `:5486`. Both
verified at `HEAD`. Its two assertions are at `:11206` and `:11219`, carrying the
messages "Each `tool_result` block must have a corresponding `tool_use`."
(`:11208`) and "Each `tool_use` block must have a corresponding `tool_result`
block in the next message." (`:11221`).

**The inventory consequence has to be stated plainly, because the naive reading
inverts it.** The assertion sits inside the shared fixture driver `run` at
`:14336`, so every one of the 207 to 210 whole-pass drivers asserts arc integrity
transitively. A reader counting assertions per test would conclude arc pairing is
the best-covered property in the sub-part. **It has the broadest test coverage in
4e and zero production presence.** Nothing in any shipped binary, debug or
release, checks it. The first signal of an orphaned arc in production is a
deterministic provider 400 for the whole session.

Because the gate is `#[cfg(test)]` and not `cfg(debug_assertions)`, running the
suite in release mode does **not** close this one: the assertion still fires in a
release *test* build and is still absent from both shipped profiles. That is a
different fix from the belt.

The scope map calls this function a production guard
(`scope-map-and-risk-ranking.md:441-443`, "Two production guards worth naming now
because they are explicit fail-loud checks on the output path"). Per METHOD.md
rule 3 the disagreement is recorded with both sides cited and not resolved in the
map's favour: the code is `#[cfg(test)]`, the sibling function it names is
genuinely production, so the sentence is half right.

### The two further debug-only claims

| Site | Guard | Release behaviour |
| --- | --- | --- |
| `transform.rs:11246` | `debug_assert!` "served output contains duplicate tool_use ids" | Repairs silently via `:11251-11302` |
| `transform.rs:12139` | `debug_assert!` "claude-code-anthropic synthetic prefix must not contain system-role messages" (message at `:12143`) | Serves the violating prefix |
| `transform.rs:8396` | `debug_assert_eq!(strip_tag_prefix(&tagged, tag_number), value)`, the byte-exact-inverse claim | Unchecked. Covered by `tag_prefix_strip_is_a_byte_exact_inverse` (`:22619`) in test builds |
| `transform.rs:9115` | `debug_assert!(utf16_len(&wrapped) <= USER_HINT_TOTAL_CHAR_CAP)` | Unchecked, and trivially satisfied in debug: lens A computes a maximum of 458 UTF-16 units against a cap of 800 |

The two the task singles out are `:11246` and `:12139`, because those are the two
whose *release* behaviour differs observably rather than merely going unchecked.

**Net effect on this part's records.** Any 4e property whose only enforcement is
a `debug_assert!` has no enforcement in a shipped release build, and any property
about the content of the served array must state which profile it holds in. All
four assertion sites in 4e production code are `debug_assert` (`:8396`, `:9115`,
`:11246`, `:12139`), and there are **zero unconditional runtime assertions in the
9,304 lines**. 4d found one in about 9,000 lines. 4e has none.

## The TypeScript gate, which differs in shape from every prior part

`ci.yml:257` runs `bun run test`, which is
`sh scripts/test-shard.sh packages/plugin && bun run --cwd packages/pi-plugin test && ...`
(root `package.json`), and `ci.yml:317` runs the pi-plugin suite again directly.
`bun test` from a package root recursively discovers every `*.test.ts` beneath
it, including `packages/plugin/scripts/`. So the gates below do run on every pull
request.

**4e has exactly one CI-gated TypeScript check that touches bytes the Rust module
actually serves, and it tests an artifact rather than either implementation.**
`packages/plugin/scripts/prompt-surface-gates.test.ts`, through
`packages/plugin/scripts/prompt-surface-fixture.ts:18-21`, reads
`crates/mc-module/assets/guidance_light_primary.txt` and
`guidance_light_no_reduce.txt` — the exact files `prompt_surface.rs:34` and `:36`
`include_str!` into the binary. Both sides were read at `HEAD`. It validates the
budget fixture, the 37-rule checklist mapping, and the rendered checklist
artifact.

That is a genuinely different shape from the prior parts and worth naming
precisely, because it changes what a green light means:

| Pattern | Where it appears | What green proves |
| --- | --- | --- |
| Each half against a fake of the other | 4d's claim-effects ack (`../part-4d-facade/existing-checks.md:163-227`) | Each half is self-consistent. The composition is unproven |
| Parallel implementations against a shared frozen fixture | 4e's nudge-hygiene golden | Two of three legs agree with a snapshot |
| **A gate on the shared frozen artifact both implementations consume** | **4e's prompt-surface gate** | The artifact conforms. Neither implementation is executed |

**No case of "each half tested against a fake of the other" was found anywhere in
4e.** That pattern is 4d's. There is no Rust code under test in
`prompt-surface-gates.test.ts` and no TypeScript reimplementation of the asset
selection; the asset bytes are the whole subject. So the gate cannot drift from
the Rust code by construction — `prompt_surface.rs` includes those exact bytes at
compile time — and equally cannot catch any error in how the Rust code *selects*
between them. That selection is the subject of the record
`render-a-light-surface-fallback-notice-never-served`, and the gate is silent on
it.

The four TypeScript gates in 4e's territory, each classified:

| Gate | Relationship to the Rust code | What it actually tests |
| --- | --- | --- |
| `packages/plugin/scripts/prompt-surface-gates.test.ts` (6 tests) | **Gates the Rust-served artifact bytes, not the Rust code.** The only real cross-language gate 4e has | Reads the two light assets `prompt_surface.rs:34`/`:36` include, validates the budget fixture, the 37-rule checklist mapping, and the rendered checklist |
| `packages/pi-plugin/src/tail-hygiene-parity.test.ts:276` | **Parallel implementations against a shared fixture. Does not execute Rust** | Reads `crates/mc-module/testdata/nudge-hygiene-golden.json` at `:60-68`, runs `measureTailHygiene` (OpenCode) and `measurePiTailHygiene` (Pi) over all 12 cases (`:281-300`), plus a reasoning-arm mutation test (`:301`) and the flagship band (`:337`) |
| `packages/pi-plugin/src/tail-hygiene-walk-pi.test.ts:713` | **Parallel implementation, same fixture** | Second Pi-side consumer of the same golden |
| `packages/plugin/src/hooks/magic-context/tail-hygiene-walk.test.ts`, `caveman.test.ts`, `decay-render.test.ts`, `ctx-reduce-nudge.test.ts`, `tag-messages-collision.test.ts` | **Parallel implementations only. No shared artifact, no Rust reference** | They test the TypeScript originals the Rust files were ported from. A Rust-side drift is invisible to them |

### The provenance guard lives only in the leg CI never runs

**This is the asymmetry that makes the fixture pattern worse than it looks.** The
`nudge-hygiene-golden.json` fixture carries a provenance field, and the guard
that would catch a fixture drifting from its generator is Rust-side:

- **Rust recomputes the input hash.** `tail_hygiene.rs:1035-1039` is
  `assert_eq!(hygiene_fixture_hash(&golden.cases), golden.provenance.input_sha256,
  "committed fixture inputs must match the TypeScript generator provenance")`,
  and `provenance_guard_rejects_mutated_fixture_input` (`:1099`) is a dedicated
  mutation test for it. Both verified at `HEAD`.
- **TypeScript reads the field and never recomputes it.**
  `tail-hygiene-parity.test.ts:277-279` asserts only `schema`,
  `generator_version` and a case-count floor.
- **No workflow regenerates the fixture and diffs it.**

So the two JavaScript legs are gated on every pull request, the Rust leg is gated
nowhere, and **the one check designed to catch the fixture itself drifting runs on
no CI machine.** A fixture that no longer matches the TypeScript generator it was
produced from is caught by review alone.

One genuine compile-coupled gate exists and it points the other way.
`memory_render.rs:504` `include_str!`s the live TypeScript source
`packages/plugin/src/features/magic-context/memory/constants.ts` and parses three
`export const` arrays out of it (`:475-499`), asserting
`CATEGORY_PRIORITY == POSITIVE_MEMORY_CATEGORIES` and that every
`V2_MEMORY_CATEGORIES` and `PROMOTABLE_CATEGORIES` entry is a positive category
(`:502-524`). Because it is `include_str!`, editing the TypeScript file forces a
Rust rebuild. But the assertion fires only when someone runs `cargo test`, which
CI does not.

## In-crate tests, clustered with counts and line ranges

### The 25 op-specific tests in `transform.rs`

Clusters as lens C produced them, by direct body reference to a 4e-owned symbol.
Every cited `fn` line was re-read at `HEAD`. `†` marks `#[ignore]`.

| Cluster | Tests | Lines | Notes |
| --- | --- | --- | --- |
| serialized-output cache | 5 | `:28596`, `:28622`, `:28660`, `:28698`, `:28726` | The invalidation-granularity family. `:28622` and `:28660` are the two byte-equality replays lens A leans on |
| tag baseline cache | 4 | `:23364`, `:23433`, `:23466`, `:23490`† | `:23433` `poisoned_tag_baseline_refills_after_direct_sql_update` is the only one that corrupts the store directly. `:23490` is `#[ignore]`, a manual 50k timing proof |
| reasoning clearing and exemption | 3 | `:18360`, `:18850`, `:19070` | The Anthropic-signed-block rules at `:12273`, `:10258` |
| orphan-arc and served-fingerprint shape | 3 | `:14310`, `:14456`, `:27338` | `:14310` and `:27338` are the only tests whose oracle is `assert_no_orphaned_tool_arcs` |
| byte-identical replay through the output cache | 2 | `:27150`, `:27216` | Lens A's strongest evidence for composition order and determinism |
| duplicate-`tool_use` belt | 2 | `:21504` (debug, `#[should_panic]` at `:21503`), `:21514` (release, `#[cfg(not(debug_assertions))]` at `:21512`) | Exactly one compiles per profile |
| tag-imitation defence | 2 | `:13726`, `:13766` | `strip_leading_tag_imitations` and its code-span carve-out |
| tag mint and prefix inverse | 2 | `:22321`, `:22619` | `:22619` pins the byte-exact-inverse claim behind the `debug_assert_eq!` at `:8396` |
| frontier and fingerprint reuse | 1 | `:14585` | |
| whole-module timing fixture | 1 | `:28388`† | `#[ignore]`, 2,500 messages and 47,075 frozen units |

Plus the 5 in `mod nudge_formula_tests` (`:9629`, extent `:9629-9783`), which 4b
explicitly assigns to 4e (`../part-4b-transform/existing-checks.md:60`):

| Line | Test |
| --- | --- |
| `:9662` | `channel1_uses_tail_ratio_without_pressure_or_whole_input` |
| `:9672` | `channel1_minimum_tail_floor_bands_and_cadence_match_reference` |
| `:9692` | `channel2_aggregate_uses_persisted_all_class_walk_and_holds_invalid_baselines` |
| `:9704` | `channel2_rearms_only_on_hard_coverage_fold_or_measured_u_collapse` |
| `:9734` | `channel2_claimed_lease_reaps_and_delivered_echo_keeps_cycle_consumed` |

**These five are the only tests of the band arithmetic and the Channel-2 rearm
paths in the repository**, and they are the reason the module's 28 unconditional
`assert!`/`assert_eq!` calls inside `transform.rs:7511-12623` are all test code:
verified at `HEAD`, all 28 sit either inside `mod nudge_formula_tests` or inside
the `#[cfg(test)]` `assert_no_orphaned_tool_arcs` at `:11206` and `:11219`.

Named single tests the records lean on, verified by name and `fn` line:

| Line | Test | Pins |
| --- | --- | --- |
| `:23307` | `tag_overlay_replays_stably_and_new_tail_gets_next_number` | Overlay replay stability plus next-number allocation |
| `:23128` | `user_hint_query_keeps_terms_beyond_the_old_character_cap` | The hint *query* path, not the render cap |
| `:23551` | `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire` | Channel-1 firing and replay. Reaches the suppression effect only by writing the flag into the store at `:23577` |
| `:27131` | `non_reasoning_adjacency_keeps_full_drop_mode` | The full-drop filter path |
| `:14336` | (inside the shared `run` helper) `assert_no_orphaned_tool_arcs(response.messages())` | Every whole-pass driver inherits the arc check, in test builds only |

The `:14336` row is the load-bearing detail of this whole inventory and is
analysed in the debug-versus-release section above.

### File-local tests in the six other 4e units

Re-counted at `HEAD` by matching test attributes per file: 7 + 15 + 1 + 4 + 6 +
2 = **35**.

| File | Test module | Tests | What they cover |
| --- | --- | --- | --- |
| `decay_render.rs` | `:366` | **15** | `:396`-`:540` tier selection, archived omission, XML-safe headings, legacy and malformed rows, oldest-first demotion; `:586` m0 extraction; `:629`, `:663`, `:787` the three cross-language goldens; `:843` a tagged-session render |
| `tail_hygiene.rs` | `:724` | **7** | `:772`, `:813` baseline additivity and invalidation; `:1029` the 12-case parity golden; `:1099` the provenance guard; `:1116` the reasoning and tagged-text mutants; `:1169` protected-arc exclusion from `u`; `:1211` the conservative orphan `t` |
| `classify.rs` | `:274` | **6** | `:284`, `:307`, `:331`, `:432` manifest envelope and diagnostics; `:292`, `:452` child-session identity |
| `memory_render.rs` | `:377` | **4** | `:407`, `:434` category typing; `:502` the live-TypeScript vocabulary gate; `:528` render-order prefix |
| `prompt_surface.rs` | `:324` | **2** | `:329` light slots serve authored bytes and assert `!fallback`; `:359` the full manifest is legacy-inert |
| `caveman.rs` | `:612` | **1** | `:626` the 42-case differential golden. The only test in 651 lines |

Combined with 237 + 5 from `transform.rs`, 4e has **277 in-crate checks**.

### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]`: 3, all in `transform.rs`, 2 of them inside 4e's 25.** All three
use the `#[ignore = "reason"]` form, which a bare `#[ignore]` grep misses:
`:13200` `apply_once_stage_timings_large_fixture` (4b, `fn` at `:13201`), `:23489`
`tag_baseline_warm_hydration_50k` (`fn` at `:23490`), `:28387`
`full_module_pass_timing_fixture` (`fn` at `:28388`). So **2 of the 25
op-specific tests do not run even under a local `cargo test`.** Zero `#[ignore]`
in the other six 4e files.

**`should_panic`: 1.** `transform.rs:21503`, on
`duplicate_tool_use_belt_panics_in_test_builds` (`:21504`). See the correction at
the top of this file: lens C reported none. It is the only test in scope whose
oracle is a panic rather than a value comparison, and it is the only check on the
debug arm of the duplicate-id belt.

**Property, mutation and concurrency tooling: none found.** Zero occurrences of
`proptest`, `quickcheck`, `loom`, `shuttle` or `miri` in any of the seven 4e
units. No `mutants.toml` in the repository root. No coverage configuration, so
every placement statement in this file is structural rather than measured. No
`mc-module` entry in `.config/nextest.toml`, so no 4e test is serialized,
grouped, or timeout-adjusted.

**Table-driven fixture inventory**, from `crates/mc-module/testdata/` at `HEAD`:

| Fixture | Cases | Rust consumer | Cross-language |
| --- | --- | --- | --- |
| `caveman-golden.json` | 42 | `caveman.rs:628` | Generated from `caveman.ts`; no TS consumer |
| `render-golden.json` | 7 | `decay_render.rs:634` | Generated by `crates/mc-core/testdata/gen-golden.ts:159` |
| `render-tight-golden.json` | 7 | `decay_render.rs:797` | Same generator, `:224` |
| `nudge-hygiene-golden.json` | 12 | `tail_hygiene.rs:1030` | Generated by `crates/mc-module/gen/gen-nudge-hygiene-golden.ts`; **also replayed by two TypeScript legs** |
| `decay-store-differential.json` | 4 | `decay_render.rs:710` | `crates/mc-module/testdata/gen-decay-store-differential.ts` |
| `memory-render-golden.json` | 6 | **none** | Generated by `gen-golden.ts:339`. Orphan; see quiet area 5 |

## Integration tests and CI status

**Integration tests in 4e scope: none found. No 4e check runs in CI.**

Seven integration binaries exist under `crates/mc-module/tests/`, counted by 4e
term occurrences in each at `HEAD`:

| Binary | Lines | 4e hits | Verdict |
| --- | --- | --- | --- |
| `direct_host.rs` | 438 | 2 | Both are the string `"render_config"` (`:114`, `:177`), a config-identity field, not the renderer. **Out of scope** |
| `lifecycle_cli.rs` | 635 | 6 | All six are `staged`/`start`/`stop` lifecycle words matched incidentally (`:5`, `:202`, `:211`, `:355`, `:429`, `:612`). **Out of scope** |
| `prepared_output.rs` | 282 | 0 | 4d |
| `host_adapter.rs` | 173 | 0 | — |
| `broca_roundtrip.rs` | 198 | 0 | — |
| `boundary_counter_durability.rs` | 64 | 0 | — |
| `release_contract_conformance.rs` | 147 | 0 | Credential and closure-digest contracts |

**4b has two integration tests driving a real transform
(`../part-4b-transform/existing-checks.md:51`) and 4d has ten. 4e has zero.** The
final byte-producing stage of the whole module has no coverage outside the
crate's own test modules.

**CI, verified at `HEAD` against all five files in `.github/workflows/`**
(`ci.yml`, `claude-code-review.yml`, `historian-eval.yml`,
`retrieval-benchmark.yml`, `shm-hardening-optin.yml`):

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`,** `ci.yml:168` at `76cd6f41`
   and `:172` at `HEAD`. `--test lifecycle_cli` selects one integration binary
   and does **not** build the `--lib` target, so no in-crate `mc-module` test is
   compiled, let alone run.
2. **The other `mc-module` step is build-only:**
   `cargo build -p mc-module --bin ck-mc-host`, `:165` at `76cd6f41` and `:169`
   at `HEAD`. No `--release`, so the CI artifact is a debug build. This is the
   fact the debug-versus-release section turns on.
3. **There is no `cargo test -p mc-module --lib`, no `cargo nextest run -p
   mc-module`, and no `--workspace` test job.** The only other `mc-module`
   mention in `ci.yml` is a comment at `:361`.
4. **`scripts/test-rust.sh` (`cargo nextest run --workspace`) exists, is wired
   into root `package.json` as `test:rust`, and no workflow invokes it.**
5. **No e2e or incident-pool suite runs.** `ci.yml:344` type-checks
   `packages/e2e-tests` and `:338` runs `test:prospective-unit`; nothing runs
   `test:e2e`, `test:incidents` or `test:incidents:rust`. This matters because
   `packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts` is
   the only harness in the tree that drives real Rust rendering across the
   language boundary. It declares `prerequisites: ["cargo", "ck-mc", "commons",
   "subconscious"]` at `:108` and links `crates/mc-module/src/injection.rs`
   (`:1600`) and `crates/mc-module/src/transform.rs` (`:1607`) as its sources. It
   runs on no machine but a developer's, on request.

**Consequence for every 4e record.** `Exercised: partial` means "a test exists on
a developer's machine", and for `transform.rs:21514` it means "a test exists that
a developer's default `cargo test` does not compile". METHOD.md's `Exercised`
vocabulary does not distinguish either from `not yet`. 4b, 4c, 4d, the scope map
(`:681`), lens A and lens C have all raised it. It is recorded here as needing a
human ruling, not resolved.

## Production assertions and guards, clustered

Measured over production lines only: `transform.rs:7511-12623` excluding
`mod nudge_formula_tests` (`:9629-9783`), plus each other 4e file up to its test
module.

**Runtime assertions: four, and all four are compiled out of release.** All four
sites re-derived at `HEAD` by matching `debug_assert` across the production
range, which returns exactly `:8396`, `:9115`, `:11246` and `:12139` plus the two
`cfg` attribute lines at `:11251` and `:11303`.

| Site | Guard | In release? |
| --- | --- | --- |
| `transform.rs:11246` | `debug_assert!` "served output contains duplicate tool_use ids" (message `:11248`) — the loud half of the belt | **No** |
| `transform.rs:12139` | `debug_assert!` "claude-code-anthropic synthetic prefix must not contain system-role messages" (message `:12143`) | **No** |
| `transform.rs:8396` | `debug_assert_eq!(strip_tag_prefix(&tagged, tag_number), value)` — the byte-exact-inverse claim | **No** |
| `transform.rs:9115` | `debug_assert!(utf16_len(&wrapped) <= USER_HINT_TOTAL_CHAR_CAP)` — trivially satisfied, max 458 against 800 | **No** |

**Zero unconditional runtime assertions in 9,304 production lines.** Verified: all
28 `assert!`/`assert_eq!`/`assert_ne!` matches in `transform.rs:7511-12623` are
inside `mod nudge_formula_tests` or inside the `#[cfg(test)]`
`assert_no_orphaned_tool_arcs` (`:11206`, `:11219`). 4d found one unconditional
assertion in about 9,000 lines; 4e has none. **Zero compile-time `const _`
assertions in scope.**

**Panicking sites: none found.** Zero `panic!`, `unreachable!`, `todo!` and
`unimplemented!` across all seven units' production halves, verified by grep over
`transform.rs:7511-12623` and each other file. **4e is the only sub-part
inventoried so far with no panicking site at all**, which is the direct
consequence of the previous paragraph: with no assertion and no panic, every
guarantee in this scope is either a returned value or a diagnostic string.

**`.expect(`: 25, in four clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Process-global tag caches (`transform.rs`) | 6 | `"tag baseline cache mutex"` (`:7605`, `:7648`, `:7671`, `:7689`), `"tag mint frontier cache mutex"` (`:8603`, `:8618`) |
| Infallible string walks (`transform.rs`) | 4 | `:8511` `"non-empty reminder remainder"`, `:9034` and `:9057` `"non-empty remainder"`, `:9235` `"filtered taggable block"` |
| Serialization (`transform.rs`) | 4 | `:10817` `"renderer transition classes are serializable"`, `:10827` `"renderer transition classes serialize"`, `:11038` `"CK message metadata must serialize"`, plus the `:9011`/`:9016` regex labels |
| Other files | 11 | `tail_hygiene.rs` 3 (`:378` `"one candidate arc"`, `:643`, `:664`), `classify.rs` 6, `caveman.rs` 1 |

Three name a contract with no test: `"renderer transition classes are
serializable"`, `"CK message metadata must serialize"` and `"one candidate arc"`.
The last is the assertion holding up the `HashMap` iteration discussed below.

**`.unwrap()`: 20, all infallible-by-construction regex compilation.**
`transform.rs:9927`, `:9972`, `:10154` and 17 sites in `caveman.rs` (`:180`,
`:204`, `:237`, `:242`, `:247` and neighbours), every one a `Regex::new(...)`
inside a `get_or_init` over a literal pattern. Zero `.unwrap()` in
`tail_hygiene.rs`, `decay_render.rs`, `memory_render.rs`, `classify.rs` or
`prompt_surface.rs` production halves.

**Diagnostics that replace a guard: two stderr writers.**
`transform.rs:11241-11245` (`action=drop_later`, the only trace of a
release-build content removal) and `prompt_surface.rs:150-153` (an ignored
tool-description override, `warn_ignored_unknown_tool_description`, which returns
nothing). Neither has a response field and neither has a test.

**`let _`: one.** `tail_hygiene.rs:594` (`let _ = write!(signature_input, ...)`),
a formatting write to a `String`, which cannot fail. Zero in `transform.rs`'s 4e
range. Lower than 4c's six and 4d's three.

**Typed rejection guards.** With no unconditional assertion anywhere, the
enforcement in 4e is either a returned value or a diagnostic string. Two places
return a hard error on a rendering failure: `SyntheticTodoAnchorMissing`
(`transform.rs:12125-12133`), the only site in the splice where a placement
failure is reported rather than absorbed, and `memory_render.rs`'s four typed
claim rejections (`:91`, `:94`, `:101`, `:104`), which name the reason a mirrored
claim was excluded. `classify.rs` carries the densest set, nine manifest
rejections at `:166-207`, with `:432`
`manifest_validation_diagnostics_never_quote_the_manifest` proving they do not
echo untrusted text.

**One order-dependence guarded only by a caller in another sub-part.**
`tail_hygiene.rs:364` iterates a `HashMap` (`for (call_id, rows) in
orphan_rows`), and the loop body reads `by_arc` at `:373` and writes it at
`:394`. Order independence holds only because candidate arc sets are disjoint per
call id, and that disjointness is produced by `ck_wire.rs:440-451`: a singleton
call's `arc_id` is the call block's own `block_id` and a repeated call's is
`tool_arc_id(&msg.mid, id)`, so all blocks in one arc carry one `tool_call_id`.
**Nothing local enforces it.** The `candidate_arcs.len() != 1` filter at `:375`
and the `.expect("one candidate arc")` at `:378` narrow the window but assume
rather than establish the invariant. `ck_wire.rs` is 4f scope, so a 4f change can
silently make a 4e render seed-dependent. Lens A reached the same conclusion from
the determinism side.

**Conventionally-enforced-only claims: nine**, each stated somewhere and
mechanically checked nowhere.

1. **The `* 2` tag-to-message conversion** at `transform.rs:10201`.
   `default_protected_tags()` returns 20 (`:893-895`) and `protected_tag_numbers`
   (`tail_hygiene.rs:401-412`) takes the top 20 tag numbers, but the strip path
   converts it to a message count, `protected_start = req.messages.len() -
   protected_tags * 2` (`:10198-10201`), gating `:10229`, `:10277` and `:10301`.
   No comment, no constant, no test. The served guidance tells the model "The
   last 20 tags stay protected until they age out".
2. **The `nudge-hygiene-golden.json` regeneration discipline.** See the
   TypeScript-gate section: the Rust provenance guard
   (`tail_hygiene.rs:1035-1039`, `:1099`) runs nowhere and no workflow
   regenerates the fixture and diffs it.
3. **Two `DEFAULT_HISTORY_BUDGET_TOKENS` constants with different types.**
   `decay_render.rs:23` is `u32 = 60_000`; `memory_render.rs:16` is
   `f64 = 60_000.0`. Nothing ties them, and the `u32` copy has no caller inside
   4e's scope.
4. **The classify byte and chain caps are mirrored by comment only.**
   `packages/plugin/src/features/magic-context/dreamer/classify.ts:52` says
   "Mirrors `MAX_CLASSIFY_PROMPT_BYTES` in `crates/mc-module/src/classify.rs`"
   and `task-config.ts:48` says the same for `MAX_CLASSIFY_MODEL_CHAIN`. Neither
   test parses the Rust source, and `task-config.test.ts:39` explicitly delegates
   one assertion to a Rust test by name instead of checking it.
5. **The `m1_revision_signal` completeness invariant crosses a sub-part boundary
   as prose.** `memory_render.rs:354-360` tells a future editor to "re-read the
   COMPLETENESS INVARIANT on `m1_revision_signal`" before adding a time-varying
   input. The invariant lives in `m1_compose.rs:54`, which is 4b. Nothing
   mechanically prevents the change the comment forbids.
6. **Four hand-written mutex labels** on the two process-global tag caches, six
   sites and two strings, with no consistency check. Same shape as 4c's and 4d's
   findings.
7. **The two 64 MiB cache budgets** at `transform.rs:144-145`
   (`TAG_BASELINE_CACHE_BUDGET_BYTES`, `TAG_MINT_FRONTIER_CACHE_BUDGET_BYTES`)
   are literals with no stated derivation and no relation to each other beyond
   being equal.
8. **`prompt_surface.rs:104`**: "It participates only in materialization
   freezing, never provider-visible epochs." A whole-crate absence claim about
   `config_identity` with no guard.
9. **The unknown-tool-override warning is stderr-only**
   (`prompt_surface.rs:150-153`). A silently ignored description override is not
   visible in any response field.

## Test support and fault-injection seams

**In-scope seams: two, and both are unusual in shape.**

- **`poisoned_tag_baseline_refills_after_direct_sql_update` (`:23433`) corrupts
  the store directly** rather than through a seam, which is the only fault
  injection any 4e test performs. It is the model for the store-side capability
  the fault map ranks.
- **`caveman.rs`'s frozen fixture is the seam.** `caveman-golden.json` is
  generated from `caveman.ts` and replayed at `:628`, so the oracle is a
  snapshot, not the live TypeScript. Regeneration is the only way to observe
  drift, and no workflow regenerates it.

**Dead test hooks in 4e scope: none found.**

**The reducer-style injectable-parameter pattern 4d relied on has no 4e
equivalent.** Nothing in 4e takes a clock, a zone, or a randomness source as a
parameter. What 4e takes instead is a `CoreState` and a frozen-unit set, which is
why almost every 4e record's enabling state is "seed a frozen unit" rather than
"install a seam". The one place that matters is
`measure_tail_hygiene(projection, core, ..)` (`tail_hygiene.rs:458-465`), whose
12-case parity golden passes `&CoreState::default()` and an empty `&HashSet` at
`:1049-1056`, so no frozen unit of any kind is present in any golden case, and
the metric's `red:` arm (`:508`), caveman arm (`:526`, via `caveman_content`
`:422-429`) and absent strip arm are all unreachable from the cross-language
corpus. One case is *named* `caveman-rendered-not-original-weight`
(`crates/mc-module/gen/gen-nudge-hygiene-golden.ts:106-112`), but it encodes the
caveman text as literal block content rather than as a `cav:` frozen unit, so it
exercises the text arm.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The release-only duplicate repair is the quietest decision in 4e that
   changes served bytes.** `transform.rs:11251-11302` removes blocks and whole
   messages from the final array. Its only report is an `eprintln!`
   (`:11241-11245`). Its only test carries `#[cfg(not(debug_assertions))]`
   (`:21512`) and therefore does not compile under a default `cargo test`. Its
   sibling arm panics instead. And the contract prose at `:11227-11230` describes
   the panicking arm as the intended behaviour while the repairing arm is the one
   a release artifact ships. Three independent gaps stacked on one 52-line block,
   and the only 4e code whose behaviour a reader cannot determine without knowing
   the build profile.

2. **Orphan tool arcs have no production detection, and the test coverage is
   broad enough to hide that.** `assert_no_orphaned_tool_arcs` is `#[cfg(test)]`
   at `:11171`, its only non-test-module call site is `#[cfg(test)]` at `:5486`,
   and because the check sits inside the shared fixture driver at `:14336` all
   207 to 210 whole-pass drivers assert it transitively. **State it plainly: the
   broad test coverage of orphan arcs masks zero production presence.** A reader
   counting assertions per test would rank arc integrity the best-covered
   property in the sub-part; in production nothing checks it and the first signal
   is a provider 400 for the whole session. Unlike the belt, running the suite in
   release does not close this: the gate is `#[cfg(test)]`, so the assertion is
   absent from both shipped profiles and present in both test profiles.

3. **`caveman.rs` is the closest thing 4e has to a zero-test file: 651 lines, one
   test.** `differential_golden_matches_typescript_oracle` (`:626`) replays 42
   frozen cases and is the entire check on the file. The header calls the fixture
   "the compatibility contract" (`:5-6`), so the contract is a snapshot rather
   than the live oracle:
   `packages/plugin/src/hooks/magic-context/caveman.ts` can change and only a
   regeneration would notice. No workflow regenerates it. And caveman output
   feeds the hygiene metric through `caveman_content`
   (`tail_hygiene.rs:422-429`), which the 12-case parity golden cannot reach at
   all, so the compression and the metric that consumes it are each pinned by a
   fixture and never checked together.

4. **The strip surface has no hygiene test and no strip literal anywhere in the
   metric.** `new_frozen_strip_units` (`transform.rs:10181-10339`) produces five
   strip classes, `apply_surface_strips` (`:10371-10458`) can collapse a whole
   message to one sentinel block (`:10388-10391`) or empty a stale reduce
   (`:10454-10457`), and `measure_tail_hygiene` knows about none of it: `strip:`
   appears zero times in `tail_hygiene.rs`. The calibration report that set the
   shipped bands assumed the opposite —
   `docs/nudge-hygiene-calibration-2026-08-16.md:10` states the replay "applied
   persisted drops **and strip transforms**" before running "the same part-typed
   TypeScript hygiene walk used by the nudge baseline". So the thresholds were
   calibrated on post-strip tails and are applied to a pre-strip measurement.
   Nothing in either language measures the divergence.

5. **`memory-render-golden.json` is generated, committed and unread.** 6
   cross-language cases for the m0/m1 memory surface, produced by
   `crates/mc-core/testdata/gen-golden.ts:339`, with no Rust consumer at `HEAD`;
   `memory_render.rs`'s four tests use hand-built rows instead. A fixture that
   exists to prove a cross-language property and is wired to nothing is worse
   than no fixture, because its presence reads as coverage.

6. **`prompt_surface.rs`'s fallback path is dead and its notice is stale.**
   `LIGHT_FALLBACK_NOTICE` (`:28`) says light assets "are not available yet"
   while `:33-37` compile them in unconditionally (verified: `GUIDANCE_LIGHT_PRIMARY`
   at `:33-34`, `GUIDANCE_LIGHT_NO_REDUCE` at `:35-36`, `TOOL_LIGHT_DESCRIPTIONS`
   at `:37`, all `Some`), so `:141` `fallback: light.is_none()` and `:157` are
   always false and all four `lib.rs` consumers (`:7594`, `:7599`, `:7600-7601`,
   `:7718`, `:7720`) are unreachable. The one CI-gated TypeScript rendering gate
   validates the very assets the notice claims do not exist.

7. **The Channel-2 derived tag numbering can name a handle with no durable row,
   and nothing checks it.** `active_tags_for_channel2` (`transform.rs:9282-9313`)
   numbers taggable tail blocks `1..n` when no stored row survives, deliberately
   per the comment at `:9279-9281`, and that numbering reaches agent-visible
   bytes through `oldest_channel2_hint` (`:9534-9547`, called `:9396`) and
   `format_reclaimable_hint` (`:9866-9876`), which renders `§{tag}§ {name}` at
   `:9872`. The five `nudge_formula_tests` cover the band arithmetic and the
   rearm paths; none covers the hint's tag numbers.

8. **The two 64 MiB process-global tag caches have four tests, none of which
   exercises the budget.** `:23364`, `:23433`, `:23466` and `:23490` cover cold
   passes, poisoned refill, session isolation and warm hydration timing, and
   `:23490` is `#[ignore]`. Nothing drives `TAG_BASELINE_CACHE_BUDGET_BYTES` or
   `TAG_MINT_FRONTIER_CACHE_BUDGET_BYTES` (`:144-145`) to eviction, so the
   eviction accounting on the only mutable process-global state the render
   depends on is unexercised.

9. **`channel1_reduce_suppressed` is documented as written by `ctx_reduce` and is
   written by nothing.** `mc-store/src/lib.rs:2458-2460` states "Set by
   ctx_reduce after the agent has acted on a reminder." The only write to `true`
   in the worktree is `transform.rs:23577`, inside a `#[test]`. Three production
   reads exist (`:9156`, `:9565`, `:9593`) and one production clear to `false`
   (`:9157`). So the documented feedback loop has no producer, and the only test
   that reaches the suppression effect installs the flag by writing the store
   directly.

10. **`classify.rs`'s cross-language constant mirrors are prose.** The Rust
    header's whole argument (`:4`, "callers cannot turn this management surface
    into a generic arbitrary-prompt producer") rests on caps whose TypeScript
    twins are checked by nothing.

11. **`decay_render.rs`'s budget-guard demotion is the one place a bound removes
    whole compartments from m0, and its termination is a magic multiplier.**
    `:330` is `let mut guard = compartments.len() * 5;` and tier 5 renders empty
    (`:319-322`), so under a binding budget whole compartments leave the
    artifact. `budget_guard_demotes_oldest_first` (`:519`) covers the ordering.
    Part 3 owns the ladder and the termination bound per
    `scope-map-and-risk-ranking.md:666`; the `* 5` has no comment on either side
    of that boundary.

12. **No integration coverage of the final byte-producing stage.** Zero of the
    seven integration binaries reach 4e, against 4b's two and 4d's ten. The only
    harness that drives real Rust rendering across the language boundary,
    `packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts`,
    runs in no workflow.

## Sampling limits on this inventory

Seven limits, stated so a later pass does not read absence as absence of risk.

- **The four-tier attribution brackets rather than pins.** 237 / 190 / 25 / 89
  comes from symbol matching plus a helper fixpoint over parsed test bodies, not
  from coverage instrumentation, which this repository does not have. The 285
  attribute count, the 280 + 5 split, the first and last `fn` lines, the six
  per-file test counts, the seven scope line counts, the three `#[ignore]` sites,
  the single `should_panic`, the four `debug_assert` sites, the zero panic sites,
  the release-only block extent `:11251-11302`, and both `ci.yml` line numbers
  were obtained directly at `HEAD`.
- **The curated 62-identifier set is not reproducible from this file.** It is
  lens C's, and it is the input that decides the 25 and the 190. A later pass
  recomputing either number will get a different answer unless it uses the same
  list. This is the sharpest limit on the whole attribution and it is worse than
  4d's, because 4d's op-specific rule could be restated in a sentence.
- **The 237 reach tier is shared evidence, not 4e evidence.** 210 of it is the
  whole-pass driver set 4b also counts. A reader counting 4e coverage must not
  mistake reach for claim in either direction: 25 tests were written about 4e
  behaviour and 212 render output incidentally.
- **The fixpoint tier is reported and then discarded.** 190 is stated so a later
  pass does not recompute it and treat it as a finding. It is an artifact of 4e
  being the terminal stage, exactly as 4d's 232 was an artifact of 4d owning the
  response vocabulary.
- **The helper population is 115 by the fixpoint's own detector and 130 by an
  independent recount**, and the driver count is 207 by lens C's detector and 210
  by 4b's. Neither changes a count here. Both are recorded because the sibling
  inventories report the other figure.
- **Every production-guard statement is a count over production halves, and the
  boundary between "production" and "test" in `transform.rs` is a line number.**
  The 4e production range is `:7511-12623` minus `mod nudge_formula_tests`
  (`:9629-9783`). Two functions defined inside that range are `#[cfg(test)]`
  (`assert_no_orphaned_tool_arcs`, `:11171`) and one call site outside the test
  module is too (`:5486`, which is 4b's range). A count keyed on line number
  alone would have called 4e's assertion density non-zero.
- **Whether a never-executed test counts as `Exercised: partial` is unresolved,
  and it governs all 277 checks inventoried above.** For `transform.rs:21514` the
  question is sharper still: the test does not compile under a default
  `cargo test`. 4b, 4c, 4d, the scope map (`:681`), lens A and lens C all raised
  it. It needs a human ruling, not a synthesis decision.
