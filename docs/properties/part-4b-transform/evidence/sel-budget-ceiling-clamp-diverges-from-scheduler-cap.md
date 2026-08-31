# sel-budget-ceiling-clamp-diverges-from-scheduler-cap

## Discovery trigger

While tracing the execute threshold for
`sel-budget-execute-threshold-unvalidated-from-request` I found the same number
clamped twice, to two different upper bounds, inside one pass. That is a separate
defect from the missing validation: even a well-behaved host cannot make the two
consumers agree, because they disagree by construction whenever the input exceeds
90.

## Evidence trail

The single input. `ProducerContext.execute_threshold_percentage`, set once at
`lib.rs:8298-8299` and read twice in `apply_once`.

Read one, at `transform.rs:3973`:

```
config: scheduler_config(ctx.execute_threshold_percentage),
```

`scheduler_config` (`:6104-6111`) wraps it unchanged. `scheduler::decide` then
calls `resolve_execute_threshold` (`scheduler.rs:716-722`), whose last line is
`resolved.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)` (`:464`) with the constant
`90.0` (`:17`). The doc comment on `SchedulerConfig.execute_threshold_percentage`
states the contract directly: "Percentage threshold config, capped by
[`MAX_EXECUTE_THRESHOLD_PERCENTAGE`]" (`scheduler.rs:129`).

Read two, at `transform.rs:4230-4232`:

```
ceiling_tokens: context_limit_tokens
    * ctx.execute_threshold_percentage.clamp(1.0, 100.0)
    / 100.0,
```

Upper bound `100.0`. Ten percentage points above the constant that the scheduler
side documents as the cap.

The module's own config agrees with the scheduler, not with the ceiling.
`config.rs:568-570` clamps the parsed value to
`[1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE]` where that file's private constant is
also `90.0` (`config.rs:28`). `CONFIGURATION.md:167` documents the same bound and
gives the reason: "Capped at 90% of the output-reserved safe window, leaving
about 10% for mid-turn input growth."

So three of four sites agree on 90 and the selection ceiling does not.

The comment immediately above the selector call does not address the cap. It
reads: "No per-request gate here: producer_gate already requires
tail_reclaim_enabled, which is the profile default..."
(`transform.rs:4203-4206`). The nearest explanatory comment,
`:4128-4130` ("Hard advisory requests use the normal Execute path so queued work
can be processed during the fold, but only context pressure reported by the
scheduler enables age reclaim"), is about the pass class, not the ceiling.

Reachability of a value above 90. The clamped config path cannot produce one
(`config.rs:568-570`), and the shipped TypeScript path cannot either
(`packages/plugin/src/hooks/magic-context/event-resolvers.ts:283-300` clamps to
the same constant). Only the unvalidated request field can
(`lib.rs:1710-1712`). That is why this record shares enabling state with
`sel-budget-execute-threshold-unvalidated-from-request` and is recorded
separately: fixing the validation would hide this defect without correcting it,
and a future caller that legitimately wants a 95 percent ceiling would then get
one budget capped and one not.

## Failure scenario

A host sends `effective_execute_threshold: 95.0`, either as a deliberate
aggressive setting or as a bug. The scheduler resolves it to `90.0`, so the
execute band fires at 90 percent usage and the force band at 85
(`scheduler.rs:19`). The selection ceiling is computed from `95.0`, so the
selector sizes its age-reclaim batch against a window five percent larger than
the one the scheduler is defending. On the force pass that follows, the batch the
selector considers acceptable leaves less headroom than the band was designed to
preserve, and `CONFIGURATION.md:167`'s stated ten percent mid-turn input
allowance is consumed.

The reverse direction is also possible with an infinite input:
`f64::INFINITY.clamp(1.0, 100.0)` is `100.0`, so the ceiling becomes the whole
context limit while the scheduler still caps at 90.

## Timing windows and dependencies

None. Both clamps run on every compaction-enabled pass, in the same pass, from
the same variable.

## What a test must construct

Two assertions over one pass. First, the invariant: for a range of
`effective_execute_threshold` inputs including 65, 90, 95, and `1e9`, assert that
the percentage used at `transform.rs:4231` equals
`scheduler::resolve_execute_threshold(&scheduler_config(input), model_key, 65.0, None, Some(limit))`.
Second, the behavioural consequence: with input 95 and a usage just under 90
percent, assert the selector's batch size against the batch it produces with
input 90. The existing `scheduler.rs:1127` table test for
`resolve_execute_threshold` gives the expected-value side for free.

## Investigation log

### Q: Is `clamp(1.0, 100.0)` deliberate?

- Sources examined: `transform.rs:4226-4256` (the whole `SelectionContext`
  construction), the comments at `:4203-4206` and `:4128-4130`,
  `scheduler.rs:17`, `:129`, `:464`, `config.rs:28`, `:568-570`,
  `CONFIGURATION.md:167`.
- Findings: No comment anywhere explains the 100. Every other site that bounds
  this quantity uses 90 and at least two of them state a reason. The `1.0` lower
  bound matches `config.rs:570` exactly, which suggests the pair was copied from
  the config clamp and the upper bound changed, or that the author read the
  ceiling as a raw window fraction where 100 is the natural bound.
- Missing evidence: No commit message or design note was consulted; the lens
  brief scopes this to the code and `docs/`. `docs/` holds no transform
  specification (the part-4 scope map resolved that at
  `_lenses/scope-map-and-risk-ranking.md:685-700`), so there is no external
  source to check against.
- Conclusion: needs human input. The divergence is verified; the intent is not
  recoverable from the code or the documentation.

### Q: Could the ceiling legitimately want a different cap from the band?

- Sources examined: `selection.rs:180-210` for how `ceiling_tokens` sits beside
  `current_total_input_tokens` and `scheduler_pressure_execute`.
- Findings: The context carries both the ceiling and
  `scheduler_pressure_execute` (`transform.rs:4241`), so the selector already
  knows whether the scheduler declared pressure. That argues the ceiling is meant
  to be the same window the scheduler is defending, not an independent one.
- Missing evidence: The selector's use of the two together was not read.
- Conclusion: unresolved, needs the 4f lens. The argument above is suggestive,
  not conclusive.
