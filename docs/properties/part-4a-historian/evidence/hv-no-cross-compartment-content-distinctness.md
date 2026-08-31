# hv-no-cross-compartment-content-distinctness

## Discovery trigger

Task item 4 names "output that duplicates one item many times" as an adversarial
shape to test the gate against. The gate's range machinery is thorough, so the
question is whether range discipline accidentally implies content discipline. It
does not: ranges must be disjoint, bodies need not be.

## Evidence trail

`validate_parsed_compartments`
(`crates/mc-module/src/historian_validate.rs:983-1084`) is the only per-set
validator. It iterates with `for (index, compartment) in compartments.iter().enumerate()`
at `:997` and inside the loop touches exactly these fields:

- `compartment.p1` — presence and non-blankness, `:1000-1008`.
- `compartment.start_message`, `compartment.end_message` — ordering `:1009-1014`,
  bounds `:1015-1020`, presence `:1021-1032`, contiguity `:1033-1050`.

No `title`, `content`, `p2`, `p3`, `p4`, `importance`, or `episode_type` is read
in the loop. The loop carries exactly one piece of cross-element state,
`expected_start` (`:995`, advanced at `:1051`), which is an ordinal. There is no
set, map, or previous-content variable anywhere in the function.

Checked the other candidate sites:

- `map_parsed_compartments_to_chunk` (`:934-981`) iterates and clones each field
  into a `ValidatedCompartment` (`:964-978`). No comparison.
- `parse_compartment_output` (`:264-446`) collects compartments into a `Vec` and
  sorts by `start_message` at `:436`. A sort by start alone; no dedup, and no
  `dedup_by` anywhere in the file.
- `validate_historian_output` (`:450-641`) after validation only pops the last
  element (`:555`) and filters side channels. No content inspection.
- The publish projection `to_stored_compartment` (`historian.rs:38-67`) clones
  per compartment with no set-level view.
- The store insert (`mc-store/src/lib.rs:12267-12290`) is a per-row upsert keyed
  by sequence; duplicate content across distinct sequences is a legal insert.

So the property is unenforced end to end.

One nuance that makes the shape easier for a model to produce than it looks:
`:313-316` already duplicates content WITHIN a compartment, backfilling `p2` from
`p1` and `p3` from `p2`-or-`p1`. So the codebase treats intra-compartment tier
duplication as normal, which means an inter-compartment duplicate does not look
anomalous to any existing code path.

## Failure scenario

Chunk 100..=139, forty ordinals covering four distinct topics. The producer
degrades (a quantised fallback model, a truncated context, a repetition loop) and
emits four correctly-ranged compartments with the same body:

```
<output><compartments>
<compartment start="100" end="109" title="Session work" ...><p1>The user worked on the codebase.</p1></compartment>
<compartment start="110" end="119" title="Session work" ...><p1>The user worked on the codebase.</p1></compartment>
<compartment start="120" end="129" title="Session work" ...><p1>The user worked on the codebase.</p1></compartment>
<compartment start="130" end="139" title="Session work" ...><p1>The user worked on the codebase.</p1></compartment>
</compartments><meta><unprocessed_from>140</unprocessed_from></meta></output>
```

Every gate check passes. Ranges are contiguous and disjoint, each start is the
expected next present ordinal (`:1039-1050`), each `p1` is non-blank
(`:1000-1008`), `unprocessed_from` is `chunk_end + 1` (`:1063`).

Discard-last DOES fire here, because `compartments.len() >= 2` (`:539`) and the
lookahead distance is `139 - 139 = 0`, which is at most
`BOUNDARY_HEALING_SLACK = 2` (`:19`, `:554`). So the fourth is popped and three
identical compartments publish, with `discarded_last = true`, which additionally
suppresses every side channel (`:1091-1093`).

Result: m0 renders three consecutive history blocks with identical headings and
identical bodies covering 100..=129. Coverage advances to 129. The agent sees one
topic where the user had three. Nothing in the system flags the repetition:
`decay_render` assigns each a decay curve index by position
(`decay_render.rs:265-275`) and renders each independently, and the next
historian run is shown these rows as calibration examples
(`historian_prompt.rs:267-278`), so the repetition becomes the model's own
reference for what good output looks like.

The raw text survives in `raw_chunk_messages` (`historian.rs:1727`), so the
failure is again a served-context failure.

## Timing windows and dependencies

None. Single-firing input admission.

The dependency worth naming is the feedback loop. `render_session_references_block`
(`historian_prompt.rs:267-278`) shows the last `SESSION_REF_WINDOW = 6`
compartments (`:15`) to the next run. Three identical rows occupy half that
window, so a degenerate run measurably biases the next one. That makes this a
compounding rather than a one-shot failure, which is the reason to catalog it
separately from the near-empty case.

## What a test must construct

Direct unit test:

1. Chunk `100..=139` with dense `present_ordinals`, all lines anchorable.
2. The four-compartment document above.
3. Assert the current behaviour is `Ok`, then assert the property directly:
   collect `(title, p1, p2, p3, p4)` from `validated.compartments` into a set and
   assert its length equals `validated.compartments.len()`. Today that assertion
   fails with 1 versus 3, which is the finding.

The oracle here is independent and cheap: distinctness of a tuple, no reference
model needed. That makes this one of the cheapest records in the set to convert
into a real check.

A property-based version generates N contiguous ranges over a chunk and a body
corpus, and asserts distinctness of accepted bodies. Care is needed on one point:
a legitimate model MAY emit two compartments with identical `p3` (the densest
tier) while differing at `p1`, because `:314-316`'s fallback chain collapses
tiers. So the assertion should be on the full tuple, not on any single tier, or it
will false-positive on correct output.

## Investigation log

### Q: Could two genuinely distinct topics legitimately produce byte-identical bodies?

- Sources examined: `historian_validate.rs:313-317` (the tier backfill),
  `historian_prompt.rs:218-265` (`render_session_ref_compartment`, which shows the
  model the expected shape), `testdata/validate-golden.json` (all 16 cases),
  `historian_validate.rs:1367-1375` (the `xml` test helper, which derives every
  body from the compartment title).
- Findings: Every fixture in the tree gives each compartment a distinct body
  derived from its title. The prompt's reference block shows per-compartment
  distinct bodies. Nothing in the contract contemplates identical bodies for
  distinct ranges. The one legitimate collapse is intra-compartment
  (`p1`/`p2`/`p3` equal when denser tiers are omitted), which the full-tuple
  assertion tolerates.
- Missing evidence: none needed.
- Conclusion: resolved with answer — no legitimate case produces identical full
  tuples across distinct ranges, so the assertion is safe.

### Q: Does the store's upsert collapse duplicate rows, masking the effect?

- Sources examined: `mc-store/src/lib.rs:12246-12290` (the compartment upsert and
  its `excluded.` assignments at `:12256-12257`), `:12267` (the column list),
  `:12288-12289` (the importance and episode_type binds).
- Findings: The upsert's conflict target is the row key, and `importance` and
  `episode_type` are assigned from `excluded`, which is an update-on-conflict for
  the SAME key. Three compartments with distinct sequences and distinct ranges are
  three distinct keys, so all three insert. Content is not part of any uniqueness
  constraint.
- Missing evidence: the exact `ON CONFLICT` target column list was read at
  `:12256-12257` but the surrounding statement text was not fully transcribed
  here; the conclusion rests on distinct sequences producing distinct keys, which
  `to_stored_compartment`'s `sequence: c.sequence as i64` (`historian.rs:41`)
  guarantees since `:965` assigns `sequence_offset + index`.
- Conclusion: resolved with answer — no collapse. All duplicates persist.
