# tshist-a-publish-stores-no-durable-raw-copy

## Discovery trigger

Part 4a records two Rust-side records about raw-message retention:
`publish-preserves-raw-chunk-messages-atomically` and
`raw-chunk-message-retention-has-no-eviction-budget`. The task asks what
preserves the user's original conversation on this side, and whether the answer
matches. Checking the TypeScript publish transaction for the same write found
nothing, so the question became whether the write exists anywhere in
`packages/`.

## Evidence trail

All references at `HEAD` = `e447c927`.

**The Rust write, for comparison.** `crates/mc-store/src/lib.rs:9472-9479`:

```
if request.chunk_transcript.is_some() || request.raw_chunk_messages.is_some() {
    insert_chunk_transcripts_tx(
        tx,
        session_id,
        first_appended_sequence,
        request.compartments,
        request.chunk_transcript,
        request.raw_chunk_messages,
    )?;
}
```

`raw_chunk_messages` is declared on the publish request at
`crates/mc-store/src/lib.rs:1780`. The call is inside the publish transaction,
which is what Part 4a's atomicity record covers.

**The TypeScript side has no counterpart.** A repository-wide search across
`packages/` for `chunk_transcript`, `chunkTranscript`, `rawChunkMessages`, and
`raw_chunk_messages` returns zero hits.

`packages/plugin/src/features/magic-context/compartment-storage.ts:14` is the
only compartment insert:

```
INSERT INTO compartments (session_id, sequence, start_message, end_message,
start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance,
episode_type, legacy, created_at, harness) VALUES (...)
```

`content` mirrors `p1` for v2 rows (`compartment-parser.ts:195`), which is model
output, not raw text. There is no raw-text column and no sibling transcript
table written by `appendCompartments` (`compartment-storage.ts:316`).

**What the publish transaction does write.**
`compartment-runner-incremental.ts:648` (compartments), `:663-677` (promoted
facts), `:685` (events), `:695` (queued drops), `:704` (publication floor),
`:707-713` (deferred marker blob). None carries raw message text.

**What the raw text is used for and then discarded.** `chunk.text`
(`read-session-chunk.ts:823`) is formatted into the prompt at
`compartment-runner-incremental.ts:450` and passed to
`embedAndStoreCompartmentChunks` as `sourceChunkText` (`:792`) on a post-commit
best-effort path (`:786-812`). Embeddings are a vector substrate, not a
recoverable original.

**What preserves the original.** Nothing in this pipeline deletes harness
messages. `queueDropsForCompartmentalizedMessages`
(`compartment-runner-drop-queue.ts:30-77`) only calls `queuePendingOp(...,
"drop")` at `:61` and `:69`, against the plugin's own tag rows. The compaction
marker changes what the harness *sends*, not what it stores:
`compaction-marker-manager.ts:9-12` says the marker "exists solely to make
OpenCode's filterCompacted stop at the boundary so the transform receives only
the live tail", and `removeCompactionMarker` is imported at `:23`.

## Failure scenario

A model produces a valid but poor summary. It publishes. The user wants the
original text of messages 1 through 400 back.

Rust mode: the chunk transcript is in the store, written in the same transaction
as the compartments.

TypeScript mode: the only copy is OpenCode's own message database, reachable
through `read-session-*`. If that database is pruned, rotated, or the session is
deleted by the harness, the raw text is gone and the compartment rows are the
sole remaining record.

## Timing windows and dependencies

No window. This is a static absence, established by search rather than by
interleaving. The dependency that matters is external: the guarantee is only as
strong as the harness's own retention, which this side neither sets nor observes.

## What a test must construct

1. Publish one chunk through `runCompartmentAgent`.
2. Enumerate every table the publish transaction wrote and assert none contains
   any substring of `chunk.text` beyond what a compartment body legitimately
   quotes.
3. Assert the harness store still holds every ordinal in
   `chunk.startIndex..chunk.endIndex`.

Step 2 is the load-bearing one and is awkward to write honestly, because a
summary may legitimately quote the original. A cleaner oracle is schema-level: no
column written by `:637-714` is declared to hold raw message text.

## Investigation log

### Q: Is the harness store a durable enough original for the product's stated retention promise, or does a Rust-mode install silently have a stronger guarantee than a TypeScript-mode one?

- Sources examined: `compartment-storage.ts` insert list;
  `compartment-runner-incremental.ts:637-714`; `crates/mc-store/src/lib.rs:1780`,
  `:9472-9479`; `compaction-marker-manager.ts:9-12`; the four search terms above
  across `packages/`.
- Findings: the asymmetry is real and one-directional. Rust persists a raw copy
  inside the publish transaction; TypeScript persists none. Neither the plugin
  nor the CLI deletes harness messages on this path, so in normal operation the
  original survives in the harness. Part 4a further records that the Rust suffix
  revert deletes compartments *and* their transcripts, so Rust's copy is not
  unconditionally durable either.
- Missing evidence: no document in `docs/` was found stating a retention promise
  to the user. Whether one exists was not exhaustively established; the search
  was limited to the 5b file set plus the two Rust references.
- Conclusion: needs human input. Whether the divergence is acceptable is a
  product decision about what "your conversation is preserved" means, and the two
  transport modes currently answer it differently.
