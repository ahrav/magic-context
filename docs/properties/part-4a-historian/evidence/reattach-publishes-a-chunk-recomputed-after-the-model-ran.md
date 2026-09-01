# reattach-publishes-a-chunk-recomputed-after-the-model-ran

## Discovery trigger

Following the reattach path to see what it publishes turned up something the fresh
path does not do: it rebuilds the chunk text, the condensed transcript, the
original-message payload, and the fingerprint from the **current** request's
projection, minutes after the producer received the old chunk text. The durable pin
is only a range, a fingerprint, and an identity vector. So the summary and the
stored original come from two different observations of the conversation.

## Evidence trail

### What the fresh path does

`crates/mc-module/src/historian_chunk.rs:611-790` builds the chunk, the transcript,
the raw payload, the fingerprint, and the identity vector from one projection, in
one call, before the producer runs. `AssembledHistorianFiring` carries all of them
(`:765-790`), and `HistorianFiringTask` carries that struct through to
`run_historian_firing` (`lib.rs:5165-5183`, `:5363-5371`). The bytes the model sees
and the bytes stored beside the compartment come from the same observation.

### What the reattach path does

`crates/mc-module/src/lib.rs:4661-4788`, the `AwaitingProducer` arm:

- `:4686-4691` builds `live` from the **current** request's projection.
- `:4692-4695` reads `chunk_range` from the durable state; without it the arm gives
  up with `recovering`.
- `:4696-4702` calls `build_historian_chunk` with the current request's
  `parsed.messages`, `range.from_ordinal`, a token budget derived from the current
  config, and `range.to_ordinal.saturating_add(1)` as the exclusive end.
- `:4703-4709` reloads `prior_compartments` from the store.
- `:4710-4721` re-serializes `raw_chunk_messages` from the current
  `parsed.messages`, filtered to
  `[chunk.chunk.start_index, chunk.chunk.end_index]`. Note this is the **rebuilt**
  chunk's range, not the durable `chunk_range`.
- `:4722` recomputes `boundary_dates` from the current messages.
- `:4723-4725` recomputes the fingerprint from the rebuilt chunk's snapshot.
- `:4754-4757` passes the rebuilt `observed`, `chunk.chunk`, `chunk.text`, and
  `raw_chunk_messages` into `HistorianReattachRequest`.

`crates/mc-module/src/historian.rs:1468-1619`:

- `:1475-1494` `handle_restart_load` supplies the durable ids and the pinned
  fingerprint, which the destructuring at `:1480-1485` discards with `..`.
- `:1529-1530` reloads the durable state as `awaiting`.
- `:1535-1538` awaits the producer output, falling back to a re-drain on timeout.
- `:1592-1610` builds `PublishOutputRequest` with the **rebuilt**
  `observed_chunk_fingerprint`, `validation_chunk`, `chunk_transcript`, and
  `raw_chunk_messages`.

### What still pins the content

- `publish_validated_chunk` compares the durable `predicate.chunk_fingerprint`
  against the rebuilt observation (`historian.rs:448-460`), so an insertion,
  removal, or id or kind change inside the range rejects.
- The store's identity fence compares each pinned mid's block identities against
  the current meta (`mc-store:9418-9425`), so a content change to an in-range
  message rejects.
- `historian.rs:2942` `reattach_equal_length_identity_drift_rejects_before_publish`
  is the test that pins the equal-length case on this path specifically.

### What is not pinned

- The rebuilt chunk's `end_index` is not compared against the durable
  `chunk_range.to_ordinal`. The exclusive end passed at `lib.rs:4701` is
  `to_ordinal + 1`, which should cap it, but `build_historian_chunk` also applies a
  token budget (`:4700`) and its own line-building rules, so the resulting
  `end_index` is whatever the builder chose within that cap.
- `historian.rs:2369` `tail_identity_extension_during_await_still_publishes`
  establishes that a tail extension during the await does not block a publish, so
  the design tolerates the range's neighbourhood changing.
- The validate options differ from the fresh path: `in_emergency: false`
  (`lib.rs:4762`), `force_keep_last_compartment: false` (`:4767`), and
  `sequence_offset: prior_compartments.len() as u64 + 1` (`:4761`) rather than
  `MAX(sequence) + 1` (`historian_chunk.rs:758-763`).
- `publication_floor_ordinal: range.to_ordinal` (`lib.rs:4769`) is set and never
  read; the published floor is `validated.unprocessed_from`
  (`historian.rs:1725`).

## Failure scenario

The damaging shape is not a rejected publish; it is an accepted one whose stored
original does not match its summary.

1. A firing pins ordinals 1 to 40. The producer receives chunk text covering 1 to 40
   and begins summarizing.
2. The process restarts. A later transform request arrives whose projection now
   contains ordinals 1 to 60.
3. `maybe_spawn_reattach` rebuilds the chunk from ordinals 1 to 41 exclusive, so 1
   to 40, and re-serializes the raw payload over the rebuilt `start_index` to
   `end_index`.
4. If the rebuilt `end_index` came out lower than 40, for example because the token
   budget changed with the config, the raw payload is a **subset** of what the model
   summarized, and the compartments validated against a narrower chunk.
5. The publish commits. An expand over the folded range returns fewer messages than
   the summary describes.

The reverse, a superset, is the milder case: the expand returns messages the summary
does not cover.

Both are worse than an absent original, because an absent original fails loudly and
a wrong one does not.

## Timing windows and dependencies

The window is from the original assembly to the reattach publish, which spans a
process restart and at least one transform request, so minutes to hours.

Dependencies:

- `build_historian_chunk`'s determinism given the same messages, start, budget, and
  end. If it is deterministic and the budget is unchanged, the rebuilt range equals
  the original and the property holds trivially. The risk is entirely in the budget
  and the message set changing.
- `derive_historian_chunk_tokens(config.historian_context_limit_tokens)`
  (`lib.rs:4700`) reads live config, which can change between the original firing
  and the reattach.
- The identity fence covers content, not extent. Extent is covered only by the
  fingerprint, which changes on insertion or removal, so a narrower rebuilt range
  over the same messages would change the fingerprint and reject. That is the
  argument that the property probably holds; it needs a test rather than more
  reading.

## What a test must construct

1. Determinism baseline: assemble a firing, then rebuild with
   `build_historian_chunk(messages, live, from, budget, to + 1)` and assert
   `chunk.chunk.start_index` and `end_index` equal the durable range and the
   fingerprint equals the pinned one. This is a pure-function test and is cheap.
2. Budget change: rebuild with a smaller token budget and assert either the
   fingerprint differs, so the publish rejects, or the range is unchanged. Whichever
   holds, pin it.
3. Extended tail: rebuild from a projection with messages past `to_ordinal` and
   assert the raw payload contains exactly the messages in the durable range, not
   the extension. This is the assertion the property is really about.
4. End-to-end: a reattach publish, then inflate `raw_messages_deflate` and compare
   against the messages the producer double was given. That closes the loop and is
   the only form that catches a mismatch introduced anywhere in the chain.

## Investigation log

### Q: Can the rebuilt `chunk.chunk.end_index` differ from the durable `chunk_range.to_ordinal`?

- Sources examined: `crates/mc-module/src/lib.rs:4696-4725`;
  `crates/mc-module/src/historian_chunk.rs:352-455` (`build_historian_chunk`'s
  signature and body start), `:611-790` (the fresh assembly for comparison),
  `:840-856` (`end_placeholder`); `crates/mc-module/src/historian.rs:645`
  (the pinned fingerprint in `RestartAction`), `:1480-1494`
  (where the destructuring drops it), `:448-460` (where the observation is compared
  against the predicate's copy instead).
- Findings: the exclusive end at `lib.rs:4701` caps the rebuild at the durable
  `to_ordinal`, so the range cannot extend. It can in principle contract, because the
  token budget at `:4700` is read from live config rather than from the durable
  state, and `build_historian_chunk` truncates to that budget. A contraction would
  change the fingerprint, which would reject at `historian.rs:448-460`, so the
  observable outcome would be a rejected reattach rather than a mismatched publish.
- Missing evidence: I did not read `build_historian_chunk`'s body in full, only its
  signature and its callers, so I cannot state whether a budget contraction always
  changes the snapshot vector that feeds the fingerprint. If the budget truncates the
  chunk *text* without dropping snapshot items, the fingerprint would match while the
  validated chunk was narrower, which is exactly the bad case.
- Conclusion: unresolved, needs the determinism test above. The record's confidence
  is `medium` for this reason. The rebuild is verified; whether it can produce a
  fingerprint-equal but extent-different chunk is not.

### Q: Does the reattach path's differing `sequence_offset` and validate options change which range is kept?

- Sources examined: `crates/mc-module/src/lib.rs:4760-4768` versus
  `crates/mc-module/src/historian_chunk.rs:777-784` and
  `crates/mc-module/src/lib.rs:5261-5262` with `:5276`;
  `crates/mc-module/src/historian_validate.rs:538-556` (discard-last healing gated
  on `in_emergency` and `force_keep_last_compartment`).
- Findings: with `in_emergency: false` and `force_keep_last_compartment: false`, the
  reattach path always allows discard-last healing, whereas the fresh path may
  suppress it when the original firing was in emergency (`lib.rs:5098`) or when the
  wrapup round was final (`:5276`). So a recovery of an emergency firing can discard
  a compartment the original attempt would have kept, narrowing the published range
  and lowering the floor.
- Missing evidence: whether that narrowing is harmful or merely conservative. A
  narrower fold leaves more in the live tail, which is safe but wastes the model
  call.
- Conclusion: unresolved, and the semantics belong to the sibling validation lens.
  Flagged here because the consequence, a published range that differs from what the
  original firing would have published, is an ordering question.
