# Part 4f lens C1: claimed guarantees and the configuration contract

Attention focus: the claims made *about* sub-part 4f, mined from the documented
contract rather than from the code, then pointed back at the code. This lens
inventories claimed guarantees and builds the configuration contract table. It
does not enumerate tests; a sibling agent owns the check inventory.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`.
Method contract in [../../METHOD.md](../../METHOD.md). Scope from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md)
sub-part 4f (`:607-611`).

Claim sources mined exhaustively: `CONFIGURATION.md` (841 lines, repository
root, not `docs/CONFIGURATION.md`) and `packages/pi-plugin/PARITY.md` (983).
Also mined: module headers and doc comments in `crates/mc-module/src/codec/`
(`mod.rs` 299, `opencode.rs` 2,186, `pi.rs` 1,499, `sidecar.rs` 339),
`config.rs` (1,229), `scheduler.rs` (1,449), `boundary.rs` (3,053),
`selection.rs` (3,365), `caveman.rs` (651), plus the call sites in `lib.rs` and
`transform.rs` that consume them.

Two scope-map file names do not exist at `HEAD`. There is no
`crates/mc-module/src/sidecar.rs`; the file is `crates/mc-module/src/codec/sidecar.rs`.
Every other named file resolves.

Sibling lenses own twenty-six records: fourteen `dec-a-` in
[lens-a-decision-units-and-config.md](lens-a-decision-units-and-config.md) and
twelve `codec-b-` in [lens-b-harness-codecs.md](lens-b-harness-codecs.md). None
are restated here. Where a sibling record already carries a claim, this lens
cites the record and adds only the claim text and the citation the sibling did
not have.

Every line reference below was read back individually at `HEAD`. Three sibling
citations are off by one or two lines and are corrected in place, with the
correction noted.

## Claims register

Thirty claims, capped as instructed. Each is a lead. The documentation
establishes the obligation and never the satisfaction of it. Grouped by source.
"Implementing code" names the location that would have to be correct for the
claim to hold, or `NOT FOUND` when no code in the repository implements the
claimed property at all.

### Group 1: cross-harness and cross-implementation parity

**C1-01. The master parity claim.**
Quote: "They must produce the **same effective behavior** (cache stability,
overflow protection, decay tiers), but the *mechanism* differs where the host
runtimes differ." (`packages/pi-plugin/PARITY.md:13-15`)
Implied property: for the shared inputs, the OpenCode and Pi legs agree on
cache-stability, overflow, and decay-tier outcomes.
Implementing code: `NOT FOUND` as an executable oracle inside `mc-module`. The
two decoders are structurally independent (`codec/opencode.rs:23`,
`codec/pi.rs:19`) and produce the same type, `DecodedHarnessMessages`
(`codec/sidecar.rs:28`), so the comparison is cheap and is not made.

**C1-02. Strict idle-TTL boundary, both harnesses.**
Quote: "Both OpenCode and Pi treat `elapsed == cache_ttl` as a defer pass. The
hard-fold predicate is strict `elapsed > ttl`, so the exact boundary does not pay
for a provider-cache rebuild." (`PARITY.md:908-911`)
Implied property: at exactly `elapsed == ttl`, both the scheduler predicate and
the hard-fold predicate are false.
Implementing code: `scheduler.rs:423-425` (`ttl_execute_fired`, strict `>`) and
`scheduler.rs:429-431` (`ttl_hard_expired`, strict `>` with a
`last_response_time_ms > 0` gate). The claim holds in the code. The doc comment
at `scheduler.rs:427-428` restates it correctly, but a test comment at
`scheduler.rs:1431` says "Hard: elapsed >= u64::MAX is never true" and names the
wrong comparator for the function it is testing.

**C1-03. One model-key lookup order for all three model maps.**
Quote: "`cache_ttl`, execute-threshold, prompt-surface model maps | Resolve
through `modelRefLookupOrder`, whose first candidate is canonical and whose
fallbacks include native aliases." (`PARITY.md:963`)
Implied property: the three per-model maps resolve a model reference by one
shared, alias-aware order.
Implementing code: partial. `cache_ttl` has a walk at `config.rs:176-200`.
The execute-threshold object form is `NOT FOUND`: `config.rs:430` reads
`/execute_threshold_percentage` through `number_at`, and `number_at`
(`config.rs:631-637`) yields `None` for a JSON object, so no map is ever
consulted. The prompt-surface map is `NOT FOUND` in `mc-module`. The claim also
says "one" order while `config.rs:113-114` calls its walk "shared" when it is
duplicated; see `dec-a-model-key-lookup-walk-has-two-implementations-that-disagree`.

**C1-04. Pi folds `toolResult` runs into a synthetic user message.**
Quote: "**`synth-user-<realId>` folding:** Pi folds runs of `toolResult` entries
into a synthetic user message (the toolResult to assistant transition)."
(`PARITY.md:164-166`)
Implied property: the Pi decode path emits folded synthetic user messages, and
consumers see the folded shape.
Implementing code: `NOT FOUND` in `codec/pi.rs`. Each `toolResult` entry maps to
its own CK message. Confirms the sibling's lead five
([lens-b-harness-codecs.md:513-522](lens-b-harness-codecs.md)); the likely
reading is that the fold lives in the TypeScript adapter upstream of the Rust
codec, which would mean the Rust Pi decoder has never seen the shape the
document describes.

**C1-05. The `pi-msg-<index>` id scheme was migrated away.**
Quote: "**`pi_stable_id_scheme` (migration v25):** a one-time forced-execute
cutover that re-keys persisted tag/drop/caveman/placeholder state from
`pi-msg-<index>` ids to real `SessionEntry` ids." (`PARITY.md:172-175`)
Implied property: no live code path mints a `pi-msg-<index>` id.
Implementing code: contradicted. `pi_stable_key` (`codec/pi.rs:712-717`) falls
back to `format!("pi-msg-{entry_index}-{}", stable_hash_prefix(message, 24))` at
`codec/pi.rs:715`. The sibling cited `:714`; the mint is at `:715`. It fires only
when `id`, `responseId`, and the message timestamp are all absent.

**C1-06. Pi drops thinking parts and image payloads before the shared core.**
Quote: "**Pi:** transcript shaping deliberately drops thinking parts and image
payloads before the shared protected-tail core sees the folded OpenCode-shaped
messages." (`PARITY.md:791-793`)
Implied property: the Pi decoder never receives, and therefore never emits,
thinking or image content.
Implementing code: contradicted. `codec/pi.rs` decodes thinking at `:194-218`
and images at `:159-162` and `:873-875`. Either the Rust coverage of those
shapes is unreachable in production or the parity claim is scoped to a layer a
reader would not guess.

**C1-07. Text and tool I/O parity is tested.**
Quote: "Pi still preserves text and tool invocation/result I/O, so
protected-tail sizing, tool-arc fencing, and historian eligibility are
parity-tested for those fields." (`PARITY.md:794-796`)
Implied property: a test drives the same text and tool-I/O input through both
legs and compares protected-tail sizing, arc fencing, and eligibility.
Implementing code: `NOT FOUND` in `mc-module`. Nothing composes `decode_pi` with
`boundary::resolve_protected_tail_boundary` or with
`boundary::check_compartment_trigger*`.

**C1-08. Caveman is a byte-for-byte port of the TypeScript twin.**
Quote: "This is a byte-for-byte Rust port of
`packages/plugin/src/hooks/magic-context/caveman.ts`. Keep the transformation
order and ASCII word-boundary rules aligned with that source: the committed
differential fixture is the compatibility contract." (`caveman.rs:3-6`)
Implied property: for every input, `compress(text, level)` equals the TypeScript
oracle's output.
Implementing code: `caveman.rs:626-650`, the single test in the file, over
`testdata/caveman-golden.json`. The fixture holds 42 cases, each carrying `lite`,
`full`, and `ultra` expectations, so the contract is discharged on 42 strings in
one direction. The transformation order the header asks a maintainer to preserve
lives at `caveman.rs:587-610`.

**C1-09. The execute-threshold default must equal the TypeScript schema.**
Quote: "The Rust module reads config without the plugin, so this must stay
identical to packages/plugin/src/config/schema/magic-context.ts."
(`config.rs:17-18`, on `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE`)
Implied property: the Rust constant tracks the TypeScript schema default.
Implementing code: `NOT FOUND`. `config.rs:19` sets `65.0`. Nothing reads the
TypeScript schema, so drift is silent in both directions.

**C1-10. Two memory budget defaults must stay at 4,000 tokens.**
Quote: "This is the twin of `packages/plugin/src/config/schema/magic-context.ts`
and must stay at 4,000 tokens." (`config.rs:20-22`) and "It must remain 4,000
tokens so the Rust module and the TypeScript renderer use the same default."
(`config.rs:23-24`)
Implied property: `DEFAULT_MEMORY_BUDGET_TOKENS` and
`DEFAULT_USER_PROFILE_BUDGET_TOKENS` equal their TypeScript twins.
Implementing code: `NOT FOUND`. The constants are at `config.rs:22` and `:25`.
Same class as C1-09.

**C1-11. Two hardwired trigger constants mirror the TypeScript schema.**
Quote: "Mirrors packages/plugin/src/config/schema/magic-context.ts
commit_cluster_trigger.enabled default." (`lib.rs:604`) and the same sentence for
`min_clusters` (`lib.rs:606`).
Implied property: the hardwired values track the TypeScript schema defaults.
Implementing code: `NOT FOUND`. The constants are `lib.rs:605` and `lib.rs:607`,
consumed at `lib.rs:4963` and `lib.rs:4964`. The sibling cited `:4962` and
`:4963`; the uses are at `:4963` and `:4964`. Because the two config keys are
never parsed at all (see the table), a schema change on the TypeScript side is
invisible here and unfixable by a user.

**C1-12. The protected-tag default matches OpenCode's window.**
Quote: "Matches the default OpenCode protected tag window. The Claude Code
facade has no request-local transform config, so acknowledgement validation uses
the durable tag ordering with the same default recency window as an omitted
transform field." (`lib.rs:600-602`)
Implied property: `DEFAULT_PROTECTED_TAGS` (`lib.rs:603`, value `20`) equals the
documented `protected_tags` default of `20` (`CONFIGURATION.md:165`).
Implementing code: `NOT FOUND` as a check. The two `20`s agree today by
coincidence of authorship, and `protected_tags` is not read from module config
at all (4b's `sel-protected-tags-not-read-from-module-config`).

**C1-13. Selection constants are exact ports.**
Quote: "// --- ported TS constants (exact; the differential golden is the
arbiter) ---" (`selection.rs:33`)
Implied property: each ported constant equals its TypeScript value, with the
differential golden as the deciding oracle.
Implementing code: `NOT FOUND` for the constants themselves. The selection
golden is generated by `gen/gen-selection-golden.ts` and compares decision
output, not the constant table, so a constant whose value is never exercised by a
golden case can drift undetected. The constants begin at `selection.rs:35`.

**C1-14. The duplicate-safe tool list mirrors the TypeScript twin.**
Quote: "Mirrors the duplicate-safe tool list in the TypeScript twin:
`packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts`"
(`selection.rs:43-44`)
Implied property: `DEDUP_SAFE_TOOLS` (`selection.rs:45`) is set-equal to the
TypeScript list.
Implementing code: `NOT FOUND` as a set-equality check. Set equality is the
claim; per-case golden agreement is the evidence available, and it only covers
tools the golden happens to contain.

### Group 2: decision determinism, purity, and totality

These are the module headers' own claims. The sibling lens verified them
structurally; this register records them as claim text with the citation, because
a structural verdict at one commit is not a check.

**C1-15. Boundary and trigger determinism.**
Quote: "There is no I/O, wall clock, store access, or ambient cache state here:
the same inputs always produce the same boundary and trigger decision."
(`boundary.rs:6-9`)
Implied property: repeated invocation on identical inputs yields identical
`BoundaryResolution` and `TriggerDecision`, including the reason string.
Implementing code: structural only. Eight `OnceLock<Regex>` caches hold
compile-time-constant patterns; the sole `HashMap` is a lookup built from a
`BTreeMap`. No repeat-invocation equality assertion exists.

**C1-16. Selection determinism as the cache invariant.**
Quote: "This is the module-owned reduction producer. It is a PURE, DETERMINISTIC
function over the flat, block-granular typed tail ... Determinism is the cache
invariant: same (items, frozen_keys, ctx, cfg) -> same decisions -> the slice-3
freeze/replay stays byte-identical." (`selection.rs:4-7`)
Implied property: the decision vector is a function of the four named inputs, and
downstream replay bytes are identical across passes.
Implementing code: `selection::select_reductions_with_outcome`
(`selection.rs:1119-1385`). See
`dec-a-selection-decision-order-is-total-under-hashmap-iteration`.

**C1-17. Payload purity.**
Quote: "**payload purity**: every payload is a pure function of (id, immutable
block bytes) with ZERO pass-varying state, so a frozen target can never be
re-emitted with different bytes." (`selection.rs:19-22`)
Implied property: for a fixed id and block bytes, the emitted payload is
constant across passes and across pass classes.
Implementing code: `selection::skeleton_payload` (`:648-694`) and
`canonical_json` (`:597-619`), plus `region_hint` (`:558-571`). `region_hint`
carries a known bypass; see `dec-a-region-hint-clamp-bypassed-by-sentinel-suffix`.

**C1-18. Deterministic merge.**
Quote: "**deterministic merge**: exactly one decision per target; `drop` beats
`edit_marker`; stable output order." (`selection.rs:26-27`)
Implied property: three separable claims. Uniqueness of `target_id`, a total
priority order over kinds, and a stable output order independent of map
iteration.
Implementing code: `selection.rs:1119-1385`, with the sort before return.

**C1-19. The frozen-keys hard filter.**
Quote: "**frozen_keys HARD FILTER**: a CK item stays LIVE with original bytes
after reduction (unlike a TS dropped tag, which leaves the active set), so every
selector MUST exclude already-frozen ids up front or it would re-target them."
(`selection.rs:14-17`)
Implied property: no emitted decision names an id in `frozen_keys`.
Implementing code: distributed across the selectors, with no shared chokepoint.
The word "MUST" is addressed to a future selector author, which makes this a
convention claim as well; see the conventionally-enforced section.

**C1-20. Arc-safe emission and reasoning immutability.**
Quote: "**arc-safe emission**: a tool reduction emits decisions for its ToolCall
and paired ToolResult together. Reasoning is never rewritten, and a
reasoning-bearing assistant with no other durable sibling makes the whole tool
arc ineligible." (`selection.rs:23-25`)
Implied property: three claims. Pairwise emission, no reasoning decision ever,
and an ineligibility rule keyed on a reasoning-bearing assistant.
Implementing code: `selection.rs:1119-1385`. The "never" is the checkable half.

**C1-21. Scheduler purity.**
Quote: "Pure state-transition functions; durable state enters as parameters and
exits in return values." (`scheduler.rs:3-4`)
Implied property: `decide` reads no clock and no ambient state; `now_ms` is a
parameter.
Implementing code: `scheduler::decide` (`:706-800`), with `now_ms` taken from
`SchedulerInputs`.

### Group 3: the configuration contract

**C1-22. The execute threshold has a documented lower bound of 20.**
Quote: "| `execute_threshold_percentage` | `number` (20-90) or `object` | `65` |"
(`CONFIGURATION.md:167`)
Implied property: a configured value below 20 is rejected or raised to 20.
Implementing code: contradicted. `config.rs:568-570` clamps to
`[1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE]`, and
`MAX_EXECUTE_THRESHOLD_PERCENTAGE` is `90.0` (`config.rs:28`). The upper bound is
implemented; the lower bound is `1`, not `20`. Recorded as
`dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1`.

**C1-23. The memory injection budget has a documented range.**
Quote: "| `injection_budget_tokens` | `number` (500-20000) | `4000` | Token
budget for memory injection into `<session-history>`. |"
(`CONFIGURATION.md:591`)
Implied property: a configured value outside `[500, 20000]` is rejected or
clamped.
Implementing code: `NOT FOUND` for either bound. Three assignment sites apply
`.max(1.0)` and nothing else: `config.rs:442` and `:444` (user tier, including
the deprecated key) and `config.rs:527` (project tier). Recorded as
`dec-a-memory-injection-budget-documented-range-has-no-implementing-code`.

**C1-24. The trigger-budget formula.**
Quote: "The tail must also contain at least one `trigger_budget` worth of tokens,
where `trigger_budget = main_context x execute_threshold x 5%` clamped to
`[5K, 50K]`." (`CONFIGURATION.md:238`)
Implied property: the derived budget equals that formula and lies in
`[5000, 50000]`.
Implementing code: `boundary::derive_trigger_budget` (`:338-346`), which computes
`context_limit * (threshold/100) * TRIGGER_BUDGET_PERCENTAGE`, rounds, and
clamps. The doc comment is at `:337`. Non-finite and non-positive
`context_limit` return `TRIGGER_BUDGET_MIN` at `:340-342`, which the
documentation does not mention; see
`dec-a-boundary-budget-derivation-is-total-over-non-finite-input`.

**C1-25. `min_clusters` has a documented minimum of 1.**
Quote: "`\"min_clusters\": 3   // default: 3, minimum: 1`"
(`CONFIGURATION.md:232`)
Implied property: a configured `min_clusters` below 1 is rejected or raised.
Implementing code: `NOT FOUND`. The key is never parsed. `lib.rs:4964` passes the
hardwired `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:607`, value `3`), so there is no
input to bound. Recorded as `dec-a-commit-cluster-trigger-config-is-inert-in-this-crate`.

**C1-26. The `"never"` TTL sentinel disables both consumers.**
Quote: "**`\"never\"` sentinel:** set `cache_ttl` to `\"never\"` to disable the
idle-TTL heuristic entirely. Both consumers - the scheduler (which converts defer
passes to execute after TTL expiry) and the HARD-fold trigger (which folds m[1]
into m[0] on a \"free\" prefix rebuild) - no longer act on idle time."
(`CONFIGURATION.md:143-145`)
Implied property: with `cache_ttl: "never"`, both `ttl_execute_fired` and
`ttl_hard_expired` are false for every reachable `now_ms`.
Implementing code: `scheduler::parse_cache_ttl` (`:385-419`) returns `u64::MAX`
for a case-insensitive, trimmed `"never"` at `:387-389`; both predicates use
strict `>` against that value (`:424`, `:430`), so no finite elapsed time fires.
The claim holds. Note that this makes the sentinel's correctness depend on the
comparator staying strict, which is also C1-02's claim.

**C1-27. Tier precedence: two documents disagree.**
Quote A: "Project config always merges on top of user config."
(`CONFIGURATION.md:14`)
Quote B: "project config may only raise the execute threshold (fire less often),
and may override trusted memory, auto-search, caveman, promotion, and privacy
settings. User-profile and historian budgets remain user-tier only."
(`config.rs:4-7`)
Implied property: for each leaf, exactly one tier policy holds, and the two
sources name the same one.
Implementing code: `config.rs:515-518` implements raise-only for the execute
threshold, so quote B governs and quote A is wrong for at least that leaf. The
enforcement is per-leaf and hand-written across `config.rs:429-566`, so quote A
is a general statement with per-leaf exceptions that the configuration document
does not enumerate.

**C1-28. `output_reserve` clamping respects the module's plausibility floor.**
Quote: "Very large values are clamped so the usable window remains at least half
of the raw context (and never below the module's plausibility floor); Magic
Context logs when a clamp is required." (`CONFIGURATION.md:315`)
Implied property: the reservation clamp composes with `mc-module`'s plausibility
floor.
Implementing code: `NOT FOUND`. `output_reserve` has zero occurrences in
`crates/mc-module/src`. The named floor exists at `scheduler.rs:33`
(`MIN_PLAUSIBLE_CONTEXT_LIMIT`, `1024`) with its ceiling at `:35`, and is applied
only to a provider-reported limit (`scheduler.rs:697`, `lib.rs:15610`,
`transform.rs:5916`). The documentation therefore attributes to the module a
composition the module never performs. New lead; the sibling classified
`output_reserve` as out of scope, before this sentence was read.

**C1-29. Caveman tier shifts are path-independent.**
Quote: "**Always compressed from the original.** The pristine pre-caveman text is
persisted in `source_contents` per tag. When a tag shifts deeper (lite -> full ->
ultra), caveman compresses the ORIGINAL text at the new target depth rather than
the already-cavemaned intermediate, so repeated tier shifts converge to exactly
the same output as direct compression at the final depth."
(`CONFIGURATION.md:740`)
Implied property: the bytes at depth `d` are independent of the sequence of
depths traversed to reach `d`.
Implementing code: `transform.rs:6339` reads `row.source_bytes` and
`transform.rs:6358` calls `caveman::compress(&source, level)` on it, so the
claim's mechanism is real and lives outside 4f. `transform.rs:6352-6354` refuses
a non-increasing depth. The property is not asserted anywhere; `caveman.rs`'s
only test compares single-shot output against the golden. Note the claim is
load-bearing precisely because `compress` is not idempotent by construction:
`apply_ultra_connectives` and `apply_ultra_abbreviations`
(`caveman.rs:472`, `:501`) rewrite words into symbols that a second pass would
see as different input.

**C1-30. `smart_drops` off is byte-identical to the previous behaviour.**
Quote: "**When `smart_drops` is off, the messages sent to the model are
byte-identical to the age-based-only behavior** - the entire feature is inert."
(`CONFIGURATION.md:763`)
Implied property: with the flag false, the emitted message array equals the
array the age-based path alone would emit, byte for byte.
Implementing code: `NOT FOUND` as a byte-equality check. The flag defaults false
(`config.rs:135`) and is set from either tier (`config.rs:467-469`, `:541-543`).
The claim is the strongest testable statement in the whole configuration
document, because a single flag flip gives a free differential oracle, and
nothing takes it.

### Register totals

| Disposition | Count | Ids |
| --- | --- | --- |
| Implementing code found, claim consistent at `HEAD` | 13 | C1-02, C1-08, C1-15 to C1-21, C1-24, C1-26, C1-27, C1-29 |
| `NOT FOUND`: no code implements the claimed property | 13 | C1-01, C1-04, C1-07, C1-09 to C1-14, C1-23, C1-25, C1-28, C1-30 |
| Contradicted by code | 3 | C1-05, C1-06, C1-22 |
| Partial: implemented for some named subjects only | 1 | C1-03 |

Eight of the thirteen `NOT FOUND` claims are cross-implementation parity claims
whose oracle lives in TypeScript. That is the register's dominant shape: the Rust
module states its obligations against a twin it never reads.

## Configuration contract table (key | code default | documented default | enforced bound | takes effect here?)

Thirty leaves. Selection rule: every key `config.rs` parses, plus every
documented key whose description names behaviour `mc-module` performs. "Enforced
bound" is the bound the Rust code actually applies, which is the column the
sibling table did not carry. "Takes effect here?" means the parsed value reaches
a decision inside `mc-module`.

| Key | Code default | Documented default | Enforced bound | Takes effect here? |
| --- | --- | --- | --- | --- |
| `execute_threshold_percentage` (scalar) | `65.0` (`config.rs:19`, `:122`) | `65`, range `20-90` (`CONFIGURATION.md:167`) | `clamp(1.0, 90.0)` (`config.rs:568-570`); project tier may only raise (`:515-518`) | Yes. **Divergent**: documented lower bound `20`, enforced `1` |
| `execute_threshold_percentage` (object form) | not parsed | documented, example at `:791` | none | **No.** `number_at` (`config.rs:631-637`) returns `None` for an object; 4b's `sel-per-model-and-token-thresholds-inert-in-module` |
| `execute_threshold_tokens` | not parsed | documented (`:168`, `:319-338`), doc claims clamp to `90% x context_limit` | none | **No.** Same 4b record. The documented clamp has no implementing code |
| `compaction.enabled` | `true` (`config.rs:123`) | `true` (`:172`) | none; user tier only, project warns (`config.rs:520`) | Yes, user tier (`:433-435`) |
| `memory.enabled` | `true` (`config.rs:124`) | `true` (`:589`) | none | Yes, both tiers (`:436-438`, `:521-523`) |
| `memory.injection_budget_tokens` | `4000.0` (`config.rs:22`, `:130`) | `4000`, range `500-20000` (`:591`) | `.max(1.0)` only (`config.rs:442`, `:527`) | Yes, both tiers. **Divergent**: neither documented bound exists |
| `memory.budget_tokens` (deprecated) | falls back to the same field (`config.rs:443-445`) | absent from the documented table | `.max(1.0)` | Yes, user tier, with a deprecation warning (`:446-451`); project warns and ignores (`:538`) |
| `memory.user_profile_budget_tokens` | `4000.0` (`config.rs:25`, `:131`) | **undocumented** | `.max(1.0)` (`config.rs:453`) | Yes, user tier only (`:452-454`); project warns (`:539`) |
| `memory.auto_promote` | `true` (`config.rs:127`) | `true` (`:592`) | none | Yes, both tiers (`:455-461`, `:529-535`) |
| `memory.auto_search.enabled` | `true` (`config.rs:60`) | `true` (`:682`) | none | Yes, both tiers (`:584-590`) |
| `memory.auto_search.score_threshold` | `0.6` (`config.rs:39`) | `0.6`, prose range `0.3-0.95` (`:683`, `:706`) | `clamp(0.3, 0.95)`, silent (`config.rs:591`) | Yes. Bound matches the prose; the clamp is invisible to the caller |
| `memory.auto_search.min_prompt_chars` | `20` (`config.rs:40`) | `20`, **no range documented** (`:684`, `:707`) | `clamp(5, 500)` (`config.rs:595`); a `0` is silently discarded by `positive_usize_at` (`:623-629`) | Yes. **Divergent**: an undocumented bound and an undocumented discard |
| `caveman_text_compression.enabled` | `false` (`config.rs:75`) | `false` (`:724`) | none | Yes, both tiers (`:600-606`) |
| `caveman_text_compression.min_chars` | `500` (`config.rs:42`, `:77`) | `500`, **no range documented** (`:725`) | `clamp(100, 10_000)` (`config.rs:607`); a `0` discarded | Yes. **Divergent**: undocumented bound |
| `smart_drops` | `false` (`config.rs:135`) | `false` (`:752`) | none | Yes, both tiers (`:467-469`, `:541-543`) |
| `dreamer.inject_docs` | `true` (`config.rs:132`) | `true` (`:501`) | none | Yes, both tiers (`:470-475`, `:544-549`) |
| `temporal_awareness` | `true` (`config.rs:133`) | `true` (`:650`) | none | Yes, both tiers (`:476-478`, `:550-555`) |
| `dreamer.tasks.review-user-memories.schedule`, legacy `user_memories.enabled` | privacy gate defaults `false` (`config.rs:128`) | task default schedule `0 3 * * *`, i.e. on (`:527`) | none; a non-empty trimmed string reads as consent (`config.rs:611-621`) | Yes as a presence test. **Divergent**: module default is closed, documented default is scheduled |
| `historian.model`, `historian.fallback_models` | empty chain (`config.rs:121`) | documented with **no user-only marker** (`:448-449`) | `model_chain.dedup()` (`config.rs:571`), adjacent-only | Yes, user tier only (`:411-424`). **Divergent**: a project-tier value is dropped with no warning; `warn_ignored_project_key` is never called for it |
| `historian.module_model`, `historian.module_fallback_models` | absent | **undocumented** | none | Yes, user tier only, and it replaces the whole chain (`config.rs:390-409`) |
| `historian.context_limit_tokens` | `128_000` (`config.rs:37`, `:129`) | **undocumented** | `> 0` via `positive_usize_at` (`config.rs:464-466`) | Yes; project tier warns (`:540`) |
| `cache_ttl` (string or object) | `"5m"` (`config.rs:136`) | `"5m"` (`:163`), **no user-only marker** | parse is total; invalid falls back to `DEFAULT_CACHE_TTL_MS` (`scheduler.rs:810-812`); `"never"` maps to `u64::MAX` (`:387-389`) | Yes, user tier only (`config.rs:486-511`). **Divergent**: project-tier value dropped with no warning, and `"0"` parses to `0` ms and forces execution every pass, undocumented |
| `prompt_surface.guidance_override_path` | `None` | documented, user-only (`:75`, `:80-88`) | must be a readable section with exactly one marker (documented at `:88`) | Yes (`config.rs:281-358`); project warns (`:561-565`) |
| `prompt_surface.guidance_override_text` | `None` | **undocumented** | none | Yes (`config.rs:479-485`), but a configured path resets it to `None` first (`:299`); project warns (`:556-560`) |
| `commit_cluster_trigger.enabled` | not parsed | `true` (`:237`) | none | **No.** Hardwired `DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED` (`lib.rs:605`) at `lib.rs:4963` |
| `commit_cluster_trigger.min_clusters` | not parsed | `3`, **minimum `1`** (`:232`, `:238`) | none | **No.** Hardwired `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:607`) at `lib.rs:4964` |
| `protected_tags` | not parsed | `20`, range `1-100` (`:165`) | none from config; a separate hardwired `20` at `lib.rs:603` | **No.** 4b's `sel-protected-tags-not-read-from-module-config` |
| `clear_reasoning_age` | not parsed | `50` (`:169`) | none | **No.** Present in `mc-module/src` only as a request field, never as a config pointer |
| `historian_timeout_ms` | not parsed | `300_000` (`:170`) | none | **No.** Zero occurrences in `crates/mc-module/src`; `historian_producer.rs:209-227` carries private timeouts. 4a scope, lead only |
| `history_budget_percentage` | not parsed | `0.15`, range `0.05-0.5` (`:171`) | none | **No.** Zero occurrences in `crates/mc-module/src` |
| `output_reserve` | not parsed | automatic; `0` disables (`:164`, `:308-315`) | none in this crate, though `:315` names "the module's plausibility floor" | **No.** Zero occurrences in `crates/mc-module/src`; see C1-28 |

The table has 31 rows because `output_reserve` is promoted from the sibling's
out-of-scope bucket by C1-28. Treat the leaf count as 31 and the sibling's 30
named leaves as a subset.

### Totals

| Category | Count | Members |
| --- | --- | --- |
| Documented leaves in the table | 26 | all rows except the four undocumented leaves and the deprecated `memory.budget_tokens` |
| Undocumented but effective | 4 | `memory.user_profile_budget_tokens`, `historian.module_model` with `module_fallback_models`, `historian.context_limit_tokens`, `prompt_surface.guidance_override_text` |
| Documented but **inert** (parsed nowhere; behaviour hardwired or missing) | 6 | `execute_threshold_percentage` object form, `execute_threshold_tokens`, `commit_cluster_trigger.enabled`, `commit_cluster_trigger.min_clusters`, `protected_tags`, `clear_reasoning_age` |
| Documented and effective but **divergent** (bound, tier policy, or default disagrees) | 7 | `execute_threshold_percentage` scalar, `memory.injection_budget_tokens`, `memory.auto_search.min_prompt_chars`, `caveman_text_compression.min_chars`, `review-user-memories` schedule, `historian.model` with `fallback_models`, `cache_ttl` |
| Absent everywhere (documented, zero occurrences in `crates/mc-module/src`, description names module behaviour) | 3 | `historian_timeout_ms`, `history_budget_percentage`, `output_reserve` |
| Deprecated, absent from the documented table, still honoured | 1 | `memory.budget_tokens` |

Inert plus divergent gives **13** keys that are documented but inert or
divergent. This is a superset of the sibling's headline nine
([lens-a-decision-units-and-config.md:119-129](lens-a-decision-units-and-config.md)).
The four this lens adds, and why the sibling did not count them:
`clear_reasoning_age` (named inside a 4b evidence file but not among the
headline keys), `memory.auto_search.min_prompt_chars` and
`caveman_text_compression.min_chars` (the sibling recorded the clamps as
invisible to the caller but not as documentation divergences), and the
`review-user-memories` default (the sibling filed it as a lead rather than
counting it). The sibling's nine and this thirteen are the same finding at two
granularities; synthesis should pick one number and say which.

A further nine documented keys have zero occurrences in `crates/mc-module/src`
and describe behaviour outside the module: `toast_duration_ms` (`:166`),
`memory.retrieval_count_promotion_threshold` (`:593`),
`memory.git_commit_indexing.*` (`:665-667`), `fail_closed_blocking` (`:161`),
`allow_home_project` (`:159`), `auto_update` (`:160`), `keep_subagents` (`:174`),
`historian.thinking_level` (`:452`), and `historian.two_pass` (`:454`, present in
`mc-module/src` as a request field only). They are not defects in 4f and are
listed so a future conformance check can exclude them deliberately rather than by
omission.

## Contract-vs-code leads

Leads already carried as sibling records or as register entries above are not
repeated. Each lead cites both sides.

1. **The strongest available differential oracle is documented and untaken.**
   `CONFIGURATION.md:763` states that with `smart_drops` off "the messages sent
   to the model are byte-identical to the age-based-only behavior" and that "the
   entire feature is inert". The flag is a single boolean read at
   `config.rs:467-469` and `:541-543`, defaulting `false` at `config.rs:135`. A
   flag-off run against a pre-feature run is a free byte-equality oracle on the
   whole selection pipeline, and no code takes it. `CONFIGURATION.md:767` adds
   "The default stays off while cache stability is being validated in the wild",
   which names field observation as the validation strategy in place of the test.
   Recommend synthesis promote this to a record; it is the cheapest high-coverage
   check surfaced by either the claim or the config pass.

2. **`output_reserve` is documented as composing with a floor the module owns and
   never sees.** `CONFIGURATION.md:315` says very large values are clamped so the
   usable window stays "never below the module's plausibility floor". The floor is
   `scheduler.rs:33` and `:35`, and every application of it
   (`scheduler.rs:697`, `lib.rs:15610` and `:15614`, `transform.rs:5916`, `:5925`,
   `:5937`) takes a provider-reported context limit, not a reservation. The string
   `output_reserve` does not occur in `crates/mc-module/src`. So either the
   TypeScript leg re-implements the module's floor, in which case the two floors
   can drift with nothing to catch it, or the documented composition does not
   happen. Unresolved; needs the TypeScript reservation resolver, which is out of
   4f scope.

3. **The parity audit table claims a shared model-key lookup for a map the Rust
   config cannot read.** `PARITY.md:963` lists "`cache_ttl`, execute-threshold,
   prompt-surface model maps" as resolving through one `modelRefLookupOrder`.
   In `mc-module`, `cache_ttl` has a walk (`config.rs:176-200`), the
   execute-threshold object form is silently unreadable because `number_at`
   (`config.rs:631-637`) filters to `as_f64`, and there is no prompt-surface map
   at all. A reader auditing model-key handling against `PARITY.md:963` would
   conclude three maps share one discipline, when one map exists, one is
   unreachable, and one is absent.

4. **A documented minimum with no input to bound.** `CONFIGURATION.md:232` carries
   the inline comment `// default: 3, minimum: 1` for `min_clusters`, and `:238`
   documents its meaning. `lib.rs:4964` passes the hardwired `3`
   (`lib.rs:607`). A user who sets `min_clusters: 0` gets neither the documented
   rejection nor any effect, and receives no warning, because
   `warn_ignored_project_key` (`config.rs:575-582`) is only called for six
   pointers (`config.rs:520`, `:538`, `:539`, `:540`, `:556`, `:561`) and
   `commit_cluster_trigger` is not among them.

5. **The tier-policy statement in the configuration document is wrong in the
   general case.** `CONFIGURATION.md:14` says "Project config always merges on top
   of user config." `config.rs:4-7` states the real policy, and
   `config.rs:515-518` implements raise-only for the execute threshold. Six
   pointers are dropped from the project tier with an explicit warning; at least
   six more (`/historian/model`, `/historian/fallback_models`,
   `/historian/module_model`, `/historian/module_fallback_models`, `/cache_ttl`,
   and the object form of `/execute_threshold_percentage`) are dropped with no
   warning at all. The configuration document marks some leaves "user-config-only"
   in prose (`:159`, `:160`, `:161`, `:178`) but not these.

6. **A test comment names the wrong comparator for the predicate it tests.**
   `scheduler.rs:1431` reads `// Hard: elapsed >= u64::MAX is never true`, while
   `ttl_hard_expired` (`scheduler.rs:429-431`) uses strict `>`. The assertions
   below it pass under either comparator, so the comment cannot be caught by the
   test it annotates. This matters because C1-02 and C1-26 both rest on the
   comparator staying strict, and this is the one place a maintainer would look
   for the intended semantics.

7. **Four codec files publish no module-level contract.**
   `codec/mod.rs:1`, `codec/opencode.rs:1`, `codec/pi.rs:1`, and
   `codec/sidecar.rs:1` all begin with `use` or `pub mod` declarations. None
   carries a `//!` header. The three decision units in the same sub-part all do
   (`selection.rs:1-32`, `boundary.rs:1-9`, `scheduler.rs:1-4`), and those headers
   are where the checkable guarantees in Group 2 come from. The consequence is
   that every codec guarantee this lens found lives either in
   `packages/pi-plugin/PARITY.md`, which describes the TypeScript legs, or in
   scattered function doc comments. The one function doc comment that does state a
   guarantee overclaims it; see the sibling record
   `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`.

## Debug-versus-release behavioural divergence

Three `debug_assert!` sites exist in 4f scope. All three are in
`codec/opencode.rs`; `codec/mod.rs`, `codec/pi.rs`, `codec/sidecar.rs`,
`config.rs`, `scheduler.rs`, `boundary.rs`, `selection.rs`, and `caveman.rs`
contain none.

**1. `decode_opencode_sidecar_incremental` panics in release on an out-of-range
replace index.** Recorded as
`codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert`. The claim
detail this lens adds is the exact division of enforcement.

- `codec/opencode.rs:251` asserts `replace_from <= messages.len()`.
- `codec/opencode.rs:252` asserts `replace_from <= prior.order.len()`.
- `codec/opencode.rs:258` slices `&messages[replace_from..]`. With
  `debug_assertions` off, both asserts vanish and this line panics with a
  slice-index panic rather than a diagnosed precondition violation.
- Caller enforcement of the first bound: `lib.rs:12561`,
  `.filter(|replace_from| *replace_from <= native_len)` inside
  `validated_native_prefix` (`lib.rs:12550-12563`), where `native_len` comes from
  `request.native_messages` at `lib.rs:12555`.
- Caller enforcement of the second bound: `lib.rs:12577`,
  `if trusted_prefix > 0 && trusted_prefix <= snapshot.sidecar.order.len()`,
  guarding the call at `lib.rs:12578`. The sibling cited `:12576`; the guard is at
  `:12577` and the call at `:12578`.
- Neither call site cites the callee's precondition, and the callee's asserts do
  not cite either call site.
- The first bound is enforced against a `native_len` derived in
  `validated_native_prefix`, while `native_sidecar` re-derives the same slice at
  `lib.rs:12570` with `request.native_messages.as_deref().unwrap_or_default()`.
  The release-mode safety of `:258` therefore depends on those two derivations
  agreeing on length within one pass, which is an unstated invariant spanning two
  functions.

**2. `assert_unique_tool_use_ids` has no release behaviour at all.** Recorded as
`codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour`. The
function is `codec/opencode.rs:462-470`; its whole body is a
`debug_assert!(duplicates.is_empty(), ...)` at `:466-469` with the message
"OpenCode serialization produced duplicate tool_use ids: {duplicates:?}". In
release the call is a no-op that still computes nothing, so a duplicate
`tool_use` id reaches the provider unflagged. The only test naming this guard is
itself `#[cfg(debug_assertions)]`-gated
(`codec/opencode.rs:2077-2079`), so a release-profile test run cannot exercise
either the guard or its test.

**3. No divergence found in the config or decision units.** `config.rs`,
`scheduler.rs`, `boundary.rs`, `selection.rs`, and `caveman.rs` contain no
`debug_assert!`, no `#[cfg(debug_assertions)]` production code, and no
`unreachable!`. Their clamps (`config.rs:47`, `:570`, `:591`, `:595`, `:607`;
`boundary.rs:346`) and their totality guards
(`scheduler.rs:385-419`, `boundary.rs:340-342`, `selection.rs:1001-1009`) are
unconditional expressions that behave identically in both profiles. This is worth
recording as a positive: the divergence risk in 4f is concentrated entirely in one
codec file.

## Conventionally-enforced-only claims

Claims whose only enforcement is a convention, a comment, or a caller's
discipline, with no mechanism in the type system, no unconditional runtime check,
and no test.

1. **The incremental sidecar bound.** Enforced by two callers
   (`lib.rs:12561`, `:12577`) against a callee that only debug-asserts
   (`codec/opencode.rs:251-252`). A third caller added anywhere would inherit a
   release-mode panic with no compile-time signal. See the divergence section.

2. **The frozen-keys hard filter.** `selection.rs:14-17` says "every selector
   MUST exclude already-frozen ids up front". The word is addressed to a future
   author. There is no shared chokepoint that filters `frozen_keys` once; each
   selector does it, so the invariant is preserved by review rather than by
   construction.

3. **Payload purity.** `selection.rs:19-22` claims "ZERO pass-varying state". A
   payload builder that read a clock or a counter would compile, and the claim
   would be silently false on the next pass. The invariant is a coding rule.

4. **The block-identity stamp.** `codec/sidecar.rs:185-187` documents
   `has_stamped_block_identity` as "True when a decoded block still carries its
   exact native-part origin", but `stamped_block_identity`
   (`codec/sidecar.rs:177-183`) returns `Some` for any three well-formed values
   under the string key `_cortexkit_codec` (`:131`) inside `provider_extras`, and
   `stamp_block_identity` (`:158-175`) is the only writer by convention, not by
   encapsulation. Recorded as
   `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`.
   The claim text is added here because the overclaim is in prose.

5. **The four cross-implementation default-parity claims.** `config.rs:17-18`,
   `:20-22`, `:23-24`, and `lib.rs:604` and `:606` all say a constant "must stay"
   equal to a TypeScript value. The enforcement is that a reviewer notices. C1-09
   through C1-11.

6. **Caveman path-independence.** `CONFIGURATION.md:740` promises convergence, and
   the mechanism is the caller reading `row.source_bytes`
   (`transform.rs:6339`) rather than any property of `compress`
   (`caveman.rs:587-610`). A future caller that passed the already-compressed text
   would satisfy every type in sight and break the documented guarantee. C1-29.

7. **The harness-supplied absolute ordinal.** Recorded as
   `codec-b-absolute-ordinal-is-harness-supplied-and-never-validated`. Noted here
   because the claim side is the `base` parameter of
   `decode_opencode_with_sidecar_and_base` (`codec/opencode.rs:37`), which no doc
   comment constrains.

8. **A serialization guarantee asserted in a message.** `lib.rs:12588`,
   `serde_json::to_vec(meta).expect("OpenCode sidecar metadata must serialize")`.
   The `expect` string states an obligation; the sibling's lead seven established
   that it is sound because the payload is a `Value` tree, and that the same
   operation is treated as fallible at `ck_wire.rs:585-589` and
   `codec/sidecar.rs:155`. Three policies for one operation, and the strictest of
   the three is the one with a message that reads like a proof.

## Open questions

- Should the documented-but-inert-or-divergent count be the sibling's nine or
  this lens's thirteen? The two disagree only about granularity: whether an
  undocumented clamp bound and a disagreeing default are "divergence" or separate
  categories. Synthesis must pick one number, state the rule, and make both lens
  files agree, because two counts in one part directory will read as a
  contradiction. (needs human input)
- Is `output_reserve` in 4f scope? C1-28 pulls it in because
  `CONFIGURATION.md:315` names "the module's plausibility floor", which is
  `scheduler.rs:33`, squarely in 4f. The key itself is parsed elsewhere. If the
  answer is no, the claim still stands as a documentation defect and needs an
  owner. (needs human input)
- Do the four undocumented but effective keys belong in `CONFIGURATION.md`? The
  sibling asked this and it stays open. This lens adds one datum on the side of
  yes: `config.rs:1-9` reads as a public contract and names its TypeScript twin
  three times, which is the posture of a documented surface.
- Is there any conformance check that compares the documented key set against
  what `config.rs` parses, or the Rust defaults against the TypeScript schema? I
  found neither. Eight of the thirteen `NOT FOUND` register entries would be
  discharged by one schema-diff check and one key-set diff check. 4b proposed the
  key-set check for its four keys
  (`part-4b-transform/existing-checks.md:571-574`). Unresolved, needs a decision
  at synthesis about whether `fault-map.md` proposes both.
- Is `PARITY.md` a claim source for `mc-module` at all? It is titled "Pi to
  OpenCode: Intentional Divergences" and describes two TypeScript plugins.
  Register entries C1-04 through C1-07 read it as constraining the Rust codecs
  because the Rust codecs carry the same harness names and the same folding and
  dropping concerns. If the document's scope is TypeScript only, four claims move
  from "contradicted" or "NOT FOUND" to "out of scope", and the Rust codecs are
  left with no stated contract at all, which is a worse position. (needs human
  input)
- Does the release profile ever run the codec tests? The sibling established that
  CI runs only `cargo test -p mc-module --test lifecycle_cli`
  (`.github/workflows/ci.yml:172`). Separately from that ruling, the
  `#[cfg(debug_assertions)]` gate at `codec/opencode.rs:2077` means one guard's
  only test is structurally absent from any release-profile run. Unresolved;
  needs the same human ruling as the sibling's `Exercised` question, plus a
  decision about whether release-profile test runs are in the harness at all.
