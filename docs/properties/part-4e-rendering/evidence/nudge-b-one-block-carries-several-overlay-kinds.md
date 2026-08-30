# nudge-b-one-block-carries-several-overlay-kinds

## Discovery trigger

Task 5 asked whether two overlays can target the same location and how conflicts
resolve. Within one kind the answer is no, by construction. Across kinds the answer
is yes, and the resulting combined state is where the fixed mutator order and the
envelope interactions actually get exercised. Nothing in the suite reaches it, so
this is the `sometimes` record.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### Four independent maps, one key space

`crates/mc-module/src/transform.rs:1724-1730`:

```
#[derive(Debug, Clone, Default)]
struct TagOverlayState {
    tag_by_block_id: BTreeMap<String, i64>,
    temporal_by_block_id: BTreeMap<String, String>,
    user_hint_by_block_id: BTreeMap<String, String>,
    channel1_by_block_id: BTreeMap<String, String>,
}
```

All four are keyed by `block_id`. Nothing prevents the same key appearing in more
than one, and nothing checks for it.

### All four are consulted for the same block, in a fixed order

`apply_tag_overlay_to_message` (`:8208-8269`), inside one loop iteration over
`blocks`:

```
8232:            let mut block_changed = false;
8233:            if let Some(kind) = taggable_kind(block) {
8234:                if let Some(tag_number) = overlay.tag_by_block_id.get(&block.id) {
8235:                    block_changed |= apply_tag_prefix_to_block(
...
8245:            if let Some(prefix) = overlay.temporal_by_block_id.get(&block.id) {
8246:                block_changed |= prepend_temporal_to_block(target, prefix);
8247:            }
8249:            if let Some(hint) = overlay.user_hint_by_block_id.get(&block.id) {
8250:                block_changed |= append_user_hint_to_block(target, hint);
8251:            }
8252:            if let Some(reminder) = overlay.channel1_by_block_id.get(&block.id) {
8253:                block_changed |= append_channel1_to_block(target, reminder);
8254:            }
```

Order: tag prefix, temporal prefix, user hint, Channel-1 reminder. Fixed by source
position, not by data.

### Within one kind, duplicates are impossible

Each map is built by `collect()` into a `BTreeMap` from a row vector
(`tag_overlay_state`, `:8140-8170`), so a duplicate key would silently keep the
last entry. But duplicates cannot arise:

- `mc_tags` has `UNIQUE(session_id, block_id)` (`mc-store/src/lib.rs:557`).
- `mc_channel1_appends` has `PRIMARY KEY (session_id, block_id)` (`:568`).
- `mc_user_hints` and `mc_temporal_marks` likewise key on
  `(session_id, block_id)` (`:592-598`, `:608-614`).
- The in-memory vectors cannot double up either: the hint decision is skipped when
  a row already exists for the block (`transform.rs:8794`), and the Channel-1
  target excludes blocks already in `existing_blocks` (`:9801`).

So intra-kind conflict resolution never runs. Cross-kind composition always does.

### The consequence of the order

`apply_tag_prefix_to_block` (`:8270-8303`) for a user text block computes
`prepend_tag(tag_number, &base)` where `base` is the block text
(`:8288-8291`). `prepend_tag` (`:8394-8399`) is
`format!("{}{value}", tag_prefix(tag_number))` with `tag_prefix` being
`format!("§{tag_number}§ ")` (`:8390-8392`).

`prepend_temporal_to_block` (`:8334-8343`) then does
`text.insert_str(0, prefix)`, so the temporal comment lands **before** the tag.
Served bytes for a user text block carrying both:

```
<!-- +12m -->
§7§ the user's actual words

<ctx-search-hint>
...
</ctx-search-hint>
```

That ordering has a consequence worth testing. `strip_tag_prefix` (`:8403-8405`)
is `value.strip_prefix(&tag_prefix(tag_number)).unwrap_or(value)`, documented at
`:8401-8402` as "the inverse of [`prepend_tag`]". Applied to the served bytes above
it is a no-op, because the string starts with `<!-- ` and not with `§7§ `. Whether
any caller applies it to post-temporal bytes is the question the combined state
would answer.

Each mutator is individually idempotent against its own output:
`prepend_temporal_to_block` checks `text.starts_with(prefix)` (`:8338`),
`append_user_hint_to_block` checks `text.ends_with(hint)` (`:8350`), and
`append_channel1_to_output` checks `!text.ends_with(reminder)` (`:8364-8367`,
`:8375-8380`). So a re-render over already-overlaid bytes would not double up. But
overlays are applied to fresh ingress bytes each pass, so that guard is a belt.

### Which combinations are reachable

**User text block: up to three.** Tag, temporal, hint.

- Tag needs `taggable_kind(block).is_some()` and a row or overlay entry.
- Temporal needs the block to be the first text block of an authored user message
  (`:8654-8670`), the message to be new relative to the frontier (`:8649-8652`),
  `temporal_enabled` (`:3525`), and a gap at or above
  `TEMPORAL_AWARENESS_THRESHOLD_MS` (5 minutes, `:112`) so
  `temporal_gap_prefix` (`:8172-8177`) returns `Some`. A sub-threshold gap writes an
  empty `marker_text`, which `tag_overlay_state` filters out (`:8152-8156`).
- Hint needs `auto_search_active` (`:3519`), the block to be the user-role text
  block of the eligible authored tail (`:8787-8791`), and a non-empty rendered hint.

**Tool result block: up to two.** Tag and Channel-1.

- Tag needs `taggable_kind` to classify it as `ToolResult`.
- Channel-1 needs `tool_result_can_carry_channel1` (`:9809-9823`) and
  `decide_channel1` to fire.

**All four on one block: impossible.** The temporal marker requires an authored
*user* message (`:8642-8647` filters `role != "tool"` and requires
`is_authored_user_message`), and the hint requires `block.role == "user"`
(`:8789`), while Channel-1 requires `block.kind_tag == "tool_result"` (`:9796`).
The role requirements are mutually exclusive.

### Reachability, both sides

Config defaults: `temporal_awareness` and `memory.auto_search` are both on by
default. `CONFIGURATION.md:644` states it explicitly: "**`temporal_awareness` and
`memory.auto_search` are now ON by default** — set them `false` to opt out."
`memory.auto_search.enabled` default `true` at `:682`.

Module defaults: `default_auto_search_enabled()` returns `true`
(`transform.rs:865-867`). `temporal_active` is
`tagging_active && ctx.temporal_awareness` (`:3525`), so it follows the config.

Shipped setup path: the host sends `serializer_profile: "opencode-aisdk"`
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1339`) and
`tool_present` derived from ctx_reduce availability (`:1945`), which together
satisfy `tagging_surface_active` (`crates/mc-module/src/lib.rs:568-577`).

So the three-overlay user-block state is default-production, given a 5-minute pause
and a prompt that matches a compartment.

## Failure scenario

This is a coverage record, so the scenario is what stays untested rather than a
specific break. Three interactions go unexercised:

1. **Tag inversion after a temporal prefix.** If any consumer strips a tag prefix
   from served bytes, the temporal comment defeats it silently, because
   `strip_tag_prefix` is a `strip_prefix` with an `unwrap_or(value)` fallback
   (`:8403-8405`) and therefore fails open. The `debug_assert_eq!` in `prepend_tag`
   (`:8396-8398`) checks the inverse on the *un-prefixed* string only, so it would
   not catch this.
2. **Imitation defence against a tagged, hinted user block.** For a user role the
   tag path does not call `strip_leading_tag_imitations` (`:8287-8291` applies it
   only when `role == "assistant"`). A later pass re-reads ingress bytes, so the
   `§7§` from the previous render is not present. But if any path ever fed served
   bytes back as ingress, a user block carrying a tag, a temporal comment, and a
   hint envelope is the worst case for that defence, and no test constructs it.
3. **Multi-overlay index shift.** The sibling lens recorded that the full-drop
   filter re-indexes `content` while the overlay still addresses pre-removal
   `block_index` values (`render-a-overlay-targets-stale-indices-after-full-drop-filter`,
   citing `:12014-12031`). With one overlay the consequence is one misplaced
   string. With three on one block the consequence is three, applied in a fixed
   order to a block that did not ask for any of them, producing bytes that look
   deliberately composed.

## Timing windows and dependencies

No race. This is situation coverage over one pass.

The scheduling dependency is real though: the three-overlay user block needs a
5-minute gap between the previous provider response and the current request
ingress, computed from `req.request_observed_at_ms` and
`req.prev_response_completed_at_ms` (`:8683-8698`). A test must supply both fields
with a gap above the threshold; the comment at `:8684-8687` explains why module-side
`now_ms` cannot substitute.

## What a test must construct

The check is `sometimes`, so the assertion is on the situation, not on an outcome.

1. **Marker.** A constant, globally unique marker asserted when a single `block_id`
   appears in two or more of the four maps on an accepted pass, and a second marker
   for three or more. Per `METHOD.md`'s coverage rule the marker names must be
   constant, never constructed from the block id.
2. **The three-overlay user block.** Seed a compartment with rare tokens. Send a
   request whose tail is an authored user message containing two of those tokens,
   with `request_observed_at_ms` and `prev_response_completed_at_ms` set 12 minutes
   apart, on a session with tagging established so the block mints a tag. Assert
   the served text starts with `<!-- +12m -->\n§N§ ` and ends with the
   `</ctx-search-hint>` envelope.
3. **The two-overlay tool result.** Reuse the existing Channel-1 fixture
   (`transform.rs:23551-23590`, which already produces a tagged, reminded tool
   result) and add the assertion that the served bytes carry both `§N§` and
   `<system-reminder>`. The existing test asserts only the reminder
   (`:23569`).
4. **Negative control.** Assert no block ever appears in all four maps, which is
   the resolved-impossible case below and is worth pinning as an invariant.

Existing checks: `tag_overlay_replays_stably_and_new_tail_gets_next_number`
(`:23307`) covers tags alone; `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`:23551`) covers Channel-1 alone. Neither combines, and neither runs in CI.

## Investigation log

### Q: Can a single block ever carry all four overlay kinds?

- Sources examined: the temporal loop's filter (`:8641-8647`), which excludes
  `role == "system"` and `role == "tool"` and requires
  `is_authored_user_message` for user messages; the hint's block selector
  (`:8787-8791`), which requires `block.role == "user"` and
  `CkKind::Text`; the Channel-1 selector (`:9796`), which requires
  `block.kind_tag == "tool_result"`; and `taggable_kind`, which classifies both
  message text and tool results.
- Findings: the temporal and hint paths require a user-role text block; the
  Channel-1 path requires a tool-result block. Mutually exclusive. Maximum is three
  on a user text block (tag, temporal, hint) and two on a tool result (tag,
  Channel-1).
- Missing evidence: none.
- Conclusion: resolved with answer.

### Q: How does an intra-kind conflict resolve, if one could occur?

- Sources examined: `tag_overlay_state` (`:8140-8170`), the four `collect()` calls;
  the primary keys at `mc-store/src/lib.rs:557`, `:568`, `:592-598`, `:608-614`;
  the in-memory guards at `transform.rs:8794` and `:9801`.
- Findings: `BTreeMap::collect` from an iterator of pairs keeps the last value for a
  duplicate key, so resolution would be last-writer-wins in row order. Row order is
  deterministic: `load_channel1_appends` orders by
  `fired_at_ms ASC, block_id ASC` (`mc-store/src/lib.rs:6484-6489`), and the
  temporal and hint loads order by `created_at ASC, block_id ASC`
  (`:5577-5578`, `:5596-5597`). Because `block_id` is the tiebreaker and the primary
  keys make duplicates impossible, the total order is well defined even under a
  coarse clock.
- Missing evidence: none.
- Conclusion: resolved with answer. Deterministic, and unreachable.

### Q: Is the mutator order load-bearing, or incidental?

- Sources examined: `:8233-8254`; `prepend_tag` (`:8394-8399`) and its
  `debug_assert_eq!` at `:8396-8398`; `prepend_temporal_to_block` (`:8334-8343`);
  the comment at `:8244` ("A boundary-lineage alarm forces raw pass-through ...").
- Findings: no comment states an intended order. The two prepends compose so that
  the later one wins the leading position, which puts the temporal comment outside
  the tag. The two appends compose so the later one is further right, which puts
  the Channel-1 reminder after the hint, though they never co-occur. Reversing the
  two prepends would produce `§7§ <!-- +12m -->\nwords`, which would keep
  `strip_tag_prefix` working and is arguably the safer order.
- Missing evidence: no design comment.
- Conclusion: unresolved on intent. Recorded here rather than as a separate finding
  because the consequence depends on whether any consumer strips tag prefixes from
  served bytes, which is 4d's `parse_tag_range_string` territory and is already an
  open question in the sibling lens.
