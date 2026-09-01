# raw-chunk-message-retention-has-no-eviction-budget

## Discovery trigger

Reading `insert_chunk_transcripts_tx` to confirm that the original conversation
survives a publish surfaced its sibling, `evict_chunk_transcripts_tx`. The
eviction has a budget, and the budget only counts one of the two payloads. That
is the deliberate mechanism by which recoverability is preserved, and it is also
an unbounded per-session growth term that nothing in the crate measures.

## Evidence trail

In `crates/mc-store/src/lib.rs`:

- `:405` `const MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES: usize = 256 * 1024;` is a
  per-row cap and applies only to the condensed transcript, at `:12685`.
- `:410` `const MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES: i64 = 8 * 1024 * 1024;`
  is the session budget.
- `:12715` every transcript insert calls `evict_chunk_transcripts_tx`.
- `:12722` precomputes the compressed empty string used as the blanking value.
- `:12723-12732` the loop: compute
  `SUM(LENGTH(transcript_deflate))` for the session and return when it is within
  budget. The sum does not include `raw_messages_deflate`.
- `:12733-12744` selects the victim: oldest by `created_at_ms` then
  `compartment_seq`, restricted to rows where `raw_messages_deflate IS NULL OR
  transcript_deflate <> <empty>`.
- `:12745-12747` returns when no victim qualifies, even if the total still
  exceeds the budget.
- `:12748-12756` a victim that holds raw messages has `transcript_deflate` set to
  the empty value and keeps its raw payload. The comment states the rule.
- `:12757-12761` only a victim with no raw payload is deleted outright.
- `:12687-12690` shows the asymmetry at the write side: the raw payload has no
  size filter, so a single publish can insert an arbitrarily large
  `raw_messages_deflate`.

Termination is structural. Each iteration either blanks a row, which removes it
from the victim predicate at `:12738` because `transcript_deflate <> <empty>`
becomes false and `raw_messages_deflate IS NULL` is false, or deletes it. Both
strictly reduce the candidate set, so the loop runs at most once per row.

The only paths that reclaim a raw payload are whole-session teardown (`:8894`,
`:8960`) and the suffix revert (`:9106`), which reclaims only the reverted
suffix.

## Failure scenario

There is no correctness failure. The consequence is capacity. A long-lived
session that folds repeatedly accumulates one `raw_messages_deflate` per
compartment forever. Because the eviction budget cannot see those bytes, the
session's transcript table grows without bound, and the growth is invisible to
the 8 MiB budget that operators might reasonably believe caps it.

The second-order effect is that `evict_chunk_transcripts_tx` can reach a steady
state where every row's transcript is blanked, the sum is still over budget, and
the loop returns at `:12745-12747` having reclaimed nothing. That is correct
behaviour under the stated contract, but it means the budget silently stops being
enforced rather than failing loudly.

## Timing windows and dependencies

No fault or interleaving is needed. This is monotone accumulation over the life
of one session. The dependencies are:

- Every publish inserts one transcript row per appended compartment
  (`:12698-12713`), so growth is proportional to compartments, not to publishes.
- The raw payload size is proportional to the chunk's original message bytes,
  which is bounded per firing by the chunk token budget
  (`historian_chunk.rs:670`, `lib.rs:5095`) but unbounded across firings.

## What a test must construct

Two assertions, both cheap once a store fixture can publish repeatedly:

1. Retention: publish enough on one session that
   `SUM(LENGTH(transcript_deflate))` exceeds `MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES`,
   then assert every compartment sequence that ever had a non-null
   `raw_messages_deflate` still has one. This is the `always` half.
2. Coverage: assert the eviction loop actually ran, by observing at least one row
   whose `transcript_deflate` equals the compressed empty value while its
   `raw_messages_deflate` is non-null. This is the `sometimes` half, and it is a
   precondition marker, not the violation: it fires on a correct implementation
   and only proves the campaign reached the operational state where the budget
   binds.

A third, more expensive assertion worth queuing: record
`SUM(LENGTH(raw_messages_deflate))` across the run and report it, so a future
budget can be sized against a real number rather than a guess.

## Investigation log

### Q: Is unbounded raw retention the intended contract, or is a separate raw budget missing?

- Sources examined: `crates/mc-store/src/lib.rs:405-410`, `:12671-12763`;
  the schema at `:536-547`; the two whole-session deletes at `:8894` and `:8960`;
  the suffix revert at `:9096-9111`; `crates/mc-module/src/historian.rs:425-426`.
- Findings: the comment at `mc-store:12749-12750` reads as a deliberate decision:
  "Full message recovery is durable by contract. Retain its raw payload and
  reclaim only the optional condensed transcript when the legacy transcript
  budget fills." The word "legacy" suggests the transcript budget predates the raw
  payload and was never re-scoped. That is consistent with the schema comment at
  `:12694-12696`, which describes `transcript_deflate NOT NULL` as belonging to
  "the original schema".
- Missing evidence: no design note, plan, or spec covers chunk-transcript
  retention. The scope map established there is no historian specification outside
  `historian*.rs` (`scope-map-and-risk-ranking.md:695-700`), and I confirmed
  nothing under `docs/specs/` mentions transcripts.
- Conclusion: needs human input. The retention is almost certainly intended; what
  is missing is whether the absence of any bound on it is intended, and whether
  operators are aware the 8 MiB constant does not cap the table. Cataloguing it
  makes the trade explicit either way.
