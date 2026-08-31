# core-decay-newest-compartment-tier-floor

## Discovery trigger

The decay module's own test suite opens with
`newest_compartment_is_tier_1` (`crates/mc-core/src/decay.rs:154-162`), whose
comment reads "index 1 → a = 0 → z = 0 → tier 1, for any importance/pressure."
The phrase "for any pressure" is a universal claim, but the loop body only
iterates `p` over `[0.1, 1.0, 5.0]`. That gap between the stated universal and
the sampled particular is what prompted checking the arithmetic at the edges of
the `f64` domain rather than the middle.

## Evidence trail

The kernel, read line by line at HEAD `ed487e11`:

- `crates/mc-core/src/decay.rs:65` — `let a = (compartment_index.max(1) - 1) as f64;`
  For `compartment_index` of 0 or 1 this is exactly `0.0`.
- `crates/mc-core/src/decay.rs:67` — `let p = budget_pressure.max(P_FLOOR);`
  Rust's `f64::max` returns the non-NaN operand when one is NaN, so a NaN
  pressure becomes `0.1`. It does **not** cap the upper end, so `+inf` passes
  through unchanged.
- `crates/mc-core/src/decay.rs:68-69` — `f = 2^((imp - 50)/D)`, then
  `h = (H50 * f) / p`. With `p = +inf` and finite `H50 * f`, `h` is exactly
  `0.0`.
- `crates/mc-core/src/decay.rs:70` — `a / h`. With `a = 0.0` and `h = 0.0`
  this is `0.0 / 0.0`, which is IEEE-754 NaN.
- `crates/mc-core/src/decay.rs:79-89` — the tier ladder is a chain of `<`
  comparisons. Every comparison against NaN is false, so control reaches the
  final `else` arm and returns `5`.
- `crates/mc-core/src/decay.rs:103` — `z >= Z4 + G * o` with `z = NaN` is also
  false, so `should_archive` returns `false`.
- `crates/mc-core/src/decay.rs:115-123` — `rendered_tier` therefore skips the
  archive return at `:121` and evaluates `tier(..).min(4)`, which is
  `5.min(4) = 4`.

I extracted `clamp_importance`, `z_value`, `tier`, `should_archive`, and
`rendered_tier` verbatim into a scratch crate outside the repository (no repo
files touched) and measured the boundary row directly:

```
p=inf:  z=NaN  tier=5  archive=false  rendered=4
p=NaN:  z=0    tier=1  archive=false  rendered=1
p=MAX:  z=0    tier=1  archive=false  rendered=1
p=0:    z=0    tier=1  archive=false  rendered=1
p=-inf: z=0    tier=1  archive=false  rendered=1
idx=2, p=inf: z=inf tier=5 archive=true rendered=5
```

So the failure is specific to `index <= 1` combined with `pressure = +inf`.
Every other pathological pressure is absorbed by the `P_FLOOR` floor.

Reachability of the enabling input, `pressure = +inf`:

- `crates/mc-core/src/decay.rs:130-145` — `compute_budget_pressure` returns
  `(natural_cost / history_budget).max(P_FLOOR)`. The early return at `:131-133`
  only catches `history_budget <= 0.0`.
- Measured in the same scratch program: `history_budget = 5e-324` and
  `history_budget = f64::MIN_POSITIVE` both yield `p = inf` for a 200-element
  compartment slice. `history_budget` of NaN or `+inf` both yield `0.1`.
- `crates/mc-module/src/decay_render.rs:278-282` gates the call on
  `history_budget > 0.0`, which a positive subnormal satisfies.

So the input is reachable through the public API without any direct
non-finite argument, provided a subnormal budget can arrive.

## Failure scenario

A render pass computes a budget pressure of `+inf` because the effective
history budget arrived as a positive subnormal (a division underflow upstream,
a misparsed configuration value, or a multiplier that drove the budget to
almost zero at `crates/mc-module/src/memory_render.rs:304`). The curve is then
evaluated for every compartment. Compartments at index 2 and beyond get
`z = +inf` and archive, which is the sane degenerate answer. The single newest
compartment, at index 1, gets `z = NaN` and is rendered at tier 4 instead of
tier 1.

The user-visible effect is that the most recent turn of the session collapses
to an anchor-level summary while older turns vanish entirely, so the prompt
loses precisely the content the model needs most. Worse, `tier` and
`should_archive` disagree for that compartment: a consumer reading `tier`
directly sees `5` (archive candidate) while the renderer emits tier-4 bytes,
so any archival bookkeeping keyed off `tier` diverges from what was rendered.

## Timing windows and dependencies

None. `tier`, `should_archive`, and `rendered_tier` are pure `f64` arithmetic
with no interior mutability, no clock, and no shared state. There is no
interleaving to construct and no fault to inject. The entire hazard is an
input-domain hazard, which makes this one of the cheapest properties in the
part to check.

The dependency worth naming is directional: this record's enabling state is
the *output* of `core-decay-budget-pressure-range-totality`. If
`compute_budget_pressure` were constrained to return a finite value, this
failure would become reachable only by a caller passing `+inf` directly.

## What a test must construct

1. A sweep over `budget_pressure` that includes non-finite and extreme values,
   not just the three finite samples at `crates/mc-core/src/decay.rs:158`:
   `f64::INFINITY`, `f64::NEG_INFINITY`, `f64::NAN`, `f64::MAX`,
   `f64::MIN_POSITIVE`, `0.0`, `-0.0`, and a negative value.
2. For each, assert `tier(1, importance, p) == 1` and
   `rendered_tier(1, importance, p, 0.0) == 1`, with `importance` swept over
   at least `{i32::MIN, 0, 1, 50, 100, 101, i32::MAX}` to confirm the clamp at
   `crates/mc-core/src/decay.rs:57-59` is not implicated.
3. Separately assert the agreement clause: for every input,
   `tier(i, m, p) == 5` implies `should_archive(i, m, p, 0.0)` when
   `anchor_overlap` is 0. This is the clause that fails first and localises the
   defect to `z = NaN` rather than to the ladder.
4. A generator-side check that `compute_budget_pressure` never feeds a
   non-finite value into the curve, using a `history_budget` sweep that
   includes positive subnormals.

Semantics: `always`, over an input sweep. This is not `sometimes` because there
is no operational situation to reach; the function is evaluated on every pass
and the only variable is which inputs the campaign covers.

## Investigation log

### Q: Is a subnormal `history_budget` reachable from configuration?

- Sources examined: `crates/mc-core/src/decay.rs:130-145`,
  `crates/mc-module/src/decay_render.rs:278-282`,
  `crates/mc-module/src/decay_render.rs:306-314`,
  `crates/mc-module/src/memory_render.rs:304`,
  `crates/mc-module/src/m0_compose.rs:117` and `:273`.
- Findings: `history_budget_tokens` is an `f64` field on the m0 and
  memory-render input structs. At `memory_render.rs:304` it is divided by
  `decay_pressure_multiplier.max(1.0)`, so the multiplier can only shrink it,
  never grow it. Every in-tree construction site I read passes it straight
  through from a caller-supplied struct field; I did not find the config
  parsing or the bound that establishes a minimum.
- Missing evidence: the configuration surface that populates
  `history_budget_tokens`, and whether any validation rejects a value below
  one token. That code is in `mc-module` and `mc-host`, outside this lens's
  assigned files.
- Conclusion: unresolved, needs an `mc-module` config trace. The property is
  worth checking regardless, because `tier` is a public API of a library crate
  and a caller can pass `+inf` directly.

### Q: Should the API reject a non-finite `budget_pressure`?

- Sources examined: `crates/mc-core/src/decay.rs:38-39` (the `P_FLOOR`
  rationale, "prevents div-by-zero and caps relaxation at 10x"),
  `crates/mc-core/src/decay.rs:75-76` (the documented input range
  "`budget_pressure` is 0.10..∞").
- Findings: the doc at `:76` literally writes the range as open at the top,
  which reads as an intentional admission of arbitrarily large pressure. The
  `P_FLOOR` comment at `:38` shows the author reasoned carefully about the
  lower bound and about division by zero, but the `0.0 / 0.0` case arises from
  the *upper* bound driving `h` to zero, which the comment does not consider.
- Missing evidence: whether "∞" in the doc is shorthand for "unbounded above"
  or a literal admission of `f64::INFINITY`.
- Conclusion: needs human input. Either clamp `p` to a finite maximum, or
  special-case `a == 0.0` to return `z = 0.0` before the division. Both are
  one-line fixes; choosing between them is a design call and this catalog does
  not make fixes.
