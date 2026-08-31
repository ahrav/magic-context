# core-decay-tier-ladder-monotone-and-archive-agreement

## Discovery trigger

`crates/mc-core/src/decay.rs:12-13` states the model's invariants as fact:
"the model's invariants (age/importance monotonicity, finite demotion even at
importance 100, append stability, O(H) render cost, budget self-tuning) hold by
the same construction." Three tests sample those monotonicity claims
(`decay.rs:165`, `:176`, `:186`), each along a single one-dimensional slice
with the other two arguments pinned. A documented invariant is a claim under
test, and a three-slice sample is not the claim.

The second half of this record came from noticing that `tier`
(`decay.rs:77-90`) can return `5` while `should_archive`
(`decay.rs:95-104`) returns `false`, which means the two public functions
disagree about retirement for a nonempty region of the input space.

## Evidence trail

Monotonicity, traced through the arithmetic:

- `crates/mc-core/src/decay.rs:65` — `a` is non-decreasing in
  `compartment_index`.
- `crates/mc-core/src/decay.rs:68` — `f = 2^((imp - 50) / D)` is increasing in
  `imp`, so `h` at `:69` is increasing in `imp`, so `z = a / h` at `:70` is
  non-increasing in `imp`.
- `crates/mc-core/src/decay.rs:69` — `h = (H50 * f) / p` is decreasing in `p`,
  so `z` is non-decreasing in `p`.
- `crates/mc-core/src/decay.rs:79-89` — the ladder is monotone in `z` by
  construction: the boundaries at `:30-36` satisfy `Z1 < Z2 < Z3 < Z4`
  (0.201 < 0.729 < 1.322 < 2.587).

So all three monotonicity clauses follow from a monotone `z` composed with a
monotone step function, *provided* `z` is not NaN. The NaN case is the subject
of a separate record, `core-decay-newest-compartment-tier-floor`.

Existing coverage, precisely:

- `crates/mc-core/src/decay.rs:165-173` walks `idx` 1..=400 with
  `importance = 50` and `pressure = 1.0`. One slice.
- `crates/mc-core/src/decay.rs:176-183` compares `importance` 10 against 90 at
  three indices with `pressure = 1.0`. Two points per index, not a sweep.
- `crates/mc-core/src/decay.rs:186-192` compares `pressure` 0.5 against 4.0 at
  three indices with `importance = 50`. Two points per index.
- `crates/mc-core/src/decay.rs:201-206` asserts
  `rendered_tier(idx, 50, 1.0, 0.0)` is either 5 or at most 4 for idx 1..=500.
  Note that this assertion is trivially true for any `u8` value in 0..=5, since
  `rt == 5 || rt <= 4` excludes nothing in the reachable range. It does not
  test the agreement with `should_archive` at all.

The agreement clause, measured. Running the extracted kernel outside the
repository at `importance = 50`, `pressure = 1.0`, `anchor_overlap = 1.0`:

```
idx=63  tier=4  archive=false  rendered=4
idx=64  tier=5  archive=false  rendered=4
idx=65  tier=5  archive=false  rendered=4
idx=100 tier=5  archive=false  rendered=4
idx=120 tier=5  archive=true   rendered=5
```

Indices 64 through 119 are the window where `tier` says 5 and
`should_archive` says false. This is the documented anchor protection:
`crates/mc-core/src/decay.rs:94` says "Anchor overlap extends P4 protection by
up to `G` half-lives", and `:107-108` says non-archived compartments "render at
most P4". So the disagreement is intended, and the correct property is not
"`tier == 5` implies archived" but "`rendered_tier == 5` if and only if
`should_archive`".

## Failure scenario

Two distinct failures.

A monotonicity break: a boundary constant is edited so the ladder is no longer
sorted, or the exponent sign at `crates/mc-core/src/decay.rs:68` is flipped
during a refactor. The visible effect is a compartment that becomes *more*
verbose as the session grows, or a high-importance compartment demoting faster
than a low-importance one. Because the three existing tests pin only single
slices, an edit that preserves those slices while breaking the surface passes.
Concretely, swapping `Z2` and `Z3` would keep `tier` non-decreasing in age
(the ladder still fires in order of `z`) but would relabel a band, which the
age-monotonicity test at `:165` cannot see because it only checks
non-decrease, not the specific tier values.

An agreement break: a change to `rendered_tier` that returns `tier()`
unclamped, or an `anchor_overlap` handling change, makes the renderer emit
tier 5 for a compartment `should_archive` reports as live, or tier 4 for one it
reports as archived. Any archival bookkeeping keyed on `should_archive` then
disagrees with the bytes actually rendered, so a compartment is either retired
while still appearing in the prompt or dropped from the prompt while still
tracked as live.

## Timing windows and dependencies

None. All four functions are pure and clock-free. There is no fault to inject
and no interleaving to construct.

Dependency: the monotonicity clauses hold only where `z` is not NaN, so this
record's sweep must exclude `pressure = +inf` at `index <= 1`, or must be run
after `core-decay-newest-compartment-tier-floor` is resolved. Sweeping finite
pressures only keeps the two records independent.

## What a test must construct

1. A joint grid, not three slices. Suggested shape: `index` over a
   logarithmically spaced set from 1 to a few hundred thousand plus the
   boundary neighbourhoods where `z` crosses `Z1..Z4`; `importance` over
   1..=100 plus the out-of-range values `{i32::MIN, 0, 101, i32::MAX}`;
   `pressure` over a finite set spanning `P_FLOOR` to a large finite value.
2. Assert pairwise monotonicity by comparing adjacent grid points along each
   axis with the other two pinned, for every combination of the other two, not
   for one arbitrary choice.
3. Assert the agreement clause with `anchor_overlap` swept over
   `{0.0, 0.25, 0.5, 1.0}` plus the out-of-range `{-1.0, 2.0}`, since the clamp
   at `crates/mc-core/src/decay.rs:102` is part of the contract:
   `rendered_tier(i, m, p, o) == 5` if and only if
   `should_archive(i, m, p, o)`, and otherwise `rendered_tier(i, m, p, o) <= 4`.
4. A `sometimes` marker recording that the grid actually visited the
   intended disagreement window (`tier == 5 && !should_archive`), because a
   grid that never sets `anchor_overlap > 0` would satisfy the agreement clause
   vacuously and prove nothing about the protection band.

Semantics: `always` for the monotonicity and agreement clauses, since both must
hold at every evaluation. The disagreement-window marker is `sometimes`, not
`reachable`, because it is a situation (a particular relationship between two
function outputs) rather than a code location.

## Investigation log

### Q: Is `tier() == 5` a legitimate public answer, or should the archive boundary be exposed only through `should_archive`?

- Sources examined: `crates/mc-core/src/decay.rs:36` (the `Z4` doc, "P4→P5
  (archive candidate) boundary"), `:44` (the `Tier` alias doc, "1 (verbose) ..
  5 (archived / not rendered)"), `:73-76` (`tier`'s doc, "ignoring archive
  protection"), `:94` (`should_archive`'s doc), `:106-108` (`rendered_tier`'s
  doc), and the only production caller,
  `crates/mc-module/src/decay_render.rs:291-296`.
- Findings: the docs are internally consistent and deliberate. `Z4` is called
  the "archive *candidate*" boundary, `tier` explicitly says it ignores archive
  protection, and `rendered_tier` is documented as the function that combines
  the two. The production caller uses `rendered_tier`, never `tier`. So the
  disagreement is by design and the naming is careful. The residual risk is
  that `tier` is `pub` (`:77`) and a future caller could reasonably read a
  return of 5 as "archived".
- Missing evidence: none for the current tree; the question is about future
  misuse rather than present behaviour.
- Conclusion: resolved with answer. `tier() == 5` means "past the archive
  candidate boundary", not "archived". The property to check is the
  `rendered_tier`/`should_archive` biconditional, and `tier == 5` must not be
  asserted to imply archival. Whether `tier` should be renamed or made
  crate-private is a design call, not a defect. (needs human input for the
  naming decision)

### Q: Does the `rendered_tier_caps_at_four_unless_archived` test assert anything?

- Sources examined: `crates/mc-core/src/decay.rs:201-206`.
- Findings: the assertion is `rt == 5 || rt <= 4`. Since `rendered_tier`
  returns a `u8` and every reachable value is in 1..=5, the disjunction is a
  tautology over the reachable range. The test does confirm the function does
  not panic across 500 indices, which has some value, but it does not
  constrain the cap.
- Missing evidence: none. This is a direct reading.
- Conclusion: resolved with answer. The existing check is vacuous as an
  agreement oracle. It is recorded as `unaudited` in the catalog per the method
  contract, and the adequacy verdict belongs to
  `/testing:invariant-test-review`, not to this lens.
