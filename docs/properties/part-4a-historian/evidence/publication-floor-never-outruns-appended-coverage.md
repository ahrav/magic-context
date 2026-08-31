# publication-floor-never-outruns-appended-coverage

## Discovery trigger

The publish transaction raises `meta.publication_floor_ordinal` (`mc-store:9484-9488`)
in the same commit that appends compartments. Asking what happens if those two
disagree led to the floor's provenance, which runs from the validator's
discard-last healing through two crates without any check relating the two.

## Evidence trail

### Where the floor comes from

`crates/mc-module/src/historian_validate.rs`:

- `:487-491` rejects a parsed output with no compartments:
  "Historian returned no usable compartments."
- `:539-556` discard-last healing: when not in emergency, not forcing keep, and
  there are at least two compartments, if `lookahead_distance <=
  BOUNDARY_HEALING_SLACK` (`:19`, value 2) and popping would not split a completed
  tool arc, the last compartment is popped and `discarded_last` is set.
- `:625-635` forward-progress check: `offset` is the last prior compartment's end
  plus one, or the chunk start when there are no priors; if `last_new_end < offset`
  the output is rejected with "no forward progress beyond raw message ...".
- `:629` `let last_new_end = compartments.last().map(|c| c.end_message).unwrap_or(0);`
  which reads the list **after** the pop.
- `:632-638` the returned `unprocessed_from: last_new_end.saturating_add(1)`, with
  the comment at `:633-637` that it is "a publication floor, not a promise that the
  next integer ordinal exists", because consumer legs may retire ordinals.

`crates/mc-module/src/historian.rs`:

- `:1725` `publication_floor_ordinal: validated.unprocessed_from`.
- `:423` the field on `ValidatedPublishRequest`.
- `:523` copied onto `HistorianPublishRequest`.

`crates/mc-store/src/lib.rs`:

- `:1776` the field on `HistorianPublishRequest`.
- `:9484-9488`:
  `meta.publication_floor_ordinal = Some(meta.publication_floor_ordinal.unwrap_or(1).max(request.publication_floor_ordinal.max(1)));`
  which is monotone by construction and floors at 1.

### Why the upper bound holds

The compartments passed to `append_compartments_tx` are the same post-pop list that
produced `last_new_end`: `historian.rs:462-467` maps
`request.validated.compartments`, and `publish_output_from_awaiting` passes
`validated: &validated` (`:1723`) alongside
`publication_floor_ordinal: validated.unprocessed_from` (`:1725`). So
`floor == MAX(end_message over appended) + 1` exactly, not merely at most.

The `max` at `:9484-9488` means a later publish cannot lower it, and an earlier
higher floor is preserved. That is the only way the equality can become a strict
inequality: if a prior publish left a higher floor than this publish's coverage
justifies. Since floors are derived from monotonically advancing chunk ranges
(`historian_chunk.rs:629-642` starts past `MAX(end_message)`), a later publish's
floor should exceed an earlier one's.

### Why coverage cannot be empty

Three independent refusals:

- `historian_validate.rs:487-491`, empty compartments after parsing.
- `historian_validate.rs:625-635`, no forward progress.
- `mc-store:12614-12616`, `append_compartments_tx` treats an empty list as
  `Appended` and writes nothing, but that list cannot be empty by the above.

`insert_chunk_transcripts_tx` also returns early on an empty list
(`mc-store:12679-12681`), which would silently skip the original-message capture.
That is the same guard from a different angle.

### What the floor does downstream

`crates/mc-module/src/boundary.rs`:

- `:1417-1426` `semantic_snap_boundary` skips messages with
  `message_ordinal < publication_floor_ordinal` as snap candidates.
- `:1339-1357` completed-tool-arc fencing uses
  `arc.inv_ordinal >= publication_floor_ordinal`.

`crates/mc-store/src/lib.rs:12419` uses
`request.publication_floor_ordinal.saturating_sub(1)` as a default range start for
side-channel items when the compartment list is empty.

## Failure scenario

If the floor were raised past the appended coverage, the ordinals in the gap would
be excluded from semantic boundary snapping (`boundary.rs:1426`) and from tool-arc
fencing (`:1349`), while no compartment summarized them. They would still be served
verbatim in the live tail, so this is not content loss. The symptom would be a
boundary that cannot snap to a good place in that window, producing worse folds
later, and a tool arc that the fence stops protecting.

The reverse, a floor lower than coverage, is prevented by the `max` and by the
derivation. It would be harmless anyway: a lower floor only widens the candidate
set.

The dangerous variant is a floor raised with **no** coverage at all, which would
require an accepted publish with zero compartments. Three guards prevent it, and
the record's value is pinning that all three are load-bearing, since removing any
one of them alone would still leave two.

## Timing windows and dependencies

No timing window. This is a data-flow invariant across two crates.

Dependencies:

- The discard-last pop must happen before `last_new_end` is computed. It does:
  `:539-556` then `:629`. If a future change moved the pop after, the floor would
  outrun coverage by exactly the popped compartment's span. That is the concrete
  regression this record guards.
- `historian_chunk.rs:629-642` must keep starting the next chunk past
  `MAX(end_message)`, or the monotone `max` could preserve a floor ahead of a
  later, lower-ranged publish.

## What a test must construct

1. The general invariant, cheap: after any accepted publish, assert
   `meta.publication_floor_ordinal == MAX(end_message) + 1` over the session's
   compartments, and that it did not decrease.
2. The healed case, which is the one that would catch a reordering regression: a
   validated output with at least two compartments where the last one's end is
   within `BOUNDARY_HEALING_SLACK` of `chunk.end_index`, so the pop fires. Assert
   the floor equals the **surviving** last compartment's end plus one, not the
   popped one's. `historian.rs:2309` and `:4199` already assert specific floor
   values; the addition is asserting the relation rather than a constant.
3. The emergency and force-keep cases, where the pop is suppressed
   (`historian_validate.rs:538`), so the floor equals the emitted last end.
4. The rejection cases: `historian.rs:2360` and `:3006` already assert the floor
   stays `None` after a rejected publish.

## Investigation log

No open questions. The derivation was traced end to end at `HEAD` across
`historian_validate.rs:638`, `historian.rs:1725` and `:523`, and
`mc-store:9484-9488`, and the three empty-coverage refusals were each read. The
one thing this record deliberately does not settle is whether the floor's *value*
is the right one for boundary quality; that is a boundary-lens question. This
record only establishes that it cannot exceed what was actually appended.
