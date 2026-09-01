# cli-a-partial-quarantine-is-detectable-and-resumable

## Discovery trigger

METHOD.md's effect-accounting rule applies wherever an operation can partly
complete. `doctor reset-db` moves four files plus a marker, so an interruption
between any two of them is possible, and the task asks whether a partially
completed destruction is detectable. This is the one place in sub-part 5d where
the answer is a clean yes, so the record exists to pin the guarantee before a
future change erodes it, and to name the one gap its authors documented.

## Evidence trail

**Publication precedes the first move.** `runResetDb` builds the marker at
`doctor-reset-db.ts:629-635` from the post-confirmation reclassification and
plan, writes it at `:637`, logs the path at `:645`, and only then calls
`executeQuarantine` at `:646`. The file header states the ordering and why:
`:5-12`, "The reset marker is published BEFORE the final holder inspection and
binds the database incarnation plus dev/inode of every family file... so an
interruption at any point leaves either the original family plus a pending
marker (resumable) or a complete quarantine."

**The marker binds identity, not content.**
`captureDatabaseFamilyIdentities`
(`packages/plugin/src/features/magic-context/storage-format-epoch.ts:505-521`)
records `{role, dev, ino, sizeBytes}` per existing file in move order, refusing
anything that is not a regular file (`:510-514`).
`buildDatabaseResetMarker` (`:560-583`) validates the incarnation id, the
creation time, both paths, and the identity list, then digests the whole tuple.
`sizeBytes` is explicitly annotated at `:482-483` as reported to the operator and
"never used for identity checks."

**Move order puts the main file last.**
`DATABASE_FAMILY_MOVE_ORDER` is `["rollback-journal", "wal", "shm", "main"]`
(`:455-460`), described at `:454` as "rollback journal and sidecars before the
main file". `executeQuarantine` iterates it at `doctor-reset-db.ts:292`.

**Every move is re-guarded.** Inside the loop, before each rename:
`inspectHoldersSafely` at `:293`, `verifyResetMarkerFamily` at `:294`, holder
refusal at `:295-297`, verification-problem refusal at `:298-302`. After the
loop the same pair runs again at `:331-340`, and the marker's own identity is
re-read and digest-compared at `:341-349` before it is moved at `:353-358`.

**Resume is a distinct branch.** `:309-318` handles
`fileCheck.status === "moved"`: it re-asserts the quarantine directory and the
destination mode, logs "Already quarantined <role>; resuming.", and continues.
So a second invocation completes rather than restarting.

**The verification is a four-way per-role status.**
`verifyResetMarkerFamily` (`storage-format-epoch.ts:857-930`) walks the same
move order and, per role, lstats source and destination. Present at both is
`mismatch` plus a problem (`:893-896`); present at neither is `missing` plus a
problem (`:899-904`); a dev/inode difference is `mismatch` with both recorded and
found identities in the message (`:906-913`); otherwise `at-source` or `moved`
(`:914`). An unrecorded file appearing at either path is collected into
`unexpectedFamilyFiles` with its own problem (`:880-892`). An lstat error sets
`inspectionComplete = false` (`:873-878`).

**Rollback happens only when nothing moved.** `refuseQuarantine`
(`doctor-reset-db.ts:208-255`) removes the marker only when
`!verification.anyMoved && verification.inspectionComplete` (the inverse of
`:222`), and even then re-reads the marker and compares its digest first
(`:229-234`) before `rmSync` at `:236`. Otherwise it tells the operator the
quarantine remains pending at the destination and returns `refused` (`:222-228`).

**The pending marker blocks bootstrap.** `classifyDatabaseFormatFamily` pushes a
reason when the `reset-marker` artifact is present (`storage-format-epoch.ts:340-342`),
`classifyPreOpenFamily` refuses outright (`:396-404`), and `doctor.ts:46-51`
refuses to run any doctor while the marker exists. So a partial quarantine
cannot be silently ignored by the next process.

## Failure scenario

The guarantee holding is the good case. The failure to imagine is its erosion:
suppose a future change publishes the marker after the first move, or moves the
main file first. Then a kill between the main-file rename and the marker write
leaves `context.db` absent, `context.db-wal` present, and no marker.
`inspectDirectDatabaseFamilyState` would classify that as
`{state: "unsupported", family: "orphan-artifacts"}`
(`database-access.ts:310-320`), `classifyPreOpenFamily` would refuse the family,
and `doctor reset-db` would offer to quarantine the orphan sidecar with no
mention of the main file already sitting in the quarantine directory. That is
precisely the state `doctor repair-db` can reach today; see
`cli-a-repair-db-activation-is-self-describing`.

## Timing windows and dependencies

- The window is `:637` (marker write) to `:362` (marker finalisation), spanning
  four renames.
- Each rename is atomic because source and destination share a directory: the
  quarantine path is `${dbPath}${DATABASE_QUARANTINE_DIR_INFIX}${stamp}`
  (`:101`, infix at `storage-format-epoch.ts:450`), a sibling of the database.
  `:9-11` states the reliance on same-filesystem atomicity.
- **The documented gap.** `verifyResetMarkerFamily` compares dev/inode only, and
  `storage-format-epoch.ts:838-856` gives a full argument for not comparing size:
  the identities are captured before the final holder inspection, so a recorded
  size is a pre-exclusivity observation, and a WAL checkpoint truncating to zero
  would produce spurious refusals that abandon a live family. The consequence is
  stated in the same block: closing the inode-reuse gap "needs content identity,
  which this marker does not record." `doctor-reset-db.ts:614-622` names the
  same gap from the caller's side and is why `:623` reclassifies after the
  prompt.
- Dependency on the pending-marker refusal: if `classifyPreOpenFamily` stopped
  refusing a `reset-marker` family, an interrupted reset would become
  bootstrappable and the resume would then race a fresh database.

## What a test must construct

The suite already constructs most of this; the residue is one case.

1. Existing coverage, all at `ci.yml:257`:
   `doctor-reset-db.test.ts:290-322` injects a `renameFile` failure immediately
   after publication and asserts resumability; `:323-369` crashes after each
   family move and asserts idempotent resume; `:370-408` replaces a sidecar
   between moves and asserts the quarantine aborts with the file preserved;
   `:409-464` introduces a holder after the initial inspection; `:465-494`
   replaces family identity after confirmation; `:735-767` asserts a rival
   reset's marker is untouched.
2. The gap: interrupt between the final family move at `:328` and the marker
   move at `:353`. `ResetDbDeps.renameFile` (`:53-58`) is injectable, so a stub
   that succeeds four times and throws on the fifth call reaches it. Assert the
   marker still exists at `databaseResetMarkerPath(dbPath)`, that
   `verifyResetMarkerFamily` reports `moved` for all four roles with `problems`
   empty, and that a second `runResetDb` completes to `RESET_DB_EXIT.ok` moving
   only the marker.
3. A property-style variant worth considering: for `k` in 0..4, stub
   `renameFile` to throw on call `k+1`, then assert for every `k` that a second
   invocation reaches `ok` and the quarantine directory ends with all five
   entries. That is the guarantee as stated, checked at every interruption point
   rather than at the four the suite picked.

## Investigation log

### Q: Does any test kill the process between the last family move at `:328` and the marker finalisation at `:353`?

- Sources examined: `doctor-reset-db.test.ts:144-767` in full for the scenario
  names; `:323-369` (scenario 5, "crash after each family move resumes
  idempotently"); `:465-494` (scenario 7); `doctor-reset-db.ts:328` (the last
  in-loop log), `:331-349` (post-loop re-verification and marker identity
  check), `:350-361` (marker chmod and move).
- Findings: scenario 5 iterates the family moves, so it covers interruptions at
  the four family renames. The marker move is the fifth rename and is covered
  only indirectly: `:341-349` is asserted by changing the marker's identity, which
  produces `reportInterruptedMove` with the role string "reset marker", not by
  interrupting the rename itself. So the state "all four family files moved,
  marker still at source" is reached by the code but not asserted by a test.
- Missing evidence: whether `moveIntoQuarantine`'s `restrictAfterMove = false`
  argument for the marker (`:357`) matters at resume — the resume branch chmods
  the destination to 0600 unconditionally at `:312`, while the marker was
  deliberately not restricted after its move. Worth an assertion either way.
- Conclusion: unresolved, needs a targeted case that throws on the fifth
  `renameFile` call and then re-runs.

### Q: Can an inode-reuse replacement defeat the verification, and if so how far?

- Sources examined: `storage-format-epoch.ts:838-856` (the size-comparison
  rationale), `:908-916` (the dev/inode check), `doctor-reset-db.ts:614-622`
  (the caller-side note), `:623-627` (the post-confirmation reclassification).
- Findings: the gap is real and bounded. For a replacement to pass verification
  it must reuse the same dev and inode for a recorded role, which means the
  replacement happened at the same path on the same filesystem with the inode
  recycled. The mitigation is not in the verification at all: it is `:623`,
  which reclassifies and recaptures immediately before publication so the marker
  binds the family as it exists after the prompt closes, leaving only the
  `:623`-to-`:637` window. The comment at `:617-620` says exactly this.
- Missing evidence: no test constructs an inode-reuse replacement; doing so
  portably is difficult, which is presumably why the code closes the window
  rather than detecting the case.
- Conclusion: resolved with answer — the gap exists as documented, is narrowed
  to the `:623`-to-`:637` window by design, and is not a defect in this record's
  guarantee. Recorded here so a future reader does not mistake the deliberate
  omission of size comparison for an oversight.
