# render-a-emptied-tail-message-drops-without-a-report

## Discovery trigger

Tracing what the composition can remove turned up a bare `continue` at the end of
the tail loop's `served` handling. Reading back to its producer showed it is the
exit for a message the render emptied, not only for a message that had nothing to
begin with.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

The decision is a two-step. First the `present` predicate at `:12037-12039`:

```
let present = !rendered.content.is_empty()
    || rendered.meta.synthetic
    || !blocks_by_mid.contains_key(msg.mid.as_str());
```

If `present` is false, `output` is `(None, false)` (`:12070-12072`). Then
`:12085-12087`:

```
let Some(served) = served else {
    continue;
};
```

So a message that reached the loop body, passed the retention filter at
`:11856-11862`, and had projected blocks, leaves the array when its `content`
ends up empty.

Three producers can empty `content` inside the same iteration:

1. `apply_surface_strips` (`:11992-12003`, body at `:10371-10458`). On a whole
   message strip it sets `rebuilt.content = vec![CkWireBlock::bare(Text { text:
   sentinel })]` and returns (`:10388-10391`). `sentinel` comes from
   `provider_sentinel_text` (`:9890-9896`), which is the **empty string** when
   `request_accepts_empty_content(req)`. An empty-text block is not an empty
   `content` vector, so this alone does not trip `present`; it matters as the
   input to producer 3.
2. `remove_frozen_historical_reasoning` (`:12035`). It blanks reasoning blocks
   rather than removing them, per the sibling helper at `:11560-11573`.
3. The full-drop filter at `:12013-12023`, which genuinely removes elements:

```
rebuilt.content = rebuilt
    .content
    .into_iter()
    .enumerate()
    .filter_map(|(index, block)| (!drop_indexes.contains(&index)).then_some(block))
    .collect();
```

`drop_indexes` is built from `blocks` at `:12004-12012` for every `ToolCall` or
`ToolResult` whose id is in `full_drop_ids`. If every block of the message is a
full-drop tool block, `content` becomes empty and `present` is false.

The interaction of 1 and 3 is the sharpest form: `apply_surface_strips` collapses
`content` to a single sentinel at index 0, then `drop_indexes` — computed from the
*pre-collapse* projection indices — can contain 0, so the filter removes the
sentinel and `content` is empty.

Nothing records the omission. `BuiltOutput` (`:11001-11006`) carries `messages`,
`cache_entries`, `cache_stats` and `timings`. `SerializedOutputCacheStats`
(built at `:11140-11154`) counts `reused_items` and `serialized_items` only.
`record_output_item` is called with `served: None` at `:12077-12084`, so the
cache learns the message renders to nothing, but no counter or field names it.
`BuildOutputTimings` (`:10894-10909`) has no dropped-message field.

Contrast with the two things the splice does report: a missing anchored todo
pair becomes `TransformError::SyntheticTodoAnchorMissing` (`:12125-12133`), and a
duplicate tool-use id becomes an `eprintln!` (`:11241-11245`). An emptied
message gets neither.

## Failure scenario

A user message carries only a large pasted payload that a `stale_reduce` strip
empties, or an assistant message consists only of tool calls that all become
full drops. The message leaves the served array. The agent's next turn sees a
conversation with a hole in it. If the omitted message was an authored user
directive, the model loses the instruction and no signal exists that it was
dropped, so the loss is indistinguishable from the user never having said it.

## Timing windows and dependencies

None. The decision is per-message, inside one pass, from data all computed in
that pass.

Downstream dependency worth naming: the omission is cached. `cached_output_item`
returns `Option<Option<ServedMessage>>` (`:11098-11109`); the inner `None` is a
cached "renders to nothing", and `cached_or_serialize_output` flattens it away
for the synthetic units (`:11120`) but the tail arm at `:11904-11908` keeps it,
so a later pass with the same identity replays the drop without recomputing it.

## What a test must construct

1. A request with a tail assistant message whose only blocks are two tool calls,
   plus frozen `red:` units of kind `drop` for both, so `full_drop_tool_ids`
   (`:10839-10891`) returns both ids.
2. Render and assert the message is absent from `built.messages`.
3. Assert the independent precondition form for the coverage check: the count of
   mids passing the retention filter at `:11856-11862` is strictly greater than
   the count of emitted non-synthetic mids. That fires on a correct
   implementation whenever a drop happens and never requires observing a
   downstream defect.
4. For the reported half, assert that some field of the response names the
   omitted mid. That assertion fails today, which is the finding.

## Investigation log

### Q: Is the `present` predicate's third disjunct evidence of intent?

- Sources examined: `transform.rs:12037-12039`, `:11796` (`blocks_by_mid`
  construction), `:12520-12531` (`projection_blocks_by_mid_for_output`).
- Findings: `!blocks_by_mid.contains_key(msg.mid)` admits a message that has no
  projected blocks at all. `blocks_by_mid` is keyed only on mids in
  `output_mids`, so a retained message with zero blocks is admitted rather than
  dropped. That reads as "keep a message we have no block-level knowledge of",
  which suggests the author's target for the drop was a message the render
  deliberately emptied.
- Missing evidence: no comment on the predicate, and no commit message was
  consulted because this pass works from `HEAD` only.
- Conclusion: unresolved, needs the author. The predicate is consistent with an
  intentional drop, but nothing states the intent and nothing reports the event.

### Q: Can a message be emptied without any strip or full drop?

- Sources examined: `:11912-11922` (the `blocks.is_empty()` arm), `:11944`
  (`rebuilt = msg.ck.clone()`).
- Findings: when `blocks` is empty the rebuild is a clone of the ingress message
  with the overlay applied, and the overlay never removes. `content` is empty only
  if the ingress message's `content` was empty, and then the third disjunct of
  `present` may still admit it.
- Missing evidence: none.
- Conclusion: resolved with answer — no. Emptying requires the full-drop filter,
  or a strip collapse followed by the full-drop filter.
