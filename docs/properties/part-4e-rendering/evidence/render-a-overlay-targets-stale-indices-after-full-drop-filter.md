# render-a-overlay-targets-stale-indices-after-full-drop-filter

## Discovery trigger

`apply_tag_overlay_to_message` addresses blocks by `block.block_index`, an index
into the projected message. Checking why it needs a bounds guard led to reading
what happens to `rebuilt.content` between the projection and the overlay, and the
full-drop filter re-indexes it.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

The overlay writes by index. `apply_tag_overlay_to_message` (`:8208-8269`):

```
for block in blocks {
    if block.block_index >= message.content.len() {
        continue;                                    // :8227-8229
    }
    if !is_reduced(block) {
        let target = &mut message.content[block.block_index];   // :8231
```

`blocks` is the projection's blocks for this mid, produced by
`projection_blocks_by_mid_for_output` (`:12520-12531`), so `block_index` is the
block's position in the **ingress** message.

Inside the tail loop the call order is (`:11991-12032`):

1. `apply_surface_strips(..)` at `:11992-12003`. Index-stable in its per-block
   loop (`:10398-10453` writes `rebuilt.content[index]` in place), but its
   whole-message arm replaces the vector with one element and returns
   (`:10388-10391`), and its stale-reduce arm does the same at `:10454-10457`.
2. The full-drop filter at `:12004-12023`. This is the re-index:

```
let drop_indexes: HashSet<usize> = blocks
    .iter()
    .filter(|block| match &block.wire.kind {
        ck_wire::CkKind::ToolCall { id, .. }
        | ck_wire::CkKind::ToolResult { id, .. } => full_drop_ids.contains(id),
        _ => false,
    })
    .map(|block| block.block_index)
    .collect();
if !drop_indexes.is_empty() {
    rebuilt.content = rebuilt
        .content
        .into_iter()
        .enumerate()
        .filter_map(|(index, block)| (!drop_indexes.contains(&index)).then_some(block))
        .collect();
    rebuilt.mark_modified();
}
```

3. `apply_tag_overlay_to_message(&mut rebuilt, msg, blocks, ..)` at `:12024-12031`,
   passing the same unmodified `blocks` slice.

So after step 2 removes element `k`, every element formerly at index `j > k` sits
at `j - 1`, while `blocks[j].block_index` is still `j`.

Two consequences:

- **Skipped overlay.** For the highest indices, `block_index >= content.len()`
  and the guard at `:8227` skips them. A tag prefix, temporal marker, user hint
  or Channel-1 reminder that the pass decided to render is silently not rendered.
  The same guard exists in `apply_surface_strips` at `:10400`, so the strip pass
  has the identical exposure when its own collapse arm ran on an earlier message
  — no, on the same message: the collapse returns immediately at `:10390`, so the
  strip loop is not reached after its own collapse. The strip exposure is only to
  a shift caused by something else, and nothing shifts before it.
- **Misattribution.** For an index that is still in range, the write lands on a
  different block. Concretely, with `content = [ToolResult A (drop), ToolResult B,
  ToolResult C]`: `drop_indexes = {0}`, `content` becomes `[B, C]`, and the
  overlay for B (`block_index == 1`) writes `content[1]`, which is C. C receives
  B's tag prefix. C's own overlay (`block_index == 2`) is then skipped by the
  guard.

The dropped block itself is not the misattribution source, because it is also
skipped: `is_reduced` is `|block| reduced.contains_key(&block.block_index)`
(`:12029`), and `reduced` (`:11924-11943`) is built from `red:` frozen units with
`kind != "image"`, while `full_drop_tool_ids` (`:10839-10891`) requires
`frozen_kind(block.id()) == Some("drop")` — a `red:` unit of kind `drop`. So
every full-drop block is in `reduced` and the overlay skips it at `:8230`. The
harm is to the blocks *after* it.

`message_output_identity` does not save the situation. It hashes the overlay
strings per `block.id` (`:11077-11086`), so the identity correctly describes the
intended overlay; the mismatch is between the intent and the write, both on the
same pass, so the cache faithfully stores the misattributed bytes.

## Failure scenario

A pass computes tag `§7§` for tool result B and `§8§` for tool result C in the
same message, and a third tool result A in that message is a frozen full drop.
The served bytes carry `§7§` on C. `mc_tags` says B is 7 and C is 8. The agent
reads `§7§` above C's output and later calls `ctx_reduce 7`, intending to discard
what it saw. The reduction resolves to B. Content the agent wanted kept is
dropped and content it wanted dropped stays.

## Timing windows and dependencies

No temporal window. The hazard is entirely intra-message and deterministic: given
a message shape with a dropped index followed by two overlay-eligible blocks, it
happens on every pass that renders that message fresh, and the wrong bytes are
then cached under a correct-looking identity.

Dependency: whether such a message shape exists. `full_drop_ids` is keyed on tool
ids, and a tool call and its result normally live in different messages. The shape
needs one message carrying at least three tool blocks, one of them a full drop and
not the last two.

## What a test must construct

1. A `CkIngressMessage` with three `ToolResult` blocks at indices 0, 1, 2, ids
   `a`, `b`, `c`.
2. `core.frozen_units` containing `red:<mid>#0` with `kind = "drop"`, so
   `full_drop_tool_ids` returns `a`.
3. A `TagOverlayState` with `tag_by_block_id` mapping `<mid>#1 -> 7` and
   `<mid>#2 -> 8`.
4. Render, then assert the block whose projected id is `<mid>#1` carries `§7§`
   and the block whose projected id is `<mid>#2` carries `§8§`. Matching by
   projected id, not by position, is the whole point: a position-based assertion
   passes on the defect.
5. Coverage form, asserting only independent preconditions: observe a pass in
   which `drop_indexes` was non-empty **and** at least one `blocks[i]` with
   `block_index > min(drop_indexes)` had a non-empty overlay entry. Both are
   observable without knowing whether the write landed correctly, so the marker
   fires on a correct implementation too.

## Investigation log

### Q: Can a real harness emit a message with a full-drop tool block followed by two overlay-eligible blocks?

- Sources examined: `transform.rs:10839-10891` (`full_drop_tool_ids`), `:8048-8074`
  (`taggable_source`, which makes a `ToolResult` with text output overlay-eligible),
  `:12004-12012` (`drop_indexes`).
- Findings: nothing in the render path constrains a message to one tool block.
  `taggable_source` admits any `ToolResult` whose output is text, error text, or
  content blocks containing text, so three text tool results in one message are
  all eligible. Whether `codec/opencode.rs` or `codec/pi.rs` produces that shape
  was not examined; those files are sub-part 4f.
- Missing evidence: a read of the two codecs' message-grouping rules.
- Conclusion: unresolved, needs 4f. The index shift is proven from source; its
  reachability through a real harness is not.

### Q: Does the reduced-block replacement have the same exposure?

- Sources examined: `transform.rs:11945-11966`.
- Findings: no. It writes `rebuilt.content[block.block_index] = reduced_block(..)`
  before any removal, so indices still agree. It replaces rather than removes, so
  it does not create a shift of its own.
- Missing evidence: none.
- Conclusion: resolved with answer — the reduced path is index-safe. The full-drop
  filter is the only remover inside the loop.

### Q: Is the `block_index >= content.len()` guard a sign the author knew?

- Sources examined: `transform.rs:8227-8229`, `:10400-10402`.
- Findings: both guards exist and neither carries a comment. They prevent a panic,
  which a shift would otherwise cause on the highest indices. They do not address
  a write that stays in range.
- Missing evidence: author intent.
- Conclusion: unresolved. The guards are consistent with either "defence against a
  known shift" or "defence against a malformed projection".
