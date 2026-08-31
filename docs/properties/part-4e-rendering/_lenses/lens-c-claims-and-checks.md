# Part 4e lens C: claimed guarantees and existing-check inventory

One attention focus: what the code, the diagnostics, and the prose *promise* about
rendered-output fidelity, tag numbering, hygiene, injection, and overlay
behaviour, and what actually checks any of it. Every claim below is a lead. None
is imported as truth. Where a document and the code disagree, both sides are
cited and the disagreement is left open, per
[../../METHOD.md](../../METHOD.md) rule 3.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Every line reference in this file
was read back at `HEAD` before it was written.

## Scope used, and three corrections to the task framing

The authoritative 4e scope is the seven units the scope map lists at
[`../../part-4-module/_lenses/scope-map-and-risk-ranking.md:587-595`](../../part-4-module/_lenses/scope-map-and-risk-ranking.md):
`transform.rs:7511-12623` (5,113), `tail_hygiene.rs` (1,278), `decay_render.rs`
(849), `caveman.rs` (651), `memory_render.rs` (538), `classify.rs` (490),
`prompt_surface.rs` (385). All seven line counts were re-derived at `HEAD` and
sum to 9,304, matching the map. Three corrections, recorded rather than silently
applied:

1. **`injection.rs` is not 4e.** The task brief names it as an in-scope file. The
   scope map assigns `src/injection.rs` (911) to sub-part **4b**
   (`scope-map-and-risk-ranking.md:526`), and 4b's inventory counts its 18 tests
   as its own (`../../part-4b-transform/existing-checks.md:45`). This lens treats
   injection as boundary context: 4e owns where the synthetic todo pair is
   *placed in the served array* (`transform.rs:11804-11833`, `:12091-12121`), not
   how the pair is built.
2. **`ck_wire.rs` is not 4e.** The map assigns `src/ck_wire.rs` (1,279) to
   sub-part **4f** (`scope-map-and-risk-ranking.md:619`). It is cited here only
   where a 4e property depends on it, at `ck_wire.rs:440-451`.
3. **There is one sibling lens in this directory, not two.** Only
   `lens-a-rendered-output.md` (555 lines) exists at `HEAD`, alongside 12
   evidence files. This lens verifies and folds in lens A's six named leads and
   does not re-derive its twelve candidate records.

`lib.rs` overlay regions are also outside the map's 4e unit list; the map splits
`lib.rs` between 4a, 4c and 4d. The only `lib.rs` sites cited below are the four
consumers of `prompt_surface.rs` exports at `:7594-7601` and `:7688-7720`, which
are 4d code reading a 4e contract.

Two reference corrections to lens A, both minor and neither changing a finding:

- Lens A cites `prompt_surface.rs:156-158` for `tool_manifest_falls_back`. The
  function is `:156-157` plus its closing brace at `:158`; the predicate is
  `:157`.
- Lens A cites `transform.rs:11001-11006` for `BuiltOutput`. Correct: `struct
  BuiltOutput` opens at `:11001` and closes at `:11006`.

**Every status below is `unaudited`.** Adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for production
guards.

## Claims register

25 claims, ordered by consequence. Sources are doc comments and diagnostic
strings inside the seven scope units, plus `docs/` and `PARITY.md` prose found by
searching for rendering, tag, hygiene, nudge and injection terms rather than by
guessing filenames. The searched documents are
`docs/nudge-hygiene-calibration-2026-08-16.md`, `docs/AUDIT-KNOWN-ISSUES.md`,
`docs/specs/prompt-surface/` (checklist, light mapping, budget fixture, mutation
results, light validation) and `packages/pi-plugin/PARITY.md`. There is no
transform or rendering specification outside the source; the scope map already
resolved that at `:685-700`.

`Impl` column values: a location means code enforces the claim in a default
production build; `debug only` and `test only` mean the enforcement is compiled
out of a release build; `NOT FOUND` means nothing in the tree enforces it.

| # | Verbatim quote (source ref) | Implied property | Impl |
| --- | --- | --- | --- |
| 1 | "Each `tool_result` block must have a corresponding `tool_use`." (`transform.rs:11208`) | The served array contains no `tool_result` without its owner. | **NOT FOUND** in production. `assert_no_orphaned_tool_arcs` is `#[cfg(test)]` at `:11171`, and its only non-test-module call site is `#[cfg(test)]` at `:5486` |
| 2 | "Each `tool_use` block must have a corresponding `tool_result` immediately after" (`transform.rs:11221`) | No served `tool_use` lacks an adjacent result. | **NOT FOUND** in production. Same guard |
| 3 | "The normal ingress and render paths must keep tool-use ids unique; debug and test builds fail at the first violation so the originating path is fixed." (`transform.rs:11227-11228`) | The belt is a last resort, and a violation is loud. | `enforce_unique_tool_use_ids` `:11231-11305`, called at `:12147`. **Loud only in debug** (`debug_assert!` `:11246-11250`); the release arm at `:11251` repairs silently |
| 4 | "(and its adjacent result) rather than trapping a live session in a deterministic provider-400 loop." (`transform.rs:11230`) | The release repair removes the later owner and its otherwise-orphaned result, and nothing else. | `:11258-11277` removes the pair; `:11297-11299` drops a message the removal emptied. Release only |
| 5 | "served output contains duplicate tool_use ids: {duplicates:?}" (`transform.rs:11248`) | The returned array has no duplicate id. | **debug only** (`:11246-11250`). Release relies on the repair at `:11251` onward, which is never asserted |
| 6 | "claude-code-anthropic synthetic prefix must not contain system-role messages" (`transform.rs:12143`) | No system-role message reaches the `m0`/`m1` prefix on the Claude Code leg. | **debug only** (`debug_assert!` `:12139-12144`) |
| 7 | "Shared rendered-tail hygiene metric for the module's Channel-1 and Channel-2 nudges." (`tail_hygiene.rs:1`) | `u` and `t` count tokens the render actually serves. | Partial. `measure_tail_hygiene` `:458-603` walks `projection.blocks`; render-aware for caveman (`:526`), Channel-1 reminder spans (`:527`, `:553`), drop sentinels (`:528`, `:555`, `:568`), reduced and sentinel arcs (`:505-507`) and `red:` targets (`:508`). **No strip class**: `strip:` appears 0 times in the file |
| 8 | "Reconstructed each final live tail after its latest compartment coverage boundary, applied persisted drops **and strip transforms**, then ran the same part-typed TypeScript hygiene walk used by the nudge baseline." (`docs/nudge-hygiene-calibration-2026-08-16.md:12`) | The calibrated `{U,T}` are post-strip. | **NOT FOUND** on the Rust side. The Rust walk has no strip handling, so the shipped numbers and the calibrated numbers are measured over different tails |
| 9 | "Channel 1/2 `ctx_reduce` nudges instead consume the persisted final-tail `{U,T}` hygiene baseline, excluding reasoning from both terms, so live pressure cannot silently escalate their severity." (`packages/pi-plugin/PARITY.md:291-294`) | Reasoning is out of both terms, and severity cannot be silently inflated. | First half implemented: the `Reasoning \| RedactedReasoning \| Opaque` arm returns `excluded_part` at `:583-585`. Second half contradicted by claim 8: a strip inflates `t`, which lowers severity, so the direction of the silent error is *under*-escalation |
| 10 | "The `<session-history>` tag is always present (never omitted) so the provider prompt-cache has a stable breakpoint to anchor on — an absent block would shift the bytes after it and bust the cache." (`memory_render.rs:7-9`) | The `m0` block is never absent. | **NOT FOUND** as stated. `M0_EMPTY_BODY` guarantees non-empty *content*, but the splice pushes `m0` only when a frozen unit keyed `"m0"` exists (`transform.rs:11709-11734`), so an absent unit yields an absent block. Lens A observation 20 |
| 11 | "m1 is the volatile half of the cached prefix and must never be fully empty, because the provider cache anchors a breakpoint at the m1 block and an empty block would shift it." (`memory_render.rs:320-322`) | `assemble_m1` never returns an empty string. | `assemble_m1` `:323-347`; the all-empty branch returns `placeholder` at `:341-343`. Same absent-unit gap as claim 10 at `transform.rs:11735-11755` |
| 12 | "This row-purity is load-bearing for the m1 digest: `m1_revision_signal` uses `max_compartment_seq` as the complete m1-SOFT leg for compartments BECAUSE the only way these bytes change without a new sequence (a row mutation) routes to a HARD." (`memory_render.rs:357-360`) | `render_new_compartments` bytes are a pure function of row fields, with no clock, age or pressure input. | `:361-375` calls `render_compartment_at_tier(c, 1)` with a literal tier. The consumer is `m1_compose.rs:54`, which is 4b scope, so the invariant spans the 4b/4e boundary |
| 13 | "the cache holds the served bytes" (implied by the render-once discipline at `transform.rs:1-16` and the `"serialized output cache drift"` assertion at `:5478`) | A `tail:{mid}` cache entry equals the bytes served for that mid. | **NOT FOUND**. Every `record_output_item` call (`:11725`, `:11746`, `:11821`, `:12077`, `:12108`) precedes `enforce_unique_tool_use_ids` at `:12147`, which can remove blocks and whole messages without touching `cache_entries`. Lens A contract-vs-code lead 4 |
| 14 | "a token must be followed by whitespace or ASCII punctuation so malformed text is never partially consumed" (`transform.rs:8411-8412`) | Imitation stripping never eats part of a malformed tag, and code spans pass through verbatim. | `strip_leading_tag_imitations` `:8413-8452`, `well_formed_tag_suffix` `:8475-8490`. Counter-lead: when a whole line is only imitations, `:8443-8445` does not re-emit the trailing newline, so two authored lines merge. That is a content change the doc does not license |
| 15 | "Remove exactly the prefix added for this block's registered number ... it never trims source whitespace or interprets another block's number." (`transform.rs:8400-8402`) | `strip_tag_prefix` is a byte-exact inverse of `prepend_tag`. | `strip_tag_prefix`, with `debug_assert_eq!(strip_tag_prefix(&tagged, tag_number), value)` at `:8396`. Test `tag_prefix_strip_is_a_byte_exact_inverse` at `:22619` |
| 16 | "Stored provenance must still match the live carrier before a row can occupy a slot." (`transform.rs:8081`) | A stale tag row cannot occupy a protected overlay slot. | `newest_active_tag_block_ids` `:8082-8125`; `row.kind` and `row.source_bytes` compared at `:8111`, descending sort on `(tag_number, block_id)` at `:8114-8119` |
| 17 | "Overlay edits mutate the typed kind in place, but `Serialize` prefers retained ingress bytes ... the edit never reaches the wire." (`transform.rs:8256-8260`) | Every overlay mutation clears the retained-bytes cache on both block and message. | `apply_tag_overlay_to_message` `:8208-8269`; `mark_modified()` at `:8255-8268` |
| 18 | "never commits its speculative mints, so the next load sees a different set" (`transform.rs:7717`) | A rejected pass invalidates the mint-frontier memo rather than skipping untagged blocks. | Memo identity `:7712-7727`, `tagged_key` `:7841-7845`, cache read and write at `:8601-8619` |
| 19 | "SQLite probes and row hydration always happen after the snapshot has been copied out." (`transform.rs:7545`) | The tag baseline cache lock is not held across store I/O. | `load_cached_tags` `:7639-7697`; the four `tag_baseline_cache()` lock scopes at `:7605`, `:7648`, `:7671`, `:7689` are each a single statement |
| 20 | "prompt_surface selected light, but built-in light assets are not available yet; using the byte-identical full guidance and tool descriptions until light assets ship." (`prompt_surface.rs:28`) | A light selection may silently serve full bytes, and the caller is told. | **Dead**. `GUIDANCE_LIGHT_PRIMARY`, `GUIDANCE_LIGHT_NO_REDUCE` and `TOOL_LIGHT_DESCRIPTIONS` are unconditionally `Some` at `:33-37`, so `:141` `fallback: light.is_none()` and `:157` are always false and all four consumers (`lib.rs:7594`, `:7599`, `:7600-7601`, `:7718`, `:7720`) are unreachable. Lens A record `render-a-light-surface-fallback-notice-never-served` |
| 21 | "The last 20 tags stay protected until they age out." (`docs/specs/prompt-surface/light-mapping.md`, rule G-002 / line `L-G-QUEUE`; the same sentence is served to the model) | Exactly the newest 20 tags are exempt from reclamation. | Partial and unit-mismatched. `default_protected_tags()` returns `20` at `transform.rs:893-895`, and `protected_tag_numbers` (`tail_hygiene.rs:401-412`) takes the top `protected_tags` tag numbers. But the strip path converts it to a **message** count: `protected_start = req.messages.len() - protected_tags * 2` at `transform.rs:10198-10201`, gating `:10229`, `:10277` and `:10301`. The `* 2` has no comment and no stated derivation |
| 22 | "The byte-identity invariant that matters is intra-module determinism (same compartments + budget → same bytes across passes); a differential golden cross-checks the v2 paraphrase path against the TS reference." (`decay_render.rs:10-12`) | The decay body is deterministic and TS-equivalent. | `render_golden_matches_reference` `:629` (7 cases), `render_tight_golden_matches_reference_with_real_estimator` `:787` (7 cases), `redacted_store_shape_matches_ts_at_real_history_budgets` `:663` (4 cases) |
| 23 | "Keep the transformation order and ASCII word-boundary rules aligned with that source: the committed differential fixture is the compatibility contract." (`caveman.rs:5-6`) | Caveman compression is byte-for-byte equal to `caveman.ts`. | `differential_golden_matches_typescript_oracle` `:626`, over 42 cases in `testdata/caveman-golden.json`. This is the file's **only** test |
| 24 | "attempts must never attach to (or purge) each other's runs." (`classify.rs:239`) | Derived Broca child session ids are distinct per attempt identity. | `:235-273`; tests `child_ids_are_stable_but_lineage_scoped` `:292` and `child_ids_are_stable_per_attempt_and_distinct_across_attempt_identity` `:452` |
| 25 | "well-formedness rejection must not echo it either." (`classify.rs:439`) plus "manifest covers {} of the {} requested claims" (`:207`) | Classifier rejection diagnostics never quote untrusted manifest text. | `manifest_validation_diagnostics_never_quote_the_manifest` `:432` |

**Count: 25 claims. 6 have no implementing code in a default production build** —
claims 1, 2, 8, 10, 13 are `NOT FOUND` outright, and claim 20 is implemented but
structurally unreachable. Two more, claims 5 and 6, are enforced only in a debug
build. Claims 1 and 2 do have `#[cfg(test)]` enforcement, which is why they are
counted as production gaps rather than as absent code.

## Contract-vs-code leads

Lens A recorded five. Its leads 1, 2, 3, 4 and 5 were independently re-verified
here and are not restated. Six further leads:

1. **The calibration report measured a different tail than the code measures.**
   Contract side: `docs/nudge-hygiene-calibration-2026-08-16.md:12` states the
   replay "applied persisted drops **and strip transforms**" before running "the
   same part-typed TypeScript hygiene walk used by the nudge baseline", and the
   report's three sessions plus a flagship positive control are the evidence
   behind the owner-set bands (`:29-40`). Code side: `measure_tail_hygiene`'s
   exclusion set (`tail_hygiene.rs:500-508`) and its per-kind arms (`:522-587`)
   have no strip class, and `strip:` appears zero times in the file. So the
   thresholds were calibrated on post-strip tails and are applied to a
   pre-strip measurement. This is the same defect lens A recorded as
   `render-a-hygiene-metric-ignores-surface-strips`, with a second, independent
   contract source that raises its consequence: it is not only a wrong number,
   it is a wrong number against thresholds tuned on the right one.

2. **`PARITY.md` names reasoning exclusion as the mechanism that stops silent
   severity drift; the strip blindness is exactly that drift, in the opposite
   direction.** Contract side: `PARITY.md:291-294`. Code side: reasoning
   exclusion is real (`tail_hygiene.rs:583-585`), but `t` includes stripped
   tokens, so `severity = u/t` (`:709`) is depressed rather than inflated. The
   doc guards against escalation and the code has a de-escalation bug. Both
   halves of the sentence are worth separate checks.

3. **The `U ⊆ T` assertion in the parity golden cannot fail.**
   `tail_hygiene.rs:1094` asserts `measured.u <= measured.t`, and `:598`
   constructs the value as `u: u.clamp(0, t)`. `hygiene_band` clamps again at
   `:706`. The assertion is a tautology against its own constructor. Recorded as
   a lead only; the adequacy verdict belongs to
   `/testing:invariant-test-review`.

4. **The parity golden cannot exercise any render-aware exclusion.**
   `tail_hygiene.rs:1049-1056` calls `measure_tail_hygiene` with
   `&CoreState::default()` and an empty `&HashSet::new()`, so no frozen unit of
   any kind is present in any of the 12 cases. The metric's `red:` arm (`:508`),
   its caveman arm (`:526`, via `caveman_content` `:422-429`) and the absent
   strip arm are all unreachable from the cross-language corpus. The fixture that
   exists to stop cross-language drift is blind to the render-awareness that
   makes the two implementations hard to keep aligned. One case is *named*
   `caveman-rendered-not-original-weight`
   (`crates/mc-module/gen/gen-nudge-hygiene-golden.ts:106-112`), but it encodes
   the caveman text as literal block content rather than as a `cav:` frozen unit,
   so it exercises the text arm, not the caveman arm.

5. **The served guidance promises a tag reserve; the strip path enforces a
   message reserve.** Contract side: the shipped guidance line `L-G-QUEUE`
   (`docs/specs/prompt-surface/light-mapping.md`, rules G-002 through G-005) and
   its full-asset twin tell the model "The last 20 tags stay protected until they
   age out". Code side: `transform.rs:10198-10201` computes
   `protected_start = messages.len() - protected_tags * 2` and uses it as a
   *message index* threshold at `:10229`, `:10277` and `:10301`. Nothing states
   the two-messages-per-tag conversion, and nothing checks that the message
   window contains at least 20 tags. A tail with more than two tags per message
   protects fewer than 20 tags while telling the model 20 are safe.

6. **`memory-render-golden.json` is an orphan fixture.** It is generated by
   `crates/mc-core/testdata/gen-golden.ts:339` and holds 6 cases
   (`memory_block_cases` 3, `memory_updates_cases` 3). No `.rs` file in `crates/`
   references it; the only in-tree references are the generator and stale
   `target/debug/deps/*.d` artifacts from an earlier revision. So a generated
   cross-language fixture for the m0/m1 memory surface exists and nothing
   consumes it. `memory_render.rs`'s four tests use hand-built rows and the live
   TypeScript source instead.

## Debug-versus-release behavioural divergence

This is a first-class contract question for 4e, not an incidental detail, and it
is the only place in the sub-part where the *observable behaviour of the served
array* depends on the build profile.

`enforce_unique_tool_use_ids` (`transform.rs:11231-11305`) is the last
transformation applied to the whole array (`:12147`). It contains two mutually
exclusive arms, so exactly one is compiled:

| Arm | Gate | Behaviour on a duplicate `tool_use` id |
| --- | --- | --- |
| debug | `debug_assert!` at `:11246-11250`, message `"served output contains duplicate tool_use ids: {duplicates:?}"`; the release repair is skipped by `#[cfg(not(debug_assertions))]` at `:11251` | Panics. The pass aborts. No array is served |
| release | `#[cfg(not(debug_assertions))]` at `:11251`; the early return is `#[cfg(debug_assertions)]` at `:11303` | Removes the later owner and its adjacent result (`:11258-11277`), drops any message the removal emptied (`:11297-11299`), and returns the modified array |

What each side of the divergence means:

- **The prose describes the debug arm as the intended contract.** `:11227-11228`
  says "debug and test builds fail at the first violation so the originating path
  is fixed", and `:11230` frames the release repair as the alternative to
  "trapping a live session in a deterministic provider-400 loop". So the split is
  deliberate. What the prose does not say is that the release arm removes content
  with no record.
- **The only report of a release-build content removal is a stderr line.**
  `eprintln!` at `:11241-11245` emits
  `mc-module: duplicate_tool_use_id session={} id={} message_index={} block_index={} action=drop_later`.
  `BuiltOutput` (`:11001-11006`) carries `messages`, `cache_entries`,
  `cache_stats` and `timings`, and no field names a dropped block or a dropped
  message. This is the same shape as lens A's
  `render-a-emptied-tail-message-drops-without-a-report`, arriving from a second
  producer.
- **Each arm's test is compiled only in the profile the other arm needs.**
  `duplicate_tool_use_belt_panics_in_test_builds` (`:21504`) covers debug.
  `duplicate_tool_use_belt_drops_later_owner_and_result_in_release` (`:21514`)
  carries `#[cfg(not(debug_assertions))]` at `:21512`, so it does not compile
  under a default `cargo test`. Whichever arm ships, its test is the one a
  developer does not run by default.
- **CI builds the debug profile.** `ci.yml:169` is
  `cargo build -p mc-module --bin ck-mc-host`, with no `--release`, so the
  artifact CI produces selects the panicking arm. Whether the *distributed*
  `ck-mc-host` is a release build is unresolved and needs the release pipeline;
  lens A left the same question open.

Two smaller divergences on the same axis, both inside the 4e scope:

- `transform.rs:12139-12144`, `debug_assert!` with
  `"claude-code-anthropic synthetic prefix must not contain system-role messages"`.
  A release build serves the violating prefix.
- `transform.rs:9115`, `debug_assert!(utf16_len(&wrapped) <= USER_HINT_TOTAL_CHAR_CAP)`.
  Compiled out of release, and trivially satisfied in debug: lens A's
  `render-a-user-hint-total-cap-cannot-bind` computes a maximum of 458 UTF-16
  units against the cap of 800 at `:114`. Re-verified here: `:117`
  `USER_HINT_RESULT_LIMIT = 3` applied at `:9090`, `:113`
  `USER_HINT_FRAGMENT_CHAR_CAP = 80` applied at `:9096`, envelope built at
  `:9111`, truncation entered at `:9114` and gated at `:9120`.

**Net effect on this part's records.** Any 4e property whose only enforcement is
a `debug_assert!` has no enforcement in a shipped release build, and any property
about the *content* of the served array must state which profile it holds in.
Four of the five assertion sites in 4e production code are `debug_assert!`
(`:8396`, `:9115`, `:11246`, `:12139`), and there are **zero unconditional
runtime assertions** in the 9,304 lines (see the guard census below).

## Conventionally-enforced-only claims

Nine, each stated somewhere and mechanically checked nowhere.

1. **The `* 2` tag-to-message conversion** at `transform.rs:10201`. No comment,
   no constant, no test. Lead 5 above.
2. **The `nudge-hygiene-golden.json` regeneration discipline.** The Rust side
   recomputes the fixture hash (`tail_hygiene.rs:1035-1039`, message "committed
   fixture inputs must match the TypeScript generator provenance") and has a
   dedicated guard test `provenance_guard_rejects_mutated_fixture_input`
   (`:1099`). The TypeScript side reads the same field but never recomputes it:
   `packages/pi-plugin/src/tail-hygiene-parity.test.ts:277-279` asserts only
   `schema`, `generator_version` and a case-count floor. So the one provenance
   check lives entirely in the leg that CI does not run, and no workflow
   regenerates the fixture and diffs it.
3. **Two `DEFAULT_HISTORY_BUDGET_TOKENS` constants with different types.**
   `decay_render.rs:23` is `u32 = 60_000`; `memory_render.rs:16` is
   `f64 = 60_000.0`. Lens A lead 5; re-verified. Nothing ties them.
4. **The classify byte and chain caps are mirrored by comment only.**
   `packages/plugin/src/features/magic-context/dreamer/classify.ts:52` says
   "Mirrors `MAX_CLASSIFY_PROMPT_BYTES` in `crates/mc-module/src/classify.rs`"
   and `task-config.ts:48` says the same for `MAX_CLASSIFY_MODEL_CHAIN`. Neither
   test parses the Rust source. `task-config.test.ts:39` explicitly delegates one
   assertion to a Rust test by name instead of checking it.
5. **The `m1_revision_signal` completeness invariant crosses a sub-part boundary
   as prose.** `memory_render.rs:354-360` tells a future editor to "re-read the
   COMPLETENESS INVARIANT on `m1_revision_signal`" before adding a time-varying
   input. The invariant lives in `m1_compose.rs:54`, which is 4b. Nothing
   mechanically prevents the change the comment forbids.
6. **Four hand-written mutex labels** on the two process-global tag caches:
   `"tag baseline cache mutex"` (`transform.rs:7605`, `:7648`, `:7671`, `:7689`)
   and `"tag mint frontier cache mutex"` (`:8603`, `:8618`). Six sites, two
   strings, no consistency check. Same shape as 4c's and 4d's findings.
7. **The two 64 MiB cache budgets** at `transform.rs:144-145`
   (`TAG_BASELINE_CACHE_BUDGET_BYTES`, `TAG_MINT_FRONTIER_CACHE_BUDGET_BYTES`)
   are literals with no stated derivation and no relation to each other beyond
   being equal.
8. **`prompt_surface.rs:104`**: "It participates only in materialization
   freezing, never provider-visible epochs." A whole-crate absence claim about
   `config_identity` with no guard.
9. **The unknown-tool-override warning is stderr-only.**
   `warn_ignored_unknown_tool_description` (`prompt_surface.rs:150-153`) emits
   `"mc-module: config warning: prompt_surface.tool_descriptions.{tool_id} is not
   a known ctx_* tool ID; the override was ignored."` and returns nothing. A
   silently ignored description override is not visible in any response field.

## Existing-check inventory

### In-crate tests (clustered, counts, line ranges, attribution method)

**237 of the 280 tests in `transform.rs`'s flat `mod tests` reach 4e production
code, of which 25 name a 4e-owned symbol in their own body; plus the 5 tests in
`mod nudge_formula_tests`, plus 35 file-local tests in the six other 4e units.
That is 277 in-crate checks. None runs in CI.**

#### Attribution method

`transform.rs`'s test module is flat (`pub(crate) mod tests` at `:12626`, no
inner `mod`) and is read as evidence by both 4b and 4e, so a test's subject
cannot be read off its location. The attribution reproduces 4d's four-step
method so the inventories are comparable
(`../../part-4d-facade/existing-checks.md:63-83`):

1. **Enumerate.** All `#[test]` and `#[tokio::test]` attributes. Re-counted
   independently at `HEAD`: **285** total, **280** at or after `:12626` and
   **5** in `mod nudge_formula_tests` (`:9629`, extent `:9629-9783`, attributes
   `:9661`, `:9671`, `:9691`, `:9703`, `:9733`). These are exactly 4b's figures
   (`../../part-4b-transform/existing-checks.md:55-62`).
2. **Resolve.** Each attribute resolved forward to its following `fn` line: 280
   functions, first
   `claude_code_cache_ttl_mapper_is_lossy_because_provider_vocabulary_is_limited`
   at `:12645`, last
   `channel2_directive_id_hashes_session_and_arming_watermark_deterministically`
   at `:29425`. Both re-derived at `HEAD`; both match 4b.
3. **Brace-match.** Each body brace-matched to its closing line with string
   literals stripped, so a test's extent is its real body.
4. **Fixpoint over helpers.** A curated set of 62 4e-owned production
   identifiers (the splice, overlay, tag-cache, mint, hygiene, hint, strip and
   serialized-output-cache entry points and their constants) matched inside each
   body, then a fixpoint taken over the **115 non-test helper functions** in the
   flat test module.

The result is four tiers that **bracket** rather than pin:

| Tier | Tests | What it measures |
| --- | --- | --- |
| **Reach** | **237** of 280 | Drives a whole pass, or names a 4e symbol transitively. Executes at least one line of 4e production code |
| Op-specific, helper fixpoint | *unusable* (190) | See below |
| **Op-specific, direct body match** | **25** | Names a 4e-owned render, tag, hygiene, overlay or hint symbol in its own body |
| Name rule | **89** | Test name contains a 4e-distinctive term |

**Two things about these numbers a later pass must not misread.**

First, **the fixpoint tier is unusable here and the reason is structural.** It
returns 190, because the shared fixture driver `run` (`:14331-14338`, which calls
`transform` at `:14334`) transitively names nearly every 4e symbol: a whole pass
renders output, so any test that drives a pass reaches the splice. This is the
mirror image of 4d's inflation, which came from 4d owning the response vocabulary
the whole crate speaks. Here it comes from 4e being the terminal stage every pass
must traverse. **Use 237 for reach and 25 for op-specific.** The 89-test name
rule sits between them and is the cheapest independent check on both.

Second, **my whole-pass driver count is 207, where 4b reports 210.** The
difference is a three-test detector edge on how the driver call is written, not a
disagreement about scope, and it changes no tier above: 237 = 207 drivers + 30
non-driving tests that name a 4e symbol transitively. Recorded per METHOD.md
rule 1 rather than silently absorbed.

#### Reconciling 4b's "226 of 280"

**No correction is issued to 4b, and the two numbers do not contradict each
other, because the 210 whole-pass drivers belong to both.** 4b's lens C
partitioned the same 280 tests into five disjoint buckets
(`../../part-4b-transform/existing-checks.md:68-74`): 210 whole-pass drivers,
16 4b-only unit tests, 22 4e-only unit tests, 5 touching both helper families,
and 27 unclassified. Those sum to 280, which I re-verified arithmetically.

4b's 226 is `210 + 16`. The symmetric 4e figure from the same partition is
`210 + 22 + 5 = 237`, which is exactly the reach tier I derived independently.
4b said so itself at `:73-74`: "Because a pass also renders output, the 210
traverse 4e as well and are shared evidence, not 4b-exclusive."

So:

| Figure | Value | What it is |
| --- | --- | --- |
| 4b scope | 226 | 210 shared drivers + 16 4b-only |
| 4e scope | **237** | 210 shared drivers + 22 4e-only + 5 both |
| Shared | 210 | Counted by both parts, exclusive to neither |
| Union | 253 | `226 + 237 - 210`; the remaining 27 are 4b's unclassified bucket |

The one place my independent pass disagrees with 4b's partition is the size of
its "4e-only" and "4b-only" buckets, and that is a definitional difference, not
an error: my 4b symbol set was the full 300 identifiers defined in
`transform.rs:1-7510` plus the seven 4b files, which is much wider than the
"4b-only symbol" rule 4b's lens used, so my direct-match buckets are not
comparable to its 16 and 22. The tier that *is* comparable — the shared driver
count — agrees to within the three-test detector edge noted above.

#### The 25 op-specific tests in `transform.rs`, clustered

Every `fn` line re-read at `HEAD`. `†` marks `#[ignore]`.

| Cluster | Tests | Lines | Notes |
| --- | --- | --- | --- |
| serialized-output cache | 5 | `:28596`, `:28622`, `:28660`, `:28698`, `:28726` | The invalidation-granularity family. `:28622` and `:28660` are the two byte-equality replays lens A leans on |
| tag baseline cache | 4 | `:23364`, `:23433`, `:23466`, `:23490`† | `:23433` `poisoned_tag_baseline_refills_after_direct_sql_update` is the only one that corrupts the store directly. `:23490` is `#[ignore]`, a manual 50k timing proof |
| byte-identical replay through the output cache | 2 | `:27150`, `:27216` | Both named by lens A as the strongest evidence for composition order and determinism |
| duplicate-`tool_use` belt | 2 | `:21504` (debug), `:21514` (release, `#[cfg(not(debug_assertions))]` at `:21512`) | Exactly one compiles per profile |
| tag-imitation defence | 2 | `:13726`, `:13766` | `strip_leading_tag_imitations` and its code-span carve-out |
| reasoning clearing and exemption | 3 | `:18360`, `:18850`, `:19070` | The Anthropic-signed-block rules at `:12273`, `:10258` |
| orphan-arc and served-fingerprint shape | 3 | `:14310`, `:14456`, `:27338` | `:14310` and `:27338` are the only tests whose oracle is `assert_no_orphaned_tool_arcs` |
| tag mint and prefix inverse | 2 | `:22321`, `:22619` | `:22619` pins claim 15 |
| frontier and fingerprint reuse | 1 | `:14585` | |
| whole-module timing fixture | 1 | `:28388`† | `#[ignore]`, 2,500 messages and 47,075 frozen units |

Plus the 5 in `mod nudge_formula_tests` (`:9629-9783`), which 4b explicitly
assigns to 4e (`../../part-4b-transform/existing-checks.md:60`): `:9662`
`channel1_uses_tail_ratio_without_pressure_or_whole_input`, `:9672`
`channel1_minimum_tail_floor_bands_and_cadence_match_reference`, `:9692`
`channel2_aggregate_uses_persisted_all_class_walk_and_holds_invalid_baselines`,
`:9704` `channel2_rearms_only_on_hard_coverage_fold_or_measured_u_collapse`,
`:9734` `channel2_claimed_lease_reaps_and_delivered_echo_keeps_cycle_consumed`.
These are the only tests of the band arithmetic and the Channel-2 rearm paths.

Named single tests the records lean on, verified by name and `fn` line:

| Line | Test | Pins |
| --- | --- | --- |
| `:23307` | `tag_overlay_replays_stably_and_new_tail_gets_next_number` | Overlay replay stability plus next-number allocation |
| `:23128` | `user_hint_query_keeps_terms_beyond_the_old_character_cap` | The hint *query* path, not the render cap |
| `:27131` | `non_reasoning_adjacency_keeps_full_drop_mode` | The full-drop filter path |
| `:14336` | (inside the shared `run` helper) `assert_no_orphaned_tool_arcs(response.messages())` | Every whole-pass driver inherits the arc check — in test builds only |

That last row is the load-bearing detail of this whole inventory: because the
arc assertion sits inside the shared fixture driver at `:14336`, all 207 to 210
whole-pass drivers assert it transitively. The guard has broad *test* coverage
and zero production presence.

#### File-local tests in the six other 4e units

Re-counted at `HEAD` by resolving each test attribute to its `fn` line.

| File | `#[cfg(test)]` | Tests | What they cover |
| --- | --- | --- | --- |
| `decay_render.rs` | `:366` | **15** | `:396`-`:540` tier selection, archived omission, XML-safe headings, legacy and malformed rows, oldest-first demotion; `:586` m0 extraction; `:629`, `:663`, `:787` the three cross-language goldens; `:843` a tagged-session render |
| `tail_hygiene.rs` | `:724` | **7** | `:772`, `:813` baseline additivity and invalidation; `:1029` the 12-case parity golden; `:1099` the provenance guard; `:1116` the reasoning and tagged-text mutants; `:1169` protected-arc exclusion from `u`; `:1211` the conservative orphan `t` |
| `classify.rs` | `:274` | **6** | `:284`, `:307`, `:331`, `:432` manifest envelope and diagnostics; `:292`, `:452` child-session identity |
| `memory_render.rs` | `:377` | **4** | `:407`, `:434` category typing; `:502` the live-TypeScript vocabulary gate; `:528` render-order prefix |
| `prompt_surface.rs` | `:324` | **2** | `:329` light slots serve authored bytes and assert `!fallback`; `:359` the full manifest is legacy-inert |
| `caveman.rs` | `:612` | **1** | `:626` the 42-case differential golden. The only test in 651 lines |

That is **35 file-local tests**. Combined with 237 + 5 from `transform.rs`, 4e has
**277 in-crate checks**.

`caveman.rs` is the sub-part's thinnest surface by test count: one test for 651
production lines, and its oracle is a frozen fixture rather than the live
TypeScript.

#### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]`: 3, all in `transform.rs`, 2 of them inside 4e's 25.** `:13200`
`apply_once_stage_timings_large_fixture` (4b), `:23489`
`tag_baseline_warm_hydration_50k`, `:28387` `full_module_pass_timing_fixture`.
The last two are in the op-specific set above, so 2 of 25 do not run even under
a local `cargo test`. Zero `#[ignore]` in the other six 4e files.

**`should_panic`: none found** in any 4e file. The two `catch_unwind` sites at
`:14314` and `:14321` are the nearest equivalent, and they wrap
`assert_no_orphaned_tool_arcs` rather than production code.

**Property, mutation and concurrency tooling: none found.** Zero occurrences of
`proptest`, `quickcheck`, `loom`, `shuttle` or `miri` in any of the seven 4e
units. No `mutants.toml` in the repository root. No coverage configuration, so
every placement statement above is structural rather than measured. No
`mc-module` entry in `.config/nextest.toml`, so no 4e test is serialized,
grouped, or timeout-adjusted.

**Table-driven fixture inventory**, re-derived from `crates/mc-module/testdata/`
at `HEAD`:

| Fixture | Cases | Rust consumer | Cross-language |
| --- | --- | --- | --- |
| `caveman-golden.json` | 42 | `caveman.rs:628` | Generated from `caveman.ts`; no TS consumer |
| `render-golden.json` | 7 | `decay_render.rs:634` | Generated by `crates/mc-core/testdata/gen-golden.ts:159` |
| `render-tight-golden.json` | 7 | `decay_render.rs:797` | Same generator, `:224` |
| `nudge-hygiene-golden.json` | 12 | `tail_hygiene.rs:1030` | Generated by `crates/mc-module/gen/gen-nudge-hygiene-golden.ts`; **also replayed by two TypeScript legs** |
| `decay-store-differential.json` | 4 | `decay_render.rs:710` | `crates/mc-module/testdata/gen-decay-store-differential.ts` |
| `memory-render-golden.json` | 6 | **none** | Generated by `gen-golden.ts:339`; orphan. Lead 6 |

### Integration and CI status (with workflow line refs)

**No integration test in scope. No 4e check runs in CI.**

Seven integration binaries exist under `crates/mc-module/tests/`. Counted by 4e
term occurrences in each at `HEAD`:

| Binary | Lines | 4e hits | Verdict |
| --- | --- | --- | --- |
| `direct_host.rs` | 438 | 2 | Both are the string `"render_config"` (`:114`, `:177`), a config-identity field, not the renderer. **Out of scope** |
| `lifecycle_cli.rs` | 635 | 6 | All six are `staged`/`start`/`stop` lifecycle words matched incidentally (`:5`, `:202`, `:211`, `:355`, `:429`, `:612`). **Out of scope** |
| `prepared_output.rs` | 282 | 0 | 4d |
| `host_adapter.rs` | 173 | 0 | — |
| `broca_roundtrip.rs` | 198 | 0 | — |
| `boundary_counter_durability.rs` | 64 | 0 | — |
| `release_contract_conformance.rs` | 147 | 0 | Credential and closure-digest contracts (`:17`, `:48`, `:130`) |

**Integration tests in 4e scope: none found.** 4b has two
(`../../part-4b-transform/existing-checks.md:51`) and 4d has ten; 4e has zero.
The final byte-producing stage has no coverage outside the crate's own test
modules.

**CI, verified at `HEAD` against all five files in `.github/workflows/`**
(`ci.yml`, `claude-code-review.yml`, `historian-eval.yml`,
`retrieval-benchmark.yml`, `shm-hardening-optin.yml`):

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`.** It is `ci.yml:168` at
   `76cd6f41` and `ci.yml:172` at `HEAD`. Both confirmed directly, the second in
   the working tree and the first through
   `git show 76cd6f41:.github/workflows/ci.yml`. The task brief's drift note is
   correct and both refs are cited wherever the step appears below.
   `--test lifecycle_cli` selects one integration binary and does not build the
   `--lib` target, so no in-crate `mc-module` test is compiled.
2. **The other `mc-module` step is build-only:**
   `cargo build -p mc-module --bin ck-mc-host`, `ci.yml:165` at `76cd6f41` and
   `:169` at `HEAD`. No `--release`, so the CI artifact is a debug build. This is
   the fact the debug-versus-release section turns on.
3. **The only other `mc-module` mention in any workflow is a comment**,
   `ci.yml:361`.
4. **`scripts/test-rust.sh` exists** (`cargo nextest run --workspace`), is wired
   into the root `package.json` as `test:rust`, and no workflow invokes it.
5. **No e2e or incident-pool suite runs.** `ci.yml:344` type-checks
   `packages/e2e-tests` and `:338` runs `test:prospective-unit`; nothing runs
   `test:e2e`, `test:incidents` or `test:incidents:rust`. This matters because
   `packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts` is
   the only harness in the tree that drives real Rust rendering across the
   language boundary: it declares `prerequisites: ["cargo", "ck-mc", "commons",
   "subconscious"]` at `:108` and links `crates/mc-module/src/injection.rs`
   (`:1600`) and `crates/mc-module/src/transform.rs` (`:1607`) as its sources.
   It runs on no machine but a developer's, on request.

**Consequence for every 4e record.** `Exercised: partial` means "a test exists on
a developer's machine", and for `transform.rs:21514` it means "a test exists that
a developer's default `cargo test` does not compile". METHOD.md's `Exercised`
vocabulary does not distinguish these from `not yet`. 4b, 4c, 4d, the scope map
(`:681`) and lens A have all raised it. It is recorded here as needing a human
ruling, not resolved.

### TypeScript-side gates

`ci.yml:257` runs `bun run test`, which is
`sh scripts/test-shard.sh packages/plugin && bun run --cwd packages/pi-plugin test && ...`
(root `package.json`), and `ci.yml:317` runs the pi-plugin suite again directly.
`bun test` from a package root recursively discovers every `*.test.ts` beneath
it, including `packages/plugin/scripts/`. So the gates below do run on every pull
request.

**Four TypeScript gates touch contracts 4e implements. Each is stated
precisely, because the prior passes found three different patterns and the
distinction decides what a green light means.**

| Gate | Relationship to the Rust code | What it actually tests |
| --- | --- | --- |
| `packages/pi-plugin/src/tail-hygiene-parity.test.ts:276` "keeps TypeScript and Pi aligned with the Rust-consumed golden" | **Parallel implementations against a shared fixture. Does not execute Rust.** | Reads `crates/mc-module/testdata/nudge-hygiene-golden.json` at `:60-68` and runs `measureTailHygiene` (OpenCode) and `measurePiTailHygiene` (Pi) over all 12 cases (`:281-300`). Two of three legs are checked; the Rust leg is bound only by the frozen fixture. Also `:301` a reasoning-arm mutation test and `:337` the 0.651 flagship band |
| `packages/pi-plugin/src/tail-hygiene-walk-pi.test.ts:713` | **Parallel implementation, same fixture.** | Second Pi-side consumer of the same golden |
| `packages/plugin/scripts/prompt-surface-gates.test.ts` (6 tests, 7 assertions per `docs/specs/prompt-surface/mutation-results.md:11`) | **Gates the Rust-served artifact bytes, not the Rust code.** The closest thing 4e has to a real cross-language gate | Through `packages/plugin/scripts/prompt-surface-fixture.ts:20-21` it reads the exact assets `prompt_surface.rs:34-36` `include_str!`s — `crates/mc-module/assets/guidance_light_primary.txt` and `guidance_light_no_reduce.txt` — and validates the budget fixture, the 37-rule checklist mapping, and the rendered checklist artifact |
| `packages/plugin/src/hooks/magic-context/tail-hygiene-walk.test.ts`, `caveman.test.ts`, `decay-render.test.ts`, `ctx-reduce-nudge.test.ts`, `tag-messages-collision.test.ts` | **Parallel implementations only. No shared artifact, no Rust reference.** | They test the TypeScript originals the Rust files were ported from. A Rust-side drift is invisible to them |

**The answer to "does a TypeScript rendering gate exist": yes, one, and it tests
an artifact rather than the code.** `prompt-surface-gates.test.ts` is the only
CI-gated TypeScript check that reads bytes the Rust module actually serves. Every
other TypeScript check in 4e's territory is a parallel implementation, and the
only cross-language *behavioural* coupling — the nudge-hygiene golden — is
checked on its two JavaScript legs in CI and on its Rust leg nowhere.

**No case of "each half tested against a fake of the other" was found in 4e.**
That pattern is 4d's, on the claim-effects acknowledgement
(`../../part-4d-facade/existing-checks.md:163-227`). 4e's pattern is different
and worth naming separately: a **frozen shared fixture whose provenance guard
lives only in the unrun leg**. The Rust side recomputes the input hash
(`tail_hygiene.rs:1035-1039`) and has a dedicated mutation guard (`:1099`); the
TypeScript side reads the provenance field but never recomputes it
(`tail-hygiene-parity.test.ts:277-279`). No workflow regenerates the fixture and
diffs it. So a fixture that drifts from the TypeScript generator it was produced
from is caught by review alone, and the check designed to catch exactly that runs
on no CI machine.

One genuine compile-coupled gate exists and it points the other way.
`memory_render.rs:504` `include_str!`s the live TypeScript source
`packages/plugin/src/features/magic-context/memory/constants.ts` and parses three
`export const` arrays out of it (`:475-499`), asserting
`CATEGORY_PRIORITY == POSITIVE_MEMORY_CATEGORIES` and that every
`V2_MEMORY_CATEGORIES` and `PROMOTABLE_CATEGORIES` entry is a positive category
(`:502-524`). Because it is `include_str!`, editing the TypeScript file forces a
Rust rebuild — but the assertion only fires when someone runs `cargo test`, which
CI does not.

### Production assertions and guards (clustered)

Measured over production lines only: `transform.rs:7511-12623` excluding
`mod nudge_formula_tests` (`:9629-9783`), plus each other 4e file up to its
`#[cfg(test)]` line.

**Runtime assertions: four, and all four are compiled out of release.**

| Site | Guard | In release? |
| --- | --- | --- |
| `transform.rs:11246-11250` | `debug_assert!` "served output contains duplicate tool_use ids" — the loud half of the belt | **No** |
| `transform.rs:12139-12144` | `debug_assert!` "claude-code-anthropic synthetic prefix must not contain system-role messages" | **No** |
| `transform.rs:8396` | `debug_assert_eq!(strip_tag_prefix(&tagged, tag_number), value)` — the byte-exact-inverse claim | **No** |
| `transform.rs:9115` | `debug_assert!(utf16_len(&wrapped) <= USER_HINT_TOTAL_CHAR_CAP)` — trivially satisfied, max 458 against 800 | **No** |

**Zero unconditional runtime assertions in 9,304 production lines.** The two
`assert!` sites in the transform range, `:11206` and `:11219`, are inside
`assert_no_orphaned_tool_arcs`, whose `#[cfg(test)]` is at `:11171`. 4d found one
unconditional assertion in about 9,000 lines; 4e has none. Zero compile-time
`const _` assertions in scope.

**Panicking sites: none found.** Zero `panic!`, `unreachable!`, `todo!` and
`unimplemented!` across all seven units' production halves. 4e is the only
sub-part inventoried so far with no panicking site at all.

**`.expect(`: 25, in four clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Process-global tag caches (`transform.rs`) | 6 | `"tag baseline cache mutex"` (`:7605`, `:7648`, `:7671`, `:7689`), `"tag mint frontier cache mutex"` (`:8603`, `:8618`) |
| Infallible string walks (`transform.rs`) | 4 | `:8511` `"non-empty reminder remainder"`, `:9034` and `:9057` `"non-empty remainder"`, `:9235` `"filtered taggable block"` |
| Serialization (`transform.rs`) | 4 | `:10817` `"renderer transition classes are serializable"`, `:10827` `"renderer transition classes serialize"`, `:11038` `"CK message metadata must serialize"` — plus `:9011`/`:9016` regex labels |
| Other files | 11 | `tail_hygiene.rs` 3 (`:378` `"one candidate arc"`, `:643`, `:664`), `classify.rs` 6, `caveman.rs` 1 |

Three of these name a contract with no test: `"renderer transition classes are
serializable"`, `"CK message metadata must serialize"` and
`"one candidate arc"`. The last is the interesting one — it is the assertion
holding up the `HashMap` iteration discussed below.

**`.unwrap()`: 20, all infallible-by-construction regex compilation.**
`transform.rs:9927`, `:9972`, `:10154` and `caveman.rs` 17 sites (`:180`, `:204`,
`:237`, `:242`, `:247` and neighbours), every one a `Regex::new(...)` inside a
`get_or_init` over a literal pattern. Zero `.unwrap()` in `tail_hygiene.rs`,
`decay_render.rs`, `memory_render.rs`, `classify.rs` or `prompt_surface.rs`
production halves.

**Diagnostics that replace a guard: two stderr writers.**
`transform.rs:11241-11245` (`action=drop_later`, the only trace of a release-build
content removal) and `prompt_surface.rs:150-153` (an ignored tool-description
override). Neither has a response field and neither has a test.

**`let _`: one.** `tail_hygiene.rs:590`
(`let _ = write!(signature_input, ...)`), a formatting write to a `String`, which
cannot fail. Zero in `transform.rs`'s 4e range. Lower than 4c's six and 4d's
three.

**Typed rejection guards.** With no unconditional assertion anywhere, the
enforcement in 4e is either a returned value or a diagnostic string. The two
places that return a hard error on a rendering failure are
`SyntheticTodoAnchorMissing` (`transform.rs:12125-12133`) — the only site in the
splice where a placement failure is reported rather than absorbed — and
`memory_render.rs`'s four typed claim rejections (`:91`, `:94`, `:101`, `:104`),
which name the reason a mirrored claim was excluded. `classify.rs` carries the
densest set, nine manifest rejections at `:166-207`, with `:432` proving they do
not echo untrusted text.

**One order-dependence guarded only by a caller.** `tail_hygiene.rs:364`
`for (call_id, rows) in orphan_rows` iterates a `HashMap`, and the loop body
reads `by_arc` at `:373` (`!by_arc.contains_key`) and writes it at `:394`
(`by_arc.insert`). Order independence holds only because candidate arc sets are
disjoint per call id, and that disjointness is produced by
`ck_wire.rs:440-451`: a singleton call's `arc_id` is the call block's own
`block_id` and a repeated call's is `tool_arc_id(&msg.mid, id)`, so all blocks in
one arc carry one `tool_call_id`. Verified at `HEAD`. **Nothing local enforces
it.** The `candidate_arcs.len() != 1` filter at `:376` and the
`.expect("one candidate arc")` at `:378` narrow the window but do not establish
the invariant; they assume it. `ck_wire.rs` is 4f scope, so a 4f change can
silently make a 4e render seed-dependent. Lens A reached the same conclusion from
the determinism side.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The release-only duplicate repair is the quietest decision in 4e that
   changes served bytes.** `transform.rs:11251-11302` removes blocks and whole
   messages from the final array. Its only report is an `eprintln!`. Its only
   test carries `#[cfg(not(debug_assertions))]` (`:21512`) and therefore does not
   compile under a default `cargo test`. Its sibling arm panics instead. And the
   contract prose at `:11227-11230` describes the panicking arm as the intended
   behaviour while the repairing arm is the one a release artifact ships. Three
   independent gaps stacked on one 52-line block.

2. **Orphan tool arcs have no production detection, and the test coverage is
   broad enough to hide that.** `assert_no_orphaned_tool_arcs` is `#[cfg(test)]`
   at `:11171` and its only non-test-module call site is `#[cfg(test)]` at
   `:5486`. Because the check sits inside the shared fixture driver at `:14336`,
   every one of the 207 to 210 whole-pass drivers asserts it, so a reader
   counting assertions per test would conclude arc integrity is the best-covered
   property in the sub-part. In production nothing checks it, and the first
   signal is a provider 400 for the whole session. The scope map calls it a
   production guard (`scope-map-and-risk-ranking.md:441-443`); lens A recorded
   the correction and this pass re-verified it.

3. **`caveman.rs` is the closest thing 4e has to a zero-test file: 651 lines,
   one test.** `differential_golden_matches_typescript_oracle` (`:626`) replays
   42 frozen cases and is the entire check on the file. The header calls the
   fixture "the compatibility contract" (`:5-6`), so the contract is a snapshot,
   not the live oracle: `packages/plugin/src/hooks/magic-context/caveman.ts` can
   change and only a regeneration would notice. No workflow regenerates it. And
   caveman output feeds the hygiene metric through `caveman_content`
   (`tail_hygiene.rs:422-429`), which the 12-case parity golden cannot reach at
   all (lead 4), so the compression and the metric that consumes it are each
   pinned by a fixture and never checked together.

4. **The strip surface has no hygiene test and no strip literal anywhere in the
   metric.** `new_frozen_strip_units` (`transform.rs:10181-10339`) produces five
   strip classes, `apply_surface_strips` (`:10371-10458`) can collapse a whole
   message to one sentinel block (`:10388-10391`) or empty a stale reduce
   (`:10454-10457`), and `measure_tail_hygiene` knows about none of it. The
   calibration report that set the bands assumed the opposite (lead 1). Nothing
   in either language measures the divergence.

5. **`memory-render-golden.json` is generated, committed and unread.** 6
   cross-language cases for the m0/m1 memory surface, produced by
   `crates/mc-core/testdata/gen-golden.ts:339`, with no Rust consumer at `HEAD`.
   `memory_render.rs`'s four tests use hand-built rows instead. A fixture that
   exists to prove a cross-language property and is wired to nothing is worse
   than no fixture, because its presence reads as coverage.

6. **`prompt_surface.rs`'s fallback path is dead and its notice is stale.**
   `LIGHT_FALLBACK_NOTICE` (`:28`) says light assets "are not available yet"
   while `:33-37` compile them in unconditionally and
   `docs/specs/prompt-surface/light-mapping.md` maps 37 checklist rules onto
   named lines of the shipped light guidance. `:141`, `:157` and the four
   `lib.rs` consumers are unreachable. The one CI-gated TypeScript rendering gate
   validates the assets the notice claims do not exist.

7. **The Channel-2 derived tag numbering can name a handle with no durable row,
   and nothing checks it.** `active_tags_for_channel2` (`transform.rs:9282-9313`)
   numbers taggable tail blocks `1..n` when no stored row survives, deliberately
   per the comment at `:9279-9281`, and that numbering reaches agent-visible
   bytes through `oldest_channel2_hint` (`:9534-9547`, called `:9396`) and
   `format_reclaimable_hint` (`:9866-9876`), which renders `§{tag}§ {name}` at
   `:9872`. The five `nudge_formula_tests` cover the band arithmetic and the
   rearm paths; none covers the hint's tag numbers. Lens A's
   `render-a-channel2-derived-tag-numbers-name-no-durable-row`, re-verified.

8. **The two 64 MiB process-global tag caches have four tests, none of which
   exercises the budget.** `:23364`, `:23433`, `:23466` and `:23490` cover cold
   passes, poisoned refill, session isolation and warm hydration timing, and
   `:23490` is `#[ignore]`. Nothing drives
   `TAG_BASELINE_CACHE_BUDGET_BYTES` or `TAG_MINT_FRONTIER_CACHE_BUDGET_BYTES`
   (`:144-145`) to eviction, so the eviction accounting on the only mutable
   process-global state the render depends on is unexercised.

9. **`classify.rs`'s cross-language constant mirrors are prose.**
   `MAX_CLASSIFY_PROMPT_BYTES` and `MAX_CLASSIFY_MODEL_CHAIN` are documented as
   mirrored in `classify.ts:52` and `task-config.ts:48`, and `task-config.test.ts:39`
   delegates one assertion to a named Rust test rather than checking it. The Rust
   header's whole argument (`:4`, "callers cannot turn this management surface
   into a generic arbitrary-prompt producer") rests on caps whose TypeScript
   twins are checked by nothing.

10. **`decay_render.rs`'s budget-guard demotion is the one place a bound removes
    whole compartments from m0, and its termination is a magic multiplier.**
    `:330` is `let mut guard = compartments.len() * 5;` and tier 5 renders empty
    (`:319-322`), so under a binding budget whole compartments leave the artifact.
    `budget_guard_demotes_oldest_first` (`:519`) covers the ordering. Part 3 owns
    the ladder and the termination bound per
    `scope-map-and-risk-ranking.md:666`; the `* 5` has no comment on either side
    of that boundary.

11. **No integration coverage of the final byte-producing stage.** Zero of the
    seven integration binaries reach 4e. The only harness that drives real Rust
    rendering across the language boundary,
    `packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts`,
    runs in no workflow.

## Open questions

- Which build profile does the distributed `ck-mc-host` use? `ci.yml:169` builds
  without `--release`, selecting the panicking duplicate-id arm, but CI's
  artifact is not necessarily the shipped one. This decides which of two
  materially different served-array behaviours is in production. Unresolved,
  needs the release pipeline. Lens A left the same question open.
- Is the debug-versus-release split at `transform.rs:11251`/`:11303` intended to
  be a *behavioural* contract, or was it intended as a debug-time diagnostic on
  top of one behaviour? The prose at `:11227-11230` reads as the latter but the
  code implements the former, and a release build never executes the assertion
  the prose calls the contract. (needs human input)
- Were the nudge bands calibrated on a tail that the Rust metric cannot
  reproduce? `docs/nudge-hygiene-calibration-2026-08-16.md:12` says the replay
  applied strip transforms; `measure_tail_hygiene` does not. If the answer is
  yes, the shipped thresholds are wrong by the strip volume of a real session,
  and the report's own note that "any threshold adjustment requires owner
  sign-off" (`:44`) makes this an owner decision rather than a code fix.
  Unresolved, needs a measurement on a real session plus the band owner.
- Should the `nudge-hygiene-golden.json` corpus carry frozen units? Today all 12
  cases pass `&CoreState::default()` (`tail_hygiene.rs:1049-1056`), so the
  cross-language fixture cannot reach the `red:`, caveman or strip arms — the
  exact render-awareness most likely to drift between three implementations.
  Adding them changes the fixture contract and requires regenerating from the
  TypeScript generator. (needs human input)
- Why is `memory-render-golden.json` generated and unread? Either a consumer was
  removed or one was never written. Unresolved, needs the author or the history.
- Is `protected_tags * 2` (`transform.rs:10201`) a deliberate
  two-messages-per-tag heuristic, and is the resulting message window ever
  smaller than 20 tags? The served guidance promises 20 protected tags. Needs the
  author. (needs human input)
- Does the `tail_hygiene.rs:364` disjointness assumption need a local guard? It
  currently depends on `ck_wire.rs:440-451`, which is 4f scope, and the
  `.expect("one candidate arc")` at `:378` assumes rather than establishes it. A
  regression test pinning the assumption would be cheap; whether the invariant
  should be enforced locally instead is a design choice. (needs human input)
- Whether a never-executed test counts as `Exercised: partial` governs all 277
  in-crate checks in this sub-part, and for `transform.rs:21514` the test does not
  even compile under a default `cargo test`. 4b, 4c, 4d, the scope map (`:681`)
  and lens A all raised it. (needs human input)
