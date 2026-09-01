# speculative-tag-numbering-has-two-authorities

## Discovery trigger

The commit slices `tag_rows` by an index range computed hundreds of lines
earlier. Checking that the slice cannot panic led to reading how tag numbers are
assigned, which turned up two independent assignment sites with different
algorithms.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

### Authority 1: in memory, during the pass

- `transform.rs:3391` — `let mut tag_rows = load_cached_tags(store, &req.session_id)?;`
- `transform.rs:3806-3819` — `pending_overlays =
  compute_active_overlay_decisions(OverlayComputation { .. tag_rows: &mut
  tag_rows, .. })?;`
- `transform.rs:8624` — `let tag_mint_count = tag_mint_work.inputs.len();`
- `transform.rs:8625-8626` — `let tag_mint_start =
  append_tag_mint_rows(Arc::make_mut(tag_rows), tag_mint_work.inputs, ctx.now_ms);`

`append_tag_mint_rows` (`transform.rs:8024-8044`):

```
let start = tag_rows.len();
let next_tag = tag_rows.iter().map(|row| row.tag_number).max().unwrap_or(0);
tag_rows.extend(
    tag_mints
        .into_iter()
        .enumerate()
        .map(|(offset, input)| McTagRow {
            tag_number: next_tag + offset as i64 + 1,
            ..
        }),
);
start
```

So the batch is numbered `next_tag + 1 ..= next_tag + n` where `next_tag` is the
maximum over the rows this pass loaded. These numbers are then rendered:
`tag_numbers = tag_number_by_message(&tag_rows)` at `:3830`, and `tag_numbers` is
handed to `build_output_with_tags` at `:5383`.

The slice at commit time is safe: `start` is captured before the extend and the
extend adds exactly `tag_mint_count` rows, so
`tag_rows[start .. start + count]` (`transform.rs:5591-5592`) is exactly the
appended span.

### Authority 2: in the commit transaction

`mc-store/src/lib.rs:7483-7515`, inside the same fenced transaction as the CAS:

```
for input in overlays.tag_mints {
    let block_id = input.block_id.trim();
    if block_id.is_empty() { continue; }
    let exists = tx
        .prepare_cached("SELECT 1 FROM mc_tags WHERE session_id = ?1 AND block_id = ?2")?
        .query_row(params![session_id, block_id], |_| Ok(()))
        .optional()?
        .is_some();
    if exists { continue; }
    let next_tag = tx
        .prepare_cached(
            "SELECT COALESCE(MAX(tag_number), 0) + 1 FROM mc_tags WHERE session_id = ?1",
        )?
        .query_row(params![session_id], |row| row.get::<_, i64>(0))?;
    tx.prepare_cached("INSERT INTO mc_tags ...")?
      .execute(params![session_id, next_tag, block_id, ..])?;
}
```

Two differences from authority 1. The store re-reads `MAX(tag_number)` for every
row, and it **skips** any input whose `block_id` already exists. A skip means the
in-memory row at offset `k` got number `next_tag + k + 1` while every durable row
after the skipped one gets a number one lower than the in-memory value.

### Why the row-version CAS mostly covers the concurrency case

`mc_tags` writers in a default build:

- `commit_transform` itself (`mc-store/src/lib.rs:7502`)
- `descend_lineage` (`:8727-8734`), which also writes `mc_cache_state` and bumps
  `row_version` (`:8312`, `:8403`, `:8480`)
- `mint_or_get_tags` (`:6258`), which carries
  `#[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]` at
  `:6257` with the comment at `:6255-6256`: "Production callers live module-side
  behind the test-support seeds; without that feature only in-crate tests reach
  these write paths"

So in a default build, any concurrent tag insert also moves `row_version` and the
CAS at `:7360-7367` rejects the pass. The reachable divergence trigger is
therefore not concurrency but a duplicate `block_id` inside one batch, or a batch
computed from a tag baseline that does not match the store.

### The baseline the batch is filtered against

`load_cached_tags` (`transform.rs:7639-7697`) serves from a process-wide cache
and validates it against `store.tag_cache_summary` before returning: the exact
match at `:7652-7654`, the append-only path at `:7655-7679` which re-reads the
summary and checks `observed == summary` plus tail length plus last tag number,
and the full reload at `:7682-7695` which checks count and max tag number. The
mint filter uses `existing_tag_ids` derived from those rows
(`transform.rs:7810`, `:7841`).

So the filter is only as good as the baseline validation, and the baseline is
validated on count and maximum, not on the full block-id set. Two tag rows with
the same count and max but different block ids would validate.

## Failure scenario

A mint batch contains a `block_id` that already has a tag row, either because
`existing_tag_ids` was computed from a baseline whose block-id set differs from
the store's despite matching count and max, or because the batch itself contains
a duplicate. The pass renders `§7§` for a block. The store skips the earlier
duplicate and assigns `7` to the *next* block in the batch. Now the served bytes
say block A is tag 7 while `mc_tags` says block B is tag 7.

That mapping is load-bearing: `tag_number_by_message` (`:3830`) drives overlay
prefixes, `frozen_red_targets` and the reduction surface key on block ids that
tags name, and the Channel-2 token aggregate sums `mc_tags.token_count` per tag.
The wrong bytes are already frozen into the provider prefix by the time the
mismatch could be noticed, because the commit and the render are the same pass.

## Timing windows and dependencies

The concurrency window (`:3391` to `:5565`) is closed by the row-version CAS in a
default build, because every other production `mc_tags` writer also bumps
`row_version`.

The remaining window is intra-pass and logical, not temporal: it depends on
whether `compute_active_overlay_decisions` can emit a `block_id` that already has
a durable tag. That function is `transform.rs:8574-8761`, which is sub-part 4e's
scope, so this lens states the dependency instead of resolving it.

## What a test must construct

1. Seed `mc_tags` with a row for block `m5#0`, tag number 3.
2. Construct a tag mint batch containing `m5#0` plus a genuinely new block
   `m6#0`, in that order. Reaching this through the public path needs
   `compute_active_overlay_decisions` to emit the duplicate, which may be
   impossible; the direct route is a unit test on the pair
   (`append_tag_mint_rows`, `commit_transform`) with a hand-built
   `TransformOverlayBatch`.
3. Commit and read back `mc_tags`.
4. Assert `m6#0`'s durable `tag_number` equals the number
   `append_tag_mint_rows` assigned it in memory. In-memory it is `3 + 1 + 1 = 5`;
   durably it is `MAX(3) + 1 = 4` because `m5#0` was skipped. The assertion
   fails, which is the finding.
5. For the coverage form, assert the independent preconditions instead: a
   non-empty mint batch committed, and at least one commit observed in which the
   store's `exists` branch at `mc-store/src/lib.rs:7493-7495` was taken. A
   counter or a log line at that branch would make it observable; today it is
   silent.

## Investigation log

### Q: Can `compute_active_overlay_decisions` emit a `block_id` that already has a tag?

- Sources examined: `transform.rs:8574-8761` skimmed, `:8611` (the
  `existing_tag_ids` argument), `:7757-7759` (`existing_tag_ids.contains`),
  `:7802-7815` (`tag_mint_count_candidates_before`), `:7823-7853`
  (`tag_mint_frontier_start` and its memo key check at `:7775`), `:7841`
  (`let mut tagged = existing_tag_ids.clone();`).
- Findings: the filter exists and is applied in at least two places
  (`:7810`, `:7841`). Whether it covers every emission path, and whether the
  frontier memo at `:7951-8010` can serve a stale `tagged` set, was not
  established. The memo has its own validity key (`:7775`, `tagged_key`), which
  suggests the authors considered exactly this.
- Missing evidence: a line-by-line read of `:8574-8761` and `:7700-8046`, which
  is sub-part 4e's assigned scope.
- Conclusion: unresolved, needs 4e. The record stands on the two-authority
  structure, which is verified, not on a demonstrated duplicate.

### Q: Can the slice at `:5591-5592` panic?

- Sources examined: `transform.rs:8024-8044`, `:8624-8626`, `:5591-5592`,
  `:3806-3819`, `:3830`; every mutation of `tag_rows` in `apply_once`.
- Findings: no. `start` is `tag_rows.len()` before the extend and the extend adds
  exactly `tag_mints.len()` rows, which is `tag_mint_count`. Between the append
  and the commit, `tag_rows` is only read: `tag_number_by_message(&tag_rows)` at
  `:3830` and the slice itself. Nothing truncates it.
- Missing evidence: none.
- Conclusion: resolved with answer — the slice is in bounds. Recorded because
  it was the trigger for reading the numbering, and because an index range
  carried 1,700 lines is worth documenting as safe rather than leaving a reader
  to re-derive it.
