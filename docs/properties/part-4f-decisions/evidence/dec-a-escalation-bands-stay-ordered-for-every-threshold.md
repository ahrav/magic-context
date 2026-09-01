# dec-a-escalation-bands-stay-ordered-for-every-threshold

## Discovery trigger

Task 3 asks for monotonicity properties the domain actually claims. `escalation_bands`
is the single function every escalation site in two files derives from, and its doc
comment says so: "Derive every sub-95 escalation site from the effective execute
threshold" (`scheduler.rs:186`). A function with that role has an implicit ordering
invariant, because the bands it produces are compared against the same usage number in
sequence.

## Evidence trail

The unit. `scheduler.rs:177-198`:

```
/// Escalation thresholds derived from the effective execute threshold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EscalationBands {
    /// Dynamic force-materialization and emergency-drop threshold.
    pub force_materialize_percentage: f64,
    /// Absolute provider-wall threshold; intentionally never derived from config.
    pub emergency_percentage: f64,
}

/// Derive every sub-95 escalation site from the effective execute threshold.
pub fn escalation_bands(effective_threshold_percentage: f64) -> EscalationBands {
    let threshold = if effective_threshold_percentage.is_finite() {
        effective_threshold_percentage.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
    } else {
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE
    };
    EscalationBands {
        force_materialize_percentage: MIN_FORCE_MATERIALIZE_PERCENTAGE.max(threshold + 2.0),
        emergency_percentage: EMERGENCY_PERCENTAGE,
    }
}
```

Constants: `MAX_EXECUTE_THRESHOLD_PERCENTAGE = 90.0` (`:17`),
`MIN_FORCE_MATERIALIZE_PERCENTAGE = 85.0` (`:19`), `EMERGENCY_PERCENTAGE = 95.0`
(`:21`), `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65.0` (`:15`).

**The range is provable in one step.** After `:189-193`, `threshold <= 90.0` on the
finite branch and `threshold == 65.0` on the non-finite branch. So
`threshold + 2.0 <= 92.0`, and `force_materialize_percentage = max(85.0, threshold + 2.0)`
lies in `[85.0, 92.0]` for every possible input. `emergency_percentage` is the constant
`95.0`. Therefore `85.0 <= force < 95.0` always, with three percentage points of
margin at the top.

Note what the finite branch does not do: it caps but does not floor. A threshold of
`-1000.0` is finite, so it survives `min(90.0)` unchanged, and
`max(85.0, -998.0)` is `85.0`. So a wildly negative threshold degrades to the minimum
force band rather than to a nonsensical one. NaN takes the non-finite branch and
yields `65.0 + 2.0 = 67.0`, then `max(85.0, 67.0) = 85.0`.

**Monotonicity.** `max(85.0, t + 2.0)` is non-decreasing in `t` on the finite branch
because both `min(90.0)` and `max(85.0, ·)` are monotone non-decreasing. So
`t1 <= t2` implies `bands(t1).force <= bands(t2).force`, for finite `t1` and `t2`. The
non-finite branch is a constant substitution and sits outside the ordering, which is
why the property is stated over finite inputs for the monotonicity half and over all
inputs for the range half.

**Why the ordering matters.** Four consumers compare a usage reading against these
bands in sequence.

`scheduler.rs:518-529`, `derive_band_with_hard_wall`:

```
let bands = escalation_bands(effective_threshold_percentage);
if hard_wall_percentage >= bands.emergency_percentage {
    Band::Emergency95
} else if usage_percentage >= bands.force_materialize_percentage {
    Band::Force85
} else {
    Band::Normal
}
```

The emergency arm is tested first. If `force` could reach or exceed `95.0`, every
usage that satisfied the force arm would already have satisfied the emergency arm on
the coinciding-geometry path where `hard_wall_percentage == usage_percentage`, and
`Band::Force85` would become unreachable. `decide` maps `Force85` and `Emergency95` to
different `PassDecision`s at `:761-765`, and `apply_boundary_deferral` (`:532-551`)
treats both as force-or-emergency but the two are distinguished downstream by
`pass_class_for` (`:803-808`) and by the emergency-scale logic in `boundary.rs`. So
collapsing them would change which passes bypass mid-turn deferral.

`boundary.rs:814-816`, inside `check_compartment_trigger_with_index`:

```
let force_materialization_percentage =
    escalation_bands(ctx.boundary.execute_threshold_percentage).force_materialize_percentage;
if ctx.boundary.usage_percentage >= force_materialization_percentage {
```

and then the emergency scale at `:826-830` picks `0.25` above
`BLOCK_UNTIL_DONE_PERCENTAGE` (`:47`, `95.0`) and `0.5` otherwise. That two-tier split
depends on `force < 95`, otherwise the `0.5` tier is dead.

`boundary.rs:483-485`, inside `resolve_protected_tail_boundary_with_index`, uses the
same band to decide whether the live-prompt floor applies:

```
if ctx.emergency_tail_scale.is_none() && usage_percentage < force_materialization_percentage {
```

`boundary.rs:977-980`, inside `has_runnable_compartment_window`, uses it to choose
between the force-eligibility rule and the ordinary one.

**The existing check.** `scheduler.rs:1238`
`escalation_bands_stay_ordered_above_execute_and_below_emergency`. The name states
exactly this property, so the invariant is already recognised; what the test does not
cover is the non-finite and negative inputs, which are the arms that a future edit is
most likely to break.

`select_per_run_cap` (`boundary.rs:958-971`) deliberately does **not** use the derived
band, and says so at `:963-965`:

```
// Capacity sizing deliberately retains its historical 80% tier. For execute
// thresholds from 84% through 90%, this cap no longer coincides with the
// derived force-band transition.
```

So there is one intentional divergence from the derived band, documented in place.
That is worth knowing when reading the file: not every `85`-ish constant is derived.

## Failure scenario

Nothing fails today. The record pins a boundary whose violation would be silent.

The regression shape: someone raises `MAX_EXECUTE_THRESHOLD_PERCENTAGE` from `90` to
`95`, which is a plausible change because `CONFIGURATION.md:167` documents the cap as
leaving "about 10% for mid-turn input growth" and a future provider might not need
it. With the cap at `95`, a configured threshold of `95` yields
`force = max(85.0, 97.0) = 97.0`, which exceeds `emergency_percentage`. Then in
`derive_band_with_hard_wall` the force arm at `:525` is unreachable on the coinciding
path, and every pressure pass jumps straight to `Emergency95`.

The observable effect is that the graduated response disappears: instead of
force-materializing at 87 percent and blocking at 95, the module does nothing until 95
and then blocks. `boundary.rs`'s `0.5` emergency-tail scale at `:829` would also become
dead, so every emergency fold would use the aggressive `0.25` scale. Nothing would
error; the module would just behave much more abruptly under pressure.

## Timing windows and dependencies

None. `escalation_bands` is a pure function of one scalar and is called fresh at each
of the four sites rather than being cached.

## What a test must construct

Extend `scheduler.rs:1238` with the input classes it omits:

```
for t in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1000.0, 0.0, 1.0, 20.0, 65.0, 90.0, 1e300] {
    let b = escalation_bands(t);
    assert!(b.force_materialize_percentage.is_finite());
    assert!(b.force_materialize_percentage >= MIN_FORCE_MATERIALIZE_PERCENTAGE);
    assert!(b.force_materialize_percentage < b.emergency_percentage);
}
```

and a monotonicity assertion over a sorted finite sequence:

```
let mut prev = f64::NEG_INFINITY;
for t in [0.0, 20.0, 40.0, 65.0, 83.0, 88.0, 90.0, 200.0] {
    let f = escalation_bands(t).force_materialize_percentage;
    assert!(f >= prev);
    prev = f;
}
```

Both are pure scalar loops with no fixture.

A second, cheaper structural assertion is worth adding: that
`MIN_FORCE_MATERIALIZE_PERCENTAGE + 0.0 < EMERGENCY_PERCENTAGE` and
`MAX_EXECUTE_THRESHOLD_PERCENTAGE + 2.0 < EMERGENCY_PERCENTAGE` hold as constant
relations. That is the assertion that would fail the moment someone raises the cap,
and it fails at the constant rather than waiting for a band comparison to go quiet.

## Investigation log

### Q: Do all four consumers use the derived band consistently?

- Sources examined: `scheduler.rs:518-529`; `boundary.rs:483-485`, `:814-816`,
  `:977-980`; `boundary.rs:958-971` (`select_per_run_cap`) and its comment at
  `:963-965`; `boundary.rs:47` (`BLOCK_UNTIL_DONE_PERCENTAGE = 95.0`) and `:46`
  (`FORCE80_CAP_TIER_PERCENTAGE = 80.0`).
- Findings: the four escalation comparisons all derive from `escalation_bands`. Two
  other constants sit nearby and are deliberately independent:
  `BLOCK_UNTIL_DONE_PERCENTAGE` duplicates `EMERGENCY_PERCENTAGE`'s value in a
  different crate module, and `FORCE80_CAP_TIER_PERCENTAGE` is the documented
  historical capacity tier. The duplicated `95.0` is a small drift hazard: raising
  `EMERGENCY_PERCENTAGE` without raising `BLOCK_UNTIL_DONE_PERCENTAGE` would split the
  emergency band from the emergency tail scale.
- Missing evidence: none.
- Conclusion: resolved with answer. The property holds and the duplicated `95.0`
  between `scheduler.rs:21` and `boundary.rs:47` is worth surfacing to synthesis as a
  drift hazard, though it is not a defect today because both are `95.0`.

### Q: Is the non-finite branch reachable?

- Sources examined: the callers' inputs. `scheduler.rs:522` receives
  `effective_threshold_percentage` from `decide`'s `threshold` (`:713-720`), which is
  `resolve_execute_threshold`'s output, and that function already replaces non-finite
  values with the fallback at `:462-464`. `boundary.rs:815` receives
  `ctx.boundary.execute_threshold_percentage` straight from the caller's
  `BoundaryContext` with no prior validation, so the non-finite branch is reachable
  there if a host supplies a non-finite threshold.
- Findings: the scheduler path is doubly guarded; the boundary path relies on
  `escalation_bands`'s own guard. So the guard at `:189-192` is load-bearing for
  `boundary.rs` and redundant for `scheduler.rs`.
- Missing evidence: whether any host can supply a non-finite threshold.
  `config.rs:631-636` filters non-finite at the config layer, and the request path is
  4b's `sel-budget-execute-threshold-unvalidated-from-request`.
- Conclusion: resolved with answer for this record. The guard is reachable in
  principle through the boundary path, which is why the property is stated over all
  f64 inputs rather than only over validated ones.
