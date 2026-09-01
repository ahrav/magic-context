# nudge-b-channel1-append-first-applies-without-a-frontier-gate

## Discovery trigger

Reading the three overlay inserts inside one commit transaction side by side.
Temporal marks and the user hint are each wrapped in a `previous_frontier`
comparison; the Channel-1 append, ten lines below them, is not. The frontier's own
doc comment names the protection it provides, which makes the omission a
contract-versus-code question rather than a style observation.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The frontier and its stated purpose

`crates/mc-store/src/lib.rs:6506-6507`, on `overlay_watermark`:

```
/// Read the ordinal frontier used to avoid first-applying overlays to closed turns.
/// A missing row is distinct from ordinal zero, which is a valid first message.
```

Reinforced module-side at `crates/mc-module/src/transform.rs:8722-8724`: "Do not
advance the frontier past a user whose temporal decision could not be evaluated. A
frozen reduction or another mint-ineligible shape must remain eligible for a later
pass instead of silently making its marker impossible to mint."

### The asymmetry, inside one transaction

`mc-store/src/lib.rs`, `commit_transform`'s overlay block. The frontier is read
once at `:7518-7525`, then:

- `:7526-7541` — temporal marks:
  `if previous_frontier.is_none_or(|frontier| *ordinal > frontier) { INSERT OR
  IGNORE INTO mc_temporal_marks ... }`
- `:7541-7546` — the user hint: `let eligible = hint_ordinal.is_some_and(|ordinal|
  previous_frontier.is_none_or(|frontier| ordinal > frontier)); if eligible {
  INSERT OR IGNORE INTO mc_user_hints ... }`
- `:7559-7573` — the Channel-1 append:
  `if let Some(append) = overlays.channel1_append { INSERT OR IGNORE INTO
  mc_channel1_appends ... }`. No frontier comparison, and
  `Channel1AppendRow` (`:2617-2621`) carries no ordinal field to compare against
  even if one were wanted.

### The second guard the hint has and Channel-1 does not

`transform.rs:4452-4460`:

```
if !hint.hint_text.is_empty()
    && user_hint_target_was_served(&loaded.meta, &hint.block_id)
    && !is_bust_pass
{
    // A decision for a previously served block is immutable, but its first append
    // must ride a later independent bust rather than rewriting the cached prefix.
    meta.pending_user_hint_block_ids
        .insert(hint.block_id.clone());
}
```

`user_hint_target_was_served` (`:8565-8572`) checks
`meta.served_output_fingerprint`. Nothing on the Channel-1 path consults that
field. The comment at `:4456-4457` states the exact invariant this record asserts:
a first append must not rewrite the cached prefix.

### The target selector admits a served block

`newest_tool_result_for_channel1` (`transform.rs:9785-9807`) filters on:

- `:9796` — `block.kind_tag == "tool_result"`
- `:9797` — `taggable_kind(block).is_some()`
- `:9799` — `is_tail(block.ordinal, meta.coverage_ordinal)`
- `:9800` — `!frozen_targets.contains(block.id())`
- `:9801` — `!existing_blocks.contains(block.id.as_str())`
- `:9802` — `mutation_exempt_mid != Some(block.mid.as_str())`
- `:9803` — `tool_result_can_carry_channel1(&block.wire)`

then `:9805` — `.max_by_key(|block| (block.ordinal, block.block_index))`.

`is_tail` is `coverage.is_none_or(|c| ordinal > c)` (`:6471-6473`). Coverage is the
compaction watermark, not a served watermark, so every uncomparted tail block
qualifies, including ones served on ten previous passes.

The three exclusions above are what make the fallback reachable.
`tool_result_can_carry_channel1` (`:9809-9823`) returns `false` for
`CkOutputKind::Json`, `ErrorJson`, and `ExecutionDenied` (`:9819-9822`), so a
newest tool result that returns JSON is skipped and `max_by_key` falls back to an
older, text-bearing one.

### The firing pass need not be a bust

`maybe_append_channel1_nudge` is called at `transform.rs:5335` under
`if tagging_active {` (`:5334`) with no `is_bust_pass` condition.

The baseline it decides from stays usable on a defer pass.
`refresh_tail_hygiene_baseline` (`crates/mc-module/src/tail_hygiene.rs:636-690`)
takes the non-busting path at `:657-682`: when `same_measured_prefix` succeeds
(`:665`) it returns a baseline with `evaluable: true, generation_invalidated:
false` (`:684-685`) and the previous baseline's `baseline_u`/`baseline_t` carried
forward via `..previous.clone()` (`:689`). So `decide_channel1`'s first gate
(`transform.rs:9590-9592`) passes on a defer pass, and the remaining gates are
pure arithmetic over token counts.

## Failure scenario

Sequence, all on one session with `serializer_profile: "opencode-aisdk"`,
`tool_present: true`, and tagging established:

1. Pass N, a bust. Tail contains tool results A (text, 30k tokens) and B (text,
   30k). `decide_channel1` fires, the append lands on B, both are served, and
   `meta.served_output_fingerprint` now covers A and B.
2. Between passes, the agent runs a tool whose result C is JSON.
3. Pass N+1, a defer pass. The tail is A, B, C. `newest_tool_result_for_channel1`
   skips C (`tool_result_can_carry_channel1` rejects `Json`) and skips B
   (`existing_blocks`), so it selects **A**. Reclaimable tokens have grown by C's
   mass, so if that growth clears
   `max(25_000, 0.08 * tail_tokens)` (`channel1_refire_tokens`, `:9623-9627`) the
   cadence gate opens (`:9608-9611`) and the decision fires.
4. The append row for A commits with no frontier check, and the render appends
   `\n\n<system-reminder>...` to A's tool output.
5. A is a block the provider has already cached. The prefix diverges at A's
   position, so every cached token after A is discarded.

The module notices the symptom but not the cause. `divergence::first_divergence`
(`transform.rs:5514`) compares
`loaded.meta.served_output_fingerprint` against the new fingerprints and records
the first difference in `first_divergence_json` (`:5516-5518`), which is passed to
the commit at `:5575`. That is a byte-level report, not an attribution.

## Timing windows and dependencies

Not a race. The window is a pass sequence: any pass after the one that first
served the target block. There is no upper bound on how far back the target can
be, because `is_tail` only excludes comparted blocks.

Dependencies: `tagging_active` (`:3503-3504`), which needs
`tagging_surface_active(profile, tool_present)` (`lib.rs:568-577`) plus either
`persisted_tagging_surface_active` or `bootstrap_tagging_active`; the hygiene
baseline; and the composition of the tail's tool results.

## What a test must construct

The whole scenario is constructible from the existing helpers in
`transform.rs`'s test module.

1. Build a request with two large text tool results and drive a firing pass. The
   existing `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
   (`:23551-23590`) already does this much, including the `"word ".repeat(40_000)`
   payload at `:23556` and `protected_tags = 0` at `:23565`.
2. Capture the served bytes and confirm `meta.served_output_fingerprint` covers
   both results.
3. Append a JSON-output tool result to the tail. The test module's
   `tool_result` helper produces text output, so this needs a variant emitting
   `CkOutputKind::Json`, which is the one piece of new fixture work.
4. Drive a pass with a plan outside `{Hard, MigrateHard, Soft}` and enough new
   token mass to clear the cadence step.
5. Assert the new append row's `block_id` is absent from the pre-pass
   `served_output_fingerprint`. That assertion fails today.

Steps 3 and 4 are the whole cost. The oracle is cheap: the pre-pass fingerprint
set is already in `loaded.meta`.

A coverage companion should assert the independent preconditions rather than the
violation: a pass in which `decide_channel1` fired, and a pass in which
`newest_tool_result_for_channel1` selected a block whose ordinal is below the
maximum tail ordinal. Both are observable without knowing whether the defect
exists.

## Investigation log

### Q: Is the missing gate deliberate on the grounds that Channel-1 only targets fresh tool results?

- Sources examined: `transform.rs:9785-9807` (the selector), `:9809-9823`
  (the eligibility predicate), `:6471-6473` (`is_tail`), `:5334-5353`
  (the call site), and every comment in `maybe_append_channel1_nudge`
  (`:9142-9177`, which has none).
- Findings: nothing in the selector encodes a freshness assumption. It picks the
  newest *eligible* block, and three independent conditions can make the newest
  blocks ineligible: JSON-shaped output, being a frozen `red:` target, and already
  carrying a row. `existing_blocks` in particular guarantees that on every refire
  the selector must reach further back, because the closest candidates are exactly
  the ones already used.
- Missing evidence: no design comment on the function or on the store insert.
- Conclusion: needs human input. The code does not support the freshness reading,
  and `existing_blocks` actively works against it.

### Q: Does the served-output divergence record fire for this case, and is it surfaced?

- Sources examined: `transform.rs:5512-5520`, the commit field
  `first_divergence` at `:5575`, and `TransformTimings`'s `divergence` field
  (`:1261-1262`).
- Findings: the fingerprint comparison would detect the byte change, since the
  target block's content hash changes. What the record does with it, and whether
  anything reads it, is inside `divergence.rs` and the commit path.
- Missing evidence: `divergence.rs`.
- Conclusion: unresolved, needs 4b or 4c.

### Q: Could the frontier be applied to Channel-1 as-is?

- Sources examined: `Channel1AppendRow` (`mc-store/src/lib.rs:2617-2621`),
  `TemporalMarkInput` (`:2635-2640`, which carries `pub ordinal: u64`),
  `UserHintDecisionInput` (`:2648-2653`, same).
- Findings: no. The two gated overlays carry an ordinal in their input type
  specifically so the commit can compare it. `Channel1AppendRow` carries
  `block_id`, `reminder_text`, and `fired_at_ms` only. Gating it would require
  either adding an ordinal to the row type or resolving the block's ordinal at
  commit time.
- Missing evidence: none.
- Conclusion: resolved with answer. The type shape is consistent with the gate
  never having been intended for this overlay, which strengthens the case that it
  is an omission rather than a deliberate exemption, but does not prove it.

### Q: Does the render-time overlay build reintroduce a guard?

- Sources examined: `tag_overlay_state` (`transform.rs:8140-8170`).
- Findings: the opposite. `channel1_by_block_id` (`:8161-8165`) applies no filter
  at all, while `temporal_by_block_id` (`:8152-8156`) filters empty marker text and
  `user_hint_by_block_id` (`:8157-8161`) filters both empty text and the parked
  `pending_user_hint_block_ids` set. Channel-1 is the least guarded of the three
  at both the commit and the render.
- Missing evidence: none.
- Conclusion: resolved with answer. No compensating guard exists.
