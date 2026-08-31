# outbox-b-authority-write-fence-covers-notes-but-not-claim-tables

## Discovery trigger

`hook.ts:930-937` throws `authority_draining` when the module does not report
`MODULE` for the memories domain, which reads like a fence. Checking what
enforces the same rule at the database boundary turned up three triggers, all of
them on `notes`.

## Evidence trail

**The database-level fence, in full.**
`packages/plugin/src/features/magic-context/storage-session-runtime-schema.ts`
declares exactly three authority guard triggers:

- `:1190` `CREATE TRIGGER notes_authority_guard_insert`
- `:1208` `CREATE TRIGGER notes_authority_guard_update`
- `:1239` `CREATE TRIGGER notes_authority_guard_delete`

Each raises `'context.db note writes are managed by the Rust module'`
(`:1206`, `:1237`, `:1255`). Each fires when the project or the session's project
has a row in `authority_managed` or `authority_repair_pending`, and each stands
down when `context_privilege_state.enabled` is 1 (`:1205`, `:1236`, `:1254`).

`rg` for `authority_managed` across the repository, excluding `node_modules`,
`dist`, and `*.test.ts`, returns ten hits in this schema file: the table
definition at `:870-874`, one entry in the table-name list at `:35`, and eight
references inside the three triggers. It returns zero hits in
`storage-claim-memory-schema.ts`. No claim table is named by any authority guard.

**The authority tables themselves carry no triggers.**
`:870-874` and `:876-879`:

```
870 CREATE TABLE authority_managed (
871                     project_path TEXT PRIMARY KEY,
872                     context_store_uuid TEXT NOT NULL,
873                     marked_at INTEGER NOT NULL
874                 );
875
876 CREATE TABLE authority_repair_pending (
877                     project_path TEXT PRIMARY KEY,
878                     started_at INTEGER NOT NULL
879                 );
```

Plain tables. The functions that write them wrap in `withPrivilegedWriter`
(`context-authority.ts:522`, `:530`, `:536`, `:544`, `:601`, `:745`), but that
wrapper's purpose is to set the flag *other* tables' triggers consult — its own
doc comment says the privilege "is recorded in the durable
`context_privilege_state` table (row id=1, enabled=1) so the guard triggers —
which reference that table, never a connection-local UDF — stand down for this
connection's writes" (`shared/sqlite.ts:318-328`). Wrapping a write to an
unguarded table in that scope changes nothing about who may perform it.

**The claim lane's only gate is a once-per-operation remote read.**
`packages/plugin/src/hooks/magic-context/hook.ts:917-937`:

```
917 const marker = readDirectFormatMarker(db);
918 if (marker.status !== "present") { ... }
921 if (!rustModeModuleClient.authorityStatus) { ... }
924 const status = await rustModeModuleClient.authorityStatus({
925     context_store_uuid: ensureContextStoreUuid(db),
926     project: projectPath,
927     projectRoot,
928     domain: "memories",
929 });
930 if (status.authority?.state !== "MODULE") {
931     throw Object.assign(new Error("memory authority is not accepting intents"), {
934         code: "authority_draining",
```

Everything after this — `commitModuleClaimIntent` at `:950`, the context commit
inside it (`context-authority.ts:207`), `settleContext` (`:264`), the drain
(`hook.ts:974-988`), and the checkpoint advance
(`module-state-sync.ts:2328-2345`) — runs without re-reading authority state,
local or remote.

**A second process can change authority mid-flight.**
`packages/cli/src/commands/doctor-authority.ts:173-227` runs `drainAuthority`
from the CLI against the same database and the same module. On success the marker
is removed (`context-authority.ts:1119-1130`).

**Two identities cross the same wire for the same purpose.** The authority call
passes `context_store_uuid` from `ensureContextStoreUuid`, which mints
`randomUUID()` (`context-authority.ts:445-457`). The claim binding passes
`databaseIncarnationId` from the format marker (`hook.ts:958`), which is 32-hex.
Part 3's `intent-control-transition-write-is-silently-dropped` is precisely a
confusion between these two identities on the Rust side.

## Failure scenario

**The trigger gap.** Any code path that writes a claim row without first
performing the `hook.ts:924` check writes state the module believes it owns, and
no trigger stops it. The `notes` equivalent would be refused with a clear error.
Since the claim tables carry their own append-only triggers
(`storage-claim-memory-schema.ts:412-456`), the write would be well formed and
durable; it simply would not be the module's.

**The timing window.** An operator runs `doctor drain-authority` while a memory
mutation is in flight. `hook.ts:924` already returned `MODULE`. The intent stages,
the context commits, `settleContext` delivers the receipt, and the checkpoint
advances — all against an authority that has been drained. The producer records
the effects as delivered to `rust-module-claims-v1`, and the module that received
them is being taken out of the ownership path. The checkpoint is irreversible
(`outbox-b-checkpoint-advance-is-the-point-of-no-return`), so those effects are
never re-delivered to whatever owns memories next.

The staging call itself is fenced on the Rust side — Part 3 established that
`claim_intent_stage_fence` resolves the live authority from the bound route and
refuses anything not in `MODULE`. So the window is narrower than it looks: the
stage would fail if the drain landed first. What is not fenced is the interval
between a successful stage and the checkpoint advance.

## Timing windows and dependencies

- Window one: structural, no timing. The trigger gap.
- Window two: between `hook.ts:924` returning and
  `module-state-sync.ts:2345` committing. Spans a context commit, at least two
  module round trips (`claimIntentAck` at `context-authority.ts:244`, the
  delivery at `module-state-sync.ts:2322`), and a local transaction.
- Depends on Part 3 for the Rust-side stage fence, which bounds the window.

## What a test must construct

1. Install an `authority_managed` row for a project. Attempt an unprivileged
   insert into `claims` and into `claim_operation_effects`. Assert the outcome. If
   both succeed, the trigger gap is proven with no timing at all.
2. Positive control: the same attempt against `notes`, asserting
   `'context.db note writes are managed by the Rust module'`. That isolates the
   missing triggers rather than some ambient protection.
3. For the window: stage an intent successfully, then remove the marker and drive
   the module to a non-`MODULE` state before `settleContext` runs. Assert whether
   the delivery and the checkpoint advance still complete. Use the injected-cut
   harness shape at `context-authority-crash.test.ts:330-370`, which already
   interposes at exactly these points.
4. Coverage-check form:
   `CLAIM_CHECKPOINT_ADVANCED_WITHOUT_REVALIDATING_AUTHORITY` fires whenever the
   advance commits, since it always does so without a re-read, and
   `AUTHORITY_MARKER_ABSENT_AT_ADVANCE` fires when `authority_managed` has no row
   for the project at that moment. Both fire on a correct implementation; both
   together are the window.

## Investigation log

### Q: Is the claim lane deliberately outside the trigger fence because the claim tables have their own append-only guards?

- Sources examined: the three notes triggers (`:1190-1255`); the claim-memory
  trigger inventory, 28 `CREATE TRIGGER` statements none of which reference
  `authority_managed`; the header comment at
  `storage-claim-memory-schema.ts:22-31`, which frames the claim guards entirely
  as an append-only contract and never mentions authority; `hook.ts:917-937` as
  the only memories-domain gate on this path; Part 3's finding that
  `claim_intent_stage_fence` fences staging on the Rust side using the live
  authority row.
- Findings: the two mechanisms guard different things. The notes triggers answer
  "may this process write notes at all", which is an ownership question. The claim
  triggers answer "is this row shaped legally", which is an integrity question. No
  claim trigger answers the ownership question, and the ownership answer lives
  entirely in the module — where Part 3 confirms it is enforced for staging. So a
  defensible reading is that the module *is* the fence for claims, and the local
  triggers are unnecessary because the local process cannot commit a claim
  operation without a successful stage. Against it: `hook.ts` is not the only
  possible writer of `claims`, and the notes lane got belt-and-braces treatment
  for the same reason.
- Missing evidence: whether any code path writes claim rows without staging. That
  needs a pass over the claim operation writers in
  `storage-claim-operations.ts:1-2100`, which is in this sub-part's file set but
  outside this lens's focus.
- Conclusion: needs human input, with the concrete sub-question above recorded as
  unresolved.
