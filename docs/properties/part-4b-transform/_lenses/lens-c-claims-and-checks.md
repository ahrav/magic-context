# Part 4b lens C: claimed guarantees and existing checks

One lens pass over sub-part 4b (transform pass engine and cache-state
transition). Attention focus: every checkable guarantee the code and the docs
state about transform behaviour, and every existing check that bears on one.
This lens proposes no property records. The state transition belongs to
[lens A](lens-a-transform-engine.md) and pass selection to
[lens B](lens-b-pass-selection.md); where a claim here corresponds to a record
there, this file cites the record rather than restating it.

Provenance: `/local/home/ahrav/scratch/magic-context`. Method contract in
[../../METHOD.md](../../METHOD.md).

**A provenance correction the reader needs first.** The task states `HEAD` =
`76cd6f41`. The repository's actual `HEAD` is `b5dc778e` ("fix(shm): close
lifecycle and evidence gaps"), one commit later. `git diff --stat 76cd6f41
b5dc778e` touches no file under `crates/mc-module` or `crates/mc-store`, so
every source line reference below is identical at both commits and is stated
without qualification. `.github/workflows/ci.yml` **does** differ between them
(+10 lines), so every CI reference is given at `76cd6f41` with the `b5dc778e`
line noted where it moved. `crates/mc-module` and `crates/mc-store` are clean
in the working tree.

**A scope note.** The task names `scheduler.rs` and the store-side transform
commit in `crates/mc-store/src/lib.rs` as part of 4b. The scope map's own 4b
definition
([../../part-4-module/_lenses/scope-map-and-risk-ranking.md:521-533](../../part-4-module/_lenses/scope-map-and-risk-ranking.md))
lists eight units that include neither: `transform.rs:1-7510`, `injection.rs`,
`compartment_coverage.rs`, `m0_compose.rs`, `healing.rs`, `m1_compose.rs`,
`retained_size.rs`, `divergence.rs`. It places `scheduler.rs` in 4f and does not
assign `mc-store` to Part 4 at all. This lens treats the eight units as scope
and `scheduler.rs` plus the `mc-store` commit as cited adjacent surfaces, the
same posture both sibling lenses took. The discrepancy is recorded as an open
question rather than resolved. One consequence worth flagging: the task's lead
about `load_cached_tags` at `transform.rs:7641` points at code the scope map
assigns to **4e** (`:7511-12623`); its call site at `:3391` is 4b's. Both
siblings noted the same split.

Every line reference below was read back individually. Two corrections to
references supplied in the task are noted inline.

## Claims register

Twenty-five claims, ordered by consequence. Each is a **lead**, never imported
truth: the quote establishes a contractual obligation and never that the code
satisfies it. "Implementing code" names where the obligation is discharged, not
that it is discharged correctly.

| # | Verbatim claim (source) | Implied property | Implementing code |
| --- | --- | --- | --- |
| C1 | "Each leaves the durable frozen-set UNCHANGED (the CAS simply does not advance)" (`transform.rs:1796-1797`) | Pass atomicity: a `TransformError` mutates nothing durable | `transform.rs:5565` `commit_transform`, guarded by `commit_required` (`:5559-5560`). **Two counterexamples**, both verified: `store.descend_lineage` (`:3312`) and `store.truncate_compartments_for_revert` (`:4646`). See leads L1, L2. |
| C2 | "Commit accepted cache state and its speculative overlays in one CAS transaction." (`mc-store/src/lib.rs:7259`) | All-or-nothing: cache state, pass trace, tag mints, temporal marks, hints, channel-1 appends, frontiers, ledger stamps and pending-drop deletions land together or not at all | `mc-store/src/lib.rs:7260-7600`, one fenced transaction |
| C3 | "Decisions from this request stay in memory until the final cache-state compare-and-swap accepts the pass." (`transform.rs:3505-3507`) | No mid-pass durable write | `transform.rs:4369-4371` open the clone region. False for `:3312` and `:4646`, same as C1 |
| C4 | "render byte-complete units ONLY on bust passes; replay verbatim on defer; a pure defer (boundary present, no delta) writes nothing" (`transform.rs:11-12`) | Render-once, replay-verbatim, and defer-writes-nothing | `is_bust_pass` (`:4439` = non-subagent and `Hard \| MigrateHard \| Soft`, `:4435-4438`) gates the render sites; `commit_required` (`:5559-5560`) gates the write |
| C5 | "synthetic items are stripped before any boundary / coverage / tail computation (PRIMARY)" (`transform.rs:13-14`) | Ordering invariant on the poison surface | `normalize_synthetic_todo_ingress` (`:2405`), the `req` shadow (`:3342`), the `live` filter (`:3357-3361`). Lens A record `synthetic-strip-precedes-every-coverage-read` |
| C6 | "the `mc_*` id namespace is reserved (BACKSTOP) so a synthetic block can never masquerade as the real boundary" (`transform.rs:14-15`); "a non-synthetic item bearing it is a contract violation" (`:90`) | Namespace reservation is enforced, not assumed | `transform.rs:3362-3365`, `RESERVED_ID_PREFIX` at `:91`. This is itself a production check |
| C7 | "`revision` is a digest over ALL byte-affecting m1 render inputs such that `render` is a pure function of what the digest covers: if the rendered bytes would differ, `revision` differs. NEVER a max-id counter" (`transform.rs:509-512`) | m1 cache-key completeness: no byte-affecting input escapes the digest | `m1_compose.rs` (230 lines, **zero tests**); consumed at `transform.rs:5157`, `:3064` |
| C8 | "The payload is captured at FREEZE and is authoritative thereafter — never re-read for an already-frozen target (a moving recent-window re-derive must not flip the bytes)." (`transform.rs:522-524`) | Frozen reduction immutability within an epoch | `validate_reduction_monotonicity` (`:6813-6825`), called at `:4283` |
| C9 | "Fail-loud monotonicity guard (runs EVERY pass, before classify) ... the set-membership trigger would SILENTLY skip it (already in keys) and serve the stale frozen payload. Error instead." (`transform.rs:6809-6812`) | Every pass validates, and a conflict errors rather than silently serving stale bytes | `transform.rs:6817-6824`; `TransformError::ReductionConflict` (`:1811`), message at `:1851-1853` |
| C10 | "Both are reached ONLY on the Hard/MigrateHard arm — never SOFT, defer, m1 compose, or the tail splice ... determinism ... is what preserves byte-identical replay between HARDs" (`transform.rs:2088-2092`) | The token estimator cannot change bytes outside an intentional HARD | Injected through `apply_once_with_estimator` (`:2174`); the doc at `:2171-2173` names the test seam ("tests can inject a panicking/counting one to prove the estimator is HARD-only") |
| C11 | "It is pure given the store contents + `now_ms` + `budget`: same inputs → same bytes, the property the frozen-m0 cache depends on. The expiry cutoff (`now_ms`) is passed in ... never read here from a live clock" (`m0_compose.rs:6-9`) | m0 byte determinism, no ambient clock | `m0_compose.rs` (403 lines, **zero tests**) |
| C12 | "Pure over a chronological compartment list ... validates that stored compartment ranges are strictly increasing and non-overlapping" (`compartment_coverage.rs:4-8`) | Coverage-set validity is checked, not assumed | `resolve_coverage` (`compartment_coverage.rs:180`); rejects `next.start <= prev.end` per `:177` |
| C13 | "The anchor can then never be present, so reconcile can never clear and the pass loops as an unbounded phantom HARD. Fail loud" (`transform.rs:1827-1831`) | An unbounded-HARD loop is prevented by a loud rejection | `TransformError::BoundaryNotPresent` raised at `:4723`, `:4731`, `:4954`, `:5091`; message at `:1872-1874` |
| C14 | "A post-read probe makes a concurrent mutation retry before its bytes reach the transform, and trigger-backed generations force a cold refill for replacement or deletion." (`transform.rs:7636-7638`) | Tag hydration is correct under concurrent mutation. States the retry as the mechanism and **states no bound on it** | `load_cached_tags` (`:7639`), an unbounded `loop` at `:7644`; called from the engine at `:3391`. Task cited `:7641`; that is the signature's closing line. Lens A `pass-firing-work-bounded-by-max-cas-retries`, lens B `sel-cas-retry-budget-bounded-tag-hydration-unbounded` |
| C15 | "A no-op truncation returns the current epoch/version without rewriting the meta blob." (`mc-store/src/lib.rs:9013-9014`) | Revert-truncate idempotency across a CAS retry | `mc-store/src/lib.rs:9015`; the no-op arm. Lens A `revert-epoch-bumps-at-most-once-per-logical-recut` depends on exactly this |
| C16 | "A valid current shape: EXACTLY one `m0`, EXACTLY one `m1` ... An initialized state missing `m0`/`m1`, or carrying any other key, is an unknown shape (rejected, never cleared)." (`transform.rs:6197-6199`) | Cache-state shape validity; a corrupt frozen set is never destructively cleared | `valid_m0m1_shape` / `cached_m1_missing` (`:6200`); `TransformError::UnknownShape` (`:1807`, doc `:1806`) raised at `:2890`, `:2900`, `:3077`, `:3082`, `:4558` |
| C17 | "`age_basis_tag` is captured durably by the caller with the same commit as these units, so newly minted tags cannot change this cycle's eligible population. The original tag source is authoritative, so a later tier shift never compresses an already-compressed payload." (`transform.rs:6299-6302`) | Caveman eligibility determinism against same-pass mints | `new_caveman_units` (`:6303`); basis captured at `:4491-4499`. Lens B `sel-caveman-eligibility-ladder-deterministic-over-frozen-basis` |
| C18 | "`boundary_present` is deliberately NOT a field: it is a cache-correctness decision ... never caller-supplied (a caller-supplied value would be a poison surface — a crafted array could force a wrong replay or reconcile)" (`transform.rs:653-656`) | The replay-vs-reconcile decision is store-derived, not request-derived | `resolve_boundary_state` (`:7167`); `TransformRequest` (`:660`) carries no such field |
| C19 | "Pure state-transition functions; durable state enters as parameters and exits in return values." (`scheduler.rs:3-4`) | Pass-class production is a pure function | `scheduler.rs` (1,449 lines). Lens B lead 7 shows the *inputs* carry process-local state even though the functions are pure |
| C20 | "the numbers are estimates, but they cannot diverge between those paths" (`retained_size.rs:6`) | One accounting routine feeds both cache admission and telemetry, so budget and reported retention agree | `retained_size.rs` (212 lines, **zero tests**); consumed by every 4b/4e cache budget |
| C21 | "a new sequence that retains every old entry in order and only appends blocks is normal tail growth" (`divergence.rs:30-31`); "It only reports a mismatch when an existing served position changes" (`:4-5`) | First-divergence attribution never fires on pure tail growth | `first_divergence` (`divergence.rs:32`) |
| C22 | "Bust passes may replace or clear the frozen unit. Defer passes never build from the current state and never clear" (`injection.rs:296-297`); "the deterministic `mc_synthetic_todo_<hash>` call id, the byte-exact injected pair" (`:2`) | Synthetic-todo freeze is bust-only and byte-deterministic | `advance_injection` (`injection.rs:300`); id builder at `:120`, pair builder at `:127` |
| C23 | "Defer passes don't run caveman, and tier assignments are persisted in `tags.caveman_depth` so the next pass re-compresses only the tags that have shifted tiers." (`CONFIGURATION.md:742`) | Caveman is bust-gated and incremental | Gate at `transform.rs:6312-6314`. **Note the register's own tension with C17's "never compresses an already-compressed payload"**: `:6366-6369` is a live `assert!` guarding exactly that relation. Lens B leads 5 and 6 |
| C24 | "Every drop resolves to the same deterministic placeholder as the normal drops, so defer passes replay byte-for-byte identically. **When `smart_drops` is off, the messages sent to the model are byte-identical to the age-based-only behavior** — the entire feature is inert." (`CONFIGURATION.md:763`) | Byte-identical defer replay, and a feature-off inertness claim | `smart_drops` parsed at `config.rs:467-468`, defaulted `false` at `:135`; consumed via the selector gate at `transform.rs:4201-4258`. The byte-identity half has no Rust check |
| C25 | "If `transform_mode: \"rust\"` is also configured, compaction-off mode resolves to the TypeScript transform and emits one frozen boot warning. There is no Rust reduced-mode contract in this cycle." (`CONFIGURATION.md:427`) | The Rust additive engine is not the serving path when compaction is off | **Implemented, in TypeScript**: `packages/plugin/src/config/transform-mode.ts:22-27` downgrades, called from `packages/plugin/src/config/index.ts:605`. See lead L3 for the reachability consequence for `transform.rs:2711-3219` |

Two further claims are recorded but not counted in the twenty-five, because
both sibling lenses already own them as leads: `transform.rs:80-81` ("the module
is the single writer in the daemon case", lens A lead 2) and
`cortexkit-cache-core:214-215` ("`reconcile_pending` ... is cleared only by a
HARD rematerialize, never a SOFT", lens A lead 3).

### Claims with NO implementing code in this module

Four, all from the configuration surface, all already established by lens B and
re-verified here rather than rediscovered.

| Claim | Source | Status |
| --- | --- | --- |
| `protected_tags`, `number` (1–100), default `20`, documented as a module config key | `CONFIGURATION.md:165`, example at `:795` | **NOT FOUND** in `crates/mc-module/src/config.rs`: `grep -c protected_tags` returns 0. The only source is the request serde default `20` (`transform.rs:893-895`). `apply_claude_code_config_controls` (`lib.rs:173-193`) does not set it |
| `execute_threshold_tokens`, per-model map, "Clamped to `90% × context_limit` with a warn log" | `CONFIGURATION.md:168`, `:319-338` | **NOT FOUND**. `McModuleConfig` has no such field (`config.rs:82-116`); `scheduler_config` hardwires `execute_threshold_tokens: None` (`transform.rs:6109`). The clamp and warn exist only in TypeScript |
| `execute_threshold_percentage` accepts an `object` with per-model maps | `CONFIGURATION.md:167`, example at `:791` | **NOT FOUND**. Read with `number_at` (`config.rs:430-431`, `:515-517`), which is `as_f64` filtered to finite (`:631-636`); an object yields `None` silently. `ExecuteThresholdConfig::ByModel` exists (`scheduler.rs:112-113`) and the module never constructs it |
| Documented lower bound `20` for `execute_threshold_percentage` | `CONFIGURATION.md:167` | Enforced bound is `1` (`config.rs:568-570`). Upper bound `90` matches |

So the count is: **25 claims in the register, 4 with no implementing code in
this module** (all four are configuration keys the documentation presents as
module-owned and whose behaviour, where it exists at all, lives on the
TypeScript side of the wire). The verified answer to the task's fourth known
lead is therefore yes: the configuration documentation does claim these take
effect, and for `protected_tags` and both threshold shapes it is wrong about
this module.

## Contract-vs-code leads

Both sides cited. None resolved in the documentation's favour. L1 and L2 are the
task's supplied leads, verified here and folded in rather than rediscovered; L3
through L7 are new to this lens.

**L1. Two writes commit outside the single fenced transaction, and the error
doc says otherwise.** Verified. `store.descend_lineage` at `transform.rs:3312`
commits before the array-validity guards at `:3355` (`DuplicateBlockId`), `:3364`
(`ReservedId`) and `:3371` (`OrdinalViolation`).
`store.truncate_compartments_for_revert` at `:4646` commits ~900 lines before
`:5565`, re-points the pass's own CAS expectation at `:4651` and adopts the new
epoch at `:4652`; a `CoverageGap` at `:4704` is raised after it. The surrounding
prose is C1 and C3: `:1796-1797` says every `TransformError` leaves durable
state alone because "the CAS simply does not advance", and `:3505-3507` says
decisions "stay in memory until the final cache-state compare-and-swap accepts
the pass". Read narrowly against `core.frozen_units` both are true. Read as
written both are false on these two paths, where the CAS does not advance **and**
durable state has changed. So a pass is up to two committed transactions, and
neither early write is rolled back if the pass later errors. Lens A owns this as
`lineage-descent-write-precedes-the-array-validity-guards` and
`revert-truncate-commits-outside-the-terminal-cas`.

**L2. Defer omits the compartment fence while still writing a compartment
watermark, and the commit doc claims one fenced CAS.** Verified.
`transform.rs:5574` passes `compartment_max_seq: is_bust_pass.then_some(..)`,
and `is_bust_pass` (`:4439`) excludes Defer because it requires
`Hard | MigrateHard | Soft` (`:4435-4438`). With `None`, the store's
compartment-sequence check at `mc-store/src/lib.rs:7378-7387` is skipped
entirely. Meanwhile the Defer arm at `transform.rs:5156-5159` writes
`meta.coverage_compartment_seq` from `m1_signal`, inside the `SoftPlus` block
whose `core.step` is at `:5151-5155`. The surrounding prose is C2: the store's
own doc calls this "one CAS transaction", which is true of the writes and silent
about which predicates guard them. Lens A owns this as
`defer-commit-carries-no-compartment-fence`.

**L3. The Rust compaction-off engine may be unreachable on the shipped leg, and
its own error path assumes it runs.** New. Lens A classified
`apply_additive_only` (`transform.rs:2711-3219`, selected at `:3233`) as
`explicit-config-only` on the basis that `compaction_enabled` defaults to `true`
(`config.rs:123`). That is right as far as it goes, but the enabling condition
is narrower than "a user sets the flag". The module reads
`/compaction/enabled` from the user tier of the same `magic-context.jsonc`
(`config.rs:433-434`; project tier is warned and ignored at `:520`), and the
shipped OpenCode plugin reads that same resolved flag and **downgrades
`transform_mode` from `rust` to `ts`** when it is false
(`packages/plugin/src/config/transform-mode.ts:22-27`, called from
`packages/plugin/src/config/index.ts:605`, warning string at
`transform-mode.ts:12-13`). CONFIGURATION.md:427 states this. So on that leg the
Rust transform op is not the serving path precisely when the additive branch
would be selected. What makes this a lead rather than a curiosity: the additive
engine contains a production `unreachable!("reject returned before
composition")` at `transform.rs:3068`, so the branch least likely to be
exercised is the one carrying a hard panic. Whether another host (an explicit
`subc` daemon, Pi, or the direct fixture) can reach it with compaction off is
unresolved; `compaction_enabled` appears nowhere in `packages/`, so the module's
value never comes from a request field.

**L4. A production panic path is gated by an environment variable and neither
sibling reported it.** New. `assert_prefix_projection_equivalent`
(`transform.rs:2344-2358`) contains two bare `assert_eq!` — "incremental prefix
projection byte drift" (`:2349-2353`) and "incremental prefix projection state
drift" (`:2354-2357`). Its gate,
`prefix_projection_differential_enabled` (`:2337-2342`), is
`cfg!(test) || MC_PREFIX_PROJECTION_DIFFERENTIAL == "1"`. The env arm makes both
asserts live in a release build. No doc comment mentions a failure mode, and no
entry in `docs/` describes the variable. Compare the neighbouring drift check at
`:5451-5479` ("serialized output cache drift", `:5478`), which is `#[cfg(test)]`
and therefore cannot fire in production; the two were evidently intended as a
pair and only one ships.

**L5. `docs/AUDIT-KNOWN-ISSUES.md` describes a different transform pipeline and
says so nowhere near the entries.** New. The file's own framing (`:3-14`) tells
auditors these findings are settled and asks them to argue against the recorded
reasoning. Fifty-one lines mention transform, compaction, bust, or defer, and
every one of them is about the TypeScript implementation: `A24`
(`:407-425`) is about `messages-transform.ts` failing open, `A8`
(`:126-136`) about m[1] TTL expiry, `A15` (`:316-325`) about missing cache-bust
signals. `A24` is the sharpest case, because it makes exactly the claim 4b needs
about the Rust engine and makes it about the other implementation: "A future
hardening would stage trim+inject atomically so a throw leaves the array fully
transformed or fully untouched; that is a core-path refactor ... and is
deferred." The Rust engine's answer to that question is C1/C3 plus the two
counterexamples in L1. **No entry in the file covers the Rust transform,
`apply_once`, the cache-state CAS, or either out-of-transaction write.** Lens A's
five leads and lens B's eight are untracked there, as is everything above.

**L6. The cache-safety claims in CONFIGURATION.md are written as product
guarantees and are discharged, where at all, in TypeScript.** New. Four
instances, each verified as prose and none traced to a Rust check: markers are
"idempotent by regex detection ... re-running the injector on any transform pass
produces the same output" (`:659`); the user hint is "replayed exactly (from a
deterministic per-message cache), so the append is idempotent and never rewrites
cached content" (`:716`); caveman "Defer passes don't run caveman" (`:742`, = C23);
smart drops "defer passes replay byte-for-byte identically" and are
"byte-identical" when off (`:763`, = C24). The caveman gate does exist in Rust
(`transform.rs:6312-6314`). The three idempotency-and-byte-identity claims are
the strongest determinism statements anywhere in the documentation for this
sub-part, and the register could find no Rust assertion, test name, or guard
that states them.

**L7. Three scope files carry purity or non-divergence claims and have no tests
at all.** New. `m0_compose.rs` claims "same inputs → same bytes, the property
the frozen-m0 cache depends on" (`:6-9`, = C11) across 403 lines with zero
`#[test]`. `m1_compose.rs` (230 lines) has zero tests and zero doc comments; it
carries no claim of its own, yet it is the producer for C7's digest-completeness
claim, which is stated 279 lines away in `transform.rs:509-512`.
`retained_size.rs` claims its estimates "cannot diverge between those paths"
(`:6`, = C20) across 212 lines with zero tests. A claim whose implementing file
has no test is not a contract-versus-code disagreement, so these are recorded as
leads rather than contradictions; the point is that the claim and the check are
in different files, or the check is absent.

## Conventionally-enforced-only claims

Claims with no mechanism: no assert, no type, no test, no guard. A future edit
breaks them silently.

1. **C5's ordering, past the shadow.** The PRIMARY poison invariant is enforced
   by a rebinding, not a type: `let req = rebased_req.as_ref().unwrap_or(ingress_req)`
   at `transform.rs:3342` makes every later `req.messages` read see normalized
   flags. Any future read placed above `:3342` silently escapes the invariant
   with no error. Lens A verified the shadow covers all current reads and records
   the fragility in `synthetic-strip-precedes-every-coverage-read`.

2. **C4's render-once discipline.** `is_bust_pass` (`:4439`) is a local `bool`
   consulted at each render and freeze site. Nothing prevents a new render site
   from omitting the check; the compiler cannot help.

3. **One `core.step` per pass.** Enforced by control-flow shape plus the *move*
   of `boundary_token: String` (`:3540-3544`) into whichever `PassInput` runs.
   Lens A's `exactly-one-core-step-executes-per-pass` notes that cloning the
   token instead of moving it silently removes the compiler's help.

4. **C10's HARD-only estimator.** The mechanism is that the two call sites
   happen to sit on the Hard/MigrateHard arm. The doc at `:2171-2173` names the
   intended proof ("tests can inject a panicking/counting one"), which locates
   the enforcement in a test rather than in the production path.

5. **C19's purity, as a reader will read it.** `scheduler.rs:3-4` is accurate
   about the functions. The property a reader draws from it, that the pass
   decision is reproducible from request plus store, is enforced by nothing:
   lens B's `sel-eligibility-reads-process-local-scheduler-state` shows
   `observed_last_response_at_ms`, `historian_active`, `wrapup_active` and
   `now_ms` all enter from process-local state.

6. **C20's non-divergence.** "They cannot diverge between those paths" is true
   only while both callers keep calling the same routine. Nothing enforces that,
   and `retained_size.rs` has no test.

7. **C7's digest completeness.** "A digest over ALL byte-affecting m1 render
   inputs" is a whole-program obligation on every future edit to
   `m1_compose.rs` and `memory_render.rs`. It has no mechanism and no test in
   either file.

8. **C15's idempotency precondition.** The no-op arm makes a *retried* truncate
   idempotent only if the recomputed `keep_through_seq` is never smaller than
   the surviving max sequence. That rests on `surviving_revert_prefix_seq`
   (`transform.rs:7275-7284`) being a prefix scan over
   `load_compartments`'s `ORDER BY sequence ASC`. Neither side asserts the
   relation. Lens A's `revert-epoch-bumps-at-most-once-per-logical-recut` carries
   the reasoning at `Confidence: medium`.

## Existing-check inventory

Every status below is **unaudited**. Test adequacy belongs to
`/testing:invariant-test-review` and production-guard adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

### In-crate tests (clustered, counts and line ranges)

`transform.rs` holds **285** test attributes in total: **280** in the main flat
module `mod tests` (`:12626-29439`, attributes `:12644-29424`, first test fn
`:12645 claude_code_cache_ttl_mapper_is_lossy_because_provider_vocabulary_is_limited`,
last `:29425 channel2_directive_id_hashes_session_and_arming_watermark_deterministically`)
plus **5** in `mod nudge_formula_tests` (`:9628-9783`), which is 4e scope.

**How many of the 280 are in 4b scope.** The module is flat, has no inner
`mod`, and is read as evidence by both 4b and 4e, so no structural split exists.
Attribution was done mechanically, by parsing each test body and matching the
entry points it calls:

| Bucket | Tests | Basis |
| --- | --- | --- |
| Drive a whole pass | **210** | Body calls `run(`, `transform(`, `transform_with_projection(`, or `apply_once_with_estimator(`. `run` is the shared fixture driver at `:14331-14338`; it calls `transform` at `:14334` |
| Unit-test a 4b helper only | **16** | Body names a 4b-only symbol (boundary/coverage/reduction/identity/lineage/synthetic-todo/additive/request-decode) and no 4e symbol |
| Unit-test a 4e helper only | **22** | Body names a 4e-only symbol (output build, overlay, tag mint, strips, hints, channel decisions) and no 4b symbol |
| Both helper families | **5** | — |
| Neither, unclassified | **27** | Small serde, timing, geometry and TTL unit tests |

So **226 of the 280 reach 4b code** (210 pass-drivers plus 16 4b-only units).
Because a pass renders output, the 210 traverse 4e as well and are shared
evidence, not 4b-exclusive. The remaining 54 are 4e-only, both, or
unclassified. **Limit on this number:** the attribution is a symbol match over
test bodies, not coverage instrumentation. There is no coverage measurement in
this repository, so the split is structural and the 27 unclassified tests were
not hand-read.

Scope-file totals, each re-counted at `HEAD`:

| File | Tests | `mod tests` | Notes |
| --- | --- | --- | --- |
| `transform.rs` | 280 + 5 | `:12626`, `:9629` | See split above |
| `injection.rs` | 18 | `:458` | `#[cfg(test)]` islands also at `:11`, `:19`, `:362` |
| `compartment_coverage.rs` | 7 | `:217` | 413-line file |
| `healing.rs` | 5 | `:161` | — |
| `divergence.rs` | 7 | `:104` | — |
| `m0_compose.rs` | **0** | none | 403 lines, carries C11 |
| `m1_compose.rs` | **0** | none | 230 lines, producer for C7 |
| `retained_size.rs` | **0** | none | 212 lines, carries C20 |
| `scheduler.rs` (adjacent) | 16 | `:919` | Lens B cites `:1056-1061`, `:1127` |

**In-crate 4b total: 263** (226 in-scope `transform.rs` plus 18 + 7 + 5 + 7 in
the four smaller files that have any). **Executed in CI: zero.** See the next
section.

Store-side transform-commit tests, in `crates/mc-store/src/lib.rs`, verified by
name and line:

| Line | Test |
| --- | --- |
| `:14207` | `transform_session_root_lineage_is_cache_committed_and_pruned_on_reopen` |
| `:14282` | `transform_session_roots_canonicalize_writes_and_match_legacy_symlink_rows` |
| `:14425` | `transform_snapshot_resists_commit_between_state_and_overlay_reads` |
| `:14479` | `transform_snapshot_keeps_row_version_and_overlays_from_one_commit` |
| `:14562` | `transform_cas_conflict_leaves_every_overlay_table_empty` |
| `:18267` | `truncate_compartments_for_revert_deletes_suffix_and_bumps_epoch` |

`:14562` is the closest existing check to C1/C2, and `:14425`/`:14479` are the
closest to the read-linearization half. `:18267` covers C15's bump path; nothing
covers its no-op arm.

**`#[ignore]`, `should_panic`, and property tooling: none found.** No `#[ignore]`
and no `should_panic` in any of the eight scope files. No `loom`, `shuttle`,
`miri`, `proptest`, `quickcheck` or `arbitrary` anywhere in the 4b path. Every
check is a hand-written fixture case.

### Integration and CI status (with workflow line refs)

**Nothing in the 4b scope executes in CI.** Three mechanical facts, each
verified against all five files in `.github/workflows/` at `76cd6f41`.

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`**, at `ci.yml:168` at
   `76cd6f41` (`:172` in the working tree and at `b5dc778e`). `--test
   lifecycle_cli` selects one integration binary and does **not** build the
   `--lib` target, so no in-crate `mc-module` unit test is compiled, let alone
   run. The other `mc-module` step is build-only: `cargo build -p mc-module
   --bin ck-mc-host` at `:165` (working tree `:169`). The full set of Rust test
   invocations at `76cd6f41` is `ci.yml:131`, `:168`, `:173`, `:174`, `:180`,
   `:181`, `:183`, `:186`; seven of the eight target `mc-host`,
   `mc-shm-native`, or `mc-shm-transport`. There is no `cargo test -p mc-module
   --lib` and no `--workspace` test run: the only `--workspace` cargo commands
   are `cargo fmt --check` (`:477`) and, adjacent to it, `cargo check -p mc-core
   --no-default-features` (`:484`).
2. **`crates/mc-store` appears in no workflow at all.** So the store-side commit
   transaction that discharges C2, and its six tests above, live in a crate no
   automation touches.
3. **`scripts/test-rust.sh` (`cargo nextest run --workspace`) and the
   `test:rust-e2e` lane exist and no workflow calls either.** `test:rust` and
   `test:rust-e2e` are wired into root `package.json` (`check:all` chains
   `test:rust`), and a search of `.github/workflows/` for `rust-e2e`,
   `incidents:rust`, `test:rust` and `test-rust.sh` returns zero matches. The
   one Rust end-to-end selection mode the repository has,
   `run-test-selection.ts --mode rust`, never runs.

**Integration tests exercising a transform, in `crates/mc-module/tests/`:** two,
neither in CI.

| File | Tests | Transform-relevant | In CI |
| --- | --- | --- | --- |
| `direct_host.rs` | 6 | `:67` `readiness_permissions_catalog_and_real_unary_transform` and `:149` `direct_primary_replays_transform_state_across_fixture_restart` drive a real `"kind": "transform"` request (`:110`, `:173`) through the fixture host | **No** |
| `prepared_output.rs` | 10 | `:35` `transform_segments_preserve_existing_golden_bytes`, plus `:151`, `:167`, `:255`, all against `PreparedOutput::transform_segments` — the 4d response encoder, not the pass engine | **No** |
| `host_adapter.rs` | 4 | `:163-172` asserts on the **text of the production source** (`split("fn respond_transform")`, then `contains`/`!contains`), so it is a source-shape gate, not an execution test | **No** |
| `boundary_counter_durability.rs` | 1 | Uses `mc_core::CoreState` (`:6`, `:17`) only; adjacent, not a transform test | **No** |
| `lifecycle_cli.rs` | 12 | **Zero** mentions of `transform` | Yes (`ci.yml:168`) |
| `broca_roundtrip.rs`, `release_contract_conformance.rs` | 2, 3 | none | **No** |

The one integration binary CI runs is the one with no transform coverage.

### TypeScript-side gates

**A TypeScript transform gate exists, it runs on every pull request, and it does
not test this Rust code.** This is the single easiest mistake to make about 4b's
coverage, so it is stated precisely.

The gate is `ci.yml:249` at `76cd6f41`, step "Test", running `bun run test`,
which is `sh scripts/test-shard.sh packages/plugin && ...` (root
`package.json`). `test-shard.sh` runs `bun test` over the whole `packages/plugin`
tree, sharded, so every `*.test.ts` under it executes. Three files in that set
bear on transform behaviour:

| File | Tests | What it actually tests |
| --- | --- | --- |
| `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts` | 70 | The TypeScript **caller** of the Rust module. The module transport is a hand-written stub: `const moduleClient: RustModeModuleClient = { call: async ({ method }) => ... }` returning canned objects such as `method === "transform" ? { native_messages: native } : { ok: true }` (`:851-859`). It asserts the request the TS side builds, the method sequence (`:867`), the acked sequence and watermarks (`:868-869`), and that the stubbed output reaches `output.messages` (`:870`). No Rust code runs |
| `packages/plugin/src/hooks/magic-context/lkg-transform-replay.test.ts` | 15 | The TypeScript last-known-good replay path, via `createMessagesTransformHandler` (`:2`) |
| `packages/plugin/src/config/transform-mode.test.ts` | 6 | `resolveTransformMode`, including "downgrades rust to ts with one warning when compaction is off" (`:69`). This is the only executing check on C25 / lead L3, and it tests the TypeScript resolver |

**No plugin test invokes the Rust module.** A search of
`packages/plugin/src/**/*.test.ts` for `ck-mc-host`, `mc-module`, a rust
`transform_mode` spawn, or `rustTransform` returns zero matches; there is no
`spawn`, `child_process`, or napi call in `rust-mode-transform.test.ts`.

Separately, `packages/plugin` and `packages/pi-plugin` contain a large executing
suite over a **parallel TypeScript transform implementation** of the same
contract: `compartment-runner*.test.ts` (eight files),
`boundary-execution*.test.ts`, `inject-compartments*.test.ts`,
`m0m1-taxonomy.test.ts`, `cache-busting-signals.test.ts`,
`degraded-reanchor.test.ts`, `transform-authority-flip-back.test.ts`, plus the
Pi equivalents. These run on every pull request and cover the same
cache-discipline vocabulary the Rust header uses. They are coverage of a
different implementation, and `docs/AUDIT-KNOWN-ISSUES.md` is written about that
one (lead L5). This is the same shape Part 4a found for the historian
(`../part-4a-historian/existing-checks.md:76-129`): the only executing per-PR
coverage measures the TypeScript twin. **Nothing executing anywhere compares the
two transform implementations.** Unlike the historian, 4b has no in-crate
TypeScript-oracle golden driver at all — there is no 4b counterpart to
`historian_validate.rs:1384 validate_golden_matches_typescript_oracle`.

### Production assertions and guards (clustered)

**Panicking sites in production code, four, clustered by liveness.**

- **Live in release, unconditionally: one.** `transform.rs:6366-6369`, a bare
  `assert!` (not `debug_assert!`) inside `new_caveman_units`:
  `compressed.len() <= existing.frozen_payload.len()`, message "caveman deeper
  tier grew frozen payload for {block_id}". This is the production panic path
  the sibling lens reported; verified at `HEAD`, in 4b scope, and reachable only
  when caveman is enabled (`config.rs:76` defaults it `false`). Lens B owns it as
  `sel-caveman-deeper-tier-growth-panics-in-production`. Its guarded relation is
  C17/C23's "never compresses an already-compressed payload"; `:6370-6374` keeps
  the shallower bytes on a tie while `:6378` still records the deeper depth.
- **Live in release under an environment variable: two.**
  `transform.rs:2349-2353` and `:2354-2357`, the two `assert_eq!` in
  `assert_prefix_projection_equivalent`, gated by
  `MC_PREFIX_PROJECTION_DIFFERENTIAL == "1"` (`:2340`). See lead L4. Neither has
  a named test and neither is documented.
- **Live in release, in the compaction-off engine: one.**
  `transform.rs:3068`, `PassPlan::Reject(_) => unreachable!("reject returned
  before composition")`, inside `apply_additive_only`. See lead L3 for why this
  is the least-reachable branch in the sub-part.
- **Compiled out of release: one.** `transform.rs:7506`,
  `debug_assert!(folded_by_advance || coverage_shrunk_on_bust)` in
  `reanchor_kept_synthetic_todo_if_folded_or_shrunk`. The comment at `:7502-7505`
  explains the invariant it stands in for.
- **`#[cfg(test)]`-only: one.** `transform.rs:5478`,
  `assert_eq!(cached_bytes, fresh_bytes, "serialized output cache drift")`,
  inside the block opening at `:5451`. Lens A calls it "the strongest check in
  the engine" and it cannot fire in production.

**The other seven scope files have almost nothing.** Verified per file over
production lines only: `injection.rs` (prod `1-456`), `compartment_coverage.rs`
(`1-215`), `healing.rs` (`1-159`), `divergence.rs` (`1-102`), `m0_compose.rs`,
`m1_compose.rs`, `retained_size.rs` (all-production). Zero `assert!`, zero
`debug_assert!`, zero `panic!`, zero `unreachable!`. Two infallible-by-
construction `expect`s: `compartment_coverage.rs:196`
`.expect("non-empty checked above")` and `retained_size.rs:67`
`.expect("CK wire values must serialize for accounting")`. `scheduler.rs`
(adjacent) has two, both static regex compilation: `:875` and `:910`.

**`transform.rs:1-7510` has 20 `unwrap`/`expect` in production**, and every one
sampled is infallible-by-construction: JSON serialization of a
`serde_json::Value` (`:181`, `:183`, `:206`, `:3602`, `:3641`, `:3716`),
`write!` into a `String` (`:2474`, `:2541`), and mutex acquisition (`:497`,
`:2318`, `:2327`). None depends on untrusted runtime data.

**Guard clusters. This is where 4b's invariants actually live, because there are
almost no assertions.** All unaudited.

- **The four ingress-validity guards**, in straight-line order at the top of
  `apply_once`: `DuplicateBlockId` (`:3355`), the `live` non-synthetic filter
  (`:3357-3361`), `ReservedId` (`:3362-3365`, the C6 backstop), and
  `OrdinalViolation` (`:3367-3372`). All four sit **after** `descend_lineage`
  (`:3312`); that ordering is lead L1.
- **The monotonicity guard**, `validate_reduction_monotonicity`
  (`:6813-6825`), called at `:4283` on every pass before `classify`. Discharges
  C8 and C9.
- **The coverage and boundary rejections**: `CoverageGap` at `:4603`, `:4704`,
  `:4934`, `:5066`; `BoundaryNotPresent` at `:4723`, `:4731`, `:4954`, `:5091`.
  These discharge C13. `:4704` is downstream of the truncate (lead L1).
- **The shape rejections**, `UnknownShape` at `:2890`, `:2900`, `:3077`,
  `:3082`, `:4558`, backed by `valid_m0m1_shape`/`cached_m1_missing`
  (`:6200`). Discharge C16, including its "never cleared" half.
- **The strict-ordering check** in `resolve_coverage`
  (`compartment_coverage.rs:180`), which rejects `next.start <= prev.end`
  (`:177`) while deliberately allowing coordinate gaps. Discharges C12.
- **The store-side commit predicates**: row-version CAS, claim-vector match
  (`mc-store/src/lib.rs:7374-7377`), and the bust-only compartment-sequence
  re-read inside the transaction (`:7378-7387`). The last is the one Defer skips
  (lead L2).
- **The two output-integrity guards**, `assert_no_orphaned_tool_arcs`
  (`transform.rs:11172-11225`) and `enforce_unique_tool_use_ids`
  (`:11231-11305`). These are 4e's scope, but they belong in 4b's inventory for
  one reason: the shared test driver `run` (`:14331-14338`) calls
  `assert_no_duplicate_tool_use_ids` (`:14335`) and
  `assert_no_orphaned_tool_arcs` (`:14336`) on every response. So all 210
  pass-driving tests assert both output invariants as a side effect, which makes
  them the most-exercised checks in the sub-part and the least explicitly
  targeted.

**Fault-injection seams.** One, and it is test-only:
`run_transform_attempt_hook` (`transform.rs:2323-2333`), fired at `:5563-5564`
under `#[cfg(test)]`, immediately before `commit_transform`. It is the seam a
CAS-conflict test uses. There is **no seam between the two out-of-transaction
writes and the terminal commit**, so C1's atomicity obligation on the `:3312`
and `:4646` paths is currently unfalsifiable by a Rust test without new code —
the same structural gap Part 4a recorded for the publish transaction
(`../part-4a-historian/existing-checks.md:395-402`).

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any executed check
proves.

1. **The whole sub-part is the quietest thing in it.** 263 in-crate tests and 6
   store-side commit tests execute nowhere. The only `mc-module` binary CI runs,
   `lifecycle_cli`, contains zero mentions of `transform`. `mc-store` is in no
   workflow. `scripts/test-rust.sh` and `test:rust-e2e` both exist and neither
   is invoked. Everything below is second-order until this changes, because
   anything added is added to a suite no automation executes.

2. **The two out-of-transaction writes have no seam, so C1 is untestable, not
   merely untested.** `descend_lineage` (`:3312`) commits 43 lines before the
   guards that can reject the same pass, and
   `truncate_compartments_for_revert` (`:4646`) commits ~900 lines before
   `:5565` with a `CoverageGap` at `:4704` inside that window. The only hook in
   the engine (`:5563-5564`) fires after both, so no test can land a fault
   between either write and the terminal commit. Existing coverage reaches only
   the success paths: `:19870`
   `reconcile_rematerialize_with_unrecut_store_truncates_and_refolds_prefix`
   drives the truncate and commits; nothing drives a malformed array through a
   lineage-switch pass and then asserts the target key is untouched. Compounding
   it, the fenced-transaction wrapper that defines C2's boundary lives in a
   sibling repository (`cortexkit-store`), and the cache-state machine C16 and
   the transition rules depend on lives in another
   (`../commons/crates/cortexkit-cache-core`, a path dependency at
   `Cargo.toml:15`, checked out at a different commit) — so neither can change
   with a diff visible to this repository's CI.

3. **The unbounded tag-hydration loop is the one place a claim substitutes for a
   bound.** `load_cached_tags`'s doc (`:7636-7638`, C14) states the post-read
   probe as the correctness mechanism and states no bound; the `loop` at `:7644`
   has two exits (`continue` at `:7678`, fallthrough at `:7695`) and no attempt
   counter, 5,000 lines below the explicitly bounded CAS loop
   (`MAX_CAS_RETRIES = 8` at `:82`, compared at `:2284`). It is called on every
   compaction-enabled pass at `:3391`. No test drives concurrent tag mutation
   against it. The dispatch wedge detector at `lib.rs:353-508` exists for
   exactly this symptom class. Both siblings reached this independently
   (`pass-firing-work-bounded-by-max-cas-retries`,
   `sel-cas-retry-budget-bounded-tag-hydration-unbounded`); synthesis must merge
   them rather than catalog both.

4. **Three scope files carry determinism claims and have zero tests.**
   `m0_compose.rs` (403 lines, C11, "same inputs → same bytes, the property the
   frozen-m0 cache depends on"), `m1_compose.rs` (230 lines, producer for C7's
   digest-completeness claim, and it carries no doc comment of its own), and
   `retained_size.rs` (212 lines, C20, "cannot diverge between those paths").
   Between them they own m0 bytes, m1 bytes, and every cache budget in the
   sub-part.

5. **The Defer commit's watermark write is guarded by nothing on the path that
   writes it.** `:5156-5159` writes `meta.coverage_compartment_seq` from a read
   taken outside any predicate, while `:5574` withholds the compartment fence
   from exactly that pass class. The nearest existing check,
   `claim_vector_commit_fence_never_publishes_interleaved_stale_bytes`
   (`:14185`), covers the claim-vector predicate instead. Nothing covers the
   compartment predicate's absence on Defer.

6. **The strongest drift check in the engine is compiled out, and its sibling
   ships with no documentation.** `:5451-5479` re-renders every cached output and
   asserts byte equality under `#[cfg(test)]`;
   `assert_prefix_projection_equivalent` (`:2344-2358`) does the analogous thing
   and is live in release under an undocumented environment variable (lead L4).
   The pair is inverted relative to what a release build wants.

7. **The compaction-off engine holds a production `unreachable!` and may be
   unreachable on the shipped leg.** `:3068`, inside a 509-line branch whose
   enabling flag causes the shipped OpenCode plugin to stop calling the Rust
   transform at all (lead L3). The only executing check anywhere near it tests
   the TypeScript resolver (`transform-mode.test.ts:69`).

8. **`docs/AUDIT-KNOWN-ISSUES.md` has no Rust transform entry.** Fifty-one
   transform-adjacent lines, all about the TypeScript pipeline, in a file that
   instructs auditors not to re-report what it lists. None of lens A's five
   leads, lens B's eight, or this lens's seven is tracked there. `A24`
   (`:407-425`) discusses the atomicity question C1 answers and discusses it
   about the other implementation.

9. **Four documented configuration keys have no implementation here and no check
   that would notice.** `protected_tags`, `execute_threshold_tokens`, the object
   form of `execute_threshold_percentage`, and the documented lower bound of 20.
   `protected_tags` is the safety-relevant one: it is the count of newest tags
   immune from dropping, feeding `newest_active_tag_block_ids`
   (`transform.rs:4177-4182`) and caveman's protected cutoff (`:6318`). A
   configuration-reference conformance check comparing documented keys against
   `config.rs` parsing would catch all four; none exists. Lens B owns the
   records.

10. **The caveman `assert!` is the sub-part's only unconditional production
    panic and has no test that reaches it.** `:25463-25490`, `:25606` and
    `:25660-25684` drive `new_caveman_units` with `caveman_min_chars = 1`; none
    constructs a deeper tier whose output is longer than the frozen payload.
    Whether that is constructible is a property of `caveman.rs`'s level ladder
    (651 lines, 4e scope), and `CONFIGURATION.md:720-744` documents caveman with
    no failure mode at all.

11. **The three CONFIGURATION.md idempotency and byte-identity claims have no
    Rust check.** `:659` (markers), `:716` (user hint, "never rewrites cached
    content"), `:763` (smart drops, "byte-for-byte identically" and
    "byte-identical" when off). These are the strongest determinism statements in
    the documentation for this sub-part and the register could trace none of them
    to an assertion, guard, or test name in Rust (lead L6).

12. **There is no TypeScript-oracle golden driver for the transform.** Part 4a
    at least has `validate_golden_matches_typescript_oracle`
    (`historian_validate.rs:1384`) tying the two validators together, ungated
    though it is. 4b has no counterpart: no in-crate test compares the Rust
    engine's output to the TypeScript transform's, and the executing per-PR suite
    covers the TypeScript twin exclusively.

## Open questions

- **Which 4b scope definition governs?** The task names `scheduler.rs` and the
  `mc-store` transform commit as in scope; the scope map's 4b entry
  (`../../part-4-module/_lenses/scope-map-and-risk-ranking.md:521-533`) lists
  eight units including neither, and assigns `scheduler.rs` to 4f. This lens
  followed the scope map and cited both adjacent surfaces, as both siblings did.
  If the task's wider scope is authoritative, `scheduler.rs`'s 16 tests and the
  six `mc-store` commit tests move from "cited" to "in-scope" and the in-crate
  total rises from 263 to 279. (needs human input)
- **Should a never-executed test count as `Exercised: partial`?** Raised by the
  scope map (`:681`) and by both siblings, still unresolved. It governs every
  `Existing check:` line in this part. This lens sidesteps it by reporting
  execution status per check rather than assigning an `Exercised` value.
  (needs human input)
- **Can any host reach `apply_additive_only` in production?** The shipped
  OpenCode plugin downgrades to the TypeScript transform when compaction is off
  (lead L3), and `compaction_enabled` appears nowhere in `packages/`, so the
  module's value comes only from its own JSONC. Whether an explicit `subc`
  daemon, the Pi leg, or a non-shipped host can call the Rust transform with
  compaction off is unresolved; it decides whether `transform.rs:2711-3219` and
  its `unreachable!` at `:3068` need any record at all. Unresolved, needs the
  4c/4d route-binding result.
- **Is `MC_PREFIX_PROJECTION_DIFFERENTIAL` intended to be settable in
  production?** `:2337-2342` reads it from the environment, which makes two bare
  `assert_eq!` live in release. No `docs/` file mentions the variable. If it is a
  developer-only switch, the gate should say so; if it is an operational
  canary, the panic is the contract and should be documented. (needs human
  input)
- **Do C7's digest and `m1_compose.rs` agree?** C7 is the strongest untested
  claim in the register: it asserts that no byte-affecting m1 render input
  escapes the `revision` digest. The claim is stated in `transform.rs:509-512`
  and the producer is `m1_compose.rs`, which has 230 lines, zero tests, and zero
  doc comments. Establishing or refuting it needs an input-enumeration pass over
  `m1_compose.rs` and `memory_render.rs` that this lens did not perform.
  Unresolved, needs a dedicated pass.
- **Should the two output-integrity guards be counted as 4b coverage?** They are
  4e code, but the shared driver `run` (`:14335-14336`) asserts both on every one
  of the 210 pass-driving tests, which makes them the sub-part's most-exercised
  invariant by a wide margin and its least deliberately targeted. Whether 4b's
  `existing-checks.md` should claim them or defer wholly to 4e is a synthesis
  decision.
- **Is the 226-of-280 in-scope split accurate enough to publish?** It is a
  symbol match over parsed test bodies, not measured coverage, and 27 tests
  remain unclassified. The repository has no coverage instrumentation, so a
  precise number would require adding one. Unresolved, needs either a
  `cargo llvm-cov` run or a hand-read of the 27.
