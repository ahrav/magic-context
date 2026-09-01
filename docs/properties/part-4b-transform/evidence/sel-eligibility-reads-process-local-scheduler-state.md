# sel-eligibility-reads-process-local-scheduler-state

## Discovery trigger

Task 1 asks whether pass selection is pure or reads mutable state. The module
header presents the transform as deriving its decisions from durable state:
"from its own durable state, never caller-supplied (a caller-supplied value would
be a poison surface)" (`transform.rs:655-657`). I traced every
`ProducerContext` field the selection region reads back to its producer in
`lib.rs` to test that reading.

## Evidence trail

`ProducerContext` is built once per transform at `lib.rs:8278-8320`. Four of its
fields are process-local, not request-derived and not store-derived:

1. `observed_last_response_at_ms` (`lib.rs:8309-8310`). Its producer is
   `McHandler::observed_last_response_at_ms` (`lib.rs:4460-4483`). The body reads
   a process-local `scheduler_observations` map (`:4461-4464`). On a hit it
   returns `observation.observed_in_process.then_some(observation.last_response_at_ms)`
   (`:4466-4468`), so an entry whose `observed_in_process` is false yields
   `None`. On a miss it reads the durable anchor
   `state.meta.last_committed_pass_at_ms` (`:4470-4474`), inserts it into the map
   with `observed_in_process: false` (`:4475-4481`), and then returns `None`
   (`:4482`). The durable anchor is read and discarded.

2. `historian_active` (`lib.rs:8311`), documented at `transform.rs:601-603` as
   "True while this process has a historian firing/awaiting/validation/publish
   lease".

3. `wrapup_active` (`lib.rs:8312`), documented at `transform.rs:604-606` as
   owning "this session's process-local round latch".

4. `now_ms` (`lib.rs:8296`), the wall clock for the pass.

Where each reaches the eligibility decision:

- `observed_last_response_at_ms` becomes `SessionMeta.last_response_time_ms`
  in `SchedulerInputs` (`transform.rs:3979-3983`), mapping `None` to `0` via
  `.map(..).unwrap_or(0)`. Two predicates read it. `ttl_hard_expired`
  (`scheduler.rs:429-431`) is `last_response_time_ms > 0 && now - last > ttl`, so
  zero disables the idle-TTL HARD entirely. `should_execute` returns
  `BaseDecision::Defer` immediately when
  `usage.percentage == 0.0 && session.last_response_time_ms == 0`
  (`scheduler.rs:476-478`).
- `historian_active` is one of five conjuncts in `ordinary_historian_veto`
  (`transform.rs:4098-4104`), which forces `selection_class` to
  `PassClass::Defer` (`:4131-4135`) and removes the ordinary-Execute arm from
  `independent_bust_opportunity` (`:4293-4295`).
- `wrapup_active` ORs with `historian_active` into
  `active_legitimate_publication_window` (`transform.rs:3924`), which freezes the
  boundary-divergence pending count (`:3926-3928`) and blocks the recut
  (`:3943-3946`).

A fifth process-local input is the tag baseline cache. `load_cached_tags`
(`transform.rs:7639-7696`) reads a process-global
`static tag_baseline_cache()` (`:7597-7600`). Its output, `tag_rows`, feeds
`tag_tokens_by_block` (`:4136-4144`), the tag-window protection set
(`:4168-4183`), and the caveman age basis (`:4492-4497`). The cache is bounded by
`TAG_BASELINE_CACHE_BUDGET_BYTES` (`:144`), so an eviction changes which path
`load_cached_tags` takes, though the verified reload arms (`:7671-7678`,
`:7684-7695`) are intended to make the result path-independent.

## Failure scenario

The daemon restarts. A session that has been idle for ten minutes issues a
transform. `observed_last_response_at_ms` misses the in-process map, reads the
durable `last_committed_pass_at_ms` (which is ten minutes old and would satisfy
the TTL), stores it with `observed_in_process: false`, and returns `None`. The
scheduler sees `last_response_time_ms = 0`, so `ttl_hard_expired` is false and
the idle HARD does not fire. If usage is also below the execute threshold,
`should_execute` may return `Defer`. `producer_gate` is then false unless a hard
advisory holds, so no reduction is selected and any queued drop waits another
pass. Nothing in the response or the timing line names the cause.

The shared-store variant is worse: two module processes against one store, one
holding a historian lease and one not, reach different `ordinary_historian_veto`
values for the same request and store row, so one busts and one defers. Because
the bust renders and freezes bytes, the two processes produce two different
frozen renders for the same conversation state.

## Timing windows and dependencies

The window opens at process start and closes, per session, at the first
`record_response_observation` call (`lib.rs:4485`). It reopens on every restart.
The shared-store window is the duration of a historian lease, which
`transform.rs:601-603` does not bound.

## What a test must construct

Build an `McHandler`, commit a pass so `last_committed_pass_at_ms` is set,
advance the clock past the cache TTL, then construct a *fresh* handler over the
same store and issue a transform. Assert on `response.materialize_reason`: the
idle HARD would report `"ttl_expired"` via `classify_materialize_reason`
(`transform.rs:12561-12613`), so its absence is the observable. The shared-store
case needs two handlers and a way to hold a historian lease on one, which
`with_producer_factory` (`lib.rs:3676-3770`) supports.

## Investigation log

### Q: Is discarding the durable anchor at `lib.rs:4482` intentional?

- Sources examined: `lib.rs:4460-4483` in full;
  `record_response_observation` (`:4485`); the `SchedulerObservation` struct
  (`lib.rs:3378-3381` per the scope map's region table); the doc comment on
  `ProducerContext.observed_last_response_at_ms`
  (`transform.rs:592-594`), which says "None disables TTL-hard even if durable
  metadata has an older sparse commit anchor".
- Findings: The doc comment states the behaviour explicitly, so the discard is
  deliberate. It does not state the cost, which is one suppressed idle fold per
  session per process lifetime.
- Missing evidence: No comment or test explains why an in-process observation is
  required rather than trusting the durable anchor. The phrase "sparse commit
  anchor" suggests the anchor is only written on committing passes
  (`transform.rs:5556-5558` sets it only when `state_changed`), so it can lag the
  real last response. That is a plausible reason but not a stated one.
- Conclusion: needs human input. The behaviour is intentional; whether the cost
  is intended is a design question.

### Q: Does the tag baseline cache change selection between a hit and a miss?

- Sources examined: `transform.rs:7639-7696`, `:7516-7546` (`matches` and
  `can_append`), `:7551-7595` (the cache and its LRU).
- Findings: Both non-fast paths re-verify against a freshly read
  `tag_cache_summary` before returning (`:7672-7678`, `:7684-7695`), so a
  successful return should carry the same rows either way.
- Missing evidence: The `can_append` fast path returns
  `entry.tags ++ tail` without re-reading the prefix, so it assumes the prefix
  rows are immutable. The header claims immutability (`:7511-7515`, "One
  immutable session baseline"), enforced by SQLite triggers advancing a
  generation. A prefix row mutation that leaves count and max unchanged would not
  be detected by `can_append`'s arithmetic. I did not verify the trigger set.
- Conclusion: unresolved, needs the trigger definitions in `mc-store` and a
  statement of which tag columns are mutable after insert.
