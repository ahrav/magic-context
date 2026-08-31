# Part 4b lens B: pass selection, eligibility, and budgeting

One lens pass over sub-part 4b (transform pass engine). Attention focus: which
passes and sub-passes are eligible for a given firing, what inputs that decision
reads, what budget the firing has, and what the selection promises. The state
transition and commit ordering belong to a sibling lens and are not analysed
here.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `76cd6f41`
("refactor(shm): simplify fixed-ring ownership"). Method contract in
[../../METHOD.md](../../METHOD.md). Region maps taken from
[../../part-4-module/\_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md);
that file was written at `dde0c051`, and every `transform.rs` boundary it names
still holds at `76cd6f41` (`apply_once` still starts at `:3222`, the test module
still starts at `:12625`).

Files read: `src/transform.rs:1-7510` (the 4b slice), `src/injection.rs`,
`src/compartment_coverage.rs:1-60`, plus the out-of-slice callees and callers
that the selection decision depends on and that no other 4b lens owns:
`src/scheduler.rs`, `src/config.rs`, `src/lib.rs:160-235`, `:1707-1712`,
`:4460-4484`, `:8278-8320`, `:13443-13465`, `src/selection.rs:180-210`,
`:900-940`, `:1268-1300`, `:1089-1105`, `crates/mc-store/src/lib.rs:6221-6250`,
`CONFIGURATION.md`, and `docs/specs/context-window-geometry.md`.

## Selection map

Selection happens in one linear region of `apply_once`. There are two distinct
layers, and conflating them is the main hazard in reading this code.

**Layer 1: the scheduler pass decision.** `scheduler::decide` is called once per
path: `transform.rs:3972-4005` in `apply_once`, and `:2813-2846` in
`apply_additive_only`. Both build a `SchedulerInputs` inline. It returns one of
`Defer`, `Execute`, `Force85`, `Emergency95` plus a drain latch and a deferred
execute intent. The config handed to it is built by `scheduler_config`
(`transform.rs:6104-6111`), which wraps a single `f64` as
`ExecuteThresholdConfig::Percentage` and hardwires `execute_threshold_tokens:
None`. Three post-decision overrides then mutate the outcome in place: a trusted
final-wire emergency disarm (`:4119-4129`), a `soft_refresh_pending` promotion of
a plain `Defer` to `Execute` (`:4034-4038`), and inside `scheduler::decide`
itself, an `emergency_recovery_armed` promotion of `Defer` to `Emergency95`
(`scheduler.rs:761-763`) and a `mid_tool_use` demotion of `Execute` to `Defer`
(`scheduler.rs:533-552`).

**Layer 2: the sub-pass gates.** Each kind of work has its own eligibility
predicate, evaluated after layer 1:

| Sub-pass | Gate | Location |
| --- | --- | --- |
| Reduction selection | `producer_gate` | `transform.rs:4120-4128`, definition `:6113-6115` |
| Reduction pass class | `selection_class` | `:4131-4135`, definition `:6117-6124` |
| HARD fold | `hard_fold_requested` | `:4078-4084` |
| Bust opportunity | `bust_opportunity` | `:4293-4297` |
| Classifier plan | `classify(&ClassifierInput{..})` | `:4298-4319` |
| Synthetic todo | `todo_injection_pending` | `:4159-4166`, predicate `injection.rs:249-277` |
| Caveman units | `is_bust_pass && req.caveman_enabled && age_basis_tag != 0` | `:4491-4510`, gate `:6312-6314` |
| Frozen strips | `new_frozen_strip_units(.., is_bust_pass, ..)` | `:4482-4489` |
| Tag-window protection | `tagging_surface_requested` | `:4168-4183` |
| Boundary divergence recut | `boundary_divergence_recut` | `:3941-3947` |

`producer_gate` is the load-bearing one. It reads
`tail_reclaim_enabled && (pass != Defer || hard_advisory)`, where
`hard_advisory` is the disjunction of five bootstrap and repair conditions
(`:4123-4127`). When it is false, `selection_outcome` is
`SelectionOutcome::default()` (`:4258`) and the selector never runs. When it is
true but `ordinary_historian_veto` holds (`:4098-4104`), the selector runs with
`PassClass::Defer`, which suppresses age reclaim while still letting the durable
queue drain.

**Is selection deterministic for fixed inputs?** On the collection-order axis,
yes, and deliberately so. Every ordered artifact in the 4b slice is produced by
`BTreeMap`, `BTreeSet`, or an explicit `sort_by` with a total tiebreak:
`new_reduction_units` uses `BTreeMap<String, FrozenUnit>` (`:6869-6882`),
`effective_reductions` uses `BTreeMap` (`:6891-6919`), `surviving_caveman_units`
uses `BTreeMap` (`:6410-6435`), `first_applied_pending_command_ids` funnels
through `BTreeSet` (`:6728-6731`), `new_caveman_units` sorts candidates by
`(tag_number, block_id)` (`:6344`), and `selection.rs:1291-1296` sorts arcs by
`(ordinal desc, arc_id desc)`. The `HashMap`/`HashSet` instances in the slice
(`:4136`, `:4175`, `:4187`, `:4191`, `:4218`, `:4223`, `:6321`, `:6389`,
`:6410`, `:6446`, `:6636`, `:6684`, `:6756`, `:6765`, `:6836`, `:6856`,
`:6865`) are all membership or lookup structures; none has its iteration order
reach an output ordering. The one apparent exception,
`covered_system_messages_for_coverage` (`:6630-6656`), iterates `req.messages`
and uses the `HashSet` only for dedup. The queue order that does reach selection,
`agent_drop_ids` (`:4207-4210`), comes from
`load_pending_agent_drops`, which is `ORDER BY p.queued_at ASC, p.id ASC`
(`mc-store/src/lib.rs:6233`).

**Is selection pure?** No. It is a deterministic function of
`(request, store row, ProducerContext)`, but `ProducerContext` carries
process-local mutable state that is neither in the request nor in the store:
`observed_last_response_at_ms` (`lib.rs:4460-4483`, which returns `None` until
this process has seen a response for that session),
`historian_active` and `wrapup_active` (process-local leases,
`lib.rs:8311-8312`), and `now_ms`. Two processes sharing one store can therefore
select different pass classes for byte-identical inputs. The tag rows that feed
`tag_tokens_by_block`, the protection sets, and the caveman age basis come from
`load_cached_tags` (`:7639-7696`), a process-global `Mutex` cache.

## Budget map

Five distinct budget units are enforced in or around the 4b slice. None of them
is a wall-clock or token budget on the firing as a whole; there is no deadline on
`apply_once`.

| Unit | Value | Default source | Enforced at | On exhaustion |
| --- | --- | --- | --- | --- |
| Context tokens (selection ceiling) | `context_limit_tokens * clamp(threshold, 1, 100) / 100` | threshold `65.0` (`config.rs:19`, `scheduler.rs:15`) | `transform.rs:4230-4232` | Selector stops adding drops; graceful |
| Context percentage (pass band) | execute `65`, force `85` (`scheduler.rs:19`), emergency `95` (`:21`), cap `90` (`:17`) | same | `scheduler.rs:716-757` | Escalates the pass class; graceful |
| Store CAS attempts | `MAX_CAS_RETRIES = 8` (`transform.rs:82`) | constant | `:2269-2292` | Returns `TransformError::Store(CasConflict)`; the pass fails, nothing commits |
| Divergence pending passes | `BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT = 3` (`:85`) | constant | `:3925-3947` | Forces a recut HARD; graceful |
| Cache idle TTL | `DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000` (`scheduler.rs:23`) | `cache_ttl` string, parse failure falls back | `scheduler.rs:810-812`, `:429-431` | Fires an idle HARD; graceful |

Two eligibility budgets sit beside these: `protected_tags` (default `20`,
`transform.rs:893-895`) is the count of newest tags immune from dropping, and
`clear_reasoning_age` (default `50`, `:119`) is the tag distance after which
reasoning is cleared. `caveman_min_chars` (default `500`, `:120`) is a per-block
byte floor.

Exhaustion is graceful for four of the five: the pass degrades to a cheaper plan
or escalates to a more aggressive one, and the commit still happens. Only the CAS
budget is a failure: after eight conflicts the error propagates out of
`apply_once_with_estimator_and_projection` and no partial work survives, because
every write for the pass is inside the single `commit_transform` call at
`:5565-5597`. Partial work never survives a failed firing by design; the
commit is one CAS.

One budget is missing. `load_cached_tags` (`:7640-7696`) is an unbounded `loop`
with two `continue` arms and no attempt counter, in contrast to the explicitly
bounded CAS loop 5,000 lines above it.

## Observations

- `transform.rs:6104-6111` — `scheduler_config` hardwires `execute_threshold_tokens: None` and always builds the `Percentage` variant, so the `ByModel` and tokens config shapes that `scheduler.rs:106-133` and `:434-464` implement are unreachable from either `scheduler::decide` call site (`transform.rs:2814`, `:3973`).
- `config.rs:82-116` — `McModuleConfig` has no `execute_threshold_tokens` field and no `protected_tags` field. `grep -c protected_tags crates/mc-module/src/config.rs` returns 0. `smart_drops` by contrast is present at `:111`, defaulted `false` at `:135`, and parsed at `:467-468`.
- `config.rs:430-431`, `:515-517` — the threshold is read with `number_at`, which is `pointer(..).and_then(Value::as_f64).filter(is_finite)` (`:631-636`). An object value yields `None` and is dropped with no warning, unlike the project-tier keys that call `warn_ignored_project_key` (`:576-583`).
- `config.rs:568-570` — the config threshold is clamped to `[1.0, 90.0]`.
- `lib.rs:1710-1712` — `execute_threshold_or` is `self.effective_execute_threshold.unwrap_or(fallback)`. No finiteness check, no range check, no clamp.
- `transform.rs:4230-4232` — the selection ceiling clamps the same value to `[1.0, 100.0]`, ten points above the scheduler's cap, and `f64::clamp` returns `NaN` for a `NaN` input.
- `scheduler.rs:434-464` — `resolve_execute_threshold` does guard: non-finite or negative falls back to `65.0` (`:461-463`) and the result is `min`-ed to `90.0` (`:464`). So the two consumers of one unvalidated number sanitize it differently.
- `transform.rs:4120-4128` — `producer_gate`. `:4131-4135` — `selection_class`. `:4201-4258` — the selector call, with `SelectionOutcome::default()` on the closed arm.
- `selection.rs:1096-1104` — the four supersession counters are `Option<usize>` and "Missing means the gate stayed shut and the selector did not run". They are committed at `transform.rs:5585-5588`, but only when `commit_required` (`:5560-5562`); on a no-op defer the `else` arm at `:5600-5601` records nothing.
- `transform.rs:1317-1360` — `format_pass_timing_line` has no field for the scheduler pass, `producer_gate`, `ordinary_historian_veto`, or `selection_class`. `TransformResponse` (`:1455-1535`) carries `action`, `decision`, and `materialize_reason`, and `materialize_reason` is `None` on a defer (`:12561-12613`).
- `lib.rs:13443-13465` — `emit_pass_timing` is unconditional whenever timings are present; there is no env gate. It writes to stderr.
- `transform.rs:4098-4104` — `ordinary_historian_veto`. No `eprintln!` accompanies it, and the timing line has no field for it.
- `transform.rs:3925-3947` — the divergence pending count is *frozen*, not incremented, while `ctx.historian_active || ctx.wrapup_active` (`:3924`, `:3926-3928`). The three-pass bound therefore only counts passes taken outside that window.
- `scheduler.rs:429-431` — `ttl_hard_expired` requires `last_response_time_ms > 0`. `scheduler.rs:476-478` — `should_execute` returns `Defer` outright when `usage.percentage == 0.0 && last_response_time_ms == 0`.
- `lib.rs:4460-4483` — `observed_last_response_at_ms` returns `None` on the first observation for a session in this process, and thereafter returns `Some` only while `observed_in_process` is true.
- `transform.rs:6312-6314` — caveman is gated on `is_bust_pass && req.caveman_enabled && !req.is_subagent && age_basis_tag != 0`. `:4491-4499` freezes `age_basis_tag` as the max hydrated tag number on a bust and persists it in the same commit.
- `transform.rs:6366-6369` — a bare `assert!` (not `debug_assert!`) inside `new_caveman_units`: `compressed.len() <= existing.frozen_payload.len()`, message "caveman deeper tier grew frozen payload for {block_id}".
- `transform.rs:6370-6374` — when the deeper tier produces an equal-length payload, the *shallower* bytes are kept while the *deeper* depth is recorded.
- `lib.rs:173-193` — `apply_claude_code_config_controls` returns early for every profile except `ClaudeCodeAnthropic` (`:178-180`), then sets `auto_search_*`, `caveman_enabled`, `caveman_min_chars`, and the guidance override. It does not set `protected_tags` or `clear_reasoning_age`.
- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2009`, `:2014`, `:2015-2017`, `:2031` — the OpenCode plugin does send `effective_execute_threshold`, `clear_reasoning_age`, `caveman_enabled`, `caveman_min_chars`, and `protected_tags` on every pass.
- `packages/plugin/src/hooks/magic-context/event-resolvers.ts:267-300`, `:386-392` — the TypeScript leg implements the tokens config, the per-model walk, the 90 percent clamp, and a deduplicated clamp warning, then sends only the resolved percentage.
- `injection.rs:249-277` — `injection_pending_after_capture` builds only the normalized state and call id, deliberately not the messages, before the classifier grants a bust. `todo_tool_present == Some(false)` reports pending only to clear an existing pair.
- `mc-store/src/lib.rs:6233` — `ORDER BY p.queued_at ASC, p.id ASC` for the pending-drop queue.

## Candidate properties

### sel-pass-order-deterministic-under-fixed-inputs

Type: safety
Reachability: default-production — every transform pass with
`compaction_enabled` runs the selection region. `compaction_enabled` defaults to
`true` (`config.rs:123`) and reaches `ProducerContext` at `lib.rs:8302`; the
disabled arm returns early at `transform.rs:3233-3235`.
Status: active
Exercised: not yet — no test replays one fixed pass input repeatedly across
processes and compares the selected decision list and its order byte for byte.
Guarantee: For a fixed request, store row, and producer context, the set of
selected reductions, caveman units, and strip units and their order are
identical on every evaluation, and no ordering depends on the iteration order of
a `HashMap` or `HashSet`.
Check: `always` — assert on every pass that a second evaluation of the selection
region over the same inputs yields an equal decision vector in the same order.
These semantics because determinism is the stated cache invariant
(`selection.rs` header, quoted in the part-4 scope map at
`_lenses/scope-map-and-risk-ranking.md:313`): a single divergence produces
non-replayable frozen bytes, so there is no tolerated window.
Fault/timing angle: none. This is a pure-ordering property over one pass.
Required faults and enabling state: none. It needs only a session with more than
one eligible reduction target so that an order exists to disagree about, plus a
randomized `RandomState` across processes, which is the default.
Confidence: high — [evidence](evidence/sel-pass-order-deterministic-under-fixed-inputs.md).
I enumerated every `HashMap` and `HashSet` construction in `transform.rs:1-7510`
and checked each use site; all are membership or lookup. Every ordered artifact
uses `BTreeMap`, `BTreeSet`, or an explicit total sort.
Existing check: `transform.rs` inline tests around `new_caveman_units`
(`:25479-25490`, `:25684`) assert unit contents but not cross-process order
stability. None of them runs in CI.
Impact: A divergence changes frozen bytes between two passes over identical
inputs, which busts the provider prefix cache and, because the frozen unit is
then re-supplied with different bytes, trips
`validate_reduction_monotonicity` (`:6813-6826`) and fails the pass.
Open questions: None.

### sel-eligibility-reads-process-local-scheduler-state

Type: safety
Reachability: default-production — `lib.rs:8309-8312` populates
`observed_last_response_at_ms`, `historian_active`, and `wrapup_active` from
process-local structures on the ordinary transform path.
Status: active
Exercised: not yet — no test drives two `McHandler` instances against one store
and compares the selected pass class for the same request.
Guarantee: The pass class and sub-pass eligibility for a firing are a function
of the request and the durable store row only, or else every process-local input
that changes them is recorded durably so a second process reaches the same
decision.
Check: `always` — on each pass, assert that the inputs which decide the pass
class are all derivable from the request plus the loaded row. These semantics
because the module's own header calls the transform's decisions store-derived and
caller-independent (`transform.rs:655-658`), and any pass may be the one that
diverges.
Fault/timing angle: The window is a fresh process, or a second process sharing
the store. `observed_last_response_at_ms` returns `None` for a session until
this process records a response (`lib.rs:4460-4483`), and `None` sets
`last_response_time_ms = 0`, which disables both the idle-TTL HARD
(`scheduler.rs:429-431`) and the TTL arm of `should_execute` (`:476-478`,
`:498`).
Required faults and enabling state: Restart the module process, or run a second
module against the same store, then issue a transform for a session whose
durable `last_committed_pass_at_ms` is older than the cache TTL. The first pass
in the new process must not fire the idle HARD.
Confidence: high — [evidence](evidence/sel-eligibility-reads-process-local-scheduler-state.md).
I traced all four process-local `ProducerContext` fields to their producers and
confirmed `observed_last_response_at_ms` deliberately discards the durable
anchor it reads (`lib.rs:4470-4482`).
Existing check: none found for the cross-process case. `lib.rs` has tests that
set `execute_threshold_percentage: 65.0` directly (`:16488`, `:16561`, `:16753`)
and bypass the resolution path.
Impact: A daemon restart silently suppresses the idle-TTL fold for one pass per
session, so deferred work waits an extra turn. In a shared-store deployment the
two processes disagree about whether a pass busts, which produces two different
frozen renders for the same conversation state.
Open questions:
- Is discarding the durable `last_committed_pass_at_ms` anchor at `lib.rs:4482` intentional conservatism, or an oversight? The code reads the anchor, stores it in the observation, and returns `None` anyway. (needs human input)

### sel-budget-execute-threshold-unvalidated-from-request

Type: safety
Reachability: default-production — the OpenCode plugin sends
`effective_execute_threshold` on every pass
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2009`), and
`lib.rs:8298-8299` prefers it over the clamped route config unconditionally.
Status: active
Exercised: not yet — no test sends a non-finite or out-of-range
`effective_execute_threshold` and asserts either a rejection or a clamp.
Guarantee: The execute threshold that reaches the selection ceiling is finite
and inside `[1, 90]`, matching the range the module's own config enforces.
Check: `always` — assert
`ctx.execute_threshold_percentage.is_finite() && (1.0..=90.0).contains(&ctx.execute_threshold_percentage)`
at the top of the selection region. `always` because the value is read on every
pass and a bad value is not a transient condition, it is a stuck configuration.
Fault/timing angle: none. It is a single unvalidated field read per pass.
Required faults and enabling state: A host or a compromised plugin that sends
`effective_execute_threshold` as `NaN`, a negative, or a value above 90. The
serde field is `Option<f64>` with no validator (`transform.rs:707-709`, wire
mirror `:924`), so any JSON number arrives intact.
Confidence: high — [evidence](evidence/sel-budget-execute-threshold-unvalidated-from-request.md).
`execute_threshold_or` (`lib.rs:1710-1712`) is a bare `unwrap_or`; I confirmed
config.rs clamps its own value (`:568-570`) and the request path does not go
through that code.
Existing check: `scheduler.rs:461-464` sanitizes for the scheduler only.
`scheduler.rs:1127` has a `resolve_execute_threshold` table test. Neither covers
the request field. None runs in CI.
Impact: `NaN` propagates through `clamp` at `transform.rs:4231` into
`ceiling_tokens`, so every ceiling comparison in the selector is false and
pressure-driven reclaim silently stops. A value above 90 makes the selection
ceiling admit more history than any pass class will ever bust to reclaim.
Open questions:
- Does any comparison in `selection.rs` treat a `NaN` ceiling as unbounded rather than as zero? Resolving this decides whether the failure mode is "never reclaims" or "reclaims everything". Unresolved, needs a read of the ceiling comparisons in `selection.rs`.

### sel-budget-ceiling-clamp-diverges-from-scheduler-cap

Type: safety
Reachability: default-production — both clamps execute on every
compaction-enabled pass.
Status: active
Exercised: not yet — no test asserts that the ceiling used by the selector and
the threshold used by the band logic derive from the same number.
Guarantee: The selection ceiling and the scheduler band threshold are computed
from the same effective threshold value, so a pass cannot select reductions
against a budget the scheduler would never authorize.
Check: `always` — assert that the percentage used at `transform.rs:4231` equals
the threshold `scheduler::resolve_execute_threshold` produced for the same pass.
`always` because both are computed on every pass and the disagreement is
structural, not situational.
Fault/timing angle: none.
Required faults and enabling state: An effective threshold above 90. That is
reachable only via the unvalidated request field, so this record shares its
enabling state with `sel-budget-execute-threshold-unvalidated-from-request`; it
is recorded separately because the defect is the divergent cap, not the missing
validation.
Confidence: high — [evidence](evidence/sel-budget-ceiling-clamp-diverges-from-scheduler-cap.md).
Verified both clamp sites: `transform.rs:4231` uses `clamp(1.0, 100.0)`,
`scheduler.rs:464` uses `min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)` where that
constant is `90.0` (`scheduler.rs:17`).
Existing check: none found.
Impact: The selector believes it has up to ten percent more usable window than
the scheduler will ever declare pressure over, so the age-reclaim batch it sizes
can be larger than the band that authorized the pass. The observable symptom is
over-dropping on a force pass.
Open questions:
- Is the 100 in `clamp(1.0, 100.0)` deliberate, on the theory that the ceiling is a raw window fraction rather than a scheduler threshold? The comment above the call (`transform.rs:4204-4206`) explains a different point and does not address the cap. (needs human input)

### sel-skip-unobservable-when-producer-gate-closed

Type: safety
Reachability: default-production — `producer_gate` is evaluated on every
compaction-enabled pass and is false on every plain defer without a hard
advisory, which is the common steady state.
Status: active
Exercised: not yet — no test asserts that a skipped selection emits a
distinguishable diagnostic.
Guarantee: When an eligible reduction is not selected because a gate closed, the
reason is observable from the response or the emitted diagnostics.
Check: `always` — assert that on any pass where the durable pending-drop queue
is non-empty and no reduction was applied, the response or the timing line names
the gate that closed. `always` rather than `unreachable` because the forbidden
condition is a *state* (a skip with no diagnostic), not a code location that must
not execute; METHOD.md's first check-semantics rule applies directly.
Fault/timing angle: none. The window is any defer pass with queued work.
Required faults and enabling state: Queue an agent drop through
`handle_agent_drops_value`, then issue a transform whose usage is below the
execute threshold, whose cache is warm, and which has no hard advisory. That
gives `producer_gate == false` and `SelectionOutcome::default()`, whose four
counters are `None` (`selection.rs:1096-1104`).
Confidence: high — [evidence](evidence/sel-skip-unobservable-when-producer-gate-closed.md).
I read the whole gate region (`transform.rs:4098-4258`) for logging and found
none, checked `format_pass_timing_line` (`:1317-1360`) field by field, and
confirmed the counters are only committed when `commit_required`
(`:5560-5562`, else arm `:5600-5601`).
Existing check: `transform.rs:15795`
`producer_gate_runs_on_execute_force_and_hard_advisory_never_plain_defer` covers
the gate's truth table, not its observability. It does not run in CI.
Impact: An operator watching a session whose queued drops never apply has no
signal distinguishing "gate closed by design" from "selector ran and found
nothing" from "selector crashed and returned default". The scope map records
silent skips as a recurring finding in this repo, and this is one.
Open questions:
- Should the four supersession counters be committed even when `commit_required` is false, given that a no-op defer is exactly the pass an operator most wants explained? (needs human input)

### sel-queued-drop-drains-within-cache-ttl-window

Type: liveness
Reachability: default-production — the idle-TTL fire is the default drain path;
`DEFAULT_CACHE_TTL_MS` is `5 * 60 * 1000` (`scheduler.rs:23`) and applies
whenever the `cache_ttl` string fails to parse (`:810-812`).
Status: active
Exercised: not yet — no test queues a drop, holds usage below the threshold, and
polls to a bound.
Guarantee: A durably queued agent drop whose target stays in the live tail is
applied within one cache-TTL interval of quiet, measured from the last observed
response, and not deferred indefinitely.
Check: `sometimes` for the drain, with a bounded fault-free window: queue a
drop, stop issuing pressure, then poll passes until the configured `cache_ttl`
plus one pass has elapsed and assert the drop applied. The bound is stated in the
unit the code bounds, `cache_ttl` milliseconds
(`scheduler.rs:810-812`, `:429-431`), never an unbounded eventually, per
METHOD.md's liveness rules.
Fault/timing angle: The window is the interval between the last recorded
response observation and the next pass. Two things can hold the gate shut past
the bound: `last_response_time_ms == 0` after a process restart
(`lib.rs:4482`), which disables the TTL predicate entirely, and
`ordinary_historian_veto` (`transform.rs:4098-4104`), which suppresses the
ordinary Execute arm while a historian lease is held.
Required faults and enabling state: One queued pending-drop row, usage below the
execute threshold on every pass, no `soft_refresh_pending`, an initialized
session, and no historian lease. Then advance the clock past the TTL.
Confidence: medium — [evidence](evidence/sel-queued-drop-drains-within-cache-ttl-window.md).
The gate chain and the TTL predicate are verified. I have not verified that a
drop surviving a `consumed_pending_drop_ids` pass stays durable across an
arbitrary number of defers; `:6735-6779` retires rows on coverage or reasoning
grounds, and I did not enumerate every retirement path.
Existing check: `transform.rs:23678-23690` exercises a pending drop across a
"false-window" case. No test bounds the drain time. It does not run in CI.
Impact: An agent that called `ctx_reduce` sees its reclaim never take effect,
with no diagnostic (see `sel-skip-unobservable-when-producer-gate-closed`), and
the context keeps growing until pressure forces a pass.
Open questions:
- Is the historian veto bounded for this purpose? `ctx.wrapup_active` is documented as bounded by `historian::MAX_WRAPUP_REQUEST_BUDGET` (3,800 seconds, `transform.rs:604-606`), but `ctx.historian_active` has no stated bound at this call site. Unresolved, needs the 4a lens's finding on historian lease duration.

### sel-divergence-repair-bounded-by-three-pending-passes

Type: liveness
Reachability: default-production — the divergence counter is evaluated on every
non-subagent compaction-enabled pass (`transform.rs:3925-3947`).
Status: active
Exercised: partial — `transform.rs:20699`, `:20750`, and `:20769` iterate the
limit constant and assert escalation, but none of them holds
`historian_active` or `wrapup_active` true across the window.
Guarantee: A detected boundary-coverage divergence is repaired by a recut within
`BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` passes that are taken outside a
legitimate publication window, and the pending count neither escapes that bound
nor resets without a repair.
Check: `sometimes` with a bounded window of three passes: construct the
divergence, take three passes with no historian or wrapup lease held, and assert
the recut fired. Three attempts is the unit the code bounds (`transform.rs:85`),
so the bound is stated in that unit rather than in wall-clock time.
Fault/timing angle: The count is frozen, not incremented, while
`ctx.historian_active || ctx.wrapup_active` (`:3924-3928`). A process that holds
a historian lease across many passes therefore takes an unbounded number of
passes without advancing toward repair, and the three-pass bound is a bound on a
subsequence, not on the pass sequence.
Required faults and enabling state: A coverage gap with a missing or stale
applied-compartment watermark, so `divergence_candidate` is `Some` and
`compartment_revision_matches` is false, plus no `divergence_inputs_moved`.
Confidence: high — [evidence](evidence/sel-divergence-repair-bounded-by-three-pending-passes.md).
I read the full counter expression and the recut filter; the freeze arm is the
first arm of the `if` at `:3926-3928`, so it takes priority over both the
increment and the reset.
Existing check: three inline tests named above, none in CI.
Impact: A genuinely damaged row waits indefinitely while a historian lease is
held. The comment at `:3919-3923` argues this is deliberate, so the property
under test is whether the "bounded by the wrapup budget" claim holds for the
`historian_active` half too.
Open questions:
- The comment at `transform.rs:3919-3923` bounds the wait by the wrapup request budget, but the freeze condition ORs in `ctx.historian_active`, which that budget does not cover. Is the historian lease independently bounded? Unresolved, needs the 4a lens.

### sel-cas-retry-budget-bounded-tag-hydration-unbounded

Type: safety
Reachability: default-production — `load_cached_tags` is called on every
compaction-enabled pass (`transform.rs:3391`) and the CAS loop wraps every pass
(`:2261-2300`).
Status: active
Exercised: not yet — no test drives concurrent tag mutation against
`load_cached_tags` to force repeated retries.
Guarantee: Every retry loop on the pass path has an explicit attempt budget, so
a firing terminates whether or not concurrent writers are converging.
Check: `always` — assert on entry to each retry loop that an attempt counter
exists and is bounded. `always` because a loop with no counter is a static
property of the code, true or false on every execution.
Fault/timing angle: The window is a concurrent tag-table writer. `load_cached_tags`
retries when the `can_append` fast path fails its post-read verification
(`:7677`) or when the full reload's summary does not match the rows read
(`:7684-7695`). Both arms `continue` with no counter, so a writer that mutates
tags faster than the read converges spins the pass thread inside a store loop.
Required faults and enabling state: Two writers on one store, or a single
process where tag mints from another route interleave with a transform pass on
this route. The store generation advances via SQLite triggers
(`:7513-7514`), so any tag mutation invalidates the summary.
Confidence: high — [evidence](evidence/sel-cas-retry-budget-bounded-tag-hydration-unbounded.md).
The CAS bound at `:2284` and the unbounded loop at `:7641` are both read at
`HEAD`. I did not construct the livelock; the claim is about the missing counter,
which is verifiable statically.
Existing check: `MAX_CAS_RETRIES` has no dedicated test I located.
`transform.rs:2303-2322` installs an attempt hook used by CAS-conflict tests.
Nothing exercises the tag-hydration loop under contention.
Impact: A transform pass can hang without a timeout, holding whatever locks the
handler took. The dispatch wedge detector in `lib.rs:353-508` exists for exactly
this class of symptom, which suggests hangs on this path have been seen.
Open questions:
- Is the tag-hydration loop provably convergent because each retry observes a strictly newer generation? The `can_append` arm requires `generation - self.generation == appended` (`:7539`), which does not obviously monotonically progress. Unresolved, needs a convergence argument or a counter.

### sel-caveman-deeper-tier-growth-panics-in-production

Type: safety
Reachability: explicit-config-only — the config default is
`CavemanConfig { enabled: false, .. }` (`config.rs:74-79`, `false` at `:76`).
The shipped setup path agrees: the OpenCode plugin sends
`caveman_enabled: !isSubagent && deps.cavemanTextCompression?.enabled === true`
(`rust-mode-transform.ts:2015-2016`), and the Claude Code leg copies the same
config field at `lib.rs:186`. The request serde default is also `false`
(`transform.rs:729-731`). So both the config default and the shipped path are
off unless a user opts in.
Status: active
Exercised: partial — `transform.rs:25463-25490`, `:25606`, `:25660-25684` set
`caveman_min_chars = 1` and drive `new_caveman_units`, but none constructs a
deeper tier whose output is longer than the shallower frozen payload.
Guarantee: Deepening a caveman tier never produces a longer payload than the
tier already frozen for that block, and if it could, the pass does not panic.
Check: `always` — assert the size relation before the payload choice at
`transform.rs:6370`. `always` because the assertion is on the pass path and
fires on the first violating block; there is no tolerated window.
Fault/timing angle: none. It is a single comparison per candidate block.
Required faults and enabling state: A text block for which
`caveman::compress(source, Ultra)` is longer than
`caveman::compress(source, Full)`, or than whatever depth is already frozen,
plus caveman enabled and the block inside the eligible tag window. Because the
compression is always applied to the persisted original (`:6338-6340`) rather
than to the intermediate, the relation is a property of `caveman.rs`'s level
ladder, not of the transform.
Confidence: medium — [evidence](evidence/sel-caveman-deeper-tier-growth-panics-in-production.md).
The `assert!` is verified at `:6366-6369` and is a hard assert, not
`debug_assert!`, so it is live in release. I did not audit `caveman.rs` (651
lines, 40 tests, owned by 4e) to establish whether a growing deeper tier is
constructible, so the reachability of the panic itself is unresolved.
Existing check: the caveman tests named above. None runs in CI.
Impact: A panic inside `apply_once` on a user-opted-in feature. The pass does not
commit, and whether the panic escapes to the host or is caught depends on the
dispatch path, which is 4c and 4d territory.
Open questions:
- Can `caveman::compress` at a deeper level ever produce more bytes than at a shallower level for the same input? Unresolved, needs a read of `caveman.rs`'s level ladder or a property test over it.
- CONFIGURATION.md:740 claims repeated tier shifts "converge to exactly the same output as direct compression at the final depth", but `transform.rs:6370-6374` keeps the shallower bytes when the deeper tier ties on length while still recording the deeper depth. Both sides cited; see the contract-vs-code leads section.

### sel-caveman-eligibility-ladder-deterministic-over-frozen-basis

Type: safety
Reachability: explicit-config-only — same evidence as
`sel-caveman-deeper-tier-growth-panics-in-production`: config default `false`
(`config.rs:76`), shipped path sends `=== true` only
(`rust-mode-transform.ts:2015-2016`), request serde default `false`
(`transform.rs:729-731`).
Status: active
Exercised: partial — `transform.rs:25479-25490` asserts the empty and non-empty
cases; `:25752-25760` covers the protected-window exclusion. No test asserts that
a same-pass tag mint cannot change the eligible population.
Guarantee: The caveman eligible population and each block's target depth are
determined by the tag basis frozen in this pass's own commit, so a tag minted
during the same pass cannot change which blocks are compressed or how deeply.
Check: `always` — assert that every candidate's tag number is at or below
`caveman_age_basis_tag`, and that the position ladder is computed over the sorted
candidate list. `always` because the basis is captured on every bust pass and a
leak would corrupt the frozen bytes for that pass.
Fault/timing angle: The window is a bust pass that also mints new tags.
`age_basis_tag` is the max *hydrated* tag number (`:4492-4497`), taken before the
mint suffix is appended, and it is persisted in `meta.caveman_age_basis_tag` in
the same commit. On a non-bust pass the prior durable value is reused
(`:4499-4501`).
Required faults and enabling state: Caveman enabled, a primary session, a bust
pass, and at least one new tag minted in that same pass so the hydrated and
final tag sets differ.
Confidence: high — [evidence](evidence/sel-caveman-eligibility-ladder-deterministic-over-frozen-basis.md).
The gate, the basis capture, the explicit `sort_by((tag_number, block_id))` at
`:6344`, and the position ladder at `:6283-6297` are all read at `HEAD`.
Existing check: the caveman tests named above, none in CI.
Impact: A basis leak makes the compressed set depend on mint timing, so two
passes over the same conversation produce different frozen caveman payloads and
bust the prefix cache.
Open questions:
- `caveman_target_depth` (`:6283-6297`) partitions by fractional position, so adding one candidate can shift every other candidate's tier. The units are keyed by block id and depth, and a deeper tier is allowed. Does a candidate that moves *shallower* (because the population grew) leave a stale deeper unit frozen? `:6355-6358` skips when `target_depth <= existing_depth`, which suggests yes by design. Unresolved, needs confirmation that a stale deeper unit is intended.

### sel-protected-tags-not-read-from-module-config

Type: safety
Reachability: default-production for the Claude Code leg. The evidence for both
sides: `config.rs` contains zero occurrences of `protected_tags`
(verified with `grep -c`), so the module config default does not exist; and the
shipped Claude Code setup path, `apply_claude_code_config_controls`
(`lib.rs:173-193`), sets five request fields and omits `protected_tags` and
`clear_reasoning_age`, so those fall back to the serde defaults `20`
(`transform.rs:893-895`) and `50` (`:119`, `:861-863`). The OpenCode leg does
send both (`rust-mode-transform.ts:2031`, `:2014`), so this is leg-specific.
Status: active
Exercised: not yet — `lib.rs:18142-18155` asserts the caveman fields are applied
but does not assert anything about `protected_tags`.
Guarantee: A user-configured `protected_tags` and `clear_reasoning_age` take
effect on every transport leg, or a misconfiguration on a leg that ignores them
is reported.
Check: `always` — assert that the effective `protected_tags` used by the
selection region equals the configured value for the bound route. `always`
because the value is read on every pass; a leg that ignores it ignores it
always.
Fault/timing angle: none. It is a missing field assignment.
Required faults and enabling state: A user config setting `protected_tags` to
something other than 20, on a Claude Code route. The Claude Code leg does not
carry these controls in its request, which is the stated reason
`apply_claude_code_config_controls` exists at all (`lib.rs:181-182`).
Confidence: high — [evidence](evidence/sel-protected-tags-not-read-from-module-config.md).
`grep -c protected_tags crates/mc-module/src/config.rs` returns 0, and I read
the full body of `apply_claude_code_config_controls`.
Existing check: `lib.rs:18123-18170` has three
`apply_claude_code_config_controls` cases. None asserts `protected_tags`. None
runs in CI.
Impact: `protected_tags` is safety-relevant: it is the count of newest tags
immune from dropping, and it feeds `newest_active_tag_block_ids`
(`transform.rs:4177-4182`) and `caveman`'s protected cutoff (`:6318`). A user who
raises it to protect recent work gets the default 20 on the Claude Code leg with
no warning, so content they expected to be protected becomes eligible for
reduction. This is a misconfiguration that silently weakens a safety-relevant
gate, which is exactly the configuration failure mode the lens brief asked for.
Open questions:
- Is `protected_tags` intended to be host-owned rather than module-config-owned? CONFIGURATION.md:165 documents it as a module config key with a default of 20 and a range of 1 to 100, which argues the module should read it. (needs human input)

### sel-per-model-and-token-thresholds-inert-in-module

Type: safety
Reachability: default-production — `scheduler_config` is called on both
`scheduler::decide` paths (`transform.rs:2814`, `:3973`) and always builds the
same shape.
Status: active
Exercised: not yet — no Rust test asserts that a config carrying
`execute_threshold_tokens` or an object-valued `execute_threshold_percentage`
changes the module's decision.
Guarantee: The documented `execute_threshold_tokens` map and the object form of
`execute_threshold_percentage` either affect the module's pass decision, or a
config carrying them is reported as ignored.
Check: `always` — assert that the `SchedulerConfig` handed to
`scheduler::decide` reflects the parsed config's threshold shape. `always`
because the config is resolved once per route and read on every pass, so the
condition never varies within a route's life.
Fault/timing angle: none.
Required faults and enabling state: A user config that sets
`execute_threshold_tokens` or an object-valued `execute_threshold_percentage`,
on a route whose threshold is not overridden by the request's
`effective_execute_threshold`. That is the Claude Code leg, which
`lib.rs:181-182` describes as route-config-authoritative.
Confidence: high — [evidence](evidence/sel-per-model-and-token-thresholds-inert-in-module.md).
`scheduler_config` hardwires `execute_threshold_tokens: None`
(`transform.rs:6109`) and `ExecuteThresholdConfig::Percentage`
(`:6106-6108`); `McModuleConfig` has no tokens field (`config.rs:82-116`); and
`number_at` (`:631-636`) returns `None` for an object with no warning, while the
neighbouring project-tier keys do warn (`:576-583`).
Existing check: `scheduler.rs:1127` table-tests `resolve_execute_threshold`
directly, and `scheduler.rs:1056-1061` pins the two constants against a golden.
Neither reaches the config or transform path. The TypeScript leg does implement
the feature and has its own tests. None of the Rust tests run in CI.
Impact: A user who sets a per-model token threshold to work around a provider
that limits effective prompt size below its advertised window
(the exact use case CONFIGURATION.md:321 gives) gets no effect on the Claude Code
leg and no warning. The consequence is compaction firing at the wrong point, and
on the paths described in `docs/specs/context-window-geometry.md` that means
provider overflow.
Open questions:
- Is the intended design that the host always resolves the threshold and sends `effective_execute_threshold`, making the module's own config a pure legacy fallback? If so, `config.rs`'s threshold parsing and `CONFIGURATION.md`'s documentation of the object and tokens shapes are both describing a TypeScript-only feature, and the module's silent drop is correct but undocumented. (needs human input)

## Contract-vs-code leads

Each lead cites both sides. None is resolved in the documentation's favour.

1. **`execute_threshold_tokens` is documented as a module config key with a
   clamp and a warn log, and the Rust module does not implement it.**
   Doc: `CONFIGURATION.md:168` ("Optional absolute-tokens variant ... Clamped to
   `90% × context_limit` with a warn log") and `:319-338`. Code:
   `McModuleConfig` has no such field (`config.rs:82-116`), nothing in
   `config.rs` mentions it, and `scheduler_config` passes `None`
   (`transform.rs:6109`). The clamp and the deduplicated warn log exist only in
   TypeScript (`packages/plugin/src/hooks/magic-context/event-resolvers.ts:283-299`).
   The scope map's open question about configuration docs claiming behaviour with
   no implementing code applies here, narrowed: the behaviour exists, but on the
   other side of the wire, and the doc does not say so.

2. **`execute_threshold_percentage` is documented as accepting an object, and an
   object is silently dropped.** Doc: `CONFIGURATION.md:167` ("`number` (20–90)
   or `object` ... Supports per-model maps") and the example at `:791`. Code:
   `config.rs:430-431` and `:515-517` read it with `number_at`, which is
   `as_f64` filtered to finite (`:631-636`); an object yields `None` and the
   default `65.0` survives with no warning. `ExecuteThresholdConfig::ByModel`
   exists in `scheduler.rs:112-113` but is never constructed by the module.

3. **The documented lower bound is 20, the enforced lower bound is 1.** Doc:
   `CONFIGURATION.md:167` says `number (20–90)`. Code: `config.rs:568-570`
   clamps to `[1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE]` where the constant is
   `90.0` (`:28`). The upper bound matches; the lower does not.

4. **`protected_tags` is documented as a module config key and the module has no
   such config.** Doc: `CONFIGURATION.md:165` (`number (1–100)`, default `20`)
   and the example at `:795`. Code: zero occurrences in `config.rs`;
   `apply_claude_code_config_controls` (`lib.rs:173-193`) does not set it; the
   only source is the request's serde default `20` (`transform.rs:893-895`).

5. **Caveman tier convergence is documented as exact, and the code keeps the
   shallower bytes on a length tie.** Doc: `CONFIGURATION.md:740` ("repeated
   tier shifts converge to exactly the same output as direct compression at the
   final depth"). Code: `transform.rs:6370-6374` keeps
   `existing.frozen_payload` when `compressed.len() == existing.frozen_payload.len()`
   while still minting the unit at the deeper depth (`:6378`). The in-code
   comment at `:6366-6368` acknowledges this as matching TypeScript's persisted
   depth behaviour, so the divergence is between the code's own comment and
   CONFIGURATION.md, not within the code.

6. **Caveman is documented with no failure mode, and the code carries a live
   `assert!`.** Doc: `CONFIGURATION.md:720-744` describes caveman with no
   mention of a panic. Code: `transform.rs:6366-6369` is a bare `assert!`, not
   `debug_assert!`, so it is enabled in release builds regardless of the
   `debug-assertions` profile setting.

7. **`selection.rs` and `boundary.rs` declare purity, and the transform's pass
   decision reads process-local state.** Doc: the part-4 scope map records
   `selection.rs` as "pure deterministic" and `boundary.rs` as claiming "no I/O,
   no wall clock, no store access, and no ambient cache state"
   (`_lenses/scope-map-and-risk-ranking.md:313`, `:314`). Code: the *inputs*
   those pure functions receive are assembled from
   `ctx.observed_last_response_at_ms` (`lib.rs:4460-4483`),
   `ctx.historian_active`, `ctx.wrapup_active`, and `ctx.now_ms`
   (`lib.rs:8309-8312`), plus a process-global tag cache
   (`transform.rs:7639-7696`). The purity claim is about the functions, and it
   holds; the claim a reader is likely to draw from it, that the pass decision
   is reproducible from the request and the store, does not.

8. **`ProducerContext.model_key` says production supplies `None`, and it does
   not.** Doc: `transform.rs:588-590` ("Per-model overrides are deferred, so
   production currently supplies None"). Code: `lib.rs:8308` sets
   `model_key: binding.model_key.clone()`, and `SessionBinding.model_key` is
   `Option<String>` populated at bind (`lib.rs:165`). The comment is stale, and
   it matters because `model_key` is the key `resolve_execute_threshold` would
   use for a per-model walk (`scheduler.rs:452`, `:457`).

## Open questions

- Should a never-executed test count as `Exercised: partial`? The scope map
  raised this for all of Part 4
  (`_lenses/scope-map-and-risk-ranking.md:681`) and it is unresolved. Every
  `Exercised:` line above that says `partial` names an inline test in
  `transform.rs` or `lib.rs` that CI does not run
  (`_lenses/scope-map-and-risk-ranking.md:414`, `:427`). I used `partial` only
  where a test constructs the situation, and `not yet` otherwise, but a ruling
  would change several lines. (needs human input)
- Is `apply_once` supposed to have a wall-clock or token budget at all? Five
  budget units are enforced and none of them bounds the pass's own duration. The
  dispatch wedge detector at `lib.rs:353-508` implies a hang is a known concern.
  If a pass deadline is intended, `load_cached_tags`'s unbounded loop is the
  first place it is missing. (needs human input)
- What is `ctx.historian_active`'s maximum duration? Two records above
  (`sel-queued-drop-drains-within-cache-ttl-window`,
  `sel-divergence-repair-bounded-by-three-pending-passes`) need it to state a
  bound, and `transform.rs:601-603` documents the flag without a duration.
  Unresolved, needs the 4a lens's finding.
- Does `selection.rs` treat a `NaN` `ceiling_tokens` as unbounded or as zero?
  This decides the direction of the failure in
  `sel-budget-execute-threshold-unvalidated-from-request`. Unresolved, needs a
  read of `selection.rs`'s ceiling comparisons, which are 4f territory.
- Is the Claude Code leg's config authority intended to cover the full set of
  selection parameters? `lib.rs:181-182` states route config is "the only
  authority for this transport leg", but the function sets five fields and omits
  at least two that the selection region reads. (needs human input)
