# core-decay-budget-pressure-range-totality

## Discovery trigger

`compute_budget_pressure` (`crates/mc-core/src/decay.rs:130-145`) is the single
value that couples every compartment's tier decision together: it is computed
once per render pass and then fed to `rendered_tier` for every compartment
(`crates/mc-module/src/decay_render.rs:278-296`). Its only test,
`pressure_self_tunes_toward_budget` (`decay.rs:208-221`), asserts a relative
ordering (tighter budget gives higher pressure) and one lower bound. Nothing
constrains the output's range or checks that the function is total over the
`f64` budget domain. A single scalar with that much downstream leverage
deserves a totality property.

## Evidence trail

The function, read line by line:

- `crates/mc-core/src/decay.rs:131-133` — early return of `1.0` when
  `history_budget <= 0.0`. Note that a NaN budget fails this comparison
  (every comparison with NaN is false), so NaN flows past the guard.
- `crates/mc-core/src/decay.rs:134-143` — accumulates `natural_cost` by
  summing `TIER_COST[natural_tier]` for compartments whose natural tier is
  below 5. The guard at `:140` (`if natural_tier < 5`) bounds the index to
  1..=4, so the array access at `:141` into `TIER_COST`
  (`[u32; 6]`, `:42`) cannot panic. Slot 0 is documented as unused (`:41`) and
  is never read, since `tier` never returns 0.
- `crates/mc-core/src/decay.rs:144` — `(natural_cost / history_budget).max(P_FLOOR)`.

Range analysis of `:144`:

| `history_budget` | `natural_cost / budget` | after `.max(0.1)` |
| --- | --- | --- |
| NaN | NaN | `0.1` (`f64::max` returns the non-NaN operand) |
| `+inf` | `0.0` | `0.1` |
| `f64::MAX` | ~0 | `0.1` |
| normal positive | finite | finite, at least `0.1` |
| positive subnormal | `+inf` (overflow) | `+inf` |
| `<= 0.0` | not reached | `1.0` via `:131-133` |

Measured in a scratch crate outside the repository, using the extracted kernel
and a 200-element compartment slice at importance 50:

```
budget=1e0                       -> p=4.137e3
budget=5e-324                    -> p=inf
budget=2.2250738585072014e-308   -> p=inf
budget=NaN                       -> p=1e-1
budget=inf                       -> p=1e-1
budget=1e-300                    -> p=4.137e303
```

So two of the three clauses hold and one does not:

- **Never NaN: holds.** The `.max(P_FLOOR)` at `:144` absorbs it. This is
  load-bearing and slightly accidental, since it depends on Rust's `f64::max`
  NaN semantics rather than on an explicit check. Worth pinning precisely
  because a refactor to `if p < P_FLOOR { P_FLOOR } else { p }` would silently
  lose it: that form returns NaN for a NaN input.
- **At least `P_FLOOR`: holds.** By construction at `:144` and by the `1.0`
  early return at `:132`.
- **Finite: does not hold.** A positive subnormal budget overflows the
  division.

Note also that `natural_cost` itself cannot be NaN or infinite: it is a sum of
at most `compartments.len()` values drawn from `TIER_COST`, each at most 322,
so it is bounded by `322 * len` and stays finite for any slice that fits in
memory.

## Failure scenario

The interesting failure is not a panic; the function is total and never panics.
It is the silent `+inf` return, which propagates into `z_value`
(`crates/mc-core/src/decay.rs:67-70`) and there splits into two behaviours:
compartments at index 2 or beyond get `z = +inf` and archive, while the newest
compartment at index 1 gets `z = 0.0 / 0.0 = NaN` and renders at tier 4. That
combined failure is recorded separately as
`core-decay-newest-compartment-tier-floor`; this record owns the upstream cause.

The NaN clause is currently satisfied, so the failure scenario for it is a
regression scenario: someone replaces the `.max(P_FLOOR)` idiom with an
explicit comparison or a clamp during a readability pass, and a NaN budget then
produces a NaN pressure. With a NaN pressure, `z` is NaN for *every*
compartment, every ladder comparison is false, `tier` returns 5 everywhere,
`should_archive` returns false everywhere, and `rendered_tier` returns 4
everywhere. The entire session history would render as uniform tier-4 anchors
with nothing archived, which is a plausible-looking output that no assertion
would catch.

## Timing windows and dependencies

None at runtime. The function is pure, allocation-free apart from reading the
caller's slice, and clock-free.

Dependency direction: this record is upstream of
`core-decay-newest-compartment-tier-floor`. Constraining the output here to be
finite would remove the enabling state there. The two are kept separate because
the tier-1 floor is also violable by a caller passing `+inf` directly to `tier`,
bypassing `compute_budget_pressure` entirely.

## What a test must construct

1. A budget sweep including, at minimum: `0.0`, `-0.0`, a negative value,
   `f64::MIN_POSITIVE`, `5e-324` (the smallest positive subnormal), `1e-300`,
   `1.0`, a realistic token budget, `f64::MAX`, `f64::INFINITY`, and
   `f64::NAN`.
2. A compartment-slice sweep including the empty slice, a single element, and a
   slice long enough that many compartments reach natural tier 5 (so the
   `:140` guard is exercised on both branches), with importances including the
   clamp edges.
3. For every pair, assert `!result.is_nan()` and `result >= P_FLOOR`.
4. Record `result.is_finite()` as a separate, currently-failing assertion, or
   as a `sometimes` marker that a non-finite pressure was produced, so the
   campaign documents the gap rather than hiding it. If the contract is
   clarified to require finiteness, promote it to an `always` clause.
5. A `sometimes` marker that the empty-slice case was exercised, since
   `natural_cost` is then `0.0` and the result is `0.1` for any positive
   budget; that is a distinct operational situation (a session with no
   compartments) rather than just another grid point.

Semantics: `always` for the NaN-free and lower-bound clauses, since the value is
consumed on every render pass and there is no optional path. The finiteness
clause is `always` too, once the contract question below is settled.

## Investigation log

### Q: Does the contract intend `compute_budget_pressure` to return a finite value?

- Sources examined: `crates/mc-core/src/decay.rs:126-129` (the function's doc,
  which explains the `p = C(1)/B` derivation and notes "Overshoots up to ~30% at
  very tight budgets (<8K)"), `:38-39` (the `P_FLOOR` doc, "prevents
  div-by-zero and caps relaxation at 10x"), `:75-76` (`tier`'s documented input
  range, "`budget_pressure` is 0.10..∞").
- Findings: the documentation reasons carefully about the *lower* bound and
  about the accuracy of the approximation at tight budgets, and says nothing
  about saturation at the upper end. The phrase "0.10..∞" at `:76` reads as
  "unbounded above" in the mathematical sense rather than as an explicit
  admission of the `f64::INFINITY` bit pattern, but it is ambiguous. The
  "<8K" note shows the author's model of a tight budget is thousands of tokens,
  which is many orders of magnitude away from the subnormal region where the
  overflow occurs, so the case was almost certainly not considered rather than
  deliberately allowed.
- Missing evidence: the reference TypeScript implementation's behaviour for the
  same input. JavaScript numbers are `f64` and `322 / 5e-324` is `Infinity`
  there too, so the port is faithful; the divergence question does not arise.
  What is missing is a statement of intent.
- Conclusion: needs human input. Either document `+inf` as an accepted
  "archive everything" saturation signal and fix the `index <= 1` NaN case
  separately, or clamp the return to a finite maximum. This catalog records the
  property and does not choose.

### Q: Is the NaN-freedom load-bearing or incidental?

- Sources examined: `crates/mc-core/src/decay.rs:144`, `:67`, and the Rust
  standard library semantics of `f64::max`.
- Findings: `f64::max` returns the other operand when one is NaN, so both
  `.max(P_FLOOR)` sites (`:67` and `:144`) launder NaN into `P_FLOOR`. Neither
  site has a comment saying so. The `P_FLOOR` doc at `:38` mentions only
  div-by-zero and relaxation capping, so the NaN laundering is an undocumented
  side effect of the chosen idiom.
- Missing evidence: none.
- Conclusion: resolved with answer. The NaN-freedom is real but incidental and
  undocumented, which is exactly why it belongs in a property test: it is the
  kind of behaviour a well-intentioned readability refactor silently removes.
