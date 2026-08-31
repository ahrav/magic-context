# hv-heal-extends-range-without-revalidating-content

## Discovery trigger

Task item 3 asks which content-integrity invariants the code actually claims,
including ordering and no-truncation-mid-unit. The healing functions are where the
gate stops being a pure filter and becomes a mutator: they rewrite the model's
declared range. The question that follows is whether the body is still entitled to
the range after the rewrite. Nothing re-examines it.

## Evidence trail

### Two healers mutate ranges before any content check

Both run at `crates/mc-module/src/historian_validate.rs:493-504`, between parse
(`:486`) and mapping (`:506`), and before `validate_parsed_compartments` (`:514`).

`heal_compartment_gaps` (`:899-932`) closes an interior gap:

```rust
for i in 1..compartments.len() {
    let gap_start = compartments[i - 1].end_message.saturating_add(1);
    let gap_end = compartments[i].start_message.saturating_sub(1);
    if gap_end < gap_start { continue; }
    let omitted_present: Vec<u64> = present_ordinals.iter().copied()
        .filter(|o| *o >= gap_start && *o <= gap_end).collect();
    if omitted_present.is_empty() { continue; }
    let fully_inside_tool_only = omitted_present.iter().all(|ordinal| {
        tool_only_ranges.iter().any(|r| r.start <= *ordinal && r.end >= *ordinal)
    });
    // Production replay showed contiguous narrative coverage. Tool-only noise is
    // therefore the sole safe gap to absorb; any narrative gap rejects before the
    // publish path can advance its durable boundary.
    if fully_inside_tool_only {
        compartments[i - 1].end_message = *omitted_present.last().expect("...");
    }
}
```

The only field written is `end_message` (`:927`). No `title`, `content`, or tier is
touched.

`heal_terminal_completed_tool_arc` (`:864-897`) extends the last compartment
forward to close a straddled arc:

```rust
for _ in 0..=arcs.len() {
    let boundary = last.end_message.saturating_add(1);
    let next_end = arcs.iter()
        .filter(|arc| arc.end <= chunk_end
            && completed_tool_arc_crosses_boundary(arc.start, arc.end, boundary))
        .map(|arc| arc.end).max().unwrap_or(last.end_message);
    if next_end == last.end_message { break; }
    last.end_message = next_end;
}
if last.end_message != original_end {
    if let Some(unprocessed) = unprocessed_from.as_mut() {
        *unprocessed = next_present_after(present_ordinals, last.end_message)
            .unwrap_or_else(|| last.end_message.saturating_add(1));
    }
}
```

Again only `end_message` (`:889`), plus a rewrite of the model's declared
`unprocessed_from` (`:891-896`). The loop bound `0..=arcs.len()` with the
`break` at `:886-888` makes it terminating and monotone.

### The durable boundary IDENTITY also changes, not just the number

This is the part that makes the record more than bookkeeping.
`map_parsed_compartments_to_chunk` (`:934-981`) runs AFTER healing and resolves the
end ordinal to a block id:

```rust
let end_line = chunk.lines.iter().find(|line| line.ordinal == compartment.end_message);
...
end_message_id: end_line.message_id.clone(),
```

`:945-948` and `:969`. So the stored `end_message_id` names the block at the HEALED
ordinal, not the one the model chose. `ChunkLine.message_id` is documented at
`:32-34` as "The real flat block id (`<mid>#<index>`) of the line's last block",
and `:36-37` explains why it matters: "A compartment must end on an anchorable block
so publication cannot mint an impossible coverage boundary." The healed end IS
checked for anchorability at `:958-963`, which is the right check; what is not
checked is whether the body describes that block.

### What still protects the run

Recorded so the record is not read as claiming healing is unguarded:

- Gap healing only fires when EVERY omitted present ordinal lies inside a
  `tool_only_ranges` entry (`:918-926`). A single narrative ordinal in the gap
  leaves the gap open, and `:1046-1049` then rejects with "gap before present
  message". Covered by `five_message_narrative_gap_rejects_like_typescript_validator`
  (`:1426`) and two golden cases.
- Arc healing only considers arcs with `arc.end <= chunk_end` (`:880`), so it
  cannot extend past the pinned chunk. Covered by
  `completed_arc_past_chunk_end_rejects_instead_of_publishing_half` (`:1710`).
- The healed end must be anchorable (`:958-963`), covered by
  `compartment_end_must_be_anchorable` (`:1665`).
- After the terminal heal rewrites `unprocessed_from`, the cross-check at
  `:1054-1060` still runs against the healed contiguity, so the declared value
  cannot drift free of the healed ranges.

### What is not checked

No re-examination of `title`, `content`, or `p1`..`p4` after either mutation. There
is no such check to skip: as established in
`hv-degenerate-body-passes-content-gate.md`, the only content check in the module is
`p1` non-blankness at `:1000-1008`, and it is insensitive to the range. So the
absence here is a special case of a general absence, which is why this record is
scoped to the range-versus-body entitlement rather than to content quality.

### The load-bearing premise is a comment

`:923-925` justifies gap healing with "Production replay showed contiguous
narrative coverage. Tool-only noise is therefore the sole safe gap to absorb". Per
METHOD.md rule 3 that is a claim under test. Two things it rests on:

1. That `tool_only_ranges` genuinely contains only transcript noise.
2. That absorbing such a gap into the PRECEDING compartment is semantically right
   rather than absorbing it into the following one, or leaving it uncovered.
   `:927` chose the preceding compartment; no comment explains the choice.

## Failure scenario

Chunk 300..=340. `historian_chunk` marks 311..=318 as tool-only (a long file-read
result plus its invocation). The model emits:

```
<compartment start="300" end="310" title="Reproducing the bug" ...><p1>...</p1></compartment>
<compartment start="319" end="340" title="Fixing the parser" ...><p1>...</p1></compartment>
```

The model deliberately skipped 311..=318 as noise, which is reasonable behaviour.

`heal_compartment_gaps` computes `gap_start = 311`, `gap_end = 318`, finds all
eight omitted ordinals inside a tool-only range, and sets the FIRST compartment's
`end_message = 318` (`:927`).

Mapping then stamps `end_message_id` from chunk line 318, which is a block inside
the tool result.

Published state: a compartment titled "Reproducing the bug", whose body describes
ordinals 300..=310, now durably claims coverage of 300..=318, with its boundary
identity naming a block in the middle of a tool output the summary never mentions.

Consequences, concretely:

- Coverage advances eight ordinals further than the summary describes. Those eight
  are behind the watermark and no longer served, replaced by a summary that does
  not mention them. Since they were tool-only noise, that is the intended trade.
- The boundary identity is the fragile part. Downstream code keys on
  `end_message_id`: `to_stored_compartment` looks up
  `boundary_dates.get(&c.end_message_id)` (`historian.rs:49-50`), so a healed
  boundary can silently get no date if the tool-result block has no date entry.
  `historian_status_summary` and coverage comparisons elsewhere key on the same id.
- If the premise at `:923-925` is ever wrong, that is, if a `tool_only_ranges`
  entry can contain narrative, then this path silently folds real conversation
  behind a summary that never described it, with no rejection anywhere. That is the
  reason to catalog it.

## Timing windows and dependencies

The window is the four-statement span between parse and validate:
`:486` parse, `:493-497` gap heal, `:498-504` terminal heal, `:506` map, `:514`
validate. No concurrency; the ordering is what matters, and it is fixed.

The dependency that decides severity is the provenance of `chunk.tool_only_ranges`
and `chunk.completed_tool_arcs`. Both are inputs to
`validate_historian_output` from `HistorianChunk` (`:58-64`), built by
`historian_chunk.rs`. If they are derived purely from module-side classification
they are trustworthy and healing is a controlled widening. If any model or harness
input influences them, they become an attacker-controlled admission widener. That
provenance was not audited in this pass and is the record's open question.

## What a test must construct

Gap-healing side, extending the shape of
`twenty_message_tool_only_gap_heals_like_typescript_validator` (`:1443`):

1. Chunk `300..=340`, dense, all anchorable, with
   `tool_only_ranges: vec![MessageRange { start: 311, end: 318 }]`.
2. The two-compartment document above.
3. Assert healing happened: `validated.compartments[0].end_message == 318`. That
   part passes today.
4. Assert the property: every newly covered present ordinal lies inside a
   `tool_only_ranges` entry. Compute the delta between the parsed and validated
   `end_message` and check each ordinal in it. This passes today and is worth
   pinning, because it is the invariant the comment at `:923-925` asserts and
   nothing currently checks.
5. Assert the boundary identity moved:
   `validated.compartments[0].end_message_id == "msg-318"`. This makes the identity
   consequence explicit rather than incidental.

Negative case, to pin the guard: same fixture with `tool_only_ranges` covering only
311..=317, leaving 318 narrative. Assert `Err` containing "gap before present
message". This exercises the `all()` at `:918-922` at its boundary, which no
current test does.

Terminal-heal side: a chunk with `completed_tool_arcs` straddling the model's
chosen end, asserting both the extension (`:889`) and the `unprocessed_from`
rewrite (`:891-896`). `terminal_unprocessed_boundary_closes_a_completed_arc_forward`
(`:1683`) covers this; the increment is asserting the same
newly-covered-ordinals property as step 4.

## Investigation log

### Q: Are tool_only_ranges and completed_tool_arcs free of model influence?

- Sources examined: `historian_validate.rs:58-64` (the two fields and their doc
  comments), `historian_chunk.rs:23-25` (the imports, which include `MessageRange`),
  `historian_chunk.rs:1329` and `:1419-1428` (test call sites that build a chunk and
  feed it to the gate), `boundary.rs:1204-1210`
  (`completed_tool_arc_crosses_boundary`), `boundary.rs:1212-1232`
  (`build_tool_arcs`, which derives arcs from `BoundaryMsg` blocks, skipping
  `provider_executed` blocks and requiring an `arc_id`).
- Findings: `build_tool_arcs` derives arcs from decoded message block structure
  (`arc_id`, `provider_executed`, block kind), which is harness-supplied
  conversation data rather than historian-model output. So the historian producer
  cannot influence them within its own run. Harness-supplied data is a different
  trust tier and is Part 4f's codec territory. The `tool_only_ranges` derivation
  itself lives in `historian_chunk.rs` and was not located precisely in this pass.
- Missing evidence: the exact construction site of `tool_only_ranges` inside
  `historian_chunk.rs`, and whether it depends on anything a model produced in an
  earlier run (a prior compartment, for instance).
- Conclusion: unresolved, needs the chunk-construction lens. Partial answer
  established: `completed_tool_arcs` traces to block structure via
  `boundary.rs:1212-1232`, not to model text, so the terminal healer is not
  producer-influenced. The gap healer's input is the open half.

### Q: Why does gap healing extend the PRECEDING compartment rather than the following one?

- Sources examined: `historian_validate.rs:904-931` (the loop and its indexing),
  `:923-925` (the only comment), `:1039-1051` (the contiguity check that consumes
  the result), `:1051` (`expected_start = next_present_after(&chunk_ordinals, compartment.end_message)`).
- Findings: The choice is mechanically necessary given how contiguity is checked.
  `expected_start` advances from the PREVIOUS compartment's `end_message`, so
  extending the preceding compartment is what makes the following compartment's
  start match `expected`. Extending the following compartment's start backward would
  not help, because its start must equal `expected`, and lowering `expected` requires
  raising the preceding end. So the direction follows from the contiguity invariant
  rather than from a semantic judgement about which summary should own the noise.
- Missing evidence: none needed for the mechanism. The semantic question (should the
  noise belong to the earlier or later narrative unit) is not answered by the code
  and does not appear to matter while the absorbed ordinals are genuinely noise.
- Conclusion: resolved with answer — the direction is forced by the contiguity
  check at `:1039-1051`, not chosen. That is worth recording because it means the
  healer and the contiguity check are coupled, and changing either in isolation
  would break the other.
