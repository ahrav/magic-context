# Part 4e fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 through 4d: safety checks must hold *while* their faults
are active; liveness checks need a bounded fault-free window; rare branches need
deterministic injection to be reachable at all; and coverage checks assert
independent preconditions, never the violation.

Provenance as in [existing-checks.md](existing-checks.md). `HEAD` is `e447c927`.
The one CI step that matters moved across `76cd6f41..HEAD`:
`cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at `76cd6f41` and
`ci.yml:172` at `HEAD`. The build step above it is `:165` and `:169`
respectively. All four were verified directly and both pairs are cited wherever
the steps appear.

Five framing points specific to this part.

**First, the dominant obstacle is not a missing fault, and this part has a second
obstacle no prior part had.** No CI job executes any test in this scope: the 277
in-crate checks run nowhere, and unlike 4b and 4d there is not even an
integration binary that reaches the renderer at all. On top of that, **a
debug-only test run cannot observe two of this part's behaviours or one of its
detection gaps**, because the served array's content depends on
`debug_assertions`. So the capability that unblocks the most consequence here is
not a fault injector. It is a build flag.

**Second, most of this part's enabling state is a frozen unit rather than a
fault.** 4e's inputs are a `CoreState`, a projection, a request and an overlay
map. Seeding a `strip:`, `red:` or `cav:` frozen unit and driving one pass makes
a large fraction of the records non-vacuous with no seam, no clock, no second
process and no new dependency. Eleven of the 26 records need nothing beyond
seeded state and one or two passes. The two records the `R3` split created are not
among the eleven: one needs a bounded advance of the caller-supplied clock and the
other needs N passes against a bound that does not exist in the code. And seeding
is two capabilities rather than one, which is refinement `R1`: core frozen units
live in `core.frozen_units` and the synthetic todo pair lives in
`meta.synthetic_todo`, so `F7` and `F7b` below are separate and neither implies the
other.

**Third, exactly one capability in this part is a build configuration rather than
a fault, and it is the only way to reach the release-only drop path.**
`transform.rs:11251-11302` is inside `#[cfg(not(debug_assertions))]`, so it does
not exist in a debug binary. Its test
(`duplicate_tool_use_belt_drops_later_owner_and_result_in_release`, `:21514`)
carries `#[cfg(not(debug_assertions))]` at `:21512` and therefore **does not
compile under a default `cargo test`**. The capability costs one extra `cargo
test --release` invocation and no new infrastructure. It is listed as `F1` and
ranked second on the leverage list for that reason.

**Fourth, two gates on the same axis are not the same gate, and conflating them
produces a wrong remediation.** `cfg(debug_assertions)` code exists in a debug
shipped binary and not a release one; `#[cfg(test)]` code exists in neither. The
duplicate-id belt's loud arm is the first kind. `assert_no_orphaned_tool_arcs`
(`transform.rs:11171`) is the second, so **running the suite in release does not
close the orphan-arc gap**: that assertion fires in a release *test* build and is
absent from both shipped profiles. F1 buys the belt's release arm and the two
further debug-only claims. It does not buy production arc detection, which needs
a code change rather than a capability.

**Fifth, one of this part's records is vacuous unless a second render happens
over already-served bytes, and that is cheap.** The Channel-1 append record
(`nudge-b-channel1-append-first-applies-without-a-frontier-gate`) is about
retroactively editing a block the provider has already cached. A single-pass test
cannot exercise it at all: the pass has to be the *second* one, over a block an
earlier pass served. That is request sequencing plus store state, which is `F3`
combined with `F6`, and both are free.

## Fault classes required

`F0` and `F1` are listed first because neither is a fault. `F0` is a workflow
change and `F1` is a build flag, and between them they govern what any other
class on this list can prove.

| Class | Description | Available today |
| --- | --- | --- |
| **F0** test execution in CI | Any workflow job that builds and runs `mc-module --lib` | **No.** Verified across all five files in `.github/workflows/`. The only `mc-module` test invocation is `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`), which selects one integration binary and does not build `--lib`, so none of the 277 in-crate checks compiles. The step above it is build-only (`:165` / `:169`). There is no `--lib`, no `nextest -p mc-module`, and no `--workspace` test job. `scripts/test-rust.sh` (`cargo nextest run --workspace`) is wired into root `package.json` as `test:rust` and no workflow calls it. There is no integration binary to fall back on: all seven under `crates/mc-module/tests/` have zero 4e content. This costs a workflow change and no new infrastructure |
| **F1** building and running in release mode | The same suite compiled with `debug_assertions` off, so `#[cfg(not(debug_assertions))]` code exists and `debug_assert!` does not | **Yes, and it is a build flag rather than a fault.** `cargo test -p mc-module --lib --release` compiles `transform.rs:11251-11302` and `:21514`, and drops the four `debug_assert` sites (`:8396`, `:9115`, `:11246`, `:12139`). This is the **only** way to reach the release-only drop path or to execute its test, which does not compile in debug (`:21512`). It is also the only way to observe that a release build serves a system-role synthetic prefix (`:12139`) rather than aborting. Cost: one extra invocation. **What it does not buy:** anything gated on `#[cfg(test)]`, which includes `assert_no_orphaned_tool_arcs` (`:11171`) and its only non-test-module call site (`:5486`) |
| **F2** forged overlay markers in ingress content | An inbound message whose bytes contain a marker the module treats as its own: `<system-reminder>`, `<ctx-search-hint>`, a `§N§` tag prefix, an HTML temporal comment, or a tool-call id in the `mc_synthetic_todo_` namespace | **Yes, and it needs no fault.** Every marker in 4e is plain text a user message or a tool result can contain. Verified: the hint envelope is the literal `<ctx-search-hint>` (`transform.rs:9111`) and the same string in ingress bytes is already treated as an existing augmentation by `has_stacked_user_hint_augmentation` (`:8989-8997`), which proves the envelope is forgeable from the user side. `is_system_reminder_transport_message`'s own comment concedes CK "intentionally has no transport-origin field" and settles for a text-shape discriminator (`:8525-8527`). The synthetic-id case is narrower and sharper: an ingress `ToolCall`/`ToolResult` id starting `mc_synthetic_todo_` on a message with `meta.synthetic == false` makes `normalize_synthetic_todo_ingress` (`:3243`, force-set at `:2419`) reclassify an authored message, which the tail loop then excludes at `:11842-11845`. Constructible by hand today; whether a non-module actor can choose an id on a production route is a harness-codec question and therefore 4f |
| **F3** a second render over an already-served block | Two passes where the second targets a block the first already put in the provider array | **Yes, and it needs no fault.** Request sequencing only. `is_tail` admits a served block (`transform.rs:6471-6473`, used at `:9799`), and `refresh_tail_hygiene_baseline` keeps the baseline evaluable on a non-busting refresh (`tail_hygiene.rs:665-682`), so the firing pass need not be a bust. The newest eligible tail tool result being one an earlier pass served is reachable through three documented fallbacks: newer results are excluded when their output is JSON (`tool_result_can_carry_channel1`, `:9809-9823` rejects `Json`, `ErrorJson`, `ExecutionDenied`), when they are frozen `red:` targets (`:9800`), or when they already carry a row (`:9801`), and `max_by_key` (`:9805`) then falls back to an older block. **This is the class that makes the apply-twice record non-vacuous.** A single-pass test cannot reach it at all |
| **F4** overlay row growth driven by turns | Enough passes that `decide_channel1` clears the escalation-or-cadence gate repeatedly, so `mc_channel1_appends` accumulates without bound | **Yes, and it needs no fault, but it costs turn volume.** Verified by grepping every statement touching the three overlay tables in `mc-store/src/lib.rs`: the only `DELETE`s are the host-driven `user_hints_replace_session` replace-delete (`:7754-7759`) and the lineage-descent wipe of the *target* key (`:8642-8654`), immediately undone by a copy from the source key (`:8736-8751`). No age predicate, no count cap, no byte cap. The cadence step is `max(25_000, 0.08 * tail_tokens)` tokens of newly unreduced tool output (`transform.rs:9623-9627`), so each additional row costs the fixture that much simulated growth. The oracle is a row count, which is directly observable |
| **F5** a budget or cap actually binding | A render in which a cap changes the served bytes rather than being satisfied trivially | **Partial, and the split is per cap.** *Binding today:* the user-hint fragment cap, 80 UTF-16 units (`transform.rs:113`, applied `:9096`, truncation at `:9135-9139`), which binds on the ordinary case of a real memory hit because `caveman::compress` at `Ultra` shortens without capping; and the history budget guard (`decay_render.rs:330-348`), where tier 5 renders empty (`:319-322`) so whole compartments leave m0. *Cannot bind:* `USER_HINT_TOTAL_CHAR_CAP` of 800 (`:114`), against a computed maximum of 458 UTF-16 units, which is why its record is a `unreachable` rather than a safety claim. *Not reachable today without volume:* the two 64 MiB process-global cache budgets at `transform.rs:144-145`. Four tests cover those caches (`:23364`, `:23433`, `:23466`, `:23490`) and none drives either to eviction |
| **F6** cross-render frontier state | A store whose overlay frontier, tag baseline, mint frontier or served-output fingerprint carries state from an earlier pass into the pass under test | **Yes, and it needs no fault.** The frontier is durable and readable: `overlay_watermark` (`mc-store/src/lib.rs:6508`), documented at `:6506` as "the ordinal frontier used to avoid first-applying overlays to closed turns". The asymmetry the apply-twice record turns on was verified inside one commit transaction: temporal marks are gated on `previous_frontier` (`:7526-7527`), the user hint is gated on it (`:7541-7546`), and the Channel-1 append is inserted unconditionally (`:7559-7573`). Reaching that state needs two passes and a store, not a seam. `poisoned_tag_baseline_refills_after_direct_sql_update` (`transform.rs:23433`) already establishes that a 4e test can corrupt the store directly, which is the widest form of this class |
| **F7** frozen-unit seeding, core units | A `CoreState` carrying a `strip:`, `red:`, `cav:` or reduced/sentinel frozen unit whose target block is in the measured tail or the rendered array | **Yes, and it needs no fault. This is the workhorse of the part.** `new_frozen_strip_units` (`transform.rs:10181-10339`) produces five strip classes and `apply_surface_strips` (`:10371-10458`) can collapse a whole message to one sentinel block (`:10388-10391`). Seeding one is ordinary fixture construction. The splice reads these units from `core.frozen_units`, through `FrozenUnitIndex::new(&core.frozen_units)` or a scan (`:11699-11703`). The gap it exposes is that the cross-language corpus cannot: all 12 `nudge-hygiene-golden.json` cases pass `&CoreState::default()` and an empty `&HashSet` (`tail_hygiene.rs:1049-1056`), so the metric's `red:` arm (`:508`), caveman arm (`:526`) and absent strip arm are unreachable from the fixture that exists to stop cross-language drift |
| **F7b** module-meta synthetic-pair seeding | A `ModuleMeta` carrying a frozen `synthetic_todo` pair, with or without an anchor mid | **Yes, and it needs no fault. Split out of `F7` by refinement `R1`, because seeding one does not seed the other.** The splice reads the pair from `meta.synthetic_todo` (`transform.rs:11805-11808` for the unanchored branch, `:12091-12121` for the anchored placement), which is a distinct `Option<FrozenSyntheticTodoPair>` field on `ModuleMeta` (`mc-store/src/lib.rs:2295-2299`) and not a member of `core.frozen_units`. A fixture that seeds a `strip:` unit therefore reaches none of the todo-pair records, and a fixture that seeds a pair reaches none of the frozen-unit records. Cost is the same as `F7`: ordinary fixture construction, no fault, no seam |
| **F8** cross-process and cross-language differential | The same fixed inputs rendered in two independently seeded processes, or the real Rust renderer answering a real TypeScript consumer | **Split, and the two halves differ by an order of magnitude in cost.** The *cross-process* half is cheap and available: two `cargo test` invocations, or one spawned child, gives two `HashMap` seeds, which is what the determinism record needs. The *cross-language behavioural* half does not exist. Zero of the seven integration binaries reach 4e, and the only harness in the tree that drives real Rust rendering across the boundary, `packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts`, runs in no workflow (it declares `prerequisites: ["cargo", "ck-mc", "commons", "subconscious"]` at `:108`). The one CI-gated TypeScript gate, `prompt-surface-gates.test.ts`, reads the frozen assets `prompt_surface.rs:34`/`:36` include and executes neither implementation |

Two availability caveats that cut across classes. First, `F2`'s adversarial half
and `F3`'s block-id-reconstruction half both terminate in open 4f and 4b
questions, so a test built on either proves the module's behaviour on a
hand-built input without establishing that a production route can supply it.
Second, `nudge-b-channel2-retirement-is-caller-asserted` needs
`serializer_profile == "claude-code-anthropic"`, which is settable in-crate but
which **no TypeScript sender in this repository emits** (the shipped sender emits
`opencode-aisdk`, `rust-mode-transform.ts:1339`), so the arm is drivable while
its production reachability is unresolved.

## Map

All 26 records: twelve from lens A (rendered output, tags, determinism), twelve
from lens B (the nudge overlay), and two created by refinement `R3`, which split
two records that mixed safety with bounded progress into a safety half and a
liveness half. "Non-vacuous today" means a developer can construct the required
state with the current harness. It does **not** mean the check runs anywhere; under
`F0` none of them do.

One reachability precondition is stated once rather than per row. Every render
path cited is reached from `build_output_with_tags_inner` on an ordinary
transform pass, and no renderer in scope sits behind a Cargo feature gate. The
only profile-dependent code in the part is the duplicate-id belt's two arms, and
the only `explicit-config-only` records are the two named in their rows.

### Rendered output: composition, integrity, and the two profile-dependent guards

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| render-a-composition-order-is-fixed-and-each-unit-appears-once | **None.** Any transform pass exercises it | **Yes, and it is the cheapest oracle in the part.** One pass. `out.push` happens at exactly five sites (`transform.rs:11733`, `:11754`, `:11830`, `:12089`, `:12117`), all inside straight-line control flow over `req.messages`, so the subsequence-and-no-duplicate assertion is a property of one return value. `:27150` and `:23307` already assert byte equality of whole renders, which would catch a reorder; neither asserts the ordering rule directly |
| render-a-emptied-tail-message-drops-without-a-report | A retained tail message whose blocks are all removed or emptied. Three producers: `apply_surface_strips` collapsing to an empty sentinel when `request_accepts_empty_content(req)` makes the sentinel empty (`:9890-9896`, `:10388`, `:10439`), `remove_frozen_historical_reasoning` (`:12035`), and the full-drop filter (`:12013-12023`) (F7) | **Yes.** One seeded frozen unit and one pass. The oracle is a count comparison plus a field absence: the `present` predicate is at `:12037-12039`, the `continue` at `:12085-12087`, and `BuiltOutput` (`:11001-11006`) carries `messages`, `cache_entries`, `cache_stats` and `timings` with no field for an omitted message. No fault of any kind |
| render-a-overlay-targets-stale-indices-after-full-drop-filter | One message containing a block the full-drop filter removes (`full_drop_tool_ids`, `:10839-10891`, which needs a frozen `red:` unit of kind `drop`) followed by **at least two** overlay-eligible blocks (F7) | **Yes.** This row read `Partial` until refinement `R1`, on the grounds that "whether a real harness emits that message shape depends on the 4f codecs". A typed wire fixture constructs the multi-block carrier directly, so the record is non-vacuous today: `user_carried_tool_result_pairs_with_prior_assistant_call` (`ck_wire.rs:1062-1089`, the `fn` at `:1061`) builds a `role: "user"` message carrying a `CkKind::ToolResult` block followed by a `CkKind::Text` block through `CkWireMessage::from_parts`. Two precisions belong with that. **The fixture proves test constructibility, which is what this column is about, not that a production harness emits the shape**; and the comment above the test (`:1056-1059`, cited as `:1057-1060` before this pass and corrected per METHOD.md rule 1) states the shape *as* real harness behaviour, "Claude Code emits the tool_result INSIDE the next user message ... when input arrives while a tool is still running", which is evidence for the production half rather than proof of it. The index shift itself is verified from source: `filter_map` rebuilds `content` at `:12014-12021` and the overlay at `:12024-12031` passes the same unmodified `blocks` slice. A whole-message strip collapsing `content` to one block (`:10388`) creates the same shift with a smaller footprint. Note also that the `block_index >= content.len()` guards at `:8227` and `:10400` convert the out-of-range half into a silently skipped overlay, which is a separate failure mode with the same cause |
| render-a-duplicate-tool-use-repair-is-release-only | Two `ToolCall` blocks with the same id reaching `:12147`, **plus a release build** to reach the repair at all (F1) | **Yes, and F1 is the whole cost.** The debug arm is already covered by `duplicate_tool_use_belt_panics_in_test_builds` (`:21504`, `#[should_panic]` at `:21503`) and the release arm by `:21514`, which needs only to be compiled. Running `cargo test -p mc-module --lib --release` executes it. Two duplicate ids are hand-buildable; the doc at `:11227-11230` states the normal paths must keep them unique, so this is a last-resort belt whose trigger is another path's defect. **The composition worth asserting is not either arm alone but that the two arms disagree**, which needs both invocations and a comparison |
| render-a-orphan-tool-arc-has-no-production-detection | A reduction, strip, full drop, or duplicate repair that removes one half of a tool arc (F7, or F1 for the repair path) | **Yes, and the finding is inverted from what coverage suggests.** The assertion is already applied to real render output on every whole-pass driver, because it sits inside the shared fixture driver at `:14336`. So `always(!orphan)` is the best-exercised check in 4e in test builds. What no capability on this list supplies is production presence: the gate is `#[cfg(test)]` at `:11171` and its only non-test-module call site is `#[cfg(test)]` at `:5486`, so **F1 does not help** — the assertion is in both test profiles and neither shipped one. Closing this needs a code change, not a fault. The release repair at `:11258-11277` explicitly removes an adjacent result when an owner empties, which is the same concern handled in one place |
| render-a-mint-batch-block-ids-are-unique-per-pass | `tag_mint_enabled`, plus either a duplicate projection block id or a stale tag baseline (F6) | **Yes.** This row read `Partial` until refinement `R1`, pending "whether the `mc_tags` SQLite triggers advance `generation` for *every* mutation, not only inserts". **They do**, so the deferred `mc-store` question is answered in `mc-store` and nothing external blocks the record. Three triggers exist and each sets `generation = generation + 1` on conflict: `mc_tags_cache_generation_insert` (`mc-store/src/lib.rs:972`), `..._delete` (`:981`) and `..._update` (`:995`). The update trigger does it twice, once keyed on `OLD.session_id` and once on `NEW.session_id` (`:995-1018`, cited as `:995-1017` before this pass; the trigger's `END;` is `:1018`, corrected per METHOD.md rule 1), so a cross-session move advances both sessions' generations. The duplicate-projection half remains provably impossible: `apply_once` returns `TransformError::DuplicateBlockId` at `:3354-3356`, before the mint at `:3806`. So the stale-baseline half is the whole of the record, both cached paths are fenced on the trigger-backed `generation` (`:7529`, `:7540`), and `poisoned_tag_baseline_refills_after_direct_sql_update` (`:23433`) is the nearest existing construction and the natural place to pin it |
| render-a-render-is-deterministic-over-fixed-inputs | Two independently seeded processes rendering identical `(core, meta, projection, req, overlay, tag_numbers)` (F8, cheap half) | **Yes.** Two `cargo test` invocations, or one spawned child. Every collection in the splice was audited and is ordered: `TagOverlayState` is four `BTreeMap`s (`:1722-1728`), `projection_blocks_by_mid_for_output` returns a `BTreeMap` of projection-ordered `Vec`s (`:12520-12531`), `reduced` is a `BTreeMap` (`:11924`), the nudge lists are explicitly sorted (`:9244`, `:9275`). The one order-sensitive site is `tail_hygiene.rs:364`, whose loop reads `by_arc` at `:373` and writes it at `:394`; order does not matter today because candidate arc sets are disjoint per call id, produced by `ck_wire.rs:440-451`, which is 4f. **The valuable test is not the differential but the regression pin on that disjointness**, since a 4f change can silently make a 4e render seed-dependent |

### Rendered output: tags, the hygiene metric, and the caps

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| render-a-channel2-derived-tag-numbers-name-no-durable-row | `SerializerProfile::OpencodeAiSdk` so `channel2_directives` takes the host-directive arm (`:9347-9365`), Channel-2 pressure due, and `active_tags_for_nudge` returning empty so `active_tags_for_channel2` falls through to the derived numbering (`:9293-9312`). No fault | **Yes.** Request state plus a store with no surviving tag row. The fallthrough is deliberate per the comment at `:9279-9281`, for profiles that "historically did not mint overlay tags", which is exactly the state in which no durable row exists. The rendered form is verified: `oldest_channel2_hint` (`:9534-9547`, called `:9396`) reaches `format_reclaimable_hint` (`:9866-9876`), which renders `§{tag}§ {name}` at `:9872`. What is unresolved is the *impact* half, what `ctx_reduce` does with an unresolvable number, which is 4d's surface |
| render-a-hygiene-metric-ignores-surface-strips | Any frozen unit keyed `strip:placeholder:`, `strip:system_injected:`, `strip:system_injected_block:`, `strip:stale_reduce:` or `strip:processed_image:` whose target block is inside the measured tail (F7) | **Yes, and it is the cheapest high-consequence oracle in the part.** One seeded strip unit and one `measure_tail_hygiene` call. Verified by grep that `tail_hygiene.rs` contains **no `strip:` literal anywhere**, and by reading the exclusion set at `:500-508` and the per-kind arms at `:522-587`. The consequence is amplified by a second contract source: `docs/nudge-hygiene-calibration-2026-08-16.md:10` states the replay that set the shipped bands "applied persisted drops **and strip transforms**", so the thresholds were calibrated post-strip and are applied pre-strip. **Per refinement `R4` the direction of the error is bidirectional, not one-way.** This row previously said a strip "inflates `t` and therefore depresses `severity = u/t`", which is only the untagged-or-protected case. `TailHygienePartMeasurement` sets `u_tokens: if active && !protected { tokens } else { 0 }` (`tail_hygiene.rs:265-270`), so a stripped block whose tag is active inflates **both** `t` and `u` and can raise the ratio, while a stripped block that is untagged or protected inflates `t` alone and depresses it; `hygiene_band` computes `severity = u as f64 / t.max(1)` at `:709` and ladders on it at `:710-716`, so the band can move either way. That is why the calibration mismatch cannot be absorbed by moving a threshold. `PARITY.md:291-294` names reasoning exclusion as the mechanism preventing silent severity escalation; the strip blindness is drift on the same axis in **both** directions |
| render-a-user-hint-total-cap-cannot-bind | `auto_search_active`, which is `!req.is_subagent && req.auto_search_enabled` (`:3519`) and defaults true on the wire (`:865-867`) and in the shipped producer | **Yes, and the arithmetic already settles it.** The `unreachable` claim is on the `utf16_len(wrapped) > limit` branch of `truncate_hint_to_total_cap` (`:9120-9127`), and the maximum composable hint is 458 UTF-16 units against a cap of 800: `USER_HINT_RESULT_LIMIT` is 3 (`:117`, applied `:9090`) and each fragment is capped at 80 (`:113`, applied `:9096`). So the record is provable by instrumentation on an ordinary pass, and the `debug_assert!` at `:9115` is trivially satisfied. The latent trap is the reason to pin it: raising either constant activates a path that has never executed |
| render-a-hint-fragment-cap-binds-in-a-served-render | `auto_search_active`, an authored user tail that is the last message (`:8776-8780`), no existing hint row for its block, and at least one memory search result whose caveman-compressed snippet exceeds 80 UTF-16 units (F5) | **Yes, and it is the one budget in 4e that binds in ordinary operation.** All four gates are default-on and were verified: `memory.auto_search.enabled` defaults true (`assets/magic-context.schema.json:1607-1612`, `transform.rs:865-867`), the prompt must clear 20 chars (`config.rs:40`, checked `:8806`), two non-stopword tokens must match (`:118`, checked `:8859-8862`), and the top score must clear 0.6 (`config.rs:39`, checked `:8953-8958`). The long-snippet condition is the ordinary case for a real memory hit, since `caveman::compress` at `Ultra` shortens without capping. This is a `sometimes` record; see the compliance review |
| render-a-light-surface-fallback-notice-never-served | `PromptSurfacePreset::Light`, which is not the serde default (`Full` is, `:74-76`) and so requires explicit configuration | **Yes, and it is already exercised.** `light_slots_serve_authored_guidance_and_descriptions` (`prompt_surface.rs:329`) asserts `!light.fallback` and `!tool_manifest_falls_back(..)` for both presets at `:333-342`. The `unreachable` claim is structurally guaranteed: `GUIDANCE_LIGHT_PRIMARY` (`:33-34`), `GUIDANCE_LIGHT_NO_REDUCE` (`:35-36`) and `TOOL_LIGHT_DESCRIPTIONS` (`:37`) are unconditionally `Some`, so `:141` and `:157` are always false and all four `lib.rs` consumers are dead. The remaining value is documentary: the notice text is stale, and the one CI-gated TypeScript gate validates the very assets it claims do not exist |

### The nudge overlay: the synthetic todo pair and its provenance

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| nudge-b-frozen-todo-pair-retires-only-on-a-bust | `req.todo_tool_present == Some(true)`, `meta.last_todo_state` populated, a frozen pair present, and a pass whose plan is not `Hard`, `MigrateHard` or `Soft` (`transform.rs:4435-4439`); then a second pass with a **different** visible todowrite state on the same plan (F7b + F3) | **Yes.** Two passes and seeded metadata. The seeding class is `F7b`, not `F7`: the pair is read from `meta.synthetic_todo` (`:11805-11808`), so a `CoreState` frozen unit does not enable this record. The mechanism is verified: the defer short-circuit at `injection.rs:306-312`, the `Clear` arm at `:325-331` and its only caller `transform.rs:7461`, the stale-anchor drop at `transform.rs:7495-7500`, and `capture_todo_state_on_bust` refusing on a non-bust pass (`injection.rs:212-214`) so the metadata cannot move either. The 4b-side checks `defer_never_clears_but_bust_does` (`injection.rs:600-613`) and `defer_after_capture_replays_frozen_bytes` (`:739-771`) already assert this for `advance_injection`; what is uncovered is the `transform.rs` wrapper |
| nudge-b-todo-availability-fail-open-is-unreachable | To reach the branch at all, a caller of `advance_injection` that is **not** `todo_synthesis_verdict`. None exists: `transform.rs:4155`, `:4529`, `:4826`, `:7454` are the four production sites and all four route through it | **Yes, and the `always-or-unreached` semantics is what makes it cheap.** The unreached half is a grep-plus-instrumentation assertion on an ordinary pass: assert that whenever `advance_injection` or `capture_todo_state_on_bust` is entered from production, `todo_tool_present` is `Some(_)`. `todo_synthesis_verdict` (`:2626-2630`) collapses the `Option` with `unwrap_or(false)` before it reaches the injection API. The safety half is already covered from the 4b side by tests that pass `None` directly (`injection.rs:626-644`, `:706-721`). **The live question is a documentation contradiction, not a fault:** `injection.rs:205`, `:228` and `:299` say a missing verdict fails open and `transform.rs:738-741` says it fails closed, and the code fails closed |
| nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report | One inbound `CkIngressMessage` with `meta.synthetic == false` containing a `ToolCall` or `ToolResult` whose id starts with `mc_synthetic_todo_` (F2) | **Yes for the module's behaviour; the production-route half is 4f.** One hand-built ingress message and one pass. The mechanism is verified: the force-set at `:2419`, the tail-loop exclusion at `:11842-11845`, and the overlay exclusion at `:8222-8224`. `synthetic_id_detection_is_prefix_only` (`injection.rs:906-910`) pins the prefix-only rule; nothing tests what the reclassification does to a non-module message. The benign producer is the harness replaying our own injected pair; whether any production path lets a non-module actor choose a tool-call id is a codec question and unresolved. **The consequence composes with the arc record:** a reclassified message carrying a real tool result orphans its call, which nothing in production detects |
| nudge-b-injected-todo-pair-carries-no-provider-visible-provenance | A frozen pair and `synthetic_todo_enabled` (`transform.rs:5389` passes `tail_reclaim_enabled && !req.is_subagent`). No fault (F7b) | **Yes.** One pass with a frozen pair, seeded into `meta.synthetic_todo` (`:11805-11808`) rather than into `core.frozen_units`, which is why `R1` split the seeding class. Three layers were verified, and the finding is that they disagree: CK wire carries `HarnessMeta::synthetic` (`mc-store/src/lib.rs:64-65`) so the host can always tell; the OpenCode native encoder emits `"syntheticTodoMarker": true` (`codec/opencode.rs:946`, inside `render_synthetic_todo_pair` at `:916-947`, reached from `:388`); the pi encoder emits nothing (`codec/pi.rs:582-607`) and has no production caller. In the provider array the only surviving marker is the `mc_synthetic_todo_` id prefix (`injection.rs:23`, `:139`), which nothing documents as a provenance signal, because the consumer's serializer reads `part.callID` and ignores the marker (`todo-view.ts:117-126`). Per refinement `R5` the record now claims the absence of an explicit model-facing provenance *field* rather than indistinguishability. The three text overlays are better marked and still forgeable, which is F2 |

### The nudge overlay: Channel-1, Channel-2, and the frontier

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| nudge-b-channel1-append-first-applies-without-a-frontier-gate | `tagging_active` (needs `serializer_profile` in `{opencode-aisdk, claude-code-anthropic}` plus `tool_present`, `lib.rs:568-577`, and the persisted-or-bootstrap condition at `transform.rs:3503-3504`), a hygiene baseline that fires `decide_channel1`, and the newest eligible tail tool result being one an earlier pass already served (F3 + F6) | **Yes, and this is the record F3 exists for.** Two passes plus store state, no fault. **A single-pass test is vacuous here by construction**, which is why the existing check misses it: `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire` (`:23551-23590`) exercises firing and replay, but every block it targets is newly added. The three-way asymmetry at the commit site is verified: temporal gated at `mc-store/src/lib.rs:7526-7527`, user hint gated at `:7541-7546`, Channel-1 inserted unconditionally at `:7559-7573`, against a frontier documented at `:6506` as existing "to avoid first-applying overlays to closed turns". The oracle is a set membership: assert each newly inserted row's `block_id` is absent from `loaded.meta.served_output_fingerprint` |
| nudge-b-channel1-append-rows-have-no-reaper | `tagging_active` and a session long enough for `decide_channel1` to clear the escalation-or-cadence gate repeatedly (F4) | **Yes, and the cost is turn volume rather than capability.** N firings and one count query. No `DELETE` with an age or count predicate exists for `mc_channel1_appends` or `mc_temporal_marks`, verified across every statement touching the three overlay tables. The cadence step is `max(25_000, 0.08 * tail_tokens)` (`channel1_refire_tokens`, `:9623-9626`, gate at `:9608-9610`), so the fixture must simulate that much unreduced growth per row. Per refinement `R3` this row is now the `always` count bound only; the removal half is its own record above. The ceiling the bound compares against still does not exist in the code, so the assertion is writable and the number to assert is a product decision |
| nudge-b-channel1-suppression-flag-is-never-set | A `ctx_reduce` call that applies a reduction, followed by a `tagging_active` transform pass. **The suppression cannot be observed, because nothing sets the flag** | **Yes, and the record is provable as an absence today.** `git grep reduce_suppressed` over the worktree returns six lines: the field (`mc-store/src/lib.rs:2461`), three reads (`transform.rs:9156`, `:9565`, `:9593`), one clear to `false` (`:9157`), and one write to `true` inside `#[test]` (`:23577`). So the `always` check fails on any real sequence, which is the finding. The existing test reaches the suppression effect only by writing the store directly at `:23577`. Two second-order facts make the consequence worse and are both assertable on the same fixture: the clear at `:9157` would consume a set flag on the first `tagging_active` pass, so suppression is a single-pass token; and because a compliant reduction *lowers* reclaimable tokens, the `reset_cycle` arm at `:9565-9566` fires instead and re-arms the ladder from `Gentle`. **Compliance resets the nudge cycle rather than suppressing it** |
| nudge-b-opencode-channel2-arm-has-no-module-side-latch | `serializer_profile == "opencode-aisdk"`, reclaimable tokens at or above `CHANNEL2_FLOOR_TOKENS` (50,000, `tail_hygiene.rs:17`), severity at or above 0.75 (`:18`), an empty or unrecognized `channel2_nudge_state`, and two consecutive passes with identical inputs (F3) | **Yes.** Two passes, no fault. Verified that the arm reads only `channel2_nudge_state` and pressure (`transform.rs:9347-9365`), that `channel2_pressure` takes `&ModuleMeta` and so cannot latch (`:9380-9383`), that `channel2_pressure_latched` is read and written only in the Claude Code arm (`:9484`, `:9496`), and that both module rearm helpers clear state this arm never reads (`:9407-9410`, `:9412-9433`). The delegation is deliberate per `:1524-1526`; what has no comment is the case where the host's lease write never lands, which is the case the other arm's TTL covers. **A second consequence is assertable on the same fixture: the two module rearm helpers are dead code in the shipped configuration** |
| nudge-b-channel2-retirement-is-caller-asserted | `serializer_profile == "claude-code-anthropic"`, a pending directive, and a `channel2_delivered_id` echoing an id the module issued one pass earlier | **Yes for the mechanism; the arm's production reachability is unresolved.** The profile string is settable in-crate and the mechanism is verified: the delivered-id comparison at `transform.rs:9442-9448`, the TTL at `:9450-9458` (10 minutes, `:111`), the pressure collapse at `:9479`, and the id derivation at `:9505-9513`. **No TypeScript sender in this repository emits that profile** — the shipped one emits `opencode-aisdk` (`rust-mode-transform.ts:1339`) — while `ARCHITECTURE.md:125` describes a Claude Code leg as a real deployment, so the `explicit-config-only` label rests on a deployment question this tree cannot answer. Per refinement `R3` the bounded half of this row is now its own record, below; what remains here is the permitted-transition set |
| nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl | `serializer_profile == "claude-code-anthropic"`, a pending directive armed on an earlier pass, **no** `channel2_delivered_id` on the pass under test, and a `ctx.now_ms` the fixture advances to `armed_at_ms + CHANNEL2_DIRECTIVE_LEASE_TTL_MS` (F3, plus caller-controlled time) | **Yes.** Created by refinement `R3`. Two calls to `channel2_directives`, which is a free function over borrowed inputs and a `&mut ModuleMeta`, so no store, no clock seam and no second process. `now_ms` is a parameter, which is why this liveness record needs no injectable clock unlike the sibling parts' reapers. The bound is stated in the code: `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` at `:111`, predicate at `:9454`, action `rearm_channel2_cycle` at `:9457` (defined `:9407-9410`). Verified that the deadline does not slide: `armed_at_ms` is written once at `:9492` and both replay arms return it unchanged (`:9463-9466`, `:9473-9476`). **The vacuity trap is naming the wrong retirement cause**: the test must hold pressure above the floor and severity gates, or the collapse arm at `:9479` retires the directive instead and the TTL is never evaluated, and it must supply no delivered id, or `:9447` retires it first |
| nudge-b-channel1-append-row-removal-has-no-bounded-window | `tagging_active`, one Channel-1 row, a projection advance past its target block, then N passes and silence (F4 or a direct seed) | **No — blocked, and not on a capability.** Created by refinement `R3`, and it is this map's only blocked row. The construction is cheap: `seed_channel1_append_for_test` (`mc-store/src/lib.rs:6664`, behind the `test-support` feature at `:6663`) places a row without generating cadence mass, and advancing the projection past it is request sequencing. What does not exist is the oracle. **No removal path exists to bound**: the only `DELETE`s against the three overlay tables are the host-driven `user_hints_replace_session` replace-delete (`:7754-7759`) and the lineage-descent wipe of the *target* key (`:8642-8654`), immediately undone by the copy from the source key (`:8736-8751`). So N is undefined, and METHOD.md's liveness rules forbid substituting a generous timeout for it. The honest test today is the negative one: assert the row survives for every N, which records the unbounded window rather than measuring it. Unblocking needs a product decision on the bound and possibly a row-type change, since `Channel1AppendRow` (`:2617-2621`) carries `fired_at_ms` but no ordinal |

### The nudge overlay: authorship, observability, and overlay composition

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block | **Default configuration is enough.** `auto_search_active` needs only a non-subagent request (`:3519`), and the four content gates are the default-on ones listed under the fragment-cap record | **Yes, and it needs the least of any record in the part.** One pass on default config. The append target is verified to be the user's own text block (`:8249-8250`, `append_user_hint_to_block` at `:8345-8355` pushes onto `CkKind::Text`), the envelope is the plain string `<ctx-search-hint>` (`:9111`), and the same string in ingress bytes is treated as an existing augmentation (`:8989-8997`), which proves the envelope is forgeable — that is F2 applied to this record. The injected fragments come from stored compartment bodies (`run_user_hint_lexical_search` reads only `load_compartment_candidates`, `:8863`), so the content is earlier-conversation material this turn's author did not write, delivered attributed to them alongside the instruction at `:9109` |
| nudge-b-overlay-suppression-and-firing-are-unreportable | **None.** Any `tagging_active` pass exercises it | **Yes, and it is a field-absence assertion.** One pass. `TransformTimings` (`:1144-1310`) carries `tag_mint_candidates`, `tag_mint_new` and `tag_mint_tokenized_bytes` (`:1221-1225`) and **no count field for any other overlay**; the four overlay stages contribute milliseconds only (`:1183-1187`, `:1205`, `:1213`, `:1217`), `format_pass_timing_line` (`:1317-1400`) emits those timings and no counts, and the suppression return at `:9156-9160` writes nothing. **This record is the reason most others in the part are hard to detect in production**, so it is the highest-leverage record to fix even though it is the cheapest to prove |
| nudge-b-one-block-carries-several-overlay-kinds | Two reachable combinations. On an authored user text block: a minted tag, a gap above 5 minutes so the temporal marker is non-empty (`:8172-8177`), and a hint decision with non-empty text — needs `temporal_active` (`tagging_active && ctx.temporal_awareness`, `:3525`, default on) plus `auto_search_active`. On a tool result block: a minted tag plus a Channel-1 reminder, needing a text-bearing result (`:9809-9823`) and `decide_channel1` to fire | **Yes.** One pass with the right tail shape, no fault. The four maps are independent `BTreeMap`s keyed by the same `block_id` (`:1724-1729`), all four are consulted for the same block inside one loop iteration (`:8233-8254`), and the order is fixed: tag prefix, temporal prefix, user hint, Channel-1. The maximum is three on a user text block and two on a tool result: a tool result is ineligible for the temporal marker (`:8642-8647` requires an authored user message) and for the hint (`:8789` requires `role == "user"`). This is a `sometimes` record; see the compliance review |

**Totals: 25 non-vacuous today, 0 partial, 1 blocked.**

Both halves of that line moved under this pass and the reasons differ, so they are
stated separately rather than as one recount.

**Refinement `R1` cleared both `Partial` verdicts, taking the original 24 records
to `24 non-vacuous / 0 partial / 0 blocked`.** Neither was genuinely partial.
`render-a-overlay-targets-stale-indices-after-full-drop-filter` was waiting on
whether a harness emits a multi-block user carrier, and a typed wire fixture
constructs one directly (`ck_wire.rs:1062-1089`).
`render-a-mint-batch-block-ids-are-unique-per-pass` was waiting on whether the
`mc_tags` triggers advance `generation` on every mutation, and all three triggers do
(`mc-store/src/lib.rs:972`, `:981`, `:995-1018`). So the paragraph that used to sit
here, explaining that the two `Partial` rows did not cluster on a capability because
each terminated in a question outside the sub-part, no longer describes anything:
both questions are answered, one inside 4e's own test tree and one in `mc-store`.

**Refinement `R3` then added two records, one non-vacuous and one blocked**, giving
`25 / 0 / 1` over 26. `nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl`
is constructible today because `now_ms` is a parameter.
`nudge-b-channel1-append-row-removal-has-no-bounded-window` is the map's only
blocked row, and it is blocked differently from anything else on this list: **not on
a capability but on a missing bound.** Its state is free to construct; there is
simply no removal window in the code to assert against, and inventing a timeout
would violate METHOD.md's liveness rules. That distinction matters for the leverage
ranking below, because no item on it unblocks this record.

The rest of the distribution needs naming precisely rather than celebrating,
because the reasons differ from 4d's. 4d reached 22 because its surface is
request-shaped: an argument map, a schema, a response. **4e reaches 25 because its
surface is fixture-shaped:** a `CoreState`, a frozen-unit set, a `ModuleMeta`, a
projection and a request, all constructible by hand. Eleven records need only seeded
state and one pass.

**But the binding constraints here are `F0` and `F1`, not any fault class**, and
`F1` is the difference from every prior part. 4d's 22 constructible records sat
against a suite no automation executes, which was already the worse position. 4e
is worse again: 25 constructible records against a suite no automation executes
*and* whose default profile cannot observe two of the part's behaviours or
execute one of its two profile-specific tests.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and
never constructed dynamically. Markers duplicating the two existing `sometimes`
records are deliberately absent.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `RENDER_PASS_EMITTED_A_TAIL_SUBSEQUENCE_OF_THE_REQUEST` | An accepted pass whose non-synthetic emitted elements were a subsequence of `req.messages` in the same relative order | The ordinary shape of every pass, since all five `out.push` sites (`:11733`, `:11754`, `:11830`, `:12089`, `:12117`) are straight-line over `req.messages`. It records that the campaign observed the ordering at all, not that a reorder occurred |
| `RENDER_OMITTED_A_RETAINED_TAIL_MESSAGE` | The `continue` at `:12085-12087` taken, so a retained mid produced no emitted message | Legal as written: the `present` predicate at `:12037-12039` accepts a message absent from `blocks_by_mid`. It records the omission as an input-domain fact and does not assert that the omission should have been reported |
| `RENDER_APPLIED_AN_OVERLAY_AFTER_A_FILTERED_BLOCK_INDEX` | `apply_tag_overlay_to_message` ran on a message whose `content` had been rebuilt by the full-drop `filter_map` at `:12014-12021` | A structural fact about which two stages ran on one message, true today with fully correct behaviour. The precondition of the stale-index record, stated without asserting a misattribution |
| `RENDER_OVERLAY_SKIPPED_AN_OUT_OF_RANGE_BLOCK_INDEX` | The `block_index >= content.len()` guard at `:8227` or `:10400` returned early | Legal and is the guard's purpose. It is the *other* half of the same cause, so witnessing it independently is what distinguishes a skipped overlay from a misapplied one |
| `DUPLICATE_TOOL_USE_LOCATIONS_WERE_NON_EMPTY_BEFORE_THE_BELT` | `duplicate_tool_use_locations` returned non-empty on entry to `enforce_unique_tool_use_ids` (`:11231`) | An input fact about the array reaching `:12147`. It does not assert which arm ran or that the repair was wrong. **Pair it with the marker below rather than with a duplicate-free assertion** |
| `BELT_RAN_UNDER_DEBUG_ASSERTIONS_OFF` | The pass executed with `cfg!(debug_assertions) == false`, so `:11251-11302` was the compiled arm | A build fact, legal and correct in a release artifact. Pairing it with the marker above is how the two-arm divergence becomes checkable without inducing a duplicate id in production |
| `ORPHAN_ARC_CHECK_RAN_IN_A_TEST_BUILD_ONLY` | `assert_no_orphaned_tool_arcs` (`:11171`) executed on a pass | Legal and is the guard's own `#[cfg(test)]` contract. Recording it explicitly is the antidote to the inflation in [existing-checks.md](existing-checks.md): a campaign that fires this on all 210 drivers has still proved nothing about production |
| `TAG_MINT_BATCH_COMMITTED_WITH_A_CACHED_BASELINE` | A mint batch whose `existing_tag_ids` snapshot (`:8595-8598`) came from `load_cached_tags` rather than a cold store read | Legal and is the cache's purpose. The precondition of the mint-uniqueness record, stated as a provenance fact rather than as a divergence |
| `TAG_BASELINE_CACHE_GENERATION_FENCE_REJECTED_A_HIT` | The `generation` fence at `:7529` or `:7540` invalidated a cached entry | Legal and is the fence's purpose. Witnessing it is how a campaign shows the fence was reached at all, which the mint record's confidence depends on |
| `CHANNEL2_HINT_RENDERED_A_DERIVED_TAG_NUMBER` | `active_tags_for_channel2` fell through to the derived numbering at `:9293-9312` and the number reached `format_reclaimable_hint` (`:9872`) | Legal and deliberate per the comment at `:9279-9281`. It records which numbering source the campaign used, not that the number was unresolvable |
| `HYGIENE_MEASURED_A_TAIL_CONTAINING_A_STRIP_UNIT` | `measure_tail_hygiene` (`:458-465`) ran with at least one `strip:` frozen unit whose target block was in the measured tail | An input fact about the `CoreState` handed to the metric, legal on every real pass. The precondition of the strip-blindness record, and it does not assert that `t` was wrong |
| `HYGIENE_MEASURED_A_TAIL_CONTAINING_A_CAVEMAN_UNIT` | `caveman_content` (`tail_hygiene.rs:422-429`) supplied the measured text for a block | Legal and is the render-aware path. Recording it separately is what shows the 12-case golden cannot reach it, since all 12 cases pass `&CoreState::default()` (`:1049-1056`) |
| `USER_HINT_TOTAL_CAP_WAS_EVALUATED_AND_NOT_BINDING` | `truncate_hint_to_total_cap` entered at `:9114` and returned the input unchanged | The ordinary success path, legal and correct. It is the positive precondition that makes the `unreachable` claim on `:9120-9127` meaningful, rather than asserting the branch's absence directly |
| `SYNTHETIC_TODO_PAIR_WAS_REPLAYED_ON_A_NON_BUST_PASS` | A pass with `is_bust_pass == false` that emitted a frozen pair | Legal and is the defer contract. The precondition of the retire-only-on-bust record, without asserting the bytes changed |
| `INGRESS_CARRIED_A_SYNTHETIC_NAMESPACE_TOOL_ID` | An inbound message with `meta.synthetic == false` whose `ToolCall` or `ToolResult` id began `mc_synthetic_todo_` | An input-domain fact. Legal to observe, and the benign producer is the harness replaying our own pair, so it fires on correct operation |
| `CHANNEL1_APPEND_TARGETED_A_PREVIOUSLY_SERVED_BLOCK` | A newly inserted `mc_channel1_appends` row whose `block_id` was present in `loaded.meta.served_output_fingerprint` | A fact about which block the selector chose, and today it is legal because the insert at `mc-store/src/lib.rs:7559-7573` is ungated. **This is the independent precondition of the apply-twice record and it must not be paired with an `always(!retroactive_edit)`** |
| `OVERLAY_FRONTIER_GATE_REJECTED_A_FIRST_APPLICATION` | The `previous_frontier` comparison at `mc-store/src/lib.rs:7526-7527` or `:7541-7546` suppressed a temporal mark or a user hint | Legal and is the gate's purpose. Witnessing the gated overlays alongside the ungated one is what makes the three-way asymmetry checkable without asserting a defect |
| `CHANNEL1_APPEND_COUNT_EXCEEDED_A_FIXED_THRESHOLD` | `count(mc_channel1_appends WHERE session_id = ?)` above a constant fixed in code, not derived per run | Legal: there is no cap, so any count is correct behaviour. The precondition of the no-reaper record, asserted as a count rather than as an exhaustion |
| `CHANNEL1_DECISION_RESET_ITS_CYCLE_AFTER_A_REDUCTION` | The `reset_cycle` arm at `:9565-9566` taken on a pass following a reduction that lowered reclaimable tokens | Legal as written and is the observed behaviour. It records the actual mechanism without asserting that suppression should have happened instead |
| `CHANNEL2_OPENCODE_ARM_AUTHORIZED_WITH_AN_EMPTY_NUDGE_STATE` | The host-directive arm at `:9347-9365` emitted a directive while `req.channel2_nudge_state` was empty | Legal input and the deliberate delegation per `:1524-1526`. The precondition of the no-latch record, without asserting a duplicate authorization |
| `CHANNEL2_DIRECTIVE_RETIRED_ON_A_CALLER_SUPPLIED_ID` | `:9440-9448` matched a `channel2_delivered_id` and cleared the pending directive | Legal and is the primary retirement path. The precondition of the caller-asserted record, stated without claiming the directive was undelivered |
| `CHANNEL2_DIRECTIVE_RETIRED_ON_THE_LEASE_TTL` | The TTL arm at `:9450-9458` re-armed after `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` (`:111`) | Legal and is the bounded fallback. Pairing it with the marker above is how a campaign shows both retirement causes were reached, which is what makes the corroboration gap measurable |
| `USER_HINT_APPENDED_UNAUTHORED_TEXT_TO_A_USER_BLOCK` | `append_user_hint_to_block` (`:8345-8355`) pushed onto a `CkKind::Text` block of a `role: "user"` message | Legal and is the feature. An observation about the authorship boundary, not a claim that the model was misled |
| `INGRESS_USER_BLOCK_ALREADY_CARRIED_A_HINT_ENVELOPE` | `has_stacked_user_hint_augmentation` (`:8989-8997`) returned true on an ingress block | Legal: it is how the module avoids double-appending. **It is also the proof that the envelope is forgeable from the user side**, so witnessing it is the independent precondition of the authorship record |
| `OVERLAY_DECISION_PASS_PRODUCED_NO_COUNT_FIELD` | An accepted `tagging_active` pass on which at least one overlay fired or was suppressed and `TransformTimings` (`:1144-1310`) carried no corresponding count | A structural fact about the type, true today with fully correct behaviour. The precondition of the unreportability record |

### The two existing `sometimes` records, checked against METHOD.md

Each lens produced exactly one `sometimes` record. **Both comply on semantics and
on the forbidden-pairing rule, and both share one compliance gap.** Neither is
duplicated in the table above.

- **`render-a-hint-fragment-cap-binds-in-a-served-render` complies on semantics.**
  Choosing `sometimes` over `reachable` is right for the stated reason: executing
  `one_line_fragment`'s truncation branch in a unit test proves nothing about a
  render that actually carried a truncated hint into the provider array. Its
  conjuncts are independent preconditions that hold on a correct implementation —
  a served `<ctx-search-hint>` block with a line ending in `…`, plus, on that
  same render, a balanced element, every fragment line at most
  `USER_HINT_FRAGMENT_CHAR_CAP + 2` UTF-16 units, and valid UTF-8 with no lone
  surrogate. None asserts a violation. No `always(!X)` companion exists, so the
  forbidden pairing is absent.
- **`nudge-b-one-block-carries-several-overlay-kinds` complies on semantics.** The
  conjunct — one `block_id` present in two or more of `tag_by_block_id`,
  `temporal_by_block_id`, `user_hint_by_block_id`, `channel1_by_block_id` on one
  accepted pass, and separately in three — is a legal, correct-implementation
  state. `sometimes` over `reachable` is justified in the record's own words:
  `apply_tag_overlay_to_message`'s lines execute on every tagging pass, and what
  a campaign easily misses is the operational situation of a multiply-overlaid
  block, which is where the ordering and envelope interactions live. No
  `always(!X)` companion exists.
- **The shared gap is closed, and the names are now in the records.** METHOD.md
  requires marker names to be constant and globally unique, and neither 4e record
  supplied one, unlike 4d where one of the two `sometimes` records did. Refinement
  `R2` assigned the two names this section had proposed, so `catalog.md` now carries
  `USER_HINT_FRAGMENT_TRUNCATION_SERVED` on the fragment-cap record and
  `OVERLAY_KINDS_COLLIDED_ON_ONE_BLOCK` on the multiply-overlaid-block record. Both
  are constants, both are globally unique across this catalog, and both witness a
  legal state of a correct implementation, so neither acquires the forbidden
  `always(!X)`-with-`sometimes(X)` pairing. The markers stay absent from the table
  above rather than being duplicated into it.
- **One refinement on the second record, also applied.** Its three-kind conjunct is
  bounded by construction at three, not four: a tool result is ineligible for the
  temporal marker (`:8642-8647` requires an authored user message) and for the user
  hint (`:8789` requires `role == "user"`). The record now states that maximum
  alongside the marker, so a campaign that never fires the three-way arm cannot be
  mistaken for one where four was the unreachable target.

### Anti-patterns to avoid in this part specifically

Six pairings are forbidden by METHOD.md's rule, and each is tempting here because
in this part the defect is almost always easier to name than its precondition.

- Do not pair `always(!retroactive_overlay_on_a_served_block)` with
  `sometimes(channel1_edited_a_cached_prefix)`. That marker can fire only by
  producing the retroactive edit. Assert
  `CHANNEL1_APPEND_TARGETED_A_PREVIOUSLY_SERVED_BLOCK` and
  `OVERLAY_FRONTIER_GATE_REJECTED_A_FIRST_APPLICATION` instead: two independent,
  legal facts whose conjunction is the asymmetry.
- Do not pair `always(no_duplicate_tool_use_ids_in_the_served_array)` with
  `sometimes(release_belt_removed_content)`. Assert
  `DUPLICATE_TOOL_USE_LOCATIONS_WERE_NON_EMPTY_BEFORE_THE_BELT` and
  `BELT_RAN_UNDER_DEBUG_ASSERTIONS_OFF` instead, and keep the `always` on the
  returned array. The `sometimes` form would also be profile-dependent, which
  makes a silent marker indistinguishable from a debug run.
- Do not pair `always(!orphaned_tool_arc)` with
  `sometimes(orphan_arc_reached_production)`. The second is unobservable by
  construction: the only detector is `#[cfg(test)]`. Assert
  `ORPHAN_ARC_CHECK_RAN_IN_A_TEST_BUILD_ONLY` and keep the `always` where it is,
  so the campaign records the gate's own scope rather than pretending to observe
  production.
- Do not pair `always(hygiene_t_counts_only_served_tokens)` with
  `sometimes(strip_inflated_t)`. Assert
  `HYGIENE_MEASURED_A_TAIL_CONTAINING_A_STRIP_UNIT` instead, which is a fact
  about the metric's input, and keep the `always` on the comparison. The
  divergence marker can only fire by computing the wrong number.
- Do not pair `always(injected_text_is_attributable_to_the_module)` with
  `sometimes(hint_was_misattributed_to_the_user)`. Assert
  `USER_HINT_APPENDED_UNAUTHORED_TEXT_TO_A_USER_BLOCK` and
  `INGRESS_USER_BLOCK_ALREADY_CARRIED_A_HINT_ENVELOPE` instead. Both are legal
  and both are present on a correct implementation, and the second is what proves
  the envelope is not a boundary.
- Do not pair `always(every_overlay_decision_is_reported)` with
  `sometimes(a_decision_went_unreported)`. Every decision goes unreported today,
  so the marker fires on the first pass and proves nothing.
  `OVERLAY_DECISION_PASS_PRODUCED_NO_COUNT_FIELD` is a structural fact about
  `TransformTimings` and is the honest form.

### Placement constraints on markers in this part

Five, and they differ from 4d's because this part's boundary is the served byte
array rather than a response envelope.

1. **"The render is final" is not the end of the splice.**
   `enforce_unique_tool_use_ids` runs at `:12147`, after every
   `record_output_item` call (`:11725`, `:11746`, `:11821`, `:12077`, `:12108`).
   So a marker meaning "these are the served bytes" placed at a
   `record_output_item` site is wrong in a release build: the belt can remove
   blocks and whole messages from `out` without touching `cache_entries`. Place it
   after `:12147`.
2. **A marker on a `debug_assert!` line does not exist in a release artifact.**
   All four assertion sites in 4e are `debug_assert` (`:8396`, `:9115`, `:11246`,
   `:12139`). A marker placed beside one inherits its `cfg`, so a silent campaign
   under `--release` is indistinguishable from a passing one. Markers about
   profile-dependent behaviour must be unconditional and must record
   `cfg!(debug_assertions)` as data.
3. **A marker inside `assert_no_orphaned_tool_arcs` cannot mean "production
   checked this".** The function is `#[cfg(test)]` (`:11171`) and sits inside the
   shared fixture driver (`:14336`), so such a marker would fire on all 210
   whole-pass drivers while the shipped binary checks nothing. This is the
   placement that produced the inflation in [existing-checks.md](existing-checks.md).
4. **A marker meaning "this overlay was first-applied" must sit at the store
   commit, not at the decision.** The three overlays diverge only inside one
   transaction: temporal gated at `mc-store/src/lib.rs:7526-7527`, user hint at
   `:7541-7546`, Channel-1 ungated at `:7559-7573`. A marker at `decide_channel1`
   cannot distinguish a decision that was gated from one that was not.
5. **A marker meaning "the hygiene metric saw the served tail" is false as
   stated.** `measure_tail_hygiene(projection, core, ..)` (`tail_hygiene.rs:458-465`)
   walks `projection.blocks`, not the served array, and has no strip handling. Any
   marker on that path must name the projection as its subject, or it will be
   read as evidence about bytes it never saw.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put `F7` at the
top; that is the wrong answer, because the two cheapest capabilities here unblock
**one** record between them and govern whether any other item on the list means
anything.

1. **`F0`, running the 277 existing checks in CI at all. This remains the
   prerequisite.** A workflow change and nothing else: `cargo test -p mc-module
   --lib` alongside the existing `--test lifecycle_cli` step (`ci.yml:168` at
   `76cd6f41`, `:172` at `HEAD`), or calling the `scripts/test-rust.sh` lane that
   already exists in `package.json` and that no workflow invokes. It unblocks
   **zero** new records and **protects 277 existing checks**, all of which are
   **static reach candidates rather than measured executions** per refinement `R6`:
   237 whole-pass and transitive candidates plus the 5 `nudge_formula_tests` in
   `transform.rs`, plus 35 file-local tests across the six other units. **Nothing
   else on this list
   matters until this is done,** because anything added below is added to a suite
   no automation executes. Unlike 4d there is no integration binary to fall back
   on: all seven have zero 4e content, so `--lib` is the only lane that reaches
   this scope. One blocker is named and bounded: `ci.yml:719-721` states Rust is
   absent from the e2e lanes because private `../commons` and `../subconscious`
   path-deps are not provisioned, and `ci.yml:163-164` provisions metadata-only
   stubs. Whether that constraint reaches `--lib` is an open question rather than
   a settled no.
2. **`F1`, running the same suite in release mode as well as debug. This is the
   cheapest high-value capability in the part and it is unusual, because it is a
   build flag rather than a fault or a harness.** One extra invocation,
   `cargo test -p mc-module --lib --release`, alongside the debug run. **Two
   behavioural divergences and one detection gap are invisible to a debug-only
   suite:**
   - The duplicate-id belt's release arm (`transform.rs:11251-11302`) removes
     blocks and whole messages from the served array. Its test
     (`:21514`) carries `#[cfg(not(debug_assertions))]` at `:21512` and therefore
     **does not compile under a default `cargo test`**, so it exists and has
     never run in any observed configuration.
   - A release build serves a Claude Code synthetic prefix containing a
     system-role message rather than aborting, because `:12139` is compiled out.
   - The byte-exact-inverse claim (`:8396`) and the hint total cap (`:9115`) are
     unchecked in release, and `:22619` covers the first only in test builds.

   Running both profiles is the only way to assert the composition that actually
   matters, which is that **the two arms disagree about what a duplicate does**:
   debug aborts the pass, release silently removes content and continues.
   Whichever profile ships is the only one whose behaviour was ever executed. And
   the open question this closes is not academic:
   `cargo build -p mc-module --bin ck-mc-host` carries no `--release` (`:165` /
   `:169`), so the CI artifact selects the panicking arm, while whether the
   *distributed* `ck-mc-host` does is unresolved and needs the release pipeline.
   **What `F1` explicitly does not buy: production orphan-arc detection.** That
   gate is `#[cfg(test)]` (`:11171`), so it is present in both test profiles and
   absent from both shipped ones. Closing it needs a code change.
3. **`F7`, frozen-unit seeding, which is the largest single block of value and
   needs no fault.** One seeded `strip:`, `red:` or `cav:` unit and one pass.
   **It makes four records non-vacuous, not six.** Refinement `R1` corrected that
   claim: the splice reads these units from `core.frozen_units`
   (`transform.rs:11699-11703`), and two of the six records this item used to credit
   need a synthetic todo pair on `meta.synthetic_todo` (`:11805-11808`) instead,
   which is a distinct field on `ModuleMeta` (`mc-store/src/lib.rs:2295-2299`) and a
   distinct capability, `F7b`. The four `F7` records are
   `render-a-hygiene-metric-ignores-surface-strips` (one strip unit, and the
   sharpest finding in the part because
   `docs/nudge-hygiene-calibration-2026-08-16.md:10` shows the shipped bands were
   calibrated on a post-strip tail the Rust metric cannot reproduce),
   `render-a-emptied-tail-message-drops-without-a-report`,
   `render-a-orphan-tool-arc-has-no-production-detection` (the removal half), and
   the weaker form of `render-a-overlay-targets-stale-indices-after-full-drop-filter`
   via a whole-message strip at `:10388`. The same capability closes the
   cross-language blind spot: all 12 `nudge-hygiene-golden.json` cases pass
   `&CoreState::default()` (`tail_hygiene.rs:1049-1056`), so seeding a unit into
   even one case reaches the `red:`, caveman and strip arms for the first time.
   **The correction moves attribution rather than the totals.** Both todo-pair
   records stay non-vacuous, because seeding `ModuleMeta` is exactly as cheap as
   seeding `CoreState`. What changes is what this ranking tells a reader to build
   first: one capability unblocking six records is a different instruction from two
   capabilities unblocking four and two.
4. **`F7b`, module-meta synthetic-pair seeding, which is the same cost as `F7` and
   is listed separately only because it is a separate thing to build.** One seeded
   `meta.synthetic_todo` and one pass, plus a second pass for the retirement record.
   It makes `nudge-b-frozen-todo-pair-retires-only-on-a-bust` and
   `nudge-b-injected-todo-pair-carries-no-provider-visible-provenance` non-vacuous.
   It is worth its own rung because the two records it unblocks are the part's only
   provenance findings and a fixture author reading `F7` would not discover that a
   frozen-unit fixture reaches neither.
5. **`F3` and `F6`, the two-pass tier, which is the only way three records become
   non-vacuous at all.** Request sequencing plus store state, no fault, no seam:
   render once, then render again over a block the first pass served.
   `nudge-b-channel1-append-first-applies-without-a-frontier-gate` is vacuous
   without it by construction, which is exactly why the existing check
   (`:23551-23590`) misses it — every block that test targets is newly added.
   The same shape makes `nudge-b-opencode-channel2-arm-has-no-module-side-latch`
   valid (two consecutive passes with identical inputs) and supplies the second
   half of `nudge-b-frozen-todo-pair-retires-only-on-a-bust`. It is fourth rather
   than third only because a two-pass fixture is more test-authoring work than
   seeding a unit and calling `transform` once.
6. **`F2`, forged overlay markers, which needs nothing but a hand-built ingress
   message.** Every marker in 4e is plain text, and one of them is already proved
   forgeable by the module's own code:
   `has_stacked_user_hint_augmentation` (`:8989-8997`) exists precisely because
   ingress bytes can contain `<ctx-search-hint>`. It makes
   `nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report` and the
   forgeability half of
   `nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block` valid. It
   sits fifth because the adversarial half of the first record terminates in an
   open 4f question, so a test proves the module's behaviour on a hand-built input
   without establishing that a production route can supply it.
7. **`F5`, a cap actually binding, for the one budget that binds in ordinary
   operation.** The user-hint fragment cap needs a memory hit whose
   caveman-compressed snippet exceeds 80 UTF-16 units, which is the ordinary case
   and is why the record is a `sometimes` rather than a `reachable`. It makes
   `render-a-hint-fragment-cap-binds-in-a-served-render` valid and confirms
   `render-a-user-hint-total-cap-cannot-bind` from the other side. **The two
   64 MiB cache budgets (`:144-145`) are a separate, more expensive item and are
   not covered by this:** four tests touch those caches and none drives either to
   eviction, so the eviction accounting on the only mutable process-global state
   the render depends on is unexercised, and reaching it needs volume rather than
   a fixture.
8. **`F4`, overlay row growth driven by turns.** No fault, and the oracle is a row
   count. Eighth on cost because the cadence step is
   `max(25_000, 0.08 * tail_tokens)` (`:9623-9626`), so a fixture must simulate
   that much unreduced growth per row to make accumulation visible. It makes
   `nudge-b-channel1-append-rows-have-no-reaper` valid, which after the `R3` split is
   the count bound alone. **It does not unblock
   `nudge-b-channel1-append-row-removal-has-no-bounded-window`**, and no capability
   does: that record needs a removal window stated in the code, which is a product
   decision. `F4` is also not the cheapest route to either record, since
   `seed_channel1_append_for_test` (`mc-store/src/lib.rs:6664`, behind the
   `test-support` feature) places a row without generating any cadence mass; `F4`
   remains the honest capability for the *accumulation* claim, which a seeded row
   cannot demonstrate.
9. **`F8` cross-process, the cheap half of the differential.** Two `cargo test`
   invocations, or one spawned child, gives two `HashMap` seeds. It makes
   `render-a-render-is-deterministic-over-fixed-inputs` valid across processes
   rather than only within one, which is where a seed would differ. **But the
   cheaper and more valuable form of the same concern is a regression pin, not a
   differential:** the one order-sensitive site (`tail_hygiene.rs:364`) is
   order-independent today only because `ck_wire.rs:440-451` makes candidate arc
   sets disjoint per call id, and `ck_wire.rs` is 4f. A test pinning that
   disjointness costs less than a two-process harness and guards the actual
   hazard, which is a 4f change silently making a 4e render seed-dependent.
10. **`F8` cross-language, last on cost and first on consequence.** This is the
   tension worth stating rather than hiding, and 4e's version differs from 4d's.
   4d's gap was a composition neither side tested. **4e's gap is that the frozen
   artifact both sides share has its provenance guard on the unrun leg.** The
   Rust side recomputes the fixture input hash (`tail_hygiene.rs:1035-1039`) and
   has a dedicated mutation guard (`:1099`); the TypeScript side reads the field
   and never recomputes it (`tail-hygiene-parity.test.ts:277-279`); no workflow
   regenerates the fixture and diffs it. So two JavaScript legs are gated on every
   pull request and the leg carrying the guard is gated nowhere. The **cheap half**
   is therefore `F0` and `F1` again: running the Rust suite puts the provenance
   guard under automation without writing a line of test code. The **expensive
   half** is a harness in which real Rust rendering answers a real TypeScript
   consumer, and none exists to extend: zero of the seven integration binaries
   reach 4e, and `parity-synthetic-todo.ts` runs in no workflow. The one CI-gated
   TypeScript gate, `prompt-surface-gates.test.ts`, executes neither
   implementation — it validates the assets `prompt_surface.rs:34`/`:36` include —
   so it cannot be extended into a behavioural gate either.

**Records that need a product decision rather than a harness.** No amount of test
infrastructure resolves these, and each is a live open question from at least one
lens.

- **Which build profile does the distributed `ck-mc-host` use?** This decides
  which of two materially different served-array behaviours is in production, and
  therefore which arm of `:11231-11305` is worth testing hardest. Unresolved,
  needs the release pipeline. Both lens A and lens C left it open.
- Whether the debug-versus-release split at `:11251` / `:11303` is intended as a
  *behavioural* contract or was intended as a debug-time diagnostic on top of one
  behaviour. The prose at `:11227-11230` reads as the latter; the code implements
  the former. (needs human input)
- Whether `assert_no_orphaned_tool_arcs` is `#[cfg(test)]` deliberately, on a
  cost argument. Its production sibling `enforce_unique_tool_use_ids` has a
  comparable per-pass cost and does run, so the asymmetry looks unintentional.
  (needs human input)
- Whether the nudge bands were calibrated on a tail the Rust metric cannot
  reproduce. `docs/nudge-hygiene-calibration-2026-08-16.md:10` says the replay
  applied strip transforms; `measure_tail_hygiene` does not. The report's own note
  that "any threshold adjustment requires owner sign-off" (`:39`) makes this an
  owner decision rather than a code fix. Refinement `R4` sharpens what the owner is
  deciding: because the strip error is bidirectional
  (`tail_hygiene.rs:265-270` against `:709`), **no single threshold move corrects
  it**, so the choice is between teaching the metric about strips and accepting a
  two-sided error.
- Whether `nudge-hygiene-golden.json` should carry frozen units. Adding them
  changes the fixture contract and requires regenerating from the TypeScript
  generator, so the capability at item 3 cannot be applied to the cross-language
  corpus unilaterally. (needs human input)
- Whether `protected_tags * 2` (`transform.rs:10201`) is a deliberate
  two-messages-per-tag heuristic, and whether the resulting message window is ever
  smaller than 20 tags. The served guidance promises the model 20 protected tags.
  (needs human input)
- Whether the `mc_channel1_appends` reaper should key on the overlay frontier, on
  tag retirement, or on compartment coverage. Until this is answered
  `nudge-b-channel1-append-row-removal-has-no-bounded-window` stays blocked, because
  METHOD.md's liveness rule requires the bound stated in the unit the code bounds
  and no removal window exists in the code at all. The row type constrains the
  answer: `Channel1AppendRow` (`mc-store/src/lib.rs:2617-2621`) carries
  `fired_at_ms`, so an age-keyed window is expressible today, and carries no
  ordinal, so a coverage-keyed one needs either a commit-time projection lookup or a
  schema change. Separately, the ceiling that
  `nudge-b-channel1-append-rows-have-no-reaper` compares against is also unstated,
  which is a second decision rather than the same one.
- Whether `channel1_reduce_suppressed`'s writer was removed or never written.
  `ModuleMeta` carries the field with `#[serde(default)]`
  (`mc-store/src/lib.rs:2460`), so a stored `true` from an older writer would
  still be honoured. (needs human input)
- Whether the `claude-code-anthropic` leg is live. If not, the whole Channel-2
  lease machinery, `channel2_directive_id`, the arming watermark and the lease TTL
  are unreached in the shipped configuration, which would move
  `nudge-b-channel2-retirement-is-caller-asserted` closer to `test-only`.
  Unresolved, needs deployment knowledge. (needs human input)
- Whether the `<system-reminder>` and `<ctx-search-hint>` envelopes should be a
  security boundary. They are not one today, and
  `is_system_reminder_transport_message`'s own comment concedes text shape is the
  only discriminator available (`:8525-8527`). Making them structural would change
  the provider prefix for every existing session. (needs human input)
- Why `memory-render-golden.json` is generated and unread. Either a consumer was
  removed or one was never written. Unresolved, needs the author or the history.
- Whether a never-executed test counts as `Exercised: partial`. It governs every
  `Existing check:` line in this part, and for `transform.rs:21514` the test does
  not even compile under a default `cargo test`. All three lenses, 4b, 4c, 4d and
  the scope map (`:681`) raised it, and it is unresolved.
