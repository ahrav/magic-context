# nudge-b-overlay-suppression-and-firing-are-unreportable

## Discovery trigger

Task 6, verbatim: "whether a suppressed, dropped, or conflicting overlay is
reportable. The sibling lens found a message that drops silently with no field
recording it; check whether the overlay path has the same shape." It does, on four
separate paths, and the absence is what makes every other record in this lens hard
to catch in production.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### What the response can carry

`TransformTimings` (`crates/mc-module/src/transform.rs:1144-1310`) is the only
per-pass diagnostic channel. It carries these `usize` count fields, found by
reading the whole struct:

| Field | Line | What it counts |
| --- | --- | --- |
| `projection_reused_messages` | `:1175` | projection cache |
| `projection_projected_messages` | `:1177` | projection cache |
| `tag_mint_candidates` | `:1221` | tag mint |
| `tag_mint_new` | `:1223` | tag mint |
| `tag_mint_tokenized_bytes` | `:1225` | tag mint |
| `emergency_reasoning_exclusions` | `:1235` | emergency reclaim |
| `trigger_token_cache_hits` | `:1273` | trigger |
| `trigger_tokenized_blocks` | `:1275` | trigger |
| `native_cache_*` (five) | `:1279-1288` | native cache |
| `frozen_units` | `:1296` | state |
| `tail_units_matched` | `:1298` | state |
| `projection_blocks` | `:1300` | projection |
| `tail_messages_emitted` | `:1302` | output |
| `build_identity_messages` | `:1304` | output |
| `cache_hits` / `cache_misses` / `cache_dirty_skips` | `:1306-1310` | output cache |

Tags are counted three ways. Channel-1, Channel-2, temporal marks, and user hints
are counted zero ways. Their only representation is elapsed milliseconds:
`store_temporal` (`:1183`), `store_user_hints` (`:1185`), `store_channel1`
(`:1187`), `user_hint` (`:1205`), `tag_overlay` (`:1213`), `temporal` (`:1217`).

`format_pass_timing_line` (`:1317-1400`) emits those same timings into the
greppable per-pass log line and adds no counts.

### The four unreportable decisions

**1. Channel-1 suppressed or quiet.** `maybe_append_channel1_nudge`
(`:9142-9177`):

```
9156:    let was_suppressed = meta.channel1_reduce_suppressed;
9157:    meta.channel1_reduce_suppressed = false;
9158:    if was_suppressed || !decision.fire {
9159:        return None;
9160:    }
```

Both reasons collapse into one `None`. Downstream, `:5334-5353` treats `None` as
"nothing to do". No caller can tell a suppression from a quiet decision, and
neither is recorded.

**2. Channel-1 fired but found no target.** Still inside
`maybe_append_channel1_nudge`, after the fire check:

```
9166:    let block_id = newest_tool_result_for_channel1(
...
9172:    )?;
```

The `?` on an `Option` returns `None`. So a decision that fired at `Urgent`, having
already written the memo fields at `:9154-9155`, silently produces nothing when
every tail tool result is JSON-shaped, frozen, or already carries a row. The memo
now records a nudge that never happened, which means the cadence gate
(`:9608-9611`) will suppress the *next* one too. That is a compounding silent
failure and there is no field for it.

**3. User hint parked.** `:4452-4459` inserts the block id into
`meta.pending_user_hint_block_ids` and renders nothing. The set is durable
(`mc-store/src/lib.rs:2453-2457`) and is cleared only on a bust
(`transform.rs:4469-4470`). A session that never busts holds hints indefinitely
with no count of how many.

**4. Channel-2 armed or retired.** `claude_code_channel2_directive` mutates three
`meta` fields (`:9495-9497`) and clears them at `:9447` and via
`rearm_channel2_cycle` (`:9407-9410`). The response carries the directive itself
(`:5693`) but no arm or retire event, so a caller cannot distinguish "this is the
same directive replayed" from "this is a new arming" without diffing
`directive_id` across passes itself.

### What exists adjacent, and why it is not enough

`divergence::first_divergence` (`:5514`) compares
`loaded.meta.served_output_fingerprint` against the new fingerprints and stores the
first difference as `first_divergence_json` (`:5516-5518`), passed to the commit at
`:5575`. That would detect the *byte consequence* of a retroactive Channel-1 append
(record `nudge-b-channel1-append-first-applies-without-a-frontier-gate`), but it
reports "the bytes for block X changed", not "an overlay first-applied to a served
block". Attribution requires knowing which overlay moved, which is exactly what is
not recorded.

`eprintln!` sites exist for other paths: identity re-adoption (`:5615-5619`),
boundary divergence recut (`:5621-5628`). None covers an overlay decision.

## Failure scenario

Not a single event: a class of undetectability.

Take the Channel-1 no-target case, which is the sharpest. Reclaimable mass reaches
the `Urgent` band. `decide_channel1` fires and writes
`channel1_last_nudge_undropped = reclaimable_tokens` and
`channel1_last_nudge_level = "urgent"` (`:9154-9155`, values from `:9617-9620`).
`newest_tool_result_for_channel1` returns `None` because the last three tool
results all returned JSON. Nothing is appended and nothing is logged.

On the next pass the memo says a nudge already fired at `Urgent`, so `escalated` is
false (`:9608`, since `level.rank()` cannot exceed `Urgent`'s) and
`cadence_reached` needs another
`max(25_000, 0.08 * tail_tokens)` of growth (`:9609-9611`). The agent is now
silently un-nudged at the highest pressure band, and the only way an operator
could learn this is by reading `meta.channel1_last_nudge_level` out of the store and
comparing it against `load_channel1_appends`. Nothing surfaces it.

## Timing windows and dependencies

None. This is an observability property of a single pass.

Dependencies: `tagging_active` for the Channel-1 paths, `auto_search_active` for
the hint path, and the serializer profile for Channel-2.

## What a test must construct

The check is `always` and asserts the existence of fields, so the test is a schema
test plus a behavioural one.

1. **Schema half.** Assert that a pass which fired Channel-1 and a pass which
   suppressed it produce different `TransformTimings`. Today they do not, and the
   assertion is one line.
2. **Behavioural half, per path.** For the no-target case: build a request whose
   hygiene baseline is in the `Urgent` band but whose every tail tool result has
   `CkOutputKind::Json` output, so `tool_result_can_carry_channel1`
   (`:9809-9823`) rejects all of them. Assert the response reports that a nudge
   fired without a target. Today it reports nothing, and
   `meta.channel1_last_nudge_level` will read `"urgent"` while
   `load_channel1_appends` returns an empty vec, which is the observable
   inconsistency a test can pin even before a field exists.
3. For the parked-hint case: drive a hint decision for a previously served block on
   a non-bust pass and assert the count of parked ids is reportable. Today the only
   evidence is `meta.pending_user_hint_block_ids.len()`, which requires a store
   read.
4. For Channel-2: call `channel2_directives` twice on the CC arm and assert the
   response distinguishes a fresh arming from a replay. Today the caller must diff
   `directive_id` itself.

The cheapest valid oracle for all four is the store-versus-response inconsistency:
`meta` records that something happened and the response does not mention it. That
oracle works today, without adding fields, which makes this record implementable
now rather than after a design change.

## Investigation log

### Q: Is `tag_mint_new` the intended precedent, or is there a reason tags are counted and reminders are not?

- Sources examined: `:1221-1225` (the three tag-mint fields),
  `PendingOverlayDecisions` (`:1747-1758`, which carries
  `tag_mint_candidates`, `tag_mint_count`, and `tag_mint_tokenized_bytes` as
  first-class fields alongside `temporal_marks`, `user_hint`, and
  `channel1_append`), and the assignment sites at `:3813-3821`.
- Findings: the struct that computes the decisions carries counts for the tag path
  and raw payloads for the other three. The tag counts exist because tag minting
  tokenizes, which is expensive and worth measuring; `tag_mint_tokenized_bytes` is a
  cost metric, not an outcome metric. So the precedent is "count the expensive
  thing", not "count the decision". That explains the shape without justifying it:
  the other three overlays are cheap to compute and expensive to get wrong.
- Missing evidence: no design comment on the timings struct.
- Conclusion: needs human input on whether outcome counters are wanted. The
  mechanical finding stands regardless.

### Q: Does the divergence record close the gap?

- Sources examined: `:5512-5520`, `:5575`, `:1261-1262` (the `divergence` timing
  field).
- Findings: it detects byte changes against the previous served fingerprint, which
  covers the *consequence* of two of this lens's records but attributes neither. It
  also cannot see the three silent-nothing cases (suppressed, no target, parked),
  because those produce no byte change at all.
- Missing evidence: what `divergence.rs` does with the record and whether anything
  reads it.
- Conclusion: unresolved, needs 4b or 4c. Either way it does not close this gap for
  the silent-nothing cases.

### Q: Is there an existing store-side signal an operator could use today?

- Sources examined: `TransformSnapshotTimings`
  (`mc-store/src/lib.rs:5645-5655` region), `load_channel1_appends`
  (`:6480-6503`), `ModuleMeta`'s `channel1_last_nudge_undropped` and
  `channel1_last_nudge_level`.
- Findings: yes, and it is the basis of the test recommendation above. The pair
  (`channel1_last_nudge_level`, row count) is inconsistent exactly when a firing
  decision found no target. That is an inferable signal, not a reported one, and it
  requires direct store access.
- Missing evidence: none.
- Conclusion: resolved with answer. There is a usable oracle today; there is no
  report.
