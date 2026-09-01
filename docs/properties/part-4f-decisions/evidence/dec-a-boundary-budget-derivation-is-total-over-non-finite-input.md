# dec-a-boundary-budget-derivation-is-total-over-non-finite-input

## Discovery trigger

Task 2 names the target directly: Part 3 found three totality defects in a sibling
crate's decay function where an infinite input produced a not-a-number result that
broke a documented invariant, and asks for the analogue here. `boundary.rs`'s header
makes a determinism claim over "caller-provided context", and every quantity in that
context is an `f64` supplied by a host that reads provider usage numbers. So the
analogue, if it exists, lives in the boundary derivations.

## Evidence trail

The claim under test. `boundary.rs:5-9`:

```
//! All token measurement in this unit is a pure function of caller-provided
//! message/block bytes and caller-provided context. There is no I/O, wall clock,
//! store access, or ambient cache state here: the same inputs always produce the
//! same boundary and trigger decision.
```

Three derivations carry the arithmetic.

**One: the trigger budget.** `boundary.rs:337-346`:

```
pub fn derive_trigger_budget(context_limit: f64, execute_threshold_percentage: f64) -> f64 {
    if !context_limit.is_finite() || context_limit <= 0.0 {
        return TRIGGER_BUDGET_MIN;
    }
    let threshold_fraction = execute_threshold_percentage.max(0.0) / 100.0;
    let usable = context_limit * threshold_fraction;
    let derived = (usable * TRIGGER_BUDGET_PERCENTAGE).round();
    derived.clamp(TRIGGER_BUDGET_MIN, TRIGGER_BUDGET_MAX)
}
```

`context_limit` is guarded at `:339`. `execute_threshold_percentage` is **not**
guarded by an `is_finite` check, only by `.max(0.0)` at `:342`. That is the line the
Part 3 defect class predicts would break, and it does not, because `f64::max`
returns the non-NaN operand when one argument is NaN. I executed
`f64::NAN.max(0.0)` and it is `0.0`. So a NaN threshold produces
`threshold_fraction == 0.0`, `usable == 0.0`, `derived == 0.0`, and the clamp at
`:345` returns `TRIGGER_BUDGET_MIN`. The output stays inside the declared range for
every possible pair of inputs, including `(INFINITY, NAN)`.

Constants: `TRIGGER_BUDGET_PERCENTAGE = 0.05` (`:38`), `TRIGGER_BUDGET_MIN = 5_000.0`
(`:39`), `TRIGGER_BUDGET_MAX = 50_000.0` (`:40`). `clamp` cannot panic here because
both bounds are constants with `min < max`.

**Two: the protected-tail token target.** `boundary.rs:362-401`. This one guards
both inputs explicitly, `:363-372`:

```
let safe_context_limit = if ctx.context_limit.is_finite() && ctx.context_limit > 0.0 {
    ctx.context_limit
} else {
    128_000.0
};
let safe_threshold = if ctx.execute_threshold_percentage.is_finite() {
    ctx.execute_threshold_percentage.max(0.0)
} else {
    65.0
};
```

and then computes with `.round().max(1.0)` at `:373-375`, `clamp_percentage` at
`:376`, and a chain of `min`/`max` at `:381-390` that ends with
`let n = ceiling_n.min(effective_floor.max(raw_n));` at `:391`. `ceiling_n` is
`1.0_f64.max(...)` at `:385`, so `n >= 1.0` unconditionally.

**Three: the usage clamp.** `boundary.rs:926-931`:

```
fn clamp_percentage(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}
```

The `is_finite` pre-check is load-bearing: `f64::clamp` returns NaN when `self` is
NaN, so without this guard a NaN usage would propagate into
`raw_n = (usable * ALPHA * (1.0 - usage / 100.0)).round()` at `:382`.

**The one unvalidated float.** `check_compartment_trigger_with_index`
(`boundary.rs:751-882`) takes the caller's budget as-is at `:756-761`:

```
let trigger_budget = ctx.boundary.trigger_budget.unwrap_or_else(|| {
    derive_trigger_budget(
        ctx.boundary.context_limit,
        ctx.boundary.execute_threshold_percentage,
    )
});
```

and `derive_protected_tail_token_target` does the same at `:380-382`. So a caller
passing `Some(f64::NAN)` bypasses every guard. Tracing where it would go:

- `scan_budget = MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE.max(trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER)`
  (`:779-780`). `f64::max` absorbs the NaN, so `scan_budget == 6_000.0`. Confirmed by
  executing `f64::NAN.max(5.0)`.
- `chunk.tokens >= trigger_budget` (`:852`) and
  `chunk.tokens >= trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER` (`:857`) are both
  false for NaN, so the commit-cluster and tail-size arms simply do not fire.
- `headroom = (trigger_budget + reserve).min((usable * 0.5).floor())` (`:384`).
  `f64::min` absorbs the NaN, so `headroom` is finite.
- `progress.tail_size_bar = trigger_budget * TAIL_SIZE_TRIGGER_MULTIPLIER` (`:803`)
  would be NaN, and `TriggerProgress` is a diagnostics structure. That is the only
  place a NaN could surface.

Production never passes `Some`. `lib.rs:4957` inside `prepare_historian_fire`:

```
trigger_budget: None,
```

and `rg trigger_budget crates/mc-module/src` finds `Some` only at `lib.rs:16495`
(`Some(4_000.0)`) and `lib.rs:16760` (`Some(10_000.0)`), both inside the
`#[cfg(test)]` module that begins at `lib.rs:16001`. So the defect class exists in
shape and is unreachable in fact.

**Unsigned arithmetic.** Every subtraction on an unsigned type in `boundary.rs` is
guarded, which I checked individually:

- `:901-902` `Some(boundary.eligible_head.end - 1)` is inside
  `if boundary.eligible_head.end > boundary.eligible_head.start`, and `start` is a
  `u64`, so `end >= 1`.
- `:606` `live_ordinals[live_ordinals.len() - keep]` is inside
  `if live_ordinals.len() <= keep { offset } else { ... }` at `:603-606`.
- `:1142` and `:1185` `hi = mid - 1` are both preceded by an `else if mid == 0 { break }`
  arm at `:1140-1141` and `:1183-1184`.
- `:1076` `self.ordinals[index - 1]` is inside `if index == 0` at `:1072-1075`.
- `:1132` `hi = self.prefix.len() - 1` is safe because `prefix` always holds at
  least the `0.0` pushed at `:1043`.

## Failure scenario

There is no failure today, which is the finding. The record exists to fix the
boundary so that a regression is visible.

The shape a regression would take: someone adds a new derived quantity to
`derive_protected_tail_token_target` using bare arithmetic instead of the
`min`/`max` chain, for example `let x = usable / usage;`. With `usage` clamped to
`[0, 100]` that is a division by zero producing infinity, and infinity would then
flow into `n`. Because `n` is the protected-tail token target, an infinite `n`
sends `find_suffix_start_for_tokens` (`:1118-1148`) down its `total < target` arm at
`:1128-1129` and returns `first_ordinal`, meaning the whole session becomes
protected tail and nothing is ever compactable. That is a silent liveness failure of
the compaction mechanism, not a crash.

The reachable half of the hazard is the `trigger_budget` passthrough. If a future
change makes any production caller pass `Some(value)` from a host-supplied number,
the guards are bypassed and `TriggerProgress.tail_size_bar` becomes the first
observable NaN. `serde_json` cannot serialize a NaN `f64`, so the diagnostics field
would either become `null` or fail to serialize, depending on how it is emitted.

## Timing windows and dependencies

None. All three derivations are pure functions of their arguments. The one external
dependency is the token estimator threaded as `&mut dyn FnMut(&str) -> usize`
(`:683`, `:754`), whose determinism belongs to Part 3
(`part-4-module/_lenses/scope-map-and-risk-ranking.md:670`).

## What a test must construct

A table test over non-finite inputs, which is the cheapest possible property test
here because all three functions are pure and take scalars.

1. `derive_trigger_budget` over the cross product of
   `{0.0, -1.0, f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 128_000.0}` and
   `{0.0, -5.0, 65.0, 1e300, f64::NAN}`, asserting the result is finite and in
   `[5000.0, 50000.0]`. Twenty-five cases, one assertion each.
2. `derive_protected_tail_token_target` over a `BoundaryContext` with each of
   `context_limit`, `execute_threshold_percentage`, `usage_percentage`, and
   `usage_input_tokens` set to `NAN` and to `INFINITY` in turn, asserting
   `target.n.is_finite() && target.n >= 1.0` and that `usable`, `raw_n`, `floor_n`,
   `ceiling_n`, `headroom`, and `reserve` are all finite.
3. `clamp_percentage` over the same non-finite set, asserting the result is in
   `[0.0, 100.0]`.
4. The `trigger_budget` passthrough: `check_compartment_trigger` with
   `trigger_budget: Some(f64::NAN)` and a non-empty message set, asserting that the
   returned `TriggerProgress.tail_size_bar` is finite. That case fails today, which
   is why the record's open question asks whether the field should be validated.

`boundary.rs` already has the fixture machinery: `:2002-2046` builds trigger cases
from golden data and `:2226-2227` asserts constants, so the table tests slot in
beside them.

## Investigation log

### Q: Should `check_compartment_trigger_with_index` validate `ctx.trigger_budget`?

- Sources examined: `boundary.rs:756-761` and `:380-382` (both `unwrap_or_else`
  sites); `boundary.rs:222-224` (the `trigger_budget` field declaration on
  `BoundaryContext`); `lib.rs:4957` (production `None`); `lib.rs:16495` and `:16760`
  (test-only `Some`).
- Findings: every other float on `BoundaryContext` is validated at its point of use,
  so the omission is inconsistent rather than reasoned. The field exists so a caller
  can pin the budget, which tests use to make assertions stable; production derives
  it. A one-line `.filter(|b| b.is_finite() && *b > 0.0)` on the `Option` would close
  it without changing any current behaviour.
- Missing evidence: whether any out-of-crate caller constructs a `BoundaryContext`.
  `BoundaryContext` is `pub` (`boundary.rs:263` for `TriggerContext`, and the
  boundary context above it), and `boundary` is a `pub mod` per `lib.rs:1-37`, so an
  external consumer is possible in principle.
- Conclusion: needs human input. The record states the property; whether to add the
  guard is a design decision.

### Q: Is the `f64::max`/`f64::min` NaN absorption argument sound?

- Sources examined: the three sites that depend on it, `boundary.rs:342`, `:779-780`,
  `:384`.
- Findings: executed `f64::NAN.max(0.0)`, `f64::NAN.min(5.0)`, and
  `(f64::INFINITY + 1.0).min(5.0)` and got `0.0`, `5.0`, and `5.0`. So both
  operations return the non-NaN operand and infinity is bounded by a following
  `min`. The argument holds for these exact expressions.
- Missing evidence: none. This is a language-level guarantee and the execution
  confirms the version in use behaves as documented.
- Conclusion: resolved with answer. The absorption is what makes the unguarded
  `.max(0.0)` at `:342` safe, and a reviewer who does not know that would read the
  line as a defect.
