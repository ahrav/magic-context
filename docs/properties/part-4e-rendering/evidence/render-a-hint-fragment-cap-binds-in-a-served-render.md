# render-a-hint-fragment-cap-binds-in-a-served-render

## Discovery trigger

Task: produce at least one situation-coverage record for a legal state a campaign
must reach, ideally a render with a budget actually binding. Auditing 4e's bounds
showed the user-hint total cap cannot bind (see
[render-a-user-hint-total-cap-cannot-bind](render-a-user-hint-total-cap-cannot-bind.md)),
so the per-fragment cap is the one bound in this sub-part that binds in ordinary
operation.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs`.

### The binding bound

`render_user_hint` applies it once per result (`:9092-9097`):

```
9093:            let fragment =
9093:                crate::caveman::compress(&result.snippet, crate::caveman::CavemanLevel::Ultra);
9094:            format!(
9095:                "- {}",
9096:                one_line_fragment(&fragment, USER_HINT_FRAGMENT_CHAR_CAP)
9097:            )
```

with `USER_HINT_FRAGMENT_CHAR_CAP = 80` (`:113`).

`one_line_fragment` (`:9130-9140`):

```
9131:    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
9132:    if utf16_len(&normalized) <= limit {
9133:        return normalized;
9134:    }
9135:    let mut truncated = utf16_prefix(&normalized, limit.saturating_sub(1))
9136:        .trim_end()
9137:        .to_string();
9138:    truncated.push('…');
9139:    truncated
```

So a served hint whose fragment line ends in `…` is direct evidence that the
truncation branch executed on data that reached the provider array.

### What the truncation must preserve

Three guarantees, all verifiable on the same observed render:

1. **No broken scalar.** `utf16_prefix` (`:9070-9082`) measures in UTF-16 units but
   advances by `char_indices`, accumulating `character.len_utf16()` and slicing at
   `start + character.len_utf8()`. It breaks *before* adding a character that would
   exceed the limit, so it never splits an astral character into a lone surrogate.
   The comment at `:9068-9069` states this is deliberate: match the TypeScript wire
   renderer's UTF-16 measure without producing an invalid half surrogate in Rust
   output.
2. **The envelope survives.** The wrapper is applied after the lines are built
   (`:9111`), so a truncated fragment is still inside a balanced
   `<ctx-search-hint>` element. The `…` lands inside a list item, not at an element
   boundary.
3. **The line bound holds.** Each line is `"- "` plus at most `limit` units, so at
   most 82 UTF-16 units.

### How the hint reaches the served bytes

`render_user_hint` is called at `:8817` inside `maybe_decide_live_user_hint`, whose
result becomes a `UserHintDecisionInput` (`:8819-8823`). `apply_once` calls it at
`:4442` under `if auto_search_active` (`:4441`). The stored row then enters
`TagOverlayState.user_hint_by_block_id` via `tag_overlay_state` (`:8157-8163`,
which filters out empty text and any block id in
`meta.pending_user_hint_block_ids`), and `apply_tag_overlay_to_message` appends it
to the block with `append_user_hint_to_block` (`:8249-8251`, body at
`:8345-8354`). So it is provider-visible text on a user block.

### Preconditions for reaching the state

From `maybe_decide_live_user_hint` (`:8776-8800`) and its caller:

| Precondition | Site |
| --- | --- |
| `!req.is_subagent && req.auto_search_enabled` | `:3519`; default `true` (`:865-867`, `:713`, `:927`) and the shipped producer sets it (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2010`) |
| an authored user message that is the last element of `req.messages` | `:8776-8780`, using `eligible_authored_user_tail` (`:8552-8563`) and `is_authored_user_message` (`:8541-8550`) |
| not the mutation-exempt mid and not the lineage anchor | `:8781-8782` |
| a user text block for it in the projection | `:8787-8792` |
| no existing hint row for that block, and the message above the overlay frontier | `:8794-8797` |
| the prompt long enough and not already carrying a stacked augmentation | `:8805-8810` |
| at least one lexical search result over threshold | `:8811-8817`, `run_user_hint_lexical_search` (`:8843-8964`) |
| at least one result whose Ultra-compressed snippet exceeds 80 UTF-16 units | the state this record wants |

The last one is the ordinary case rather than a corner: `caveman::compress`
shortens text but has no length cap, and a memory or compartment snippet is
typically a sentence or more.

## Failure scenario

There is no defect asserted here. The point of the record is that a campaign can
easily *not* reach the state: it can run a unit test that calls
`one_line_fragment("long text", 80)` directly, cover the truncation lines, and
never once serve a truncated fragment inside a real array. If a future change
moves the `…` outside the list item, changes the wrapper, or replaces
`utf16_prefix` with a byte slice, only a served-render observation catches it —
a line-coverage signal would stay green.

## Timing windows and dependencies

None. The one ordering fact worth noting is that a hint decided for a block the
pass has already served is deferred rather than applied: `apply_once` inserts the
block id into `meta.pending_user_hint_block_ids` when
`user_hint_target_was_served(&loaded.meta, &hint.block_id)` and the pass is not a
bust (`:4452-4459`, predicate at `:8565-8572`), and `tag_overlay_state` filters
those ids out (`:8160`). So the truncated hint may first appear on a later pass
than the one that decided it.

## What a test must construct

1. Seed the store with memories whose snippets are comfortably over 80 UTF-16 units
   after Ultra compression, including at least one with a non-BMP character
   positioned so a naive prefix would split it.
2. Drive a transform pass with `auto_search_enabled` true, an authored user message
   last in the array, a prompt over `auto_search_min_prompt_chars`, and no existing
   hint row for its block.
3. Drive a second pass if necessary, because of the pending-deferral rule above,
   until the hint appears in the served array.
4. On that served render, assert all four things at once: a `<ctx-search-hint>`
   block exists; at least one of its lines ends in `…`; the element's open and
   close tags are balanced; every line is at most
   `USER_HINT_FRAGMENT_CHAR_CAP + 2` UTF-16 units; and the message's text is valid
   UTF-8 containing no unpaired surrogate.
5. Register the observation under a constant marker name so the campaign can assert
   it happened at least once. Do not construct the marker name from the session id
   or the fragment.

## Investigation log

### Q: Is the fragment cap the only bound in 4e that binds in normal operation?

- Sources examined: `transform.rs:113-117` (hint caps), `:144-145` (two 64 MiB tag
  cache budgets), `:143` (`SERIALIZED_OUTPUT_CACHE_BUDGET_BYTES`, 256 MiB),
  `crates/mc-module/src/decay_render.rs:328-348` (the history budget guard),
  `crates/mc-module/src/tail_hygiene.rs:15-18` (the nudge thresholds).
- Findings: the three cache budgets bind only on very large or many-session
  processes, and their effect is extra work rather than changed bytes — the tag
  mint frontier's own comment says so (`transform.rs:7940-7942`). The nudge
  thresholds are gates, not size bounds. The decay history budget genuinely removes
  content from the m0 body, but Part 3 owns the tier ladder and the demotion order,
  so 4e should not re-derive it.
- Missing evidence: none.
- Conclusion: resolved with answer — within 4e's own material the fragment cap is
  the cheapest budget that binds and changes served bytes.

### Q: Does the deferral rule make the state hard to reach in a short campaign?

- Sources examined: `transform.rs:4452-4459`, `:8565-8572`, `:8157-8163`.
- Findings: the deferral applies only when the target block was already in
  `meta.served_output_fingerprint` and the current pass is not a bust. A first
  authored user message on a bust pass is served with the hint immediately.
- Missing evidence: none.
- Conclusion: resolved with answer — reachable in one pass on a bust, two
  otherwise.
