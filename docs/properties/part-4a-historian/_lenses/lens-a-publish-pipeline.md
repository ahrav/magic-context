# Part 4a lens A: the publish pipeline, its state machine, and irreversibility

Attention focus: what the historian pipeline writes, in what order, under what
compare-and-swap, and what can be lost or double-applied. Content validation is
a sibling lens's territory; this pass treats `validate_historian_output` as an
opaque accept/reject oracle and only asks what happens on each side of it.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `76cd6f41`
("refactor(shm): simplify fixed-ring ownership"). `git diff --stat
dde0c051..HEAD -- crates/mc-module/src/` is empty, so every `mc-module` line
reference in
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md)
still resolves at this `HEAD`. Method contract in
[../../METHOD.md](../../METHOD.md).

Every line reference below was read back individually at `HEAD`. Two references
outside the stated Part 4a scope are load-bearing and are cited explicitly:
`crates/mc-store/src/lib.rs` (the publish transaction itself) and
`../commons/crates/cortexkit-store/src/lib.rs` (the transaction wrapper, which
lives outside this repository).

## Pipeline map

The pipeline has five durable phases and six durable writes. The phases are
named in the module header (`historian.rs:1-6`): `idle -> firing ->
awaiting_producer -> validating -> publishing`. The writes matter more than the
phases, because five of the six are separate transactions and only the sixth
carries the substitution.

**1. Trigger.** A transform request reaches
`McHandler::handle_transform_unpaged_value`. Two arms can start a firing. The
emergency arm (`lib.rs:8370-8456`) drives the firing inline and awaits it. The
ordinary arm (`lib.rs:8458-8480`) spawns it and returns immediately. A third
entry, `session.wrapup`, drives a multi-round drain
(`lib.rs:6594-7132`). A fourth, `maybe_spawn_reattach` (`lib.rs:4614-4806`),
resumes a firing left behind by a previous process.

Nothing fires unless the resolved config carries a model chain. `model_chain`
defaults to empty (`config.rs:121`) and is populated only from user config keys
`/historian/module_model`, `/historian/model`, and their fallback arrays
(`config.rs:390-425`). `prepare_historian_fire` returns `no_models` when it is
empty (`lib.rs:5021-5031`). This is why every record in this lens is labelled
`explicit-config-only`.

**2. Assembly (no durable write).** `assemble_historian_firing`
(`historian_chunk.rs:611-790`) reads one snapshot of stored compartments, the
revert epoch, and the compartment-set generation (`:624-627`), picks the chunk
start just past the last covered ordinal (`:629-657`), builds the chunk text
(`:666-672`), and then pins three separate freshness records:

- `selected_range_identities`, one entry per non-synthetic message in the chunk
  range carrying that message's block identities (`:698-715`). A message with no
  known identity aborts the fire (`:704-710`).
- `chunk_fingerprint`, ordered `id:kind:byte-length` pieces joined with `|`
  (`historian.rs:151-160`), computed at `historian_chunk.rs:751-756`.
- `raw_chunk_messages`, the original CK messages of the chunk range serialized
  to JSON (`historian_chunk.rs:717-727`). This is the user's real conversation,
  captured before the model has run.

**3. Fire (durable write 1).** `fire` refuses unless the phase is exactly `Idle`
(`historian.rs:251-253`) and otherwise returns a state with `firing_seq + 1`,
the chunk range, the fingerprint, the identities, the expected revert epoch, and
the compartment-set generation (`:255-275`). `run_historian_firing` re-verifies
the fingerprint, loads, fires, and persists (`:1260-1278`).

**4. Producer start (durable write 2).** `producer.start` returns a run id;
`producer_started` moves to `AwaitingProducer` and records the session id, run
id, and harness (`historian.rs:278-297`), persisted at `:1332-1338`. The
producer session id embeds `firing_seq` so a fallback attempt never resumes a
failed run (`:1013-1035`).

**5. Await output (no durable write).** `await_output` and `redrain_output` are
the same `subscribe_from_start` call with different timeouts
(`historian_producer.rs:848-878`), so draining is replay-safe against the
producer. A timeout falls back to a re-drain (`historian.rs:1340-1368`).

**6. Validating (durable write 3).** `publish_output_from_awaiting` transitions
to `Validating` and persists before it validates (`historian.rs:1663-1664`),
then validates (`:1666-1679`).

**7. Publishing (durable write 4).** On acceptance, `validation_ok` moves to
`Publishing` and the persist returns the row version that the publish CAS will
use (`historian.rs:1706-1707`). The comment at `:1709-1713` states why the row
version is not reloaded: reloading would adopt a racing sync's version and erase
the CAS conflict that must retire a stale run.

**8. Publish (durable write 5, the commit point).**
`publish_validated_chunk` (`historian.rs:444-595`) re-checks the fingerprint
(`:448-460`), projects the validated compartments, events, primers, and optional
user observations onto store row shapes (`:462-511`), and calls either the
publication fence or the store directly (`:527-530`). The store's
`publish_historian_chunk` (`mc-store/src/lib.rs:9351-9546`) does everything else
inside one transaction.

**9. Side-channel drain (durable write 6, after the commit).** Once the
transaction commits, the store drains the queued side channels best effort
(`mc-store/src/lib.rs:9508-9517`). Failures stay queued for a later transform.

## Observations

### The publish transaction and its gates

- `mc-store/src/lib.rs:9360` opens the transaction via
  `self.inner.with_conn_fenced(...)`. The wrapper takes an `Immediate`
  transaction, checks a writer epoch fence, runs the closure, and commits
  (`../commons/crates/cortexkit-store/src/lib.rs:185-232`). The closure's `Ok`
  return is what causes `tx.commit()` at `:230`.
- Gate 1, row-version CAS: `mc-store/src/lib.rs:9373-9382` compares the current
  `row_version` against `expected_row_version`, which is the version written by
  the `Publishing` transition.
- Gate 2, phase: `:9389-9396` requires the durable phase to be `Publishing` **or
  `AwaitingProducer`**. The second alternative is wider than the documented state
  machine.
- Gate 3, predicate identity: `:9398-9407` requires `firing_seq`,
  `producer_run_id`, `chunk_fingerprint`, `selected_range_identities`, and
  `compartment_set_generation` all to match.
- Gate 4, content freshness: `:9413-9417` rejects an empty identity vector
  outright, and `:9418-9425` rejects if any selected message's block identities
  no longer match `meta.block_identity_by_mid`.
- Gate 5, revert epoch: `:9427-9434` rejects as a CAS conflict when the session
  was re-cut mid-firing.
- Gate 6, compartment-set generation, re-read inside the transaction:
  `:9436-9455` recomputes `(MAX(sequence), COUNT(*))` and rejects a mismatch.
- Gate 7, range overlap, the storage backstop: `append_compartments_tx`
  validates the whole batch against existing ranges before writing its first row
  (`:12634-12652`), so a rejected batch stays atomic.

### What the transaction writes, in order

1. `append_compartments_tx` inserts the model-generated compartment rows
   (`:9457-9471`).
2. `insert_chunk_transcripts_tx` inserts the condensed transcript and the
   deflated original CK messages, keyed to the same sequences (`:9472-9481`,
   implementation at `:12671-12716`).
3. `enqueue_historian_side_channels_tx` queues events, primers, and user
   observations (`:9482`).
4. `meta.publication_floor_ordinal` is raised, never lowered, by a `max`
   (`:9484-9488`).
5. `meta.historian` is reset to idle at the same `firing_seq` (`:9489`).
6. `UPDATE mc_cache_state SET row_version = current + 1, meta = ...` with
   `WHERE row_version = current` (`:9491-9500`).

### Preservation of the original

- `raw_chunk_messages` is always `Some` on this path (`historian.rs:524-525`),
  and its field doc calls it "Original CK messages for exact durable
  full-message and verbose recovery" (`historian.rs:425-426`).
- The condensed transcript is dropped when it compresses past
  `MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES` (256 KiB, `mc-store:405`, applied at
  `:12682-12686`), but the raw messages have no such per-row filter
  (`:12687-12690`); a compression error aborts the whole publish.
- Eviction (`:12718-12763`) sums only `transcript_deflate` against
  `MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES` (8 MiB, `:410`, used at
  `:12724-12730`). A victim row that still holds raw messages has its transcript
  blanked and its raw payload retained (`:12748-12756`); only a row with no raw
  payload is deleted (`:12757-12761`). The comment at `:12749-12750` states the
  rule: "Full message recovery is durable by contract."
- The only paths that delete `mc_chunk_transcripts` are whole-session teardown
  (`:8894`, `:8960`) and the suffix revert at `:9106`, which deletes transcripts
  and compartments for the same reverted suffix inside one transaction
  (`:9105-9111`).

### Single flight, races, and fences

- In-process claim: `try_claim_live_historian_session` (`lib.rs:4556-4581`)
  inserts a per-session entry and hands back a guard whose `Drop` removes it and
  notifies waiters. Both `prepare_historian_fire` (`lib.rs:5146-5163`) and
  `prepare_wrapup_fire` (`lib.rs:5286-5291`) go through it.
- Durable claim: `fire` returns `Busy` on any non-idle phase
  (`historian.rs:251-253`). `prepare_wrapup_fire` additionally refuses when the
  phase is not `Idle` (`lib.rs:5211-5216`).
- Reattach has its own latch, `reattaching_sessions` (`lib.rs:4640-4650`), and
  defers to a live in-process firing (`lib.rs:4632-4639`).
- Cross-process: the store is opened under a single-writer lease acquired before
  the file is opened (`../commons/crates/cortexkit-store/src/lib.rs:265-277`),
  and every transaction re-checks the writer epoch (`:211-218`).
- Optimistic snapshot fences exist for two of the three publish routes.
  `WrapupSnapshotPublicationFence` (`lib.rs:3288-3322`) and
  `ReattachSnapshotPublicationFence` (`lib.rs:3324-3359`) hold the transform
  snapshot mutex across the check and the store write. The ordinary pressure
  firing deliberately passes `publication_fence: None` (`lib.rs:5165-5183`,
  reasoning in the comment at `:5178-5181`), and so does
  `prepare_wrapup_fire`'s task before `handle_session_wrapup_value` attaches one
  (`lib.rs:5298`, then `:6969-6975`).
- Losing-race handling is differentiated. A fence rejection abandons **without**
  arming the failure cooldown so an immediate retry is admitted
  (`historian.rs:533-547`, helper at `:1786-1801`). A compartment overlap does
  the same (`:548-559`). A row-version CAS conflict abandons **with** the
  cooldown (`:560-583`). Any other store error leaves the producer run intact
  for the normal recovery path and only records a publish failure (`:584-593`).

### Recovery

- `handle_restart_load` (`historian.rs:620-655`) maps `Idle` to `Done`,
  `AwaitingProducer` to a reattach with the durable producer ids, and
  `Firing | Validating | Publishing` to abandon-and-refire-eligible
  (`:648-653`). The doc at `:616-619` states the reasoning: a surviving
  `Publishing` row proves the transaction did not commit.
- A reattach whose `producer.status` call fails does **not** abandon; the comment
  at `historian.rs:1499-1504` says abandoning would authorize a second billable
  firing, so only an explicit `Missing` answer refires (`:1517-1526`).
- The inline emergency drive awaits a spawned task with a timeout and documents
  that a timeout does not cancel the task (`lib.rs:5396-5407`, timeout at
  `:5420`).

### Ordering and progress

- Chunks are ordered by construction, not by an applied-in-order check. The next
  chunk starts at the first present ordinal past `MAX(end_message)`
  (`historian_chunk.rs:629-642`), the store assigns sequences from
  `MAX(sequence) + 1` at write time (`mc-store:12618`, `:12654-12656`), and
  overlap is rejected on message ranges (`:12637-12646`). Validation refuses a
  batch that makes no forward progress past the last stored end
  (`historian_validate.rs:625-635`) and refuses an empty compartment set
  (`:487-491`).
- `unprocessed_from` is `last_new_end + 1` where `last_new_end` is the end of the
  last **kept** compartment after discard-last healing
  (`historian_validate.rs:638`), and it becomes the publication floor
  (`historian.rs:1725`).
- The wrapup drain has no round cap by design (`lib.rs:6831-6834`,
  `historian.rs:952-961`); its ceiling is `MAX_WRAPUP_REQUEST_BUDGET` (3800 s,
  `historian.rs:962`) with a per-round bound of `wrapup_round_wait_budget`
  (600 s, `:966`). Each round demands observable progress: if
  `max_compartment_end_ordinal` did not advance, the loop breaks with a
  retryable failure (`lib.rs:6977-6989`).
- The emergency arm uses the publication floor as its interleaving detector and
  states the invariant it relies on: "a PUBLISH is the only event that advances
  the publication floor" (`lib.rs:8481-8501`). Production writes to
  `meta.publication_floor_ordinal` occur at exactly one site,
  `mc-store:9484-9488`.

### Effect accounting on the producer

The billable effect is a producer run. Attempted and acknowledged diverge in one
specific branch.

- Output-failure fallback demands typed proof that the failed attempt stopped:
  `decision.try_next_model && cancellation_confirmed_stopped(&cancel_result)`
  (`historian.rs:1401`), where only `Ok(())` counts as proof, with the reasoning
  spelled out at `:1226-1240`.
- Start-failure fallback demands no such proof. The branch at
  `historian.rs:1290-1329` persists an abandon and, if `decision.try_next_model`,
  closes the attempt and continues to the next model (`:1318-1322`). It never
  calls `cancel`, because no run id is known, and `decide_producer_failure`
  (`:1052-1143`) never inspects the send outcome. `HistorianSendOutcome` has an
  `OutcomeUnknown` variant (`historian_producer.rs:78-82`), so a start that
  actually reached Broca and began a run can be followed by a second start.

## Commit point and irreversibility

**The commit point is the transaction opened at
`crates/mc-store/src/lib.rs:9360` and committed by `tx.commit()` at
`../commons/crates/cortexkit-store/src/lib.rs:230`.** Inside the repository the
last operation before that commit is the row-version bump at
`crates/mc-store/src/lib.rs:9496-9500`. Everything the substitution depends on
lands in that one transaction: the model-generated compartment rows
(`:9458`), the deflated original messages (`:9472-9481`), the queued side
channels (`:9482`), the raised publication floor (`:9484-9488`), and the reset to
idle (`:9489`). Before it commits, no summary row exists and a crash refires
cleanly. After it commits, the transform's next materializing pass folds the
covered prefix behind `m0`/`m1` and the model's text is what the agent sees.

Three qualifications on "irreversible", all verified:

1. **The substitution is additive, not destructive.** The transaction writes no
   render state; the store's own doc says it "intentionally leaves render state
   (`CoreState`, `coverage_ordinal`, watermarks, and m1 revision) untouched"
   (`mc-store:9345-9350`), matching `historian.rs:441-443`. Nothing on the
   publish path deletes or overwrites a source message.
2. **The user's original conversation is recoverable.** The original CK messages
   for the folded range are serialized at assembly time
   (`historian_chunk.rs:717-727`), carried through the publish request
   (`historian.rs:525`), and inserted in the same transaction as the summary
   (`mc-store:9472-9481`). Session-level eviction is designed never to reclaim
   them (`:12748-12756`). Two independent copies therefore survive a publish:
   `mc_chunk_transcripts.raw_messages_deflate`, and the harness's own session
   file, which this module reads but never writes.
3. **The reversal is a suffix revert, not an undo.** `:9105-9111` drops
   compartments and their transcripts above a kept sequence inside one
   transaction and bumps `revert_epoch`. That restores verbatim serving of the
   reverted range, but it also discards the durable raw copy for that range, so
   after a revert the harness session file is the only remaining source.

## Candidate properties

Every record below is `explicit-config-only`. The evidence is the same for all
of them and is stated once here rather than repeated verbatim twelve times:
`model_chain` defaults to empty (`config.rs:121`), is populated only from user
config (`config.rs:390-425`), and an empty chain short-circuits every entry
point (`lib.rs:5021-5031`, `lib.rs:5228-5231`, `historian.rs:1249-1251`). Each
record's `Reachability` line names the additional state its own path needs.

### publish-transaction-is-the-single-commit-point

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `mc-store/src/lib.rs:16984` `publish_historian_chunk_persists_transcript_inside_cas` and `:17017` `publish_historian_chunk_cas_conflict_leaves_no_transcript_row` cover the transcript half of the atom; no test asserts all six writes land or none do, and no CI job runs either (`ci.yml:171-172` is the only `mc-module` test invocation and it runs one integration binary).
Guarantee: The compartment rows, the deflated original messages, the queued side channels, the raised publication floor, and the historian phase reset either all become durable together or none of them do.
Check: `always` — after any outcome of `publish_historian_chunk`, the observed store satisfies: `count(compartments appended by this predicate) > 0` if and only if `publication_floor_ordinal >= validated.unprocessed_from` and `meta.historian.state == Idle` at the published `firing_seq` and a `mc_chunk_transcripts` row exists for each appended sequence. Semantics are `always` because it constrains every reachable post-publish state, not one code point.
Fault/timing angle: Process kill or SQLite failure between any two of the six writes at `mc-store:9457-9500`. The window is the interior of one `Immediate` transaction, so the property is the claim that the wrapper's commit boundary really is the only visible boundary.
Required faults and enabling state: A configured model chain, a fired run reaching `Publishing`, and either an injected SQLite error inside the transaction or a SIGKILL during it. The `#[cfg(test)] after_store_publish` hook (`lib.rs:3311-3319`) fires only after the store call returns, so it cannot land inside the window; a fault seam inside the transaction does not exist today.
Confidence: high — [evidence](../evidence/publish-transaction-is-the-single-commit-point.md). Read the whole closure at `mc-store:9360-9505` and the wrapper at `../commons/crates/cortexkit-store/src/lib.rs:185-232`; confirmed the single `tx.commit()` at `:230` and that every early return inside the closure is a value, not a commit.
Existing check: `mc-store/src/lib.rs:16984`, `:17017`, `:18221` (`publish_historian_chunk_fails_loud_from_non_publish_state`). Status `unaudited`.
Impact: A partial commit that appended compartments without raising the floor, or raised the floor without appending, would leave a range that is neither summarized nor eligible for boundary placement.
Open questions:
- Is there any intended fault-injection seam inside the publish transaction, or is the wrapper's atomicity taken on faith? (needs human input)

### publish-preserves-raw-chunk-messages-atomically

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `mc-store/src/lib.rs:16984` asserts a transcript row exists after a publish and `:17017` asserts none exists after a CAS conflict; neither asserts that `raw_messages_deflate` round-trips to the exact pre-publish messages. Not run in CI.
Guarantee: Every compartment appended by a publish has, in the same transaction, a durable deflated copy of the original CK messages for the range it replaces.
Check: `always` — for every appended compartment sequence `s`, a `mc_chunk_transcripts` row exists with `compartment_seq = s` and non-null `raw_messages_deflate` that inflates to the exact JSON serialized at `historian_chunk.rs:717-727`. `always` because this is the invariant that makes the substitution recoverable, and it must hold in every post-publish state.
Fault/timing angle: None for the atomicity itself; the window of interest is between assembly and publish, during which the projection can change while the fingerprint stays equal.
Required faults and enabling state: A configured model chain and one accepted publish. To attack it: a chunk whose compressed raw payload is large, and a chunk whose condensed transcript exceeds 256 KiB so the transcript is dropped (`mc-store:12682-12686`) while raw must survive.
Confidence: high — [evidence](../evidence/publish-preserves-raw-chunk-messages-atomically.md). Traced `raw_chunk_messages` from `historian_chunk.rs:717-727` through `historian.rs:525` and `mc-store:9472-9481` into `:12687-12713`; confirmed no size filter on the raw payload and that a compression error aborts the publish.
Existing check: `mc-store/src/lib.rs:16984`, `:17039`-region transcript-cap tests. Status `unaudited`.
Impact: If the raw copy were absent, the folded conversation would exist only as model-generated summary text inside this store, and the store's own full-message and verbose expand paths would have nothing to serve.
Open questions:
- `insert_chunk_transcripts_tx` returns early when both payloads are absent (`mc-store:12691-12693`) and when the compartment list is empty (`:12679-12681`). The historian path cannot reach either, but nothing in the store's own signature prevents another caller from publishing compartments with no recoverable original. Unresolved, needs a decision on whether the store should enforce it.

### raw-chunk-message-retention-has-no-eviction-budget

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test measures the growth of `raw_messages_deflate` across many publishes, and the eviction tests exercise only the transcript budget.
Guarantee: Session transcript eviction never reclaims a raw-message payload, and therefore `SUM(LENGTH(raw_messages_deflate))` per session is bounded only by the number of publishes.
Check: `always` — after any number of publishes and evictions, every compartment sequence that ever had a non-null `raw_messages_deflate` still has one. Paired with a `sometimes` on the operational state that makes the growth visible: at least one campaign session reaches `SUM(LENGTH(transcript_deflate)) > MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES` so the eviction loop actually runs and is observed to blank rather than delete. These are separate assertions on independent preconditions, not an `always(!X)`/`sometimes(X)` pair.
Fault/timing angle: None. This is a monotone accumulation over a long session.
Required faults and enabling state: A configured model chain and enough publishes on one session to push the transcript sum past 8 MiB (`mc-store:410`).
Confidence: high — [evidence](../evidence/raw-chunk-message-retention-has-no-eviction-budget.md). Read `evict_chunk_transcripts_tx` at `mc-store:12718-12763`; the budget query at `:12724-12729` sums `transcript_deflate` only, and the victim branch at `:12748-12756` retains raw. Also confirmed the loop terminates: each iteration either blanks a row (removing it from the victim predicate at `:12738`) or deletes it.
Existing check: none found for raw-payload growth.
Impact: This is the price of recoverability and is probably the right trade, but it is an unbounded per-session growth term that nothing measures or alarms on. It belongs in the catalog as a resource property so the trade is explicit rather than accidental.
Open questions:
- Is unbounded raw retention the intended contract, or is a separate raw budget missing? The comment at `mc-store:12749-12750` reads as deliberate. Needs a product decision on long-session storage. (needs human input)

### historian-single-flight-admits-one-publish-per-firing

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:4243` `pure_state_machine_happy_path_and_single_flight` covers the pure `fire`/`Busy` transition and `:3011` `concurrent_lineages_reattach_and_publish_in_isolated_sessions` covers two lineages; no test drives two concurrent publishes against one session id. Not run in CI.
Guarantee: For one session, at most one publish transaction commits per `firing_seq`, and a second concurrent publisher is rejected before any row is appended.
Check: `always` — for every session, the multiset of committed publishes has distinct `firing_seq` values, and every rejected publish leaves `count(mc_compartments)` unchanged. `always` because it constrains every reachable state of the store, and the forbidden state (two commits at one `firing_seq`) has no dedicated detection point, so `unreachable` would be wrong.
Fault/timing angle: Two publishers interleaving between the `Publishing` persist (`historian.rs:1707`) and the transaction at `mc-store:9360`. The first to commit bumps `row_version` and resets the phase to idle, so the second fails gate 1 (`:9373-9382`) and gate 2 (`:9389-9396`).
Required faults and enabling state: A configured model chain, plus either two in-process firings racing (which the live-session guard at `lib.rs:4556-4581` is meant to prevent) or one firing racing its own reattach (which the reattach latch at `lib.rs:4640-4650` and the live-session check at `:4632-4639` are meant to prevent). The interesting construction bypasses the in-process guards and drives `publish_validated_chunk` twice, which the pure-function seam permits.
Confidence: high — [evidence](../evidence/historian-single-flight-admits-one-publish-per-firing.md). Verified three independent layers: `fire` refuses non-idle (`historian.rs:251-253`), the store predicate binds five fields (`mc-store:9398-9407`), and the row-version CAS uses the version written by the `Publishing` transition rather than a fresh read (`historian.rs:1707-1719` with the reasoning at `:1709-1713`).
Existing check: `historian.rs:4243`, `:4314` `fingerprint_mismatch_at_publish_abandons_and_releases_single_flight`, `:4451` `compartment_generation_fence_releases_overlapped_publish_to_idle`. Status `unaudited`.
Impact: Two commits at one `firing_seq` would append the same summarized range twice. The overlap backstop at `mc-store:12637-12646` would catch identical ranges, but a fallback attempt that produced different boundaries could append an overlapping-but-not-identical second fold.
Open questions: None.

### publish-fence-rejects-selected-content-drift

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:2323` `selected_range_identity_drift_during_await_rejects_without_cooldown` and `:2942` `reattach_equal_length_identity_drift_rejects_before_publish` cover the reject; `:2369` `tail_identity_extension_during_await_still_publishes` covers the permitted extension. Not run in CI.
Guarantee: No publish commits if any message in the pinned chunk range has changed content since the fire, and a firing with no recorded content identities cannot publish at all.
Check: `always` — at the instant of commit, for every entry in `predicate.selected_range_identities`, `meta.block_identity_by_mid[mid] == entry.block_identities`, and `selected_range_identities` is non-empty. `always` because it is a precondition on every commit.
Fault/timing angle: The whole model-run window, which is minutes. A harness can edit, retract, or re-stamp a message while the producer runs. The fingerprint alone would not catch a same-length content edit; the module header says so explicitly (`historian.rs:141-143`).
Required faults and enabling state: A configured model chain, a fired run, and a store mutation to `block_identity_by_mid` for one selected mid during the await. The existing tests use a commit hook to do exactly this, which is the seam to reuse.
Confidence: high — [evidence](../evidence/publish-fence-rejects-selected-content-drift.md). Read the fence at `mc-store:9413-9425` and confirmed the empty-vector rejection is separate from and prior to the per-mid comparison, with the reasoning at `:9409-9412`.
Existing check: `historian.rs:2323`, `:2369`, `:2942`, `:3776` `reattach_fingerprint_mismatch_recovers_to_idle_and_releases_routes`. Status `unaudited`.
Impact: Without it, a summary of text the user has since changed or retracted would replace the changed text.
Open questions:
- The fence covers only mids inside the pinned chunk range. A message just past the range can change freely, and `tail_identity_extension_during_await_still_publishes` shows an extension is deliberately permitted. Whether that is safe depends on the validated end boundary, which is the sibling validation lens's question. Unresolved, needs cross-lens reconciliation.

### publish-admits-awaiting-producer-phase-at-commit

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `mc-store/src/lib.rs:18221` `publish_historian_chunk_fails_loud_from_non_publish_state` proves some phases are refused, but no test pins which phases are admitted, and no test asserts a committed publish was preceded by a `Validating` transition.
Guarantee: Every committed publish was preceded by a durable `Validating` then `Publishing` transition for the same `firing_seq`.
Check: `always` — at the instant of commit, `meta.historian.state == Publishing`. `always` rather than `unreachable`, because the thing to forbid is a state at the commit point, not the execution of a code location: the guard at `mc-store:9389-9396` is one expression covering both admitted phases and cannot be marked as a forbidden location.
Fault/timing angle: None needed. The gap is static: the store admits `AwaitingProducer` as well as `Publishing`, so the `Validating` phase is not enforced where it matters.
Required faults and enabling state: A configured model chain plus a caller that reaches `publish_historian_chunk` from `AwaitingProducer`. `publish_output_from_awaiting` always transitions first (`historian.rs:1706-1707`), so today the coverage check is on the preconditions: the store's phase guard admits two phases, and the module has more than one publish route (`historian.rs:527-530`, plus two fence implementations at `lib.rs:3296` and `:3332`).
Confidence: medium — [evidence](../evidence/publish-admits-awaiting-producer-phase-at-commit.md). The widening is verified by reading `mc-store:9389-9396`. What is not established is whether any current caller exercises it; I found no in-repo caller that does, and I could not rule out an external consumer of the public `mc-store` API.
Existing check: `mc-store/src/lib.rs:18221`. Status `unaudited`.
Impact: The documented five-phase machine (`historian.rs:1-6`) and the "fail-closed before any database write" claim (`historian_validate.rs:1-9`) both rest on validation preceding publish. The commit point does not check that. A future or external caller that skips `validation_ok` publishes unvalidated model text through the same gates.
Open questions:
- Is admitting `AwaitingProducer` deliberate, for example to support a recovery path that has not been written yet, or is it a leftover? Nothing in the code or comments explains it. (needs human input)

### crash-before-publish-commit-refires-without-partial-state

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:4596` `restart_mid_awaiting_exposes_reattach_ids` and `:4647` `restart_mid_publishing_with_committed_tx_detects_idle` cover the two load outcomes with a simulated restart; neither uses a real process kill. Not run in CI.
Guarentee placeholder removed.
Guarantee: A crash at any point before the publish transaction commits leaves no compartment rows, no transcript rows, and no raised floor, and the next load makes the session refire-eligible rather than stuck.
Check: `always-or-unreached` — if a restart observes `state in {Firing, Validating, Publishing}`, then no compartment appended by that `firing_seq` exists and the load transitions the row to `Idle` with a backoff; if it observes `Idle`, the publish either committed or never fired. `always-or-unreached` because a crash in this window is an optional event that a campaign may not produce, and the property must hold whenever it does.
Fault/timing angle: Four distinct windows: between the fire persist and the producer start, between the start and the output, between the `Validating` persist and the `Publishing` persist, and between the `Publishing` persist and the transaction commit. The last is the dangerous one and is the one `handle_restart_load` reasons about at `historian.rs:616-619`.
Required faults and enabling state: A configured model chain, a fired run, and a process kill in each of the four windows, then a restart that runs `maybe_spawn_reattach` (`lib.rs:4614-4806`).
Confidence: high — [evidence](../evidence/crash-before-publish-commit-refires-without-partial-state.md). Verified that `Publishing` is a separate transaction from the publish (`historian.rs:1707` versus `mc-store:9360`), that the publish CAS uses the version that transition wrote (`historian.rs:1719`), and that `handle_restart_load` abandons all three pre-commit phases (`:648-653`).
Existing check: `historian.rs:4596`, `:4647`, `:3776`. Status `unaudited`.
Impact: A stuck `Publishing` row would block every future fire for the session, because `fire` refuses any non-idle phase. The abandon-on-load is the only thing that unwedges it.
Open questions:
- `handle_restart_load` for `AwaitingProducer` with missing producer ids abandons (`historian.rs:630-639`), but `MissingProducerIds` is also a `publish_predicate` error (`:377-381`). Whether the two paths agree on what a partially written `AwaitingProducer` row means is unresolved, needs a targeted test.

### uncertain-producer-start-authorizes-a-second-billable-run

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `historian.rs:3389` `unconfirmed_cancellation_stops_the_fallback_chain` and `:3444` `uncertain_cancel_send_outcomes_stop_the_fallback_chain` cover the symmetric protection on the output path. No test covers a start failure carrying `OutcomeUnknown`.
Guarantee: Producer runs started for one firing are bounded: observed runs are at least the number of starts that returned a run id, and at most the number of `start` calls made.
Check: `always` with per-identity accounting — per `firing_seq`, `acknowledged = count(starts returning a RunHandle)` and `attempted = count(start calls)`; assert `acknowledged <= observed provider runs <= attempted`, and separately assert `acknowledged <= 1` because the loop returns after the first successful publish (`historian.rs:1456-1462`). The per-identity form is primary because aggregate totals cancel across models in one chain; the bounds are the cheap screen. `always` because the accounting must hold on every drive.
Fault/timing angle: A `start` call whose send outcome is `OutcomeUnknown` (`historian_producer.rs:80`), meaning the request may have reached Broca and begun a run whose id the module never learns.
Required faults and enabling state: A configured model chain with at least two models, and a producer double that fails the first `start` with a transient-classified error carrying `OutcomeUnknown`, then succeeds on the second. The oracle counts runs at the fake, not in the module.
Confidence: high — [evidence](../evidence/uncertain-producer-start-authorizes-a-second-billable-run.md). Read `historian.rs:1290-1329` and confirmed there is no `cancel`, no outcome inspection, and no `cancellation_confirmed_stopped` call on that branch, while `:1401` requires exactly that proof on the output branch. Confirmed `decide_producer_failure` (`:1052-1143`) never reads the send outcome, and neither does `heuristic_decision` (`historian_producer.rs:412-433`).
Existing check: `historian.rs:3389`, `:3444`, `:3498` `a_terminal_cancel_error_never_authorizes_fallback`. All cover the output branch only. Status `unaudited`.
Impact: Duplicate spend and a duplicate provider run, not a duplicate publish. The orphaned run's output is never drained because its id is unknown, and the second attempt fires under a new `firing_seq` (`historian.rs:257`) with its own producer session id (`:1013-1035`), so only one publish can commit. The cost is money and provider load, plus a live run the module cannot cancel.
Open questions:
- The asymmetry may be deliberate, on the grounds that a start with no run id cannot be cancelled anyway. If so, the mitigation is to refuse fallback on `OutcomeUnknown` rather than to cancel. Needs a design decision. (needs human input)

### publication-floor-never-outruns-appended-coverage

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:2309` and `:4199` assert the floor equals a specific value after a publish, and `:2360` and `:3006` assert it stays `None` after a rejection. No test relates the floor to the appended compartment ends generally. Not run in CI.
Guarantee: After any publish, the publication floor is at most one past the highest appended compartment end, and it never decreases.
Check: `always` — after every committed publish, `meta.publication_floor_ordinal <= MAX(end_message) + 1` over all compartments for the session, and `floor_after >= floor_before`. `always` because it constrains every post-publish state.
Fault/timing angle: None for monotonicity, which is structural via the `max` at `mc-store:9484-9488`. The upper bound depends on validation producing `unprocessed_from = last_new_end + 1` after discard-last healing (`historian_validate.rs:638`), so the interesting case is a healed batch where the last emitted compartment was popped (`:539-556`).
Required faults and enabling state: A configured model chain and an accepted publish whose last compartment was discarded by boundary healing, which needs at least two compartments and a lookahead distance within `BOUNDARY_HEALING_SLACK` (`historian_validate.rs:19`, applied at `:554`).
Confidence: high — [evidence](../evidence/publication-floor-never-outruns-appended-coverage.md). Traced the floor from `historian_validate.rs:638` through `historian.rs:1725` and `:523` to `mc-store:9484-9488`, and confirmed the empty-compartment rejection at `historian_validate.rs:487-491` and the forward-progress check at `:625-635` together prevent a floor advance with no appended coverage.
Existing check: `historian.rs:2309`, `:2360`, `:3006`, `:4199`. Status `unaudited`.
Impact: A floor past the covered range would make messages in the gap ineligible as boundary candidates (`boundary.rs:1417-1426`) and ineligible for tool-arc fencing (`:1339-1357`) while no compartment summarizes them. They would still be served verbatim, so this is a boundary-quality defect rather than data loss.
Open questions: None.

### publication-floor-advances-only-on-publish

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — the emergency re-run at `lib.rs:8490-8501` depends on this claim and `historian.rs:2360` and `:3006` show a rejected run leaves the floor untouched. No test enumerates the write sites. Not run in CI.
Guarantee: `meta.publication_floor_ordinal` changes only as part of a committed publish transaction; no abandon, sync, import, or recovery path moves it.
Check: `always` — between two observations of the store, if `publication_floor_ordinal` changed then the number of committed publishes for that session increased. `always` because the emergency arm's correctness rests on it at every pass.
Fault/timing angle: The emergency arm reads the floor before and after each of its four arms (`lib.rs:8346`, `:8395`, `:8421`, `:8447`, compared at `:8493`) precisely to detect a publish that interleaved with the request. A false positive costs one redundant transform re-run; a false negative serves pre-fold bytes at emergency pressure.
Required faults and enabling state: A configured model chain, an emergency-band pass, and a concurrent firing that abandons rather than publishes, which must not trip the detector, plus one that publishes, which must.
Confidence: high — [evidence](../evidence/publication-floor-advances-only-on-publish.md). Grepped every `publication_floor_ordinal` occurrence in `mc-store/src/lib.rs`; the only production assignment is `:9484-9488`, and the abandon path rebuilds only `HistorianDurableState` (`historian.rs:353-360`), which lives under `meta.historian` and cannot touch the sibling field. The comment at `lib.rs:8484-8486` states the intent and the reason row-version advancement is not used instead.
Existing check: `historian.rs:2360`, `:3006`. Status `unaudited`.
Impact: If another write site appeared, the emergency arm would either loop on spurious re-runs or silently return pre-fold bytes at 95 percent context fill, which is where raw forwarding risks provider overflow.
Open questions: None.

### wrapup-rounds-require-observed-boundary-advance

Type: liveness
Reachability: explicit-config-only
Status: active
Exercised: not yet — the `lib.rs` test module contains wrapup tests, but I found none that asserts the no-advance break at `:6982-6989` or that the loop terminates within the budget. Not run in CI.
Guarantee: A wrapup drain either advances the maximum compartment end ordinal on every counted round or stops with a retryable failure, and it terminates within the request budget.
Check: `always` on the per-round progress condition plus a bounded liveness check on termination: after `MAX_WRAPUP_REQUEST_BUDGET` (3800 s, `historian.rs:962`) the handler has returned a response, and for every counted round `after_end > before_end`. The bound is stated in the unit the code bounds, a wall-clock budget re-checked before each round (`lib.rs:6831-6834`), because there is deliberately no round-count cap.
Fault/timing angle: The loop has no round cap by design, so its only ceiling is the deadline. A producer that publishes an empty-progress fold, or a repeated fence rejection with no cooldown (`historian.rs:533-547`), are the two shapes that could spin.
Required faults and enabling state: A configured model chain, a session with several chunks left to drain, and a producer double that publishes a fold which does not advance the boundary. Run under a compressed budget so the test finishes; the budget is a constant, so the test must inject the deadline rather than wait 3800 s.
Confidence: medium — [evidence](../evidence/wrapup-rounds-require-observed-boundary-advance.md). The progress check and the break are verified at `lib.rs:6977-6989`, and the deadline re-check before each round is verified at `:6831-6834` and `:5481-5487`. What I did not verify is that every `continue`-shaped path in the loop re-checks the deadline; the loop body is inside a 539-line method and I traced the documented arms rather than all of them.
Existing check: none found for the no-advance break.
Impact: A drain that neither advances nor stops holds a `session.wrapup` request open for the whole budget and repeatedly spends model calls. The fence-rejection path is the specific worry because it deliberately arms no cooldown.
Open questions:
- Can a fence rejection with no cooldown (`historian.rs:533-547`) recur every round until the budget expires, or does the snapshot generation stabilize? Unresolved, needs a test that holds the transform-snapshot generation moving while a wrapup drains.

### reattach-publishes-a-chunk-recomputed-after-the-model-ran

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:2881` `reattach_terminal_redrains_from_start_without_second_send`, `:3138` `reattach_redrains_full_run_from_start`, and `:4533` `reattach_carries_durable_revert_epoch_to_publish` cover the reattach publish. None compares the published `raw_chunk_messages` against what the producer actually summarized. Not run in CI.
Guarantee: On the reattach path, the transcript and original messages stored beside a compartment describe the same message range the model summarized.
Check: `always` — for a reattach publish, the inflated `raw_messages_deflate` contains exactly the non-synthetic messages in `[chunk.start_index, chunk.end_index]` as they existed when the producer's prompt was built. `always` because a stored original that does not correspond to the stored summary defeats the recoverability property.
Fault/timing angle: The reattach rebuilds the chunk, the transcript, the raw messages, and the fingerprint from the **current** request's projection (`lib.rs:4696-4725`), minutes after the producer received the old chunk text. The identity fence (`mc-store:9418-9425`) pins content for mids inside the pinned range, and `tail_identity_extension_during_email` (see `historian.rs:2369`) shows a tail extension is deliberately permitted, so the recomputed range can be a superset.
Required faults and enabling state: A configured model chain, a restart or process handoff leaving an `AwaitingProducer` row, and a transform request whose projection has grown past the pinned `chunk_range.to_ordinal` before the reattach publishes.
Confidence: medium — [evidence](../evidence/reattach-publishes-a-chunk-recomputed-after-the-model-ran.md). The rebuild is verified at `lib.rs:4692-4725`, and the pinned range at `historian.rs:645` and `:1529-1530`. What I could not settle is whether `build_historian_chunk` called with `range.to_ordinal + 1` as its exclusive end (`lib.rs:4701`) can ever return a `chunk.chunk.end_index` beyond the pinned end, which is what would make the raw payload a superset. That needs a test, not more reading.
Existing check: `historian.rs:2881`, `:2942`, `:3138`, `:4533`. Status `unaudited`.
Impact: A stored original that is wider or narrower than the summary makes the durable full-message recovery misleading rather than absent, which is worse: an expand would return messages the summary does not describe.
Open questions:
- Does the reattach path's differing `sequence_offset` and `validate_options` (`lib.rs:4760-4768`) change which range is kept, relative to what the fresh path would have kept for the same chunk? See the contract-vs-code leads below. Unresolved.

## Contract-vs-code leads

1. **The documented five-phase machine is not enforced at the commit point.**
   `historian.rs:1-6` names `validating` as a phase the pipeline passes through,
   and `historian_validate.rs:1-9` says validation resolves everything "before
   any database write is possible". The publish transaction admits
   `HistorianPhase::AwaitingProducer` as well as `Publishing`
   (`mc-store:9389-9396`), so the commit point does not require that a
   validation ever happened. Captured as
   `publish-admits-awaiting-producer-phase-at-commit`.

2. **The store, not validation, assigns the compartment sequence.**
   `to_stored_compartment` copies the validated sequence onto the row shape
   (`historian.rs:38-45`) and its doc says "publication stamps the row"
   (`:35-37`). `append_compartments_tx` ignores that field and assigns
   `MAX(sequence) + 1 + index` at write time (`mc-store:12618`, `:12654-12656`,
   `insert_compartment_tx` signature at `:12352-12357`). The validated sequence
   is not dead, though: `to_store_event` uses it to resolve a side-channel
   event's `compartment_id` (`historian.rs:87-88`), as do the primer and
   user-observation projections (`:102-104`, `:128-130`). So an event's
   `compartment_id` is derived from `validate_options.sequence_offset` while the
   row it names is numbered by the store. The two agree only while sequences stay
   contiguous. They are contiguous today, because the only partial delete is a
   suffix revert (`mc-store:9110`), but the coupling is undocumented and the two
   call sites derive the offset differently: assembly uses
   `MAX(sequence) + 1` (`historian_chunk.rs:758-763`) and reattach uses
   `prior_compartments.len() + 1` (`lib.rs:4761`). Not raised to a record
   because I could not construct a non-contiguous state; recorded here so the
   synthesis pass can decide.

3. **`HistorianReattachRequest::publication_floor_ordinal` is written and never
   read.** `lib.rs:4769` sets it to `range.to_ordinal`, and the field is declared
   at `historian.rs:931`, but `reattach_historian_producer` builds its
   `PublishOutputRequest` without it (`historian.rs:1592-1610`) and the floor
   actually published is `validated.unprocessed_from` (`:1725`). A reader would
   reasonably conclude the reattach path publishes a floor of `to_ordinal`. It
   does not.

4. **"A publish never mutates cached render state" is stated twice and holds, but
   only for the store transaction.** `historian.rs:441-443` and
   `mc-store:9345-9350` both make the claim, and the transaction does leave
   `CoreState` and the watermarks alone. The two publication fences do take the
   transform snapshot mutex across the store write (`lib.rs:3304`, `:3341`),
   which is a lock on cached render state, not a mutation. Worth stating in the
   catalog so the claim is not read as "the publish path touches no in-process
   cache".

5. **The ordinary pressure firing publishes with no snapshot fence.**
   `lib.rs:5165-5183` passes `publication_fence: None` and the comment at
   `:5178-5181` justifies it: an organic firing assembles and publishes in one
   continuous drive under the live-session guard. Wrapup and reattach both attach
   a fence (`:6969-6975`, `:4662-4668`). The asymmetry is deliberate and
   documented, but it means the store-side gates are the only protection for the
   most common path, so their sufficiency is load-bearing.

6. **The scope map's CI line reference has drifted.**
   `scope-map-and-risk-ranking.md:414` cites `ci.yml:167-168` for `cargo test -p
   mc-module --test lifecycle_cli`. At this `HEAD` that step is
   `.github/workflows/ci.yml:171-172`. The substance is unchanged: it is still
   the only `mc-module` test invocation in the workflow set, so none of the 51
   test functions in `historian.rs` and none of the `mc-store` publish tests run
   in CI.

## Open questions

- METHOD.md's `Exercised` field forces a ruling the scope map already flagged
  (`scope-map-and-risk-ranking.md:681`): is a test that exists but never executes
  in CI `partial` or `not yet`? I used `partial — <what it covers>, not run in
  CI` and named the CI gap in every record, so a later ruling can be applied
  mechanically. It affects all twelve records here. (needs human input)
- The commit point lives outside this repository. `tx.commit()` is at
  `../commons/crates/cortexkit-store/src/lib.rs:230`, in a sibling checkout that
  CI provisions as a metadata-only stub (`ci.yml:163-164` runs
  `scripts/provision-rust-ci-stubs.sh`). Whether Part 4a may assert properties
  whose enforcement point is in another repository, and whether the stub means
  even the build does not compile the real wrapper, needs a scoping decision.
  (needs human input)
- Is there a fault-injection seam inside the publish transaction? The
  `#[cfg(test)] after_store_publish` hook (`lib.rs:3292-3293`, fired at
  `:3311-3319`) runs after the store call returns, so it cannot land between the
  compartment append and the row-version bump. Every atomicity record here is
  therefore currently unfalsifiable by a Rust test. Unresolved, needs either a
  store-level seam or a SIGKILL harness.
- Can two publishes commit for one session across two processes? The single-writer
  lease is acquired before the file is opened
  (`../commons/crates/cortexkit-store/src/lib.rs:265-277`) and every transaction
  re-checks the writer epoch (`:211-218`), which should make it impossible. I did
  not verify the lease's own liveness, for example what happens when a lease
  holder is SIGKILLed. That is Part 2a territory; noting the dependency.
- The reattach path passes `in_emergency: false` and
  `force_keep_last_compartment: false` (`lib.rs:4762`, `:4767`) regardless of the
  original firing's options, while the fresh path derives both from live config
  and chunk lookahead (`lib.rs:5137-5139`, `:5273-5275`). Discard-last healing
  therefore behaves differently on recovery than on the original attempt. Whether
  that changes the published range is a validation question and belongs to the
  sibling lens; flagged here because the ordering consequence is mine.
