# dec-a-execute-threshold-lower-bound-is-documented-20-and-enforced-1

## Discovery trigger

Task 5 asks whether each documented default matches the code default and whether
each documented bound has implementing code. Task 7 asks specifically to check
`docs/` because a prior pass found configuration documentation claiming behaviour
with no implementing code. Part 4b's `portfolio-evaluation.md:390` already
identified this exact divergence as gap `G4` and recorded that "no record covers
it, and it is the one of the four where the code silently accepts a value the
documentation forbids rather than silently ignoring a key". `config.rs` is 4f
scope, so this lens owns the record.

## Evidence trail

The documented contract. `CONFIGURATION.md:167`:

> `execute_threshold_percentage` | `number` (20–90) or `object` | `65` | Context
> usage that forces queued ops to execute. Capped at 90% of the output-reserved
> safe window, leaving about 10% for mid-turn input growth. Supports per-model
> maps.

Two bounds are stated. The upper bound has implementing code and a reason.
`config.rs:26-28`:

```
/// Maximum execute threshold percentage (90.0). Output capacity is already reserved
/// from the usable window, leaving the final 10% for mid-turn input growth.
const MAX_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 90.0;
```

The default matches too. `config.rs:17-19` declares
`DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 65.0` with the comment that it "must
stay identical to packages/plugin/src/config/schema/magic-context.ts", and
`McModuleConfig::default` uses it at `:122`.

The lower bound has no implementing code. The only clamp is
`config.rs:568-570`:

```
cfg.execute_threshold_percentage = cfg
    .execute_threshold_percentage
    .clamp(1.0, MAX_EXECUTE_THRESHOLD_PERCENTAGE);
```

`1.0`, not `20.0`. The parse that feeds it is `number_at(user,
"/execute_threshold_percentage")` at `:430-432` and the project-tier raise-only
comparison at `:515-519`. `number_at` (`:631-636`) accepts any finite `f64`, so
`5` and `0.5` both survive to the clamp and both come out above it: `5` unchanged,
`0.5` raised to `1.0`.

No warning is pushed. `warn_ignored_project_key` (`:575-581`) exists and is called
five times (`:520`, `:538`, `:539`, `:540`, `:556`, `:561`), so the mechanism is
available; it is simply not used for value validation.

What the resolved value then does. `lib.rs:8296-8299` puts it on the producer
context, and `transform.rs:6104-6111`'s `scheduler_config` wraps it as
`ExecuteThresholdConfig::Percentage`. `scheduler::resolve_execute_threshold`
(`:434-465`) rejects only two shapes at `:462-464`:

```
if !resolved.is_finite() || resolved < 0.0 {
    resolved = fallback;
}
resolved.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
```

`0.0` is neither non-finite nor negative, so it survives. `should_execute`
(`:466-503`) then compares at `:492`:

```
if usage.percentage >= threshold {
    return BaseDecision::Execute;
}
```

With `threshold` at `0.0`, every non-zero usage reading is an Execute. With
`threshold` at `5.0`, essentially every real session is an Execute from its first
few messages.

The band derivation absorbs a low threshold safely.
`scheduler::escalation_bands` (`:187-198`) computes
`MIN_FORCE_MATERIALIZE_PERCENTAGE.max(threshold + 2.0)`, so a threshold of `5`
still leaves the force band at `85`. The damage is confined to the execute
decision, which is the cache-bust decision.

## Failure scenario

A user reads `CONFIGURATION.md:167`, sees the range `20–90`, and decides they want
Magic Context to compact aggressively. They misread the semantics and write
`"execute_threshold_percentage": 15`, believing a lower number means less
intervention. The documentation says `15` is out of range, so they expect either a
rejection or a clamp to `20`.

`config.rs` accepts `15` verbatim. Every pass from about 15 percent context usage
onward returns `BaseDecision::Execute`, which is the class that busts the provider
prefix cache and re-renders. The user's sessions become far more expensive rather
than less, and nothing in the module's output says the configured value was out of
range, because there is no range.

The floor case is worse in kind rather than degree: `"execute_threshold_percentage":
0` yields a resolved threshold of `1.0` from `config.rs` (clamped up) but `0.0`
from any path that reaches `scheduler::resolve_execute_threshold` without the
config clamp, and at `0.0` the comparison at `scheduler.rs:492` is true for every
positive usage.

## Timing windows and dependencies

None. The configuration is resolved at route bind through
`McHandler::effective_config` (`lib.rs:4427-4436`) and re-resolved on each
historian prepare, reattach, and wrapup call (`lib.rs:4624`, `:4864`, `:5229`,
`:6773`, `:11947`). The mtime cache in `read_tier_cached` (`config.rs:254-266`)
means the value is stable for the life of the file.

## What a test must construct

Cheap. `config.rs:829-835` is the existing shape:

```
#[test]
fn project_threshold_may_only_raise() {
    let user = serde_json::json!({ "execute_threshold_percentage": 70 });
    let project = serde_json::json!({ "execute_threshold_percentage": 91 });
    let cfg = merge_tiers(Some(&user), Some(&project));
    assert_eq!(cfg.execute_threshold_percentage, 90.0);
}
```

Add the mirror case: a user tier of `5`, and assert either
`cfg.execute_threshold_percentage == 20.0` or that
`merge_tiers_with_warnings` returned a warning naming
`/execute_threshold_percentage`. `merge_tiers_with_warnings` already returns the
pair (`:373-376`, `:572`), so the warning channel is reachable from a test without
touching production code.

A second assertion is worth adding at the scheduler layer: a
`SchedulerConfig` with `Percentage(0.0)` and a usage reading of `1.0` percent, and
assert the resulting `BaseDecision`. That documents the floor behaviour
independently of the config clamp.

## Investigation log

### Q: Should `config.rs` enforce `20` or should the documentation be corrected?

- Sources examined: `CONFIGURATION.md:167` and its expansion at `:319-338`;
  `config.rs:17-19` and `:26-28` (both constants carry comments tying them to the
  TypeScript schema); `scheduler.rs:15-17`, which declares its own
  `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE` and `MAX_EXECUTE_THRESHOLD_PERCENTAGE`
  with the same values; part-4b `evidence/sel-budget-ceiling-clamp-diverges-from-scheduler-cap.md`,
  which found a third clamp at `transform.rs:4230-4232` using `100.0`.
- Findings: the upper bound is asserted in three places with the same value and a
  stated reason; the lower bound is asserted only in prose. `config.rs:17-18`
  says the default "must stay identical" to the TypeScript schema, which implies
  the schema is the authority for the range too, but that file is outside this
  lens's scope and this record does not assert what it contains.
- Missing evidence: whether `packages/plugin/src/config/schema/magic-context.ts`
  declares a minimum of `20`. If it does, the Rust module is the divergent side
  and `config.rs` should enforce it. If it does not, the documentation is wrong on
  both legs.
- Conclusion: needs human input. The defect is established either way; only the
  direction of the fix is open.

### Q: Is the low threshold reachable on a default build?

- Sources examined: `config.rs:430-432` (user tier), `:515-519` (project tier,
  raise-only, so a project cannot lower it below the user value), `:568-570`;
  `lib.rs:4427-4436`, `:8296-8299`.
- Findings: reachable only from an explicit configuration key. The project tier
  cannot introduce it, because `:516` requires `project_threshold >
  cfg.execute_threshold_percentage`. So the user tier is the only entry point.
- Missing evidence: none.
- Conclusion: resolved with answer. Reachability is `explicit-config-only`, with
  the evidence being that both parse sites require the key to be present and the
  default `65.0` is inside the documented range.
