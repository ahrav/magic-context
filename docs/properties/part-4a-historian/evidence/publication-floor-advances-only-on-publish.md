# publication-floor-advances-only-on-publish

## Discovery trigger

The emergency arm of `handle_transform_unpaged_value` uses the publication floor
as a race detector and states the invariant it depends on in a comment. A
documented guarantee is a claim under test, and this one is load-bearing at the
exact pressure where a wrong answer is most expensive, so it is worth checking
rather than accepting.

## Evidence trail

### The claim

`crates/mc-module/src/lib.rs:8481-8489`:

> Emergency passes must return the freshest fold obtainable in this request: an
> active run can publish between this request's transform and any of the arms
> above (live entry already released, inline attempt failed, busy wait timed out).
> One final check catches every such interleaving — a PUBLISH is the only event
> that advances the publication floor (an abandon also bumps the row version, so
> row advancement alone would re-run spuriously after a failed inline drive); if
> the floor moved past what this request's transform saw, re-run once so the
> response carries the published fold instead of pre-fold bytes.

### The mechanism that depends on it

`crates/mc-module/src/lib.rs`:

- `:8346` reads the floor into `emergency_pre_floor` before the fire attempt.
- `:8395`, `:8421`, `:8447` re-read it after each of the arms that could have
  published.
- `:8490-8501` the final check: `floor_advanced` compares the current floor
  against `emergency_pre_floor` and re-runs the transform once if they differ.

Note the comparison is `!=`, not `>`, so any change triggers the re-run. Combined
with the monotone `max` at `mc-store:9484-9488`, a change can only be an increase.

### The write sites

I grepped every occurrence of `publication_floor_ordinal` in
`crates/mc-store/src/lib.rs` and separated production from the test module:

- `:1776` field declaration on `HistorianPublishRequest`.
- `:2395` field declaration on `ModuleMeta`, as `Option<u64>`.
- `:9484-9488` the only production assignment, inside the publish transaction.
- `:12419` a read, used as a default range start for side-channel items when the
  compartment list is empty.
- everything from `:16812` onward is inside the store's test module.

In `crates/mc-module/src/lib.rs` every occurrence is a read
(`:4769` writes a request field that is never consumed; `:7963` reports it in
status; `:8346`, `:8395`, `:8421`, `:8447`, `:8493` are the emergency arm).

### Why the abandon paths cannot touch it

`abandon_with_detail` (`historian.rs:348-361`) constructs a
`HistorianDurableState` from `HistorianDurableState::default()`. That type lives at
`meta.historian`; the floor lives at `meta.publication_floor_ordinal`, a sibling
field on `ModuleMeta` (`mc-store:2395`). `persist_historian_state`
(`historian.rs:391-403`) clones the loaded meta and replaces only
`meta.historian` (`:397-398`), so the floor is carried through unchanged. The same
holds for `abandon_historian_run_if_matching_with_publish_failure`
(`historian.rs:1786-1819` wrapping the store call) and
`record_historian_publish_failure_if_matching` (`:588-591`).

The abandon does bump the row version, which is exactly why the comment says row
advancement is the wrong signal.

### Corroborating tests

- `historian.rs:2360` `assert_eq!(loaded.meta.publication_floor_ordinal, None)`
  after `selected_range_identity_drift_during_await_rejects_without_cooldown`.
- `historian.rs:3006` the same assertion after
  `reattach_equal_length_identity_drift_rejects_before_publish`.
- `historian.rs:2309` and `:2404` assert `Some(4)` after publishes, including
  `tail_identity_extension_during_await_still_publishes`.
- `historian.rs:4025` and `:4050` assert floor values across the
  validation-rejection tests.

## Failure scenario

Two directions, both bad, both at 95 percent context fill:

- **False positive.** If some other path advanced the floor, the emergency arm
  would re-run the transform for no reason. One extra transform pass is expensive
  at emergency pressure but not incorrect. The comment shows the authors already
  rejected row-version advancement for exactly this reason, so the sensitivity to
  false positives is understood.
- **False negative.** If a publish could commit without advancing the floor, the
  emergency response would carry pre-fold bytes. At 95 percent fill the module's
  own reasoning (`historian.rs:983-997`) is that forwarding a raw array risks
  provider context overflow. So a false negative here converts a successful fold
  into a possible provider rejection.

A publish that does not advance the floor is possible in principle if
`request.publication_floor_ordinal` were not greater than the existing floor, since
the `max` would then be a no-op. Given the derivation in
`publication-floor-never-outruns-appended-coverage.md`, that needs a publish whose
chunk range ends at or before a previous publish's, which the chunk-start
derivation at `historian_chunk.rs:629-642` prevents. Worth asserting rather than
assuming.

## Timing windows and dependencies

The window is the whole emergency request: between the pre-read at `:8346` and the
post-read at `:8493`, during which a background firing from a previous request can
publish. That is minutes wide, so the interleaving is ordinary rather than rare.

Dependencies:

- The monotone `max`, so `!=` and `>` coincide.
- The chunk-start derivation, so successive publishes have strictly increasing
  floors.
- No other writer appearing. That is what the record guards.

## What a test must construct

1. Enumeration, cheapest and most durable: a test or lint that asserts exactly one
   production assignment to `meta.publication_floor_ordinal` exists. A grep-based
   guard is unattractive; the practical form is asserting the behaviour instead.
2. Negative behaviour: drive a firing to each abandon path (fence rejection, CAS
   conflict, validation rejection, producer failure) and assert the floor is
   unchanged while the row version increased. `historian.rs:2360` and `:3006`
   already cover two of these; the missing ones are the CAS-conflict and
   producer-failure paths.
3. Positive behaviour: publish twice on one session and assert the floor strictly
   increases, which also covers the no-op-`max` worry.
4. The emergency-arm integration: an emergency pass whose fire is `Busy`, a
   background firing that publishes during the busy wait, and an assertion that the
   response carries the post-fold bytes. That exercises the detector rather than the
   invariant, and is the test that would actually catch a regression in either
   direction.

## Investigation log

No open questions. The claim is verified by exhaustive enumeration of
`publication_floor_ordinal` occurrences in both crates, plus the structural
argument that the abandon paths rebuild `meta.historian` and cannot reach a sibling
field of `ModuleMeta`. The one residual, whether a publish can ever leave the floor
unchanged because the `max` is a no-op, is covered by the third test above and by
the sibling record on floor-versus-coverage.
