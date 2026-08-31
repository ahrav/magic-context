# sel-budget-execute-threshold-unvalidated-from-request

## Discovery trigger

Task 2 asks where the firing's budget is enforced. The selection ceiling
(`transform.rs:4230-4232`) is the only token budget in the selection region, and
it is a product of a caller-supplied percentage. The lens brief also asks to
check the config default against the shipped setup path, so I traced the
percentage from the wire to both of its consumers.

## Evidence trail

The field. `TransformRequest.effective_execute_threshold: Option<f64>`
(`transform.rs:707-709`), with the doc comment "Host-resolved execute threshold
for this model and usable context geometry. Absence means the host did not send a
value, so older hosts fall back to route-bind configuration." The wire mirror is
`TransformRequestWire.effective_execute_threshold: Option<f64>`
(`transform.rs:924`), copied straight across at `:1034`. There is no `deserialize_with`,
no range attribute, and no post-parse validator.

The resolution. `lib.rs:1707-1712`:

```
fn execute_threshold_or(&self, fallback: f64) -> f64 {
    self.effective_execute_threshold.unwrap_or(fallback)
}
```

Called at `lib.rs:8298-8299` to populate
`ProducerContext.execute_threshold_percentage`. The request value wins
unconditionally over `binding.config.execute_threshold_percentage`, which is the
value `config.rs:568-570` clamped to `[1.0, 90.0]`. So the clamped path is the
fallback and the unclamped path is the default.

Consumer one, the scheduler. `scheduler_config(ctx.execute_threshold_percentage)`
(`transform.rs:3973`, definition `:6104-6111`) wraps it as
`ExecuteThresholdConfig::Percentage`. `scheduler::decide` passes it to
`resolve_execute_threshold` (`scheduler.rs:716-722`), which sanitizes:

- `if !resolved.is_finite() || resolved < 0.0 { resolved = fallback }`
  (`scheduler.rs:460-463`), fallback being
  `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE` = `65.0` (`:718`, constant at `:15`).
- `resolved.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)` (`:464`), constant `90.0`
  (`:17`).

Consumer two, the selection ceiling. `transform.rs:4230-4232`:

```
ceiling_tokens: context_limit_tokens
    * ctx.execute_threshold_percentage.clamp(1.0, 100.0)
    / 100.0,
```

`f64::clamp` propagates `NaN`: the standard library documents that it returns
`NaN` if `self` is `NaN`. So a `NaN` threshold produces a `NaN` ceiling. A
threshold of `1e9` produces a ceiling of `1e7 * context_limit`, because the
clamp's upper bound is `100.0`, not `90.0`.

Consumer three, indirectly. `emergency_drain_exit_threshold`
(`scheduler.rs:567-572`) guards non-finite and non-positive with
`EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE` (`:27`), so it is safe. This confirms
the codebase does know to guard this value; the selection ceiling is the site
that does not.

The shipped path. `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2009`
sends `effective_execute_threshold: threshold`, where `threshold` comes from
`resolveExecuteThreshold` (`:1965`), which resolves through
`resolveExecuteThresholdDetail`
(`packages/plugin/src/hooks/magic-context/event-resolvers.ts:267-300`,
wrapper `:386-392`). That function does clamp to `MAX_EXECUTE_THRESHOLD` and
guards non-finite inputs (`:279-284`, "Junk values (NaN, negatives, zero)
silently fall through to percentage"). So on the shipped OpenCode path the value
arriving is already sanitized. The module does not depend on that.

## Failure scenario

A host bug, a plugin regression, or a hostile process on the module's socket
sends `"effective_execute_threshold": null` as a JSON number that parses to
`NaN` (for example via a serialized `NaN` in a permissive encoder), or simply
`1e9`. The scheduler sanitizes and behaves normally, so the pass class looks
correct. `ceiling_tokens` becomes `NaN` or absurdly large. Every ceiling
comparison in the selector then behaves differently from the pass class the
scheduler chose. With `NaN`, all `<` and `>` comparisons against the ceiling are
false, so the pressure-driven reclaim arm cannot fire and the session grows
until the force or emergency band takes over. With `1e9`, the ceiling never
constrains the batch, so a force pass drops more than the band intended.

Neither outcome produces an error. The response reports a normal pass class and a
normal action.

## Timing windows and dependencies

None. It is a single field read per pass. The condition persists for as long as
the host keeps sending the bad value.

## What a test must construct

Set `effective_execute_threshold` to `f64::NAN`, then to `1000.0`, then to
`-5.0`, on a request that would otherwise select at least one age-based
reduction, and assert on the resulting decision list. `transform.rs:14049` shows
a test fixture already setting `execute_threshold_percentage: 65.0` directly, so
the harness exists; the missing part is driving the request field rather than the
context field. Because the two consumers sanitize differently, the assertion
should compare the scheduler's resolved threshold against the ceiling's
percentage rather than checking either in isolation.

## Investigation log

### Q: Can a JSON payload actually deliver a non-finite f64 to serde?

- Sources examined: `TransformRequestWire` (`transform.rs:898-1007`), the custom
  `Deserialize` for `TransformRequest` (`:1009-1077`), field at `:924`.
- Findings: The field is a plain `Option<f64>` with `#[serde(default)]`. Strict
  JSON has no `NaN` literal, so `serde_json` cannot produce `NaN` from
  conforming input. A very large finite value such as `1e400` deserializes to
  `f64::INFINITY` in `serde_json`'s float path, and `1e9` is trivially
  deliverable.
- Missing evidence: I did not confirm whether the module's transport is strictly
  `serde_json` or whether any path uses a permissive encoder that admits `NaN`.
  `enforce_request_byte_cap` and `value_footprint_bound` (`lib.rs:14329-14391`)
  operate on a `serde_json::Value`, which suggests `serde_json` throughout.
- Conclusion: resolved with answer for the practical case. Infinity and
  out-of-range finite values are deliverable through conforming JSON; `NaN` is
  not, unless a non-`serde_json` encoder is in the path. The infinity case is
  enough to make the property worth checking, because
  `f64::INFINITY.clamp(1.0, 100.0)` is `100.0`, which lands above the
  scheduler's 90 cap and is therefore the same defect as the `1e9` case.

### Q: Which direction does a `NaN` ceiling fail?

- Sources examined: `selection.rs:1089-1121` for the outcome shape; the
  `SelectionContext` field list at `:180-210`.
- Findings: `ceiling_tokens: f64` is one of the context fields; I did not locate
  every comparison against it.
- Missing evidence: The comparison sites inside `select_reductions_with_outcome`
  (`selection.rs:1119` onward, roughly 160 lines) were not read; that body is
  sub-part 4f.
- Conclusion: unresolved, needs a read of `selection.rs`'s ceiling comparisons.
  The record's guarantee does not depend on the direction, only the impact
  statement does.
