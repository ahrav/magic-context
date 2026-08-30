# sel-divergence-repair-bounded-by-three-pending-passes

## Discovery trigger

`BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` (`transform.rs:85`) is the only
pass-count budget in the slice, and its doc comment states an explicit liveness
promise: "Limit consecutive passes that may ignore a coverage gap when the applied
compartment watermark is missing or stale; after this limit, the gap is repaired
instead of suppressed" (`:83-84`). Task 4 asks what prevents indefinite deferral,
so I read the counter's full state machine to test whether "consecutive passes"
means what it says.

## Evidence trail

The constant. `const BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT: u8 = 3;`
(`transform.rs:85`).

The counter, `transform.rs:3925-3940`:

```
let mut boundary_divergence_pending_count =
    if req.is_subagent || divergence_inputs_moved || active_legitimate_publication_window {
        loaded.meta.boundary_divergence_pending_count
    } else if divergence_candidate.is_some() {
        if boundary_divergence_retry || compartment_revision_matches {
            0
        } else {
            loaded.meta.boundary_divergence_pending_count
                .saturating_add(1)
                .min(BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT)
        }
    } else {
        0
    };
```

The first arm is the one that matters. `active_legitimate_publication_window` is
`ctx.historian_active || ctx.wrapup_active` (`:3924`). When it holds, the counter
is *carried forward unchanged*: not incremented, not reset. So a pass taken inside
that window advances nothing.

The recut, `transform.rs:3941-3947`:

```
let boundary_divergence_recut = divergence_candidate.filter(|_| {
    boundary_divergence_retry
        || compartment_revision_matches
        || (!active_legitimate_publication_window
            && boundary_divergence_pending_count >= BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT)
});
```

The third disjunct also requires `!active_legitimate_publication_window`, so the
limit-driven repair cannot fire inside the window at all. The first two disjuncts
can: `boundary_divergence_retry` is the CAS-retry carry-over
(`:2289`), and `compartment_revision_matches` (`:3913-3918`) means the applied
watermark is coherent, in which case the gap is genuinely a defect rather than a
publication in flight.

The reset after repair, `:3948-3950`, also conditions on
`!active_legitimate_publication_window`.

The intended reading is documented at `:3919-3923`: "A non-idle durable historian
phase and the process-local wrapup latch are state proofs that publication may
legitimately be ahead of rendered coverage. Retain prior evidence while either
proof holds: incrementing would manufacture a provider-cache bust, while
resetting would forget a genuinely damaged row. A damaged row seen during wrapup
waits for the latch guard to end, bounded by the 3,800-second wrapup request
budget documented on the context."

That comment bounds the wait by the wrapup budget. But the condition it guards
ORs in `ctx.historian_active`, and `transform.rs:601-603` documents that flag
without any duration: "True while this process has a historian
firing/awaiting/validation/publish lease." So the stated bound covers one of the
two disjuncts.

The recut consumer. When `boundary_divergence_recut` is `Some`,
`hard_fold_requested` becomes true (`:4079`), `materialize_reason` is set to
`"boundary_divergence_recut"` (`:4351-4353`), and a stderr line is emitted
(`:5621-5630`). So the repair, unlike the producer-gate skip, is observable.

`*boundary_divergence_detected` is set from the recut (`:3952`) and drives the CAS
loop's carry-over (`:2289`), which is what makes `boundary_divergence_retry` a
one-shot bypass of the counter after a conflict.

## Failure scenario

A session's applied-compartment watermark is stale, so
`compartment_revision_matches` is false and `divergence_candidate` is `Some` on
every pass. The module holds a historian lease for this session across a long run:
`prepare_historian_fire` claims it (`lib.rs:4808-5184`), the producer call goes
out to a language model over Broca, and the lease is held through
`awaiting_producer`, `validating`, and `publishing`. Every transform pass taken
during that interval hits the first arm at `:3926-3928`, carries the count
forward, and is blocked from recutting by `!active_legitimate_publication_window`
at `:3944`.

The count therefore does not reach 3 by taking passes; it reaches 3 only by taking
passes *outside* the window. If the historian run fails and is retried, the window
reopens. The promise in the constant's doc comment, "consecutive passes", is
satisfied only if "pass" is read as "pass outside a publication window", which the
comment does not say.

## Timing windows and dependencies

Window: the union of all historian and wrapup lease intervals for the session.
`wrapup_active` is bounded at 3,800 seconds (`transform.rs:604-606`).
`historian_active` is unbounded from the 4b slice's point of view.

Dependency: `divergence_inputs_moved` (`:3903-3905`) also freezes the counter, but
it is set when a revalidation observed the m1 inputs moving, which is genuine
progress rather than a stall.

## What a test must construct

Two tests. The bounded case, which the existing suite covers in part: construct a
coverage gap with a stale watermark, take three passes with no historian or wrapup
lease, and assert `materialize_reason == Some("boundary_divergence_recut")` on the
third. `transform.rs:20699` (`for _ in 1..BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT`),
`:20750` (`for _ in 0..usize::from(BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT) + 1`),
and `:20769` (`for expected_count in 2..BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT`)
already drive the constant.

The uncovered case: hold `ctx.historian_active` true across N passes for N well
above 3, with the same stale watermark, and assert the count does not exceed its
carried value and no recut fires. Then release the lease and assert the recut
fires within three further passes. `with_producer_factory` (`lib.rs:3676-3770`)
is the seam for holding a historian lease; `historian_active`
(`lib.rs:4427-4532` group) is the reader.

## Investigation log

### Q: Does any of the three existing tests hold a publication window open?

- Sources examined: the three loops at `transform.rs:20699`, `:20750`, `:20769`
  and the surrounding test bodies' construction of `ProducerContext`.
- Findings: The 4b slice's test fixtures construct `ProducerContext` with
  `historian_active` and `wrapup_active` at their defaults. I did not find a test
  that sets either true while driving the divergence counter.
- Missing evidence: the inline test module is 16,815 lines and flat, with no inner
  `mod` to index by (recorded in the part-4 scope map at
  `_lenses/scope-map-and-risk-ranking.md:397-399`), so this is a grep result, not
  an exhaustive read.
- Conclusion: unresolved, needs a name-level grep of all 280 transform tests for
  `historian_active`. Recorded as `Exercised: partial` on that basis.

### Q: Is `historian_active` bounded?

- Sources examined: `transform.rs:601-603`, `:3919-3923`, `lib.rs:8311`.
- Findings: The doc comment describes the lease's phases but no maximum duration.
  The parallel `wrapup_active` comment does state a budget, which makes the
  omission for `historian_active` look deliberate rather than accidental.
- Missing evidence: `historian.rs` is sub-part 4a.
- Conclusion: unresolved, needs the 4a lens. This is the same open question as in
  `sel-queued-drop-drains-within-cache-ttl-window`, and both records depend on it
  for their bound.
