# sel-per-model-and-token-thresholds-inert-in-module

## Discovery trigger

Task 7 asks to check `docs/` for configuration documentation describing transform
or pass behaviour, and warns that a prior pass found configuration docs in this
repository claiming behaviour with no implementing code. `CONFIGURATION.md` gives
`execute_threshold_tokens` a full section with a clamp, a warn log, and a
fall-through rule. I traced each of those claims into the Rust module.

## Evidence trail

The documented behaviour. `CONFIGURATION.md:168`:

> `execute_threshold_tokens` | `object` (per-model map) | — | **Optional
> absolute-tokens variant of `execute_threshold_percentage`.** Per-model map (e.g.
> `{ "default": 150000, "github-copilot/gpt-5.2-codex": 40000 }`). When set for a
> model, overrides the percentage-based threshold for that model. Clamped to
> `90% × context_limit` with a warn log. Requires a resolvable context limit —
> falls through to percentage if unavailable.

Expanded at `:319-338`, including `:335` ("Tokens wins: when a matching entry
exists for the current model, it overrides the percentage-based threshold for that
model") and `:338` (the fall-through on an unknown context limit).

And `CONFIGURATION.md:167` for the percentage form:

> `execute_threshold_percentage` | `number` (20–90) or `object` | `65` | ...
> Supports per-model maps.

with an object-valued example at `:791`.

What the scheduler implements. `scheduler.rs` has both shapes:
`ExecuteThresholdConfig::{Percentage, ByModel}` (`:106-115`),
`ExecuteThresholdTokensConfig` (`:117-122`), and `SchedulerConfig` carrying
`execute_threshold_tokens: Option<ExecuteThresholdTokensConfig>` (`:132`) whose doc
comment says "Optional absolute-token threshold config; wins when a context limit
is known" (`:131`). `resolve_execute_threshold` (`:434-465`) implements the
documented precedence exactly: tokens first when a finite positive context limit is
present (`:441-451`), the `90%` cap as
`limit * (MAX_EXECUTE_THRESHOLD_PERCENTAGE / 100.0)` (`:445`), and the fall-through
to percentage otherwise, with `ByModel` resolved by
`resolve_percentage_match(values, model_key)` (`:459`).

So the algorithm exists. Three things make it unreachable from the transform path.

**One: the transform hardwires the shape.** `scheduler_config`
(`transform.rs:6104-6111`):

```
fn scheduler_config(execute_threshold_percentage: f64) -> SchedulerConfig {
    SchedulerConfig {
        execute_threshold_percentage: ExecuteThresholdConfig::Percentage(
            execute_threshold_percentage,
        ),
        execute_threshold_tokens: None,
    }
}
```

Its only parameter is an `f64`, so `ByModel` cannot be constructed, and
`execute_threshold_tokens` is literally `None`. Both call sites pass
`ctx.execute_threshold_percentage`: `:3973` inside `apply_once` and `:2814`
inside `apply_additive_only`.

**Two: the module's config does not model tokens.** `McModuleConfig`
(`config.rs:82-116`) has `pub execute_threshold_percentage: f64` (`:85`) and no
tokens field. Searching `config.rs` for `execute_threshold_tokens`,
`ExecuteThresholdConfig`, `ByModel`, and `by_model` returns nothing.

**Three: an object value is dropped without a warning.** The parse is
`if let Some(threshold) = number_at(user, "/execute_threshold_percentage")`
(`config.rs:430-431`) and the project-tier equivalent at `:515-517`.
`number_at` (`:631-636`) is:

```
fn number_at(value: &Value, pointer: &str) -> Option<f64> {
    value.pointer(pointer).and_then(Value::as_f64).filter(|v| v.is_finite())
}
```

`Value::as_f64` on a JSON object returns `None`, so the `if let` does not fire and
the default `65.0` (`:122`, constant at `:19`) survives. No warning is pushed.
`config.rs` does have a warning channel and uses it five times for ignored
project-tier keys via `warn_ignored_project_key` (`:576-583`, called at `:521` and
`:548-567`), so the silence here is a gap rather than an absence of mechanism.

Where the documented behaviour does live. The TypeScript leg implements all of it.
`packages/plugin/src/hooks/magic-context/event-resolvers.ts:267-300` is
`resolveExecuteThresholdDetail`: it checks `options?.tokensConfig` and
`isFinitePositive(options.contextLimit)` (`:281`), resolves a per-model match
(`:283`), clamps with `const cap = contextLimit * (MAX_EXECUTE_THRESHOLD / 100)`
(`:285`), and emits the documented warn log, deduplicated per
`(session, modelKey, value, cap)` tuple (`:288-297`). The wrapper
`resolveExecuteThreshold` (`:386-392`) returns only the resolved percentage, and
that scalar is what `rust-mode-transform.ts:2009` sends as
`effective_execute_threshold`.

So the module receives a pre-resolved number and never sees the shapes. On the
OpenCode and Pi legs that is coherent. On the Claude Code leg it is not, because
`apply_claude_code_config_controls` (`lib.rs:181-182`) states route config "is the
only authority for this transport leg", and that leg does not send
`effective_execute_threshold` at all, so `execute_threshold_or`
(`lib.rs:1710-1712`) falls through to `binding.config.execute_threshold_percentage`,
the scalar that `config.rs` parsed with `number_at`.

A fourth, smaller inconsistency. `resolve_execute_threshold` takes `model_key`
(`scheduler.rs:437`) and `decide` passes `inputs.model_key.as_deref()`
(`:718`), which the transform populates from `ctx.model_key` (`:3993`). But
`ProducerContext.model_key`'s doc comment says "Per-model overrides are deferred,
so production currently supplies None" (`transform.rs:588-590`), while
`lib.rs:8308` sets `model_key: binding.model_key.clone()`. The comment is stale.
It does not change behaviour today, because `ByModel` is never constructed, but it
would mislead anyone wiring the per-model path.

## Failure scenario

A user runs Claude Code against a provider whose effective prompt limit is well
below its advertised window. That is not hypothetical: it is exactly the situation
`docs/specs/context-window-geometry.md` documents, where "enforcement and
advertisement are different quantities" and a path can admit or reject at a value
the catalog does not know. `CONFIGURATION.md:321` names this as the use case:
"Useful when you want a hard cap expressed in tokens rather than a percentage — for
example, when a provider limits effective prompt size below its advertised context
window."

The user writes:

```
{ "execute_threshold_tokens": { "default": 150000 } }
```

`merge_tiers` never looks for the key. `McModuleConfig` carries the default
`execute_threshold_percentage` of 65. `scheduler_config` builds
`Percentage(65.0)` with `tokens: None`. The scheduler bands fire at 65 percent of
the advertised window, which is above the provider's real limit. The pass does not
compact in time and the provider rejects the request.

The recovery path then engages: `req.provider_error` is set, `scheduler.rs`'s
overflow patterns (`:36-58`) match, `emergency_recovery_armed` promotes a Defer to
`Emergency95` (`:761-763`). So the system does eventually recover, but through the
overflow path rather than the configured threshold, and the user saw a failed
request. No warning ever told them their configuration was inert.

The object-valued percentage variant is quieter still: a user who writes
`"execute_threshold_percentage": { "default": 70, "anthropic/claude-opus-5": 55 }`
gets 65 on every model.

## Timing windows and dependencies

None. The config is resolved at route bind and the shape is fixed at
`scheduler_config`'s signature. The condition persists for the life of the
configuration.

## What a test must construct

Three assertions, all cheap and all failing today on the Claude Code leg.

1. Parse a config containing `execute_threshold_tokens` and assert either that the
   resulting `SchedulerConfig` carries it or that `merge_tiers` returned a warning
   naming the key. `merge_tiers` already returns `(cfg, warnings)`
   (`config.rs:572`), so the warning channel is available.
2. Parse a config whose `execute_threshold_percentage` is an object and assert the
   same.
3. End to end: bind a Claude Code route with a tokens config and a known context
   limit, drive a pass at a usage that the tokens threshold would treat as
   pressure and the percentage threshold would not, and assert the pass class.

`config.rs:930-968` shows the existing tier-merge test shape, and
`config.rs:814-839` shows the existing threshold tests, including
`:830-833` which asserts the project-tier raise-only rule and the 90 clamp. Adding
an object-valued case to that group is a two-line change.

## Investigation log

### Q: Is the module's own config threshold a legacy fallback by design?

- Sources examined: `transform.rs:707-709` (the request field's doc comment,
  "Absence means the host did not send a value, so older hosts fall back to
  route-bind configuration"), `lib.rs:1708-1709` (the same framing on
  `execute_threshold_or`: "Prefer the request's host-resolved threshold. `None`
  specifically means an older host did not send the field, so the caller's trusted
  config remains the compatibility fallback"), `lib.rs:8296-8299` (the comment
  "Bind-time scalar config is only the old-host compatibility fallback"),
  `lib.rs:181-182` (the Claude Code leg's route-config authority claim).
- Findings: Three comments describe the module's config threshold as a legacy
  fallback, and one describes route config as the sole authority for Claude Code.
  Those two framings are in tension: if route config is the only authority for a
  currently shipping leg, it is not legacy. The word "scalar" at `lib.rs:8297` is
  telling: the author knew the bind-time value is a scalar and the host's is
  resolved, which is exactly the gap.
- Missing evidence: whether the Claude Code leg is expected to send
  `effective_execute_threshold` in a future version. `docs/` holds no transform
  specification (`_lenses/scope-map-and-risk-ranking.md:685-700`), and the five
  `docs/plans/` files that mention `mc-module` do so tangentially.
- Conclusion: needs human input. Either `CONFIGURATION.md` should mark
  `execute_threshold_tokens` and the object form as harness-resolved and note that
  the Claude Code leg does not support them, or `config.rs` should parse them and
  `scheduler_config` should take the parsed shape instead of an `f64`.

### Q: Does the additive path have the same gap?

- Sources examined: `transform.rs:2813-2814` inside `apply_additive_only`'s region
  (`:2711-3219`); `:3972-3973` inside `apply_once`. These are the only two
  `scheduler::decide` call sites in the crate.
- Findings: Both `scheduler::decide` call sites use `scheduler_config(...)` with
  the same scalar, so the gap is identical on the compaction-disabled path.
- Missing evidence: none.
- Conclusion: resolved with answer. The record's guarantee covers both call sites.
