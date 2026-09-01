# publish-transaction-is-the-single-commit-point

## Discovery trigger

The task asked for the commit point precisely: the single operation after which
the substitution is visible and irreversible. Tracing that question backwards
from `publish_validated_chunk` showed the module makes five separate durable
writes before the publish and only the sixth carries the substitution. The
interesting property is not where the commit is but what is inside it, because
five writes land in five independent transactions and six writes land in one.

## Evidence trail

The publish path in `crates/mc-module/src/historian.rs`:

- `:444-460` `publish_validated_chunk` re-checks the pinned fingerprint against
  the observed one and abandons the matching firing before returning a mismatch.
- `:462-511` projects validated compartments, events, primer candidates, and
  optionally user observations onto store row shapes.
- `:513-526` builds `HistorianPublishRequest`, always with
  `chunk_transcript: Some(...)` and `raw_chunk_messages: Some(...)`.
- `:527-530` calls the publication fence when present, otherwise
  `store.publish_historian_chunk` directly.

The transaction in `crates/mc-store/src/lib.rs`:

- `:9360` `self.inner.with_conn_fenced(|tx| { ... })` opens it.
- `:9361-9382` reads `(row_version, meta)` and applies the row-version CAS.
- `:9384-9407` deserializes meta, checks the phase, checks the five-field
  predicate.
- `:9413-9425` the block-identity content fence.
- `:9427-9434` the revert-epoch check.
- `:9436-9455` re-reads `(MAX(sequence), COUNT(*))` and checks it against the
  pinned compartment-set generation.
- `:9457` `first_appended_sequence = next_compartment_sequence_tx(...)`.
- `:9458-9471` `append_compartments_tx`, write 1.
- `:9472-9481` `insert_chunk_transcripts_tx`, write 2.
- `:9482` `enqueue_historian_side_channels_tx`, write 3.
- `:9484-9488` raises `meta.publication_floor_ordinal` with a `max`, write 4.
- `:9489` `meta.historian = idle_historian_after_success(firing_seq)`, write 5.
- `:9491-9500` `UPDATE mc_cache_state SET row_version = next, meta = ...
  WHERE session_id = ?1 AND row_version = ?4`, write 6.
- `:9502-9505` returns `PublishTxnOutcome::Committed`.
- `:9508-9517` after the transaction, drains the queued side channels best
  effort. Failures stay queued for a later transform, per the comment at
  `:9509-9510`.

The wrapper, outside this repository, at
`../commons/crates/cortexkit-store/src/lib.rs`:

- `:185-192` takes an `Immediate` transaction.
- `:194-227` ensures and checks the writer-epoch fence table, rejecting when a
  newer writer owns the database (`:211-218`) and claiming it otherwise
  (`:219-227`).
- `:229` runs the closure.
- `:230-232` `tx.commit()`, then returns.

Every early return inside the closure returns a `PublishTxnOutcome` value rather
than an error, so the transaction commits in those cases too. That is deliberate
for `Committed` and harmless for the rejection variants, which write nothing.

Confirmation that the transaction touches no render state: the store's doc at
`:9345-9350` states it "intentionally leaves render state (`CoreState`,
`coverage_ordinal`, watermarks, and m1 revision) untouched", matching the module
side at `historian.rs:441-443`. I read the closure body and found no write
outside the six listed above.

## Failure scenario

Suppose the compartment append at `:9458` committed but the row-version bump at
`:9496` did not. The session would hold a model-generated summary row while
`meta.historian` still said `Publishing` and the publication floor had not
moved. The next `handle_restart_load` would see `Publishing`, abandon, and make
the session refire-eligible (`historian.rs:648-653`). The refire would assemble
a chunk starting past `MAX(end_message)` (`historian_chunk.rs:629-642`), which
now includes the orphaned compartment, so the range would not be re-summarized.
The orphaned compartment would fold the range while the floor stayed behind it,
and the boundary logic would treat those ordinals as still eligible for
placement (`boundary.rs:1417-1426`). The symptom is a fold whose floor does not
protect it, not lost content.

The reverse partial, floor raised without compartments appended, is worse: a
range with no summary and no boundary eligibility.

## Timing windows and dependencies

The window is the interior of one `Immediate` SQLite transaction on a local
file, so it is short in wall-clock terms and only a process kill or a SQLite
error can land in it. Dependencies:

- SQLite's own atomicity, and the `Immediate` behaviour chosen at
  `../commons/crates/cortexkit-store/src/lib.rs:191`.
- The single-writer lease acquired before the file is opened (`:265-277`), plus
  the per-transaction epoch fence (`:211-218`), which together are what stop a
  second process from interleaving.
- Durable pragmas, which `open_sqlite` claims to set (`:266`). I did not read
  the pragma list.

## What a test must construct

A configured model chain, a fired run driven to `Publishing`, and a fault inside
the transaction. The blocker is that no such seam exists. The
`#[cfg(test)] after_store_publish` hook (`lib.rs:3292-3293`, fired at
`:3311-3319`) runs after `store.publish_historian_chunk` has returned, so it is
outside the window by construction. Options, cheapest first:

1. Assert the post-condition conjunction after a successful publish and after
   each rejection variant, which does not test atomicity but does pin the
   six-write set so a future change that drops one is caught.
2. Add a `#[cfg(test)]` hook inside the closure, between the append and the
   row-version bump, that returns a `rusqlite::Error`. That exercises rollback,
   which is the achievable half of the property.
3. A SIGKILL harness driving the real binary, which is the only way to test the
   process-death case. Expensive and belongs with the crash-consistency work
   rather than here.

## Investigation log

### Q: Is there any intended fault-injection seam inside the publish transaction, or is the wrapper's atomicity taken on faith?

- Sources examined: `crates/mc-store/src/lib.rs:9351-9546`; every `#[cfg(test)]`
  and `cfg(feature =` occurrence in `crates/mc-store/src/lib.rs`;
  `crates/mc-module/src/lib.rs:3286-3359` for the two publication fences;
  `crates/mc-module/src/lib.rs:13229-13337`, the `drive-fault` feature block.
- Findings: the only test hook near the publish is
  `after_store_publish`, which fires after the store call returns. The
  `drive-fault` feature is scoped to the transform drive path, not the store. No
  `#[cfg(test)]` branch exists inside the publish closure.
- Missing evidence: whether the sibling `cortexkit-store` crate offers a fault
  hook. Its `with_conn_fenced` at `../commons/crates/cortexkit-store/src/lib.rs:185-232`
  has none, and that crate is outside this repository so changing it is not in
  scope for Part 4a.
- Conclusion: unresolved, needs a decision on whether a store-level fault seam
  is worth adding. The atomicity is taken on faith today. Recording it as
  `Exercised: partial` with the two existing transcript tests is the honest
  label.
