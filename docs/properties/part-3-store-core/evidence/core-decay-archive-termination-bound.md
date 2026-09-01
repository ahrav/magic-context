# core-decay-archive-termination-bound

## Discovery trigger

`crates/mc-core/src/decay.rs:12-13` lists "finite demotion even at importance
100" among the invariants that "hold by the same construction", and
`finite_demotion_at_max_importance` (`decay.rs:194-198`) encodes it as a single
assertion with the comment "even importance 100 archives eventually (finite
half-life) — no immortal row." The assertion pins one point:
`should_archive(100_000, 100, 1.0, 0.0)`. Three of the four arguments are fixed,
and the one that is fixed to `0.0` is the one the doc at `decay.rs:94` describes
as a future extension point. That combination invited checking what happens when
`anchor_overlap` is something other than a well-behaved value in `0.0..=1.0`.

## Evidence trail

- `crates/mc-core/src/decay.rs:95-104` — `should_archive` computes
  `let o = anchor_overlap.clamp(0.0, 1.0);` at `:102` and returns
  `z >= Z4 + G * o` at `:103`.
- Rust's `f64::clamp` propagates NaN: for a NaN input it returns NaN. (It
  panics only if `min > max`, which cannot happen here because the bounds are
  the literals `0.0` and `1.0`.) So a NaN `anchor_overlap` yields `o = NaN`.
- With `o = NaN`, `Z4 + G * NaN` is NaN, and `z >= NaN` is false for every `z`,
  including `+inf`. So `should_archive` returns `false` unconditionally.
- `crates/mc-core/src/decay.rs:115-123` — `rendered_tier` then skips the
  archive return at `:121` and evaluates `tier(..).min(4)`, so every
  compartment, however old, renders at tier 4 or lower. No compartment ever
  reaches tier 5.

Measured in a scratch crate outside the repository using the extracted kernel:

```
f64::NAN.clamp(0.0, 1.0)                          -> NaN
should_archive(100_000, 100, 1.0, f64::NAN)       -> false
should_archive(u32::MAX, 100, 0.1, 1.0)           -> true
```

The third line confirms that with a well-formed overlap of `1.0`, termination
does hold even at the most protective settings: maximum index, maximum
importance, minimum pressure. So the invariant is real for the intended domain
and fails only for the out-of-domain NaN.

For completeness, the negative and above-one cases are handled correctly by the
clamp: `-1.0` becomes `0.0` and `2.0` becomes `1.0`, both finite, so
termination holds for them.

Reachability, established rather than assumed:

- `crates/mc-module/src/decay_render.rs:19` imports `rendered_tier` from
  `mc_core::decay`.
- `crates/mc-module/src/decay_render.rs:291-296` is the only call site, and the
  fourth argument is the literal `0.0` at `:295`.
- A repo-wide search for `should_archive` over `*.rs` returns hits only inside
  `crates/mc-core/src/decay.rs` (the definition at `:95` and the three test
  uses at `:197`, `:266`, and the golden loop).

So no production code path can supply a NaN overlap today. The label is
`test-only`: only a direct library call reaches the failing input. That label
is a statement about the current tree, not a claim that it will stay true.
`decay.rs:94` explicitly anticipates anchors becoming a first-class storage
primitive, at which point the overlap becomes data flowing in from storage and
the label changes.

## Failure scenario

Anchors become a real storage primitive, as `crates/mc-core/src/decay.rs:94`
anticipates. Anchor overlap is computed as a ratio, something of the shape
`overlapping_anchors as f64 / total_anchors as f64`. For a compartment with no
anchors at all, that is `0.0 / 0.0`, which is NaN. The NaN reaches
`should_archive`, the clamp passes it through, and every comparison fails.

The observable result is unbounded retention: session history never archives.
The rendered prompt grows with every compartment, and the only remaining
backstop is the byte-level budget guard at
`crates/mc-module/src/decay_render.rs:331-347`, which demotes oldest-first while
the rendered body exceeds the budget. That guard has a bounded iteration count
(`guard = compartments.len() * 5` at `:329`) and stops when nothing can be
demoted further, so it limits the damage but does not restore archival: it
pushes compartments to tier 5 in the local `tiers` vector without ever agreeing
with `should_archive`, so the renderer and any archival bookkeeping diverge.

The failure is silent. There is no error, no panic, and no log line. The tier
distribution simply skews and the prompt gets longer.

## Timing windows and dependencies

None at runtime. `should_archive` is pure `f64` arithmetic with no clock and no
shared state.

The relevant window is developmental, not temporal: the gap between the
documented invariant being unconditional and the code's being conditional on a
non-NaN overlap. That gap is harmless while the only caller passes a literal
`0.0`, and becomes live the moment the overlap is computed from data.

Dependency: independent of the pressure records. The NaN here comes from the
fourth argument, not from `z`. A campaign can check this record with
`pressure` fixed at `1.0`.

## What a test must construct

1. An `anchor_overlap` sweep including `f64::NAN`, `-0.0`, `-1.0`, `0.0`,
   `0.5`, `1.0`, `2.0`, `f64::INFINITY`, and `f64::NEG_INFINITY`.
2. For each, plus an `importance` sweep over `{1, 50, 100, 101, i32::MAX}` and
   a finite `pressure` sweep at and above `P_FLOOR`, assert
   `should_archive(u32::MAX, importance, pressure, overlap)` is true. Using
   `u32::MAX` as the index is the cheapest way to express "eventually" as a
   total assertion: if the largest representable index does not archive, no
   index does, because `z` is non-decreasing in the index.
3. Assert the derived clause on the renderer:
   `rendered_tier(u32::MAX, importance, pressure, overlap) == 5`.
4. A `sometimes` marker that the sweep actually produced a case where
   `o != anchor_overlap` (the clamp did something), so the campaign records
   that the out-of-range branch was exercised rather than only the identity
   case.

Semantics: `always`, not liveness. The temptation is to call "eventually
archives" a liveness property, but there is no process making progress over
time here: the quantity is a pure function of an ordinal index, so
"eventually" is expressible as a single total assertion at the largest index.
A liveness check would need a bounded fault-free window and a poll loop, and
there is nothing to poll.

## Investigation log

### Q: Where should anchor overlap be validated once anchors are real?

- Sources examined: `crates/mc-core/src/decay.rs:26` (the `G` constant, "Max
  extra half-lives of P4 protection from full anchor overlap"), `:94` ("with
  `anchor_overlap = 0.0` (the default today, anchors not yet a first-class
  storage primitive)"), `:102` (the clamp),
  `crates/mc-module/src/decay_render.rs:291-296` (the hardcoded `0.0`).
- Findings: the clamp at `:102` already expresses an intent to be defensive
  about the range, and it handles every out-of-range *finite* value correctly.
  It simply does not handle NaN, because `f64::clamp` is not a NaN filter. Two
  reasonable placements exist: reject or replace NaN at the storage boundary
  where the ratio is computed, or make the clamp NaN-safe inside
  `should_archive`. The second is strictly more robust because
  `should_archive` is a public function of a library crate and cannot see its
  callers.
- Missing evidence: the anchor storage schema, which does not exist yet.
- Conclusion: needs human input. This catalog records the property; the
  placement is a design decision, and per the method contract this lens makes
  no fixes.

### Q: Does the documented invariant hold for every in-domain input?

- Sources examined: `crates/mc-core/src/decay.rs:12-13`, `:22-39` (the
  constants), `:63-71` (`z_value`), `:95-104`, and the measured
  `should_archive(u32::MAX, 100, 0.1, 1.0) == true`.
- Findings: yes. For the documented domain (`importance` 1..100,
  `budget_pressure` at or above `P_FLOOR`, `anchor_overlap` 0.0..=1.0), the
  half-life is finite and bounded above by `H50 * 2^((100-50)/25) / P_FLOOR`,
  which is `24 * 4 / 0.1 = 960` compartments, so `z` exceeds
  `Z4 + G * 1.0 = 4.587` by index `960 * 4.587 + 1`, roughly 4,404. That is far
  below `u32::MAX`, so termination holds with an enormous margin.
- Missing evidence: none.
- Conclusion: resolved with answer. The invariant holds on its documented
  domain. The defect is that the documentation states it unconditionally while
  the code admits an out-of-domain NaN that defeats it, and the single existing
  test cannot distinguish the two because it fixes the implicated argument to
  `0.0`.
