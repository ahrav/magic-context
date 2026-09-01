# publish-fence-rejects-selected-content-drift

## Discovery trigger

The task asked what token or version guards the publish. The module header calls
it "a pinned ordinal-range chunk snapshot with fail-loud fingerprint
verification" (`historian.rs:1-6`), which suggests the fingerprint is the guard.
Reading the fingerprint's own doc showed it deliberately cannot detect a
same-length content edit, so something else must be doing the work. It is the
block-identity vector, and it is checked in a different crate from the one whose
header advertises the fingerprint.

## Evidence trail

### The fingerprint is structural only

`crates/mc-module/src/historian.rs`:

- `:140-143` the doc: "The fingerprint intentionally records byte lengths rather
  than content bytes: insertion/removal and type/id changes alter the
  fingerprint, while unrelated metadata drift and same-length content edits do
  not stale a snapshot."
- `:151-160` `compute_chunk_fingerprint` joins `id:kind:byte-length` pieces with
  `|`, no hashing, "so mismatches are readable in diagnostics".
- `:363-372` `verify_chunk_fingerprint` is an equality check.
- `:1260-1263` it runs before each fire attempt.
- `:448-460` it runs again at the top of `publish_validated_chunk`, abandoning the
  matching firing before returning the mismatch.

So the fingerprint catches insertion, removal, and id or kind change, and nothing
else.

### The content guard

`crates/mc-module/src/historian_chunk.rs:698-715` pins one
`HistorianSelectedMessageIdentity` per non-synthetic message in the chunk range,
each carrying that message's `block_identities` from
`projection.identity_by_mid`. A message with no known identity aborts the fire
(`:704-710`), so the vector is either complete over the range or absent entirely.

`crates/mc-store/src/lib.rs`, inside the publish transaction:

- `:9402` the predicate comparison includes
  `meta.historian.selected_range_identities == predicate.selected_range_identities`,
  which proves the durable row still describes this firing.
- `:9409-9412` the comment that separates the two roles: "`chunk_fingerprint`
  remains a readable structural diagnostic; exact content freshness is verified
  using the durable block identities. An empty vector means the firing predates
  selected-range identity persistence, so it cannot establish that the selected
  content is still current."
- `:9413-9417` rejects outright when `predicate.selected_range_identities` is
  empty. This is a separate, earlier rejection from the per-mid comparison.
- `:9418-9425` for each selected entry, compares against
  `meta.block_identity_by_mid[mid]` and rejects with the offending mid named.

Both rejections are `PublishTxnOutcome::FenceRejected`, which the module maps to
`HistorianPublishError::FenceRejected` (`:9525-9527`) and then abandons **without**
arming the failure cooldown (`historian.rs:533-547`), so a retry on a fresh
snapshot is admitted immediately.

### What the fence does not cover

The vector covers only mids inside the pinned range. `historian.rs:2369`
`tail_identity_extension_during_await_still_publishes` establishes that a tail
extension past the range is deliberately permitted and still publishes. The
counterpart, `:2323`
`selected_range_identity_drift_during_await_rejects_without_cooldown`, and
`:2942` `reattach_equal_length_identity_drift_rejects_before_publish`, establish
that an in-range change rejects. `:2942`'s name states the sharpest case: the
change was equal-length, so the fingerprint matched and only the identity vector
caught it.

## Failure scenario

Without the identity fence, this sequence publishes a summary of text the user has
since changed:

1. A firing pins ordinals 1 to 40 and their byte lengths.
2. The producer takes several minutes.
3. The harness rewrites message 17 in place with a same-length edit, for example a
   redaction that replaces characters rather than removing them. The block
   identity changes; the fingerprint does not.
4. The publish commits. The compartment covering 17 now summarizes the old text,
   and the fold hides the new text behind coverage.

The stored raw payload makes this recoverable in principle, but the raw payload
was captured at assembly time (`historian_chunk.rs:717-727`), so it also holds the
old text. Both the summary and the durable original would describe content the
session no longer contains.

The empty-vector rejection covers a different case: a durable row written by an
older build that did not persist identities. Admitting it would publish with no
content freshness proof at all.

## Timing windows and dependencies

The window is the entire producer run, which is bounded per attempt by
`DEFAULT_AWAIT_TIMEOUT` (600 s, `historian_producer.rs:30`) plus
`RECOVERY_REDRAIN_TIMEOUT` (60 s, `:31`). Minutes, in other words, during which the
harness is free to mutate any message.

Dependencies:

- `meta.block_identity_by_mid` must be maintained by the transform path on every
  pass, and must change when content changes. That is `codec/sidecar.rs`'s
  `stamp_block_identity`, which the scope map records as having zero tests of its
  own (`scope-map-and-risk-ranking.md:358-364`). The fence is exactly as strong as
  that stamping.
- The comparison is by value on `Vec<BlockIdentity>`, so ordering matters. Whether
  the projection guarantees a stable order per mid is not established here.

## What a test must construct

1. Reject case: a configured model chain, a fired run, and a store mutation to
   `meta.block_identity_by_mid` for one selected mid during the await. The existing
   tests use a commit hook on the producer double to do this; reuse that seam.
   Assert `FenceRejected`, no compartment appended, and no failure cooldown armed.
2. Empty-vector case: construct a durable `AwaitingProducer` row with
   `selected_range_identities: vec![]` and drive a publish. Assert the rejection
   fires at `mc-store:9413-9417` before the per-mid loop.
3. Permitted case: extend the tail past the pinned range and assert the publish
   still commits, pinning the deliberate carve-out so a future tightening is a
   conscious change.
4. Coverage marker for the vulnerable window: assert the two independent
   preconditions, that a firing reached `AwaitingProducer` and that at least one
   in-range mid was mutated during the await, rather than asserting a wrong publish.

## Investigation log

### Q: The fence covers only mids inside the pinned chunk range. Is permitting a tail extension safe?

- Sources examined: `crates/mc-store/src/lib.rs:9413-9425`;
  `crates/mc-module/src/historian_chunk.rs:698-715`;
  `crates/mc-module/src/historian.rs:2369-2409` (the permitting test) and
  `:2942-3010` (the rejecting test);
  `crates/mc-module/src/historian_validate.rs:525-556` (terminal boundary and
  discard-last healing).
- Findings: an extension past `chunk.end_index` cannot change any pinned identity,
  so the fence is silent by construction. Whether the extension matters depends on
  the validated terminal boundary: `historian_validate.rs:529-534` refuses a
  terminal boundary that splits a completed tool arc, and the discard-last healing
  at `:539-556` pops the last compartment when the lookahead is within
  `BOUNDARY_HEALING_SLACK` (`:19`, `:554`). Those are the mechanisms that would
  have to be wrong for an extension to cause a bad fold.
- Missing evidence: whether `BOUNDARY_HEALING_SLACK = 2` is sufficient when the
  tail extended during the await, and whether the reattach path's
  `force_keep_last_compartment: false` (`lib.rs:4767`) interacts badly with an
  extension. Both are validation-semantics questions.
- Conclusion: unresolved, needs cross-lens reconciliation with the sibling
  validation lens. This lens establishes that the fence is silent on extensions and
  that the silence is deliberate; whether the validator covers the gap is not this
  lens's call.
