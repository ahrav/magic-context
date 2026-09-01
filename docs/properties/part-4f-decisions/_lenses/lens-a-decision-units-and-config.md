# Part 4f lens A: pure decision units and the configuration contract

Attention focus: the algorithmic units in 4f that hold no durable state, plus the
configuration reader that drives the whole crate. The harness codecs
(`codec/*`, `ck_wire.rs`) belong to a sibling lens and are not mined here.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` =
`e447c927ad734d6d54e57f02427e988e612cf246`. Method contract in
[../../METHOD.md](../../METHOD.md). Scope and region maps from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md),
sub-part 4f (`:607-649`).

Files read at `HEAD`: `src/selection.rs` (3,365), `src/boundary.rs` (3,053),
`src/scheduler.rs` (1,449), `src/config.rs` (1,229), `src/session_resolver.rs`
(70), plus the call sites in `src/lib.rs` and `src/transform.rs` that supply or
consume these units, and `CONFIGURATION.md` (841) as the documented contract.

Every line reference below was read back individually at `HEAD`. Two arithmetic
claims (float-to-integer saturation, `f64::max`/`f64::min` NaN absorption) were
confirmed by executing the exact expressions rather than quoting the reference;
the results are in the evidence files that depend on them.

## Decision unit table

Ten units carry a genuine decision. "Pure?" is a verdict against the file's own
purity claim, not a restatement of it.

| Unit | Decides | Inputs | Output domain | Pure? |
| --- | --- | --- | --- | --- |
| `selection::select_reductions_with_outcome` (`selection.rs:1119-1385`) | which tail blocks to reduce and with which payload | `items`, `frozen_keys`, `SelectionContext`, `SelectionConfig` | `Vec<ReductionDecision>` sorted by unique `target_id`, kinds `drop`/`skeleton`/`edit_marker`; empty on Defer | Yes. No clock, no store, no statics. Iterates `HashMap`s internally but every result is a set or is totally sorted before it escapes; see `dec-a-selection-decision-order-is-total-under-hashmap-iteration` |
| `selection::region_hint` (`:558-571`) | how far to clamp a superseded diff value | one `&str` | `String`, normally `<=40` UTF-16 units plus the sentinel | Yes, and idempotent. But the idempotence guard is also a bypass: see `dec-a-region-hint-clamp-bypassed-by-sentinel-suffix` |
| `selection::skeleton_payload` (`:648-694`) / `canonical_json` (`:597-619`) | the frozen call-skeleton bytes | one `serde_json::Value` | canonical `String` with sorted keys | Yes. Key sort makes bytes independent of map order |
| `selection::resolve_tool_tier` (`:948-958`) | emergency drop tier of a tool | tool name | `{1,2,3}`, total via the `else` arm | Yes |
| `selection::select_emergency` (`:995-1084`) | which arcs to evict under force pressure | active arcs, ctx, floor tokens | `HashSet<String>` of arc ids | Yes. Guards non-finite ceiling and usage at `:1001-1009` and refuses sub-`2000`-token reclaim at `:1018` |
| `boundary::resolve_protected_tail_boundary` (`:410-416`) | where the compactable/protected split sits | messages, `BoundaryContext` | `BoundaryResolution` with ordinals and a reason string | Yes. `HashMap` at `:1001` is lookup-only, built from a `BTreeMap` at `:1027` |
| `boundary::check_compartment_trigger*` (`:751-882`) | whether the historian fires, and why | messages, `TriggerContext`, token index, estimator | `TriggerDecision`, `reason` in a closed 4-variant enum | Yes given the caller-supplied estimator. `mc_tokenizer` determinism is Part 3's |
| `boundary::derive_trigger_budget` (`:338-346`) + `derive_protected_tail_token_target` (`:362-401`) | the size-trigger budget and the protected-tail token target | `context_limit`, `execute_threshold_percentage`, usage, optional budget | budget always in `[5000, 50000]`; `n` always `>= 1` | Yes and total: see `dec-a-boundary-budget-derivation-is-total-over-non-finite-input` |
| `scheduler::decide` (`:706-800`) | the pass class, band, latch, and overflow verdict | `SchedulerInputs` (config, session, usage, `now_ms`, latch, error text) | `SchedulerOutcome`; `PassDecision` in a closed 4-variant enum | Yes. `now_ms` is a parameter, not a clock read. Regexes live behind `OnceLock` but are constant |
| `scheduler::parse_cache_ttl` (`:385-419`) + `escalation_bands` (`:187-198`) | the idle TTL in ms, and the force/emergency bands | a TTL string; the effective threshold | `Result<u64, CacheTtlParseError>`; bands with force in `[85, 92]`, emergency fixed at `95` | Yes and total: `dec-a-cache-ttl-parse-is-total-over-arbitrary-strings`, `dec-a-escalation-bands-stay-ordered-for-every-threshold` |

`config.rs` itself is not pure: `ConfigCache` reads the filesystem and caches on
mtime (`:254-266`). Its two derived helpers are pure:
`derive_historian_chunk_tokens` (`:45-48`) and
`resolve_cache_ttl_with_provenance` (`:159-200`).

`session_resolver.rs` holds no decision worth a record.
`MissingSessionResolver::resolve_session` (`:44-52`) returns `Ok(None)`
unconditionally and its one test (`:57-67`) already pins that.

### Purity verdict against the headers

`boundary.rs:5-9` claims "no I/O, wall clock, store access, or ambient cache
state here: the same inputs always produce the same boundary and trigger
decision." Confirmed for the boundary and trigger functions. The only statics are
eight `OnceLock<Regex>` caches (`:1930-1970`) holding compile-time-constant
patterns, which do not vary with input.

`selection.rs:4-7` claims "PURE, DETERMINISTIC ... same (items, frozen_keys, ctx,
cfg) -> same decisions". Confirmed structurally, with one unstated precondition
recorded below.

`scheduler.rs:1-4` claims "Pure state-transition functions; durable state enters
as parameters and exits in return values." Confirmed.

The prior-part finding that this repository uses ordered maps and explicit sorts
holds here. Both hash-map-iterating loops I found
(`selection.rs:1305` and `:1397-1405`) are made order-insensitive downstream, and
`boundary.rs`'s only `HashMap` is keyed lookup built from a `BTreeMap`. I found
no process-local timezone or locale read in 4f scope.

## Configuration key table

Every key `config.rs` parses, plus the documented keys that name behaviour this
crate owns and does not implement. "Takes effect here?" means the parsed value
reaches a decision inside `mc-module`.

| Key | Code default | Documented default | Takes effect here? |
| --- | --- | --- | --- |
| `execute_threshold_percentage` (scalar) | `65.0` (`config.rs:19`, `:122`) | `65`, range `20-90` (`CONFIGURATION.md:167`) | Yes, clamped to `[1.0, 90.0]` (`:568-570`). The documented lower bound `20` is not implemented |
| `execute_threshold_percentage` (object form) | not parsed | documented, example at `CONFIGURATION.md:791` | **No.** `number_at` (`:631-636`) yields `None`; already recorded as 4b's `sel-per-model-and-token-thresholds-inert-in-module` |
| `execute_threshold_tokens` | not parsed | documented (`:168`, `:319-338`) | **No.** Same 4b record |
| `compaction.enabled` | `true` (`:123`) | `true` (`:172`) | Yes (user tier only; project tier warns at `:520`) |
| `memory.enabled` | `true` (`:124`) | `true` (`:590`) | Yes, both tiers |
| `memory.injection_budget_tokens` | `4000.0` (`:22`, `:130`) | `4000`, range `500-20000` (`:591`) | Yes, both tiers, but only `.max(1.0)` is applied (`:442`, `:527`). Neither documented bound is implemented |
| `memory.budget_tokens` (deprecated) | falls back to the same field (`:443-445`) | not in the table | Yes on user tier, with a deprecation warning (`:446-451`); project tier warns and ignores (`:538`) |
| `memory.user_profile_budget_tokens` | `4000.0` (`:25`, `:131`) | **undocumented** | Yes, user tier only (`:452-454`); project tier warns (`:539`) |
| `memory.auto_promote` | `true` (`:127`) | `true` (`:592`) | Yes, both tiers |
| `memory.auto_search.enabled` | `true` (`:60`) | `true` (`:682`) | Yes, both tiers |
| `memory.auto_search.score_threshold` | `0.6` (`:39`) | `0.6`, prose range `0.3-0.95` (`:683`, `:706`) | Yes, silently clamped to `[0.3, 0.95]` (`:591`) |
| `memory.auto_search.min_prompt_chars` | `20` (`:40`) | `20`, no range (`:684`, `:707`) | Yes, silently clamped to `[5, 500]` (`:595`); a `0` is silently discarded by `positive_usize_at` (`:623-629`) |
| `caveman_text_compression.enabled` | `false` (`:75`) | `false` (`:724`) | Yes, both tiers |
| `caveman_text_compression.min_chars` | `500` (`:42`, `:77`) | `500`, no range (`:725`) | Yes, silently clamped to `[100, 10000]` (`:607`) |
| `smart_drops` | `false` (`:135`) | `false` (`:752`) | Yes, both tiers (`:467-469`, `:541-543`) |
| `dreamer.inject_docs` | `true` (`:132`) | `true` (`:501`) | Yes, both tiers (`:470-475`, `:544-549`) |
| `temporal_awareness` | `true` (`:133`) | `true` (`:650`) | Yes, both tiers (`:476-478`, `:550-555`) |
| `dreamer.tasks.review-user-memories.schedule` / `user_memories.enabled` | privacy gate defaults `false` (`:128`) | task default schedule `0 3 * * *`, i.e. on (`:527`) | Yes as a presence test (`:611-621`). The module's default is closed while the documented task default is scheduled |
| `historian.model`, `historian.fallback_models` | empty chain (`:121`) | documented, no user-only marker (`:448-449`) | Yes, user tier only. A project-tier value is dropped with **no** warning (`:514-566` has no entry for it) |
| `historian.module_model`, `historian.module_fallback_models` | absent | **undocumented** | Yes, user tier only, and when present it replaces the whole chain (`:390-409`) |
| `historian.context_limit_tokens` | `128000` (`:37`, `:129`) | **undocumented** | Yes (`:464-466`); project tier warns (`:540`) |
| `cache_ttl` (string or object) | `"5m"` (`:136`) | `"5m"` (`:163`), not marked user-only | Yes, user tier only (`:486-511`). A project-tier value is dropped with **no** warning; test `:797-802` pins the drop but asserts no warning |
| `prompt_surface.guidance_override_path` | `None` | documented, user-only (`:75`, `:80`) | Yes (`:281-358`); project tier warns (`:561-565`) |
| `prompt_surface.guidance_override_text` | `None` | **undocumented** | Yes (`:479-485`), and a configured path resets it to `None` first (`:299`); project tier warns (`:556-560`) |
| `commit_cluster_trigger.enabled` | not parsed | `true` (`:237`) | **No.** Hardwired `DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED` (`lib.rs:605`) at `lib.rs:4962` |
| `commit_cluster_trigger.min_clusters` | not parsed | `3` (`:238`) | **No.** Hardwired `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:607`) at `lib.rs:4963` |
| `protected_tags` | not parsed | `20`, range `1-100` (`:165`) | **No.** 4b's `sel-protected-tags-not-read-from-module-config` |
| `clear_reasoning_age` | not parsed | `50` (`:169`) | **No.** Same 4b record |
| `historian_timeout_ms` | not parsed | `300000` (`:170`) | **No.** `historian_producer.rs:209-227` has its own `request_timeout`. 4a scope; flagged as a lead only |
| `history_budget_percentage` | not parsed | `0.15`, range `0.05-0.5` (`:171`) | **No.** Zero occurrences in `crates/mc-module/src`. Flagged as a lead |
| `output_reserve`, `toast_duration_ms`, `memory.retrieval_count_promotion_threshold`, `memory.git_commit_indexing.*` | not parsed | documented (`:164`, `:166`, `:593`, `:665-667`) | **No**, and none of them names behaviour `mc-module` implements, so they are out of scope rather than defects |

### Count of documented-but-inert or divergent keys in 4f scope

Prior passes named four (`protected_tags`, `execute_threshold_tokens`, the object
form of `execute_threshold_percentage`, and the `20`-versus-`1` lower bound; see
`part-4b-transform/existing-checks.md:549-574` and `portfolio-evaluation.md:390`).
All four are confirmed at this `HEAD`. `clear_reasoning_age` is named inside the
same 4b evidence file but is not one of the four headline keys.

**Nine** keys in this table are documented but inert or divergent here. The four
prior ones, plus five new:

1. `commit_cluster_trigger.enabled` — inert, hardwired `true`.
2. `commit_cluster_trigger.min_clusters` — inert, hardwired `3`.
3. `memory.injection_budget_tokens` — the documented `500-20000` range has no
   implementing code; only `.max(1.0)`.
4. `cache_ttl` — the documentation does not mark it user-only, and the code drops
   a project-tier value silently.
5. `historian.model` / `historian.fallback_models` — documented without a
   user-only marker, and dropped from the project tier with no warning.

Three further keys take effect but are **undocumented**:
`memory.user_profile_budget_tokens`, `historian.module_model` (plus its fallback
list), and `historian.context_limit_tokens`, and
`prompt_surface.guidance_override_text`. That is four undocumented leaves; the
`module_model` pair is the load-bearing one because it decides which model spends
the user's money.

Two documented keys (`historian_timeout_ms`, `history_budget_percentage`) have no
occurrence anywhere in `crates/mc-module/src`. Their owning implementation is
outside 4f, so they are leads rather than records.

## Observations

Each observation is `file:line` verified at `HEAD`.

1. **`config.rs:568-570` clamps to `1.0`, `CONFIGURATION.md:167` documents `20`.**
   `MAX_EXECUTE_THRESHOLD_PERCENTAGE` is `90.0` (`config.rs:28`) and matches. The
   lower bound does not. `scheduler::resolve_execute_threshold` (`:434-465`)
   rejects only non-finite and negative values (`:462-464`), so `0.0` survives and
   `usage.percentage >= threshold` (`:492`) is then true for every reading.

2. **A malformed config file becomes silence, not an error.**
   `read_tier_cached` (`config.rs:254-266`) does
   `serde_json::from_str(&strip_jsonc(&raw)).ok()` at `:262` and `Err(_) => None`
   at `:263`. There is a warning channel (`merge_tiers_with_warnings` returns
   `Vec<String>` at `:572`, printed by `emit_warnings` at `:275-279`) and it is
   used five times for ignored project keys, but never for a parse failure. The
   downstream effect is concrete: defaults give `model_chain: Vec::new()`
   (`:121`), and `lib.rs:5020-5028` turns an empty chain into
   `no_fire: "no_models"`, so the historian silently stops firing.

3. **`emit_warnings` writes to stderr and drops the vector.**
   `effective_for_paths` (`:228-238`) calls `emit_warnings(warnings)` at `:236`
   and returns only `McModuleConfig`. No caller can learn that a key was ignored,
   deprecated, or clamped. The `#[cfg(test)] merge_tiers` wrapper (`:268-273`) has
   the same shape, which is why the existing tier tests assert values and never
   warnings (`:797-802`, `:811-825`, `:1166-1178`).

4. **Every value clamp in `config.rs` is silent.** `:591` (`0.3..=0.95`), `:595`
   (`5..=500`), `:607` (`100..=10_000`), `:568-570` (`1.0..=90.0`), and the
   asymmetric `.max(1.0)` at `:442`, `:453`, `:527`. `positive_usize_at`
   (`:623-629`) additionally discards `0` by filtering `*v > 0`, so
   `min_prompt_chars: 0` and `caveman_text_compression.min_chars: 0` silently
   become the defaults rather than a documented "disabled".

5. **`cfg.model_chain.dedup()` (`config.rs:571`) is adjacent-only.**
   `Vec::dedup` removes consecutive runs. A user whose
   `historian.module_fallback_models` repeats the `module_model` value at any
   non-adjacent position keeps a duplicate in the chain, and
   `historian.rs:1256` iterates that chain as attempts.

6. **Two independent implementations of one documented model-key walk.**
   `CONFIGURATION.md:70` states the walk once and says `cache_ttl` shares it:
   exact `provider/model`, less specific variants, then literal `provider/*`, then
   `default`. `config.rs:159-200` implements all four steps, including the
   wildcard at `:196`. `scheduler::model_key_lookup_order` (`:849-870`) implements
   exact and dash-stripped variants and has **no** `provider/*` step; its callers
   `resolve_percentage_match` (`:818-829`) and `resolve_tokens_match` (`:832-847`)
   fall straight to `"default"`. `config.rs:113-114` calls it "the shared ...
   walk", which is not true of the code.

7. **The commit-cluster trigger cannot be turned off from config.**
   `boundary.rs:850-855` gates on `ctx.commit_cluster_trigger_enabled` and
   `ctx.min_commit_clusters`, and both arrive from constants at
   `lib.rs:4962-4963`. `CONFIGURATION.md:237-238` documents them as configurable
   with defaults `true` and `3`, and `boundary.rs:45` carries the same `3`, so the
   values agree; only the configurability is fictional.

8. **The documented conjunction for the commit trigger is implemented.**
   `CONFIGURATION.md:238` says the tail must also hold one `trigger_budget` worth
   of tokens. `boundary.rs:850-853` requires `chunk.tokens >= trigger_budget`
   alongside the cluster count, and `derive_trigger_budget` (`:338-346`) matches
   the documented `context * threshold * 5%` clamped to `[5000, 50000]`
   (`:38-40`). This one is a claim that holds.

9. **`region_hint` short-circuits on its own sentinel.** `selection.rs:559-561`
   returns the input unchanged when it already ends with `"...[truncated]"`
   (`:71`). That makes the function idempotent, which the doc comment at `:557`
   claims, and it also means a diff value whose real content ends with that
   literal is never clamped. The existing test (`:2537-2549`) covers the UTF-16
   and surrogate boundary and not this branch.

10. **The project tier can write four leaves the header's allow-list omits.**
    `config.rs:6-7` enumerates what project config may do: raise the execute
    threshold, and override "trusted memory, auto-search, caveman, promotion, and
    privacy settings". The project block at `:514-566` also applies
    `memory.injection_budget_tokens` (`:526-528`), `smart_drops` (`:541-543`),
    `dreamer.inject_docs` (`:544-549`), and `temporal_awareness` (`:550-555`).
    `smart_drops` and the memory budget are the two that a repository can move in
    the permissive direction: `smart_drops` defaults `false` and
    `CONFIGURATION.md:767` says the default "stays off while cache stability is
    being validated in the wild"; the budget has no upper bound.

11. **`selection.rs` iterates two hash maps whose order could escape.**
    `:1305` is `for (arc_id, shape) in &arc_shapes` pushing into `out`, and
    `:1397-1405` is `dedupe_and_sort`'s `best` map. Both are neutralised at
    `:1408` by `out.sort_by(|a, b| a.target_id.cmp(&b.target_id))` over
    `target_id`s that `best` has already made unique. The residual risk is the
    equal-rank arm at `:1400`: `Some(existing) if rank(existing) >= rank(d) => {}`
    keeps whichever arrived first, so two same-kind decisions for one target with
    different payloads would resolve by `arc_shapes` iteration order.

12. **`boundary.rs`'s only `HashMap` is order-safe by construction.**
    `TokenIndex::tokens_by_ordinal` (`:1001`) is filled from a `BTreeMap`
    (`:1027`, `:1046-1052`) and only ever read through
    `token_for_ordinal` (`:1058-1060`). Nothing iterates it.

13. **Boundary and scheduler arithmetic is defensively total.** Non-finite guards
    at `boundary.rs:339` (`derive_trigger_budget`), `:363-372`
    (`derive_protected_tail_token_target`), `:926-931` (`clamp_percentage`),
    `:1122-1124`; `scheduler.rs:188-192` (`escalation_bands`), `:462-464`
    (`resolve_execute_threshold`), `:566-569`
    (`emergency_drain_exit_threshold`), `:414-418` (`parse_cache_ttl` overflow);
    `selection.rs:1001-1009` (`select_emergency`). Every unsigned subtraction I
    checked is guarded: `boundary.rs:901-902` behind `end > start`, `:606` behind
    `live_ordinals.len() > keep`, `:1142` and `:1185` behind `mid == 0` breaks,
    `:1076` behind `index == 0`, and `selection.rs:466-467` operates on
    `chunk_by` runs, which are never empty, with `checked_sub` at `:468`.

14. **The one arithmetic shape that reads wrong is `boundary.rs:687-691`.**
    `total_message_count` is the **maximum ordinal**, falling back to
    `ordered.len()`. It is consumed at `:705` and used at `:1705-1706` to clamp an
    exclusive end. With dense 1-based ordinals the two quantities coincide; with a
    sparse tail the max ordinal exceeds the count. I could not construct a
    behavioural difference from 4f scope alone because the value is only used as a
    clamp ceiling, so this stays an open question rather than a record.

15. **`parse_cache_ttl("0")` is accepted and means "always idle".** Verified by
    executing the function's logic: `"0"` is all-ASCII-digits so it takes the
    `multiplier = 1.0` arm (`scheduler.rs:391-392`) and returns `Ok(0)`. Then
    `ttl_hard_expired` (`:429-432`) is true for any elapsed millisecond.
    `config.rs:486-491` accepts any non-empty trimmed string, so `"0"` reaches the
    scheduler. `CONFIGURATION.md:163` documents no zero semantics.

16. **`parse_cache_ttl` rejects an uppercase unit but accepts uppercase `NEVER`.**
    `:386-387` uses `eq_ignore_ascii_case` for `"never"`; the unit match at
    `:399-404` is exact lowercase, so `"5S"` is an error. Verified by execution.
    An invalid string is then swallowed: `scheduler_ttl_ms` (`:810-812`) does
    `.unwrap_or(DEFAULT_CACHE_TTL_MS)`.

17. **`derive_historian_chunk_tokens` is total at both integer extremes.**
    `config.rs:45-48`. Executed: `usize::MAX` yields `50_000` because a
    float-to-integer `as` cast saturates, and `0` yields `8_000`. Its test
    (`:972-978`) covers `1`, `32_000`, `128_000`, `200_000`, `400_000` and neither
    extreme.

18. **No totality defect of the Part 3 decay shape exists in 4f scope.** The Part
    3 analogue is an infinite input producing a NaN that broke a documented
    invariant. Here every f64 entry point guards `is_finite` first, and where a
    NaN could still arrive it is absorbed rather than propagated, because
    `f64::max` and `f64::min` return the non-NaN operand. Executed to confirm:
    `NAN.max(0.0) == 0.0` and `NAN.min(5.0) == 5.0`. The one place a caller can
    inject an unvalidated float is `BoundaryContext.trigger_budget`
    (`boundary.rs:756-761` uses it without revalidation), and production always
    passes `None` (`lib.rs:4957`); the only `Some` call sites are tests
    (`lib.rs:16495`, `:16760`). So the defect class is present in shape and
    unreachable in fact, which is worth stating and not worth a record.

## Candidate properties

Fourteen records. Reachability is labelled per record with the evidence that
fixed the label.

### dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test supplies a threshold below `20`. `config.rs:829-835` pins the upper clamp (`91 -> 90`) and `:837-841` pins the default `65`; neither touches the low end.
Guarantee: A configured `execute_threshold_percentage` that the documentation forbids is rejected or reported, not silently accepted as the effective threshold.
Check: `always` — after `merge_tiers_with_warnings`, `execute_threshold_percentage >= 20.0`, or the returned warning vector names `/execute_threshold_percentage`. These semantics because the clamp runs on every config resolution, so there is no optional path.
Fault/timing angle: none. The value is fixed at route bind and persists for the life of the binding.
Required faults and enabling state: a user or project `magic-context.jsonc` containing `execute_threshold_percentage` below `20`, for example `5`.
Confidence: high — [evidence](../evidence/dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1.md). Both sides read at `HEAD`: `CONFIGURATION.md:167` documents `number (20-90)`; `config.rs:568-570` clamps to `[1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE]` with the constant `90.0` at `:28`. Traced the consequence into `scheduler.rs:462-464` and `:492`.
Existing check: `config.rs:829-835` `project_threshold_may_only_raise` covers the upper bound only. Status `unaudited`. This record adopts 4b's queued gap `portfolio-evaluation.md:390` (G4), which that part recorded as uncovered.
Impact: a threshold of `5` makes `should_execute` return `Execute` on essentially every pass, so every pass busts the provider prefix cache. A threshold of `1` is the floor the code will accept.
Open questions:
- Should `config.rs` enforce `20` or should `CONFIGURATION.md` be corrected to `1-90`? The TypeScript schema is the stated twin for the default (`config.rs:17-19`), so the two implementations may already disagree on the bound. (needs human input)

### dec-a-memory-injection-budget-documented-range-has-no-implementing-code

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `config.rs:843-849` pins the default `4000` and `:851-874` pins key precedence and the deprecated fallback. No test supplies a value outside `500-20000`.
Guarantee: A configured `memory.injection_budget_tokens` outside the documented range is rejected, clamped to the documented range, or reported.
Check: `always` — after config resolution, `500.0 <= memory_budget_tokens <= 20000.0`, or a warning names the key. `always` because the parse runs on every resolution for both tiers.
Fault/timing angle: none.
Required faults and enabling state: a project `.cortexkit/magic-context.jsonc` with `memory.injection_budget_tokens` set above `20000` (or below `500`).
Confidence: high — [evidence](../evidence/dec-a-memory-injection-budget-documented-range-has-no-implementing-code.md). `CONFIGURATION.md:591` documents `number (500-20000)` default `4000`. `config.rs:441-445` and `:526-528` apply only `.max(1.0)`. Traced the value to `lib.rs:8293` and into `trim_claims_to_budget` at `transform.rs:2657`.
Existing check: none for the range. `config.rs:876-911` `rust_only_budget_leaves_are_user_tier_only_and_warn_when_project_supplies_them` proves that the *user-profile* budget is user-tier-only, which by contrast confirms the injection budget is deliberately project-writable. Status `unaudited`.
Impact: a repository config can raise the memory-injection trim budget without limit, inflating the frozen `m0` baseline that every subsequent pass replays verbatim.
Open questions: None.

### dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:1191-1229` covers the mtime cache with well-formed files, and `:1181-1189` covers JSONC stripping of comment-like strings. No test writes a syntactically invalid file and asserts the outcome.
Guarantee: A configuration file that exists but cannot be parsed produces a distinguishable signal rather than the same result as an absent file.
Check: `always` — whenever `fs::read_to_string` succeeds and `serde_json::from_str` fails, the resolution emits a warning naming the path. `always` rather than `always-or-unreached` because the read path executes on every `effective_config` call.
Fault/timing angle: none for the parse itself. There is a separate same-mtime window: `read_tier_cached` keys on `(path, mtime)` (`config.rs:256`), so an edit landing inside the filesystem's mtime granularity is not observed.
Required faults and enabling state: a user `magic-context.jsonc` with a syntax error that `strip_jsonc` does not repair, for example an unterminated string.
Confidence: high — [evidence](../evidence/dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian.md). `config.rs:261-264` discards both the parse error and the read error. Traced the default `model_chain: Vec::new()` (`:121`) to `lib.rs:5020-5028`, which records `no_fire: "no_models"`.
Existing check: none. Status `unaudited`.
Impact: a typo in the user config silently disables autonomous historian firing. The only surface is a `no_models` no-fire reason, which points at model configuration rather than at a parse failure.
Open questions:
- Is the mtime-granularity window worth a separate record, or is it subsumed here? An edit that changes bytes without changing mtime serves stale config until the next mtime change. Unresolved, needs a scoping decision at synthesis.

### dec-a-commit-cluster-trigger-config-is-inert-in-this-crate

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16500-16501`, `:16573-16574`, and `:16767-16768` drive `TriggerContext` with `min_commit_clusters: 2` and both settings of the enable flag, so the boundary logic is covered. Nothing covers the config-to-context wiring, because there is none.
Guarantee: A configured `commit_cluster_trigger` reaches the module's trigger decision, or the module reports that it cannot honour the key.
Check: `always` — for every resolved configuration, the `TriggerContext` built at `lib.rs:4962-4963` carries the configured `enabled` and `min_clusters`. `always` because `prepare_historian_fire` constructs this context on every transform pass that evaluates a trigger.
Fault/timing angle: none.
Required faults and enabling state: none for the divergence itself; it holds on a default build. Observing a behavioural difference needs `commit_cluster_trigger.enabled: false` plus a tail with at least three commit clusters and one `trigger_budget` of tokens.
Confidence: high — [evidence](../evidence/dec-a-commit-cluster-trigger-config-is-inert-in-this-crate.md). `CONFIGURATION.md:237-238` documents both keys. `config.rs` has zero occurrences of `commit_cluster` or `min_clusters`. `lib.rs:605` and `:607` are the hardwired constants, passed at `:4962-4963`; `boundary.rs:850-855` consumes them.
Existing check: none for the wiring. `boundary.rs:2226-2227` asserts the constant `DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER` against a golden value, which pins the default and not the configurability. Status `unaudited`.
Impact: a user who disables the commit-cluster trigger still gets commit-cluster-driven historian fires, each of which spends a model call and replaces raw conversation with generated summary text.
Open questions:
- Does any harness leg carry these controls in the transform request instead? I found no request field for either. Unresolved, needs a sweep of the TypeScript sender, which is outside 4f scope.

### dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:930-970` and `:981-997` assert that `auto_search`, `caveman`, `inject_docs`, and `temporal_awareness` follow user-then-project tiers, so the behaviour is pinned as intended. No test asserts the header's allow-list as a closed set.
Guarantee: The set of leaves a project-tier config can change equals the set the trust policy documents.
Check: `always` — for every leaf in `McModuleConfig`, a project-tier value changes it only if the documented policy permits it. `always` because the tier merge runs on every resolution.
Fault/timing angle: none.
Required faults and enabling state: a project `.cortexkit/magic-context.jsonc` setting `smart_drops: true`, which the code accepts at `config.rs:541-543`.
Confidence: high — [evidence](../evidence/dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list.md). Compared `config.rs:6-7`'s enumeration against the project block at `:514-566`, leaf by leaf. Four leaves are outside the enumeration; two of them move in the permissive direction.
Existing check: `config.rs:913-928` and `:1096-1117` prove specific keys are user-tier-only, and `warn_ignored_project_key` (`:575-581`) is called five times. Neither establishes that the remaining project-writable set is the documented one. Status `unaudited`.
Impact: a repository can enable `smart_drops`, which `CONFIGURATION.md:767` describes as intentionally off while cache stability is validated, and can raise the memory injection budget without bound. Both change the bytes the module serves to the provider.
Open questions:
- Is `smart_drops` intended to be project-overridable? The header omits it while the code applies it on both tiers, so one of the two is wrong. (needs human input)

### dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:930-970` exercises `auto_search` and `caveman` values inside their clamps and asserts the resulting values. No test supplies an out-of-range value and asserts either the clamped result or a warning.
Guarantee: When a configured value is altered by a clamp or discarded as out of domain, the resolution reports which key was altered.
Check: `always` — for every resolution where an input leaf differs from the resolved leaf, the warning vector names that leaf. `always` because the merge path always produces the vector.
Fault/timing angle: none.
Required faults and enabling state: a config with `memory.auto_search.score_threshold: 0.99`, `memory.auto_search.min_prompt_chars: 0`, or `caveman_text_compression.min_chars: 50`.
Confidence: high — [evidence](../evidence/dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller.md). Enumerated every clamp: `config.rs:568-570`, `:591`, `:595`, `:607`, and the `.max(1.0)` calls at `:442`, `:453`, `:527`. `positive_usize_at` (`:623-629`) filters `*v > 0`. `emit_warnings` (`:275-279`) prints and drops.
Existing check: none for the clamp reporting. Status `unaudited`.
Impact: a user tuning auto-search or caveman sees no effect from a value outside the clamp and no explanation. `min_prompt_chars: 0`, the natural spelling of "hint on every prompt", silently becomes `20`.
Open questions:
- Is the stderr line from `emit_warnings` visible in any harness the module runs under? The module runs as a daemon component, so stderr may be discarded. Unresolved, needs a look at the host's process wiring, which is Part 2a scope.

### dec-a-model-key-lookup-walk-has-two-implementations-that-disagree

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:721-744` and `:760-785` exercise the `config.rs` walk, including a shared TypeScript vector set. The scheduler walk has no wildcard test because it has no wildcard.
Guarantee: Every consumer of a per-model configuration map resolves a given model key through the same documented walk.
Check: `always` — for every model key and every map, `config.rs`'s walk and `scheduler::model_key_lookup_order` select the same entry. `always` because each walk runs on every resolution for its own consumer.
Fault/timing angle: none.
Required faults and enabling state: a per-model map keyed only by a `provider/*` wildcard. On the `cache_ttl` side this resolves; on the scheduler side it would fall to `default`. Reaching the scheduler side additionally needs `ExecuteThresholdConfig::ByModel`, which no code in this crate constructs.
Confidence: high — [evidence](../evidence/dec-a-model-key-lookup-walk-has-two-implementations-that-disagree.md). `CONFIGURATION.md:70` states the walk and says `cache_ttl` shares it. `config.rs:159-200` includes the wildcard at `:196`; `scheduler.rs:849-870` has no wildcard step, and `:818-829` and `:832-847` fall to `"default"`. `config.rs:113-114` calls the walk "shared".
Existing check: `config.rs:760-785` `cache_ttl_resolution_matches_shared_typescript_vectors` pins one implementation against TypeScript vectors. No differential test between the two Rust implementations. Status `unaudited`.
Impact: today the divergence is latent because `ByModel` is unreachable here (see 4b's `sel-per-model-and-token-thresholds-inert-in-module`). If the per-model threshold path is ever wired, a wildcard-keyed config will resolve differently from the same wildcard on `cache_ttl`, and the documentation says it will not.
Open questions:
- Should the two walks be one function? They already agree on the exact, bare, and dash-stripped steps, which is the duplication the repository's own duplication policy targets. (needs human input)

### dec-a-model-chain-dedup-is-adjacent-only

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:1119-1137` and `:1138-1153` cover chain construction from `module_model` and the plugin-key fallback. `:1154-1165` covers a blank `module_model`. No test repeats a model at a non-adjacent position.
Guarantee: The resolved historian model chain contains no duplicate model id.
Check: `always` — after config resolution, `model_chain` has no repeated element. `always` because `dedup()` runs on every resolution at `config.rs:571`.
Fault/timing angle: none.
Required faults and enabling state: a user config with `historian.module_model: "a"` and `historian.module_fallback_models: ["b", "a"]`.
Confidence: high — [evidence](../evidence/dec-a-model-chain-dedup-is-adjacent-only.md). `Vec::dedup` removes only consecutive runs, so `["a","b","a"]` is unchanged. `historian.rs:1256` iterates the chain as ordered attempts, and `:1300`, `:1380`, and `:1443` slice it as a remaining-candidates list.
Existing check: none. Status `unaudited`.
Impact: a duplicated model is attempted twice in one firing. `config.rs:384-389` explains why the author cares about chain hygiene: a wrong chain "would burn permanent-classified advances every fire".
Open questions:
- Is a repeated attempt actually harmful, or is it an acceptable retry? The comment at `:384-389` suggests the author treats wasted advances as a cost, but it is about namespace mixing rather than duplication. (needs human input)

### dec-a-cache-ttl-parse-is-total-over-arbitrary-strings

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `scheduler.rs:1417-1424` covers `never` in four cases, `5m`, and one malformed string. Nothing covers `"0"`, an uppercase unit, an overflowing digit run, or a multi-byte trailing character.
Guarantee: `parse_cache_ttl` returns for every `&str` without panicking, and any accepted value yields a millisecond count that no finite elapsed time can misinterpret.
Check: `always` — for every input string, the call returns `Ok(n)` or `Err(CacheTtlParseError)`, never panics, and never yields a value from a non-finite intermediate. `always` because the scheduler parses the configured TTL on every `decide` call through `scheduler_ttl_ms`.
Fault/timing angle: none in the parse. The consequence has one: `ttl_hard_expired` compares `now_ms.saturating_sub(last_response_time_ms) > ttl_ms`, so a `ttl_ms` of `0` makes every pass past the first look idle-expired.
Required faults and enabling state: a `cache_ttl` string. `"0"`, `"5S"`, `"99999999999999999999h"`, and `"5\u{20ac}"` are the interesting inputs; all are accepted by `config.rs:486-491` as non-empty trimmed strings.
Confidence: high — [evidence](../evidence/dec-a-cache-ttl-parse-is-total-over-arbitrary-strings.md). Read `scheduler.rs:385-419`, then executed the function's exact logic on nine inputs. Confirmed `"0" -> Ok(0)`, `"5S" -> Err`, `"never"`/`"NEVER"` -> `u64::MAX`, the overflow arm at `:414-418` -> `u64::MAX`, and that the `len_utf8` slice at `:397` keeps a multi-byte trailing character on a character boundary.
Existing check: `scheduler.rs:1417-1424` `parse_cache_ttl_never_returns_u64_max` and `:1427-1435` `never_ttl_predicates_are_always_false`. Status `unaudited`.
Impact: the parse itself is sound, which is the finding. The reachable hazard is downstream: `"0"` forces a hard idle expiry on every pass, and any unparseable string is swallowed into the `5m` default by `scheduler_ttl_ms` (`:810-812`) with no report.
Open questions:
- Is `cache_ttl: "0"` intended as "always expire" or should it be rejected? `CONFIGURATION.md:163` documents neither. (needs human input)

### dec-a-boundary-budget-derivation-is-total-over-non-finite-input

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `boundary.rs:2226-2227` pins the commit-cluster constant against a golden, and the golden fixture suite drives the boundary with realistic values. No test supplies a non-finite context limit, threshold, or usage percentage.
Guarantee: The boundary and trigger derivations produce a finite, in-range result for every f64 input, including infinity and NaN, and never propagate a non-finite value into a decision or a serialized diagnostic.
Check: `always` — for every `BoundaryContext`, `derive_trigger_budget` returns a value in `[5000, 50000]`, `derive_protected_tail_token_target().n >= 1.0` and is finite, and `clamp_percentage` returns a value in `[0, 100]`. `always` because every trigger evaluation runs all three.
Fault/timing angle: none.
Required faults and enabling state: a `BoundaryContext` whose `context_limit`, `execute_threshold_percentage`, or `usage_percentage` is `f64::INFINITY` or `f64::NAN`. Reaching that from production needs a host-supplied usage reading, since `lib.rs:4950-4959` builds the context from request and store values.
Confidence: high — [evidence](../evidence/dec-a-boundary-budget-derivation-is-total-over-non-finite-input.md). Read every guard: `boundary.rs:339-341`, `:363-372`, `:926-931`. Executed `NAN.max(0.0) == 0.0` and `NAN.min(5.0) == 5.0` to confirm the absorption argument, which is what makes `:342` safe against a NaN threshold. Also confirmed that `ctx.trigger_budget` is the one unvalidated float (`:756-761`, `:380-382`) and that production always passes `None` (`lib.rs:4957`), with `Some` only at `lib.rs:16495` and `:16760`.
Existing check: none targeting non-finite input. Status `unaudited`.
Impact: this is the guarded analogue of Part 3's decay totality defects, and the guard holds. Recording it fixes the boundary so a later change that drops a guard is visible. The `trigger_budget` passthrough is the one place where a caller could still inject a non-finite value.
Open questions:
- Should `check_compartment_trigger_with_index` validate `ctx.trigger_budget` the way it validates everything else? It is test-only today, so this is a latent-hazard question, not a defect. (needs human input)

### dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `config.rs:972-978` covers `1`, `32_000`, `128_000`, `200_000`, and `400_000`, so both clamp arms are hit. Neither `0` nor `usize::MAX` is covered.
Guarantee: `derive_historian_chunk_tokens` returns a value in `[MIN_HISTORIAN_CHUNK_TOKENS, MAX_HISTORIAN_CHUNK_TOKENS]` for every `usize` input, without panicking.
Check: `always` — for every input, the result is in `[8000, 50000]`. `always` because every historian firing derives the budget from the configured limit.
Fault/timing angle: none.
Required faults and enabling state: `historian.context_limit_tokens` set to `0` is impossible, because `positive_usize_at` (`config.rs:623-629`) discards it. Reaching the extremes needs a very large configured limit or a direct call.
Confidence: high — [evidence](../evidence/dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes.md). `config.rs:45-48`. Executed the exact body: `usize::MAX -> 50000` because a float-to-integer `as` cast saturates rather than wrapping, `0 -> 8000`, `1 -> 8000`. Traced the three call sites at `lib.rs:4700`, `:5087`, `:5250`.
Existing check: `config.rs:972-978` `historian_budget_derivation_clamps_at_both_bounds`. Status `unaudited`.
Impact: low on its own. It matters as the paired positive result to the Part 3 defect class: the rounding-then-clamp order here cannot produce a value outside the declared range, and the saturating cast means an absurd configured limit degrades to the documented maximum rather than wrapping to a tiny budget.
Open questions: None.

### dec-a-selection-decision-order-is-total-under-hashmap-iteration

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `selection.rs:2836` `drop_wins_over_edit_marker` covers the rank precedence. No test asserts that two runs over identical inputs produce identical output, which is the claim the module header makes.
Guarantee: `select_reductions` returns byte-identical decisions for identical `(items, frozen_keys, ctx, cfg)`, independent of hash-map iteration order.
Check: `always` — for identical inputs, repeated calls return equal `Vec<ReductionDecision>`; and the enabling precondition holds, namely that no two distinct arcs emit a decision for the same `target_id`. `always` because determinism is stated as the cache invariant at `selection.rs:6-7` and every non-defer pass runs the selector.
Fault/timing angle: none in a single pass. The consequence window is across passes: a non-deterministic decision set makes a defer-pass replay differ from the frozen bytes.
Required faults and enabling state: none for the property. Refuting it needs an input where one `target_id` receives two same-rank decisions with different payloads, which requires duplicate `SelItem` ids mapped to different `arc_id`s.
Confidence: high — [evidence](../evidence/dec-a-selection-decision-order-is-total-under-hashmap-iteration.md). Traced both hash-map iterations that reach output: `selection.rs:1305` and `dedupe_and_sort`'s `:1397-1405`. The final `out.sort_by` at `:1408` sorts on `target_id`s that `best` has made unique, so the order is total. Also checked every internal sort for a total tie-break: `:853-861`, `:763-770`, `:1033-1037`, `:1071-1075`, `:447-452`, `:1290-1295` all end in an `arc_id` or `mid` comparison.
Existing check: `selection.rs:2836` `drop_wins_over_edit_marker`, plus the differential golden that `selection.rs:32-33` names as the arbiter. Status `unaudited`.
Impact: the header stakes the cache invariant on this. If it fails, a defer pass replays different bytes than the freeze produced, which busts the provider prefix cache without any pass intending to.
Open questions:
- Can duplicate `SelItem` ids reach the selector? Ids are `mid#block_index` projections from `ck_wire.rs`, which is the sibling lens's scope. Unresolved, needs the codec lens to confirm id uniqueness.

### dec-a-region-hint-clamp-bypassed-by-sentinel-suffix

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `selection.rs:2537-2549` covers the UTF-16 cap and the surrogate back-off. No test supplies a value that already ends with the sentinel.
Guarantee: An `edit_marker` payload's diff-bearing values are clamped to a bounded region hint regardless of their content.
Check: `always` — for every diff value, the `edit_marker` payload's corresponding value is at most `EDIT_REGION_HINT_LEN` UTF-16 units plus the sentinel. `always` because `region_hint` runs on every diff key of every superseded edit.
Fault/timing angle: none.
Required faults and enabling state: `smart_drops: true`, which is off by default (`config.rs:135`, `CONFIGURATION.md:752`), plus an `edit` or `write` tool call superseded by a later edit to the same file, whose `oldString`, `newString`, or `content` value ends with the literal `...[truncated]`.
Confidence: high — [evidence](../evidence/dec-a-region-hint-clamp-bypassed-by-sentinel-suffix.md). `selection.rs:559-561` returns the input unchanged when it ends with `TRUNCATION_SENTINEL` (`:71`). Executed the predicate on a 5,014-character hostile string to confirm it takes the short-circuit arm. The gate is `cfg.smart_drops` at `:1229` and `:1236`.
Existing check: `selection.rs:2537-2549` `edit_marker_region_hint_caps_utf16_and_backs_off_split_surrogate`, which covers the other two arms. Status `unaudited`.
Impact: a superseded edit keeps its full diff instead of a 40-unit hint, so the reduction reclaims nothing while the accounting believes it did. The content is harness-supplied, so a file whose text legitimately ends with that marker is enough; no adversary is required.
Open questions:
- Should the guard test for a well-formed hint rather than a bare suffix, for example a length check as well? Changing it would have to preserve idempotence, which the doc comment at `:557` claims. (needs human input)

### dec-a-escalation-bands-stay-ordered-for-every-threshold

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `scheduler.rs:1238` `escalation_bands_stay_ordered_above_execute_and_below_emergency` covers the ordering for the thresholds it samples. Non-finite and negative thresholds are not covered.
Guarantee: For every effective threshold, the derived force-materialization band lies at or above `MIN_FORCE_MATERIALIZE_PERCENTAGE` and strictly below the fixed emergency band, and is monotone non-decreasing in the threshold.
Check: `always` — for every f64 threshold, `85.0 <= force_materialize_percentage < emergency_percentage == 95.0`, and `t1 <= t2` implies `bands(t1).force <= bands(t2).force`. `always` because every boundary resolution and every scheduler band derivation calls it.
Fault/timing angle: none.
Required faults and enabling state: none. A threshold of `f64::NAN`, a negative threshold, or a threshold above `90` are the interesting inputs.
Confidence: high — [evidence](../evidence/dec-a-escalation-bands-stay-ordered-for-every-threshold.md). `scheduler.rs:187-198`. The non-finite arm substitutes `65.0` (`:191`); the finite arm caps at `90.0` (`:190`), so `threshold + 2.0 <= 92.0` and `force = max(85.0, threshold + 2.0)` lies in `[85, 92]`, always below the constant `95.0` at `:21`. Confirmed the four consumers: `boundary.rs:815-816`, `:484-485`, `:978-980`, and `scheduler.rs:522-526`.
Existing check: `scheduler.rs:1238` and, in `boundary.rs`, the golden constant assertions at `:2226-2227`. Status `unaudited`.
Impact: if a threshold could push the force band to or past `95`, the `Force85` arm at `scheduler.rs:525` would become unreachable and the emergency arm would absorb the whole force band, changing which passes bypass mid-turn deferral. The cap makes that impossible, and this record pins it.
Open questions: None.

## Contract-vs-code leads

Each lead cites both sides. Leads that became records are not repeated.

1. **`historian_timeout_ms` has no consumer in `mc-module`.**
   `CONFIGURATION.md:170` documents `300000` as the "Timeout per historian call
   (ms)". `rg historian_timeout_ms crates/mc-module/src` returns zero matches,
   while `historian_producer.rs:209-210` and `:226-227` carry their own
   `request_timeout` and `await_timeout` from private constants. The module makes
   the historian call, so the documented key names behaviour it owns. 4a scope.

2. **`history_budget_percentage` has no consumer anywhere in the crate.**
   `CONFIGURATION.md:171` documents `0.15`, range `0.05-0.5`, as the fraction of
   usable context reserved for the history block, and says exceeding it "Triggers
   compression". Zero occurrences in `crates/mc-module/src`. Either the TypeScript
   leg owns it entirely or it is dead documentation.

3. **`prompt_surface.guidance_override_text` is undocumented and interacts with
   the documented key.** `config.rs:479-485` reads the text form;
   `resolve_user_guidance_override` (`:281-358`) then sets
   `prompt_surface_guidance_override = None` at `:299` before resolving the path,
   with the comment at `:297-298` stating that a configured path is the only
   override source. So a config with both keys silently discards the text, and an
   invalid path discards both. `CONFIGURATION.md:75-88` documents only the path.

4. **`historian.module_model` is the highest-consequence undocumented key.**
   `config.rs:390-409` gives it precedence over `historian.model` and replaces
   the whole chain. The comment at `:384-389` explains that this exists because
   the module and the plugin resolve different model namespaces. Nothing in
   `CONFIGURATION.md` mentions it, so a user cannot discover the key that decides
   which model the module bills.

5. **The privacy gate's default is closed while the documented task default is
   scheduled.** `config.rs:128` defaults `user_memory_collection_enabled` to
   `false`; `CONFIGURATION.md:527` gives `review-user-memories` a default schedule
   of `0 3 * * *`, and `:640` says the task is "Privacy-sensitive - only runs when
   scheduled". `user_memory_collection_at` (`config.rs:611-621`) treats a
   non-empty schedule string as consent. The divergence is fail-closed, so it is a
   documentation defect rather than a safety one, but the two defaults disagree.

6. **The code's legacy fallback pointer may not match the documented legacy
   location.** `config.rs:618-620` reads `/user_memories/enabled` at the config
   root. `CONFIGURATION.md:638` describes "the former `user_memories` sub-feature
   block" under `dreamer`, which would be `/dreamer/user_memories`. If the legacy
   key really lived under `dreamer`, the fallback never fires for a real legacy
   config. Unresolved; needs the TypeScript migration code, which is out of scope.

7. **`config.rs:113-114` calls the model-key walk "shared" when it is
   duplicated.** Recorded as
   `dec-a-model-key-lookup-walk-has-two-implementations-that-disagree`. Listed
   again here because the false word is in a doc comment, not just in behaviour.

## Open questions

- Should Part 4f treat a property whose only existing check lives in a test
  binary CI never runs as `Exercised: partial` or `Exercised: not yet`? The scope
  map raised this at `:681` and left it needing human input. Every `Exercised:
  partial` label above assumes `partial` means "a check exists and covers this
  much", independent of whether CI executes it. If the ruling goes the other way,
  every `partial` in this lens becomes `not yet`. (needs human input)
- Is `boundary.rs:687-691`'s use of the maximum ordinal as `total_message_count`
  correct for a sparse tail? It is consumed at `:705` and clamps an exclusive end
  at `:1705-1706`. I could not construct a behavioural difference from 4f scope
  alone. Unresolved, needs the ingress projection's ordinal-density contract,
  which is the sibling codec lens's material.
- Do the four undocumented but effective keys belong in `CONFIGURATION.md`, or is
  the module config deliberately a private surface? The file's own header
  (`config.rs:1-9`) reads like a public contract, and three of the four keys have
  TypeScript twins named in adjacent comments. (needs human input)
- Is there any conformance test that compares the documented key set against
  what `config.rs` parses? I found none. 4b's `existing-checks.md:571-574`
  proposed exactly such a check for its four keys; with nine keys now in the same
  category, the check would pay for itself. Unresolved, needs a decision at
  synthesis about whether to propose it in `fault-map.md`.
