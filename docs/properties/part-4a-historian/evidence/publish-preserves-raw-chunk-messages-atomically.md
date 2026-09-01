# publish-preserves-raw-chunk-messages-atomically

## Discovery trigger

The task's highest-consequence question: what preserves the user's original
conversation, and is the original recoverable after a publish. The scope map
frames the historian as "the only path that irreversibly substitutes unverified
language-model text for the user's real conversation". That framing is accurate
about visibility and inaccurate about destruction, and the difference is one
field, `raw_chunk_messages`, which nothing in the scope map mentions.

## Evidence trail

Capture, before the model runs, in `crates/mc-module/src/historian_chunk.rs`:

- `:698-715` builds `selected_range_identities` over non-synthetic messages in
  `[chunk.chunk.start_index, chunk.chunk.end_index]`, aborting the fire if any
  message has no known block identity (`:704-710`).
- `:717-727` serializes the same filtered message set to JSON as
  `raw_chunk_messages`. A serialization error aborts assembly.
- `:765-790` returns them on `AssembledHistorianFiring` (fields at `:771` and
  `:773`).

Carriage, in `crates/mc-module/src/historian.rs`:

- `:425-426` the field doc: "Original CK messages for exact durable full-message
  and verbose recovery."
- `:524-525` `chunk_transcript: Some(request.chunk_transcript)` and
  `raw_chunk_messages: Some(request.raw_chunk_messages)`. Both are always `Some`
  on this path.
- `:1727` the reattach and fresh paths both pass `raw_chunk_messages` through
  `PublishOutputRequest` into the publish request.

Storage, in `crates/mc-store/src/lib.rs`, inside the publish transaction:

- `:9472-9481` calls `insert_chunk_transcripts_tx` when either payload is
  present, passing `first_appended_sequence` so the rows key to the sequences the
  append just used.
- `:12679-12681` returns early when the compartment list is empty.
- `:12682-12686` compresses the condensed transcript and **drops it** when it
  exceeds `MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES` (256 KiB, `:405`).
- `:12687-12690` compresses the raw messages with **no size filter**; a
  compression error becomes `rusqlite::Error::ToSqlConversionFailure`, which
  propagates out of the closure and aborts the whole publish.
- `:12691-12693` returns early only when both payloads are absent.
- `:12694-12697` when the transcript was dropped, substitutes a compressed empty
  string so the `NOT NULL` column is satisfied and the raw payload is not
  discarded along with an oversized transcript. The comment says exactly that.
- `:12698-12714` inserts one row per compartment, `INSERT OR REPLACE`, carrying
  both payloads.
- `:536-547` the schema: `mc_chunk_transcripts` with `transcript_deflate` and
  `raw_messages_deflate`, plus the range index at `:546-547`.

Survival, in the same file:

- `:12715` the insert calls `evict_chunk_transcripts_tx`.
- `:12724-12730` the budget sums `LENGTH(transcript_deflate)` only, against
  `MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES` (8 MiB, `:410`).
- `:12748-12756` a victim that still holds raw messages has only its transcript
  blanked. The comment at `:12749-12750`: "Full message recovery is durable by
  contract."
- `:12757-12761` only a row with no raw payload is deleted.

Deletion paths: whole-session teardown at `:8894` and `:8960`, and the suffix
revert at `:9106`, which deletes transcripts and compartments for the same
reverted suffix inside one transaction (`:9105-9111`).

## Failure scenario

If the raw copy were absent for a published compartment, the folded range would
exist inside this store only as model-generated summary text. The store's own
full-message and verbose expand paths read `mc_chunk_transcripts` (`:9994` is one
such read), so an expand over a folded range would return nothing. The user's
conversation would still exist in the harness session file, which this module
reads and never writes, so the loss would be of the module's own recovery
capability rather than of the conversation. That distinction is what makes the
substitution reversible in practice and is worth stating precisely in the
catalog.

A subtler failure: the raw copy present but not corresponding to the summary. See
`reattach-publishes-a-chunk-recomputed-after-the-model-ran.md`, which is the
record for that shape.

## Timing windows and dependencies

Atomicity needs no window: capture happens at assembly and insertion happens
inside the same transaction as the compartment append.

Two dependencies matter:

- The compartment list must be non-empty, or `insert_chunk_transcripts_tx`
  returns early (`:12679-12681`). Validation refuses an empty set
  (`historian_validate.rs:487-491`), so the historian path cannot reach it.
- Both payloads must not be absent, or `:12691-12693` returns early. The
  historian path always supplies both.

Neither guard is enforced by the store's own signature, which is the open
question below.

## What a test must construct

1. Happy path: a configured model chain, one accepted publish, then inflate
   `raw_messages_deflate` for each appended sequence and compare it byte for byte
   against the JSON that `historian_chunk.rs:717-727` produced. The assembled
   firing already carries that string, so the test can hold it.
2. Oversized-transcript path: a chunk whose condensed transcript compresses past
   256 KiB, proving the transcript is blanked and the raw payload survives. The
   store already has a test in this shape near `:17071`; the addition is
   asserting the raw payload.
3. Eviction path: enough publishes on one session to push the transcript sum past
   8 MiB, then assert every sequence still has a non-null `raw_messages_deflate`.
4. Negative: a compression failure on the raw payload aborts the publish with no
   compartment appended. Hard to construct without a seam, since deflate does not
   fail on valid UTF-8 input in practice.

## Investigation log

### Q: `insert_chunk_transcripts_tx` returns early when both payloads are absent and when the compartment list is empty. Can another caller publish compartments with no recoverable original?

- Sources examined: `crates/mc-store/src/lib.rs:1766-1782`
  (`HistorianPublishRequest`, both payload fields are `Option`), `:9472-9481`,
  `:12671-12716`; every in-repo caller of `publish_historian_chunk`
  (`crates/mc-module/src/historian.rs:529` and the two publication fences at
  `crates/mc-module/src/lib.rs:3310` and `:3347`).
- Findings: exactly one production construction site of the request exists,
  `historian.rs:513-526`, and it always supplies both payloads. The `Option`
  shape and the two early returns are therefore latent, not live. The store's
  test module constructs requests directly, and some of those tests do pass
  `None`; that is test-only.
- Missing evidence: whether `mc-store` is consumed outside this workspace.
  `crates/mc-store/Cargo.toml` gives it a `description` and it is a workspace
  member, but I did not check for an external dependent.
- Conclusion: unresolved, needs a decision on whether the store should require a
  raw payload when appending compartments, rather than relying on the single
  module caller to supply one. The property as written is about the historian
  path and holds there; the store-level widening is a separate hardening
  question.
