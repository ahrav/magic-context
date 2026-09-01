# core-pass-classifier-destructive-clear-guard

## Discovery trigger

`crates/mc-core/src/lib.rs:53-56` documents the safety rule in the classifier's
own comments: "An initialized state that is neither legacy nor valid (missing
`m0`/`m1`, or any other key) is an UNKNOWN shape → [`PassPlan::Reject`] (never
cleared — a destructive clear must never fire on an unrecognized shape)." The
parenthetical is a safety invariant stated in prose. `classify`
(`:116-160`) is a pure total function over eleven booleans, so the entire input
domain is 2048 points and the invariant is exhaustively decidable. A property
that is both safety-critical and exhaustively checkable for the cost of a single
nested loop is the cheapest valid oracle in this part.

## Evidence trail

The input and output types:

- `crates/mc-core/src/lib.rs:42-80` — `ClassifierInput` with exactly eleven
  `bool` fields: `initialized` (`:46`), `is_legacy_baseline` (`:50`),
  `valid_m0m1_shape` (`:56`), `cached_m1_missing` (`:59`),
  `render_config_changed` (`:61`), `hard_fold_requested` (`:63`),
  `boundary_present` (`:65`), `reconcile_pending` (`:67`),
  `m1_revision_changed` (`:70`), `reductions_pending` (`:76`),
  `bust_opportunity` (`:79`). `2^11 = 2048`.
- `crates/mc-core/src/lib.rs:84-97` — `PassPlan` with five variants: `Hard`
  (`:87`), `MigrateHard` (`:89`), `Soft` (`:91`), `Defer` (`:93`),
  `Reject(&'static str)` (`:96`).

The eight guards, in order, each verified against the source:

| # | Line | Condition | Plan |
| --- | --- | --- | --- |
| 1 | `:118` | `!input.initialized` | `Hard` (`:119`) |
| 2 | `:122` | `input.is_legacy_baseline` | `MigrateHard` (`:123`) |
| 2b | `:126` | `input.cached_m1_missing` | `Hard` (`:127`) |
| 2c | `:130` | `!input.valid_m0m1_shape` | `Reject` (`:131`) |
| 3 | `:134` | `input.render_config_changed` | `Hard` (`:135`) |
| 4 | `:138` | `input.hard_fold_requested` | `Hard` (`:139`) |
| 5 | `:142` | `input.reconcile_pending && !input.boundary_present` | `Hard` (`:143`) |
| 6 | `:146` | `input.reconcile_pending` | `Defer` (`:147`) |
| 7 | `:152-155` | `boundary_present && bust_opportunity && (m1_revision_changed \|\| reductions_pending)` | `Soft` (`:156`) |
| 8 | `:159` | otherwise | `Defer` |

Every path returns, so the function is total. It reads no clock, allocates
nothing, and touches no shared state, so it is deterministic and reproducible.

The four clauses that follow from the guard order:

- `MigrateHard` is returned only at `:123`, reachable only when guard 2 fires,
  so `classify(i) == MigrateHard` implies `i.is_legacy_baseline`. Guard 1 sits
  above it, so an uninitialised legacy state routes to `Hard` instead, which is
  also safe (bootstrap materialises a baseline; it does not clear one).
- `Reject` is returned only at `:131`, reachable only when guards 1, 2, and 2b
  all fail, so it implies `i.initialized && !i.is_legacy_baseline &&
  !i.cached_m1_missing && !i.valid_m0m1_shape`.
- `Soft` is returned only at `:156`, so it implies the full conjunction at
  `:152-155`.
- Therefore `!i.boundary_present` implies `classify(i) != Soft`, which is the
  invariant the comment at `:112-115` and the test at `:269-277` care about:
  "boundary absent + delta must DEFER (set reconcile), never Soft (which would
  bust the m1 breakpoint and strand the flag)."

The documented ordering rationale at `crates/mc-core/src/lib.rs:99-115` matches
the code: it claims rules 2 and 2b run "right after bootstrap" (they do, at
`:122` and `:126`), that rule 6 runs before rule 7 (it does, `:146` before
`:152`), and that rule 7 requires both `boundary_present` and
`bust_opportunity` (it does, `:152-153`).

Existing coverage: 14 tests at `crates/mc-core/src/lib.rs:176-337`. They cover
each guard at least once, including `unknown_shape_rejects_never_clears`
(`:207-216`) which is the direct test of the destructive-clear invariant, and
`legacy_baseline_migrates` (`:186-195`) which confirms guard 2 wins over an
invalid shape. Fourteen hand-picked points out of 2048.

Reachability, established rather than assumed. A repo-wide search for
`ClassifierInput|PassPlan|mc_core::classify` across `*.rs` returns matches only
inside `crates/mc-core/src/lib.rs`. The other `classify` symbols in the tree are
unrelated: `crates/mc-module/src/classify.rs` is a different module with its own
purpose, and `crates/mc-host/tests/support/perf_measurement.rs:426` defines
`fn classify(&self, opened_ns: u64) -> WindowClass`. The `mc-core` items that
*are* consumed downstream are `claim_operation::*`
(`crates/mc-module/src/memory_tool.rs:19`,
`crates/mc-module/src/m1_compose.rs:5`,
`crates/mc-module/src/m0_compose.rs:13`,
`crates/mc-module/src/classify.rs:176`, `crates/mc-store/src/lib.rs`) and
`CoreState` (`crates/mc-module/src/tail_hygiene.rs:6`,
`crates/mc-module/src/historian.rs:1828`,
`crates/mc-module/tests/boundary_counter_durability.rs:6`). So the label is
`test-only`, and stating it as `default-production` would be exactly the
unverified blanket claim the method contract warns about.

## Failure scenario

If `MigrateHard` escaped its guard, a session whose frozen set is an
unrecognised shape would have its durable frozen units cleared and rebuilt
rather than cleanly rejected. The clear is the destructive step: `:88` describes
it as "clear the frozen set, THEN hard fold". Clearing on an unrecognised shape
throws away state that a future build might have been able to interpret, and it
does so on the basis of not recognising it, which is precisely the wrong
inference. The `Reject` path at `:95-96` exists to leave durable state
untouched.

The plausible mechanism for such an escape is guard reordering during a
refactor. Moving guard 2c (`:130`) above guard 2 (`:122`) would be a harmless
looking change that in fact turns every legacy state into a `Reject`, blocking
migration. Moving guard 2 below guard 3 or 4 would let an epoch change or a hard
trigger mask a legacy state, so migration never runs and the legacy shape
persists. Removing the `is_legacy_baseline` condition while keeping the
`MigrateHard` return would clear on any shape. Fourteen point tests would catch
some of these and not others; an exhaustive enumeration catches all of them,
because it pins the entire input-to-plan mapping.

There is a second, subtler failure the exhaustive check would catch: a `Soft`
plan firing without `boundary_present`. `:112-115` explains the consequence, that
`step_soft` in the cache core "never touches `reconcile_pending`", so a `Soft`
on a boundary-absent pass would bust the m1 breakpoint and leave the reconcile
flag stranded, producing a session that never re-derives its boundary.

Because the classifier has no production caller today, the present blast radius
is zero. That is the argument for installing the check now rather than later: the
cost is one loop, and the moment of adoption is exactly when a latent ordering
defect becomes live.

## Timing windows and dependencies

None. `classify` is pure, total, clock-free, and single-threaded by nature. There
is no fault to inject, no interleaving to construct, and no enabling state beyond
the eleven booleans.

Dependency: the *meaning* of the eleven booleans is computed by the consuming
module, as `:39-41` says ("all booleans the consuming module computes"). So this
property checks the router, not the inputs. If a consumer computes
`valid_m0m1_shape` incorrectly, the router faithfully routes a wrong input, and
that is a different property belonging to whichever module computes it.

## What a test must construct

1. An exhaustive enumeration of all 2048 `ClassifierInput` values, built by
   iterating an 11-bit counter and mapping each bit to a field. No generator or
   shrinking machinery is needed or wanted; the domain is small enough to
   enumerate and a complete enumeration is a stronger oracle than any sample.
2. The four implication clauses asserted for every point:
   - `plan == MigrateHard` implies `is_legacy_baseline`
   - `plan == Reject(_)` implies `initialized && !is_legacy_baseline &&
     !cached_m1_missing && !valid_m0m1_shape`
   - `plan == Soft` implies `boundary_present && bust_opportunity &&
     (m1_revision_changed || reductions_pending)`
   - `!boundary_present` implies `plan != Soft`
3. A totality assertion that is free with the enumeration: every input produces
   a plan, which the type system already guarantees, but the enumeration also
   confirms no panic path exists.
4. Optionally, a golden mapping: record the full 2048-entry input-to-plan table
   as a fixture so any change to routing shows up as an explicit diff rather than
   as a possibly-still-passing set of implications. This is the cheapest way to
   make guard reordering visible in review.
5. A `reachable` marker per plan variant, asserting the enumeration produced at
   least one input yielding each of the five variants. This is location coverage
   (each return statement executed), so `reachable` is the correct semantics and
   `sometimes` would be wrong.

Semantics for the four implication clauses: `always`, over an exhaustively
enumerated finite domain.

## Investigation log

### Q: Is `classify` dead code awaiting adoption, or has `mc-module` grown a second copy of the routing logic?

- Sources examined: a repo-wide search for `ClassifierInput`, `PassPlan`, and
  `mc_core::classify` across `*.rs` (matches only in
  `crates/mc-core/src/lib.rs`); `crates/mc-module/src/classify.rs` (a different
  module, whose only `mc-core` use is `is_valid_public_claim_id` at `:176`);
  `crates/mc-core/src/lib.rs:1-7` (the crate doc, which describes the crate as
  the "Origin-agnostic PURE decision layer: the [`CkItem`] trait, the pass
  [`classify`] function, and re-exports of the shipped `cortexkit-cache-core`
  types"); `crates/mc-core/src/lib.rs:102-103` (which references
  `cortexkit-cache-core`'s `step_*` mechanics as the intended consumer
  vocabulary).
- Findings: the crate doc presents `classify` as a headline export, not as
  scaffolding, and the guard comments reference the cache core's `step_soft` and
  `step_defer` semantics in detail, which reads like code written against a real
  consumer. Yet no consumer imports it. The likely readings are that the routing
  logic was reimplemented in `mc-module` (`transform.rs` is very large and
  contains reconcile and hard-fold vocabulary) and this copy was left as a
  reference, or that adoption is pending. Distinguishing them requires reading
  `mc-module`'s routing, which is outside this lens's assigned files.
- Missing evidence: `crates/mc-module/src/transform.rs` routing logic.
- Conclusion: unresolved, needs an `mc-module` routing comparison. Flagging the
  worse outcome explicitly: a silent divergence between an unused reference
  implementation and the live router is more dangerous than no reference at all,
  because a reader who finds `mc-core::classify` will reasonably believe it
  describes the system's behaviour.

### Q: Does the ordering documentation match the code?

- Sources examined: `crates/mc-core/src/lib.rs:99-115` against `:116-160`,
  clause by clause.
- Findings: all three documented ordering facts hold. Rules 2 and 2b are
  immediately after bootstrap (`:122`, `:126`, following `:118`). Rule 6
  (`:146`) precedes rule 7 (`:152`). Rule 7 requires both `boundary_present` and
  `bust_opportunity` (`:152-153`). The doc's explanation of *why* rule 6 must
  precede rule 7 (that `step_soft` never clears `reconcile_pending`) is a claim
  about `cortexkit-cache-core`, an external crate this lens did not read.
- Missing evidence: the `cortexkit-cache-core` `step_soft` and `step_defer`
  implementations, needed to confirm the stated rationale rather than the stated
  ordering.
- Conclusion: resolved with answer for the ordering itself; the rationale's
  premise is unverified and is a separate question about an external dependency.
  The property as written does not depend on the rationale being correct, only on
  the ordering being preserved.
