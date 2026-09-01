# Part 4f fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 through 4e: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window; rare branches need
deterministic injection to be reachable at all; and coverage checks assert
independent preconditions, never the violation.

Provenance as in [existing-checks.md](existing-checks.md). `HEAD` is `e447c927`.
The one CI step that matters moved across `76cd6f41..HEAD`:
`cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at `76cd6f41` and
`ci.yml:172` at `HEAD`, and the build-only step above it is `:165` and `:169`
respectively. All four were verified directly and both pairs are cited wherever
the steps appear.

Five framing points specific to this part.

**First, this is the cheapest part in the catalog so far, and the reason is
structural rather than lucky.** 4f is made of pure decision units and two pure
decoders. `boundary.rs:5-9`, `selection.rs:4-7` and `scheduler.rs:1-4` all claim
no I/O, no clock, no store and no ambient state, and the check inventory confirmed
those claims structurally. Both decoders are pure functions over one immutable
input array (`codec/opencode.rs:23-25`, `codec/pi.rs:19-21`). **So most of this
part needs no harness at all: a struct literal, a JSON string, or a
`Vec<serde_json::Value>` is the entire enabling state.** There is no clock to
pause, no second process to spawn, no store to corrupt, and no two-pass sequence
to arrange. Contrast 4e, where eleven of 24 records needed seeded frozen units and
three needed a second render.

**Second, the binding constraint is therefore not a fault. It is `F0`.** None of
the 192 in-crate checks runs in CI, and unlike 4b and 4d there is not even an
integration binary that reaches this scope: all seven have zero 4f content. Every
capability below is cheap, and every one of them adds tests to a suite no
automation executes.

**Third, one capability is a build flag rather than a fault, and in this part it
buys less than it did in 4e.** All three 4f assertion sites are `debug_assert!`
(`codec/opencode.rs:251`, `:252`, `:466`) and **no `cfg(not(debug_assertions))`
exists anywhere in 4f**, verified across all eleven files. So unlike 4e's
two-armed belt there is no release arm whose distinct behaviour a release run
observes. What `F4` buys instead is the *absence*: that `:466` enforces nothing,
that `:252`'s violation is silent because `take` at `:265` saturates, and that
`:251`'s is not silent because the slice at `:258` panics on the same condition in
every profile.

**Fourth, the sharpest single item on this list is free, is documented, and is not
a fault at all.** `CONFIGURATION.md:763` states that with `smart_drops` off "the
messages sent to the model are byte-identical to the age-based-only behavior" and
that "the entire feature is inert". The flag is one boolean, defaulting `false` at
`config.rs:135` and set from either tier at `:467-469` and `:541-543`. That is a
whole-pipeline byte-equality oracle obtainable by flipping one field and running
twice, and **nothing takes it** (`lens-c1-claims-and-config.md:488-498`, register
entry C1-30). It is ranked second below only because `F0` governs whether any test
runs at all.

**Fifth, this part has no `sometimes` and no liveness record, which changes what
the coverage-check section has to do.** The 27 records are 26 `safety` and one
`reachability`; the catalog's own header already reports the semantics finding on
that single `reachable` record and declines to apply it. So there is no
`sometimes` marker to audit for the forbidden pairing, and every marker proposed
below is new. **The zero-liveness position was challenged by an independent
evaluation and upheld**, on the ground that `scheduler::decide` is an immediate
pure transition with no progress obligation to bound and the paging loop that
would carry one belongs to another sub-part; the reasoning is in
[portfolio-evaluation.md](portfolio-evaluation.md) and is recorded there rather
than here because it is a verdict on this file's framing, not a fact about a
fault class. The forbidden pairing is still the dominant hazard here, because in
this part the defect is almost always easier to name than its precondition.

## Fault classes required

`F0` is listed first because it is not a fault. It is a workflow change, and it
governs what every other class on this list can prove.

| Class | Description | Available today |
| --- | --- | --- |
| **F0** test execution in CI | Any workflow job that builds and runs `mc-module --lib` | **No.** Verified across all five files in `.github/workflows/`. The only `mc-module` test invocation is `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`), which selects one integration binary and does not build `--lib`, so none of the 192 in-crate checks compiles. The step above it is build-only (`:165` / `:169`). There is no `--lib`, no `nextest -p mc-module`, and no `--workspace` Rust test job. `scripts/test-rust.sh` (`cargo nextest run --workspace`) is wired into root `package.json` as `test:rust` and no workflow calls it. There is no integration binary to fall back on: all seven under `crates/mc-module/tests/` have zero 4f content, and `release_contract_conformance.rs` reaches no 4f file even if it ran. Cost: a workflow change and no new infrastructure |
| **F1** arbitrary input to each decoder | A `Vec<serde_json::Value>` of arbitrary shape handed to `decode_opencode` or `decode_pi` | **Yes, and it needs no fault. This is the cheapest capability in the part.** Both decoders return `DecodedHarnessMessages` with **no error type at all** (`codec/opencode.rs:23-25`, `codec/pi.rs:19-21`), so totality is free and the interesting question inverts from "does it reject" to "what does it silently accept". An arbitrary `Vec<Value>` is the whole enabling state; the interesting members are a bare string or number as an array element, a `parts` value that is an object rather than an array, and a part whose `type` is absent. The only decoder inputs anywhere today are the two goldens' single cases plus well-formed hand-built fixtures across `codec/opencode.rs:1322-2186` (17 tests) and `codec/pi.rs:1078-1499` (14 tests) |
| **F2** configuration values at and beyond documented bounds | A user or project `magic-context.jsonc` carrying a leaf outside the range `CONFIGURATION.md` documents | **Yes, and it needs no fault. This is the widest single capability in the part.** One config fixture resolved through `merge_tiers_with_warnings` makes **five** records non-vacuous. The interesting values are all named in the records and all accepted by the parser today: `execute_threshold_percentage: 5` (documented floor `20`, enforced floor `1` at `config.rs:568-570`), `memory.injection_budget_tokens` above `20000` or below `500` (documented range `CONFIGURATION.md:591`, enforced `.max(1.0)` only at `config.rs:442` and `:527`), `memory.auto_search.score_threshold: 0.99`, `memory.auto_search.min_prompt_chars: 0`, `caveman_text_compression.min_chars: 50`, a project-tier `smart_drops: true` (accepted at `config.rs:541-543`), and `historian.module_model: "a"` with `module_fallback_models: ["b", "a"]` for the non-adjacent dedup. The oracle in every case is the resolved struct plus the returned warning vector, both of which the merge path always produces |
| **F3** a malformed configuration file | A `magic-context.jsonc` whose syntax error survives `strip_jsonc`, for example an unterminated string | **Yes, and it needs no fault beyond writing one bad file.** The path is `fs::read_to_string` succeeding and `serde_json::from_str` failing, which the resolution absorbs into defaults. `config.rs:1191-1229` already covers the mtime cache, so the fixture scaffolding for writing a config file and resolving it exists; only the malformed content is new. The oracle is the presence of a warning naming the path, and the observable consequence is a `no_models` no-fire reason that points at model configuration rather than at a parse failure |
| **F4** building and running in release | The same suite compiled with `debug_assertions` off | **Yes, and it is a build flag rather than a fault, but it buys less here than in 4e.** `cargo test -p mc-module --lib --release` drops all three `debug_assert` sites (`codec/opencode.rs:251`, `:252`, `:466`) and stops compiling the one test gated `#[cfg(debug_assertions)]` at `:2077`. **Verified: no `cfg(not(debug_assertions))` exists anywhere in 4f**, so unlike 4e there is no release arm with distinct behaviour to execute. What `F4` establishes is three absences: `:466` enforces nothing while `duplicate_tool_use_locations` at `:465` still runs and its result is discarded; `:252`'s violation is silent because `take` at `:265` saturates; and `:251`'s violation is **not** silent, because `&messages[replace_from..]` at `:258` panics on the same condition in every profile. Cost: one extra invocation |
| **F5** harness input carrying unknown or omitted types | One session entry or message part whose `type` the decoder does not recognise, or a required class the goldens omit | **Yes, and it needs no fault.** One hand-built element. Pi: an entry with an unrecognised `type` and no `role` key, for example `{"type": "tool_use_v2", "data": {}}`, or the degenerate `{"type": "message"}` with no `message` key, which the decode loop drops from `decoded` and from the sidecar alike (`codec/pi.rs:41-50`, `:661-669`, `:681-686`). OpenCode: a part in `{snapshot, patch, agent, retry}`, which is preserved as raw for re-encode (`codec/opencode.rs:194-204`) and omitted from `content` (`:193`). Plus the two classes the goldens declare missing: an OpenCode `subtask` part and a Pi assistant `thinking` part carrying `redacted: true`. Verified at `HEAD` that `opencode-golden.json` covers 11 of 12 required classes with `subtask` declared missing, and `pi-golden.json` covers 12 of 13 with `redacted_thinking` declared missing, and that `assert_coverage_or_recorded_missing` (`codec/mod.rs:254-271`) passes on both |
| **F6** caller-supplied block identity | A CK ingress block whose `provider_extras` already carries a `_cortexkit_codec` stamp the decoder did not write, or two byte-identical native parts in one message | **Yes, and it needs no fault.** `TransformRequest.messages` is `Vec<CkIngressMessage>` (`transform.rs:781`) and `CkWireBlock`'s `Deserialize` (`mc-store/src/lib.rs:207-221`) reads `provider_extras` verbatim, so a caller can supply plausible `blockIndex`, `nativeIndex` and `decodedFingerprint` values under the string key `_cortexkit_codec` (`codec/sidecar.rs:131`). `stamped_block_identity` (`:177-183`) returns `Some` for any three well-formed values, and `stamp_block_identity` (`:158-175`) is the only writer **by convention, not by encapsulation**. The collision half needs only one OpenCode message with two byte-identical parts. The file has zero tests, so both halves are unexercised in either direction |
| **F7** cross-implementation differential | The same fixed inputs run through two implementations, or through one implementation with a documented-inert feature on and off | **Split, and the two halves differ by an order of magnitude in cost.** The **in-Rust half is free and is the highest-value item in the part**: `CONFIGURATION.md:763` promises byte-identical output with `smart_drops` off, and the flag is one boolean (`config.rs:135`, `:467-469`, `:541-543`), so a flag-off run against a pre-feature run is a whole-pipeline byte-equality oracle. Nothing takes it. The **cross-language half does not exist as an executable comparison.** `PARITY.md:13-15` states the master parity claim, and the register records it as `NOT FOUND` as an oracle inside `mc-module`: the two decoders are structurally independent and produce the same type (`codec/sidecar.rs:28`), so the comparison is cheap and is not made. Eight of the thirteen `NOT FOUND` claims are cross-implementation parity claims whose oracle lives in TypeScript and is never read from this crate. The one two-legged fixture, `cache-ttl-routing-vectors.json` (5 cases), is gated only on its TypeScript leg (`prompt-surface.test.ts:105` via `ci.yml:257`); the Rust leg (`config.rs:760`) runs nowhere |

Three availability caveats that cut across classes.

- **`F2`'s and `F3`'s enabling state is a file, and `config.rs` is the one impure
  unit in the part.** `ConfigCache` reads the filesystem and caches on mtime
  (`config.rs:254-266`), so a config fixture must control the mtime as well as the
  content. `config.rs:1191-1229` already does this, so the pattern exists.
- **`F6`'s trust half proves the module's behaviour on a hand-built ingress
  message without establishing that a production route supplies one.** Whether a
  non-module actor can choose `provider_extras` on a production route is a route
  question this pass cannot answer, and it is the same shape as 4e's open question
  about who can choose a tool-call id.
- **Two records are `test-only` by their own reachability label**, and that is
  orthogonal to non-vacuity. `codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record`
  and `codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given` are both
  constructible today and neither has a production caller on the Pi encode path.

## Map

All 27 records, grouped as the catalog groups them, meaning by the thing a single
test fixture would have to build. "Non-vacuous today" means a developer can
construct the required state with the current harness. It does **not** mean the
check runs anywhere; under `F0` none of them do.

One reachability precondition is stated once rather than per row. No decision unit
or codec in scope sits behind a Cargo feature gate, no unit in scope reads a clock
or a store, and the only profile-dependent code in the part is the three
`debug_assert` sites in `codec/opencode.rs`. The `explicit-config-only` records are
exactly the eight the catalog labels so.

### Group A: the configuration contract as a defect surface

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1 | A user or project `magic-context.jsonc` containing `execute_threshold_percentage` below `20`, for example `5` (F2) | **Yes, and it is one of the five records F2 unblocks on one fixture.** One resolution. The clamp is verified at `config.rs:568-570`, `.clamp(1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE)` with the ceiling `90.0` at `:28`, against a documented range of `20-90` (`CONFIGURATION.md:167`). The existing check covers the **upper** bound only: `project_threshold_may_only_raise` (`config.rs:829-835`). The oracle is the resolved value plus the warning vector, and the record adopts 4b's queued gap `portfolio-evaluation.md:390` (G4) |
| dec-a-memory-injection-budget-documented-range-has-no-implementing-code | A project `.cortexkit/magic-context.jsonc` with `memory.injection_budget_tokens` above `20000`, or below `500` (F2) | **Yes.** Same fixture. Three assignment sites apply `.max(1.0)` and nothing else (`config.rs:442`, `:444`, `:527`) against a documented range of `500-20000` (`CONFIGURATION.md:591`). The nearest existing check proves the *user-profile* budget is user-tier-only (`config.rs:876-911`), which by contrast confirms the injection budget is deliberately project-writable. **The consequence composes with 4b's frozen `m0`**: an unbounded trim budget inflates a baseline every subsequent pass replays verbatim |
| dec-a-commit-cluster-trigger-config-is-inert-in-this-crate | **A non-default `commit_cluster_trigger` value, plus a trigger workload.** Neither alone. This cell previously read "None for the divergence itself; it holds on a default build", which is the claim a disposition pass retired | **Partial, and the wiring half is not the free win this row claimed.** The check is that the `TriggerContext` built at `lib.rs:4962-4963` carries the configured values. This row previously said "today it carries the hardwired `DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED` (`lib.rs:605`) and `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:607`), so the assertion fails with no fault at all". **It does not fail at defaults, because the documented defaults *are* those constants**: `CONFIGURATION.md:237-238` gives `true` and `3`, and the constants are `true` and `3`, both printed and confirmed. A context built from the constants satisfies "carries the configured value" whenever the configuration is default, so the assertion needs a non-default value to have any content. Set `min_clusters` to `2` — the value `lib.rs:16500-16501` already uses — and assert on the constructed context; that is the cheap half and it is not free. The behavioural half additionally needs a tail with at least the configured cluster count and one `trigger_budget` of tokens. Note the call site is 4b/4c code reading a 4f contract, so the assertion crosses a sub-part boundary. `boundary.rs:2226-2227` pins the constant against a golden value, which pins the default and not the configurability |
| dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list | A project `.cortexkit/magic-context.jsonc` setting `smart_drops: true`, accepted at `config.rs:541-543` (F2) | **Yes.** Same fixture. `warn_ignored_project_key` (`config.rs:575-581`) is called for **six** pointers only (`:520`, `:538`, `:539`, `:540`, `:556`, `:561`), and `config.rs:913-928` and `:1096-1117` prove specific keys are user-tier-only. Neither establishes that the remaining project-writable set is the documented one, which is what the check asserts. The consequence is concrete: `CONFIGURATION.md:767` describes `smart_drops` as intentionally off "while cache stability is being validated in the wild", and a repository can turn it on |
| dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller | A config with `memory.auto_search.score_threshold: 0.99`, `memory.auto_search.min_prompt_chars: 0`, or `caveman_text_compression.min_chars: 50` (F2) | **Yes, and the oracle is a comparison the merge path already materialises.** For every resolution where an input leaf differs from the resolved leaf, the warning vector should name that leaf; today no clamp reports itself. All three clamps verified: `clamp(0.3, 0.95)` at `config.rs:591`, `clamp(5, 500)` at `:595` with a `0` silently discarded by `positive_usize_at` (`:623-629`), and `clamp(100, 10_000)` at `:607`. **`min_prompt_chars: 0`, the natural spelling of "hint on every prompt", silently becomes `20`** |
| dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian | A user `magic-context.jsonc` with a syntax error `strip_jsonc` does not repair, for example an unterminated string (F3) | **Partial, and the fault is free while the record's original oracle was impossible.** Producing the state is the cheapest thing outside Group C: one bad file and one `effective_config` call, and `config.rs:1181` already covers JSONC stripping and `:1191` the mtime cache, so only the malformed content is new. **But the check as written asked for a warning naming the path, and no channel exists to carry one.** `read_tier_cached` (`config.rs:254-266`) is `fn(&mut TierConfig, PathBuf) -> Option<Value>`: no warnings sink, no `Result`, and `:261-264` collapses both the read error and the parse error to `None`. By the time `merge_tiers_with_warnings` builds its warning vector, an unparseable file and an absent file are the same `None`. And `emit_warnings` (`:275-279`) only `eprintln!`s, which a sibling record already flags as possibly discarded under the daemon host. The record now asserts the observable consequence instead — the resolved config equals `McModuleConfig::default()`, which it does, so the assertion fails on the current build — plus a static enumeration of the signature. The observable surface today is a `no_models` no-fire reason, which points a reader at model configuration rather than at a parse failure. There is a separate same-mtime window the record names, and it is not needed for the primary check |

### Group B: model-chain resolution

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| dec-a-model-key-lookup-walk-has-two-implementations-that-disagree | A per-model map keyed only by a `provider/*` wildcard. On the `cache_ttl` side it resolves; on the scheduler side it falls to `default`. Reaching the scheduler side **from production** additionally needs `ExecuteThresholdConfig::ByModel`, which no code in this crate constructs | **Yes for the differential; the production consequence is latent, and the two must not be conflated.** The check is a pure differential over two in-crate functions, `config.rs`'s walk at `:176-200` and `scheduler::model_key_lookup_order`, and a wildcard-keyed map discriminates them. That test is writable today with no fault. What it cannot show is a live divergence, because `number_at` (`config.rs:631-637`) returns `None` for a JSON object so the execute-threshold map is never consulted (4b's `sel-per-model-and-token-thresholds-inert-in-module`). `config.rs:760-785` pins **one** implementation against the shared TypeScript vectors; **no differential between the two Rust implementations exists** |
| dec-a-model-chain-dedup-is-adjacent-only | A user config with `historian.module_model: "a"` and `historian.module_fallback_models: ["b", "a"]` (F2) | **Yes.** One resolution. `dedup()` at `config.rs:571` removes adjacent repeats only, so the chain `[a, b, a]` survives intact. No existing check. The reason the author cares is stated in the code: `config.rs:384-389` says a wrong chain "would burn permanent-classified advances every fire", so the consequence is a duplicated model attempted twice in one firing |

### Group C: totality, determinism, and the one clamp with a bypass

These six are the cheapest records in the catalog. Every one is a direct call on a
pure function with a hand-written argument, and **four of them are guards that
hold rather than defects**, which is why they are recorded: they fix the boundary
so a later change that drops a guard is visible.

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| dec-a-cache-ttl-parse-is-total-over-arbitrary-strings | A `cache_ttl` string. `"0"`, `"5S"`, `"99999999999999999999h"` and `"5\u{20ac}"` are the interesting inputs, all accepted by `config.rs:486-491` as non-empty trimmed strings. No fault | **Yes, and it is the single cheapest oracle in the part.** One function call per input. `scheduler.rs:1417-1424` `parse_cache_ttl_never_returns_u64_max` and `:1427-1435` `never_ttl_predicates_are_always_false` already exist. **The finding is that the parse is sound and the hazard is downstream**: `"0"` parses to 0 ms and forces execution every pass, which no documentation mentions, and any unparseable string is swallowed into the `5m` default by `scheduler_ttl_ms` (`:810-812`) with no report |
| dec-a-boundary-budget-derivation-is-total-over-non-finite-input | A `BoundaryContext` whose `context_limit`, `execute_threshold_percentage` or `usage_percentage` is `f64::INFINITY` or `f64::NAN`. No fault | **Yes by direct call; production reachability is a separate and narrower question.** A struct literal with `f64::NAN` is the whole enabling state, and no test targets non-finite input today. Reaching it *from production* needs a host-supplied usage reading, since `lib.rs:4950-4959` builds the context from request and store values. **This is the guarded analogue of Part 3's decay totality defect and, over the three fields it validates, the guard holds**: `boundary.rs:339-341` returns `TRIGGER_BUDGET_MIN` for non-finite and non-positive input, which `CONFIGURATION.md:238` does not mention. The `trigger_budget` passthrough that this cell used to fold in as "the one place a caller could still inject a non-finite value" is no longer part of this record; it is the row below |
| dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic | A `BoundaryContext` with `trigger_budget: Some(f64::NAN)` and a non-empty message set. No fault | **Yes, and it is the cheapest falsifying oracle in the part.** One struct literal and one call: `BoundaryContext.trigger_budget` is a `pub` field and both read sites are reachable in-crate. `boundary.rs:377-379` and `:756-761` read it through `unwrap_or_else` with no `is_finite` gate on the `Some` arm, unlike the three neighbouring fields. `derive_protected_tail_token_target`'s own postcondition survives, because `f64::min` at `:383` returns the non-NaN operand and `n` stays finite, but `:399` stores the raw NaN into the returned struct and `:802`'s `tail_size_bar: trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER` is a bare multiply with nothing to absorb it. So `TriggerProgress.tail_size_bar` is NaN, and that struct is carried into the transform response at `lib.rs:4982` and divided at `:5002`. **Unlike every other row in this table, this oracle fails on the current build**, and the evidence was already written: the budget record's evidence file lists this exact case as test-plan item 4 and states it fails today |
| dec-a-derive-historian-chunk-tokens-is-total-at-both-integer-extremes | `historian.context_limit_tokens` at an extreme. **A configured `0` is impossible**, because `positive_usize_at` (`config.rs:623-629`) discards it, so reaching the extremes needs a very large configured limit or a direct call | **Yes by direct call.** `config.rs:972-978` `historian_budget_derivation_clamps_at_both_bounds` already covers `1`, `32_000` and `128_000`. The value of the record is as the paired positive result to the Part 3 defect class: the rounding-then-clamp order cannot produce a value outside `[8000, 50000]`, and the saturating cast degrades an absurd configured limit to the documented maximum rather than wrapping to a tiny budget |
| dec-a-escalation-bands-stay-ordered-for-every-threshold | **None.** A threshold of `f64::NAN`, a negative threshold, or a threshold above `90` are the interesting inputs | **Yes.** One call per threshold. `scheduler.rs:1238` and the golden constant assertions at `boundary.rs:2226-2227` are the existing checks. The consequence the record pins is precise: if a threshold could push the force band to or past `95`, the `Force85` arm at `scheduler.rs:525` would become unreachable and the emergency arm would absorb the whole force band, changing which passes bypass mid-turn deferral. The cap makes that impossible |
| dec-a-selection-decision-order-is-total-under-hashmap-iteration | **None for the property.** Refuting it needs an input where one `target_id` receives two same-rank decisions with different payloads, which requires duplicate `SelItem` ids mapped to different `arc_id`s | **Yes, and the cheap form is a repeat-call equality plus a postcondition scan.** Both conjuncts are directly assertable: repeated calls on identical inputs return equal `Vec<ReductionDecision>`, and no two distinct arcs emit a decision for the same `target_id`. `selection.rs:2836` `drop_wins_over_edit_marker` plus the differential golden `selection.rs:32-33` names as the arbiter are the existing checks. **The cross-process form is also cheap** (two `cargo test` invocations give two `HashMap` seeds) and is the form that would catch a genuine iteration-order dependence, since both hash-iterating loops (`selection.rs:1305`, `:1397-1405`) are made order-insensitive downstream today. The header stakes the cache invariant on this: if it fails, a defer pass replays different bytes than the freeze produced |
| dec-a-region-hint-clamp-bypassed-by-sentinel-suffix | `smart_drops: true`, off by default (`config.rs:135`, `CONFIGURATION.md:752`), plus an `edit` or `write` tool call superseded by a later edit to the same file whose `oldString`, `newString` or `content` value **ends with the literal `...[truncated]`** (F2 for the flag) | **Yes, and no adversary is required.** One config flip and one fixture. `selection.rs:2537-2549` `edit_marker_region_hint_caps_utf16_and_backs_off_split_surrogate` covers the other two arms of `region_hint` and not this one. The bypass is the idempotence guard doing double duty: a value that already ends with the sentinel is returned unclamped, so a superseded edit keeps its full diff instead of a 40-unit hint. **The content is harness-supplied, so a file whose text legitimately ends with that marker is enough**, and the accounting believes the reduction reclaimed something it did not |

### Group D: decoder acceptance with no rejection channel

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| codec-b-harness-decoders-accept-every-input-with-no-rejection-channel | **None.** An arbitrary `Vec<Value>` is the whole enabling state (F1). The interesting members are a bare string or number as an array element, a `parts` value that is an object rather than an array, and a part whose `type` is absent | **Partial: the return and consistency clauses are the cheapest codec oracle in the part; the allocation clause is not observable at all.** One call per input for the first two clauses. The third clause, "allocation is bounded by a constant multiple of input size", cannot be witnessed by a decode call: both decoders return `DecodedHarnessMessages` and expose no allocation accounting, so proving a multiple of input size needs a counting `#[global_allocator]`, a `dhat`-style profiler, or a `Vec::capacity` sweep over the returned structure, and the tree has none of the three. That clause is discharged by reading — the largest allocations are `raw_message.clone()` at `codec/opencode.rs:232` and `raw_entry.clone()` at `codec/pi.rs:114`, one per input message — and must not be counted as an oracle a call satisfies. `codec/mod.rs:78-89` and `:201-212` assert decode determinism over the goldens, which pins purity and not totality; all 31 hand-built decoder tests use well-formed fixtures. **This record differs from Part 1's equivalent in a way worth carrying**: Part 1's `decoder-totality-over-arbitrary-bytes` could say the property holds and is under-evidenced, whereas this one **is violated by design**, because there is no error variant to fall back on. The failure mode is not a crash but a fabricated message: a malformed element becomes a zero-block `"user"` message that occupies an ordinal, enters the sidecar, participates in boundary selection, and is re-encoded from its retained raw |
| codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record | One Pi session entry with an unrecognised `type` and no `role` key, for example `{"type": "tool_use_v2", "data": {}}`, or the degenerate `{"type": "message"}` with no `message` key (F5) | **Yes.** One hand-built entry. No golden case and no unit test supplies one: `codec/pi.rs:1078-1499` has 14 tests, and `:1479-1483` asserts `encode_pi(...).is_empty()` for an empty-content message, which is the encoder half of a different drop. The check is that every input entry is recoverable either from a `CkIngressMessage`'s meta or from `sidecar.messages`; today the entry is dropped from both (`codec/pi.rs:41-50`, `:661-669`, `:681-686`). **The unrecoverable consequence is the ordinal shift**: every later entry moves down by one, so a persisted boundary ordinal or a tag keyed to an ordinal now names a different message, and because Pi has no `absolute_ordinal` input there is no way for the harness to pin the numbering against it |
| codec-b-opencode-hides-four-part-types-from-every-transform-decision | **None for the preservation direction**; one OpenCode message carrying any of `{snapshot, patch, agent, retry}` suffices (F5). For the interesting composition, that message must **also** have a decoded block deleted, so `remove_unretained_native_parts` runs with a non-empty removal set | **Yes for both halves.** The golden already supplies one `patch` part, so the preservation direction is pinned **by accident rather than by design**: `codec/mod.rs:59-76` lists `patch` as a required coverage class and the round trip covers it. `codec/mod.rs:216-252` `codec_conformance_removes_leading_native_blocks_without_reindex_drift` exercises the removal path but on a message with no immune parts, so the composition of the two is what is missing and it is one fixture away. **Correct today and fragile in one direction**: these four types are invisible to the CK view, so the transform's byte accounting, tag numbering and boundary selection never see them while the provider does |
| codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only | For the mixed-parts hole, one OpenCode message with one synthetic part and one authored part. For the role hole, a synthetic assistant or tool message that is not the todo pair. **For Pi, any input at all** (F5) | **Yes, and the Pi half needs literally nothing.** `codec/mod.rs:128-175` covers the all-synthetic path and `:290-298` asserts `message["meta"]["synthetic"] == true` on the native fixtures; **neither covers a mixed message**. The consequence is that the module's own writes can come back classified as user-authored, and `meta.synthetic` gates `meta_for_ck`'s positional fallback (`codec/sidecar.rs:324-328`), so a misclassified module-authored message becomes eligible to inherit a native envelope by position. **Pi's hardcoded `false` means the Pi leg has no provenance in either direction**, which composes with 4e's finding to leave synthetic content indistinguishable from authentic content for that harness at every layer |

### Group E: cross-stage composition and block identity

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| codec-b-decoder-output-can-violate-the-projector-precondition | Two independent shapes, both harness-controlled. One OpenCode message with `info.id` containing `#`, or one Pi entry with such an `id` or `responseId`, which the decoders copy verbatim into the mid; **or** a Pi `toolResult` entry whose preceding `toolCall` entry was dropped by the mechanism above, yielding a `ToolResult` block with no pending call (F1 + F5) | **Yes, and what is missing is the composition rather than either half.** `ck_wire.rs:1122` and `:1149` cover the projector's rejection with hand-built inputs (both verified at `HEAD` to assert `UnpairedToolResult`). **Nothing covers the mid rejection at all, and no test composes a decoder with the projector**, which is the whole point of the record. Both functions are in-crate, so `project_messages(&decode_pi(input).messages)` is one line. The rejection is correct and fail-closed; the defect is that it is detected two layers away from the layer that could have normalised it, and **a single harness-supplied id containing one `#` fails every transform pass for that session until the message leaves the window** |
| codec-b-absolute-ordinal-is-harness-supplied-and-never-validated | **None.** A window into the tail of a long session is the whole enabling state | **Yes, and the producer's contract is already verified.** `module-wire.ts:1028-1031` bases the numbering on a canonical count, so a fifteen-message window of a 500-message session carries ordinals around 501-515, and `module-wire.test.ts:180` pins `absolute_ordinal: 501` as a real value (both read at `HEAD`). `transform.rs:20278` already supplies `"absolute_ordinal": 2_414` in a fixture. **No check exists for the invariant in either language.** The check is stated over the consumer's interpretation rather than over the decoder's validation, because the producer's contract makes the verbatim pass-through correct: `boundary.rs:687-691`'s max-as-count reading is what disagrees, and it disagrees for **every** windowed session rather than for a contrived one |
| codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity | For the collision half, one OpenCode message with two byte-identical parts. For the trust half, a CK ingress message carrying `provider_extras["_cortexkit_codec"]` with plausible `blockIndex`, `nativeIndex` and `decodedFingerprint` values (F6 + F1) | **Yes for both halves, and this is the record with the least existing evidence of any in the part.** `codec/sidecar.rs` has **zero** `#[test]` functions across 339 lines, verified directly. `codec/opencode.rs:1515-1582` and `codec/pi.rs:1436-1443` exercise alignment after a block deletion and an encode replay, which covers the honest path only. **The forged stamp lets a caller point a block at a native part it did not come from**, and `alignment_candidate`'s early return means the kind check that would otherwise catch the mismatch is skipped, so the encoder can write a text block's content into a reasoning part. The collision is contained today **only** because the stamp disambiguates duplicates, which makes the stamp the sole load-bearing disambiguator for a case the fingerprint cannot handle |

### Group F: release behaviour of the codec guards

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert | A caller passing `replace_from > messages.len()`. In debug the `debug_assert!` at `:251` fires first; **in release the slice at `:258` panics with "range start index out of range"** (F4 for the release half) | **Yes by direct call, and the check fails today in both profiles, which is the finding.** `decode_opencode_sidecar_incremental` is `pub(crate)`, so a test can pass an out-of-range value without a new production caller. Its only test, `incremental_sidecar_carries_pins_across_three_generations` (`codec/opencode.rs:2113`), calls it three times with `replace_from` of **1, 2 and 2** (`:2128`, `:2139`, `:2151`), all in range. Reaching it *from production* needs a new caller, or `validated_native_prefix`'s `:12561` filter changing, or `native_sidecar`'s `:12577` condition changing. **The existing test-hook asymmetry is the sharpest evidence**: `lib.rs:12452-12459` defines `CorruptSidecarForTest` and `CorruptFrontierForTest`, and `:12531-12541` deliberately perturbs the projection prefix by `+1` under `cfg(test)` then re-clamps at `:12543`, so the authors built a hook for a corrupted prefix on the projection path and **no equivalent hook exists for the sidecar slice** |
| codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour | **A release build (F4)** plus an input reaching the `parts.push(render_tool_pair_as_part(block, result))` arm at `codec/opencode.rs:754` for a call id another message already emitted. The comment at `:749-757` says the arm exists because neither half matched a native index, which is the fresh-shell case | **Yes, and F4 is the whole cost.** The `always(!duplicate)` on the returned `Vec<MessageV2Json>` is assertable in either profile; F4 is what shows the guard is absent. Verified: `assert_unique_tool_use_ids` (`:462-470`) has **one** arm, so in release the function is a no-op while `duplicate_tool_use_locations(messages)` at `:465` still runs and its result is discarded, and there is **no `cfg(not(debug_assertions))` anywhere in 4f** to hold a repair. Its only test is gated `#[cfg(debug_assertions)]` at `:2077`. `transform.rs:21509` and `:21522` exercise 4e's `enforce_unique_tool_use_ids`, which is **the wrong layer**. Two further scope facts: three production callers depend on the guard (`:370`, `lib.rs:12985`, `lib.rs:21308`), and **`lib.rs:12949`'s direct call to `encode_opencode_chunks_with_transition_state` has no uniqueness check in any profile**, because the guard sits inside `encode_opencode_impl` rather than in the chunk API |

### Group G: round-trip claims and declared coverage gaps

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness | **None for the claimed direction.** To make the oracle meaningful, an input containing a shape the retained-raw path does not cover: an unrecognised part or entry type, or a **mutated** block, since an unmutated block short-circuits at `codec/opencode.rs:763-765` and `codec/pi.rs:463-465` and is trivially identical (F5) | **Yes, and the strengthening is a fixture change rather than a capability.** `codec/mod.rs:54-90` and `:177-213` plus the determinism assertions at `:81`, `:87`, `:204`, `:210` are **genuine oracles and not tautologies**: they compare against an independently captured input array, since `generated_from` names a real `opencode.db` and real Pi JSONL sessions, which is materially stronger than the round trip Part 1 characterised as "a tautology over accepted inputs". **The weakness is breadth and oracle fidelity, not vacuity**: one case per harness, the expected value derived from the input by `strip_opencode_compaction` / `strip_pi_compaction` at `:88` and `:211`, and the retained-raw path making identity nearly automatic for unmutated input. The other direction is provably false and already pinned: `codec/mod.rs:112-125` shows four CK messages encoding to three wire messages |
| codec-b-declared-missing-capture-classes-are-never-decoded | One OpenCode message with a `subtask` part; one Pi assistant entry with a `thinking` part carrying `redacted: true` (F5) | **Yes, and the blocker is that nobody added a case rather than that anyone cannot.** Both fixtures were read at `HEAD`: `opencode-golden.json` covers 11 of 12 required classes with `subtask` in `missing_capture_classes`, `pi-golden.json` covers 12 of 13 with `redacted_thinking`, and `assert_coverage_or_recorded_missing` (`codec/mod.rs:254-271`) passes on both because listing a required class clears it. Its own message, "codec golden neither covers nor records missing classes" (`:267-270`), is honest that it is a bookkeeping gate. **The two halves are not equally valuable**: deleting the `subtask` arm would not move the golden, since the part would fall to `:194-204` and still become an opaque block, whereas Pi's `:199-211` produces `CkKind::RedactedReasoning` against `:212-217`'s `CkKind::Reasoning` with a signature, and the two round-trip through different encoder arms (`:543-548` versus `:536-542`) |
| codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given | For the `codec/pi.rs:371` drop, a message whose meta role is `toolResult` but whose CK content holds no `ToolResult` block, which the transform can produce by reducing a decoded tool-result message. For the `:396-397` drop, a CK message with empty `content` whose matched meta's raw is not a Pi message | **Yes via the `:371` drop; the `:396-397` half may be unreachable by construction.** The first drop is directly constructible and refutes `encode_pi(msgs, sidecar).len() == msgs.len()`, so the check is non-vacuous. The second may be unreachable, since only `decode_opaque_entry` produces such a raw and those messages carry exactly one opaque block; that half is recorded and not resolved. `codec/pi.rs:1469-1484` pins the cleared-content drop. **Reachability is the caveat, not constructibility**: there is no production caller, so the record exists because the function is a public export (`codec/mod.rs:10`, `lib.rs:12`) whose contract differs from its OpenCode twin, and 4e's lens already notes the Pi encode path is off-route |

**Totals: 23 non-vacuous today, 4 partial, 0 blocked outright**, over 27 records.
Against a pre-disposition **26 non-vacuous, 0 partial, 0 blocked** over 26 records.

**The old 26-of-26 was the headline of this file and it was wrong, so the
correction goes here rather than in a footnote.** An independent evaluation found
that three of the twenty-six counted checks have no runtime observability at all,
and re-reading each against the code confirms it. One record was added by a split,
and it is non-vacuous, which is why the denominator moved by one and the numerator
by three:

- **`dec-a-commit-cluster-trigger-config-is-inert-in-this-crate` → `Partial`.**
  Its check is that the `TriggerContext` at `lib.rs:4962-4963` carries the
  *configured* `enabled` and `min_clusters`. At defaults the configured and
  hardwired values are identical — `CONFIGURATION.md:237-238` documents `true` and
  `3`, `lib.rs:605` and `:607` hardwire `true` and `3` — so a context built from
  the constants satisfies the assertion. This file's own row said the assertion
  "fails with no fault at all", which is false at defaults. Non-vacuity needs a
  non-default config value **and** a trigger workload, together, and the row now
  says so.
- **`dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian`
  → `Partial`.** Its check was that a warning naming the path is emitted. There is
  no channel for one: `read_tier_cached` (`config.rs:254-266`) takes
  `(&mut TierConfig, PathBuf)`, returns `Option<Value>`, and maps both the read and
  the parse error to `None` at `:261-264`. No warnings sink, no `Result`. The
  observable substitute is the consequence — the resolved config equals
  `McModuleConfig::default()` — plus a static enumeration of the signature, and the
  record now asserts that instead.
- **`codec-b-harness-decoders-accept-every-input-with-no-rejection-channel` →
  `Partial`.** Its return and consistency clauses are non-vacuous over an arbitrary
  `Vec<Value>` and stay so. Its third clause, "allocation is bounded by a constant
  multiple of input size", is not observable from a decode call: the functions
  return `DecodedHarnessMessages` and expose no allocation accounting, so proving
  it needs a counting `#[global_allocator]`, a `dhat`-style profiler, or a
  `Vec::capacity` sweep, none of which the tree has. That clause is now recorded as
  discharged by reading rather than by assertion.
- **`dec-a-caller-supplied-trigger-budget-is-the-one-unvalidated-float-and-reaches-a-diagnostic`
  → `Yes`, and it is the cheapest falsifying oracle in the part.** New record, split
  out of the budget-derivation record. One `BoundaryContext` literal with
  `trigger_budget: Some(f64::NAN)`, one call, and `TriggerProgress.tail_size_bar`
  (`boundary.rs:802`) is NaN. It fails on the current build, which none of the
  guards cluster's oracles do.

**The corrected distribution is still the finding, and it needs naming precisely
rather than celebrating.** 4d reached 22 of 24 because its surface is
request-shaped, and 4e reached 22 of 24 because its surface is fixture-shaped.
**4f reaches 23 of 27 because its surface is argument-shaped.** Fifteen of the 27
need nothing but a struct literal, a JSON string, or a `Vec<Value>` passed to a
pure function, and none of the 27 needs a clock, a store mutation, a second
process, a second pass, or a seam. Group C in particular is seven records whose
entire enabling state is a hand-written function argument.

**And the shape of the three demotions is worth stating, because it is one error
repeated.** All three counted a check as observable when the observation channel
does not exist: a value that is indistinguishable from its own default, a warning
with no return path, and an allocation with no accounting. Constructibility of the
*input* was verified in every case and mistaken for constructibility of the
*oracle*. That is a different failure from the sibling parts' — 4d and 4e's
demotions were about missing fixtures — and it is cheaper to catch, because the
question is mechanical: name the value the oracle reads, and the code path that
returns it to the test.

**Three caveats keep the 23 honest, and they are about reachability rather than
constructibility.** METHOD.md keeps those axes separate and so does this table.

- `dec-a-model-key-lookup-walk-has-two-implementations-that-disagree`: the
  differential is writable, and the divergence it would demonstrate is latent
  because **nothing anywhere in the repository** constructs
  `ExecuteThresholdConfig::ByModel`. `grep -rn 'ByModel' --include='*.rs'` returns
  two hits, the variant declaration at `scheduler.rs:115` and the match arm at
  `:456`. Not production, not a test. The catalog's label moved from
  `explicit-config-only` to `test-only` for this reason, since `config.rs`'s
  `number_at` (`:631-636`) discards an object form before any enum is chosen.
- `codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record` and
  `codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given` are labelled
  `test-only` in the catalog, and the second has no production caller at all.
- `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`
  and `codec-b-decoder-output-can-violate-the-projector-precondition` both prove
  the module's behaviour on a hand-built input; whether a production route can
  supply that input is an unresolved route question.

**But the binding constraint here is `F0`, not any fault class, and 4f's position
is the worst of the three parts on that axis.** 4d had 22 constructible records
against a suite no automation executes, with ten integration binaries as a
fallback. 4e had 22 with no integration fallback. **4f has 23 constructible
records, no integration fallback, and the one integration binary the brief names
would not cover this scope even if it ran**: `release_contract_conformance.rs`
reaches no 4f file, while its own header at `:1-8` argues its drift "must fail the
build, not the deployment".

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically. Because this part has no `sometimes` record, none of these
duplicates an existing marker.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `CONFIG_RESOLUTION_CHANGED_A_SUPPLIED_LEAF` | A resolution in which an input leaf differed from the resolved leaf, whether by a clamp, a discard, or a tier drop | The ordinary shape of every clamping resolution, and clamping is the design. It records that the campaign observed a value being altered at all, not that a warning was owed |
| `CONFIG_RESOLUTION_EMITTED_AN_IGNORED_KEY_WARNING` | `warn_ignored_project_key` (`config.rs:575-581`) fired for one of its six pointers (`:520`, `:538`, `:539`, `:540`, `:556`, `:561`) | Legal and is the function's purpose. **Pairing it with the marker above is how the reporting asymmetry becomes checkable** without asserting that any specific leaf should have warned |
| `CONFIG_PROJECT_TIER_CHANGED_A_RESOLVED_LEAF` | A project-tier value changed a leaf of `McModuleConfig` | Legal for the documented project-writable set, so it fires on correct operation. The precondition of the allow-list record, stated as a tier-provenance fact |
| `CONFIG_FILE_READ_SUCCEEDED_AND_PARSE_FAILED` | `fs::read_to_string` returned `Ok` and `serde_json::from_str` returned `Err` on the same file | Legal as written: the resolution absorbs the failure into defaults. It records the input-domain fact and does not assert that a warning was owed |
| `HISTORIAN_CHAIN_WAS_ASSEMBLED_FROM_TWO_CONFIG_KEYS` | The resolved `model_chain` drew from `historian.module_model` and `historian.module_fallback_models` in one resolution | Legal input and is the documented way to configure a chain. The independent precondition of the adjacent-only dedup record, without asserting the chain contained a repeat |
| `HISTORIAN_CHAIN_DEDUP_REMOVED_AN_ELEMENT` | `dedup()` at `config.rs:571` shortened the chain | Legal and is `dedup`'s purpose. Witnessing it alongside the marker above is what shows the campaign reached the dedup at all, which the record's confidence depends on |
| `CACHE_TTL_PARSE_RETURNED_ERR_AND_THE_DEFAULT_WAS_SUBSTITUTED` | `scheduler_ttl_ms` (`scheduler.rs:810-812`) swallowed a `CacheTtlParseError` into `DEFAULT_CACHE_TTL_MS` | Legal as written and is the fallback's purpose. The precondition of the silent-substitution half of the TTL record |
| `CACHE_TTL_RESOLVED_TO_ZERO_MILLISECONDS` | A configured `cache_ttl` of `"0"` parsed to `Ok(0)` | Legal: the parse is total and `0` is a valid result. It records the input-domain fact whose consequence is a forced execution every pass, without asserting that forcing is wrong |
| `BOUNDARY_BUDGET_DERIVED_FROM_A_NON_FINITE_OR_NON_POSITIVE_LIMIT` | The guard at `boundary.rs:340-342` returned `TRIGGER_BUDGET_MIN` because `context_limit` was non-finite or non-positive | Legal and is the guard's purpose. **This is the positive precondition that makes the totality record meaningful**, rather than asserting that the guard's absence would be a defect |
| `ESCALATION_BANDS_DERIVED_FROM_AN_OUT_OF_RANGE_THRESHOLD` | `escalation_bands` was called with a threshold that was `NaN`, negative, or above `90` | Legal input, because the function is total over `f64`. It records that the campaign reached the extremes rather than only the default `65` |
| `SELECTION_MERGED_TWO_CANDIDATE_DECISIONS_FOR_ONE_TARGET` | The merge chose between two candidate decisions naming one `target_id` | Legal and is exactly what "drop beats edit_marker" (`selection.rs:26-27`) describes. The precondition of the determinism record, stated as a merge-provenance fact rather than as an ordering violation |
| `REGION_HINT_INPUT_ALREADY_ENDED_WITH_THE_TRUNCATION_SENTINEL` | A diff value handed to `region_hint` (`selection.rs:558-571`) already ended with the literal `...[truncated]` on entry | An input-domain fact about harness-supplied content, legal to observe, and the benign producer is a file whose text legitimately ends that way. **This is the independent precondition of the bypass and it must not be paired with a marker meaning the clamp was skipped** |
| `DECODER_ACCEPTED_AN_ELEMENT_MATCHING_NO_NAMED_SHAPE` | A decode produced a message from an input element that matched no named arm | Legal today by design, because neither decoder has a rejection channel. It records the acceptance as an input-domain fact and does not claim the message was fabricated |
| `DECODER_PRODUCED_A_ZERO_BLOCK_MESSAGE_OCCUPYING_AN_ORDINAL` | A decoded message with zero blocks was assigned an ordinal and entered the sidecar | Legal today, and the same shape an authentic empty user turn produces. The precondition of the totality record, without asserting the two are indistinguishable |
| `PI_DECODE_INPUT_CARRIED_AN_UNRECOGNISED_ENTRY_TYPE` | An input entry whose `type` matched neither a message nor one of the three named opaque types | An input-domain fact, legal to observe. It records what arrived and not what was retained, so it fires on a correct implementation that retained the entry |
| `OPENCODE_DECODE_INPUT_CARRIED_AN_IMMUNE_PART_TYPE` | An input part whose type was in `{snapshot, patch, agent, retry}` | Legal, and the golden already supplies a `patch`, so it fires today. The preservation-direction precondition |
| `OPENCODE_ENCODE_RAN_WITH_A_NON_EMPTY_NATIVE_REMOVAL_SET` | `remove_unretained_native_parts` ran with at least one block removed | Legal and is the function's purpose. **Pairing it with the marker above is the composition the existing checks miss**, since `codec/mod.rs:216-252` exercises removal on a message with no immune parts |
| `DECODED_MESSAGE_CARRIED_MIXED_SYNTHETIC_AND_AUTHORED_PARTS` | One decoded OpenCode message whose parts included both a synthetic and an authored origin | Legal input. The precondition of the provenance record, stated without asserting the resulting classification was wrong |
| `DECODED_MID_CONTAINED_A_PROJECTOR_RESERVED_CHARACTER` | A decoder copied an `info.id`, `id` or `responseId` containing `#` verbatim into a mid | An input-domain fact about harness-supplied ids, legal at the decoder because the decoder has no such precondition. It does not assert that the projector rejected anything |
| `DECODER_OUTPUT_WAS_HANDED_DIRECTLY_TO_THE_PROJECTOR` | One campaign run composed a decode with `project_messages` on the same value | A structural fact about which two stages ran in sequence, true today with fully correct behaviour. **It is the marker that distinguishes a campaign that tested the composition from one that tested each half**, which is the whole gap the record names |
| `DECODED_ARRAY_CARRIED_A_NON_ZERO_MINIMUM_ABSOLUTE_ORDINAL` | The smallest `absolute_ordinal` in a decoded array was greater than zero, meaning a windowed session | Legal and is the producer's design per `module-wire.ts:1028-1031`. The precondition of the ordinal record, stated as a numbering-provenance fact rather than as a consumer error |
| `BLOCK_ALIGNED_VIA_A_STAMP_PRESENT_ON_INGRESS` | The `_cortexkit_codec` stamp used by alignment was already on the block when it arrived, rather than written by `stamp_block_identity` during this decode | Legal today, because the pass-through path preserves `provider_extras` verbatim, and the benign producer is a replay of the module's own encoded output. **The independent precondition of the trust half, and it must not be paired with a marker meaning the stamp was forged** |
| `TWO_NATIVE_PARTS_IN_ONE_MESSAGE_SHARED_A_FINGERPRINT` | `decoded_block_fingerprint` returned the same value for two parts of one message | Legal today and contained, because the stamp disambiguates. Witnessing it is what shows the stamp is load-bearing for a case the fingerprint cannot handle |
| `INCREMENTAL_SIDECAR_REPLACE_FROM_CAME_FROM_A_CALLER_FILTER` | The `replace_from` passed to `decode_opencode_sidecar_incremental` was produced by `validated_native_prefix`'s filter at `lib.rs:12561` or the guard at `:12577` | Legal and is exactly the convention the callee depends on. **It records that the callee's safety is a caller property**, which is the record's claim, without inducing an out-of-range value |
| `TOOL_USE_UNIQUENESS_GUARD_RAN_WITH_DEBUG_ASSERTIONS_OFF` | `assert_unique_tool_use_ids` (`codec/opencode.rs:462-470`) was entered with `cfg!(debug_assertions) == false` | A build fact, legal and correct in a release artifact. Pairing it with the marker below is how the no-enforcement finding becomes checkable without inducing a duplicate id in production |
| `ENCODE_EMITTED_A_TOOL_PART_FROM_THE_FRESH_SHELL_ARM` | The `parts.push(render_tool_pair_as_part(block, result))` arm at `codec/opencode.rs:754` ran | Legal and deliberate per the comment at `:749-757`: the arm exists because neither half matched a native index. The precondition of the duplicate-id record |
| `ROUND_TRIP_INPUT_CONTAINED_A_MUTATED_BLOCK` | A round-trip case included a block that did **not** short-circuit at `codec/opencode.rs:763-765` or `codec/pi.rs:463-465` | Legal, and is the only condition under which the round-trip oracle carries information. **This is the marker that measures the record's real gap**, since the retained-raw path makes identity nearly automatic for unmutated input |
| `GOLDEN_COVERAGE_GATE_CLEARED_A_CLASS_VIA_MISSING_CAPTURE_CLASSES` | The filter at `codec/mod.rs:262-266` cleared a required class because it appeared in `missing_capture_classes` rather than in `coverage` | Legal by construction and is the mechanism being reported. It records which list satisfied the gate, not that the gate is wrong |
| `PI_ENCODE_INPUT_CARRIED_A_TOOLRESULT_META_WITH_NO_TOOLRESULT_BLOCK` | A message reaching `encode_pi` whose meta role was `toolResult` while its CK content held no `ToolResult` block | An input-domain fact the transform can legitimately produce by reducing a decoded tool-result message. The precondition of the shorter-array record, without asserting the array shortened |
| `COMMIT_CLUSTER_TRIGGER_CONTEXT_BUILT_FROM_HARDWIRED_CONSTANTS` | The `TriggerContext` at `lib.rs:4962-4964` was built from `DEFAULT_COMMIT_CLUSTER_TRIGGER_ENABLED` (`lib.rs:605`) and `DEFAULT_MIN_COMMIT_CLUSTERS` (`lib.rs:607`) rather than from resolved config | A structural fact about the call site, true today with fully correct behaviour. The precondition of the inert-config record |

### The one `reachable` record, checked against METHOD.md

**This part produced no `sometimes` record and no liveness record**, so there is no
existing marker to audit for the forbidden pairing and nothing here duplicates one.
The 27 records are 26 `safety` and one `reachability`.

`codec-b-declared-missing-capture-classes-are-never-decoded` uses `reachable`, and
**the semantics are correct as written.** METHOD.md distinguishes location coverage
from situation coverage, and the obligation here is location coverage in the strict
sense: two decode arms exist (`codec/opencode.rs:171-181` and
`codec/pi.rs:199-211`), both are named as required by the golden's own manifest,
and both are provably never entered by the suite that claims to cover them. There
is no separate operational state to reach beyond executing them, which is the
condition under which METHOD.md's second rule would force `sometimes`. The
catalog's header already reports the one qualification and declines to apply it: the
`subtask` half is location coverage over a path with no distinguishable outcome,
because deleting the arm would leave the part falling to `:194-204` and still
becoming an opaque block, so the golden would not move. The redacted-thinking half
is the load-bearing one. **That record supplies no marker constant**, which is the
same compliance gap 4e recorded for both of its `sometimes` records. Give it one of
the same shape as the table above, for example
`REDACTED_THINKING_DECODE_ARM_EXECUTED`, so the assertion stops being anonymous.

### Anti-patterns to avoid in this part specifically

Seven pairings are forbidden by METHOD.md's rule, and each is tempting here because
in this part the defect is almost always easier to name than its precondition.

- Do not pair `always(config_changes_are_reported)` with
  `sometimes(a_clamp_went_unreported)`. **Every clamp goes unreported today**, so
  the marker fires on the first resolution and proves nothing.
  `CONFIG_RESOLUTION_CHANGED_A_SUPPLIED_LEAF` and
  `CONFIG_RESOLUTION_EMITTED_AN_IGNORED_KEY_WARNING` are two independent legal
  facts whose conjunction is the asymmetry.
- Do not pair `always(region_hint_output_is_within_the_cap)` with
  `sometimes(the_sentinel_bypassed_the_clamp)`. That marker can fire only by
  producing the oversized hint. Assert
  `REGION_HINT_INPUT_ALREADY_ENDED_WITH_THE_TRUNCATION_SENTINEL` instead, which is
  a fact about harness-supplied input, and keep the `always` on the payload.
- Do not pair `always(no_duplicate_tool_use_ids_in_the_encoded_array)` with
  `sometimes(the_release_guard_missed_a_duplicate)`. Assert
  `TOOL_USE_UNIQUENESS_GUARD_RAN_WITH_DEBUG_ASSERTIONS_OFF` and
  `ENCODE_EMITTED_A_TOOL_PART_FROM_THE_FRESH_SHELL_ARM` instead, and keep the
  `always` on the returned `Vec`. The `sometimes` form would also be
  profile-dependent, which makes a silent marker indistinguishable from a debug run.
- Do not pair `always(every_input_entry_is_recoverable)` with
  `sometimes(pi_dropped_an_entry)`. Assert
  `PI_DECODE_INPUT_CARRIED_AN_UNRECOGNISED_ENTRY_TYPE` instead, which records what
  arrived rather than what was lost, and keep the `always` on the recoverability
  comparison. The drop marker can only fire by observing the defect.
- Do not pair `always(project_messages_accepts_decoder_output)` with
  `sometimes(the_projector_rejected_a_decoded_set)`. The second is the violation.
  Assert `DECODED_MID_CONTAINED_A_PROJECTOR_RESERVED_CHARACTER` and
  `DECODER_OUTPUT_WAS_HANDED_DIRECTLY_TO_THE_PROJECTOR`: one input-domain fact and
  one structural fact, both legal, whose conjunction is the composition gap.
- Do not pair `always(every_aligning_stamp_was_written_by_this_decode)` with
  `sometimes(a_forged_stamp_was_trusted)`. "Forged" is not observable from inside
  the decoder, which is the record's whole point.
  `BLOCK_ALIGNED_VIA_A_STAMP_PRESENT_ON_INGRESS` is the honest form, because it
  records the stamp's provenance without judging the writer's intent.
- Do not pair `always(the_golden_covers_every_required_class)` with
  `sometimes(a_required_class_was_uncovered)`. **Two required classes are uncovered
  today**, so the marker fires immediately and proves nothing.
  `GOLDEN_COVERAGE_GATE_CLEARED_A_CLASS_VIA_MISSING_CAPTURE_CLASSES` is a
  structural fact about which list satisfied `codec/mod.rs:262-266`, and is the
  honest form.

### Placement constraints on markers in this part

Six, and they differ from 4e's because this part's boundary is a returned value
rather than a served byte array.

1. **A marker on a `debug_assert!` line does not exist in a release artifact, and
   in 4f there is no release arm to put a counterpart in.** All three assertion
   sites are `debug_assert` (`codec/opencode.rs:251`, `:252`, `:466`) and
   **verified: no `cfg(not(debug_assertions))` exists anywhere in 4f**. A marker
   placed beside one inherits its `cfg`, so a silent campaign under `--release`
   would be indistinguishable from a passing one. Markers about profile-dependent
   behaviour must be unconditional and must record `cfg!(debug_assertions)` as
   data.
2. **A marker inside `assert_unique_tool_use_ids` cannot mean "the wire was
   checked".** In release the whole body vanishes, while
   `duplicate_tool_use_locations(messages)` at `:465` still runs and its result is
   discarded. **The honest placement is on that computed value**, not beside the
   assertion, because the computation survives the profile and the assertion does
   not.
3. **A marker meaning "these are the encoded wire bytes" must not sit inside
   `encode_opencode_impl`.** The guard is applied there rather than in the chunk
   API, so `lib.rs:12949`'s direct call to
   `encode_opencode_chunks_with_transition_state` bypasses it in **every** profile.
   A marker inside the impl would fire on the guarded path and stay silent on the
   unguarded one, which inverts the signal.
4. **A marker meaning "block identity was established by this decode" must sit in
   `stamp_block_identity` (`codec/sidecar.rs:158`), not at the alignment read.**
   `stamped_block_identity` (`:177-183`) returns `Some` for any three well-formed
   values under `_cortexkit_codec` (`:131`) regardless of writer, so a marker at
   the read cannot distinguish a stamp this decode wrote from one that arrived on
   ingress.
5. **A marker meaning "the golden covered this class" is false as stated.**
   `assert_coverage_or_recorded_missing` (`codec/mod.rs:254-271`) is satisfied by a
   class appearing in `missing_capture_classes`, so a coverage marker must name the
   `coverage` array as its subject or it will be read as evidence about a class the
   fixture explicitly declares absent.
6. **A marker anywhere in `codec/sidecar.rs` fires only transitively.** Zero tests
   call its entry points directly, and the only reachers are
   `codec/opencode.rs:553-554`, `:742`, `:763` and `codec/pi.rs:303-304`, `:372`,
   `:463`, which means the two one-case goldens. Such a marker records the goldens'
   path, not direct exercise of the block-identity stamper.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. **Every item on this list is cheap, which is the
distinguishing fact about this part**, so the ranking turns on value rather than on
effort once `F0` is answered.

1. **`F0`, running the 192 existing checks in CI at all. This remains the
   prerequisite.** A workflow change and nothing else: `cargo test -p mc-module
   --lib` alongside the existing `--test lifecycle_cli` step (`ci.yml:168` at
   `76cd6f41`, `:172` at `HEAD`), or calling the `scripts/test-rust.sh` lane that
   already exists in `package.json` and that no workflow invokes. It unblocks
   **zero** new records and **protects 192 existing checks**: 153 file-local across
   the ten 4f files that have any, plus 39 drawn from `transform.rs`. **Nothing
   else on this list matters until this is done**, because everything added below
   is added to a suite no automation executes. Unlike 4d there is no integration
   binary to fall back on: all seven have zero 4f content, so `--lib` is the only
   lane that reaches this scope. One blocker is named and bounded: `ci.yml:719-721`
   states Rust is absent from the e2e lanes because private `../commons` and
   `../subconscious` path-deps are not provisioned, and `ci.yml:163-164` provisions
   metadata-only stubs. Whether that constraint reaches `--lib` is an open question
   rather than a settled no.
2. **The `smart_drops` whole-pipeline differential. This is the single
   highest-value item in the part, and it is free.** State it plainly:
   **`CONFIGURATION.md:763` promises that with the flag off "the messages sent to
   the model are byte-identical to the age-based-only behavior" and that "the entire
   feature is inert"; the flag is one boolean (`config.rs:135`, `:467-469`,
   `:541-543`); and nothing takes the oracle.** A flag-off run against a
   pre-feature run is a byte-equality check over the whole selection pipeline
   obtained by flipping one field and running twice. It requires no fixture design,
   no seam, no new dependency and no new fault class, and it is the strongest
   testable statement in the entire configuration document. It sits above every
   per-record capability below because it is the only item on the list whose oracle
   covers a pipeline rather than a function, and `CONFIGURATION.md:767` names the
   validation strategy currently in place instead: "The default stays off while
   cache stability is being validated in the wild." **Field observation is standing
   in for a free test.**
3. **`F2`, configuration values at and beyond documented bounds. The widest
   capability per fixture.** One config resolution makes **five** records
   non-vacuous:
   `dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1`,
   `dec-a-memory-injection-budget-documented-range-has-no-implementing-code`,
   `dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list`,
   `dec-a-config-value-clamps-and-zero-rejection-are-invisible-to-the-caller`, and
   `dec-a-model-chain-dedup-is-adjacent-only`. The oracle in every case is the
   resolved struct plus the returned warning vector, both of which the merge path
   already materialises, so no new plumbing is needed. **The same fixture answers a
   documentation question the register raised**: eight of the thirteen `NOT FOUND`
   claims would be discharged by one schema-diff check plus one key-set diff check,
   and 4b already proposed the key-set check for its four keys
   (`../part-4b-transform/existing-checks.md:571-574`). **This map proposes both.**
4. **`F1`, arbitrary input to each decoder. The cheapest single oracle in the
   part.** A `Vec<serde_json::Value>` and one call. It makes
   `codec-b-harness-decoders-accept-every-input-with-no-rejection-channel` valid
   and supplies half of `codec-b-decoder-output-can-violate-the-projector-precondition`
   and half of the fingerprint-collision record. **The reason it is not higher is
   that the property it checks is violated by design rather than under-evidenced**:
   both decoders return `DecodedHarnessMessages` with no error variant
   (`codec/opencode.rs:23-25`, `codec/pi.rs:19-21`), so a test written here
   documents a decision rather than catching a regression. That is still worth
   having, because the failure mode is a fabricated zero-block message that
   occupies an ordinal and is indistinguishable downstream from an authentic empty
   turn.
5. **`F5`, harness input carrying unknown or omitted types. One hand-built element
   per record, four records.** It makes
   `codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record`,
   `codec-b-opencode-hides-four-part-types-from-every-transform-decision`,
   `codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only` and
   `codec-b-declared-missing-capture-classes-are-never-decoded` valid, and it is
   the capability that turns
   `codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness`
   from a near-tautology into an informative check. **Two of its members are
   already named by the code itself**: `subtask` and `redacted_thinking` are
   declared required and declared missing in the same fixture, so the work is adding
   one part and one entry to two generators, not designing a fault.
6. **`F4`, running the suite in release as well as debug. A build flag, and it buys
   less here than the same flag bought 4e.** One extra invocation,
   `cargo test -p mc-module --lib --release`. It makes
   `codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour` valid and
   completes `codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert`.
   **What it establishes is three absences rather than a second behaviour**, because
   there is no `cfg(not(debug_assertions))` anywhere in 4f: `:466` enforces nothing
   while `:465` still computes and discards; `:252`'s violation is silent because
   `take` at `:265` saturates; and `:251`'s is not silent because the slice at
   `:258` panics on the same condition in every profile. It also compiles the one
   test currently gated `#[cfg(debug_assertions)]` at `:2077` out of existence,
   which is the sharper half of the finding: **whichever profile ships, that
   guard's shipped behaviour has no test.**
7. **`F6`, caller-supplied block identity. One forged `provider_extras` value, and
   it targets the file with zero tests.** It makes
   `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`
   valid in both halves. It ranks here rather than higher for two reasons: the
   trust half proves the module's behaviour on a hand-built ingress message without
   establishing that a production route supplies one, and the collision half is
   contained today. **But it is the only capability that reaches
   `codec/sidecar.rs` at all**, 339 lines with no test module that owns the block
   identity everything downstream keys on, so its per-line value is the highest on
   the list.
8. **`F3`, a malformed configuration file. One bad file, one record.** It makes
   `dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian`
   valid. Eighth on records-per-cost and not on difficulty: the fixture pattern
   already exists at `config.rs:1181` and `:1191`. The consequence is worth the one
   test on its own, because the observable surface of a config typo today is a
   `no_models` no-fire reason that points a reader at model configuration rather
   than at a parse failure.
9. **`F7` cross-language, last on cost and first on consequence.** This is the
   tension worth stating rather than hiding, and 4f's version is the worst of the
   three parts. 4e's gap was that the frozen artifact both sides share has its
   provenance guard on the unrun leg. **4f has no provenance guard at all**:
   verified that no 4f file contains any `provenance`, `input_sha256` or
   `generator_version` fixture assertion, across eight fixtures, and that the two
   `generated_from` and `projection_oracle` fields which do exist are never
   deserialized (`codec/mod.rs:28-34`, `:41-47`). Of those eight fixtures, seven
   are one-legged and replayed by Rust only; the one two-legged fixture,
   `cache-ttl-routing-vectors.json` (5 cases), **is gated only on its TypeScript
   leg** (`prompt-surface.test.ts:105` via `ci.yml:257`) while the Rust leg
   (`config.rs:760`) runs nowhere. The **cheap half is therefore `F0` again**:
   running the Rust suite puts every one of those goldens under automation without
   writing a line of test code. The **expensive half** is an executable
   cross-implementation oracle, and none exists to extend: `PARITY.md:13-15`'s
   master parity claim is `NOT FOUND` as an oracle inside `mc-module`, and eight of
   the thirteen `NOT FOUND` claims are parity claims whose oracle lives in
   TypeScript and is never read from this crate.

### Why this part's cheap oracles are worth more than their cost suggests

One framing note, because it changes the priority rather than the analysis.
**Under the project's Rust-first decision (`../README.md:46-58`), this sub-part's
configuration and codec surface is the one that survives.** All transforms are
moving to Rust, Part 5 is parked, and the records that describe a transitional
state are the TypeScript transform records in 5c. 4f is the layer that both reads
the user's configuration and owns the bytes entering and leaving the crate, so it
is on the path that is becoming the default rather than the path being retired. The
consequence for this map is direct: **a `NOT FOUND` parity claim against a
TypeScript twin becomes less recoverable over time, not more**, because the twin is
being retired while the obligation stated in `config.rs:17-18`, `:20-22`, `:23-24`
and `lib.rs:604`, `:606` stays in the source. The cheap oracles ranked above are
the ones that would still be meaningful after the twin is gone, and they cost a
fixture each.

## Records that need a product decision rather than a harness

No amount of test infrastructure resolves these, and each is a live open question
from at least one lens.

- **Which build profile does the distributed `ck-mc-host` use?** CI builds debug
  (`ci.yml:169` at `HEAD`, `:165` at `76cd6f41`, no `--release`), which selects the
  arms that do enforce. Every release-profile statement in this part is conditional
  on the answer, and it decides whether `assert_unique_tool_use_ids` enforces
  anything in production at all. Unresolved, needs the release pipeline. 4e's lens
  A and lens C left the same question open. (needs human input)
- **Should a `debug_assert!` whose condition is independently enforced by the
  language in release be catalogued differently from one that is not?**
  `codec/opencode.rs:251` is re-checked by the slice at `:258`; `:252` is consumed
  by `take` at `:265`, which saturates. The two sit on adjacent lines with opposite
  release semantics. (needs human input)
- **Are `subtask` and `redacted_thinking` absent from the codec goldens because the
  generator cannot produce them, or because nobody has added a case?** The
  `missing_capture_classes` mechanism records the fact and not the reason.
  Unresolved, needs the intent behind `testdata/codec/gen-opencode-golden.ts` and
  `gen-pi-golden.ts`.
- **Is the encode-direction oracle at `codec/mod.rs:88` and `:211` intended to be
  self-referential, or was an independent expected output intended?** Each fixture
  carries a `projection_oracle` field that nothing deserializes, which suggests the
  latter. Unresolved.
- **Should the documented-but-inert-or-divergent key count be nine or thirteen?**
  The two sibling lenses disagree only about granularity, and the catalog picked 13
  and said so. Two counts in one part directory would read as a contradiction, so
  the rule needs stating once. (needs human input)
- **Is `output_reserve` in 4f scope?** `CONFIGURATION.md:315` names "the module's
  plausibility floor", which is `scheduler.rs:33`, squarely in 4f, while the key
  itself is parsed elsewhere and has zero occurrences in `crates/mc-module/src`. If
  the answer is no, the claim still stands as a documentation defect and needs an
  owner. (needs human input)
- **Is `PARITY.md` a claim source for `mc-module` at all?** It is titled "Pi to
  OpenCode: Intentional Divergences" and describes two TypeScript plugins. If its
  scope is TypeScript only, four register claims move from "contradicted" or "NOT
  FOUND" to "out of scope", **and the Rust codecs are left with no stated contract
  at all**, which is a worse position: verified that `codec/mod.rs:1`,
  `codec/opencode.rs:1`, `codec/pi.rs:1` and `codec/sidecar.rs:1` all begin with
  `use` or `pub mod` and none carries a `//!` header, while the three decision
  units in the same sub-part all do. (needs human input)
- **Do the four undocumented but effective keys belong in `CONFIGURATION.md`?**
  `memory.user_profile_budget_tokens`, `historian.module_model` with
  `module_fallback_models`, `historian.context_limit_tokens`, and
  `prompt_surface.guidance_override_text`. `config.rs:1-9` reads as a public
  contract and names its TypeScript twin three times, which is the posture of a
  documented surface. (needs human input)
- **Should `release_contract_conformance.rs` be inventoried by 4f at all, and
  should it run?** The brief names it, its content reaches no 4f file, and its own
  header (`:1-8`) argues its drift "must fail the build, not the deployment" while
  no workflow runs it. The scope map raised this at `:681`. (needs human input)
- **Does `caveman.rs` belong to 4e or 4f?** The scope map says 4e (`:590`), 4e's
  inventory counts its single test, and the brief assigns the file here. One test
  and 651 production lines are currently double-counted. (needs human input)
- **Which of 4b's five buckets hold the 9 tests 4f attributes and neither sibling
  did?** Without 4b's per-test bucket assignment the union of the three parts over
  `transform.rs` can only be bracketed at 253 to 262 of 280, and the orphan
  remainder at 18 to 27. Unresolved, needs 4b's enumeration.
- **Does a test that never runs in CI count as `Exercised: partial` or
  `Exercised: not yet`?** It governs every `Existing check:` line in this part, and
  for `codec/opencode.rs:2079` the question is sharper because the test does not
  compile in a release test build. 4b, 4c, 4d, 4e, the scope map (`:681`) and both
  4f sibling lenses raised it. (needs human input)
