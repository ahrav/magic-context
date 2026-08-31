# render-a-mint-batch-block-ids-are-unique-per-pass

## Discovery trigger

Part 4b's record
[`speculative-tag-numbering-has-two-authorities`](../../part-4b-transform/catalog.md#speculative-tag-numbering-has-two-authorities)
closes with an open question assigned to this sub-part: can
`compute_active_overlay_decisions` emit a `block_id` that already has a tag? That
record's numbering analysis is not re-derived here; this file answers its question
and states the resulting property.

## Evidence trail

All references read back at `HEAD` `e447c927`, in
`crates/mc-module/src/transform.rs` unless noted.

### The mint filter is a snapshot that is never updated

`compute_active_overlay_decisions` builds the filter once (`:8595-8598`):

```
let existing_tag_ids = tag_rows
    .iter()
    .map(|row| row.block_id.as_str())
    .collect::<HashSet<_>>();
```

and hands it to `tag_mint_inputs_from` (`:8606-8615`). The mint loop
(`:7898-7920`) tests `existing_tag_ids.contains(block.id.as_str())` at `:7905` and
pushes to `work.inputs` at `:7914-7919`. It never inserts the pushed id back into
`existing_tag_ids`. So if `projection.blocks` contained the same `block.id` twice,
both occurrences would pass the filter and the batch would carry a duplicate.

### The projection cannot contain a duplicate block id

`apply_once` rejects it before the mint runs:

```
3354:    if let Some(id) = duplicate_ids(&projection.blocks) {
3355:        return Err(TransformError::DuplicateBlockId(id));
3356:    }
```

and the additive path has the same guard at `:2731-2733`. The mint is invoked from
`:3806`, after `:3354`. `duplicate_ids` (`crates/mc-module/src/ck_wire.rs:729-737`)
walks the blocks with a `BTreeSet` and returns the first repeated id, so it is
exact rather than a heuristic.

So the intra-batch duplicate cannot come from the projection. The remaining door
is a `tag_rows` baseline whose block-id set differs from the store's.

### The baseline's validation

`load_cached_tags` (`:7639-7697`) has three paths and both cached ones are fenced
on a store generation, not just on count and maximum:

- exact reuse requires `entry.matches(store_namespace, summary)` (`:7652`), which
  is `store_namespace`, `generation`, `count` **and** `max_tag_number` all equal
  (`:7527-7532`);
- append-only reuse requires `entry.can_append(..)` (`:7655`), which additionally
  requires `summary.generation - self.generation == appended` (`:7540`) — the
  generation must have advanced by exactly the number of new rows — and then
  re-reads the summary and checks `observed == summary`, the tail length, and the
  tail's last tag number (`:7657-7664`) before splicing;
- otherwise a cold `load_tags_for_session` with its own post-read verification
  (`:7682-7695`).

The entry's doc comment states the design (`:7511-7515`): "The store generation is
advanced by SQLite triggers for every tag-table mutation. The count/max pair
recognizes an append-only advance, while any other generation transition requires
a full refill before the cached bytes are used again."

That is the mechanism that closes the blind spot the sibling record identified.
A replacement — delete one row, insert another with the same number — leaves
`count` and `max_tag_number` unchanged but advances `generation` by two, so
`matches` fails on generation and `can_append` fails because `appended == 0`.
Both cached paths fall through to the cold reload.

The claim rests entirely on the trigger covering every mutation, which is
`mc-store` and outside 4e.

### The frontier memo does not widen the door

`tag_mint_frontier_start` (`:7764-7797`) refuses the memo unless
`memo.tagged_key` equals a hash of the current `existing_tag_ids`
(`:7775-7777`). `tag_mint_frontier_store` writes that key from the union of
`existing_tag_ids` and this pass's mints (`:7841-7845`), with the comment at
`:7839-7840` explaining that a rejected commit therefore invalidates the memo.
`tag_mint_id_set_key` sorts before hashing (`:7736-7745`), so the key is
order-independent. A stale memo can only cause the frontier to be ignored, which
costs work, not correctness.

## Failure scenario

If a `mc_tags` mutation exists that does not advance the trigger-backed
generation, a cached baseline can be served whose block-id set differs from the
store's while `(namespace, generation, count, max)` all match. `existing_tag_ids`
then omits a block that is durably tagged, the mint batch includes it, and the
store's skip branch fires. Every later row in that batch gets a number one lower
than the number the render already wrote into the served bytes. The tag-to-block
mapping the reduce surface resolves against is off by one for the rest of the
batch, in bytes already frozen into the provider prefix.

## Timing windows and dependencies

The concurrent-writer window between the baseline read at `:3391` and the commit
is closed by the row-version CAS, as the sibling evidence file establishes; that
analysis is not repeated here.

The window this record covers is logical and intra-pass: it opens only if the
baseline the filter was computed from did not reflect the store. Duration is
irrelevant; correctness of the generation trigger is the only variable.

## What a test must construct

1. Assert the invariant directly: for every pass with `tag_mint_count > 0`,
   `tag_mint_work.inputs` has distinct `block_id`s, and none of them is present in
   `mc_tags` for the session before the commit.
2. Reach the guard: build a request whose projection would carry a duplicate block
   id and assert `TransformError::DuplicateBlockId`. That proves the door this
   record relies on is actually shut.
3. Attack the baseline: seed `mc_tags`, take a baseline snapshot, then perform a
   delete-and-reinsert that preserves count and max, and assert `load_cached_tags`
   returns the store's rows and not the cached ones. If the generation trigger has
   a gap, this fails, and that failure is the sibling record's enabling condition.
4. Coverage form for the sibling record: count commits in which the store's
   `exists` skip branch was taken. It is silent today.

## Investigation log

### Q: Can `compute_active_overlay_decisions` emit a `block_id` that already has a tag?

- Sources examined: `transform.rs:8574-8626` (the mint half of the function),
  `:7875-7938` (`tag_mint_inputs_from`), `:7898-7920` (the loop and its filter),
  `:3354-3356` and `:2731-2733` (the duplicate-id guards), `:3806` (the call
  site), `ck_wire.rs:729-737` (`duplicate_ids`).
- Findings: not from the projection. The guard at `:3354` runs before the mint at
  `:3806` and rejects the pass, so the loop can never see the same `block.id`
  twice. The loop's filter would not have caught it on its own, because
  `existing_tag_ids` is a snapshot taken at `:8595-8598` and never updated as rows
  are appended.
- Missing evidence: none for this half.
- Conclusion: resolved with answer — the projection route is closed by
  `TransformError::DuplicateBlockId`. This answers the sibling record's open
  question in the negative for that route.

### Q: Can the baseline cache serve a set-divergent baseline?

- Sources examined: `transform.rs:7511-7541` (the entry and its two predicates),
  `:7639-7697` (`load_cached_tags`), `:7602-7607` (the metrics accessor, which
  shows the cache is process-global).
- Findings: both cached paths require generation equality or an exact
  generation-equals-appended advance, so a same-count same-max replacement forces
  a cold reload. The sibling record's stated concern — "validated on count and
  maximum, not on the full block-id set" — is true of the count/max pair alone but
  not of the predicate as a whole, because generation is also compared.
- Missing evidence: whether the SQLite triggers advance the generation on delete
  and on update, not only on insert. That is `mc-store`.
- Conclusion: unresolved, needs an `mc-store` read. Confidence is medium for that
  reason.

### Q: Does the frontier memo let a mint skip a block that is durably untagged?

- Sources examined: `transform.rs:7712-7727` (the memo), `:7764-7797`
  (`tag_mint_frontier_start`), `:7817-7853` (`tag_mint_frontier_store`),
  `:7736-7745` (`tag_mint_id_set_key`).
- Findings: the memo is refused unless the frozen-target key and the tagged-id key
  both match, and the per-block content keys match for every index below the
  frontier that is not covered by a trusted projection prefix (`:7785-7795`). A
  mismatch returns `None`, which means a full scan.
- Missing evidence: none.
- Conclusion: resolved with answer — the memo is fail-safe in this direction. Its
  only failure mode is doing more work than necessary.
