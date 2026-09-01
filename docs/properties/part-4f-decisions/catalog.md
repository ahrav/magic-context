# Part 4f property catalog: decision units, configuration, and harness codecs

Scope: sub-part 4f of `crates/mc-module`, the decision layer every transform pass
consults plus the two harness codecs that own the bytes entering and leaving the
crate. `src/codec/` is 4,323 lines across four files, `src/selection.rs` is 3,365,
`src/boundary.rs` 3,053, `src/scheduler.rs` 1,449, `src/config.rs` 1,229,
`src/caveman.rs` 651, and `src/session_resolver.rs` 70. `src/ck_wire.rs` (1,279)
is in scope where it bears on codec contracts, and `CONFIGURATION.md` (841) is
read as the documented contract rather than as evidence of behaviour. The decision
regions of
[../part-4-module/_lenses/scope-map-and-risk-ranking.md](../part-4-module/_lenses/scope-map-and-risk-ranking.md)
at `:607-649` fix the boundary.

One path correction to the task framing, because it changes what a reader greps
for: `sidecar.rs` is at `codec/sidecar.rs`, not `src/sidecar.rs`. It is the file
every other codec unit depends on for block identity, and it is the one file in
scope with no tests of its own.

Out-of-part files are cited rather than catalogued. `crates/mc-store/src/lib.rs`
owns the CK types the codecs produce (`:40-300`), the `lib.rs` call sites that
supply or consume these units are 4b, 4c and 4d code reading a 4f contract, and
`crates/mc-module/src/healing.rs:10-28` defines five `SerializerProfile` variants
against two codecs, so the profile axis is larger than the codec axis and is left
to a later pass.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"), which all four lens agents read. Method contract in
[../METHOD.md](../METHOD.md). The CI reference drift the lenses record is a pure
file move: the only `mc-module` test invocation,
`cargo test -p mc-module --test lifecycle_cli`, is `ci.yml:172` at `HEAD` and
`ci.yml:168` at `76cd6f41`, and the build-only step above it is `:169` at `HEAD`
and `:165` at `76cd6f41`. The `run:` text is byte-identical at both commits, and
records may cite either numbering.

### Reconstruction provenance

This file was rebuilt from `_lenses/` after the working tree was cleaned and the
synthesized `catalog.md` was lost. Every record is taken verbatim from the lens
file that produced it, `_lenses/lens-a-decision-units-and-config.md` (14 records,
`dec-a-` prefix) and `_lenses/lens-b-harness-codecs.md` (12 records, `codec-b-`
prefix), with two mechanical adjustments and no re-derivation: evidence links are
rewritten from the lens-relative `../evidence/` to the catalog-relative
`evidence/`, and field paragraphs are rewrapped to about 80 columns. Content
equality against the lens text was checked mechanically, token by token, after
rewrapping. `_lenses/lens-c1-claims-and-config.md` and
`_lenses/lens-c2-check-inventory.md` proposed no records; they supply the claims
register, the configuration contract table, the release-behaviour divergence and
the check inventory this header cites. No `portfolio-evaluation.md` exists for
this part, so no refinements are applied and none are claimed.

**The grouping below is mine.** The lens files produced two flat record lists, and
neither proposed group headings, so the seven groups are a synthesis choice: they
cut by mechanism, meaning the thing a single test fixture would have to build,
rather than by lens or by file. Index order follows group order.

### One semantics finding, reported and not applied

Lens B produced the part's only `reachable` record,
[codec-b-declared-missing-capture-classes-are-never-decoded](#codec-b-declared-missing-capture-classes-are-never-decoded),
and per METHOD.md rules 3 and 6 it is reproduced verbatim with the finding
recorded here rather than resolved in the record.

**The semantics are correct as written.** METHOD.md distinguishes location
coverage from situation coverage: `reachable` is "a specific code point or path
should be executed", `sometimes` is "a meaningful state must occur at least once
per campaign". The obligation here is location coverage in the strict sense. Two
decode arms exist, `codec/opencode.rs:171-181` for `subtask` and
`codec/pi.rs:199-211` for redacted thinking; both are named as required classes by
the golden's own manifest; and both are provably never entered by the suite that
claims to cover them, because listing a class in `missing_capture_classes` clears
the coverage assertion at `codec/mod.rs:262-266`. The record asks for those two
arms to execute. There is no separate operational state to reach beyond executing
them, which is the condition under which METHOD.md's second rule would force
`sometimes` instead.

One qualification a reviewer should carry. For the `subtask` arm the record's own
`Impact:` line observes that deleting the arm would not move the golden, because
the part would fall through to `:194-204` and still become an opaque block. So the
`subtask` half is location coverage over a path with no distinguishable outcome,
which is the weakest form of the check; the redacted-thinking half is the load
bearing one, since `:199-211` produces `CkKind::RedactedReasoning` while the
non-redacted branch at `:212-217` produces `CkKind::Reasoning` with a signature,
and the two round-trip through different encoder arms. A future pass may want to
split the record on that asymmetry. That is a strengthening, not a correction, and
it is not applied here.

## What this part is about

4f is where the crate decides things and where it talks to the outside world. The
decision units are pure by their own headers and that claim survives inspection;
the defects are almost all on the two boundaries, the configuration contract above
and the harness wire below. Six facts frame the records.

**The configuration contract is the part's largest defect surface, and the
headline that number belongs to is route-scoped rather than product-wide.** The
table below has 31 leaves. **This section previously read "13 documented keys
either do nothing here or disagree with their own documentation" and treated that
as a product defect count. An independent evaluation refuted the framing and the
membership, and the correction is applied below rather than footnoted, because the
Rust-first scope decision makes the distinction decision-relevant rather than
pedantic.** Two things were wrong. First, `protected_tags` and
`clear_reasoning_age` are not inert: both are carried on the transform *request*
and consumed as Rust request fields, so "does nothing here" is false for them.
`rust-mode-transform.ts:1355` sends `protected_tags` and `:1398` sends
`clear_reasoning_age` on one call path, `:2031` and `:2014` send the same pair on
another, and `transform.rs:682-684` and `:693-697` declare them as
`#[serde(default = ...)]` fields on the request struct. Second, three keys were
filed as "absent everywhere", which is true of `crates/mc-module/src` and false of
the workspace: `historian_timeout_ms` is read at `pi-plugin/src/index.ts:676` and
threaded through `:1297`, `:1313`, `:1332`; `history_budget_percentage` at
`pi-plugin/src/index.ts:693` and `:1229`; `output_reserve` at
`pi-plugin/src/config/index.ts:427` and `:600`. "Absent" was a statement about one
crate wearing the clothes of a statement about the product.

The replacement is a **route-aware matrix**. The axis that matters is *which
channel carries the key to the Rust reader*, because that is what the migration
has to preserve:

| Route | Count | Members | What a defect here means |
| --- | --- | --- | --- |
| **Parsed by the Rust config reader** | 24 | every row of the table below whose "Takes effect here?" is `Yes`, including the four undocumented-but-effective leaves and the deprecated `memory.budget_tokens` | `config.rs` is the authority. A bound or default that disagrees with `CONFIGURATION.md` is a real divergence in this crate, and 7 of these are divergent: `execute_threshold_percentage` scalar, `memory.injection_budget_tokens`, `memory.auto_search.min_prompt_chars`, `caveman_text_compression.min_chars`, the `review-user-memories` schedule, `historian.model` with `fallback_models`, and `cache_ttl` |
| **Request-supplied** | 2 | `protected_tags`, `clear_reasoning_age` | Not inert. The value arrives per pass on the transform request (`transform.rs:682-697`) from the TypeScript sender (`rust-mode-transform.ts:1355`, `:1398`, `:2014`, `:2031`), and `config.rs` correctly does not parse it. **These are the keys the Rust-first migration must preserve**, because the sender is the thing being replaced. A hardwired Rust constant standing in for either — `DEFAULT_PROTECTED_TAGS` at `lib.rs:603` — is a fallback for a *missing request field*, not a config gap |
| **TypeScript-only** | 6 | `execute_threshold_percentage` object form, `execute_threshold_tokens`, `commit_cluster_trigger.enabled`, `commit_cluster_trigger.min_clusters`, `historian_timeout_ms`, `history_budget_percentage`, `output_reserve` (7 leaf names, 6 documented keys, since the object form shares a key with the scalar) | The key is honoured, in TypeScript, by code the Rust reader never consults. Verified per key: the `commit_cluster_trigger` pair is parsed by `plugin/src/config/schema/magic-context.ts` and consumed by `pi-plugin/src/context-handler.ts`, while Rust hardwires `DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED` and `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:605`, `:607`) at `:4962-4963` and never reads either. **This is the class the Rust-first decision actually threatens**: a key that works today only because a TypeScript component is in the path |
| **Truly absent from both** | 0 | none | Checked per key. Every leaf in the documented table has a consumer somewhere in the workspace, in Rust, in TypeScript, or on the request. The pre-disposition "absent everywhere: 3" bucket is empty once the search leaves `crates/mc-module/src` |

So the corrected headline is: **7 divergences on the Rust-parsed route, 6
documented keys honoured only in TypeScript, 2 keys carried on the request rather
than in config, and nothing absent.** The old "13" was 7 real divergences plus 6
keys misfiled as inert, of which 2 were request-supplied and 4 were
TypeScript-only. The number was not inflated by carelessness — every cited line
was correct — but it summed across three routes that a migration treats
differently, which is the shape of error that matters when the decision on the
table is which route survives. The per-route counts above supersede both the old
13 and the sibling lens's 9.

A further 9 documented keys have zero occurrences in `crates/mc-module/src` **and**
describe behaviour outside the module, listed at the end of this section; those are
correctly out of scope and unaffected.

**13 of 30 claims have no implementing code.** The claims register holds 30
entries: 13 are consistent with the code at `HEAD`, 13 are `NOT FOUND`, 3 are
contradicted, and 1 is partial. **Eight of the thirteen `NOT FOUND` claims are
cross-implementation parity claims whose oracle lives in TypeScript** and is never
read from this crate. That is the register's dominant shape: the Rust module states
its obligations against a twin it does not consult.

**No harness decoder has a rejection channel.** Both decoders return
`DecodedHarnessMessages` with no error type at all (`codec/opencode.rs:23-25`,
`codec/pi.rs:19-21`), so totality is free and worthless, and the interesting
question inverts from "does it reject" to "what does it silently accept and
silently discard". The two harnesses then answer that question in opposite ways.
The Pi decoder drops an entry that is neither a message nor one of three named
opaque types, from `decoded` and from the sidecar alike, retaining nothing
(`codec/pi.rs:41-50`, `:661-669`, `:681-686`). OpenCode preserves unknowns as
opaque with the raw part cloned (`codec/opencode.rs:194-204`) but omits four named
part types from `content` (`:193`), so they exist for re-encode and are invisible
to every transform decision. The CK layer's own contract requires the pass-through
path stay `Value`-level "so harmless future CK fields are not silently dropped"
(`ck_wire.rs:19-21`), and one of the two harness codecs violates that spirit
outright.

**There is a release-behaviour divergence, and the dangerous line is not the
obvious one.** Three `debug_assert!` sites exist in the 4f production halves, all
in `codec/opencode.rs`. The out-of-range index at `:251` is **re-checked by the
slice at `:258`**, so a violation fails loudly in every profile and the assertion
only buys a better message. **`:252` is the silent one**: same function, adjacent
line, no release equivalent, and a later `take` at `:265` saturates, so a violated
precondition becomes a silently truncated sidecar. **Neither is tested.** The third
site, `:466` inside `assert_unique_tool_use_ids`, **enforces nothing in release**:
unlike 4e's two-armed belt it has one arm, so the function becomes a no-op while
`duplicate_tool_use_locations` still runs and its result is discarded, and its only
test is debug-gated at `:2077`. Verified: no `cfg(not(debug_assertions))` exists
anywhere in 4f, so no release-arm counterpart exists for any of them.

**One totality defect was found, and this line previously said none was.** The
claim mattered because of what it was compared against: Part 3's analogue is an
infinite input producing a NaN that broke a documented invariant, and the sibling
crate carries **three** such defects. Saying 4f had zero was therefore a
substantive result about this crate, not a throwaway, which is exactly why it had
to be checked rather than inherited. Most of it survives. Every `f64` entry point
into `derive_trigger_budget` (`boundary.rs:339-345`),
`derive_protected_tail_token_target`'s own context fields (`:363-372`), and
`clamp_percentage` (`:926-931`) guards `is_finite` first, and where a NaN could
still arrive it is absorbed rather than propagated, because `f64::max` and
`f64::min` return the non-NaN operand; both expressions were executed to confirm.
**The exception is `BoundaryContext::trigger_budget`, a caller-supplied
`Option<f64>` that is read through `unwrap_or_else` at `:377-379` and again at
`:756-761` with no validation on the `Some` arm.** A `Some(f64::NAN)` therefore
reaches `:802`'s `tail_size_bar: trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER`,
which is a bare multiply with no `max` or `min` to absorb it, and the NaN lands in
`TriggerProgress` — a struct whose own doc comment (`:322-324`) says it is
"Surfaced through the transform response's historian diagnostics so a stalled rig
drive is diagnosable per pass". It is carried out at `lib.rs:4982` and divided at
`:5002`. So the defect class is present in shape, unreachable on the guarded
derivations, and **reachable on the one unguarded passthrough**, which is a
different sentence from the one this section used to carry. Group C's four guards
still hold, and they are still worth recording for the reason given there. What
changes is that the fifth thing in that neighbourhood is a defect and is now
recorded as one. Production passes `None` (`lib.rs:4957`) and the only `Some` sites
are `lib.rs:16495` and `:16760`, both tests, so the reachability is latent rather
than default-production, and the split record says so. The nearest *reachable*
hazard remains a different one: a `cache_ttl` of `"0"` parses to 0 ms and forces
execution every pass, which no documentation mentions.

**Coverage is 192 in-crate tests, none in CI, and the file that owns block
identity has none.** 192 tests reach full scope-map 4f: 153 file-local across the
ten 4f files plus 39 of the 280 tests in `transform.rs`'s flat `mod tests`.
Restricted to the brief's named files the figure is 164, being 146 file-local plus
18. The three-way reconciliation against the sibling sub-parts holds: all three
inventories agree on 285 attributes total and 280 in the flat module, and each
reports its own reach tier as unusable for the same structural reason, 4b through
its driver set, 4e through its helper fixpoint returning 190, and 4f through a
type-mention rule returning 87 because the shared fixture driver's signature
promotes the whole driver population. Use 39 for behaviour and 18 for the
brief-named subset. There is no integration test in scope, and
`tests/release_contract_conformance.rs` does not run despite its own header
(`:1-8`) arguing that its equalities are load-bearing at runtime and that "the
drift must fail the build, not the deployment"; the drift fails no build. Two
further facts belong here because several records depend on them:
**`codec/sidecar.rs` has zero tests across 339 lines while owning block identity**,
its three entry points reached only transitively, and **both harness goldens are a
single case each**, with an oracle derived from the test's own input and one
required block class declared missing so the coverage gate passes without it.

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
| `boundary::derive_trigger_budget` (`:338-346`) + `derive_protected_tail_token_target` (`:362-401`) | the size-trigger budget and the protected-tail token target | `context_limit`, `execute_threshold_percentage`, usage, optional budget | budget always in `[5000, 50000]`; `n` always `>= 1` | Yes, and total **over the three fields it validates**: see `dec-a-boundary-budget-derivation-is-total-over-non-finite-input`. **Not total over `ctx.trigger_budget`**, which is read at `:377-379` with no `is_finite` gate: `n` stays finite because `f64::min` absorbs the NaN at `:383`, but the raw value is stored at `:399` and reaches `TriggerProgress.tail_size_bar` at `:802`. See `dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic` |
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
| `commit_cluster_trigger.enabled` | not parsed | `true` (`:237`) | none | **Not in Rust; honoured in TypeScript.** Rust hardwires `DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED` (`lib.rs:605`) at `lib.rs:4962`. `plugin/src/config/schema/magic-context.ts` parses it and `pi-plugin/src/context-handler.ts` consumes it |
| `commit_cluster_trigger.min_clusters` | not parsed | `3`, **minimum `1`** (`:232`, `:238`) | none | **Not in Rust; honoured in TypeScript.** Rust hardwires `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:607`) at `lib.rs:4963`. Same TypeScript parse and consumer as the flag |
| `protected_tags` | not parsed by `config.rs` | `20`, range `1-100` (`:165`) | none from config; the request field defaults to a hardwired `20` at `lib.rs:603` | **Not through config; yes through the request.** `transform.rs:682-684` declares it `#[serde(default = "default_protected_tags")]`, and `rust-mode-transform.ts:1355` and `:2031` send it. 4b's `sel-protected-tags-not-read-from-module-config` is correct about the config route and is not a claim that the value never arrives |
| `clear_reasoning_age` | not parsed by `config.rs` | `50` (`:169`) | none from config; the request field defaults at `default_clear_reasoning_age` | **Not through config; yes through the request.** `transform.rs:693-697` declares it and `rust-mode-transform.ts:1398` and `:2014` send it. This row already said "Present in `mc-module/src` only as a request field", so the fact was recorded and the column was wrong |
| `historian_timeout_ms` | not parsed | `300_000` (`:170`) | none | **Not in Rust; honoured in TypeScript.** Zero occurrences in `crates/mc-module/src`; `pi-plugin/src/index.ts:676` reads it and `:1297`, `:1313`, `:1332` thread it. `historian_producer.rs:209-227` carries private Rust timeouts unrelated to the key. 4a scope, lead only |
| `history_budget_percentage` | not parsed | `0.15`, range `0.05-0.5` (`:171`) | none | **Not in Rust; honoured in TypeScript.** Zero occurrences in `crates/mc-module/src`; `pi-plugin/src/index.ts:693` and `:1229` read it |
| `output_reserve` | not parsed | automatic; `0` disables (`:164`, `:308-315`) | none in this crate, though `:315` names "the module's plausibility floor" | **Not in Rust; honoured in TypeScript.** Zero occurrences in `crates/mc-module/src`; `pi-plugin/src/config/index.ts:427` and `:600` call `setOutputReserveConfig` on it. See C1-28 |

The table has 31 rows because `output_reserve` is promoted from the sibling's
out-of-scope bucket by C1-28. Treat the leaf count as 31 and the sibling's 30
named leaves as a subset.

### Totals

Two views. The first is the documentation-shaped one this catalog synthesized. The
second is the route-aware one that supersedes it as the headline, restated here so
the two are side by side and a reader can see which rows moved.

| Category | Count | Members |
| --- | --- | --- |
| Documented leaves in the table | 26 | all rows except the four undocumented leaves and the deprecated `memory.budget_tokens` |
| Undocumented but effective | 4 | `memory.user_profile_budget_tokens`, `historian.module_model` with `module_fallback_models`, `historian.context_limit_tokens`, `prompt_surface.guidance_override_text` |
| Documented and **not parsed by `config.rs`** | 6 | `execute_threshold_percentage` object form, `execute_threshold_tokens`, `commit_cluster_trigger.enabled`, `commit_cluster_trigger.min_clusters`, `protected_tags`, `clear_reasoning_age`. **Previously labelled "inert", which is wrong for the last two**: both are request-supplied and consumed at `transform.rs:682-697`. The label is now the literal fact — `config.rs` does not parse them — and the route matrix says what each one does instead |
| Documented and effective but **divergent** (bound, tier policy, or default disagrees) | 7 | `execute_threshold_percentage` scalar, `memory.injection_budget_tokens`, `memory.auto_search.min_prompt_chars`, `caveman_text_compression.min_chars`, `review-user-memories` schedule, `historian.model` with `fallback_models`, `cache_ttl` |
| **Absent from `crates/mc-module/src`** and describing module behaviour | 3 | `historian_timeout_ms`, `history_budget_percentage`, `output_reserve`. **Previously labelled "absent everywhere", which is wrong**: all three have TypeScript consumers (`pi-plugin/src/index.ts:676`, `:693`; `pi-plugin/src/config/index.ts:427`). They are TypeScript-only, not absent |
| Deprecated, absent from the documented table, still honoured | 1 | `memory.budget_tokens` |

Route-aware view, which is the one to cite:

| Route | Count | Defect count on that route |
| --- | --- | --- |
| Parsed by the Rust config reader | 24 | **7 divergent** |
| Request-supplied, consumed as a Rust request field | 2 | 0 divergent; both are correctly outside `config.rs` |
| Honoured only in TypeScript | 6 documented keys (7 leaf names) | 6, in the sense that the Rust reader cannot honour any of them |
| Truly absent from Rust and TypeScript alike | 0 | — |

**The old "13 documented keys either do nothing here or disagree with their own
documentation" is retired.** It summed 7 divergences, 4 TypeScript-only keys, and
2 request-supplied keys into one product-wide figure, and the three routes have
different consequences under the Rust-first decision. This is a superset of the
sibling's headline nine
([lens-a-decision-units-and-config.md:119-129](_lenses/lens-a-decision-units-and-config.md)),
and both numbers are now superseded rather than reconciled. The four leaves this
lens added over the sibling, and why the sibling did not count them, are still
worth recording because two of them survive as genuine divergences:
`clear_reasoning_age` (named inside a 4b evidence file but not among the headline
keys, and now known to be request-supplied rather than inert),
`memory.auto_search.min_prompt_chars` and `caveman_text_compression.min_chars` (the
sibling recorded the clamps as invisible to the caller but not as documentation
divergences, and both remain divergent on the Rust-parsed route), and the
`review-user-memories` default (the sibling filed it as a lead rather than counting
it, and it remains divergent). So of the four, three stay and one moves route.

A further nine documented keys have zero occurrences in `crates/mc-module/src`
and describe behaviour outside the module: `toast_duration_ms` (`:166`),
`memory.retrieval_count_promotion_threshold` (`:593`),
`memory.git_commit_indexing.*` (`:665-667`), `fail_closed_blocking` (`:161`),
`allow_home_project` (`:159`), `auto_update` (`:160`), `keep_subagents` (`:174`),
`historian.thinking_level` (`:452`), and `historian.two_pass` (`:454`, present in
`mc-module/src` as a request field only). They are not defects in 4f and are
listed so a future conformance check can exclude them deliberately rather than by
omission.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1](#dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1) | safety | high |
| [dec-a-memory-injection-budget-documented-range-has-no-implementing-code](#dec-a-memory-injection-budget-documented-range-has-no-implementing-code) | safety | high |
| [dec-a-commit-cluster-trigger-config-is-inert-in-this-crate](#dec-a-commit-cluster-trigger-config-is-inert-in-this-crate) | safety | high |
| [dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list](#dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list) | safety | high |
| [dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller](#dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller) | safety | high |
| [dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian](#dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian) | safety | high |
| [dec-a-model-key-lookup-walk-has-two-implementations-that-disagree](#dec-a-model-key-lookup-walk-has-two-implementations-that-disagree) | safety | high |
| [dec-a-model-chain-dedup-is-adjacent-only](#dec-a-model-chain-dedup-is-adjacent-only) | safety | high |
| [dec-a-cache-ttl-parse-is-total-over-arbitrary-strings](#dec-a-cache-ttl-parse-is-total-over-arbitrary-strings) | safety | high |
| [dec-a-boundary-budget-derivation-is-total-over-non-finite-input](#dec-a-boundary-budget-derivation-is-total-over-non-finite-input) | safety | high |
| [dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic](#dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic) | safety | high |
| [dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes](#dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes) | safety | high |
| [dec-a-escalation-bands-stay-ordered-for-every-threshold](#dec-a-escalation-bands-stay-ordered-for-every-threshold) | safety | high |
| [dec-a-selection-decision-order-is-total-under-hashmap-iteration](#dec-a-selection-decision-order-is-total-under-hashmap-iteration) | safety | high |
| [dec-a-region-hint-clamp-bypassed-by-sentinel-suffix](#dec-a-region-hint-clamp-bypassed-by-sentinel-suffix) | safety | high |
| [codec-b-harness-decoders-accept-every-input-with-no-rejection-channel](#codec-b-harness-decoders-accept-every-input-with-no-rejection-channel) | safety | high |
| [codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record](#codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record) | safety | high |
| [codec-b-opencode-hides-four-part-types-from-every-transform-decision](#codec-b-opencode-hides-four-part-types-from-every-transform-decision) | safety | high |
| [codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only](#codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only) | safety | high |
| [codec-b-decoder-output-can-violate-the-projector-precondition](#codec-b-decoder-output-can-violate-the-projector-precondition) | safety | high |
| [codec-b-absolute-ordinal-is-harness-supplied-and-never-validated](#codec-b-absolute-ordinal-is-harness-supplied-and-never-validated) | safety | high |
| [codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity](#codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity) | safety | high |
| [codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert](#codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert) | safety | high |
| [codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour](#codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour) | safety | high |
| [codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness](#codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness) | safety | high |
| [codec-b-declared-missing-capture-classes-are-never-decoded](#codec-b-declared-missing-capture-classes-are-never-decoded) | reachability | high |
| [codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given](#codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given) | safety | high |

**Twenty-seven records**, against 26 before a disposition pass split
`dec-a-boundary-budget-derivation-is-total-over-non-finite-input` in two. METHOD
step 7 requires the distributions to be recorded here, and the synthesis omitted
them, so they are stated for the first time rather than corrected.

Semantics distribution: **twenty-six `always`** — twenty-three bare, plus
`codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour`'s
`always(!duplicate)` and two `always(!X)`, on
`dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian`
and the new
`dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic`,
all three of which are `always` over a forbidden state per METHOD's first
check-semantics rule — plus **zero `always-or-unreached`**, **zero `sometimes`**,
**one `reachable`**, **zero `unreachable`**. The absence of `sometimes` is worth
naming rather than passing over: 4f's surface is argument-shaped, so almost every
obligation is a statement about all inputs rather than about an operational state
that must occur, and the one `reachable` record is the sole exception. It is also
what makes 4f's zero-liveness position defensible; see
[portfolio-evaluation.md](portfolio-evaluation.md).

Type distribution: **twenty-six safety, one reachability, zero liveness**.

Reachability distribution: **sixteen `default-production`, seven
`explicit-config-only`, four `test-only`**, against 16/8/2 before. Two labels
moved, both away from `explicit-config-only` and both because a configuration
cannot in fact construct the state:
`dec-a-model-key-lookup-walk-has-two-implementations-that-disagree`, whose
differential needs `ExecuteThresholdConfig::ByModel` and where `number_at`
(`config.rs:631-636`) discards an object form before any enum is chosen; and the
new trigger-budget record, whose only `Some` sites are two test literals. Both
relabels are recorded at the records.

Confidence: twenty-seven high, zero medium, zero low.

---

## Group A: the configuration contract as a defect surface

Six records on the gap between `CONFIGURATION.md` and `config.rs`. Two are
documented bounds with no implementing code, one is a documented feature whose
value is parsed nowhere because the behaviour is hardwired, one is a tier policy
the documentation does not state and the code enforces silently, one is the set of
clamps and discards that change a user's value with no signal back, and the last is
what happens when the file itself does not parse. They share a fixture: resolve a
config with a known-out-of-contract value and compare the resolved struct against
the document, so one conformance harness serves all six.

### dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test supplies a threshold below `20`.
`config.rs:829-835` pins the upper clamp (`91 -> 90`) and `:837-841` pins the
default `65`; neither touches the low end.
Guarantee: A configured `execute_threshold_percentage` that the documentation
forbids is rejected or reported, not silently accepted as the effective
threshold.
Check: `always` — after `merge_tiers_with_warnings`,
`execute_threshold_percentage >= 20.0`, or the returned warning vector names
`/execute_threshold_percentage`. These semantics because the clamp runs on
every config resolution, so there is no optional path.
Fault/timing angle: none. The value is fixed at route bind and persists for the
life of the binding.
Required faults and enabling state: a user or project `magic-context.jsonc`
containing `execute_threshold_percentage` below `20`, for example `5`.
Confidence: high —
[evidence](evidence/dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1.md).
Both sides read at `HEAD`: `CONFIGURATION.md:167` documents `number (20-90)`;
`config.rs:568-570` clamps to `[1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE]` with
the constant `90.0` at `:28`. Traced the consequence into
`scheduler.rs:462-464` and `:492`.
Existing check: `config.rs:829-835` `project_threshold_may_only_raise` covers
the upper bound only. Status `unaudited`. This record adopts 4b's queued gap
`portfolio-evaluation.md:390` (G4), which that part recorded as uncovered.
Impact: a threshold of `5` makes `should_execute` return `Execute` on
essentially every pass, so every pass busts the provider prefix cache. A
threshold of `1` is the floor the code will accept.
Open questions:
- Should `config.rs` enforce `20` or should `CONFIGURATION.md` be corrected to
  `1-90`? The TypeScript schema is the stated twin for the default
  (`config.rs:17-19`), so the two implementations may already disagree on the
  bound. (needs human input)

### dec-a-memory-injection-budget-documented-range-has-no-implementing-code

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `config.rs:843-849` pins the default `4000` and `:851-874`
pins key precedence and the deprecated fallback. No test supplies a value
outside `500-20000`.
Guarantee: A configured `memory.injection_budget_tokens` outside the documented
range is rejected, clamped to the documented range, or reported.
Check: `always` — after config resolution,
`500.0 <= memory_budget_tokens <= 20000.0`, or a warning names the key.
`always` because the parse runs on every resolution for both tiers.
Fault/timing angle: none.
Required faults and enabling state: a project `.cortexkit/magic-context.jsonc`
with `memory.injection_budget_tokens` set above `20000` (or below `500`).
Confidence: high —
[evidence](evidence/dec-a-memory-injection-budget-documented-range-has-no-implementing-code.md).
`CONFIGURATION.md:591` documents `number (500-20000)` default `4000`.
`config.rs:441-445` and `:526-528` apply only `.max(1.0)`. Traced the value to
`lib.rs:8293` and into `trim_claims_to_budget` at `transform.rs:2657`.
Existing check: none for the range. `config.rs:876-911`
`rust_only_budget_leaves_are_user_tier_only_and_warn_when_project_supplies_them`
proves that the *user-profile* budget is user-tier-only, which by contrast
confirms the injection budget is deliberately project-writable. Status
`unaudited`.
Impact: a repository config can raise the memory-injection trim budget without
limit, inflating the frozen `m0` baseline that every subsequent pass replays
verbatim.
Open questions: None.

### dec-a-commit-cluster-trigger-config-is-inert-in-this-crate

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:16500-16501`, `:16573-16574`, and `:16767-16768`
drive `TriggerContext` with `min_commit_clusters: 2` and both settings of the
enable flag, so the boundary logic is covered. Nothing covers the
config-to-context wiring, because there is none.
Guarantee: A configured `commit_cluster_trigger` reaches the module's trigger
decision, or the module reports that it cannot honour the key.
Check: `always` — for every resolved configuration, the `TriggerContext` built
at `lib.rs:4962-4963` carries the configured `enabled` and `min_clusters`.
`always` because `prepare_historian_fire` constructs this context on every
transform pass that evaluates a trigger. **This check is not observable at
defaults and the record previously claimed it was.** At defaults the documented
values and the hardwired constants are the same values —
`CONFIGURATION.md:237-238` documents `enabled: true` and `min_clusters: 3`, and
`lib.rs:605` and `:607` hardwire `true` and `3`, both printed and confirmed — so
"the context carries the configured value" is satisfied by a context that reads
the constant. The check can only fire against a **non-default configuration**, and
even then only if the oracle can see the context: `TriggerContext` is built inline
inside `prepare_historian_fire` and passed to `check_compartment_trigger_with_index`
at `lib.rs:4964-4966`, so observing it means either an in-crate assertion at that
site or inferring it from a behavioural difference, which needs the trigger
workload below.
Fault/timing angle: none.
Required faults and enabling state: **a non-default `commit_cluster_trigger`
value, and a trigger workload, together.** Neither alone suffices. This line
previously read "none for the divergence itself; it holds on a default build",
which is the claim the disposition retired: on a default build the configured and
hardwired values coincide, so nothing distinguishes wiring from hardwiring. The
cheap form is `commit_cluster_trigger.min_clusters` set to something other than
`3` — `2` is what `lib.rs:16500-16501` and `:16573-16574` already use for the
boundary logic — plus an in-crate assertion on the constructed context. The
behavioural form additionally needs a tail with at least the configured number of
commit clusters and one `trigger_budget` of tokens, so the trigger's verdict
changes with the value.
Confidence: high —
[evidence](evidence/dec-a-commit-cluster-trigger-config-is-inert-in-this-crate.md).
`CONFIGURATION.md:237-238` documents both keys. `config.rs` has zero
occurrences of `commit_cluster` or `min_clusters`. `lib.rs:605` and `:607` are
the hardwired constants, passed at `:4962-4963`; `boundary.rs:850-855` consumes
them. Confidence is in the mechanism, which is fully verified, and not in the
check's observability, which the `Check:` line now bounds. The key is
TypeScript-honoured rather than inert product-wide:
`plugin/src/config/schema/magic-context.ts` parses it and
`pi-plugin/src/context-handler.ts` consumes it, so the slug's word "inert" is true
of this crate and false of the product. The slug is left unchanged because
renaming it would break the index, the evidence filename, and two sibling
citations; the scope qualifier is in the guarantee.
Existing check: none for the wiring. `boundary.rs:2226-2227` asserts the
constant `DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER` against a golden value,
which pins the default and not the configurability. Status `unaudited`.
Impact: a user who disables the commit-cluster trigger still gets
commit-cluster-driven historian fires, each of which spends a model call and
replaces raw conversation with generated summary text. Under the Rust-first
decision the impact grows rather than shrinks, because the TypeScript component
that does honour the key is the component being removed.
Open questions:
- Does any harness leg carry these controls in the transform request instead? I
  found no request field for either, and a disposition pass re-checked: `grep`
  for `commit_cluster` and `min_clusters` across `crates/mc-module/src` returns
  only `historian_chunk.rs`'s counting field, `lib.rs`'s two constants and their
  one production use at `:4962-4963`, three test-only literals, and
  `boundary.rs`'s context field. There is no request field. Resolved against
  Rust; the TypeScript sender's own consumption is
  `pi-plugin/src/context-handler.ts`, which is outside 4f scope.

### dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:930-970` and `:981-997` assert that
`auto_search`, `caveman`, `inject_docs`, and `temporal_awareness` follow
user-then-project tiers, so the behaviour is pinned as intended. No test
asserts the header's allow-list as a closed set.
Guarantee: The set of leaves a project-tier config can change equals the set
the trust policy documents.
Check: `always` — for every leaf in `McModuleConfig`, a project-tier value
changes it only if the documented policy permits it. `always` because the tier
merge runs on every resolution.
Fault/timing angle: none.
Required faults and enabling state: a project `.cortexkit/magic-context.jsonc`
setting `smart_drops: true`, which the code accepts at `config.rs:541-543`.
Confidence: high —
[evidence](evidence/dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list.md).
Compared `config.rs:6-7`'s enumeration against the project block at `:514-566`,
leaf by leaf. Four leaves are outside the enumeration; two of them move in the
permissive direction.
Existing check: `config.rs:913-928` and `:1096-1117` prove specific keys are
user-tier-only, and `warn_ignored_project_key` (`:575-581`) is called five
times. Neither establishes that the remaining project-writable set is the
documented one. Status `unaudited`.
Impact: a repository can enable `smart_drops`, which `CONFIGURATION.md:767`
describes as intentionally off while cache stability is validated, and can
raise the memory injection budget without bound. Both change the bytes the
module serves to the provider.
Open questions:
- Is `smart_drops` intended to be project-overridable? The header omits it
  while the code applies it on both tiers, so one of the two is wrong. (needs
  human input)

### dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:930-970` exercises `auto_search` and `caveman`
values inside their clamps and asserts the resulting values. No test supplies
an out-of-range value and asserts either the clamped result or a warning.
Guarantee: When a configured value is altered by a clamp or discarded as out of
domain, the resolution reports which key was altered.
Check: `always` — for every resolution where an input leaf differs from the
resolved leaf, the warning vector names that leaf. `always` because the merge
path always produces the vector.
Fault/timing angle: none.
Required faults and enabling state: a config with
`memory.auto_search.score_threshold: 0.99`,
`memory.auto_search.min_prompt_chars: 0`, or
`caveman_text_compression.min_chars: 50`.
Confidence: high —
[evidence](evidence/dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller.md).
Enumerated every clamp: `config.rs:568-570`, `:591`, `:595`, `:607`, and the
`.max(1.0)` calls at `:442`, `:453`, `:527`. `positive_usize_at` (`:623-629`)
filters `*v > 0`. `emit_warnings` (`:275-279`) prints and drops.
Existing check: none for the clamp reporting. Status `unaudited`.
Impact: a user tuning auto-search or caveman sees no effect from a value
outside the clamp and no explanation. `min_prompt_chars: 0`, the natural
spelling of "hint on every prompt", silently becomes `20`.
Open questions:
- Is the stderr line from `emit_warnings` visible in any harness the module
  runs under? The module runs as a daemon component, so stderr may be
  discarded. Unresolved, needs a look at the host's process wiring, which is
  Part 2a scope.

### dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:1191-1229` covers the mtime cache with
well-formed files, and `:1181-1189` covers JSONC stripping of comment-like
strings. No test writes a syntactically invalid file and asserts the outcome.
Guarantee: A configuration file that exists but cannot be parsed produces a
distinguishable signal rather than the same result as an absent file.
Check: `always(!X)` — and the check this record originally carried is not
implementable, so the disposition states the implementable substitute rather than
deleting the record. The original read: `always` — whenever `fs::read_to_string`
succeeds and `serde_json::from_str` fails, the resolution emits a warning naming
the path.
There is no return channel for such a warning to travel on. `read_tier_cached`
(`config.rs:254-266`) has the signature
`fn read_tier_cached(cache: &mut TierConfig, path: PathBuf) -> Option<Value>`: no
`warnings: &mut Vec<String>` parameter, no `Result`, and `:261-264` maps both the
read error and the parse error to `None` with `.ok()` and a bare `Err(_) => None`.
The warning vector that the sibling clamp records assert against is built inside
`merge_tiers_with_warnings`, which runs on the parsed `Value` and therefore cannot
distinguish "file absent" from "file unparseable" — by then both are `None`. And
even if a warning existed, `emit_warnings` (`:275-279`) only `eprintln!`s it and
returns `()`, which the sibling record
[dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller](#dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller)
already flags as possibly discarded by the daemon host.

The implementable substitute, and what this record now asserts: `always(!X)` over
the *observable consequence*, plus an enumeration for the mechanism.
**Consequence half:** for a user config file that exists and does not parse, the
resolved `McModuleConfig` is not equal to `McModuleConfig::default()` **or** some
distinguishable signal exists. Today it is equal, which is the defect, so the
assertion fails on the current build and that is the point of the record.
`always` rather than `always-or-unreached` because the read path executes on every
`effective_config` call. **Mechanism half:** the enumeration that
`read_tier_cached`'s signature admits no diagnostic channel, which is a static
fact and needs no fixture. The consequence half is the falsifiable one; the
mechanism half is what makes the defect a design gap rather than a missing
`eprintln!`.
Fault/timing angle: none for the parse itself. There is a separate same-mtime
window: `read_tier_cached` keys on `(path, mtime)` (`config.rs:256`), so an
edit landing inside the filesystem's mtime granularity is not observed.
Required faults and enabling state: a user `magic-context.jsonc` with a syntax
error that `strip_jsonc` does not repair, for example an unterminated string.
Confidence: high —
[evidence](evidence/dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian.md).
`config.rs:261-264` discards both the parse error and the read error. Traced
the default `model_chain: Vec::new()` (`:121`) to `lib.rs:5020-5028`, which
records `no_fire: "no_models"`. A disposition pass re-read `:254-266` and
confirmed the absence of any warning parameter or `Result` on the function.
Existing check: none. Status `unaudited`.
Impact: a typo in the user config silently disables autonomous historian
firing. The only surface is a `no_models` no-fire reason, which points at model
configuration rather than at a parse failure.
Open questions:
- Is the mtime-granularity window worth a separate record, or is it subsumed
  here? An edit that changes bytes without changing mtime serves stale config
  until the next mtime change. Unresolved, needs a scoping decision at
  synthesis.
- Where should the diagnostic channel live? `read_tier_cached` would have to
  return a `Result` or take a warnings sink, and `effective_config`'s callers
  would have to carry it. That is a signature change across the config module,
  which is why the record's original check was not merely unwritten but
  unwritable. (needs human input)

## Group B: model-chain resolution

Two records on how the historian's model chain is built, kept together because
both are properties of the same walk and neither is visible in the resolved value.
The first is that the key lookup has two implementations that do not agree, so
which one runs decides whether a configured model is found at all. The second is
that the chain's deduplication is adjacent-only, so a repeated model separated by
one other entry survives and is billed twice. Both are cheap to check against a
constructed config and neither has a test.

### dec-a-model-key-lookup-walk-has-two-implementations-that-disagree

Type: safety
Reachability: test-only
Status: active
Exercised: not yet — for the differential this record actually asserts. The
existing tests exercise **one** of the two walks: `config.rs:721-744` and
`:760-785` drive the `config.rs` walk, including a shared TypeScript vector set.
Neither compares it against the scheduler walk, and the scheduler walk has no
wildcard test because it has no wildcard. This line previously read `partial —`
against those two tests, which credited coverage of one implementation as partial
coverage of a differential between two.
Guarantee: Every consumer of a per-model configuration map resolves a given
model key through the same documented walk.
Check: `always` — for every model key and every map, `config.rs`'s walk and
`scheduler::model_key_lookup_order` select the same entry. `always` because
each walk runs on every resolution for its own consumer.
Fault/timing angle: none.
Required faults and enabling state: a per-model map keyed only by a
`provider/*` wildcard. On the `cache_ttl` side this resolves; on the scheduler
side it would fall to `default`. **The scheduler side additionally needs
`ExecuteThresholdConfig::ByModel`, and nothing constructs that variant anywhere
in the repository**, which is what forces the reachability label below.
Confidence: high —
[evidence](evidence/dec-a-model-key-lookup-walk-has-two-implementations-that-disagree.md).
`CONFIGURATION.md:70` states the walk and says `cache_ttl` shares it.
`config.rs:159-200` includes the wildcard at `:196`; `scheduler.rs:849-870` has
no wildcard step, and `:818-829` and `:832-847` fall to `"default"`.
`config.rs:113-114` calls the walk "shared".
Existing check: `config.rs:760-785`
`cache_ttl_resolution_matches_shared_typescript_vectors` pins one
implementation against TypeScript vectors. No differential test between the two
Rust implementations. Status `unaudited`.
Impact: today the divergence is latent because `ByModel` is unconstructed
everywhere (see 4b's `sel-per-model-and-token-thresholds-inert-in-module`). If the
per-model threshold path is ever wired, a wildcard-keyed config will resolve
differently from the same wildcard on `cache_ttl`, and the documentation says
it will not.
Open questions:
- Should the two walks be one function? They already agree on the exact, bare,
  and dash-stripped steps, which is the duplication the repository's own
  duplication policy targets. (needs human input)

> Disposition note on this record's reachability label, and on the two halves the
> label collapses. **The label was `explicit-config-only` and that was wrong: no
> configuration can construct the state this record's check needs.** The check is a
> differential between two walks, and reaching the scheduler walk with a per-model
> map requires `ExecuteThresholdConfig::ByModel` (`scheduler.rs:456-458`).
> `config.rs` cannot build that variant: `number_at` (`:631-636`) returns
> `Option<f64>` from `Value::as_f64` and yields `None` for an object, and the one
> assignment to `execute_threshold_percentage` (`:430-432`) takes that `f64`
> directly, so an object-form `execute_threshold_percentage` in a config file is
> discarded before any enum is chosen. So config cannot reach it, and
> `explicit-config-only` asserts precisely that config can.
>
> **The relabel to `test-only` is the correct class and it overstates what exists,
> so the overstatement is recorded here rather than hidden.**
> `grep -rn 'ByModel' --include='*.rs'` over the whole tree returns exactly two
> hits, both in `scheduler.rs`: the variant declaration at `:115` and the match arm
> at `:456`. **Nothing constructs it — not production, not a test, not a fixture.**
> `test-only` is nonetheless right under METHOD's three-way vocabulary, because the
> class names the only route by which the state *can* be reached and that route is
> a direct in-crate call: `ExecuteThresholdConfig` is `pub` at `:111` with
> `#[serde(untagged)] Deserialize`, and `model_key_lookup_order` at `:849` is
> private, so an in-crate `#[cfg(test)]` caller is the whole reachable set. The
> label describes the class, not the census.
>
> **The split the evaluation offered as its alternative is recorded in prose rather
> than as a second record, and here is the split.** The record bundles two claims
> with different reachability: (a) the `config.rs` walk resolves a wildcard-keyed
> `cache_ttl` map correctly, which *is* `explicit-config-only` and is the half
> `config.rs:760-785` already pins against TypeScript vectors; and (b) the two
> walks agree, which is `test-only` and unconstructed. The record's `Guarantee:`
> and `Check:` are both (b), so (b) governs the label. A second record for (a) was
> considered and rejected: it would assert that one implementation matches an
> external vector set, which is what the existing test already does, so it would be
> a record with no gap behind it. Splitting the record would raise the part's count
> to 27 for no new obligation, and METHOD prefers reframing to proliferation.

### dec-a-model-chain-dedup-is-adjacent-only

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `config.rs:1119-1137` and `:1138-1153` cover chain
construction from `module_model` and the plugin-key fallback. `:1154-1165`
covers a blank `module_model`. No test repeats a model at a non-adjacent
position.
Guarantee: The resolved historian model chain contains no duplicate model id.
Check: `always` — after config resolution, `model_chain` has no repeated
element. `always` because `dedup()` runs on every resolution at
`config.rs:571`.
Fault/timing angle: none.
Required faults and enabling state: a user config with
`historian.module_model: "a"` and
`historian.module_fallback_models: ["b", "a"]`.
Confidence: high —
[evidence](evidence/dec-a-model-chain-dedup-is-adjacent-only.md). `Vec::dedup`
removes only consecutive runs, so `["a","b","a"]` is unchanged.
`historian.rs:1256` iterates the chain as ordered attempts, and `:1300`,
`:1380`, and `:1443` slice it as a remaining-candidates list.
Existing check: none. Status `unaudited`.
Impact: a duplicated model is attempted twice in one firing.
`config.rs:384-389` explains why the author cares about chain hygiene: a wrong
chain "would burn permanent-classified advances every fire".
Open questions:
- Is a repeated attempt actually harmful, or is it an acceptable retry? The
  comment at `:384-389` suggests the author treats wasted advances as a cost,
  but it is about namespace mixing rather than duplication. (needs human input)

## Group C: totality, determinism, and the two exceptions

**Seven records on the pure decision units, after a disposition pass split one in
two.** Four are guards that hold: a TTL parse total over arbitrary strings, a
budget derivation total over the non-finite inputs it validates, a chunk-token
derivation total at both integer extremes, and escalation bands that stay ordered
for every threshold. They are recorded rather than assumed because each is the
guarded analogue of a Part 3 defect, so the record fixes the boundary and makes a
later change that drops a guard visible. The fifth is determinism of the selection
decision under `HashMap` iteration, which holds because every result is a set or is
totally sorted before it escapes.

**Two are exceptions rather than guards, and the group heading used to name only
one.** The first is a clamp whose idempotence guard doubles as a bypass, because a
value already carrying the sentinel suffix is passed through unclamped. The second
was carried inside the budget-derivation record as an open question and is now its
own record: `BoundaryContext::trigger_budget` is the one float read without an
`is_finite` gate, and a `Some(NaN)` reaches `TriggerProgress.tail_size_bar`
(`boundary.rs:802`) and from there the transform response's historian diagnostics.
Its evidence was already written — the budget record's own evidence file states
that this test case fails today — so promoting it is applying a finding the part
had rather than adding one. The group therefore reads: four guards, one determinism
result, and two defects.

### dec-a-cache-ttl-parse-is-total-over-arbitrary-strings

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `scheduler.rs:1417-1424` covers `never` in four cases,
`5m`, and one malformed string. Nothing covers `"0"`, an uppercase unit, an
overflowing digit run, or a multi-byte trailing character.
Guarantee: `parse_cache_ttl` returns for every `&str` without panicking, and
any accepted value yields a millisecond count that no finite elapsed time can
misinterpret.
Check: `always` — for every input string, the call returns `Ok(n)` or
`Err(CacheTtlParseError)`, never panics, and never yields a value from a
non-finite intermediate. `always` because the scheduler parses the configured
TTL on every `decide` call through `scheduler_ttl_ms`.
Fault/timing angle: none in the parse. The consequence has one:
`ttl_hard_expired` compares
`now_ms.saturating_sub(last_response_time_ms) > ttl_ms`, so a `ttl_ms` of `0`
makes every pass past the first look idle-expired.
Required faults and enabling state: a `cache_ttl` string. `"0"`, `"5S"`,
`"99999999999999999999h"`, and `"5\u{20ac}"` are the interesting inputs; all
are accepted by `config.rs:486-491` as non-empty trimmed strings.
Confidence: high —
[evidence](evidence/dec-a-cache-ttl-parse-is-total-over-arbitrary-strings.md).
Read `scheduler.rs:385-419`, then executed the function's exact logic on nine
inputs. Confirmed `"0" -> Ok(0)`, `"5S" -> Err`, `"never"`/`"NEVER"` ->
`u64::MAX`, the overflow arm at `:414-418` -> `u64::MAX`, and that the
`len_utf8` slice at `:397` keeps a multi-byte trailing character on a character
boundary.
Existing check: `scheduler.rs:1417-1424`
`parse_cache_ttl_never_returns_u64_max` and `:1427-1435`
`never_ttl_predicates_are_always_false`. Status `unaudited`.
Impact: the parse itself is sound, which is the finding. The reachable hazard
is downstream: `"0"` forces a hard idle expiry on every pass, and any
unparseable string is swallowed into the `5m` default by `scheduler_ttl_ms`
(`:810-812`) with no report.
Open questions:
- Is `cache_ttl: "0"` intended as "always expire" or should it be rejected?
  `CONFIGURATION.md:163` documents neither. (needs human input)

### dec-a-boundary-budget-derivation-is-total-over-non-finite-input

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `boundary.rs:2226-2227` pins the commit-cluster constant
against a golden, and the golden fixture suite drives the boundary with
realistic values. No test supplies a non-finite context limit, threshold, or
usage percentage.
Guarantee: The **guarded** boundary and trigger derivations produce a finite,
in-range result for every f64 input they validate, including infinity and NaN,
and never propagate a non-finite value from a validated field into a decision or
a serialized diagnostic. The scope word "guarded" is load-bearing and was added by
a disposition pass: the unvalidated `trigger_budget` passthrough is now
[dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic](#dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic),
and it is a defect rather than a guard that holds.
Check: `always` — for every `BoundaryContext`, `derive_trigger_budget` returns
a value in `[5000, 50000]`, `derive_protected_tail_token_target().n >= 1.0` and
is finite, and `clamp_percentage` returns a value in `[0, 100]`. `always`
because every trigger evaluation runs all three. Each of the three has an
`is_finite` gate on its own inputs — `boundary.rs:339-341` for `context_limit`,
`:363-372` for the context limit and threshold, `:926-931` for the percentage —
so the check is over inputs those gates cover. It does **not** cover
`ctx.trigger_budget`, and the record no longer implies that it does.
Fault/timing angle: none.
Required faults and enabling state: a `BoundaryContext` whose `context_limit`,
`execute_threshold_percentage`, or `usage_percentage` is `f64::INFINITY` or
`f64::NAN`. Reaching that from production needs a host-supplied usage reading,
since `lib.rs:4950-4959` builds the context from request and store values.
Confidence: high —
[evidence](evidence/dec-a-boundary-budget-derivation-is-total-over-non-finite-input.md).
Read every guard: `boundary.rs:339-341`, `:363-372`, `:926-931`. Executed
`NAN.max(0.0) == 0.0` and `NAN.min(5.0) == 5.0` to confirm the absorption
argument, which is what makes `:342` safe against a NaN threshold. Also
confirmed that `ctx.trigger_budget` is the one unvalidated float (`:756-761`,
`:377-379`) and that production always passes `None` (`lib.rs:4957`), with
`Some` only at `lib.rs:16495` and `:16760`. The evidence file's test-plan item 4
already states that the `trigger_budget` case "fails today"
([evidence:184-187](evidence/dec-a-boundary-budget-derivation-is-total-over-non-finite-input.md)),
which is what the split acts on.
Existing check: none targeting non-finite input. Status `unaudited`.
Impact: this is the guarded analogue of Part 3's decay totality defects, and for
the three validated fields the guard holds. Recording it fixes the boundary so a
later change that drops a guard is visible.
Open questions: None. The `trigger_budget` question that stood here has been
promoted to its own record, because the evidence file already recorded that its
test case fails, which makes it a defect rather than an open question.

### dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic

Type: safety
Reachability: test-only
Status: active
Exercised: not yet — and the evidence for the sibling record already says the
oracle fails. `boundary.rs`'s golden fixture suite never sets `trigger_budget` to
a non-finite value; the two `Some` sites in the tree, `lib.rs:16495` and `:16760`,
pass finite numbers.
Guarantee: `BoundaryContext::trigger_budget`, being caller-supplied and read
without validation, does not carry a non-finite value into a boundary
computation or into a serialized diagnostic. **This guarantee does not hold
today.**
Check: `always(!X)` — for every `BoundaryContext`, if
`derive_protected_tail_token_target` or `check_compartment_trigger_with_index` is
called with `trigger_budget: Some(v)` where `!v.is_finite()`, then no field of the
returned `ProtectedTailTokenTarget` or `TriggerProgress` is non-finite.
`always(!X)` over a forbidden **state** with no dedicated detection point, per
METHOD's first check-semantics rule; `unreachable` would be wrong because the
`unwrap_or_else` at `:377-379` and `:756-761` must execute on every call and only
its `Some` arm's *content* is at fault. The assertion fails on the current build,
which is the record's purpose.
Fault/timing angle: none. Pure function of one context value.
Required faults and enabling state: one direct call with
`trigger_budget: Some(f64::NAN)` and a non-empty message set.
`BoundaryContext.trigger_budget` is a `pub` field and both entry points are
reachable in-crate, so the fixture is a struct literal and one call. No harness
work.
Confidence: high —
[evidence](evidence/dec-a-boundary-budget-derivation-is-total-over-non-finite-input.md).
Shares the sibling's evidence file, which already carries the trail: item 4 of its
test plan is exactly this case and states "That case fails today". Traced for this
disposition: `:377-379` reads `ctx.trigger_budget` through `unwrap_or_else` with no
`is_finite` gate on the `Some` arm, unlike every neighbouring field; `:383`'s
`(trigger_budget + reserve).min((usable * 0.5).floor())` absorbs the NaN, because
`f64::min` returns the non-NaN operand, so `headroom`, `ceiling_n`, and `n` stay
finite and `derive_protected_tail_token_target`'s own postcondition survives — but
`:399` stores the raw NaN into the returned struct's `trigger_budget` field. The
propagating path is the trigger one: `:756-761` performs the same unguarded read,
`:780-781`'s `MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE.max(...)` absorbs it for
`scan_budget`, and then `:802`'s
`tail_size_bar: trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER` is a bare multiply
with nothing to absorb it. So `TriggerProgress.tail_size_bar` is NaN.
Existing check: none. Status `unaudited`.
Impact: `TriggerProgress`'s own doc comment (`boundary.rs:322-324`) says it is
"Surfaced through the transform response's historian diagnostics so a stalled rig
drive is diagnosable per pass", and `tail_size_bar` is described at `:329-330` as
"The tail_size fire bar". It is carried out at `lib.rs:4982` and divided by 1000
and rounded at `:5002`. A NaN there is the diagnostic field going quietly wrong in
the response an operator reads to explain why the historian did not fire, and
`serde_json` renders a NaN as `null`, so the wire form is an absent number rather
than a visible error. This is the defect the sibling record's "no totality defect
was found" framing concealed, and it is the same class as Part 3's three.
Open questions:
- Should `derive_protected_tail_token_target` and
  `check_compartment_trigger_with_index` validate `ctx.trigger_budget` the way
  they validate `context_limit`, `execute_threshold_percentage`, and
  `usage_percentage`, or should the field's type make a non-finite value
  unrepresentable? The first is a two-line `is_finite` gate at each of the two
  read sites; the second is a newtype and a constructor. (needs human input)
- Production passes `None` (`lib.rs:4957`) so the reachability is `test-only`
  today. Whether a future caller may supply the budget — the field exists for
  someone — decides whether this is a latent defect or an active one. Unresolved;
  the field's purpose is not documented at its declaration (`:222-224`).

### dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `config.rs:972-978` covers `1`, `32_000`, `128_000`,
`200_000`, and `400_000`, so both clamp arms are hit. Neither `0` nor
`usize::MAX` is covered.
Guarantee: `derive_historian_chunk_tokens` returns a value in
`[MIN_HISTORIAN_CHUNK_TOKENS, MAX_HISTORIAN_CHUNK_TOKENS]` for every `usize`
input, without panicking.
Check: `always` — for every input, the result is in `[8000, 50000]`. `always`
because every historian firing derives the budget from the configured limit.
Fault/timing angle: none.
Required faults and enabling state: `historian.context_limit_tokens` set to `0`
is impossible, because `positive_usize_at` (`config.rs:623-629`) discards it.
Reaching the extremes needs a very large configured limit or a direct call.
Confidence: high —
[evidence](evidence/dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes.md).
`config.rs:45-48`. Executed the exact body: `usize::MAX -> 50000` because a
float-to-integer `as` cast saturates rather than wrapping, `0 -> 8000`,
`1 -> 8000`. Traced the three call sites at `lib.rs:4700`, `:5087`, `:5250`.
Existing check: `config.rs:972-978`
`historian_budget_derivation_clamps_at_both_bounds`. Status `unaudited`.
Impact: low on its own. It matters as the paired positive result to the Part 3
defect class: the rounding-then-clamp order here cannot produce a value outside
the declared range, and the saturating cast means an absurd configured limit
degrades to the documented maximum rather than wrapping to a tiny budget.
Open questions: None.

### dec-a-escalation-bands-stay-ordered-for-every-threshold

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `scheduler.rs:1238`
`escalation_bands_stay_ordered_above_execute_and_below_emergency` covers the
ordering for the thresholds it samples. Non-finite and negative thresholds are
not covered.
Guarantee: For every effective threshold, the derived force-materialization
band lies at or above `MIN_FORCE_MATERIALIZE_PERCENTAGE` and strictly below the
fixed emergency band, and is monotone non-decreasing in the threshold.
Check: `always` — for every f64 threshold,
`85.0 <= force_materialize_percentage < emergency_percentage == 95.0`, and
`t1 <= t2` implies `bands(t1).force <= bands(t2).force`. `always` because every
boundary resolution and every scheduler band derivation calls it.
Fault/timing angle: none.
Required faults and enabling state: none. A threshold of `f64::NAN`, a negative
threshold, or a threshold above `90` are the interesting inputs.
Confidence: high —
[evidence](evidence/dec-a-escalation-bands-stay-ordered-for-every-threshold.md).
`scheduler.rs:187-198`. The non-finite arm substitutes `65.0` (`:191`); the
finite arm caps at `90.0` (`:190`), so `threshold + 2.0 <= 92.0` and
`force = max(85.0, threshold + 2.0)` lies in `[85, 92]`, always below the
constant `95.0` at `:21`. Confirmed the four consumers: `boundary.rs:815-816`,
`:484-485`, `:978-980`, and `scheduler.rs:522-526`.
Existing check: `scheduler.rs:1238` and, in `boundary.rs`, the golden constant
assertions at `:2226-2227`. Status `unaudited`.
Impact: if a threshold could push the force band to or past `95`, the `Force85`
arm at `scheduler.rs:525` would become unreachable and the emergency arm would
absorb the whole force band, changing which passes bypass mid-turn deferral.
The cap makes that impossible, and this record pins it.
Open questions: None.

### dec-a-selection-decision-order-is-total-under-hashmap-iteration

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `selection.rs:2836` `drop_wins_over_edit_marker` covers
the rank precedence. No test asserts that two runs over identical inputs
produce identical output, which is the claim the module header makes.
Guarantee: `select_reductions` returns byte-identical decisions for identical
`(items, frozen_keys, ctx, cfg)`, independent of hash-map iteration order.
Check: `always` — for identical inputs, repeated calls return equal
`Vec<ReductionDecision>`; and the enabling precondition holds, namely that no
two distinct arcs emit a decision for the same `target_id`. `always` because
determinism is stated as the cache invariant at `selection.rs:6-7` and every
non-defer pass runs the selector.
Fault/timing angle: none in a single pass. The consequence window is across
passes: a non-deterministic decision set makes a defer-pass replay differ from
the frozen bytes.
Required faults and enabling state: none for the property. Refuting it needs an
input where one `target_id` receives two same-rank decisions with different
payloads, which requires duplicate `SelItem` ids mapped to different `arc_id`s.
Confidence: high —
[evidence](evidence/dec-a-selection-decision-order-is-total-under-hashmap-iteration.md).
Traced both hash-map iterations that reach output: `selection.rs:1305` and
`dedupe_and_sort`'s `:1397-1405`. The final `out.sort_by` at `:1408` sorts on
`target_id`s that `best` has made unique, so the order is total. Also checked
every internal sort for a total tie-break: `:853-861`, `:763-770`,
`:1033-1037`, `:1071-1075`, `:447-452`, `:1290-1295` all end in an `arc_id` or
`mid` comparison.
Existing check: `selection.rs:2836` `drop_wins_over_edit_marker`, plus the
differential golden that `selection.rs:32-33` names as the arbiter. Status
`unaudited`.
Impact: the header stakes the cache invariant on this. If it fails, a defer
pass replays different bytes than the freeze produced, which busts the provider
prefix cache without any pass intending to.
Open questions:
- Can duplicate `SelItem` ids reach the selector? Ids are `mid#block_index`
  projections from `ck_wire.rs`, which is the sibling lens's scope. Unresolved,
  needs the codec lens to confirm id uniqueness.

### dec-a-region-hint-clamp-bypassed-by-sentinel-suffix

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `selection.rs:2537-2549` covers the UTF-16 cap and the
surrogate back-off. No test supplies a value that already ends with the
sentinel.
Guarantee: An `edit_marker` payload's diff-bearing values are clamped to a
bounded region hint regardless of their content.
Check: `always` — for every diff value, the `edit_marker` payload's
corresponding value is at most `EDIT_REGION_HINT_LEN` UTF-16 units plus the
sentinel. `always` because `region_hint` runs on every diff key of every
superseded edit.
Fault/timing angle: none.
Required faults and enabling state: `smart_drops: true`, which is off by
default (`config.rs:135`, `CONFIGURATION.md:752`), plus an `edit` or `write`
tool call superseded by a later edit to the same file, whose `oldString`,
`newString`, or `content` value ends with the literal `...[truncated]`.
Confidence: high —
[evidence](evidence/dec-a-region-hint-clamp-bypassed-by-sentinel-suffix.md).
`selection.rs:559-561` returns the input unchanged when it ends with
`TRUNCATION_SENTINEL` (`:71`). Executed the predicate on a 5,014-character
hostile string to confirm it takes the short-circuit arm. The gate is
`cfg.smart_drops` at `:1229` and `:1236`.
Existing check: `selection.rs:2537-2549`
`edit_marker_region_hint_caps_utf16_and_backs_off_split_surrogate`, which
covers the other two arms. Status `unaudited`.
Impact: a superseded edit keeps its full diff instead of a 40-unit hint, so the
reduction reclaims nothing while the accounting believes it did. The content is
harness-supplied, so a file whose text legitimately ends with that marker is
enough; no adversary is required.
Open questions:
- Should the guard test for a well-formed hint rather than a bare suffix, for
  example a length check as well? Changing it would have to preserve
  idempotence, which the doc comment at `:557` claims. (needs human input)

## Group D: decoder acceptance with no rejection channel

Four records on what the harness codecs silently accept and silently discard.
The first is the shape: neither decoder can reject anything, so the question
inverts. The next two are the two harnesses answering it in opposite ways, Pi
dropping an unrecognised entry with nothing retained, OpenCode retaining the raw
part but hiding four named part types from every transform decision. The fourth is
provenance recovery on decode, which is all-or-nothing and exists on one harness
only. Group D is where the crate's trust boundary actually sits, and none of these
records has a rejection channel to test, so each oracle is a comparison between
what entered and what the next stage can see.

### codec-b-harness-decoders-accept-every-input-with-no-rejection-channel

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the only decoder inputs anywhere are the two goldens' 21
well-formed values (`codec/mod.rs:57`, `:180`) and the hand-built fixtures in
`codec/opencode.rs:1322-2186` and `codec/pi.rs:1078-1499`. No test supplies a
non-object array element, and there is no arbitrary-input sweep of any kind.
Guarantee: For every input array, each harness decoder returns a value whose
postcondition holds, without panicking, without unbounded allocation, and
without producing a message that silently misrepresents its input.
Check: `always` — for arbitrary input, the call returns; `decoded.len()`,
`sidecar.order.len()`, and the per-message block counts are consistent with the
input. A panic is a forbidden state with no dedicated detection point, so it is
`always(!panic)`; `unreachable` would be wrong because no code location must
never execute. This reapplies Part 1's `decoder-totality-over-arbitrary-bytes`
(`part-1-shm-transport/catalog.md:1284-1329`), with the postcondition
strengthened because there is no error variant to fall back on.

**The allocation clause is separated out and downgraded, because it is not
observable from a decoder call.** The original check ended "and allocation is
bounded by a constant multiple of input size", counted alongside the return and
consistency clauses as though one `decode` call could witness it. It cannot: the
functions return `DecodedHarnessMessages` and expose no allocation accounting, so
proving a multiple of input size needs an allocation observer — a
`#[global_allocator]` counting wrapper, a `dhat`-style profiler, or a
`Vec::capacity` sweep over the returned structure — none of which exists in this
tree and any of which is a harness of its own. Its honest status is
**enumeration, not assertion**: the largest allocations in either decoder are
`raw_message.clone()` at `codec/opencode.rs:232` and `raw_entry.clone()` at
`codec/pi.rs:114`, each one input message, and no loop in either file allocates
per iteration without a bound from the input. That is a static reading and it is
already recorded in the `Confidence:` line below. If an allocation observer is ever
built, the clause becomes assertable as stated; until then it is a claim discharged
by reading and it must not be counted as an oracle a decode call satisfies.
Fault/timing angle: none. Both decoders are pure functions over one immutable
slice, exactly as Part 1's three were. The exposure is structural rather than
temporal: totality is achieved by a default ladder (observations 2 and 3), not
by validation, so every malformation is converted into a plausible-looking
decoded message.
Required faults and enabling state: none for the return and consistency clauses.
An arbitrary `Vec<Value>` is the whole enabling state. The interesting members are
a bare string or number as an array element, a `parts` value that is an object
rather than an array, and a part whose `type` is absent. **The allocation clause
additionally needs an allocation-observing harness**, which the tree does not have,
so that clause is the reason this record is `partial` on its own terms.
Confidence: high —
[evidence](evidence/codec-b-harness-decoders-accept-every-input-with-no-rejection-channel.md).
Signatures read at `HEAD`: `codec/opencode.rs:23-25`, `:27-32`, `:37-41` and
`codec/pi.rs:19-21`, `:23-26` all return `DecodedHarnessMessages`. Every
fallible extraction in both files was enumerated; all of them are
`Option`-combinator chains terminating in `unwrap_or`, `unwrap_or_default`, or
`unwrap_or_else`. Panic sites in the production halves
(`codec/opencode.rs:1-1321`, `codec/pi.rs:1-1077`): three `debug_assert!`
(`opencode.rs:251`, `:252`, `:466`) and one slice index (`:258`), all covered
by record two; every other index is bounded by the loop that produced it
(`opencode.rs:716-717` by the `while` at `:715`, `:730` by the
`.get(block_index + 1)` test at `:727`, `pi.rs:393` by the `matches!` on
`.first()` at `:389-392`). No decoder allocates unboundedly; the largest
allocations are `raw_message.clone()` at `opencode.rs:232` and
`raw_entry.clone()` at `pi.rs:114`, each one input message.
Existing check: partial and indirect. `codec/mod.rs:78-89` and `:201-212`
assert decode determinism (`decoded == decoded_again`) over the goldens, which
pins purity but not totality. `codec/opencode.rs:1322-2186` (17 tests) and
`codec/pi.rs:1078-1499` (14 tests) all use well-formed fixtures. Status
`unaudited`. CI runs only `cargo test -p mc-module --test lifecycle_cli`
(`.github/workflows/ci.yml:172`), so none of these execute in CI.
Impact: the failure mode is not a crash, it is a fabricated message. A harness
that ships a malformed element gets a zero-block `"user"` message that occupies
an ordinal, enters the sidecar, participates in boundary selection, and is
re-encoded from its retained raw. Nothing downstream can tell it apart from an
authentic empty user turn. Part 1's equivalent record could say "the property
holds at HEAD and is under-evidenced rather than violated"; this one cannot,
because the property as stated is violated by design.
Open questions:
- Should a harness codec have a rejection or warning channel at all, or is
  total coercion the deliberate contract on the grounds that the harness is
  trusted? Nothing in either file states a position. (needs human input)

### codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record

Type: safety
Reachability: test-only
Status: active
Exercised: not yet — no golden case and no unit test supplies an entry whose
`type` is outside
`{message, custom_message, custom, branch_summary, compaction}`. Observation 21
verifies the Pi golden's 11 entries use only three of those.
Guarantee: An input entry the Pi decoder does not recognise is either
represented in the decoded output, retained for replay, or reported; it is not
discarded without trace.
Check: `always` — for every input entry, either a `CkIngressMessage` exists
whose meta retains the entry's bytes, or the entry's bytes are recoverable from
`sidecar.messages`. `always` because the decode loop visits every entry
unconditionally.
Fault/timing angle: none. The consequence is temporal only in that it
compounds: the dropped entry also shifts every later ordinal, because
`codec/pi.rs:52` derives the ordinal from `decoded.len() + 1` rather than from
the entry index.
Required faults and enabling state: one Pi session entry with an unrecognised
`type` and no `role` key, for example `{"type": "tool_use_v2", "data": {}}`, or
the degenerate `{"type": "message"}` with no `message` key.
Confidence: high —
[evidence](evidence/codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record.md).
`codec/pi.rs:41-50` read at `HEAD`; `pi_message` at `:661-669` returns `None`
unless `type == "message"` (then `raw_entry.get("message")`, itself possibly
`None`) or a `role` key is present; `is_pi_opaque_entry` at `:681-686` admits
exactly `custom_message`, `custom`, `branch_summary`. The `continue` at `:49`
writes nothing. Contrasted against `codec/opencode.rs:194-204`, which routes
every unknown part type to `CkKind::Opaque` with `raw: part.clone()`, so the
two harness decoders hold opposite policies for the same situation. Also
contrasted against the CK layer's stated contract at `ck_wire.rs:19-21`, which
requires the pass-through path stay `Value`-level "so harmless future CK fields
are not silently dropped".
Existing check: none. `codec/pi.rs:1078-1499` has 14 tests;
`codec/pi.rs:1479-1483` asserts `encode_pi(...).is_empty()` for an
empty-content message, which is the encoder half of a different drop. Status
`unaudited`.
Impact: two consequences, one recoverable and one not. Recoverable: `encode_pi`
cannot reproduce the entry, so a decode-then-encode round trip silently
truncates the session file. Unrecoverable in the same pass: every later entry's
ordinal shifts down by one, so a persisted boundary ordinal or tag keyed to an
ordinal now names a different message. Because Pi has no `absolute_ordinal`
input (record ten), there is no way for the harness to pin the numbering
against this.
Open questions:
- Is the three-type opaque allow-list at `:681-686` a closed set by design, or
  a list that was meant to grow and did not? `codec/opencode.rs:194-204`
  suggests the crate's default answer is "preserve unknown shapes". (needs
  human input)
- Does the TypeScript Pi plugin drop the same entries before the Rust codec
  sees them? `packages/pi-plugin/PARITY.md:107-116` says Pi "rebuilds
  `AgentMessage[]` from JSONL every pass", which implies a shaping layer
  upstream. Unresolved, needs the TypeScript transcript adapter, which is
  outside 4f scope.

### codec-b-opencode-hides-four-part-types-from-every-transform-decision

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `testdata/codec/opencode-golden.json` includes one `patch`
part (message index 2) and the round trip at `codec/mod.rs:88` therefore does
pin that `patch` survives re-encode. Nothing covers `snapshot`, `agent`, or
`retry`, and nothing asserts the CK-side absence for any of the four.
Guarantee: A part type the OpenCode decoder omits from the CK view is
nonetheless byte-preserved on re-encode, and no downstream decision depends on
seeing it.
Check: `always` — for every accepted OpenCode message, the re-encoded parts
array contains every input part whose type is in
`{snapshot, patch, agent, retry}`, at its original index, byte-identical; and
no `BlockMeta` claims that index. `always` because the decode arm is
unconditional. This is the surviving half of Part 1's
`accepted-decode-consumes-its-declared-width`
(`part-1-shm-transport/catalog.md:1330-1373`): a byte either influences a
decoded field or is retained verbatim, and here it is the second case for four
named types.
Fault/timing angle: none at decode. The interaction to check is with
`remove_unretained_native_parts` (`codec/sidecar.rs:118-128`), which removes a
native index only when it is in `decoded_native_indices` and not in
`retained_native_indices`. The four types never enter `decoded_native_indices`,
so they are structurally immune to deletion compaction. That immunity is
load-bearing and stated nowhere.
Required faults and enabling state: none for the preservation direction; one
OpenCode message carrying any of the four part types suffices. For the
interesting composition, that message must also have a decoded block deleted,
so that `remove_unretained_native_parts` runs with a non-empty removal set.
Confidence: high —
[evidence](evidence/codec-b-opencode-hides-four-part-types-from-every-transform-decision.md).
`codec/opencode.rs:193` read at `HEAD`. Traced the preservation path:
`encode_with_meta` starts from `meta.raw`'s parts at `:707-711`, only mutates
matched indices (`:761-779`), pushes unmatched blocks (`:780`), then filters
via `:784`. Confirmed against the golden: the `patch` part at input message
index 2 survives `codec/mod.rs:88`'s
`assert_eq!(encoded, strip_opencode_compaction(case.messages))`, which strips
only `compaction`.
Existing check: partial, and it covers the type by accident rather than by
design. `codec/mod.rs:59-76` lists `patch` as a required coverage class and the
golden supplies one, so the round trip pins it. `codec/mod.rs:216-252`
`codec_conformance_removes_leading_native_blocks_without_reindex_drift`
exercises `remove_unretained_native_parts` but on a message with no immune
parts. Status `unaudited`.
Impact: correct today, and fragile in one specific direction. Because these
four types are invisible to the CK view, the transform's byte accounting, tag
numbering, and boundary selection never see them, while the provider does. If
any of the four ever carries content large enough to matter to the context
budget, the module's measurement of the array is wrong by exactly that amount
and no existing check would notice.
Open questions:
- Are all four types genuinely content-free for provider purposes? `patch` is
  the one that plausibly carries bytes. Unresolved, needs the OpenCode
  part-schema, which is not vendored (observation 20 records that the SDK
  serializer is absent from the test closure).

### codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `codec/mod.rs:128-175`
`fresh_boundary_prefix_does_not_borrow_persisted_synthetic_meta` builds a
persisted message whose single part carries `synthetic: true` and asserts at
`:174` that it re-encodes byte-identically, which exercises the all-synthetic
recovery path. Nothing covers a mixed-parts message, and nothing covers Pi.
Guarantee: A codec that reads a message the module previously wrote recovers
the same synthetic-versus-authentic classification the module assigned.
Check: `always` — for every message the module encodes with
`meta.synthetic == true`, decoding the encoded form yields
`meta.synthetic == true`. `always` because the classification is computed for
every decoded message.
Fault/timing angle: the window is a pass boundary. Provenance is lost only when
a module-authored message survives into the next pass's ingress, which is the
normal case for a persisted m0, m1, or injected pair.
Required faults and enabling state: for the mixed-parts hole, one OpenCode
message with one synthetic part and one authored part. For the role hole, a
synthetic assistant or tool message that is not the todo pair. For Pi, any
input at all.
Confidence: high —
[evidence](evidence/codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only.md).
`codec/opencode.rs:1277-1279` read at `HEAD`:
`!parts.is_empty() && parts.iter().all(is_synthetic_part)`, so an empty-parts
message and a mixed-parts message both classify as authentic.
`is_synthetic_part` at `codec/sidecar.rs:331-339` accepts `synthetic` or
`syntheticTodoMarker`. Encoder side: `codec/opencode.rs:991-995` stamps
`synthetic: true` on every part only when
`msg.meta.synthetic && msg.role == "user"`; `render_synthetic_todo_pair` at
`:941-947` stamps `syntheticTodoMarker: true`. `codec/pi.rs:99` hardcodes
`synthetic: false` with no read of any input field. Part 4e is cited rather
than re-derived for the two halves it owns:
`part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378` for the Pi encoder
writing no marker and having no production caller, and `:379-382` for
`HarnessMeta::synthetic` surviving on the CK wire while never reaching the
model. This record adds only the decode direction and the all-or-nothing
condition, neither of which appears in 4e.
Existing check: `codec/mod.rs:128-175` for the all-synthetic path, and
`codec/mod.rs:290-298` `fixture_builder_drives_synthetic_todo_wire_shape`,
which asserts `message["meta"]["synthetic"] == true` on the native fixtures.
Neither covers a mixed message. Status `unaudited`.
Impact: the module's own writes can come back classified as user-authored.
`meta.synthetic` gates `meta_for_ck`'s positional fallback
(`codec/sidecar.rs:324-328`), so a misclassified module-authored message
becomes eligible to inherit a native envelope by position, which is the failure
`codec/mod.rs:128-175` exists to prevent for the other direction. Pi's
hardcoded `false` means the Pi leg has no provenance at all in either
direction; combined with 4e's finding this leaves synthetic content
indistinguishable from authentic content for that harness at every layer.
Open questions:
- Is all-parts-synthetic the intended rule, or should any synthetic part mark
  the message? The `!parts.is_empty()` guard suggests the author considered
  degenerate cases, which makes the mixed case look unconsidered rather than
  decided. (needs human input)
- Should `codec/pi.rs:99` read a marker at all, given 4e's finding that the Pi
  encoder writes none? The two halves are consistent with each other and
  jointly inconsistent with the OpenCode leg.

## Group E: cross-stage composition and block identity

Three records that are only visible when two stages are read together. The
decoder's output must satisfy the projector's precondition and neither codec checks
that it does, so Part 1's "identity and schema rejection is one contract" becomes a
composition property here. The absolute ordinal every later decision indexes on is
harness-supplied and never validated. And the block-identity stamp is
caller-writable while the fingerprint is computed over the typed projection only,
so it is a change detector rather than an identity. All three live in or depend on
`codec/sidecar.rs`, the file with no tests.

### codec-b-decoder-output-can-violate-the-projector-precondition

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `ck_wire.rs:1122` and `:1149` assert `UnpairedToolResult`
is produced for two hand-built CK inputs, so the projector's rejection is
pinned. Nothing feeds decoder output to the projector, so the composition is
untested from either end.
Guarantee: Every value a harness decoder returns satisfies the preconditions
`project_messages` enforces, or the decoder rejects or repairs the input that
would violate them.
Check: `always` — for every decoder output,
`project_messages(&decoded.messages).is_ok()`. `always` because the projection
runs on every transform pass. This is Part 1's
`identity-and-schema-rejection-is-one-contract`
(`part-1-shm-transport/catalog.md:1375-1426`) reapplied across a stage boundary
instead of across two sibling readers: there, two decoders had to agree on one
condition set; here, a producer and a consumer must agree, and the producer
enforces nothing.
Fault/timing angle: none temporal. The structural angle is that a violation is
not local: `project_messages_from_state` returns `Err` on the *first* offending
message (`ck_wire.rs:424-426`), which fails the entire projection and therefore
the whole pass, not just the one message.
Required faults and enabling state: two independent shapes, both
harness-controlled. First, one OpenCode message with `info.id` containing `#`,
or one Pi entry with such an `id` or `responseId`; the decoders copy it
verbatim into the mid and the projector rejects it. Second, a Pi `toolResult`
entry whose preceding `toolCall` entry was dropped by record three's mechanism,
which yields a `ToolResult` block with no pending call.
Confidence: high —
[evidence](evidence/codec-b-decoder-output-can-violate-the-projector-precondition.md).
`ck_wire.rs:324-337` enumerates the three error variants and all three are
constructed: `MidContainsReservedHash` at `:425`, `UnsupportedBlock` at `:585`,
`UnpairedToolResult` at `:660` and `:667`. Mid provenance traced:
`codec/opencode.rs:61-67` takes `string_field(info, "id")` with no validation,
and `codec/pi.rs:58-62` with `:710-715` takes `id` then `responseId` then a
timestamp then a synthesised fallback, again unvalidated. Only the last two
fallbacks are `#`-free by construction. For the pairing half, confirmed the
OpenCode decoder emits call and result adjacently in one message
(`codec/opencode.rs:496-541`), so it cannot produce an unpaired result from a
single part, while `codec/pi.rs:77-79` with `:86-90` makes each `toolResult`
its own message.
Existing check: partial and one-sided. `ck_wire.rs:1122` and `:1149` cover the
projector's rejection with hand-built inputs. Nothing covers the mid rejection
at all, and no test composes a decoder with the projector. Status `unaudited`.
Impact: a single harness-supplied id containing one `#` character fails every
transform pass for that session until the message leaves the window. The
rejection is correct and fail-closed; the defect is that it is detected two
layers away from the layer that could have normalised it, and the error names a
reserved character the harness never agreed to avoid.
Open questions:
- Should the decoders normalise or reject `#` in a mid, so the failure is
  attributable to one message rather than the whole array? `ck_wire.rs:369-372`
  documents the fallback-to-full-projection policy for out-of-range metadata;
  nothing analogous exists for a malformed mid.
- Is `#` reserved because `block_id` is `format!("{mid}#{index}")`
  (`ck_wire.rs:513-515`)? If so the reservation is stricter than its own parser
  needs: `split_block_id` (`:517-521`) uses `rsplit_once('#')`, which
  round-trips a mid containing `#` correctly. So either the rejection defends a
  consumer other than `split_block_id`, or it is belt-and-braces. Unresolved;
  needs the set of `block_id` consumers, several of which are in 4b and 4c
  scope.

### codec-b-absolute-ordinal-is-harness-supplied-and-never-validated

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `transform.rs:20278` supplies `"absolute_ordinal": 2_414`
and `:27809` and `:27942` supply `1` and `3`, so the explicit path is
exercised. Nothing supplies a duplicate or a zero, which are the producer's two
documented non-dense cases, and nothing asserts the relationship between
`max(ordinal)` and message count.
Guarantee: Every consumer of a decoded ordinal interprets it in the ordinal
space the producer emits, which is session-global, non-dense,
duplicate-permitting, and zero-inclusive.
Check: `always` — for every decoded array, any consumer computing a message
count from ordinals agrees with `decoded.len()`. `always` because the ordinal
is assigned to every decoded message on every pass. Stated over the consumer's
interpretation rather than over the decoder's validation, because the
producer's contract makes the decoder's verbatim pass-through correct.
Fault/timing angle: no temporal window in Rust. Cross-pass ordinal stability is
guaranteed on the producer side by a memo mismatch check
(`packages/plugin/src/hooks/magic-context/module-wire.ts:1041-1048`), not by
anything in this crate, so a producer change that dropped the memo would
destabilise every ordinal-keyed piece of Rust state with no Rust-side
detection.
Required faults and enabling state: none. A window into the tail of a long
session is the whole enabling state: the producer bases the numbering on a
canonical count (`module-wire.ts:1028-1031`), so a fifteen-message window of a
500-message session carries ordinals around 501-515. `module-wire.test.ts:180`
pins `absolute_ordinal: 501` as a real value.
Confidence: high —
[evidence](evidence/codec-b-absolute-ordinal-is-harness-supplied-and-never-validated.md).
`codec/opencode.rs:52-60` read at `HEAD`; the fallback is
`provisional_base.saturating_add(index).saturating_add(1)`, so the fallback is
dense and monotonic and the explicit path is unconstrained. The producer was
then read, which changed the finding: `module-wire.ts:1027-1034` numbers from
`canonicalCount` or an explicit `provisionalBase`, never from an array index;
`:999-1018` states that a synthetic message "borrows the preceding canonical
ordinal instead of consuming a slot", so duplicate ordinals are deliberate;
`:1017` assigns `0` when there is no resolved predecessor.
`boundary.rs:687-691` computes `total_message_count` as `max()` with
`unwrap_or(ordered.len() as u64)` at `:691`, which is direct evidence the
consumer reads `max()` as a count. `codec/pi.rs:52` and `:45` confirmed to use
`decoded.len() + 1`, so Pi is dense-but-unstable where OpenCode is
stable-but-sparse.
Existing check: none for the invariant, in either language.
`codec/opencode.rs:246-281`'s incremental path and `lib.rs:12550-12563`'s
prefix validation both reason about positions, not ordinals. Status
`unaudited`.
Impact: this record answers the open question Lens A left for this lens
(`_lenses/lens-a-decision-units-and-config.md:589-593`), and the answer is that
max-as-count is wrong, not merely fragile: the producer's ordinal space is
session-global by design and permits duplicates by design, so
`boundary.rs:687-691` disagrees with the ingress contract for every windowed
session rather than only for a contrived one. Whether the resulting chunk
estimate is materially wrong is 4a's and 4b's call, since
`ChunkBuilder::finish` is theirs; the decoder's contribution is that it
faithfully passes through a space one consumer was not written for.
Open questions:
- Should `boundary.rs:687-691` take `ordered.len()` instead of `max()`, or does
  it genuinely want the highest ordinal for a different reason? Needs the
  `ChunkBuilder::finish` contract, which is 4a and 4b scope.
- Why does Pi have no `absolute_ordinal` equivalent, given that
  `codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record` makes
  its positional numbering unstable? Unresolved.
- Can an incremental suffix ever lack explicit ordinals?
  `decode_opencode_sidecar_incremental` passes `replace_from` (an array index)
  as `provisional_base` at `:260`, while the producer's base is a canonical
  count, so the two bases are in different spaces.
  `module-state-sync.test.ts:779` asserts some message has no
  `absolute_ordinal`, so I could not conclude the fallback is unreachable.

### codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `codec/sidecar.rs` has zero `#[test]` functions.
Everything in it is covered only incidentally through the two harness codecs'
goldens, which supply no duplicate-content blocks and no caller-supplied stamp.
Guarantee: The block-identity stamp that the encoder trusts to align a mutated
block with its native part is authentic, and the fingerprint stored beside it
distinguishes blocks that differ.
Check: `always` — for every block the encoder aligns via a stamp, that stamp
was written by `stamp_block_identity` during this decode, and no two distinct
native parts in one message share a fingerprint without the stamp separating
them. `always` because the alignment runs for every block of every encoded
message.
Fault/timing angle: none temporal, but the ordering inside `push_block` is
load-bearing and undocumented: `codec/opencode.rs:553-554` and
`codec/pi.rs:303-304` compute the fingerprint *before* stamping, so the
fingerprint is deliberately stamp-independent, which is what makes it stable
across passes and also what makes it collide for identical content.
Required faults and enabling state: for the collision half, one OpenCode
message with two byte-identical parts. For the trust half, a CK ingress message
carrying `provider_extras["_cortexkit_codec"]` with plausible `blockIndex`,
`nativeIndex`, and `decodedFingerprint` values; `TransformRequest.messages` is
`Vec<CkIngressMessage>` (`transform.rs:781`) and `CkWireBlock`'s `Deserialize`
(`mc-store/src/lib.rs:207-221`) reads `provider_extras` verbatim.
Confidence: high —
[evidence](evidence/codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity.md).
`codec/sidecar.rs:131-134` gives the namespace and three keys as plain string
constants. `stamped_block_identity` at `:177-183` reads them back with no
provenance check; `alignment_candidate` at `:204-211` returns early on a stamp
match, never consulting `kind_matches`, so a forged stamp outranks the kind
check. `decoded_block_fingerprint` at `:151-156` calls
`canonical.mark_modified()` at `:154`, which clears `original`
(`mc-store/src/lib.rs:261-263`), so the hash covers `kind` plus
`provider_extras` only and is blind to the retained pass-through bytes the CK
contract at `mc-store/src/lib.rs:92-95` exists to preserve.
`block_is_unchanged` at `:192-196` is fingerprint-only. The mitigating fact was
checked and holds: the harness decoders never route input into
`_cortexkit_codec`, since `block_with_metadata` (`codec/opencode.rs:567-577`)
writes under the `"opencode"` key, so the forged-stamp path is reachable from
CK ingress and not from harness ingress.
Existing check: none in `codec/sidecar.rs`. `codec/opencode.rs:1515-1582` and
`codec/pi.rs:1436-1443` exercise alignment after a block deletion and an encode
replay, which covers the honest path. Status `unaudited`.
Impact: two shapes. The forged stamp lets a CK caller point a block at a native
part it did not come from, and `alignment_candidate`'s early return means the
kind check that would otherwise catch the mismatch is skipped, so the encoder
can write a text block's content into a reasoning part. The fingerprint
collision is contained today because the stamp disambiguates duplicates, which
makes the stamp the sole load-bearing disambiguator for a case the fingerprint
cannot handle: if the stamp were ever dropped from the pass-through path,
duplicate-content blocks would align by the `:225-227` positional fallback
instead, silently.
Open questions:
- Should the stamp carry a per-decode nonce so a stamp from a prior pass or a
  foreign caller is distinguishable? The comment at `:243-247` says the stamps
  "survive reductions, overlays, and deletion compaction", which is the
  property that makes them useful and also the reason they cannot be validated
  by age.
- Which of the three serialization-failure policies is normative? `:155` maps a
  failure to `Value::Null`, `:293` maps it to empty bytes, and
  `ck_wire.rs:585-589` maps it to `CkWireError::UnsupportedBlock`. The first
  two collapse every failing block onto one hash, which `block_is_unchanged`
  would then read as "unchanged".

## Group F: release behaviour of the codec guards

Two records on the three `debug_assert!` sites, which are the only runtime
assertions in the 4f production halves. The first covers the incremental sidecar
slice, where the adjacent pair of assertions diverge under release: one condition
is re-checked by the language and one is absorbed by a saturating `take`. The
second covers the encode-side uniqueness guard, which has a single arm and
therefore enforces nothing in release while three production call sites depend on
it. Both records must name the profile they hold in, and the shipped profile's
behaviour is the one with no test in either case.

### codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test calls `decode_opencode_sidecar_incremental` with
`replace_from > messages.len()`, and no test calls it in a release build.
Guarantee: `decode_opencode_sidecar_incremental` returns a sidecar or a
declared error for every `(messages, prior, replace_from)` triple, including
triples its callers cannot currently produce.
Check: `always` — for arbitrary `replace_from`, the call returns without
panicking. `always` rather than `always-or-unreached` because the function is
called on every native-attachment pass with a cached snapshot and a non-zero
trusted prefix; the *out-of-range* argument is what is currently unreachable,
and that unreachability is a caller property, not a callee property.
Fault/timing angle: none in the callee. The window that matters is a
maintenance window rather than a runtime one: the bound is enforced two frames
up, in a different file, by two separate filters, and neither cites the callee.
Required faults and enabling state: a caller passing
`replace_from > messages.len()`. Reaching it today requires either a new
caller, or `validated_native_prefix`'s `:12561` filter changing, or
`native_sidecar`'s `:12576` condition changing. In a debug build the
`debug_assert!` fires first; in release the slice index panics with "range
start index out of range".
Confidence: high —
[evidence](evidence/codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert.md).
`codec/opencode.rs:251-258` read at `HEAD`:
`debug_assert!(replace_from <= messages.len())` then
`&messages[replace_from..]`. Both callers traced and both confirmed to enforce
the bound: `lib.rs:12550-12563` filters `*replace_from <= native_len` at
`:12561`, and `lib.rs:12565-12585` gates the call on
`trusted_prefix > 0 && trusted_prefix <= snapshot.sidecar.order.len()` at
`:12576`. Note the second condition bounds `replace_from` against the *sidecar
order length*, not against `messages.len()`; the `messages.len()` bound arrives
only via `validated_native_prefix`, so the two `debug_assert!`s at `:251` and
`:252` are discharged by two different callers' checks.
Existing check: none for the bound. `lib.rs:12452-12453` and `:12457-12459`
define `CorruptSidecarForTest` and `CorruptFrontierForTest` modes, and
`:12531-12541` deliberately perturbs the projection prefix by `+1` under
`cfg(test)` and then re-clamps with `prefix <= projection.message_count()` at
`:12543`. That machinery proves the authors thought about a corrupted prefix on
the projection path and built a test hook for it; no equivalent hook exists for
the sidecar slice. Status `unaudited`.
Impact: a panic inside the transform on the default production path. This is
the same shape as Part 1's observation that "narrowing `GRANT_BYTES` turns
`ring.rs:430` into an unconditional panic on every call, and no property
currently forbids either" (`part-1-shm-transport/catalog.md:1322-1324`): the
reasoning that keeps the call safe lives only in the callers, and nothing in
the tree records that the callee depends on it.
Open questions:
- Should the function clamp with `messages.len().min(replace_from)` and fall
  back to a full decode, matching the documented policy at `ck_wire.rs:369-372`
  that "malformed or out-of-range local metadata falls back to a full
  projection rather than trusting a partial result"? The projection path
  already does this; the sidecar path does not. (needs human input)

### codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `codec/opencode.rs:1486-1513` asserts that two encodes of
the same input produce identical tool parts, which exercises determinism rather
than the duplicate guard. No test constructs a duplicate `callID` in the
encoded array.
Guarantee: The encoded OpenCode array contains no two `tool` parts sharing a
`callID`, or the duplicate is removed before the array is returned.
Check: `always(!duplicate)` — for every returned `Vec<MessageV2Json>`, the
multiset of `callID` values across all `tool` parts has no repeats.
`always(!X)` and not `unreachable`, per METHOD's rule: the forbidden thing is a
*state* of the returned array, and the guard at `codec/opencode.rs:462-470` is
not a code point that must never execute, it is a check that must never find
anything.
Fault/timing angle: none temporal. The ordering that matters is layer ordering:
the CK-level guard runs first on `ServedMessage` (`transform.rs:12147`), the
wire-level guard runs last on the encoded JSON (`codec/opencode.rs:370`). A
duplicate introduced *by encoding* is visible only to the second guard, and the
encoder's own comment at `:750-753` describes exactly that case: "two
independently emitted shells carry the same callID".
Required faults and enabling state: a release build (`debug_assertions` off)
plus an input reaching the
`parts.push(render_tool_pair_as_part(block, result))` arm at `:754` for a call
id that another message already emitted. The comment at `:749-757` says this
arm exists because neither half matched a native index, which is the
fresh-shell case.
Confidence: high —
[evidence](evidence/codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour.md).
`codec/opencode.rs:462-470` read at `HEAD`: the body is
`let duplicates = ...; debug_assert!(duplicates.is_empty(), ...)` and nothing
else, so in release the function computes a `Vec` and discards it. Compared
against `transform.rs:11231-11249`, which `debug_assert!`s at `:11246` and then
has `#[cfg(not(debug_assertions))]` at `:11251` opening a heal branch that
drops the later duplicate and its paired result. So the two same-named guards
diverge in release, and the divergence is in the direction that leaves the wire
unprotected. Two independent `duplicate_tool_use_locations` implementations
exist, `codec/opencode.rs:438-460` over `MessageV2Json` and
`transform.rs:11235` over `ServedMessage`.
Existing check: partial and at the wrong layer. `transform.rs:21509` and
`:21522` exercise `enforce_unique_tool_use_ids` including its heal path.
Nothing exercises `assert_unique_tool_use_ids`. Status `unaudited`.
Impact: a provider request containing two `tool_use` blocks with one id, which
Anthropic-shaped providers reject outright, so the failure mode is a hard
request error rather than a degraded reply. The debug build catches it and the
shipped build does not, which is the inverse of what a wire-level invariant
wants. The guard is also applied inside `encode_opencode_impl` rather than in
the chunk API, so `lib.rs:12949`'s direct call to
`encode_opencode_chunks_with_transition_state` on the incremental native path
has no uniqueness check in any build profile.
Open questions:
- Should the wire-level guard adopt the CK-level heal branch, or should the
  CK-level heal be removed in favour of failing loud in both? The two layers
  currently encode two different answers to the same question. (needs human
  input)
- The scope map (`part-4-module/_lenses/scope-map-and-risk-ranking.md:603`)
  describes `enforce_unique_tool_use_ids` as one of two "fail-loud production
  checks". At `HEAD` it is a `debug_assert!` plus a release heal, so it is
  fail-loud in debug and fail-quiet-and-repair in release. 4e owns that
  function; flagged here as a lead only.

## Group G: round-trip claims and declared coverage gaps

Three records on what the goldens prove. The round-trip claim is made in one
direction on one case per harness, against an oracle derived from the test's own
input, so it cannot detect a decode error the encoder symmetrically reverses. The
coverage manifest is then designed to pass without two block classes it declares
required. And the Pi encoder can return a shorter array than it was given, which is
the failure the round-trip claim would have to be strengthened to catch. Read
together they say the codec suite measures agreement of the code with itself.

### codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness

Type: safety
Reachability: default-production
Status: active
Exercised: partial — one golden case per harness, `codec/mod.rs:78-89` and
`:201-212`, each asserting decode-then-encode against the input array. The
reverse direction is asserted nowhere, and both goldens declare their oracle
incomplete.
Guarantee: The direction each codec actually claims is decode-then-encode byte
identity modulo a declared exception set; encode-then-decode is explicitly not
the identity, and the exception set is complete.
Check: `always` — for every accepted input array,
`encode(decode(input)) == input` after removing exactly the declared exceptions
(`compaction` parts for OpenCode via `codec/mod.rs:273-281`, whole `compaction`
entries for Pi via `:283-288`). Stated as `always` and in one direction only,
because the other direction is provably false: `codec/mod.rs:112-125` pins four
CK messages encoding to three wire messages.
Fault/timing angle: none. The angle that matters is oracle strength, not
timing. Both goldens carry `projection_oracle.status: "todo"` with a reason
stating the harness serializer "is not vendored in the Rust workspace test
closure", so the oracle compares against the retained input array and not
against provider wire bytes.
Required faults and enabling state: none for the claimed direction. To make the
oracle meaningful, an input containing a shape the retained-raw path does not
cover: an unrecognised part or entry type (observations 5, 6, 21), or a mutated
block, since an unmutated block short-circuits at `codec/opencode.rs:763-765`
and `codec/pi.rs:463-465` and is trivially identical.
Confidence: high —
[evidence](evidence/codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness.md).
Both goldens parsed at `HEAD`: `cases` has length 1 in each, with 10 OpenCode
messages and 11 Pi entries. `projection_oracle` reasons quoted in observation
20. The asymmetry between the two OpenCode encoders was verified:
`encode_opencode` passes `preserve_compaction: false` (`:289-290`) and
`encode_opencode_with_session` passes `true` (`:305-306`), which is why the
golden's oracle must strip compaction while the native-serving golden at
`codec/mod.rs:125` compares `&encoded[3..]` to the raw messages unstripped. The
four-to-three collapse was traced to `render_synthetic_todo_pair` (`:916-948`)
via `:388-399`.
Existing check: `codec/mod.rs:54-90` and `:177-213`, plus determinism
assertions at `:81`, `:87`, `:204`, `:210`. Genuine oracles, not tautologies:
they compare against an independently captured input array (`generated_from`
names a real `opencode.db` and real Pi JSONL session files), which is
materially stronger than the round-trip assertion Part 1 found at
`harness.rs:112-116` and characterised as "a tautology over accepted inputs"
(`part-1-shm-transport/catalog.md:1360-1361`). The weakness here is breadth and
oracle fidelity, not vacuity. Status `unaudited`.
Impact: one case per harness with a self-declared placeholder oracle is the
entire evidence base for the property the whole encoder design rests on. The
specific gap that matters is that the retained-raw path makes identity nearly
automatic for unmutated input, so the test's pass carries much less information
than its name implies.
Open questions:
- Should the exception set be declared in code rather than reconstructed in the
  test's own helpers (`codec/mod.rs:273-288`)? Today the encoder's compaction
  policy and the test's stripping helper are two independent statements of one
  rule.
- Can the `projection_oracle` TODO be discharged without vendoring the harness
  SDKs? If not, the goldens' status is permanent and should say so.

### codec-b-declared-missing-capture-classes-are-never-decoded

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — by construction. The classes are recorded as missing
precisely so that no case supplies them.
Guarantee: Every capture class the golden names as required is actually decoded
by at least one case, so the decode arm that handles it is executed.
Check: `reachable` — the decode arms at `codec/opencode.rs:171-181` (`subtask`)
and `codec/pi.rs:199-211` (redacted thinking) are executed at least once per
campaign. `reachable` and not `sometimes`, because the obligation here is
location coverage: the arms exist, are named as required, and are provably
never entered by the suite that claims to cover them.
Fault/timing angle: none.
Required faults and enabling state: one OpenCode message with a `subtask` part;
one Pi assistant entry with a `thinking` part carrying `redacted: true`.
Confidence: high —
[evidence](evidence/codec-b-declared-missing-capture-classes-are-never-decoded.md).
`codec/mod.rs:254-271` read at `HEAD`: the filter at `:262-266` retains a
required class only when it is absent from both `coverage` and
`recorded_missing`, so membership in `missing_capture_classes` satisfies the
assertion. Both golden files parsed: `opencode-golden.json` has
`missing_capture_classes: ["subtask"]` against a required list including
`"subtask"` (`codec/mod.rs:72`), and `pi-golden.json` has
`["redacted_thinking"]` against a required list including `"redacted_thinking"`
(`:187`). The two decode arms were read and confirmed to be the only handlers
for those shapes.
Existing check: the mechanism is the check, and it is the thing being reported.
`codec/mod.rs:267-270`'s message, "codec golden neither covers nor records
missing classes", is honest about what it enforces: it is a bookkeeping gate,
not a coverage gate. Status `unaudited`.
Impact: `subtask` decoding is on the default production path and untested; a
`subtask` part currently becomes an opaque block via `:171-181`, and if that
arm were deleted the part would fall to `:194-204` and still become an opaque
block, so the golden would not move. Pi's redacted-thinking arm is the one with
a behavioural difference to lose: `:199-211` produces
`CkKind::RedactedReasoning` while the non-redacted branch at `:212-217`
produces `CkKind::Reasoning` with a signature, and the two round-trip through
different encoder arms (`:543-548` versus `:536-542`).
Open questions:
- Is `missing_capture_classes` intended as a temporary ledger with an owner and
  a date, or as a permanent waiver? Nothing in `codec/mod.rs` or either golden
  says. (needs human input)

### codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given

Type: safety
Reachability: test-only
Status: active
Exercised: partial — `codec/pi.rs:1469-1484`
`deleted_tool_result_does_not_replay_the_retained_raw_entry` clears a
tool-result message's content and asserts `encode_pi(...).is_empty()`, which
pins the `:371` drop for the fully-cleared case. The same drop with content
that survives but holds no `ToolResult` is uncovered, the `:396-397` drop is
uncovered, and no test asserts what a caller should conclude from the shortened
array.
Guarantee: Either `encode_pi` returns one entry per input message, or the
positions it dropped are recoverable by the caller.
Check: `always` — `encode_pi(msgs, sidecar).len() == msgs.len()`, or the return
type carries the dropped indices. `always` because the `filter_map` runs on
every call.
Fault/timing angle: none. The composition risk is index drift: callers that
pair an encoded entry with the CK message at the same index are wrong after the
first drop, and the OpenCode encoder's parallel API returns
`EncodedOpencodeChunk` values carrying explicit `start_index` and `end_index`
(`codec/opencode.rs:343-348`) precisely so that its own collapse is index-safe.
Pi's has no equivalent.
Required faults and enabling state: for the `:371` drop, a message whose meta
role is `toolResult` but whose CK content holds no `ToolResult` block, which
the transform can produce by reducing a decoded tool-result message. For the
`:396-397` drop, a CK message with empty `content` whose matched meta's raw is
not a Pi message; this may be unreachable, since only `decode_opaque_entry`
produces such a raw and those messages carry exactly one opaque block.
Confidence: high —
[evidence](evidence/codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given.md).
`codec/pi.rs:128-137` read at `HEAD`: `filter_map` over `encode_with_meta`
(returns `Option<Value>`) and `encode_new_message` (returns `Value`, wrapped in
`Some` at `:134`). The two `None` returns are `:371`'s `find(...)?` and
`:396-397`'s explicit `return None`. Contrasted against
`codec/opencode.rs:428-433`, which pushes a chunk for every message
unconditionally, and against `EncodedOpencodeChunk` (`:343-348`), whose
`start_index`/`end_index` fields exist so `lib.rs:12949-12961` can splice by
position. Reachability label fixed by `rg` over `crates/` and `packages/`:
`encode_pi` appears only in `codec/pi.rs` and in `codec/mod.rs:208-209` and
`:249`, all inside `#[cfg(test)]`; 4e reached the same conclusion independently
at `part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378`.
Existing check: `codec/pi.rs:1469-1484`, which pins the cleared-content drop.
Status `unaudited`.
Impact: today, none, because there is no production caller. The record exists
because the function is a public export (`codec/mod.rs:10`, `lib.rs:12`) whose
contract differs from its OpenCode twin in a way a future caller would not
expect, and because 4e's lens item 18 already notes the Pi encode path is
off-route, which makes this the moment to write the contract down rather than
after it is wired up.
Open questions:
- Should `encode_pi` adopt the `EncodedOpencodeChunk` shape so index mapping is
  explicit? Unresolved, needs a decision about whether the Pi leg is being
  wired up at all.

## Relationship map

Grouped by shared mechanism rather than by the group headings above, because the
mechanism is what decides whether one check can stand in for another. Every
dominance statement is a hypothesis offered to guide ordering, not a verified
claim; none of these records has an executing check.

- **One document, one resolver, and every way they disagree.**
  [dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1](#dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1),
  [dec-a-memory-injection-budget-documented-range-has-no-implementing-code](#dec-a-memory-injection-budget-documented-range-has-no-implementing-code),
  [dec-a-commit-cluster-trigger-config-is-inert-in-this-crate](#dec-a-commit-cluster-trigger-config-is-inert-in-this-crate),
  [dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller](#dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller),
  [dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list](#dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list).
  Five instances of one absent artifact: nothing in the tree compares the resolved
  config against `CONFIGURATION.md`. Hypothesis: a single table-driven conformance
  check, one row per leaf carrying documented default, documented bound, expected
  tier policy and expected warning, *dominates all five and is cheaper than any one
  of them*, because each record's oracle is already a row in the table above. What
  it would not cover is the clamp record's second half, that the caller is never
  told, since that is a property of the response rather than of the resolved value.
- **The chain that spends the money.**
  [dec-a-model-key-lookup-walk-has-two-implementations-that-disagree](#dec-a-model-key-lookup-walk-has-two-implementations-that-disagree),
  [dec-a-model-chain-dedup-is-adjacent-only](#dec-a-model-chain-dedup-is-adjacent-only),
  [dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian](#dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian).
  The three ways the historian's model chain can be wrong: found by the wrong walk,
  deduplicated too weakly, or empty because the file did not parse and the error was
  discarded. Hypothesis: no dominance, because the oracles differ in kind, but they
  compose into the sharpest scenario in the part. A malformed config yields an empty
  chain and a `no_fire: "no_models"` verdict that reads as a healthy decision, so
  the operator-visible signal for a broken file is identical to the signal for a
  deliberately disabled historian. That composition is worth one integration test on
  its own.
- **Guards that hold, recorded so a later change is visible.**
  [dec-a-cache-ttl-parse-is-total-over-arbitrary-strings](#dec-a-cache-ttl-parse-is-total-over-arbitrary-strings),
  [dec-a-boundary-budget-derivation-is-total-over-non-finite-input](#dec-a-boundary-budget-derivation-is-total-over-non-finite-input),
  [dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes](#dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes),
  [dec-a-escalation-bands-stay-ordered-for-every-threshold](#dec-a-escalation-bands-stay-ordered-for-every-threshold),
  [dec-a-selection-decision-order-is-total-under-hashmap-iteration](#dec-a-selection-decision-order-is-total-under-hashmap-iteration).
  The cheapest cluster in the part by a wide margin: five pure-function properties
  over an input domain, no faults, no interleavings, and four of them expressible as
  a property test in a few lines. Hypothesis: none dominates another, and their value
  is not defect-finding but boundary-fixing, since Part 3's analogous unit failed
  exactly here. The one live hazard sits inside the first: a `cache_ttl` of `"0"`
  parses to 0 ms and forces execution every pass, so the totality record and the
  configuration cluster meet on one key.
- **The two doors in the guard wall, and they are different shapes.**
  [dec-a-region-hint-clamp-bypassed-by-sentinel-suffix](#dec-a-region-hint-clamp-bypassed-by-sentinel-suffix),
  [dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic](#dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic).
  This cluster was one record and is now two, and pairing them is what makes the
  pattern legible. The region-hint clamp is a guard that *is* a door: the same
  idempotence property that makes it safe to re-apply is what lets a value carrying
  the sentinel through unclamped, so the defect is inside a correct-looking
  mechanism. The `trigger_budget` passthrough is the opposite shape: it is a door
  where the wall simply stops. Three neighbouring fields on the same struct are
  `is_finite`-gated and this one is not, so there is no clever mechanism to
  misunderstand, just a missing gate at `boundary.rs:377-379` and again at
  `:756-761`. Hypothesis: no dominance between them, and neither belongs in the
  guards cluster above, because a property test over the guarded domain passes
  while both defects stand. The trigger-budget one is additionally the cheapest
  falsifying oracle in the whole part — one struct literal and one call — and it
  fails today, which the guards cluster's oracles by definition do not.
- **What the decoder accepts, and who never learns.**
  [codec-b-harness-decoders-accept-every-input-with-no-rejection-channel](#codec-b-harness-decoders-accept-every-input-with-no-rejection-channel),
  [codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record](#codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record),
  [codec-b-opencode-hides-four-part-types-from-every-transform-decision](#codec-b-opencode-hides-four-part-types-from-every-transform-decision),
  [codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only](#codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only).
  Hypothesis: the no-rejection-channel record *dominates the other three as a
  framing* and none of them as a check, because each names a different disposal.
  Pi discards bytes, OpenCode retains bytes and hides the decision, and provenance
  recovery either works wholly or not at all on one harness. The pairing that matters
  for a reviewer is Pi against OpenCode on the same input class: two codecs in one
  crate hold opposite policies for the same situation, and the CK layer's stated
  contract endorses only one of them.
- **Two stages, one unchecked precondition.**
  [codec-b-decoder-output-can-violate-the-projector-precondition](#codec-b-decoder-output-can-violate-the-projector-precondition),
  [codec-b-absolute-ordinal-is-harness-supplied-and-never-validated](#codec-b-absolute-ordinal-is-harness-supplied-and-never-validated),
  [codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity](#codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity).
  All three are properties of the seam rather than of either side, and all three
  route through `codec/sidecar.rs`, which has no tests. Hypothesis: the projector
  precondition record *hypothetically dominates* the ordinal record, because a
  composition check that decodes then projects and asserts the projector accepted
  would also catch an ordinal the projector rejects; it does not dominate the
  identity record, because a caller-written stamp with a fingerprint that ignores
  retained bytes is accepted by the projector by construction.
- **The profile decides whether the guard exists.**
  [codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert](#codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert),
  [codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour](#codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour).
  The cross-part tie is the point of this cluster: 4e's
  `enforce_unique_tool_use_ids` has two arms and two tests, and this part's
  encode-side counterpart has one arm and one debug-gated test, so the same
  invariant is defended on the render side and abandoned on the encode side.
  Hypothesis: neither dominates the other, and both are blocked on the same
  unresolved question, which build profile the distributed artifact uses. Until that
  is answered every record in this cluster has two readings.
- **Agreement of the code with itself.**
  [codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness](#codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness),
  [codec-b-declared-missing-capture-classes-are-never-decoded](#codec-b-declared-missing-capture-classes-are-never-decoded),
  [codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given](#codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given).
  Hypothesis: the round-trip record *hypothetically dominates* the shorter-array
  record, because a strengthened round trip over generated inputs would catch a
  `filter_map` that drops a message, and it dominates neither of the others: the
  declared-missing record is about a gate that is designed to pass, which no
  strengthening of the existing oracle reaches. The cluster's shared cause is one
  design choice, that the expected value in both goldens is a transformation of the
  test's own input, so the suite cannot distinguish a decode error the encoder
  symmetrically reverses.

### Cross-part relationships

Three ties are strong enough to state, and one of them answers a sibling's open
question.

**4e asked whether one CK message can carry a full-drop tool block followed by two
or more taggable blocks, and left it to 4f.** This catalog does not resolve it. The
OpenCode decoder collapses a CK tool call plus its result into one native part and
hides four part types from `content`, so the shape of a decoded message is decided
by `codec/opencode.rs:193` and `:194-204` rather than by anything 4e can see. What
is established here is narrower and still useful to 4e: because the four hidden
types never enter `content`, they cannot be the taggable blocks 4e's index-shift
record needs, so the question reduces to whether two *retained* taggable blocks can
follow a full-drop tool block in one message. Recorded as unresolved on both sides
rather than answered.

**The release-profile question is one question across three sub-parts.** 4e's
duplicate-id belt, this part's encode-side uniqueness guard, and this part's sidecar
slice all behave differently under `debug_assertions`, and all three are blocked on
the same fact: CI builds without `--release` (`ci.yml:169` at `HEAD`), so the
artifact CI produces selects the debug arm, and whether the distributed
`ck-mc-host` matches is unresolved and needs the release pipeline. Any conformance
work on either sub-part should answer it once.

**The parity-claim shape recurs.** 4a found five in-crate tests asserting
TypeScript parity by construction with nothing executing the comparison, and 4e
found a frozen shared fixture whose provenance guard lives only in the leg CI does
not run. This part's register is the same shape at larger scale: 8 of its 13
`NOT FOUND` claims are cross-implementation parity claims whose oracle lives in
TypeScript and is never read. The three findings are one architectural fact rather
than three defects, and it is the strongest argument in the project for a single
cross-language conformance lane.
