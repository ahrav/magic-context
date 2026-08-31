# Part 4e property catalog: rendered output, tags, and nudge overlay

Scope: sub-part 4e of `crates/mc-module`, 9,304 production lines across seven
units. `src/transform.rs:7511-12623` (5,113 lines) carries the byte-producing
splice `build_output_with_tags_inner` (`:11678-12156`), the overlay application
site (`:8208-8269`), the tag caches (`:7597-7727`) and the nudge decisions
(`:9142-9627`). The other six are `src/tail_hygiene.rs` (1,278),
`src/decay_render.rs` (849), `src/caveman.rs` (651), `src/memory_render.rs`
(538), `src/classify.rs` (490) and `src/prompt_surface.rs` (385). All seven line
counts were re-derived at `HEAD` and sum to 9,304, matching
[../part-4-module/_lenses/scope-map-and-risk-ranking.md](../part-4-module/_lenses/scope-map-and-risk-ranking.md)
at `:587-595`.

Three neighbours are cited rather than catalogued, and the reason is recorded
because the task framing named them as in-scope files. `src/injection.rs` (911)
belongs to sub-part 4b (`scope-map-and-risk-ranking.md:526`), which counts its 18
tests as its own; 4e owns where the synthetic todo pair is *placed in the served
array* (`transform.rs:11804-11833`, `:12091-12121`), not how the pair is built,
and lens B cites the file throughout on that basis. `src/ck_wire.rs` (1,279)
belongs to 4f (`:619`) and is cited only at `:440-451`, where the arc-id
assignment is what makes one 4e `HashMap` iteration order-independent. The
`lib.rs` overlay regions are split between 4a, 4c and 4d by the same map; the
only `lib.rs` sites cited below are the four consumers of `prompt_surface.rs`
exports at `:7594-7601` and `:7688-7720`, which are 4d code reading a 4e
contract. Two further neighbours are load-bearing and cited, not paraphrased: the
three overlay tables and the transform commit transaction in
`crates/mc-store/src/lib.rs` (Part 3's territory) and the two harness encoders
in `crates/mc-module/src/codec/`.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"). Method contract in [../METHOD.md](../METHOD.md).

### Reconstruction provenance

This file was rebuilt from `_lenses/` after the working tree was cleaned and the
synthesized `catalog.md` was lost. Every record below is taken verbatim from the
lens file that produced it, `_lenses/lens-a-rendered-output.md` (12 records,
`render-a-` prefix) and `_lenses/lens-b-nudge-overlay.md` (12 records,
`nudge-b-` prefix), with three mechanical adjustments and no re-derivation:
evidence links are rewritten from the lens-relative `../evidence/` to the
catalog-relative `evidence/`, field paragraphs are rewrapped to about 80
columns, and the two refinements listed under
[Refinements applied](#refinements-applied-after-the-portfolio-evaluation) are
applied. Content equality against the lens text was checked mechanically, token
by token, after rewrapping. `_lenses/lens-c-claims-and-checks.md` proposed no
records; it supplies the claims register, the debug-versus-release section, and
the check inventory that this header cites. The header, index, check-semantics
audit and relationship map were recovered from the four surviving synthesis
fragments retained under `evidence/` (`head.md`, `index.md`, `semantics.md`,
`relmap.md`).

### CI line-reference drift

Per METHOD.md rule 1 both numberings are recorded, because the workflow file
moved between the commits the lenses read. The one `mc-module` test invocation,
`cargo test -p mc-module --test lifecycle_cli`, is **`ci.yml:168` at
`76cd6f41`** and **`ci.yml:172` at `HEAD`**; both were read directly, the first
through `git show 76cd6f41:.github/workflows/ci.yml`. The build-only step above
it, `cargo build -p mc-module --bin ck-mc-host`, is `:165` at `76cd6f41` and
`:169` at `HEAD`. Inherited text may cite either. Lens A cites the build step as
`ci.yml:164-165`, which is the `run: |` block at `76cd6f41`; lens C cites `:169`,
which is the same line at `HEAD`. All of these name the same two steps. The
TypeScript sweep, `bun run test`, is `ci.yml:257` at `HEAD`, and the pi-plugin
suite runs again directly at `:317`.

Rust source references do not drift across these commits. All three lenses read
at `HEAD`, and every `transform.rs`, `tail_hygiene.rs`, `prompt_surface.rs`,
`memory_render.rs`, `injection.rs`, `mc-store`, `codec/` and `packages/` line
reference used in this catalog's own prose was read back individually at
`e447c927` during synthesis.

### Reachability provenance

Both record-proposing lenses labelled 11 of their 12 records
`default-production`, so 22 of the original 24 carried that label and 2 carried
`explicit-config-only`. The `R3` split raises the count to 26: the Channel-1
removal record inherits `default-production` from its parent and the Channel-2
lease record inherits `explicit-config-only` from its parent, giving **23
`default-production` and 3 `explicit-config-only`**. Per METHOD.md rule 4 no
preamble below repeats the claim; each record carries its own label and its own
derivation.

The `default-production` derivation is a single dispatch fact plus a default.
`build_output_with_tags_inner` is the only byte-producing splice, it carries no
`#[cfg]`, and every accepted transform pass traverses it, so the composition,
determinism, drop and index records need nothing beyond a request. The overlay
records need `tagging_active`, which requires a `serializer_profile` in
`{opencode-aisdk, claude-code-anthropic}` plus `tool_present`
(`lib.rs:568-577`) and the persisted-or-bootstrap condition at
`transform.rs:3503-3504`; the shipped host sends `opencode-aisdk`
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1339`). The
auto-search records need `auto_search_active`, which is
`!req.is_subagent && req.auto_search_enabled` (`transform.rs:3519`) and defaults
to `true` on the wire (`default_auto_search_enabled`, `:865-867`), in the shipped
producer (`rust-mode-transform.ts:2010`) and in the schema
(`assets/magic-context.schema.json:1607-1612`, `CONFIGURATION.md:682`).

The three `explicit-config-only` labels rest on a configuration that the shipped
producer does not emit, and they are not equally solid.
`render-a-light-surface-fallback-notice-never-served` needs
`PromptSurfacePreset::Light`, which is not the serde default (`Full` is,
`prompt_surface.rs:74-76`), so the label is a straightforward statement about a
config key. `nudge-b-channel2-retirement-is-caller-asserted` needs
`serializer_profile == "claude-code-anthropic"`, and no TypeScript sender in this
repository emits that string; `ARCHITECTURE.md:125` describes a Claude Code leg
as a real deployment, so the arm is presumably reached from a proxy outside this
tree. If that leg is not live the label is closer to `test-only`. Lens B recorded
that as an open question needing deployment knowledge, and it is not resolved
here. `nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl` is the
liveness half split out of that same record by `R3`, so it inherits the label and
the unresolved question with it.

## Reachability under the Rust-first decision

Framing note, added 2026-08-30. It relabels nothing. No `Reachability:` line below
is changed, and no record's content, type, or semantics is touched. It sits beside
[Reachability provenance](#reachability-provenance) above rather than replacing it.

A default install currently selects the TypeScript renderer, not this Rust
rendering path. Sub-part 5c established that, and its references hold at
`e447c927`: `transform_mode` defaults to `"ts"`
(`packages/plugin/src/config/schema/magic-context.ts:674`, inside the field
declared at `:672-677`); the resolver at
`packages/plugin/src/config/index.ts:605-611` decides the mode once and overwrites
the field at `:611`; both of that resolver's early returns demote toward `ts`
(`packages/plugin/src/config/transform-mode.ts:22-27` on compaction-off and
`:34-39` on missing user-tier consent), and only `:41` passes `rust` through. So
reaching this crate's render requires user-tier consent.

The project owner's Rust-first decision makes the Rust transform the target
architecture, and all transforms are moving to Rust. This part therefore catalogs
the path that is becoming the default. An earlier commit message inferred the
opposite, that 4e cataloged a path ordinary users do not execute and its
reachability labels needed revisiting; that inference is withdrawn in
[../README.md](../README.md).

The labels below stand as written: 23 `default-production` and 3
`explicit-config-only`, as [Reachability provenance](#reachability-provenance)
records. What changes is only what the `default-production` labels rest on. Each
was derived from a fact internal to this crate, that
`build_output_with_tags_inner` is the only byte-producing splice and carries no
`#[cfg]`, plus the `tagging_active` and `auto_search_active` conditions and their
shipped-producer defaults, and no such derivation is affected. The remaining
premise, that the crate is in the path, now rests on the target architecture rather
than on today's shipped default. A reader who needs today's shipped behaviour reads
[../part-5c-transform-ts/](../part-5c-transform-ts/).

## What this part is about

This is the code that assembles what the model finally sees. The splice
`build_output_with_tags_inner` (`transform.rs:11678-12156`) is the single
byte-producing site, the overlay application at `:8208-8269` is the single site
that edits a block the harness sent, and everything downstream of them is the
provider's prompt cache. Six facts frame the records below.

**Debug and release behave differently, and the difference is content.**
`enforce_unique_tool_use_ids` is the last transformation applied to the whole
array (`:12147`) and it contains two mutually exclusive arms, so exactly one is
compiled. A debug build panics on the `debug_assert!` at `:11246-11250` and
serves nothing; a release build runs the repair at `transform.rs:11251-11302`,
which removes the later owner and its adjacent result and drops any message the
removal empties, then returns the modified array. The paired guard is worse: the
orphan-arc pairing detection whose own doc comments state the obligations
(`:11208`, `:11221`) is `#[cfg(test)]` at `:11171`, so a shipped build has no
orphan detection at all. Any 4e property about the content of the served array
has to name the profile it holds in, and four of the five assertion sites in 4e
production code are `debug_assert!`.

**Injected content has no explicit model-facing provenance field.** State it
that way rather than as "indistinguishable", because the distinction is real up
to the last hop. Provenance survives in both encodings: `HarnessMeta::synthetic`
is serialized on the CK wire (`mc-store:64`) and the OpenCode encoder collapses
the injected todo pair into a part carrying `"syntheticTodoMarker": true`
(`codec/opencode.rs:916-947`). What breaks the chain is the consumer: its
serializer reads the call id and ignores the marker (`todo-view.ts:117-126`),
and the id format is deliberately distinctive (`:185-196`), so the only signal
that reaches the provider array is a tool-call id prefix that nothing documents
as a provenance contract. The module concedes the general shape of the problem in
its own comment at `transform.rs:8525-8527`: CK has no transport-origin field for
this case, so the narrowest safe discriminator is text shape. The three text
overlays are in the same position, and text is forgeable by ingress.

**Overlay rows have no reaper.** Two of the three overlay tables,
`mc_channel1_appends` and `mc_temporal_marks`, have no age cap, no count cap and
no byte cap, and the only `DELETE` against either is the lineage-descent wipe
that immediately re-copies the rows to the descended key. The third table in the
same family, `mc_user_hints`, does have a caller-driven reaper, which makes the
other two an omission rather than a uniform design decision.

**One overlay path can apply twice across renders.** The Channel-1 insert is not
wrapped in the `previous_frontier` comparison that gates the temporal mark and
the user hint, and nothing on that path consults `served_output_fingerprint`, so
a row can be first-applied to a block a previous render already served. That is
the one case in this part where "applied again" is not the intended replay: it
changes bytes the provider has already cached.

**A message can be dropped silently, and the one number that is reported is
wrong.** The `present` gate at `:12037-12039` omits a retained tail message whose
blocks were all emptied, and `BuiltOutput` (`:11001-11006`) has no field
recording it; the release duplicate repair reaches the same outcome from a second
producer. Separately, the tail-hygiene metric is blind to surface strips, so the
reported number understates what the render removed. The severity error is
**bidirectional**: strips inflate `t` and, when the stripped block was tool
output, `u` as well (`tail_hygiene.rs:265-272`), and `severity = u/t` with its
band ladder (`:704-712`) can therefore move either way, which is worse than a
one-directional bias because the bands were calibrated on the post-strip
measurement the code does not make.

**Six claims have no implementing code in a default production build.** Of the 25
claims in the register, claims 1, 2, 8, 10 and 13 are `NOT FOUND` outright and
claim 20 is implemented but structurally unreachable; two more, claims 5 and 6,
are enforced only in a debug build. Claims 1 and 2 do have `#[cfg(test)]`
enforcement, which is why they count as production gaps rather than absent code.

### Coverage: 277 in-crate tests, and what the number is not

State the coverage figure carefully, because its natural reading is wrong twice
over.

There are **277 in-crate checks** attributable to 4e: 237 of the 280 tests in
`transform.rs`'s flat `mod tests` are static reach candidates for 4e production
code, of which 25 name a 4e-owned symbol in their own body, plus the 5 tests in
`mod nudge_formula_tests`, plus 35 file-local tests in the six other 4e units.
**None of them runs in CI.**

The first misreading is to treat 277 as executions. These are **static reach
candidates, not measured executions**: the attribution enumerates test
attributes, resolves each to its function, brace-matches its body, and takes a
fixpoint over 115 non-test helpers, so "reach" means the test drives a pass that
must traverse the splice. No coverage instrumentation was run. The helper
fixpoint tier is unusable here for a structural reason worth keeping: it returns
190, because the shared fixture driver `run` (`:14331-14338`) transitively names
nearly every 4e symbol. Use 237 for reach and 25 for op-specific, and treat the
89-test name rule as the cheapest independent check on both.

The second misreading is to count the TypeScript lane as cover. Four TypeScript
gates touch contracts 4e implements and three of them are parallel
implementations that never execute Rust. The only CI-gated TypeScript check that
touches bytes this module serves is `prompt-surface-gates.test.ts`, and it reads
the frozen assets the Rust code `include_str!`s, so **it tests an artifact rather
than either implementation**. The one genuinely cross-language behavioural
coupling, the nudge-hygiene golden, is checked on its two JavaScript legs in CI
and on its Rust leg nowhere, and the provenance guard that would catch fixture
drift lives only in the leg CI does not run. So every `Existing check:` line
below is a local-only check, and "partial" in an `Exercised:` line means a test
exists on a developer's machine.

### Refinements applied after the portfolio evaluation

All nine of the evaluation's refinements are now applied. The first two were
applied during the reconstruction; the other seven were recovered from
[portfolio-evaluation.md](portfolio-evaluation.md), where they are numbered `R1`
through `R7`, and applied afterwards. They are named here so a reader can tell
reconstructed text from evaluated text. Every premise was re-verified against the
source at `HEAD` before the change was made, and the two line-reference
corrections that verification produced are recorded with the refinements that
carried them.

1. **`render-a-light-surface-fallback-notice-never-served` is retyped from
   reachability to safety, and its semantics change from `unreachable` to
   `always(!fallback)`.** Both of its targets are value-producing expressions
   rather than branches: `prompt_surface.rs:139-142` is the field initializer
   inside the `PromptSurfacePreset::Light` arm, and that arm does execute whenever
   the Light preset is configured, while `tool_manifest_falls_back` (`:156-158`)
   evaluates its predicate on every manifest request. What can never happen is the
   value `true`. Per METHOD.md a forbidden state with no dedicated detection point
   takes `always(!X)`, so the record now asserts the forbidden value and no longer
   claims a forbidden location.
2. **`render-a-user-hint-total-cap-cannot-bind` keeps `unreachable`, restated so
   the subject is unambiguous.** Its target is a genuine forbidden location: the
   guard at `transform.rs:9120-9122` returns early, so the truncating body at
   `:9123-9127` is entered only by falling through it, and the arithmetic says
   that cannot happen. The `Check:` line now says the truncating body is never
   entered, rather than naming the branch by its condition.
3. **`R2`: both `sometimes` records now name a marker constant.**
   `render-a-hint-fragment-cap-binds-in-a-served-render` takes
   `USER_HINT_FRAGMENT_TRUNCATION_SERVED` and
   `nudge-b-one-block-carries-several-overlay-kinds` takes
   `OVERLAY_KINDS_COLLIDED_ON_ONE_BLOCK`. Both are the names
   [fault-map.md](fault-map.md) had already proposed, so the two files now agree.
   METHOD.md's coverage-check rules require marker names to be constant and
   globally unique; both are, and both assert independent legal preconditions
   rather than the violation, so neither acquires the forbidden
   `always(!X)`-with-`sometimes(X)` pairing.
4. **`R3`: two records that mixed safety with bounded progress are split into
   four.** `nudge-b-channel1-append-rows-have-no-reaper` keeps the count bound as
   `always` safety and hands eventual removal to
   [nudge-b-channel1-append-row-removal-has-no-bounded-window](#nudge-b-channel1-append-row-removal-has-no-bounded-window).
   `nudge-b-channel2-retirement-is-caller-asserted` keeps the permitted-transition
   set as `always` safety and hands the bounded re-arm to
   [nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl](#nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl).
   Both new records are written to METHOD.md's liveness rules: the Channel-2 one
   states its bound in the unit the code bounds,
   `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` at `transform.rs:111`, enforced at
   `:9450-9458`; the Channel-1 one records that **no removal bound exists in the
   code** and proposes one rather than writing an unbounded "eventually". This is
   the part's first liveness pair and it takes the record count from 24 to 26.
5. **`R4`: `render-a-hygiene-metric-ignores-surface-strips` now states the
   severity error as bidirectional.** Its `Impact` previously said `t` and
   possibly `u` "overstate the served tail" so the gates fire on a smaller tail
   than measured, which is one direction only.
   `TailHygienePartMeasurement` sets `u_tokens: if active && !protected { tokens }
   else { 0 }` (`tail_hygiene.rs:265-270`), so a stripped block whose tag is
   active inflates both `t` and `u` while a stripped block that is untagged or
   protected inflates `t` alone, and `severity = u as f64 / t.max(1)`
   (`:709`, laddered `:710-716`) therefore moves either way.
   [What this part is about](#what-this-part-is-about) already stated the
   bidirectional form; the record now agrees with it.
6. **`R5`: `nudge-b-injected-todo-pair-carries-no-provider-visible-provenance`
   now claims only that there is no explicit model-facing provenance field.** The
   wide form, that injected content is indistinguishable at the consuming layer,
   is withdrawn: provenance survives in both encodings and the OpenCode encoder
   emits a native marker, `"syntheticTodoMarker": true` inside
   `render_synthetic_todo_pair` (`codec/opencode.rs:916-947`, the marker at
   `:946`). The chain breaks one hop later, because the consumer's serializer
   reads the call id and ignores the marker (`todo-view.ts:117-126`) and the id
   format is deliberately distinctive (`:185-196`). The slug is left unchanged:
   renaming it would break the links from the index, the relationship map, the
   evidence file and `fault-map.md` for no gain in accuracy that the restated
   `Guarantee` does not already deliver.
7. **`R6`: the 237 figure is labelled static reach candidates wherever it
   appears.** [Coverage](#coverage-277-in-crate-tests-and-what-the-number-is-not)
   already carried the relabel in full and now carries it in the sentence that
   states the number as well. The headline and the tier table in
   [existing-checks.md](existing-checks.md) carried the unlabelled number and are
   corrected there.

Two refinements are applied outside this file and are named for completeness.
`R1` splits the fault map's frozen-unit seeding class, because the splice reads
frozen units from `core.frozen_units` (`transform.rs:11699-11703`) while the
synthetic pair is read from `meta.synthetic_todo` (`:11805-11808`), a distinct
field on `ModuleMeta` (`mc-store/src/lib.rs:2295-2299`), and clears both of that
file's `Partial` verdicts. `R7` records in `existing-checks.md` that four driver
detectors disagree rather than two.

One limit remains, and it is a limit on provenance rather than on content. The
evaluation's own `portfolio-evaluation.md` did not survive the clean. Its
findings were recovered from a report of it, so the substance of all nine
refinements is present and independently re-verified while the evaluator's
reasoning, its finding order and its per-finding lens attribution are gone. `R1`
through `R7` are therefore not the evaluator's `F1` through `F7`.

### Check-semantics audit, and the disposition of the two `unreachable` records

Semantics distribution across the 26 records, after the refinements above:
`always` 20, `always(!X)` 2 (written `always(!orphan)` and `always(!fallback)`),
`always-or-unreached` 1, `sometimes` 2, `unreachable` 1. No `reachable`. Types are
**21 safety, 3 reachability, 2 liveness**. The two liveness records are the `R3`
split and both take `always` evaluated once at the end of an explicit bounded
window, which is the form METHOD.md's liveness rules require and the form Parts
4b and 4c used; neither is written as an unbounded "eventually". Lens A produced
both of the original `unreachable` records, and METHOD.md reserves that form for a
code location that must not execute, requiring `always(!X)` for a forbidden
**state** with no dedicated detection point. Each was checked against the source,
the two did not come out the same way, and the evaluation kept one and retyped the
other.

**`render-a-user-hint-total-cap-cannot-bind` is a genuine forbidden code point.**
Its `Check:` line instruments the truncating body of `truncate_hint_to_total_cap`.
The function guards at `transform.rs:9120-9122` with
`if utf16_len(wrapped) <= limit { return wrapped.to_string(); }`, so the
truncating body at `:9123-9127` is reached only by falling through that guard,
and it is a distinct location that the arithmetic says cannot execute. Lens A's
cited range `:9120-9127` spans the guard plus the body, which is accurate. The
`unreachable` semantics stand; only the wording of the target changed, from the
branch condition to the truncating body itself.

**`render-a-light-surface-fallback-notice-never-served` named two targets that
are not code points, so its semantics are now `always(!fallback)` and its type is
safety.** Both targets are value-producing expressions, not branches.
`prompt_surface.rs:139-142` is the field initializer `fallback: light.is_none()`
inside the `PromptSurfacePreset::Light` arm, and that arm **does** execute
whenever the Light preset is configured; what can never happen is the value
`true`. `tool_manifest_falls_back` (`:156-158`) likewise executes its predicate
`preset == PromptSurfacePreset::Light && TOOL_LIGHT_DESCRIPTIONS.is_none()`
(`:157`) on every manifest request and returns `false`. Both are therefore
forbidden states of a returned value, which is exactly the case METHOD.md says
takes `always(!X)`.

The record was never wrong about the underlying fact, which is why this was a
semantics correction rather than an invalidation. Genuine forbidden code points do
exist one layer up and remain available to a stronger check: the `"full"` arm of
`if prompt_surface::tool_manifest_falls_back(selection.preset)` at
`lib.rs:7594-7596` and the `"full"` arm of `if asset.fallback` at `:7712-7714` are
real branches that must not execute. Retargeting the `Check:` at those two arms
would make `unreachable` correct as written, and that option is left open rather
than taken, because it changes what the record is about: the value form asserts
that the light assets are present, and the branch form asserts that no consumer
ever serves full bytes under a light selection. The
`.then_some(LIGHT_FALLBACK_NOTICE)` calls at `:7600-7601` and `:7718` would not
work as targets either way, because
`bool::then_some` is a method call whose argument is evaluated eagerly and is not
a branch in source.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [render-a-composition-order-is-fixed-and-each-unit-appears-once](#render-a-composition-order-is-fixed-and-each-unit-appears-once) | safety | high |
| [render-a-render-is-deterministic-over-fixed-inputs](#render-a-render-is-deterministic-over-fixed-inputs) | safety | high |
| [render-a-overlay-targets-stale-indices-after-full-drop-filter](#render-a-overlay-targets-stale-indices-after-full-drop-filter) | safety | medium |
| [render-a-emptied-tail-message-drops-without-a-report](#render-a-emptied-tail-message-drops-without-a-report) | safety | high |
| [nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report](#nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report) | safety | medium |
| [render-a-duplicate-tool-use-repair-is-release-only](#render-a-duplicate-tool-use-repair-is-release-only) | safety | high |
| [render-a-orphan-tool-arc-has-no-production-detection](#render-a-orphan-tool-arc-has-no-production-detection) | safety | high |
| [render-a-mint-batch-block-ids-are-unique-per-pass](#render-a-mint-batch-block-ids-are-unique-per-pass) | safety | medium |
| [render-a-channel2-derived-tag-numbers-name-no-durable-row](#render-a-channel2-derived-tag-numbers-name-no-durable-row) | safety | medium |
| [render-a-user-hint-total-cap-cannot-bind](#render-a-user-hint-total-cap-cannot-bind) | reachability | high |
| [render-a-light-surface-fallback-notice-never-served](#render-a-light-surface-fallback-notice-never-served) | safety | high |
| [nudge-b-todo-availability-fail-open-is-unreachable](#nudge-b-todo-availability-fail-open-is-unreachable) | safety | high |
| [nudge-b-frozen-todo-pair-retires-only-on-a-bust](#nudge-b-frozen-todo-pair-retires-only-on-a-bust) | safety | high |
| [nudge-b-channel1-append-first-applies-without-a-frontier-gate](#nudge-b-channel1-append-first-applies-without-a-frontier-gate) | safety | high |
| [nudge-b-opencode-channel2-arm-has-no-module-side-latch](#nudge-b-opencode-channel2-arm-has-no-module-side-latch) | safety | high |
| [nudge-b-channel2-retirement-is-caller-asserted](#nudge-b-channel2-retirement-is-caller-asserted) | safety | medium |
| [nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl](#nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl) | liveness | high |
| [nudge-b-channel1-append-rows-have-no-reaper](#nudge-b-channel1-append-rows-have-no-reaper) | safety | high |
| [nudge-b-channel1-append-row-removal-has-no-bounded-window](#nudge-b-channel1-append-row-removal-has-no-bounded-window) | liveness | high |
| [nudge-b-injected-todo-pair-carries-no-provider-visible-provenance](#nudge-b-injected-todo-pair-carries-no-provider-visible-provenance) | safety | high |
| [nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block](#nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block) | safety | high |
| [nudge-b-channel1-suppression-flag-is-never-set](#nudge-b-channel1-suppression-flag-is-never-set) | safety | high |
| [nudge-b-overlay-suppression-and-firing-are-unreportable](#nudge-b-overlay-suppression-and-firing-are-unreportable) | safety | high |
| [render-a-hygiene-metric-ignores-surface-strips](#render-a-hygiene-metric-ignores-surface-strips) | safety | high |
| [render-a-hint-fragment-cap-binds-in-a-served-render](#render-a-hint-fragment-cap-binds-in-a-served-render) | reachability | high |
| [nudge-b-one-block-carries-several-overlay-kinds](#nudge-b-one-block-carries-several-overlay-kinds) | reachability | high |

---

## Group A: composition fidelity and silent drops

Five records on whether the served array faithfully represents the state it was
built from. The first two are the positive guarantees the cache discipline rests
on, a fixed composition order with each unit appearing once and a byte-identical
replay over fixed inputs. The other three are what the composition can lose: an
index space that three stages are allowed to shrink while the overlay still
addresses blocks by their pre-removal position, a retained tail message that
leaves the array with no field naming it, and an ingress message reclassified as
synthetic and dropped from the tail loop with no report.

### render-a-composition-order-is-fixed-and-each-unit-appears-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`historical_full_drop_replays_byte_identically_through_output_cache`
(`transform.rs:27150`) and
`tag_overlay_replays_stably_and_new_tail_gets_next_number` (`:23307`) assert
byte equality of whole renders, which would catch a duplicated or reordered
unit. Neither asserts the ordering rule directly, and neither runs in CI.
Guarantee: The served array is `m0?`, `m1?`, then the retained non-synthetic
tail in request order, with each retained unit present exactly once and the
synthetic todo pair placed at exactly one position.
Check: `always` — for every accepted pass, assert the emitted sequence's
non-synthetic elements are a subsequence of `req.messages` in the same relative
order, that no `mid` appears twice, and that the synthetic todo pair appears
exactly zero or one time. `always` because a reorder or a duplicate is wrong on
every pass, not only under an interleaving.
Fault/timing angle: None. The splice is single-threaded over borrowed inputs.
Required faults and enabling state: None. Any transform pass exercises it.
Confidence: high —
[evidence](evidence/render-a-composition-order-is-fixed-and-each-unit-appears-once.md).
Read the whole of `build_output_with_tags_inner` and confirmed `out.push`
happens at exactly five sites (`:11733`, `:11754`, `:11830`, `:12089`,
`:12117`), all inside straight-line control flow over `req.messages`.
Existing check: `transform.rs:27150`, `:23307`; both inline, neither runs in
CI.
Impact: A duplicated or reordered message is a provider-visible prefix change,
which busts the prompt cache at best and produces an invalid conversation at
worst.
Open questions:
- Can the anchored and unanchored synthetic-todo branches both fire in one
  pass? The anchored branch requires `anchor_mid.is_some()` and the unanchored
  branch requires `anchor_mid.is_none()` on the same `meta.synthetic_todo`, so
  no. Recorded as resolved in the evidence file.

### render-a-render-is-deterministic-over-fixed-inputs

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the byte-equality replay tests (`transform.rs:27150`,
`:27216`, `:23307`, `:28622`) all assert determinism across passes within one
process. Nothing asserts it across processes, which is where a `HashMap` seed
would differ.
Guarantee: Identical `(core, meta, projection, req, overlay, tag_numbers)`
renders byte-identical output, in any process.
Check: `always` — render the same fixed inputs in two independently seeded
processes and assert byte equality of the served array and of every
overlay-bearing block. `always` because a seed-dependent render busts the
prefix cache on the very next pass.
Fault/timing angle: None for the splice. The one audited order-sensitive site
is `tail_hygiene.rs:364`, whose loop body reads `by_arc` at `:373` and writes
it at `:394`.
Required faults and enabling state: To make the `tail_hygiene.rs:364` site
actually order-dependent you would need two distinct orphan raw call ids whose
single unclaimed candidate arc is the same arc. `ck_wire.rs:441-445` assigns a
singleton call's arc id as the call block's own block id and a repeated call's
arc id as `mid#call:{id}`, so all blocks in one arc carry one `tool_call_id`
and the candidate sets are disjoint. The order therefore does not matter today,
but nothing local enforces that.
Confidence: high —
[evidence](evidence/render-a-render-is-deterministic-over-fixed-inputs.md).
Audited every collection in the splice: `TagOverlayState` is four `BTreeMap`s
(`:1722-1728`), `projection_blocks_by_mid_for_output` returns a `BTreeMap` of
projection-ordered `Vec`s (`:12520-12531`), `reduced` is a `BTreeMap`
(`:11924`), the nudge lists are explicitly sorted (`:9244`, `:9275`), and every
`HashSet`/`HashMap` in the splice is used only for `contains`, `get`, or an
order-independent `any`.
Existing check: `transform.rs:27150`, `:27216`, `:23307`, `:28622`; none run in
CI.
Impact: The whole cache discipline in the module header (`transform.rs:1-16`)
rests on a replay producing identical bytes. A seed-dependent render would bust
the provider prefix cache on every process restart.
Open questions:
- None. The one `HashMap` iteration is order-independent for the reason
  recorded above; a regression test pinning the disjointness assumption would
  be cheap.

### render-a-overlay-targets-stale-indices-after-full-drop-filter

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`duplicate_tool_full_drop_replays_byte_identically_through_output_cache`
(`transform.rs:27216`) and `non_reasoning_adjacency_keeps_full_drop_mode`
(`:27131`) exercise the full-drop path, but neither constructs a message with
two overlay-eligible blocks after a dropped index.
Guarantee: Every overlay string is applied to the block whose id it was
computed for.
Check: `always` — after `apply_tag_overlay_to_message` returns, assert that for
every `(block_id, overlay_string)` the overlay applied, the receiving block's
projected id equals `block_id`. `always` because an overlay on the wrong block
misattributes content every time it happens.
Fault/timing angle: None. The hazard is a within-message index shift, not a
race.
Required faults and enabling state: One message must contain a block that the
full-drop filter removes (`full_drop_tool_ids` returns its tool id,
`:10839-10891`, which needs a frozen `red:` unit of kind `drop`) followed by at
least two overlay-eligible blocks. Whether that shape occurs is the open
question. A whole-message strip collapsing `content` to one block (`:10388`)
creates the same shift with a smaller footprint. The
`block_index >= content.len()` guards at `:8227` and `:10400` convert the
out-of-range half of the hazard into a silently skipped overlay, which is a
separate failure mode with the same cause.
Confidence: medium —
[evidence](evidence/render-a-overlay-targets-stale-indices-after-full-drop-filter.md).
The index shift is verified from source: `filter_map` rebuilds `content` at
`:12014-12021` and the overlay at `:12024-12031` passes the same unmodified
`blocks` slice. What is not established is whether a real harness emits a
message with a full-drop tool block followed by two taggable blocks.
Existing check: `transform.rs:27216`, `:27131`; neither runs in CI.
Impact: A `§N§` prefix on the wrong block breaks the tag-to-block mapping that
`ctx_reduce` resolves against, so the agent's reduce request hits content it
did not choose. The bytes are already frozen into the provider prefix by the
time it could be noticed.
Open questions:
- Can one CK message carry a full-drop tool block followed by two or more
  taggable blocks? Depends on the harness codecs, which are 4f scope.
  Unresolved, needs 4f.

### render-a-emptied-tail-message-drops-without-a-report

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing asserts the drop is observable.
Guarantee: When the render empties a retained tail message and therefore omits
it, the omission is observable to the caller.
Check: `always` — for every accepted pass, assert that the count of retained
tail mids equals the count of emitted tail messages, or else that the response
carries a field naming each omitted mid. `always` because an unreported
omission is a fidelity failure whenever it happens.
Fault/timing angle: None. It is a per-message decision inside one pass.
Required faults and enabling state: A retained tail message whose blocks are
all removed or emptied. The reachable producers are `apply_surface_strips`
collapsing to an empty sentinel when `request_accepts_empty_content(req)` makes
the sentinel the empty string (`:9890-9896`, `:10388`, `:10439`),
`remove_frozen_historical_reasoning` (`:12035`), and the full-drop filter
(`:12013-12023`).
Confidence: high —
[evidence](evidence/render-a-emptied-tail-message-drops-without-a-report.md).
Verified the `present` predicate at `:12037-12039` and the `continue` at
`:12085-12087`, and verified `BuiltOutput` (`:11001-11006`) has no field for an
omitted message.
Existing check: none.
Impact: A message the module intended to keep leaves the served context
silently. If it was an authored user message, the agent loses a directive with
no signal that it happened.
Open questions:
- Is the omission intended for every producer, or only for the strip path? The
  `present` predicate accepts a message absent from `blocks_by_mid`, which
  suggests the author's target was messages with no projected blocks, not
  messages emptied by strips. Needs the author. (needs human input)

### nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `synthetic_id_detection_is_prefix_only`
(`injection.rs:906-910`) pins the prefix-only rule. Nothing tests what
`normalize_synthetic_todo_ingress` does to a non-module message that happens to
carry such an id, and no `mc-module` lib test runs in CI.
Guarantee: A message the module removes from the served array because its
tool-call id falls in the synthetic namespace is either genuinely
module-authored, or the removal is reported.
Check: `always` — for every pass, assert that the set of mids
`normalize_synthetic_todo_ingress` marks synthetic is a subset of the mids the
module itself injected in an earlier render, or else that the response carries
a field naming each reclassified mid. `always` because silently deleting an
authored message from the provider array is wrong on every occurrence.
Fault/timing angle: None. It runs once per request at `transform.rs:3243`.
Required faults and enabling state: One inbound `CkIngressMessage` with
`meta.synthetic == false` containing a `ToolCall` or `ToolResult` whose id
starts with `mc_synthetic_todo_`. The benign producer is the harness replaying
our own injected pair. The adversarial producer is any path that lets a
tool-call id be chosen upstream.
Confidence: medium —
[evidence](evidence/nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report.md).
The mechanism is verified from source: the force-set at
`transform.rs:2414-2415`, the tail-loop exclusion at `:12126-12128`, and the
overlay exclusion at `:8222-8224`. What is not established is whether any
production path lets a non-module actor choose a tool-call id, which is a
harness codec question and therefore 4f scope.
Existing check: `injection.rs:906-910`; does not run in CI.
Impact: A whole message leaves the served conversation with no error and no
response field. If it carried a real tool result, the matching tool call
becomes an orphan, which is exactly the shape the sibling lens found has no
production detection (`render-a-orphan-tool-arc-has-no-production-detection`).
Open questions:
- Can a tool-call id reaching `decode_opencode` or `decode_pi` be chosen by
  anything other than the harness itself? Unresolved, needs 4f.
- Is the prefix check deliberately loose so that a pair frozen under an older
  hash scheme still round-trips? The comment at `transform.rs:2405` does not
  say. (needs human input)

## Group B: debug-versus-release divergence

Two records on the one function pair where the observable behaviour of the served
array depends on the build profile. `enforce_unique_tool_use_ids` panics in debug
and repairs silently in release, and each arm's test is compiled only in the
profile the other arm needs. Its sibling guard, the orphan-arc pairing check, is
`#[cfg(test)]`, so the asymmetry is that the cheaper-to-justify guard runs in
production and the one whose failure is a deterministic provider rejection does
not. Both records must state the profile they hold in, and no other record in this
part does.

### render-a-duplicate-tool-use-repair-is-release-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `duplicate_tool_use_belt_panics_in_test_builds`
(`transform.rs:21504`) covers the debug arm.
`duplicate_tool_use_belt_drops_later_owner_and_result_in_release` (`:21514`)
covers the release arm but carries `#[cfg(not(debug_assertions))]` (`:21512`),
so it does not compile under a default `cargo test`, and no `mc-module` lib
test runs in CI at all.
Guarantee: The served array contains no duplicate `tool_use` id, and the repair
that guarantees it removes only the later owner and its otherwise-orphaned
result.
Check: `always` — on every accepted pass, assert
`duplicate_tool_use_locations(&messages).is_empty()` for the returned array.
`always` because a duplicate id is a deterministic provider rejection every
time. Pair it with a coverage check asserting the independent preconditions: a
pass observed in which `duplicate_tool_use_locations` returned non-empty
*before* `:12147`, and the build profile under test.
Fault/timing angle: None. The belt runs once, at the end of the splice.
Required faults and enabling state: Two `ToolCall` blocks with the same id
reaching `:12147`. The doc comment at `:11227-11230` states the normal ingress
and render paths must keep them unique, so this is a last-resort belt whose
trigger is another path's defect.
Confidence: high —
[evidence](evidence/render-a-duplicate-tool-use-repair-is-release-only.md).
Verified the `#[cfg]` split at `:11251` and `:11303-11304`, verified the
release arm drops an emptied message at `:11297-11299`, and verified the
release test's own `#[cfg]` gate at `:21512`.
Existing check: `transform.rs:21504` (debug only), `:21514` (release only, does
not compile in a debug test run).
Impact: The two profiles disagree about what a duplicate does: debug aborts the
pass, release silently removes content and continues. Whichever profile ships
is the only one whose behaviour was ever executed, and today neither arm's test
runs in CI.
Open questions:
- Which profile does the shipped `ck-mc-host` use? `ci.yml:164-165` builds it
  without `--release`, so the CI artifact is a debug build with the panicking
  arm. Whether the distributed artifact matches is unresolved, needs the
  release pipeline.

### render-a-orphan-tool-arc-has-no-production-detection

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `assert_no_orphaned_tool_arcs` is asserted on real render
output at `transform.rs:14336` and `:27418`, `:27427`, and negatively at
`:14314`, `:14321`. All of it is inline test code that CI does not run.
Guarantee: The served array never contains a `tool_result` without a preceding
`tool_use` of the same id, and never a `tool_use` whose result is not in the
same or the next message.
Check: `always(!orphan)` — assert the pairing condition over the emitted array.
`always(!X)` and not `unreachable`, because the forbidden thing is a state of
the output array and there is no production code point that must not be
entered; per METHOD.md the `unreachable` form is only for a code location.
Fault/timing angle: None.
Required faults and enabling state: A reduction, strip, full drop, or duplicate
repair that removes one half of a tool arc. `split_coverage_tool_arcs`
(`:10545-10617`) and `projection_reasoning_ineligible_arc_ids` exist
specifically to keep arcs intact, and the release duplicate repair at
`:11258-11277` explicitly removes an adjacent result when the owner empties,
which is the same concern handled in one place.
Confidence: high —
[evidence](evidence/render-a-orphan-tool-arc-has-no-production-detection.md).
Verified `#[cfg(test)]` at `:11171` on the function and at `:5486` on the only
call site outside the test module, and grepped every reference.
Existing check: `transform.rs:5486-5487` (test builds only), plus the
test-module assertions listed above.
Impact: An orphaned arc is a deterministic provider 400 for the whole session
until the array changes. In production nothing detects it, so the first signal
is the provider error.
Open questions:
- Is the guard test-only deliberately, on the argument that its cost is
  O(messages × blocks) per pass? The sibling `enforce_unique_tool_use_ids` runs
  in production with a comparable cost, so the asymmetry looks unintentional.
  Needs the author. (needs human input)

## Group C: tag numbering authorities

Two records about a `§N§` the agent cannot resolve, approached from opposite
directions. The first is the property expected to hold, that a mint batch never
carries a duplicate or already-durable `block_id`, which is what makes the durable
numbering trustworthy and what closes half of a sibling part's open question. The
second is a deliberately process-local numbering that reaches agent-visible bytes,
so a rendered directive can name a number no `mc_tags` row holds. Both read the
same table, so one fixture that renders a pass and reads `mc_tags` back serves
both.

### render-a-mint-batch-block-ids-are-unique-per-pass

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`tag_baseline_cache_matches_cold_passes_across_drop_reset_and_remint`
(`transform.rs:23364`) and
`tag_baseline_cache_keeps_interleaved_sessions_isolated` (`:23466`) cover the
baseline paths. Nothing asserts uniqueness of `block_id` within one mint batch.
Guarantee: A single tag-mint batch never contains the same `block_id` twice,
and never contains a `block_id` that already has a durable `mc_tags` row.
Check: `always` — before the commit, assert `tag_mint_work.inputs` has distinct
`block_id`s and that none of them is present in the store's `mc_tags` for this
session. `always` because the store's skip branch desynchronises every later
number in the batch whenever it fires.
Fault/timing angle: The in-memory numbering at `:8029-8035` and the store's
per-row numbering are separated by the whole pass; the `row_version` CAS closes
the concurrent-writer window. The residual window is logical: whether the
batch's `existing_tag_ids` snapshot (`:8595-8598`) matched the store.
Required faults and enabling state: `tag_mint_enabled`, plus either a duplicate
projection block id or a stale baseline. The first is impossible: `apply_once`
returns `TransformError::DuplicateBlockId` at `:3354-3356`, before the mint at
`:3806`. The second requires `load_cached_tags` to serve rows whose block-id
set differs from the store's; both cached paths are additionally fenced on the
trigger-backed `generation` (`:7529`, `:7540`), which a delete-and-reinsert
advances even when count and max are unchanged.
Confidence: medium —
[evidence](evidence/render-a-mint-batch-block-ids-are-unique-per-pass.md).
Verified the projection guard, the mint loop's non-updating filter, and both
generation fences. Not verified: that the SQLite triggers advance `generation`
for *every* `mc_tags` mutation, which is `mc-store` and outside 4e.
Existing check: `transform.rs:23364`, `:23466`; neither runs in CI.
Impact: This is the enabling condition for the sibling record
[`speculative-tag-numbering-has-two-authorities`](../../part-4b-transform/catalog.md#speculative-tag-numbering-has-two-authorities).
If it holds, that record's divergence is unreachable through the public path;
if the generation trigger has a gap, it is reachable.
Open questions:
- Do the `mc_tags` SQLite triggers advance `generation` on delete and on
  update, not only on insert? Unresolved, needs an `mc-store` read.

### render-a-channel2-derived-tag-numbers-name-no-durable-row

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `nudge_formula_tests` (`transform.rs:9628-9783`) covers
the band arithmetic, not the hint's tag numbers.
Guarantee: Every `§N§` a nudge or directive renders names a tag number the
agent can use, meaning one that a `mc_tags` row holds for the block the text is
pointing at.
Check: `always` — whenever `format_reclaimable_hint` produces a non-empty
string, assert each rendered `N` matches a durable `mc_tags.tag_number` for
this session. `always` because a directive naming a non-existent handle is
wrong every time it is rendered.
Fault/timing angle: None.
Required faults and enabling state: `SerializerProfile::OpencodeAiSdk` (so
`channel2_directives` takes the host-directive arm at `:9347-9365`), Channel-2
pressure due, and `active_tags_for_nudge` returning empty so
`active_tags_for_channel2` falls through to the derived numbering at
`:9293-9312`. The comment at `:9279-9281` says that fallthrough is deliberate
for profiles that "historically did not mint overlay tags", which is exactly
the state in which no durable row exists.
Confidence: medium —
[evidence](evidence/render-a-channel2-derived-tag-numbers-name-no-durable-row.md).
Verified the derived numbering, verified it reaches `oldest_channel2_hint`
(`:9396`) and `format_reclaimable_hint` (`:9872`), and verified the rendered
form is `§N§ tool`. Not verified: what `ctx_reduce` does with a tag number that
has no row, which is 4d's surface.
Existing check: none.
Impact: The agent is told to reduce `§3§` when no `§3§` exists, so a compliant
`ctx_reduce` either no-ops or resolves to a different block. The second is a
misattributed reduction.
Open questions:
- Does `ctx_reduce` reject an unresolvable tag number or silently resolve it?
  `parse_tag_range_string` is `lib.rs:15165-15210`, which is 4d scope.
  Unresolved, needs 4d.

## Group D: documented paths the build makes unreachable

Three dead paths with three different keepers: a computed maximum of 458 UTF-16
units against a cap of 800, two `Option` constants that are unconditionally
`Some`, and a normalizing wrapper that collapses an `Option` before the documented
fail-open branch can see it. The grouping earns its place because a reviewer
reading them together sees one failure mode three times, a comment or a constant
describing behaviour the build forbids with a `debug_assert!` or a doc comment as
the only witness. The third is the most dangerous, because its documentation would
tell a future caller to manufacture a synthetic tool call without host authority.

### render-a-user-hint-total-cap-cannot-bind

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — `user_hint_query_keeps_terms_beyond_the_old_character_cap`
(`transform.rs:23128`) covers the query path, not the render cap.
Guarantee: `truncate_hint_to_total_cap` is never entered from
`render_user_hint`, because the composed hint cannot exceed
`USER_HINT_TOTAL_CHAR_CAP`.
Check: `unreachable` — instrument the truncating body of
`truncate_hint_to_total_cap` (`:9123-9127`, entered only by falling through the
guard at `:9120-9122`) and assert the truncating body is never entered.
`unreachable` and not `always`, because the subject is a specific code location
that the arithmetic says cannot execute.
Fault/timing angle: None.
Required faults and enabling state: `auto_search_active`, which is
`!req.is_subagent && req.auto_search_enabled` (`:3519`) and defaults to `true`
on the wire (`default_auto_search_enabled`, `:865-867`) and in the shipped
producer
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2010`).
Confidence: high —
[evidence](evidence/render-a-user-hint-total-cap-cannot-bind.md). Computed the
maximum: 18 (`<ctx-search-hint>\n`) + 44 (three-fragment header) + 1 + 3 × 82 +
2 + 1 + 127 (footer) + 19 = 458 UTF-16 units against a cap of 800.
`USER_HINT_RESULT_LIMIT` is 3 (`:117`, applied `:9090`) and `one_line_fragment`
caps each fragment at 80 UTF-16 units (`:113`, applied `:9096`, enforced
`:9132-9139`).
Existing check: none. The only guard is the `debug_assert!` at `:9115`, which
is trivially satisfied.
Impact: A dead truncation path plus a `debug_assert` that can never fail. It is
also a latent trap: raising `USER_HINT_RESULT_LIMIT` or the fragment cap
silently activates a path that has never executed.
Open questions:
- Is `truncate_hint_to_total_cap` reachable from any other caller? Grep found
  only `:9114`. Recorded as resolved in the evidence file.

### render-a-light-surface-fallback-notice-never-served

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: yes — `light_slots_serve_authored_guidance_and_descriptions`
(`prompt_surface.rs:329`) asserts `!light.fallback` and
`!tool_manifest_falls_back(..)` for both presets at `:333-342`.
Guarantee: No served prompt surface or guidance response carries
`LIGHT_FALLBACK_NOTICE`, and no `light` selection silently serves `full` bytes.
Check: `always(!fallback)` — whenever a prompt-surface manifest or guidance
response is produced, assert `guidance_asset`'s `fallback` field is false
(`prompt_surface.rs:139-142`) and `tool_manifest_falls_back(preset)` returns
false (`:156-158`), so no served response carries `LIGHT_FALLBACK_NOTICE`.
`always(!fallback)` and not `unreachable`, because both targets are
value-producing expressions that do execute under the Light preset: what the
`Option` constants at `:33-37` forbid is the value `true`, not the location,
and per METHOD.md a forbidden state with no dedicated detection point takes
`always(!X)`. If either value is ever true, the light assets were dropped from
the build.
Fault/timing angle: None.
Required faults and enabling state: `PromptSurfacePreset::Light`, which is not
the serde default (`Full` is, `:74-76`), so it requires explicit configuration.
That is the basis for the `explicit-config-only` label. The consumers are
`lib.rs:7594-7601` (`handle_prompt_surface_manifest_value`) and
`lib.rs:7688-7720` (`handle_guidance_value`).
Confidence: high —
[evidence](evidence/render-a-light-surface-fallback-notice-never-served.md).
Verified `GUIDANCE_LIGHT_PRIMARY`, `GUIDANCE_LIGHT_NO_REDUCE` and
`TOOL_LIGHT_DESCRIPTIONS` are unconditionally `Some` at `:33-37`, and that
`docs/specs/prompt-surface/light-mapping.md` maps every `compressed`-applicable
checklist rule to a named line in the shipped light asset.
Existing check: `prompt_surface.rs:329-342`; does not run in CI.
Impact: Low on its own. It matters as a documentation artifact: the notice text
says light assets "are not available yet", which is stale, and a reader who
trusts it will conclude the light preset is inert when the mapping document and
the assets show it is not.
Open questions:
- None.

### nudge-b-todo-availability-fail-open-is-unreachable

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`provisional_verdict_keeps_capture_and_composition_fail_open`
(`injection.rs:626-644`) and `aged_out_todowrite_injects_from_module_meta`
(`:706-721`) both pass `None` directly to the injection API and assert the
fail-open behaviour. No test drives that behaviour through
`todo_synthesis_verdict`, and none runs in CI.
Guarantee: The injection API's documented fail-open-on-missing-verdict path
either is reachable from a production request, or the documentation is
corrected.
Check: `always-or-unreached` — assert that whenever
`advance_injection`/`capture_todo_state_on_bust` are entered from a production
call site, `todo_tool_present` is `Some(_)`; and separately assert that when it
is `None` the fail-open branch is safe. `always-or-unreached` is the right
semantics because the branch is a documented optional path that may
legitimately never execute, but must be correct if a future call site does
reach it.
Fault/timing angle: None.
Required faults and enabling state: To reach the branch at all, a caller of
`advance_injection` that is not `todo_synthesis_verdict`. None exists today
(`transform.rs:4155`, `:4529`, `:4826`, `:7454` are the four production sites
and all four route through it).
Confidence: high —
[evidence](evidence/nudge-b-todo-availability-fail-open-is-unreachable.md).
Verified `todo_synthesis_verdict` at `transform.rs:2626-2630`, enumerated its
four production callers by grep, and verified the shipped host always sends a
boolean (`rust-mode-transform.ts:1945-1951`, `:2023-2024`,
`resolveCombinedTodowriteVerdict` returns `Promise<boolean>` at `:141-171`).
Existing check: `injection.rs:626-644`, `:646-659`, `:706-721`; none run in CI.
Impact: Low as a live bug, high as a maintenance trap. Three doc comments in
`injection.rs` describe behaviour the crate cannot exhibit and that a fourth
doc comment in `transform.rs` explicitly forbids. A future caller that trusts
the `injection.rs` wording would manufacture a synthetic tool call without host
authority, which is precisely what `transform.rs:739-741` says must never
happen.
Open questions:
- Which of the two doc comments is the intended contract? Fail-closed is what
  ships and is the safer reading; the `injection.rs` wording is at minimum
  stale. (needs human input)

## Group E: overlay lifecycle and retirement

Five records on when an injected thing stops. The synthetic todo pair is the
control: it has a retirement rule that actually holds, and it is the only injected
thing whose absent placement is a hard error rather than an absorbed skip. Against
it sit a Channel-1 insert with no first-apply gate, an OpenCode Channel-2 arm that
writes no module state at all so the two module rearm helpers clear fields it
never reads, and a Claude Code arm whose retirement is asserted by the caller
echoing an id the response already handed it. The arm with the protocol is the arm
nothing in this tree exercises. The fifth record is the bounded half of that last
one, split out under `R3`: the lease TTL is the only retirement cause the module
can reach on its own, which makes it the one bounded-progress obligation in this
group and the load-bearing safety mechanism on the arm.

### nudge-b-frozen-todo-pair-retires-only-on-a-bust

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `defer_never_clears_but_bust_does`
(`injection.rs:600-613`) and `defer_after_capture_replays_frozen_bytes`
(`:739-771`) assert exactly this for `advance_injection`. Neither covers the
`transform.rs` wrapper, and no `mc-module` lib test runs in CI.
Guarantee: A frozen synthetic todo pair changes or disappears only on a
cache-busting pass; on a defer pass its bytes are replayed verbatim.
Check: `always` — for every pass with `is_bust_pass == false`, assert
`meta.synthetic_todo` before the pass equals `meta.synthetic_todo` after it,
and that the two emitted synthetic messages are byte-identical to the previous
render's. `always` because a defer pass that mutates the pair rewrites a prefix
the provider has already cached, which is wrong on every occurrence.
Fault/timing angle: The window is one pass. The hazard is a plan
misclassification, not an interleaving.
Required faults and enabling state: `req.todo_tool_present == Some(true)`,
`meta.last_todo_state` populated, a frozen pair present, and a pass whose plan
is not `Hard`, `MigrateHard`, or `Soft` (`transform.rs:4435-4439`). Then a
second pass with a *different* visible todowrite state on the same plan.
Confidence: high —
[evidence](evidence/nudge-b-frozen-todo-pair-retires-only-on-a-bust.md).
Verified the defer short-circuit at `injection.rs:306-312`, the `Clear` arm at
`:325-331` and its only caller `transform.rs:7461`, and the stale-anchor drop
at `transform.rs:7495-7500`. Verified that `capture_todo_state_on_bust` also
refuses on a non-bust pass (`injection.rs:212-214`), so the metadata cannot
move either.
Existing check: `injection.rs:600-613`, `:739-771`, `:585-598`; none run in CI.
Impact: A defer pass that swapped the pair would change bytes mid-prefix,
busting the provider prompt cache and, on Anthropic, presenting a tool result
the model never asked for at a position it has already reasoned past.
Open questions:
- The stale-anchor arm at `transform.rs:7495-7500` drops the pair on a *bust*
  when the anchor vanished without a coverage move. Can the same vanish happen
  on a defer pass, where `reanchor_kept_synthetic_todo_if_folded_or_shrunk` is
  not called (`:7462-7470`)? If so the render then fails with
  `SyntheticTodoAnchorMissing` (`:12125-12132`) rather than dropping.
  Unresolved, needs a pass-plan trace.

### nudge-b-channel1-append-first-applies-without-a-frontier-gate

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`transform.rs:23551-23590`) exercises firing and replay, but every block it
targets is newly added, so it never constructs the previously-served case. It
does not run in CI.
Guarantee: An overlay is first-applied only to a block that no earlier render
has served, so an accepted pass never rewrites bytes already in the provider
prefix.
Check: `always` — for every accepted pass, assert that each newly inserted
overlay row's `block_id` is absent from
`loaded.meta.served_output_fingerprint`. `always` because a retroactive prefix
edit is a cache-correctness failure on every occurrence, not only under a race.
Fault/timing angle: None strictly required. The interesting window is a defer
pass, where the pass is contractually not supposed to change replayed bytes at
all.
Required faults and enabling state: `tagging_active` (needs
`serializer_profile` in `{opencode-aisdk, claude-code-anthropic}` and
`tool_present`, `lib.rs:568-577`, plus the persisted-or-bootstrap condition at
`transform.rs:3503-3504`); a hygiene baseline that fires `decide_channel1`; and
the newest eligible tail tool result being one an earlier pass already served.
The last condition is constructible: newer tool results are excluded when their
output is JSON (`tool_result_can_carry_channel1`, `:9809-9823` rejects `Json`,
`ErrorJson`, `ExecutionDenied`), when they are frozen `red:` targets (`:9799`),
or when they already carry a row (`:9800`), and `max_by_key` (`:9804`) then
falls back to an older block.
Confidence: high —
[evidence](evidence/nudge-b-channel1-append-first-applies-without-a-frontier-gate.md).
Verified the three-way asymmetry at the commit site: temporal gated at
`mc-store/src/lib.rs:7526-7541`, user hint gated at `:7541-7546`, Channel-1
ungated at `:7559-7573`. Verified the frontier's stated purpose at
`:6506-6507`. Verified `is_tail` admits a served block
(`transform.rs:6471-6473`, used at `:9798`), and that
`refresh_tail_hygiene_baseline` keeps the baseline evaluable on a non-busting
refresh (`tail_hygiene.rs:665-682`), so the firing pass need not be a bust.
Existing check: `transform.rs:23551-23590`; does not run in CI.
Impact: A `<system-reminder>` appears inside a tool result the provider has
already cached, so the prefix diverges and the whole cached prompt is
discarded. On the divergence path this also shows up as a served-fingerprint
mismatch (`transform.rs:5513-5520`), which is a report of the symptom, not a
prevention.
Open questions:
- Is the missing gate deliberate on the grounds that Channel-1 only ever
  targets a fresh tool result? The selector does not encode that assumption,
  and the three fallback conditions above defeat it. (needs human input)
- Does the served-output divergence record (`divergence::first_divergence`,
  `:5513`) actually fire for this case, and is it surfaced anywhere an operator
  reads? Unresolved, needs `divergence.rs`, which is 4b/4c scope.

### nudge-b-opencode-channel2-arm-has-no-module-side-latch

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `nudge_formula_tests` (`transform.rs:9629-9783`) covers
the band arithmetic only. No test drives `channel2_directives` twice with the
same inputs on the OpenCode arm.
Guarantee: A Channel-2 authorization is emitted at most once per arming cycle,
so a repeated render does not re-authorize an injection the host has already
performed.
Check: `always` — for two consecutive passes with identical inputs and a
`channel2_nudge_state` the caller did not change, assert the second pass
returns `host_directives == None`. `always` because a duplicate authorization
is wrong on every occurrence. Pair it with a coverage check on the independent
preconditions: `SerializerProfile::OpencodeAiSdk`,
`channel2_pressure(..).due == true`, and `req.channel2_nudge_state.is_empty()`.
Fault/timing angle: The window is any pass sequence in which the host's lease
write does not land before the next transform: a crashed host between the
response and its `setChannel2NudgeState`, a lost response, or a caller that
simply never implements the field.
Required faults and enabling state: `serializer_profile == "opencode-aisdk"`,
reclaimable tokens at or above `CHANNEL2_FLOOR_TOKENS` (50_000,
`tail_hygiene.rs:17`), severity at or above 0.75 (`:18`), and an empty or
unrecognized `channel2_nudge_state`.
Confidence: high —
[evidence](evidence/nudge-b-opencode-channel2-arm-has-no-module-side-latch.md).
Verified the arm reads only `channel2_nudge_state` and pressure
(`transform.rs:9347-9365`), that `channel2_pressure` takes `&ModuleMeta` and so
cannot latch (`:9380-9383`), that `channel2_pressure_latched` is read and
written only in the Claude Code arm (`:9483`, `:9493`), and that both module
rearm helpers clear state this arm never reads (`:9407-9410`, `:9412-9433`).
Verified the shipped host sends `opencode-aisdk`
(`rust-mode-transform.ts:1339`) and owns the lease and its stale-claim reaper
(`storage-meta-persisted.ts:1132-1146`, `storage-db.ts:586-596`).
Existing check: none on the Rust side. The host side has
`packages/plugin/src/hooks/magic-context/channel2-delivery.test.ts`.
Impact: On the profile that actually ships, the module's idempotence for
Channel-2 is entirely delegated to the caller with no verification and no
fallback. A caller that never sets the field gets a `<system-reminder>`
injected on every pass while pressure is high, which is the nagging failure
mode the arming watermark exists to prevent on the other arm. It also means the
two module rearm helpers are dead code in the shipped configuration, which is a
maintenance hazard: a reader sees a rearm protocol that is not wired up.
Open questions:
- Is the delegation deliberate, with the module treating the OpenCode host as
  the sole lease owner? The comment at `transform.rs:3509-3511` says tags are
  kept available on non-CC profiles so "the OpenCode host can receive the same
  ceiling decision", which reads as deliberate. It does not address the missing
  latch. (needs human input)
- The host clears a `pending` lease pre-delivery only when it authored the text
  itself; a module-supplied `directiveText` deliberately skips revalidation
  (`channel2-delivery.ts:155-166`). Can a module-authored `pending` wedge? Host
  scope. Unresolved.

### nudge-b-channel2-retirement-is-caller-asserted

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test drives `claude_code_channel2_directive` with a
`channel2_delivered_id`.
Guarantee: A pending Channel-2 directive is retired only when it was actually
delivered, or by one of two other causes the module itself can name.
Check: `always` — assert that `meta.pending_channel2_directive` transitions to
`None` only via a matching `channel2_delivered_id`, the lease TTL, or a
pressure collapse, and that no other input clears it. `always` because a
directive retired without delivery is silently lost every time it happens. The
TTL appears here only as a permitted cause of the transition; that it *fires*
within a bound is bounded progress and belongs to
[nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl](#nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl),
split out under `R3` so this check carries no liveness half.
Fault/timing angle: The retirement is a same-pass decision. Inside the lease
window only the caller's word retires the directive, which is what makes the
corroboration gap this record's subject; what happens at the window's edge is the
liveness record's subject.
Required faults and enabling state:
`serializer_profile == "claude-code-anthropic"`. This is the reason for the
`explicit-config-only` label: the string appears in `crates/mc-module` tests,
in `ARCHITECTURE.md:125`, and in the profile-epoch table (`lib.rs:552`), but no
TypeScript sender in this repository emits it. The only shipped sender emits
`opencode-aisdk` (`rust-mode-transform.ts:1339`). `ARCHITECTURE.md:125`
describes a CC leg as a real deployment, so the arm is presumably reachable
from a proxy outside this tree.
Confidence: medium —
[evidence](evidence/nudge-b-channel2-retirement-is-caller-asserted.md). The
mechanism is verified from source: the delivered-id comparison at
`transform.rs:9440-9448`, the TTL at `:9450-9458`, the pressure collapse at
`:9479`, and the id derivation at `:9505-9513`. What is not established is
whether the CC leg is live and, if so, whether the proxy has an independent
record of delivery. Both are outside this tree.
Existing check: none.
Impact: A caller can retire a directive it never delivered by echoing an id the
module handed it one pass earlier, and the agent then never sees the
housekeeping warning for that cycle. The TTL bounds the damage to one arming
cycle, which is the right shape; the concern is that the primary retirement
path has no corroboration at all.
Open questions:
- Is the CC leg live? If not, this whole arm plus `channel2_directive_id`, the
  arming watermark, and the lease TTL are unreached in the shipped
  configuration, which would change the label to something closer to
  `test-only`. Unresolved, needs deployment knowledge. (needs human input)
- The `arming_watermark` is monotonic per session (`:9489-9494`) and the id is
  a hash over `(session_id, watermark)`. Is the watermark ever exposed so an id
  could be predicted before it is issued? Not from the transform response,
  which only carries the id itself. Recorded as resolved in the evidence file.

### nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl

Type: liveness
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test advances `now_ms` past the lease and asserts the
re-arm. Step 4 of the parent record's evidence file names the construction and
nothing implements it.
Guarantee: A pending Channel-2 directive that the caller never acknowledges stops
being pending within one lease interval, so a lost directive costs at most that
interval plus one arming cycle rather than wedging the arm forever.
Check: `always` evaluated once at the end of an explicit bounded window — arm a
directive, supply no `channel2_delivered_id` and no pressure change, advance
`ctx.now_ms` to `armed_at_ms + CHANNEL2_DIRECTIVE_LEASE_TTL_MS`, call
`channel2_directives` once more, then assert `meta.pending_channel2_directive` is
`None` and `meta.channel2_pressure_latched` is `false`. The bound is
`CHANNEL2_DIRECTIVE_LEASE_TTL_MS`, 10 minutes at `transform.rs:111`, which is the
unit the code actually bounds: the predicate is
`now_ms.saturating_sub(pending.armed_at_ms) >= CHANNEL2_DIRECTIVE_LEASE_TTL_MS`
(`:9454`) and the only action on it is `rearm_channel2_cycle(meta)` (`:9457`).
Stating it in milliseconds of the caller-supplied clock rather than as an
"eventually" is what METHOD.md's liveness rules require, and a generous timeout
would not distinguish one re-arm from a thousand.
Fault/timing angle: The window is the lease. The fault is the absence of an
acknowledgement, and the fault-free part of the window is that nothing else
touches the directive: the pressure aggregate must stay above the gates, or the
collapse arm at `:9479` retires it for a different reason and the test proves
nothing about the TTL.
Required faults and enabling state:
`serializer_profile == "claude-code-anthropic"`, a pending directive armed on an
earlier pass, no `channel2_delivered_id` on the pass under test, and a `ctx.now_ms`
the fixture controls. All four are reachable from a direct call to
`channel2_directives`, which is a free function over borrowed inputs and a
`&mut ModuleMeta`. The profile is the reason for the `explicit-config-only` label
and it is inherited from the parent record, along with the unresolved question
about whether the leg is live.
Confidence: high —
[evidence](evidence/nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl.md).
The mechanism is verified from source: the TTL arm at `:9450-9458`, its predicate
at `:9454`, `rearm_channel2_cycle` at `:9457` (defined `:9407-9410`, clearing both
`pending_channel2_directive` and `channel2_pressure_latched`), the constant at
`:111`, and the `armed_at_ms` the comparison reads, written once as
`armed_at_ms: now_ms` where the directive is armed (`:9492`, inside `:9488-9497`)
and returned unchanged by both replay arms (`:9463-9466`, `:9473-9476`). The
delivered-id comparison that precedes it is at `:9442-9448`, so a caller
acknowledgement and a TTL expiry cannot both be credited for one retirement in the
same pass.
Existing check: none. `nudge_formula_tests` (`transform.rs:9629-9783`) covers the
Channel-1 band arithmetic only.
Impact: This is the load-bearing safety mechanism on the arm, which is why it is
worth a record of its own. The parent record's finding is that the primary
retirement path has no corroboration; the TTL is the only retirement cause the
module can reach without trusting the caller, so if it failed to fire the arm
would stay pending on a caller that simply never implements the acknowledgement,
replaying one directive text for the life of the session while pressure stayed
high. Nothing counts arms or retirements
([nudge-b-overlay-suppression-and-firing-are-unreportable](#nudge-b-overlay-suppression-and-firing-are-unreportable)),
so the wedge would be invisible.
Open questions:
- Is the CC leg live? Inherited from the parent record and unresolved for the same
  reason: no TypeScript sender in this repository emits the profile. (needs human
  input)
- Does any caller-reachable path reset `armed_at_ms` on a replay pass, which would
  slide the deadline forward indefinitely? No. The replay block at `:9460-9481`
  returns the pending directive with its existing `armed_at_ms` in both arms, and
  the field is written only at `:9492` where a new directive is armed, so the
  deadline is fixed at arming. Recorded as resolved in the evidence file.

## Group F: unbounded overlay growth

Two records, kept in their own group because they are resource properties rather
than correctness ones and they are deliberately outside the dominance chains
above. Two of the three overlay tables have no reaper, no count cap and no byte
cap, while the third in the same family does, which makes the omission local
rather than a uniform design decision. The interesting failure is not size: a
stale row is inert only while its block is out of the projection, so the hazard is
a reminder resurfacing and quoting a token count from a session state that no
longer exists. The two records are the two halves `R3` separated. The first is the
`always` count bound, which is assertable today against a bound nobody has stated.
The second is the removal obligation, which is bounded progress and is the reason
this part now has a liveness record at all.

### nudge-b-channel1-append-rows-have-no-reaper

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts a bound on the row count, and none
observes the table across a long session.
Guarantee: The durable overlay tables are bounded, so the row count for a session
stays at or below an explicit documented ceiling.
Check: `always` — assert `count(mc_channel1_appends WHERE session_id = ?)` stays
at or below an explicit documented bound across a session. `always` because
exceeding a stated ceiling is wrong whenever it happens. The removal obligation
that this check previously carried in the same conjunction is bounded progress and
is now
[nudge-b-channel1-append-row-removal-has-no-bounded-window](#nudge-b-channel1-append-row-removal-has-no-bounded-window),
split out under `R3`, so nothing here asserts an "eventually". The bound this
check compares against does not exist in the code either; the difference is that a
missing ceiling makes the safety check unwritable until a number is stated, while a
missing removal window makes the liveness check unwritable until a *window* is
stated, and those are two different product decisions.
Fault/timing angle: None. This is accumulation over a long session, not a race.
Required faults and enabling state: `tagging_active`, and a session long enough
for `decide_channel1` to clear the escalation-or-cadence gate repeatedly. The
cadence step is `max(25_000, 0.08 * tail_tokens)` tokens of newly unreduced
tool output (`channel1_refire_tokens`, `transform.rs:9623-9626`, gate at
`:9608-9610`), so each additional row costs the agent that much unreduced growth.
The cited range was `:9624-9627` before this pass; the function opens at `:9623`
and closes at `:9626`, and the reference is corrected here per METHOD.md rule 1.
Confidence: high —
[evidence](evidence/nudge-b-channel1-append-rows-have-no-reaper.md). Verified
by grepping every statement touching the three overlay tables in
`mc-store/src/lib.rs`: the only `DELETE`s are the host-driven
`user_hints_replace_session` replace-delete (`:7754-7759`) and the
lineage-descent wipe of the *target* key (`:8642-8654`), which is immediately
undone by a copy from the source key (`:8736-8751`). No age predicate, no count
cap, no byte cap, and no `PRAGMA`-level bound exists for `mc_channel1_appends`
or `mc_temporal_marks`.
Existing check: none.
Impact: Two costs. The database grows by one row of roughly 300 reminder bytes
per firing forever, which is the same unbounded-caller-driven-growth shape
prior parts recorded. More importantly a stale row is inert only while its
block is out of the projection; if a block id is ever reconstructed on a later
pass the old reminder reappears, quoting a token count from a session state
that no longer exists.
Open questions:
- Can a `block_id` be reconstructed after leaving the projection? Block ids are
  `ck_wire::block_id(&message_id, block_index)`, so a message that re-enters
  the request with the same mid and block layout would collide. Whether that
  happens depends on the projection cache and lineage handling, which is 4b
  scope. Unresolved, needs 4b.
- Should the reaper key on the overlay frontier, on tag retirement, or on
  compartment coverage? A design decision. (needs human input) The same decision
  fixes the window in
  [nudge-b-channel1-append-row-removal-has-no-bounded-window](#nudge-b-channel1-append-row-removal-has-no-bounded-window),
  which is why neither half of the original check can be written today.

### nudge-b-channel1-append-row-removal-has-no-bounded-window

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test observes a row after its target block leaves the
projection, and no bound exists to observe it against. This is the stronger of the
two reasons: the construction is cheap and the oracle is undefined.
Guarantee: A `mc_channel1_appends` or `mc_temporal_marks` row whose target block
has left the projection is removed within a bounded number of subsequent passes,
so a spent row cannot outlive the state it describes.
Check: `always` evaluated once at the end of an explicit bounded window — drive a
session until a Channel-1 row exists, advance the projection past that row's target
block so the block is no longer selectable, stop adding tool output, drive N
further `tagging_active` passes, then assert
`load_channel1_appends(session)` no longer contains that `block_id`. **The bound N
does not exist in the code**, and per METHOD.md's liveness rules this record does
not substitute an unbounded "eventually" or a generous timeout for it: as written
the check is unwritable until a bound is stated, and that is the finding rather
than a gap in the record. The proposed bound, offered so the shape is concrete and
labelled as a proposal rather than a citation, is **one pass**: the module already
computes whether a block is below coverage on every pass, so a coverage-keyed
reaper has no reason to need a second one. `is_tail(ordinal, coverage)`
(`transform.rs:6471-6473`) is `coverage.is_none_or(|c| ordinal > c)`, and a block at
or below `meta.coverage_ordinal` (`mc-store/src/lib.rs:2250`) can never be selected
for a new append again, so the removable set is already decidable at commit time.
Fault/timing angle: The window is the quiescent period after the target block
leaves the projection. The fault-free requirement is that nothing re-presents the
block during it, because a reappearance would make a surviving row correct rather
than stale, and that reappearance is the parent record's hazard.
Required faults and enabling state: `tagging_active`, one Channel-1 firing, then
a projection advance past the fired block, then N passes and silence. All of it is
request sequencing plus store state and none of it is a fault. A row can also be
placed directly with `seed_channel1_append_for_test`
(`mc-store/src/lib.rs:6664`, behind the `test-support` feature), which removes the
need to drive a real firing first.
Confidence: high —
[evidence](evidence/nudge-b-channel1-append-row-removal-has-no-bounded-window.md).
Verified that no removal path exists to be bounded: grepping every statement
touching the three overlay tables in `mc-store/src/lib.rs` returns exactly two
`DELETE`s, the host-driven `user_hints_replace_session` replace-delete
(`:7754-7759`) and the lineage-descent wipe of the *target* key (`:8642-8654`),
which is immediately undone by a copy from the source key (`:8736-8751`). Verified
that the row type cannot express the natural bound: `Channel1AppendRow`
(`:2617-2621`) carries `block_id`, `reminder_text` and `fired_at_ms` and no
ordinal, so a coverage-keyed reaper would have to resolve ordinals from the
projection at commit time or the row type would have to change. Verified that
`fired_at_ms` exists, so an age-keyed reaper is expressible today while a
coverage-keyed one is not, which is a fact about the schema rather than a
recommendation. A row can be placed directly with `seed_channel1_append_for_test`
(`:6664`), which is gated `#[cfg(feature = "test-support")]` (`:6663`).
Existing check: none. `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`transform.rs:23551-23590`) asserts `len() == 1` three times (`:23570`, `:23574`,
`:23588`) and never advances past the block it fired on, so it observes
persistence rather than removal.
Impact: Unbounded retention is the parent record's cost. This record's cost is the
one that is not about size: because nothing removes a spent row, a row survives to
the moment its `block_id` is reconstructed, and the reminder is then re-applied
quoting `approx_thousands(reclaimable_tokens)` from a session state that no longer
exists. A bounded removal window would close that hazard whatever the ceiling on
the table turned out to be, which is why the two halves needed separating: fixing
the count bound does not fix this, and fixing this bounds the count as a
side-effect.
Open questions:
- What is N, and in what unit? Passes is the unit this record proposes because the
  module's own removability test is evaluated per pass, but a wall-clock TTL keyed
  on `fired_at_ms` is the cheaper implementation and the schema already supports
  it. The choice is the same product decision the parent record's second open
  question names. (needs human input)
- Does a lineage descent reset the window? The descent copies every row forward
  (`mc-store/src/lib.rs:8736-8751`), so a descended session inherits rows whose
  target blocks may never re-enter its projection. Whether the window should be
  measured from the original `fired_at_ms` or restarted at the descent depends on
  the projection cache's mid-stability contract, which is 4b scope. Unresolved,
  needs 4b.

## Group G: provenance of injected content

Two records on unmarked authorship. The first is a whole assistant turn the model
never took, injected with a completed status and a zero timestamp, whose only
model-facing signal is a tool-call id prefix nothing documents as a contract. The
second appends unauthored text inside a message the user did send, behind an
envelope the module's own suppression logic proves a user can forge. One harness
serves both: render a pass with a frozen pair and a non-empty hint decision, then
ask of every emitted message whether it corresponds to an ingress message or
carries a marker its consumer reads.

### nudge-b-injected-todo-pair-carries-no-provider-visible-provenance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `ck_pair_byte_determinism_golden` (`injection.rs:866-904`)
asserts `meta.synthetic` is set on both halves, and
`serve_native_golden_preserves_ingress_and_pins_synthetic_shapes`
(`codec/mod.rs:93-127`) pins the encoded shape. Neither asserts anything about
what the model can distinguish.
Guarantee: Content the module injects into the served conversation carries an
explicit model-facing provenance field on the surface its consumer reads, rather
than only an identifier convention. State it that way and not as
"indistinguishable": the distinction survives every hop the module controls, and
what is missing is a field that declares it. `HarnessMeta::synthetic` is serialized
on the CK wire (`mc-store/src/lib.rs:64-65`) and the OpenCode encoder emits a
native marker, `"syntheticTodoMarker": true` in `render_synthetic_todo_pair`
(`codec/opencode.rs:916-947`, the marker at `:946`). The chain breaks at the
consumer, whose wire serializer reads `part.state.*`, `part.callID`, `part.tool`
and `part.metadata` and therefore ignores the marker (`todo-view.ts:117-126`),
leaving a deliberately distinctive call-id format (`:185-196`) as the only
surviving signal.
Check: `always` — for every emitted message, assert that either it corresponds
to an ingress message, or it carries a provenance marker on the surface its
consumer reads. `always` because an unmarked injection misattributes authorship
on every pass it is served. Pair it with a coverage check asserting the
independent preconditions: a pass in which `meta.synthetic_todo` is `Some` and
`synthetic_todo_enabled` is true, plus the serializer profile under test.
Fault/timing angle: None.
Required faults and enabling state: A frozen pair and `synthetic_todo_enabled`
(`transform.rs:5388-5389` passes `tail_reclaim_enabled && !req.is_subagent`).
Confidence: high —
[evidence](evidence/nudge-b-injected-todo-pair-carries-no-provider-visible-provenance.md).
Verified three layers. CK wire: `HarnessMeta::synthetic` is serialized
(`mc-store/src/lib.rs:64-65`), so the host can always tell. OpenCode native
encode: `"syntheticTodoMarker": true` (`codec/opencode.rs:946`, reached from
`:388`). Provider array: the module does not build it, and the only marker that
survives into the tool-call id is the `mc_synthetic_todo_` prefix
(`injection.rs:23`, `:139`). The pi encoder emits nothing
(`codec/pi.rs:582-607`) but has no production caller, verified by grep.
Existing check: `codec/mod.rs:93-127`, `:290-297`; neither runs in CI.
Impact: The model is shown an assistant `todowrite` call and result it never
made, with a `completed` status and a zero timestamp (`injection.rs:345`,
`:355-358`). It cannot tell that from its own work, so it may reason about the
todo list as something it already did. The three text overlays are better off:
Channel-1 and Channel-2 carry `<system-reminder>` (`transform.rs:9859`,
`:9559`), the hint carries `<ctx-search-hint>` (`:9111`), and the temporal mark
is an HTML comment (`:8205`). All four of those markers are plain text a user
or a tool result can forge, so they are a convention, not a boundary.
Open questions:
- Is the `mc_synthetic_todo_` id prefix intended as the provenance marker for
  the model? It is deterministic and visible in the Anthropic `tool_use` id, so
  it is a real signal, but nothing documents it as one. (needs human input)
- Does the OpenCode host propagate `syntheticTodoMarker` into anything the
  model sees, or only into its own storage? Host scope, outside 4e. Unresolved.

### nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `empty_user_hint_decision_skips_future_queries`
(`transform.rs:23075-23090`) and the query-sanitization tests (`:23030-23133`)
cover the decision and the query. Nothing asserts anything about the authorship
boundary of the appended bytes.
Guarantee: Text the module appends to a user's message is attributable to the
module rather than to the user, on the surface the model reads.
Check: `always` — for every emitted `role: "user"` text block, assert that the
block's bytes equal the ingress bytes plus only prefixes and suffixes that
carry a provenance envelope, and that the envelope cannot be produced by
ingress bytes alone. `always` because a misattributed sentence is wrong every
time it is served. Pair it with a coverage check on the preconditions:
`auto_search_active`, a hint decision with non-empty text, and the target block
rendering in this pass.
Fault/timing angle: None.
Required faults and enabling state: Default configuration is enough.
`memory.auto_search.enabled` defaults to `true` (`CONFIGURATION.md:682`,
`assets/magic-context.schema.json:1607-1612`, `transform.rs:865-867`),
`auto_search_active` needs only a non-subagent request (`:3519`), the prompt
must clear `DEFAULT_AUTO_SEARCH_MIN_PROMPT_CHARS` of 20 (`config.rs:40`,
checked `:8806`), at least two non-stopword tokens must match
(`USER_HINT_MIN_MATCHED_TOKENS`, `:118`, checked `:8861`), and the top score
must clear `DEFAULT_AUTO_SEARCH_SCORE_THRESHOLD` of 0.6 (`config.rs:39`,
checked `:8955-8959`).
Confidence: high —
[evidence](evidence/nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block.md).
Verified the append target is the user's own text block
(`transform.rs:8249-8250`, `append_user_hint_to_block` at `:8345-8355` pushes
onto `CkKind::Text`), that the envelope is the plain string `<ctx-search-hint>`
(`:9111`), and that the same string in ingress bytes is treated as an existing
augmentation (`has_stacked_user_hint_augmentation`, `:8989-8997`), which proves
the envelope is forgeable from the user side. Verified the injected fragments
come from stored compartment bodies (`run_user_hint_lexical_search` reads only
`load_compartment_candidates`, `:8866`), so the content is earlier-conversation
material this turn's author did not write.
Existing check: `transform.rs:23075-23090`, `:23030-23048`, `:23049-23073`;
none run in CI.
Impact: The provider sees a user message that ends with three fragments of
earlier conversation plus the instruction "If the fragments above seem relevant
to the current request, you may run ctx_search to retrieve full context"
(`:9109`). Attributed to the user, that reads as the user's own instruction.
The module's own code shows it knows this is a text convention and not a
boundary: `is_system_reminder_transport_message`'s comment says CK
"intentionally has no transport-origin field" and settles for a text-shape
discriminator (`:8525-8527`).
Open questions:
- Is a caller-supplied value causing this? Yes, indirectly and by design: the
  user's own prompt is the search query, so the caller's bytes select which
  unauthored content gets injected. Recorded as resolved in the evidence file.
- Should the envelope be structural, for example a separate block with a typed
  kind, rather than a text marker? That changes the provider prefix and so is a
  design decision. (needs human input)

## Group H: observability of suppression and of what the render removed

Three records whose shared consequence is that a decision leaves no trace. A
documented suppression flag is never set outside a test, so the mechanism the
design names as the post-reduction throttle does not exist; overlay firings,
suppressions and retirements have no counter anywhere in the timings struct; and
the one number that is reported is measured over a pre-strip tail. The third is a
different animal from the first two and is grouped here deliberately: it is the
only place in the part where a number is reported and is wrong, and its
consequence is amplified because the bands were calibrated on the measurement the
code does not make.

### nudge-b-channel1-suppression-flag-is-never-set

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`transform.rs:23551-23590`) covers the suppression *effect*, but only by
writing the flag directly into the store at `:23577`. That is the only write to
`true` in the repository. The test does not run in CI.
Guarantee: The documented ctx_reduce feedback loop exists: after the agent acts
on a reminder, the next transform suppresses new Channel-1 appends.
Check: `always` — assert that on any pass following a `ctx_reduce` that froze
at least one reduction, `decide_channel1` takes the suppressed arm
(`transform.rs:9593-9595`) on the next transform for that session. `always`
because the documented contract is unconditional once the antecedent holds.
Fault/timing angle: The window is between the `ctx_reduce` facade commit and
the next transform pass. If the flag were ever set, the clear at
`transform.rs:9157` would consume it on the first `tagging_active` pass, so the
suppression is a single-pass token.
Required faults and enabling state: A `ctx_reduce` call that applies a
reduction, followed by a `tagging_active` transform pass. The suppression
cannot be observed because nothing sets the flag.
Confidence: high —
[evidence](evidence/nudge-b-channel1-suppression-flag-is-never-set.md).
`git grep reduce_suppressed` over the whole worktree returns six lines: the
field (`mc-store/src/lib.rs:2461`), three reads (`transform.rs:9156`, `:9565`,
`:9593`), one clear to `false` (`transform.rs:9157`), and one write to `true`
inside `#[test]` (`transform.rs:23577`). The TypeScript side has no
`reduceSuppressed` equivalent, checked by the same grep.
Existing check: `transform.rs:23551-23590`; does not run in CI and only reaches
the code by writing the store directly.
Impact: The agent that complies with a reminder gets no credit for it. Refire
is throttled only by the cadence gate, which keys on `reclaimable_tokens`
growth (`:9610-9611`). Since a compliant reduction *lowers* reclaimable tokens,
the `reset_cycle` arm at `:9565-9566` fires instead and zeroes the memo, which
re-arms the ladder from `Gentle`. So compliance resets the nudge cycle rather
than suppressing it, which is a different behaviour from the documented one.
Open questions:
- Was the writer removed, or never written? `mc_store::ModuleMeta` carries the
  field with `#[serde(default)]` (`:2460`), so a stored `true` from an older
  writer would still be honoured. Whether such a writer ever shipped needs the
  history. (needs human input)

### nudge-b-overlay-suppression-and-firing-are-unreportable

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing asserts the observability of an overlay decision.
Guarantee: Every overlay decision that changes what the agent sees, or that
suppresses something the agent would have seen, is observable in the response.
Check: `always` — for every accepted pass, assert that the response carries a
count for each of: Channel-1 fired, Channel-1 suppressed, temporal marks
minted, user-hint decisions taken, user-hint decisions parked, Channel-2 armed,
and Channel-2 retired. `always` because an unreportable decision is
unobservable on every pass, and the whole class of defects above is invisible
without it.
Fault/timing angle: None.
Required faults and enabling state: None. Any `tagging_active` pass exercises
it.
Confidence: high —
[evidence](evidence/nudge-b-overlay-suppression-and-firing-are-unreportable.md).
Read the whole of `TransformTimings` (`transform.rs:1144-1310`) and confirmed
it carries `tag_mint_candidates`, `tag_mint_new`, and
`tag_mint_tokenized_bytes` (`:1217-1221`) but no count field for any other
overlay. Confirmed the four overlay stages contribute milliseconds only
(`:1182-1187` for the store reads, `:1203` for `user_hint`, `:1211-1212` for
`tag_overlay` and `temporal`). Confirmed `format_pass_timing_line`
(`:1315-1400`) emits those timings and no overlay counts. Confirmed the
suppression return at `:9156-9160` writes nothing.
Existing check: none. This is the same shape as the sibling's
`render-a-emptied-tail-message-drops-without-a-report`, on a different path.
Impact: Every other record in this lens is hard to detect in production for the
same reason. A Channel-1 nudge that fires on a served block, a hint parked
forever because a bust never comes, a Channel-2 directive retired without
delivery: none of them leave a counter. The only adjacent signal is the
served-output divergence record (`:5513-5520`), which reports the byte symptom
without naming the cause.
Open questions:
- Is `tag_mint_new` the intended precedent, meaning the other overlays were
  simply never given counters, or is there a deliberate reason tags are counted
  and reminders are not? (needs human input)

### render-a-hygiene-metric-ignores-surface-strips

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `recurring_raw_call_id_orphan_is_conservative_t_only`
(`tail_hygiene.rs:1211`) and the surrounding suite cover exclusion for `red:`,
caveman and sentinel content. Nothing covers a `strip:` unit.
Guarantee: The tail-hygiene metric's total `t` counts only tokens the render
actually serves.
Check: `always` — for a pass with at least one `strip:` frozen unit whose
target is in the measured tail, assert `measure_tail_hygiene`'s `t` excludes
the stripped block's original tokens. `always` because the number is wrong on
every pass where a strip is active.
Fault/timing angle: None; both are computed in the same pass from the same
`core`.
Required faults and enabling state: Any frozen unit keyed `strip:placeholder:`,
`strip:system_injected:`, `strip:system_injected_block:`, `strip:stale_reduce:`
or `strip:processed_image:` whose target block is inside the measured tail.
`new_frozen_strip_units` (`transform.rs:10181-10339`) is the producer.
Confidence: high —
[evidence](evidence/render-a-hygiene-metric-ignores-surface-strips.md).
Verified `measure_tail_hygiene`'s exclusion set at `:499-512` and its per-kind
arms at `:522-587`, and verified by grep that `tail_hygiene.rs` contains no
`strip:` literal anywhere.
Existing check: `tail_hygiene.rs:1211` and its neighbours; none run in CI.
Impact: `t`, and `u` as well when the stripped block carried an active
non-protected tag, diverge from the served tail, and the divergence is
**bidirectional**. `TailHygienePartMeasurement` sets `tokens` and then
`u_tokens: if active && !protected { tokens } else { 0 }`
(`tail_hygiene.rs:265-270`), so a stripped block whose tag is active inflates both
`t` and `u` while a stripped block that is untagged or protected inflates `t`
alone. `hygiene_band` computes `severity = u as f64 / t.max(1)` (`:709`) and
ladders on it (`:710-716`), so the ratio moves **up or down** according to which
case the strip was: the gates can fire on a tail smaller than measured, or stay
quiet on a tail that has crossed a threshold. The agent is told about tokens that
are not there, in either direction. A one-directional bias could be absorbed by
moving a threshold; a bidirectional error cannot, and that matters more here than
it would elsewhere because the bands were calibrated on a post-strip measurement
the code does not make
(`docs/nudge-hygiene-calibration-2026-08-16.md:10`, cited in
[fault-map.md](fault-map.md)).
Open questions:
- Is the divergence bounded? A whole-message strip replaces every block, so the
  overstatement is the whole message. Whether any strip class can dominate the
  tail is unresolved, needs a measurement on a real session.

## Group I: situation coverage

Two `sometimes` records, both aimed at vacuous passes rather than at defects. The
first gates the only budget in 4e that binds in ordinary operation, so a campaign
cannot execute the truncation lines from a unit test and call the envelope and
scalar guarantees proven. The second constructs three overlay kinds on one block,
which is an ordinary state that no existing test builds and which is the
precondition for the index-shift cluster in Group A and for the fixed mutator
order. Both are situation coverage, not location coverage, which is why neither is
`reachable`.

### render-a-hint-fragment-cap-binds-in-a-served-render

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test observes a truncated fragment inside a served
array.
Guarantee: A campaign reaches a render in which the user-hint fragment cap
actually binds, and the served bytes are still a balanced `<ctx-search-hint>`
element with no broken scalar.
Check: `sometimes` — marker `USER_HINT_FRAGMENT_TRUNCATION_SERVED`. At least once
per campaign, observe a served array containing a `<ctx-search-hint>` block whose
body has a line ending in `…`, and assert on that same render that the element is
balanced, that every fragment line is at most `USER_HINT_FRAGMENT_CHAR_CAP + 2`
UTF-16 units, and that the whole message is valid UTF-8 with no lone surrogate.
`sometimes` and not `reachable`, because executing `one_line_fragment`'s truncation
branch in a unit test proves nothing about a render that actually carried a
truncated hint into the provider array. The marker name is a constant and is
globally unique across this catalog; it witnesses a served truncation, which is a
legal state of a correct implementation, so it does not pair with any `always(!X)`
and cannot fire only by observing a defect.
Fault/timing angle: None.
Required faults and enabling state: `auto_search_active` (default true, see the
record above), an authored user tail that is the last message (`:8776-8780`),
no existing hint row for its block, and at least one memory search result whose
caveman-compressed snippet exceeds 80 UTF-16 units. The last is the ordinary
case for a real memory hit, since `caveman::compress` at `Ultra` shortens but
does not cap.
Confidence: high —
[evidence](evidence/render-a-hint-fragment-cap-binds-in-a-served-render.md).
Verified the cap application at `:9096`, the truncation at `:9135-9139`, the
whole-scalar slicing at `:9070-9082`, and the envelope construction at `:9111`.
Existing check: none.
Impact: This is the only budget in 4e that binds in ordinary operation. Without
a `sometimes` record a campaign can run for hours, execute the truncation lines
from a unit test, and never once serve a truncated hint, so the envelope and
scalar guarantees stay unproven on real data.
Open questions:
- None.

### nudge-b-one-block-carries-several-overlay-kinds

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — `tag_overlay_replays_stably_and_new_tail_gets_next_number`
(`transform.rs:23307`) and the Channel-1 test (`:23551`) each exercise one
overlay kind at a time. No test constructs a block carrying three.
Guarantee: A campaign reaches the state where one block carries more than one
overlay kind at once, so the fixed mutator order and the interaction between
envelopes is actually exercised.
Check: `sometimes` — marker `OVERLAY_KINDS_COLLIDED_ON_ONE_BLOCK`. Assert that at
least once per campaign a single `block_id` appears in two or more of
`tag_by_block_id`, `temporal_by_block_id`, `user_hint_by_block_id`,
`channel1_by_block_id` on the same accepted pass, and separately at least once in
three of them. Three is the maximum by construction, not four, so the three-way arm
is a reachable target rather than an unreachable one: a tool result is ineligible
for the temporal marker (`transform.rs:8642-8647` requires an authored user
message) and for the user hint (`:8789` requires `role == "user"`). `sometimes` and
not `reachable` because `apply_tag_overlay_to_message`'s lines execute on every
tagging pass; what a campaign can easily miss is the operational *situation* of a
multiply-overlaid block, which is where the ordering and the envelope interactions
live. The marker name is a constant and is globally unique across this catalog; a
multiply-overlaid block is an ordinary legal state, so the marker asserts a
precondition rather than a violation and pairs with no `always(!X)`.
Fault/timing angle: None. This is situation coverage, not a race.
Required faults and enabling state: Two reachable combinations. On an authored
user text block: a minted tag, a gap above 5 minutes since the previous
response so the temporal marker is non-empty (`transform.rs:8168-8173`), and a
hint decision with non-empty text. That needs `temporal_active`
(`tagging_active && ctx.temporal_awareness`, `:3525`; `temporal_awareness`
defaults on per `CONFIGURATION.md:644`) plus `auto_search_active`. On a tool
result block: a minted tag plus a Channel-1 reminder, which needs the tool
result to be text-bearing (`tool_result_can_carry_channel1`, `:9809-9823`) and
`decide_channel1` to fire.
Confidence: high —
[evidence](evidence/nudge-b-one-block-carries-several-overlay-kinds.md).
Verified the four maps are independent `BTreeMap`s keyed by the same `block_id`
(`:1724-1729`), that all four are consulted for the same `block` inside one
loop iteration (`:8233-8254`), and that the order is fixed: tag prefix,
temporal prefix, user hint, Channel-1. Verified the consequence of that order,
that the temporal comment ends up outside the tag prefix in the served bytes,
by reading `prepend_tag` (`:8395-8399`) and `prepend_temporal_to_block`
(`:8334-8343`).
Existing check: `transform.rs:23307`, `:23551`; neither covers the combination,
and neither runs in CI.
Impact: Without this situation, three interactions go untested. First, whether
`strip_tag_prefix` (`:8404-8406`) still inverts `prepend_tag` when a temporal
comment precedes the tag. Second, whether a user block ending in a hint
envelope and beginning with a tag confuses the imitation defence on a later
pass. Third, whether the sibling's index-shift hazard
(`render-a-overlay-targets-stale-indices-after-full-drop-filter`) misapplies
two or three overlays at once rather than one.
Open questions:
- Can a single block ever carry all four? A tool result is not eligible for the
  temporal marker (that requires an authored user message, `:8642-8647`) and
  not eligible for the user hint (that requires `role == "user"`, `:8789`), so
  the answer is no: the maximum is three on a user text block and two on a tool
  result. Recorded as resolved in the evidence file.

## Relationship map

Grouped by shared mechanism rather than by lens or by group heading, because the
mechanism is what decides whether one check can stand in for another. Every
dominance statement is a hypothesis, not a finding.

- **One index space, three stages allowed to shrink it.**
  [render-a-overlay-targets-stale-indices-after-full-drop-filter](#render-a-overlay-targets-stale-indices-after-full-drop-filter),
  [render-a-emptied-tail-message-drops-without-a-report](#render-a-emptied-tail-message-drops-without-a-report),
  [render-a-composition-order-is-fixed-and-each-unit-appears-once](#render-a-composition-order-is-fixed-and-each-unit-appears-once).
  All three turn on the same fact: `apply_surface_strips` (`transform.rs:10388`),
  the full-drop filter (`:12014-12021`) and
  `remove_frozen_historical_reasoning` (`:12035`) may shorten `content`, and the
  overlay that follows still addresses blocks by their pre-removal `block_index`
  (`:8227-8231`). One fixture serves all three: a retained tail message with a
  removable block followed by two taggable blocks. Hypothesis: the composition
  record dominates neither of the others, because a subsequence-and-uniqueness
  check over mids cannot see a within-message index shift or an emptied message
  that never reaches `out`. The index record and the drop record are the two
  outcomes of one shrink, split by whether the shift lands inside the array
  (misattribution) or off its end (a skipped overlay at `:8227`), so a single
  harness that records `(block_id, overlay_string)` pairs before and after the
  filter answers both.
- **A whole message leaves the array and nothing names it.**
  [render-a-emptied-tail-message-drops-without-a-report](#render-a-emptied-tail-message-drops-without-a-report),
  [nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report](#nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report),
  [render-a-duplicate-tool-use-repair-is-release-only](#render-a-duplicate-tool-use-repair-is-release-only).
  Three producers of one outcome, at three different points in the pass:
  reclassification at ingress (`transform.rs:2419`, excluded from the tail loop at
  `:11842-11845`), the `present` gate mid-loop (`:12037-12039`), and the release
  repair at the very end (`:11297-11299`). Hypothesis: no dominance, because the
  oracles differ in kind. The first needs a forged tool-call id, the second needs
  a strip or a reasoning removal, the third needs a duplicate id and a release
  build. What they share is the detection strategy: count retained mids against
  emitted mids per pass and refuse to read the answer off the return type, which
  is the same strategy 4c and 4d arrived at for missing durable writes.
- **The only defence is compiled out or compiled test-only.**
  [render-a-duplicate-tool-use-repair-is-release-only](#render-a-duplicate-tool-use-repair-is-release-only),
  [render-a-orphan-tool-arc-has-no-production-detection](#render-a-orphan-tool-arc-has-no-production-detection).
  Two halves of one function pair at `transform.rs:11171-11305`, and the pairing
  is economic as well as diagnostic: `enforce_unique_tool_use_ids` runs in
  production at a cost comparable to the guard that does not, which is what makes
  the asymmetry look unintentional rather than a considered trade. Hypothesis: the
  orphan record dominates the duplicate record's *consequence* but not its
  *check*, because the duplicate repair is itself a producer of orphans
  (`:11258-11277` removes an adjacent result), so an arc check running in
  production would catch a bad repair while a duplicate check would not catch an
  arc broken by a strip. Both must state the build profile, and no other record in
  this part does.
- **A tag number that names nothing.**
  [render-a-mint-batch-block-ids-are-unique-per-pass](#render-a-mint-batch-block-ids-are-unique-per-pass),
  [render-a-channel2-derived-tag-numbers-name-no-durable-row](#render-a-channel2-derived-tag-numbers-name-no-durable-row).
  Both are about a `§N§` the agent cannot resolve, from opposite directions. The
  mint record is the property expected to hold, and it is what makes the durable
  numbering trustworthy; the Channel-2 record is a deliberate process-local
  numbering (`transform.rs:9279-9281` says so) that reaches agent-visible bytes
  through `format_reclaimable_hint` (`:9872`). Hypothesis: neither dominates,
  because the mint record's oracle is a pre-commit comparison against `mc_tags`
  and the Channel-2 record's oracle is a post-render scan of served text against
  the same table. What they share is the table, so one fixture that renders a pass
  and then reads `mc_tags` back serves both, and both are blocked on the same
  unresolved question about the store's generation triggers.
- **A path the arithmetic or the build makes dead.**
  [render-a-user-hint-total-cap-cannot-bind](#render-a-user-hint-total-cap-cannot-bind),
  [render-a-light-surface-fallback-notice-never-served](#render-a-light-surface-fallback-notice-never-served),
  [nudge-b-todo-availability-fail-open-is-unreachable](#nudge-b-todo-availability-fail-open-is-unreachable).
  Three dead paths with three different keepers: a computed maximum of 458 UTF-16
  units against a cap of 800, two `Option` constants that are unconditionally
  `Some`, and a normalizing wrapper (`todo_synthesis_verdict`,
  `transform.rs:2626-2630`) that collapses the `Option` before the documented
  fail-open branch can see it. Hypothesis: no dominance, and the grouping's value
  is that a reviewer reading them together sees the same failure mode three times:
  a comment or a constant describing behaviour the build forbids, with a
  `debug_assert!` or a doc comment as the only witness. The third is the most
  dangerous of the three, because its documentation would tell a future caller to
  manufacture a synthetic tool call without host authority, which
  `transform.rs:739-741` says must never happen.
- **An overlay that stops, and one that does not.**
  [nudge-b-frozen-todo-pair-retires-only-on-a-bust](#nudge-b-frozen-todo-pair-retires-only-on-a-bust),
  [nudge-b-channel1-append-first-applies-without-a-frontier-gate](#nudge-b-channel1-append-first-applies-without-a-frontier-gate),
  [nudge-b-channel1-append-rows-have-no-reaper](#nudge-b-channel1-append-rows-have-no-reaper),
  [nudge-b-channel1-append-row-removal-has-no-bounded-window](#nudge-b-channel1-append-row-removal-has-no-bounded-window).
  Three points on one axis plus the bounded-progress half of the third: an overlay
  with a strict retirement rule, an overlay with no first-apply gate, the same
  overlay with no ceiling, and the same overlay with no removal window.
  Hypothesis: the frontier-gate record dominates the reaper record's *first* cost
  and not its second. A check asserting that every newly inserted overlay row's
  `block_id` is absent from `served_output_fingerprint` also bounds how often a row
  can be created against a served block, but it says nothing about accumulation
  over a long session, and nothing at all about a stale row resurfacing on a
  reconstructed block id. That second cost is what the liveness record owns, and it
  is why the split under `R3` was not cosmetic: the frontier gate constrains
  *creation*, the count bound constrains *size*, and neither can be satisfied in a
  way that bounds *retention*. The todo-pair record is the control in this cluster:
  it is the one injected thing with a retirement rule that actually holds, and it is
  the only one whose absent placement is a hard error
  (`SyntheticTodoAnchorMissing`, `transform.rs:12125-12133`) rather than an
  absorbed skip.
- **Idempotence delegated to the caller.**
  [nudge-b-opencode-channel2-arm-has-no-module-side-latch](#nudge-b-opencode-channel2-arm-has-no-module-side-latch),
  [nudge-b-channel2-retirement-is-caller-asserted](#nudge-b-channel2-retirement-is-caller-asserted),
  [nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl](#nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl).
  The two Channel-2 arms plus the bound that separates them, and the arms are
  opposites rather than variants: one keeps a durable directive id, an arming
  watermark and a 10-minute lease (`transform.rs:9435-9513`), the other writes
  nothing at all (`:9347-9365`).
  Hypothesis: the OpenCode record is the more urgent by a wide margin, because it
  is the profile the shipped host sends (`rust-mode-transform.ts:1339`) and its
  failure mode is a `<system-reminder>` on every pass while pressure is high,
  while the Claude Code record's damage is bounded to one arming cycle by the TTL.
  Neither dominates the other as a check, since they need different profiles, and
  the pair is what makes the finding legible: the arm with the protocol is the arm
  nothing in this tree exercises, and the two module rearm helpers
  (`:9412-9433`) clear state the live arm never reads. The liveness record is the
  hinge of that comparison rather than a third variant: the OpenCode arm's damage is
  unbounded *because* it has no analogue of the lease, so proving the lease fires
  within its bound is what licenses the claim that one arm is bounded and the other
  is not.
- **Unmarked authorship.**
  [nudge-b-injected-todo-pair-carries-no-provider-visible-provenance](#nudge-b-injected-todo-pair-carries-no-provider-visible-provenance),
  [nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block](#nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block).
  One harness serves both: render a pass with a frozen pair and a non-empty hint
  decision, then ask of every emitted message whether it corresponds to an ingress
  message or carries a marker its consumer reads. Hypothesis: the hint record
  dominates the pair record's check but not its consequence. The hint's envelope is
  demonstrably forgeable, and the module's own
  `has_stacked_user_hint_augmentation` (`transform.rs:8989-8997`) is the proof, so
  a check that rejects text-only markers rejects the pair's `mc_synthetic_todo_`
  id prefix for the same reason. The consequence runs the other way: the pair is a
  whole assistant turn the model never took, with a `completed` status, which is a
  heavier misattribution than a paragraph appended to a message the user did send.
- **A decision with no counter.**
  [nudge-b-overlay-suppression-and-firing-are-unreportable](#nudge-b-overlay-suppression-and-firing-are-unreportable),
  [nudge-b-channel1-suppression-flag-is-never-set](#nudge-b-channel1-suppression-flag-is-never-set),
  [render-a-hygiene-metric-ignores-surface-strips](#render-a-hygiene-metric-ignores-surface-strips).
  Hypothesis: the unreportable record dominates the never-set-flag record's
  *detectability* and neither its cause nor its cure. `TransformTimings` counts
  `tag_mint_new` (`:1218`) and nothing else about overlays, so adding the seven
  counters the unreportable record asks for would make a missing suppression
  observable; it would not make the flag get written, and the actual behaviour
  after a compliant reduction is worse than absent suppression, because lowering
  reclaimable tokens takes the `reset_cycle` arm (`:9565-9566`) and re-arms the
  ladder from `Gentle`. The hygiene record is grouped here and is a different
  animal: it is the only record in the part where a number *is* reported and is
  wrong, and it is the only one whose consequence is amplified by a second
  document, because the bands were calibrated on the measurement the code does not
  make.
- **Situation coverage against vacuous passes.**
  [render-a-hint-fragment-cap-binds-in-a-served-render](#render-a-hint-fragment-cap-binds-in-a-served-render),
  [nudge-b-one-block-carries-several-overlay-kinds](#nudge-b-one-block-carries-several-overlay-kinds),
  [render-a-render-is-deterministic-over-fixed-inputs](#render-a-render-is-deterministic-over-fixed-inputs).
  The two `sometimes` markers plus the property they protect. Hypothesis: the
  multiply-overlaid-block marker is the more urgent, because it gates the
  index-shift cluster above and the fixed mutator order at `:8233-8254`, and
  because three overlay kinds on one user text block is an ordinary state that no
  existing test constructs. The fragment-cap marker gates the only budget in 4e
  that binds in ordinary operation, which is why it is worth a marker at all
  rather than a unit test on `one_line_fragment`. The determinism record sits with
  them because it is what the markers are ultimately protecting: the cache
  discipline in the module header (`transform.rs:1-16`) rests on a replay
  producing identical bytes, and the one order-sensitive site
  (`tail_hygiene.rs:364`) is order-independent only because of an arc-id
  assignment in 4f (`ck_wire.rs:440-451`) that nothing local enforces.

### Cross-part relationships

Two ties are strong enough to state as relationships rather than resemblances,
and one of them closes a sibling part's open question.

**Tag numbering with multiple authorities was first found in 4b, and lens A shut
the projection route.** 4b's
[`speculative-tag-numbering-has-two-authorities`](../part-4b-transform/catalog.md#speculative-tag-numbering-has-two-authorities)
records that the engine assigns numbers in memory as `max(loaded tag_number) +
offset + 1` (`transform.rs:8029`) while the store re-reads `MAX(tag_number)` per
row and **skips** any input whose `block_id` already exists
(`mc-store/src/lib.rs:7488-7500`), so one skipped input desynchronises every later
number in the batch. That record named two possible triggers and left the choice
to 4e: a duplicate `block_id` inside one batch, or a batch whose
`existing_tag_ids` filter is computed from a stale baseline. Its open question was
explicit: "Can `compute_active_overlay_decisions` emit a `block_id` that already
has a tag? Unresolved, needs 4e."

**Lens A answers the first half: not from the projection.** `apply_once` returns
`TransformError::DuplicateBlockId` at `transform.rs:3354-3356`, and that check
runs before the mint at `:3806`, so a duplicate projection block id cannot reach
the batch. Worth stating precisely, because the mint loop would not have caught it
on its own: the loop's `existing_tag_ids` filter is a snapshot taken at
`:8595-8598` and never updated as rows are appended (`:7898-7920`). So one of 4b's
two doors is shut by an upstream guard rather than by the mint, and the surviving
trigger is the stale-baseline route.
[render-a-mint-batch-block-ids-are-unique-per-pass](#render-a-mint-batch-block-ids-are-unique-per-pass)
carries that residue and narrows it further: both cached hydration paths in
`load_cached_tags` are fenced on a SQLite-trigger-backed `generation` (`:7529`,
`:7540`), which a delete-and-reinsert advances even when count and max are
unchanged, so the remaining question is entirely about the triggers themselves.
That is a Part 3 read and it is recorded as unresolved on both sides rather than
answered here. The net effect on 4b is that its record's reachability now rests on
one condition instead of two, which is a narrowing, not an invalidation.

**The unbounded-with-no-reaper shape recurs in Parts 3, 4c and 4d, and this part
adds two more tables.** A prior evaluation cautioned against overstating this kind
of correspondence, so what is shared and what is not is stated separately.

What is genuinely shared is one sentence: a structure grows on caller-driven
traffic, its declared bound is either absent or does not bind, and nothing removes
an entry whose purpose is spent. Part 3 has it as unbounded session-history
retention where the render budget guard becomes the only backstop
([`core-decay-archive-termination-bound`](../part-3-store-core/catalog.md#core-decay-archive-termination-bound)).
Part 4c has a whole group of it, above all a session map with no removal path
whose growth then disables the pending-count half of its own budget
([`stagelc-transform-page-session-map-has-no-removal-path`](../part-4c-handlers/catalog.md#stagelc-transform-page-session-map-has-no-removal-path))
and completed replay results charged to no budget and reaped by no TTL
([`stagelc-completed-replay-results-are-uncharged-and-unexpiring`](../part-4c-handlers/catalog.md#stagelc-completed-replay-results-are-uncharged-and-unexpiring)).
Part 4d has it as a note count with no cap and no reaper, fully materialized per
poll
([`note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll`](../part-4d-facade/catalog.md#note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll)).
This part adds `mc_channel1_appends` and `mc_temporal_marks`
([nudge-b-channel1-append-rows-have-no-reaper](#nudge-b-channel1-append-rows-have-no-reaper)).

Four differences matter, and each changes what a test would do. First, the medium:
Parts 3, 4c and 4d are about resident memory or a rendered budget, where the cost
is paid continuously by the running process, while this part's rows are on disk,
where the cost is paid at load time and the row is otherwise inert. Second, the
second-order cost: 4c's session map converts unbounded growth into a *disabled
cap*, which is a strictly worse shape than accumulation, and nothing here does
that. Third, the resurfacing hazard is this part's alone: a stale overlay row is
inert only while its block is out of the projection, so the interesting failure is
not size but a reminder reappearing and quoting a token count from a session state
that no longer exists, which is why the record's second open question is a 4b
question about block-id reconstruction rather than a capacity question. Fourth,
the local contrast is sharper here than in the other parts: the third table in the
same family, `mc_user_hints`, *does* have a reaper (`mc-store/src/lib.rs:7736-7760`),
which makes the other two an omission rather than a uniform design decision.

Three smaller ties are recorded without being resolved. 4b's
`output-cache-replace-trails-the-accepted-commit` sits next to lens C's claim 13,
that the serialized-output cache records what was built rather than what was
served, since every `record_output_item` call precedes
`enforce_unique_tool_use_ids`; the two need a joint reading of the cache's
contract rather than a fix on one side. 4d owns `parse_tag_range_string`
(`lib.rs:15165-15210`) and `handle_ctx_reduce_facade` (`:10482-10588`), which
decide whether
[render-a-channel2-derived-tag-numbers-name-no-durable-row](#render-a-channel2-derived-tag-numbers-name-no-durable-row)
is a no-op or a misattributed reduction; lens A left that open for 4d. And 4f owns
both `ck_wire.rs:440-451`, which is what keeps
[render-a-render-is-deterministic-over-fixed-inputs](#render-a-render-is-deterministic-over-fixed-inputs)
true today, and the codec question behind
[nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report](#nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report),
namely whether any production path lets a non-module actor choose a tool-call id.
