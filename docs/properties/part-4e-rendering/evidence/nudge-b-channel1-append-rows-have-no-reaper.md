# nudge-b-channel1-append-rows-have-no-reaper

## Discovery trigger

Task 4 named the pattern to look for: "Prior parts found unbounded caller-driven
growth and missing reapers repeatedly, including notes being unbounded with no
reaper in the sibling sub-part; check whether overlays share that shape or
differ." They partly differ, which is the interesting part: one of the three
overlay tables has a reaper and two do not.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The three tables

`crates/mc-store/src/lib.rs`:

- `mc_channel1_appends` (`:563-572`): columns `session_id`, `block_id`,
  `reminder_text`, `fired_at_ms`; `PRIMARY KEY (session_id, block_id)`; index on
  `(session_id, fired_at_ms, block_id)`.
- `mc_user_hints` (`:592-601`): `session_id`, `block_id`, `hint_text`,
  `created_at`; index on `(session_id, created_at, block_id)`.
- `mc_temporal_marks` (`:608-617`): `session_id`, `block_id`, `marker_text`,
  `created_at`; index on `(session_id, created_at, block_id)`.

No table carries a TTL column, a generation column, or a row-count trigger.

### Every DELETE against them

Enumerated by grepping all three table names in `mc-store/src/lib.rs`:

1. `:7754-7759` — the user-hint replace-delete:
   `DELETE FROM mc_user_hints WHERE session_id = ?1 AND block_id NOT IN (SELECT
   value FROM json_each(?2))`, guarded by
   `if request.user_hints_replace_session` (`:7736`). This is the one reaper, and
   it is caller-driven: the field's doc (`:3263-3268`) explains that the flag
   asserts the host's batch is "the host's COMPLETE hint-decision list for this
   session", so any stored hint absent from it "has no backing decision the host
   can still validate ... and keeping it would replay unvalidated overlay bytes
   forever". The code also fails closed on a serialization error rather than
   deleting everything (`:7745-7752`).
2. `:8642-8654` — the lineage-descent wipe. A loop over seven tables including all
   three overlay tables, deleting `WHERE session_id = ?1` for
   `request.target_key`. This is not a reaper: it clears the *destination* key
   before the copy.
3. `:8736-8751` — the copy that immediately follows, moving every row from the
   source key to the target key for `mc_temporal_marks` (`:8736-8739`),
   `mc_user_hints` (`:8742-8745`), and `mc_channel1_appends` (`:8748-8751`).

So a lineage descent preserves the rows. There is no age predicate, no count cap,
and no byte cap anywhere for `mc_channel1_appends` or `mc_temporal_marks`. A grep
for `DELETE FROM mc_channel1_appends` and `DELETE FROM mc_temporal_marks` in the
whole crate returns nothing.

### What causes growth

One row per Channel-1 firing. The primary key is `(session_id, block_id)` and
`newest_tool_result_for_channel1` excludes blocks already in `existing_blocks`
(`crates/mc-module/src/transform.rs:9801`, set built at `:9161-9165`), so each
firing targets a distinct block and adds exactly one row.

The throttle is the cadence gate in `decide_channel1`
(`transform.rs:9608-9613`):

```
let escalated = last_level.is_none_or(|last| level.rank() > last.rank());
let cadence_reached = last_level.is_some()
    && reclaimable_tokens.saturating_sub(last_nudge) >= channel1_refire_tokens(tail_tokens);
if !escalated && !cadence_reached {
    return quiet(last_nudge, last_level_string(last_level));
}
```

`channel1_refire_tokens` (`:9623-9627`) is
`max(CHANNEL1_REFIRE_FLOOR_TOKENS, round(0.08 * tail_tokens))` where the floor is
25_000 (`:109`). So each additional row costs roughly 25k tokens of newly
unreduced tool output, or 8% of the tail if the tail is above about 313k tokens.

There is no session-lifetime bound on how many times that can happen. A long
agentic session that repeatedly accumulates and reduces tool output crosses the
threshold on every cycle.

Temporal marks grow faster: one row per authored user message that reaches the
loop at `transform.rs:8641-8719`, including a row with an *empty* `marker_text`
when the gap is below the 5-minute threshold (the push at `:8708-8712` is
unconditional once the block is found, and `marker_text` is
`.unwrap_or_default()` at `:8698` and `:8705`). So the temporal table grows
one row per user turn for the life of the session.

### What a stale row does

Nothing, while its block is out of the projection.
`tag_overlay_state` builds `channel1_by_block_id` from every loaded row
(`transform.rs:8161-8165`), but `apply_tag_overlay_to_message` only writes into
`message.content[block.block_index]` for blocks passed in for that mid
(`:8226-8231`), so a row for a comparted block never fires. The row simply sits
there.

The hazard is reappearance. Block ids are
`ck_wire::block_id(&message_id, block_index)`, a deterministic pair. If a message
with the same mid and the same block layout re-enters the request, the old row
matches again and the reminder is re-applied, quoting a token count
(`approx_thousands(reclaimable_tokens)` at `:9861-9863`) captured from a session
state that no longer exists.

## Failure scenario

The slow one first. A long-lived session accumulates rows: one per user turn in
`mc_temporal_marks`, one per Channel-1 firing in `mc_channel1_appends`. A reminder
is roughly 300 bytes of text (`build_channel1_reminder`, `:9841-9860`, three
prose variants plus up to four `§N§ tool` entries from
`format_reclaimable_hint`, `:9866-9877`). The database grows without bound for the
life of the conversation key, and `load_transform_snapshot` reads every row on
every pass (`mc-store/src/lib.rs:5611-5626` for Channel-1, `:5576-5594` for
temporal, `:5595-5610` for hints), so the read cost grows too. The snapshot even
measures itself: `channel1_ms` (`:5627`), `temporal_ms`, `user_hints_ms`, all
surfaced in `TransformSnapshotTimings`.

The sharp one second. A lineage descent copies every row forward
(`:8748-8751`), and a descended session can re-present earlier messages. If a
copied row's `block_id` resolves against a re-presented block, a reminder from
before the descent is appended to it, telling the agent about ~40k reclaimable
tokens in a session whose tail is now 5k.

## Timing windows and dependencies

Not a race. This is accumulation over the life of a conversation key, plus a
reappearance window at a lineage descent.

Dependencies: `tagging_active` for Channel-1
(`transform.rs:3503-3504`), `temporal_active` for temporal marks (`:3525`), and
the length of the session. Nothing caller-supplied is needed.

## What a test must construct

The bound half is a soak-shaped test, and the `always` check needs a documented
bound to compare against, which does not exist yet. So the honest test today is
the negative one:

1. Drive a session through N Channel-1 firings by repeatedly adding large text
   tool results, each time adding enough mass to clear
   `channel1_refire_tokens`. Assert `load_channel1_appends(session).len()` and
   observe that it equals N with no ceiling. The existing
   `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
   (`transform.rs:23551-23590`) already drives one firing and asserts
   `len() == 1` three times (`:23570`, `:23574`, `:23588`); extending it to
   multiple firings is mechanical.
2. For the reappearance half: seed a row via
   `seed_channel1_append_for_test` (`mc-store/src/lib.rs:6664`), then present a
   request whose projection contains that `block_id`, and assert the reminder is
   or is not applied. This pins current behaviour and makes the reappearance
   question testable rather than theoretical.
3. For temporal growth: drive N authored user turns with sub-threshold gaps and
   assert the row count. Every row will have empty `marker_text`, which makes the
   "decision record" versus "overlay" distinction concrete.

The cheapest valid oracle is the row count, which is one query. The expensive
part is generating enough token mass to clear the cadence gate repeatedly, since
the test fixture uses `"word ".repeat(40_000)` per result (`:23556`).

## Investigation log

### Q: Can a `block_id` be reconstructed after its block has left the projection?

- Sources examined: `ck_wire::block_id` call sites
  (`transform.rs:2396` inside `served_output_fingerprints`), the projection build,
  the lineage-descent copy (`mc-store/src/lib.rs:8736-8751`), and
  `valid_drop_seed_block_id` (`:4636`) as the nearest thing to a block-id format
  validator.
- Findings: block ids are `(message_id, block_index)` pairs, so reconstruction
  requires the same mid to reappear with the same block layout. Whether a mid can
  reappear after leaving the projection depends on the projection cache, the
  `tail_delta` expansion path, and lineage handling, none of which are in this
  lens's file footprint.
- Missing evidence: the projection cache's mid-stability contract.
- Conclusion: unresolved, needs 4b.

### Q: Should the reaper key on the overlay frontier, on tag retirement, or on compartment coverage?

- Sources examined: `overlay_watermark` (`mc-store/src/lib.rs:6506-6521`),
  `is_tail` (`transform.rs:6471-6473`), the `mc_tags` retirement logic in
  `newest_active_tag_block_ids` (`:8082-8125`).
- Findings: compartment coverage is the natural key, because
  `is_tail` already uses it and a block below coverage can never be selected for a
  new append. A reaper deleting rows whose block ordinal is at or below
  `meta.coverage_ordinal` would be sound and would bound the table to the live
  tail. But `Channel1AppendRow` carries no ordinal (`:2617-2621`), so the reaper
  would have to resolve ordinals from the projection at commit time, or the row
  type would have to change.
- Missing evidence: none needed for the observation; the choice is a design one.
- Conclusion: needs human input.

### Q: Does `mc_user_hints` having a reaper make it safe?

- Sources examined: `mc-store/src/lib.rs:7736-7760`,
  `ModuleStateSyncRequest::user_hints_replace_session` (`:3263-3268`),
  `crates/mc-module/src/lib.rs:9156-9163` (where the seeds are built from
  `parsed.auto_search_hint_decisions`) and `:9251-9253`.
- Findings: safer, not safe. The reaper only runs when the host sets the flag, and
  the host must supply its complete decision list to do so. A host that never sets
  it, or a Rust-mode session where the module makes the decisions itself
  (`maybe_decide_live_user_hint`, `transform.rs:8766-8823`) rather than receiving
  seeds, gets no reaping at all. The doc at `:3265-3267` frames the flag as a
  correctness mechanism against replaying "unvalidated overlay bytes forever",
  which is a different concern from bounding.
- Missing evidence: whether the shipped Rust-mode host ever sets the flag.
  `crates/mc-module/src/lib.rs:13771` passes
  `final_batch.user_hints_replace_session` through, so the value originates
  further out.
- Conclusion: resolved with answer for this record's scope: the reaper exists but
  is not a bound. The `mc_user_hints` case is therefore closer to the
  `mc_channel1_appends` case than the schema suggests.
