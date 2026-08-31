# lineage-descent-write-precedes-the-array-validity-guards

## Discovery trigger

Mapping the pure/durable boundary in `apply_once` turned up a `store.` write at
`transform.rs:3312` that sits above the clone at `:4369`. Reading forward from
it showed three hard error returns between the write and the point where the
pass could still be abandoned.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The write:

- `transform.rs:3281` — `if ingress_req.lineage_switched && !ingress_req.is_subagent {`
- `transform.rs:3282-3292` — a shape precheck on the descent fields; a failure
  here returns `lineage_protocol_passthrough` *before* the write, which is the
  correct order.
- `transform.rs:3301` — `let initial_state = store.load(&ingress_req.session_id)?;`
- `transform.rs:3312` — `let outcome = store.descend_lineage(LineageDescentRequest {`
- `transform.rs:3320` — `expected_target_row_version: initial_state.row_version`
- `transform.rs:3321-3331` — a `PendingBuildSkew` disposition returns
  pass-through, but the transaction has already run.
- `transform.rs:3339` — `rebased_req = rebase_descent_ordinals(ingress_req, base)?;`
  This `?` can also return after the write.

`descend_lineage` (`mc-store/src/lib.rs:8177`) is one fenced transaction. It
copies rows into the target key:

- `:8705-8716` — `INSERT INTO mc_compartments ... SELECT ... WHERE session_id = ?2`
- `:8717-8726` — `mc_chunk_transcripts`
- `:8727-8734` — `mc_tags`
- `:8735-8740` — `mc_temporal_marks`
- `:8741-8745` — `mc_user_hints`

and writes `mc_cache_state` with a new `row_version` at `:8312-8331` and
`:8403-8422`.

The guards that run after it:

- `transform.rs:3342` — `let req = rebased_req.as_ref().unwrap_or(ingress_req);`
- `transform.rs:3354-3356` — `if let Some(id) = duplicate_ids(&projection.blocks)
  { return Err(TransformError::DuplicateBlockId(id)); }`
- `transform.rs:3362-3366` — `if item.id().starts_with(RESERVED_ID_PREFIX) {
  return Err(TransformError::ReservedId); }`, with
  `RESERVED_ID_PREFIX = "mc_"` at `:91`
- `transform.rs:3367-3374` — the non-decreasing-ordinal check returning
  `TransformError::OrdinalViolation` at `:3371`

So `descend_lineage` commits 42 to 59 lines before three guards that reject the
same request outright.

The contract this contradicts is on `TransformError` itself,
`transform.rs:1796-1798`: "Each leaves the durable frozen-set UNCHANGED (the
CAS simply does not advance), so the next pass replays the last good state or
busts cleanly". Read narrowly about `core.frozen_units`, the claim survives.
Read as written about durable state, it does not.

Reachability of the enabling flag: the shipped plugin sets it.
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1404` sends
`lineage_switched: args.passInputs.lineage_switched === true`, and the built
bundle carries the same line (`packages/plugin/dist/index.js:35865`). The wire
field is decoded at `transform.rs:994` and `:1068`. The CK array itself is
harness-supplied and decoded through the hand-written `Deserialize` at
`:1009-1077`, so both halves of the trigger come from outside the module.

## Failure scenario

A lineage switch fires on a session whose array also carries a duplicate flat
block id, for example because a harness adapter emitted the same
`mid#block_index` twice. `descend_lineage` commits: the prior session's
compartments, chunk transcripts and tags are now present under the new key and
the new key's `row_version` has advanced. `apply_once` then returns
`DuplicateBlockId`. The handler maps it to a clean error frame
(`lib.rs:8329-8337`, `reject_transform`) and the host serves the raw array. The
user sees no summary. The store now holds a half-completed descent whose
cache-state blobs were written by `descend_lineage`'s own logic rather than by
any accepted transform pass.

## Timing windows and dependencies

No timing window and no fault injection needed. This is straight-line ordering:
the write is unconditionally above the guards.

The recovery question is whether a later, valid request repeats the descent
safely. That depends on `descend_lineage`'s disposition logic and its
`edge_id` handling, which this lens did not read to the depth needed for a
verdict.

## What a test must construct

1. Seed a prior session key with compartments and tags.
2. Build a `TransformRequest` with `lineage_switched: true`, `is_subagent:
   false`, a non-zero `descent_edge_id`, a non-empty `prior_conversation_key`,
   at most five `constituents` whose last `new_key` equals `session_id`, so the
   precheck at `:3282-3292` passes.
3. Put a duplicate flat block id in the array, or a live block whose id starts
   with `mc_`, or two non-synthetic messages with non-increasing ordinals.
4. Snapshot the target key's `row_version`, compartment count and tag count.
5. Call `transform`, assert the expected `TransformError`.
6. Re-read the three values and assert none changed. This is the assertion that
   fails today.

Repeat with each of the three guards to show the window is not specific to one.

## Investigation log

### Q: Does `descend_lineage` treat a repeat of the same `edge_id` as a no-op, so a retry after fixing the array is safe?

- Sources examined: `mc-store/src/lib.rs:8177-8500` skimmed for `row_version`
  writes and disposition arms; `transform.rs:3312-3341`;
  `LineageDescentDisposition` uses at `transform.rs:3321`, `:3334`.
- Findings: the function has multiple dispositions including
  `PendingBuildSkew` and a `materialization_required` signal, and it writes
  `mc_cache_state` in at least three places (`:8312`, `:8403`, and a third at
  `:8480`-ish). A CAS on `expected_target_row_version` is checked at `:8199`.
  That means a *second* call with the stale expected version would conflict, but
  the transform re-loads (`:3301`) on the retry, so it would supply the new
  version and the CAS would pass.
- Missing evidence: the exact disposition returned when the edge has already
  been applied, and whether the row copies are `INSERT OR IGNORE` or plain
  `INSERT` that would duplicate. The `INSERT INTO mc_compartments ... SELECT`
  at `:8705` is a plain insert; whether a duplicate is prevented by a unique
  constraint on `(session_id, sequence)` was not checked.
- Conclusion: unresolved, needs a targeted read of
  `mc-store/src/lib.rs:8177-8500` plus the `mc_compartments` schema. That is
  Part 4a and 4c territory; recorded here as a dependency rather than guessed.

### Q: Is the guard ordering deliberate, so that a descent must happen before the array is validated?

- Sources examined: comments at `transform.rs:3277-3280`, `:3344`, the module
  header `:1-15`.
- Findings: the comment at `:3344` reads "--- ingress: CK messages -> flat
  blocks, then strip synthetic before cache logic ---", which frames `:3344`
  onward as the ingress stage. Nothing explains why a durable descent precedes
  ingress validation. The descent needs `ingress_req` (normalized) and the
  anchor from `initial_projection`, both of which exist by `:3301`, so the
  ordering is not forced by data dependency: the validity guards only need
  `projection`, which is `initial_projection` when `rebased_req` is `None`.
- Missing evidence: no design note anywhere in `docs/` covers the transform;
  the scope map already established there is no transform specification outside
  the source.
- Conclusion: needs human input. Whether the ordering is intentional is a
  design question the code does not answer.
