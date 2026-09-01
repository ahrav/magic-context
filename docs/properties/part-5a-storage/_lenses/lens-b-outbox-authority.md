# Part 5a lens B: the claim outbox and the authority surface

One attention focus: the producer side of the claim-effect delivery contract
whose consumer side Part 4d already catalogs, plus the authority state that
gates it. The sibling lens owns the schema fence, the marker epochs, and
migration; nothing here re-derives them.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`.
Method contract in [../../METHOD.md](../../METHOD.md). Every line reference
below was read back at `HEAD`. Two corrections to inherited references are
noted inline.

Inherited context, cited rather than rediscovered:

- Part 4d, `facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect`.
  The module's `claim.effects.apply` handler never calls `self.store()` and
  returns `ackedEffectId` equal to the last delivered effect id
  (`crates/mc-module/src/lib.rs:10184-10255`, answer at `:10251-10254`). It also
  never compares the `consumer` value against anything (`:10198-10204`), and it
  acks while the store is still opening, when every neighbouring claim handler
  returns `store_unavailable_error` (`:10097-10099`, phase at `:12007-12011`).
  Verified at `HEAD`; all five ranges read back correctly.
- Part 4d also fixes the coverage reality: the Rust half has no test, the
  TypeScript drain is tested against a fake delivery closure, and
  `decodeClaimEffectDeliveryResponse` has no test reference anywhere.
- Part 3, `intent-control-transition-write-is-silently-dropped`. Rust's
  `set_claim_intent_transition_tx` returns `Ok(())` without writing when its
  `database_incarnation_id` argument is not 32 lowercase hex, and all four call
  sites pass `context_store_uuid`, which production mints as a dashed UUID.
- Part 3, the five `mirror-*` records: the claim mirror is a projection whose
  divergence is prevented at admission and never detected afterwards.

## Outbox and checkpoint map

**What an effect is.** A row in `claim_operation_effects`
(`packages/plugin/src/features/magic-context/storage-claim-memory-schema.ts:270-281`).
It carries `receipt_id`, `effect_key`, `project_id`, `claim_id`, an optional
`revision_id`, a `change_kind` drawn from a fixed six-value list, and a
`generation`. The primary key is `INTEGER PRIMARY KEY AUTOINCREMENT`, and the
comment at `:267-269` says why in one sentence: consumer cursors and prune
watermarks compare ids, so an id must never be reused after a full prune empties
the table.

**How an effect is enqueued.** Never directly. Effects are written as part of a
claim operation, inside the same transaction that writes the operation's receipt
into `claim_operation_receipts` (`:245-265`). The receipt records
`expected_effect_count`, and three database triggers make the group immutable
afterwards: updates raise (`:427-429`), key-colliding inserts raise
(`:439-445`), and every effect must bind a claim of the stated project
(`:449-456`). Receipts themselves can never be deleted at all (`:416-418`).

So an effect is a durable, immutable, receipt-grouped fact. The outbox is the
set of effects, and a consumer's position in it is a cursor, not a queue
pointer: nothing is dequeued on read.

**What the checkpoint means.** `claim_outbox_consumer_checkpoints` is keyed
`(consumer, project_id)` and holds one `acked_effect_id`
(`storage-claim-memory-schema.ts:289-297`). Its meaning is defined entirely by
how it is read. Both readers use the same predicate:

- `module-state-sync.ts:1776-1779` (`pendingClaimMirrorReceipt`), and
- `module-state-sync.ts:2261-2263` (`drainClaimEffectPrefix`),

each a `LEFT JOIN ... ON checkpoint.consumer = ? AND checkpoint.project_id =
effects.project_id` with `effects.id > COALESCE(checkpoint.acked_effect_id, 0)`.
An absent row therefore reads as zero, and the checkpoint means exactly: *no
effect at or below this id will ever be selected for this consumer again.*

**Two consumers, one table.** `module-state-sync.ts:1617` defines
`MODULE_CLAIM_MIRROR_CONSUMER = "rust-module-claim-mirror-v1"` and `:1621`
defines `MODULE_CLAIM_EFFECTS_CONSUMER = "rust-module-claims-v1"`. The comment
at `:1618-1620` states the obligation the identity carries: checkpoint
bookkeeping and the delivered request body must name the same consumer, or
checkpoints advance under one identity while the module is told about another.
Part 4d establishes that the module never checks the value it is told.

**The three advance paths.** All three funnel through
`advanceOutboxConsumerCheckpointInCurrentTransaction`
(`memory/storage-claim-operations.ts:2214-2267`).

| Path | Site | Value advanced to |
| --- | --- | --- |
| Mirror seed | `module-state-sync.ts:1760` via `:1728-1741` | each project's `MAX(id)` at snapshot time (`:1710`) |
| Mirror receipt | `module-state-sync.ts:2045` via `:1728-1741` | per-project max of the delivered receipt's effect ids (`:2038-2044`) |
| Effects drain | `module-state-sync.ts:2328-2345` | per-project max of the delivered receipt's effect ids (`:2330-2336`) |

The effects drain is the one `hook.ts` runs on a real mutation. `hook.ts:974-988`
calls `drainClaimEffectPrefix` from inside `settleContext`, with
`consumer: MODULE_CLAIM_EFFECTS_CONSUMER`, `throughReceiptId: proof.receiptId`,
and `deliver` bound to `claimEffectsApply`. `settleContext` itself is invoked by
`commitModuleClaimIntent` at `context-authority.ts:264`, after the intent has
reached `context-committed` and before the final `acknowledged` ack at `:266-281`.

**The guard chain the producer runs before it advances.** In delivery order:

1. `proveClaimOperationDurable` (`module-state-sync.ts:2143-2203`) re-reads the
   receipt and its effects and rejects a count mismatch (`:2156-2158`), a
   repeated effect key (`:2160-2162`), a row that disagrees with the encoded
   result on project, generation, or change kind (`:2163-2172`), and a
   generation the store has not durably reached (`:2182-2195`).
2. The drain re-checks `proof.receiptId` and the expected effect count
   (`:2292-2297`).
3. Every effect in the group must sit strictly above the current checkpoint, or
   the receipt is declared "checkpointed partially" (`:2298-2309`).
4. The ack is compared to the last effect id of the delivered group
   (`:2318-2327`), and the same comparison is made independently in the wire
   decoder (`module-wire.ts:717-735`, mismatch at `:729-733`) using an
   `expectedEffectId` the transport derives the same way
   (`module-transport.ts:1076-1081`).
5. `advanceOutboxConsumerCheckpointInCurrentTransaction` rejects a non-integer
   or negative value (`:2218-2220`), regression (`:2222-2226`), a value beyond
   `MAX(id)` of the whole effects table (`:2237-2245`), and a value that splits
   a receipt group within the project (`:2246-2259`).

That is a genuinely careful producer. The comment at `:2227-2236` even explains
why the tail check exists and why the tail falls back to the existing cursor
rather than zero. What the chain never does is establish that the consumer
retained anything.

**What advancing makes unrecoverable.** Once the upsert at `:2260-2266`
commits, the effects at or below that id are outside both read predicates for
that consumer, permanently. There is no lowering path. A repository-wide search
for the table name returns only the one `SELECT` (`:2201-2202`), the one
`INSERT ... ON CONFLICT DO UPDATE` (`:2260-2266`), the prune aggregate
(`:2305-2309`), and the two drain joins. No `DELETE`, no reset, no downward
`UPDATE`, and no reference at all under `crates/` — the table is
TypeScript-only, which matches the scope map's finding that the outbox has no
Rust counterpart.

## Point of no return

**The point of no return is the commit of the `INSERT ... ON CONFLICT(consumer,
project_id) DO UPDATE SET acked_effect_id = excluded.acked_effect_id` at
`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2260-2266`,
reached through the `db.transaction(...).immediate()` at
`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2328-2345`, which
runs unconditionally on the statement immediately after
`const acknowledged = await args.deliver(delivery)` at `:2322` passes the
equality check at `:2323-2327`.**

Three things make it the point of no return rather than merely a durable write.

1. **It is the first irreversible step.** Everything before it is either a read
   or a rejected write. `advanceOutboxConsumerCheckpointInCurrentTransaction`
   refuses regression at `:2222-2226`, so the same function that performs the
   advance is the function that forbids undoing it.
2. **Nothing else can undo it.** No code in either tree lowers, deletes, or
   rebuilds a row in `claim_outbox_consumer_checkpoints`. Recovery would require
   editing the table by hand.
3. **The information needed to redo the work still exists, but nothing reads
   it.** Receipts and effects survive (`:416-418` forbids receipt deletion, and
   in a shipped install nothing prunes effects at all — see
   `outbox-b-effects-are-never-pruned-in-a-shipped-install`). So the loss is not
   loss of data; it is loss of the *obligation* to deliver it. That is a
   strictly harder failure to notice, because no row is missing.

The window between the module receiving the delivery and the producer committing
the checkpoint is one `await`. A crash inside it is the safe direction: the
checkpoint has not moved, so the next drain re-delivers, and the module's
handler is idempotent by virtue of doing nothing. The unsafe direction is not a
crash at all. It is a successful, well-formed, correctly-numbered ack from a
consumer that retained nothing.

## Cross-language contract

The contract is stated in four places, all of them code comments, and nowhere
else. A sweep of `docs/` for `claim_outbox`, `ackedEffectId`,
`claim.effects.apply`, and `KTD13` returns only this property catalog and one
dry-audit note (`docs/research/dry-audit-2026-08-29/plugin-hooks.md`).
`docs/specs/` holds `context-window-geometry.md`, the git-dedup pair, and
`prompt-surface/`; there is no claim or outbox specification, and no
`direct-claims-cutover` plan under `docs/plans/`. This resolves the scope map's
open question at
`../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:756-761`: the
outbox delivery contract has no source outside the implementation, so every
guarantee in this lens is a claim with no independent authority.

The four statements:

- `storage-claim-memory-schema.ts:22-31` — the append-only contract, and the
  explicit carve-out that `claim_outbox_consumer_checkpoints` is "mutable by
  design".
- `storage-claim-memory-schema.ts:286-288` — "Mutable; monotonicity is enforced
  by `advanceOutboxConsumerCheckpointInCurrentTransaction`". An unusually candid
  admission that the invariant lives in application code.
- `storage-claim-operations.ts:2208-2213` — regression rejected, no advance past
  the tail, no split receipt group.
- `module-state-sync.ts:1618-1620` and `module-transport.ts:1073-1075` — the
  consumer-identity obligation and "the last effect is the delivery checkpoint".

Producer and consumer obligations, side by side:

| Obligation | Producer (TypeScript) | Consumer (Rust module) |
| --- | --- | --- |
| Validate protocol version | outbound pass-through (`module-wire.ts:620-624`) | `lib.rs:10191-10197` |
| Validate consumer identity | names it (`hook.ts:984`) | non-empty only, value never compared (`lib.rs:10198-10204`) |
| Validate effect ids strictly increasing | `:1848-1850` (mirror), `:2298-2309` (effects) | `lib.rs:10225-10250` |
| Prove the group durable locally | `proveClaimOperationDurable` (`:2143-2203`) | not applicable |
| Apply the effects | not applicable | **nothing** (Part 4d) |
| Return an ack | verified twice (`:2323-2327`, `module-wire.ts:729-733`) | echoes the last delivered id (`lib.rs:10251-10254`) |
| Advance the durable cursor | `storage-claim-operations.ts:2260-2266` | no such table under `crates/` |

The asymmetry is total and one-directional. Every check on this contract lives
on the producer side, and every check the producer performs is a check on
*itself* or on a value it supplied. The one fact the checkpoint's meaning
depends on — that the consumer durably applied the prefix — is the one fact
neither side establishes.

## Observations

Each observation is a verified reading, not yet a property.

1. **`storage-claim-operations.ts:2214-2267`.** The advance function's four
   rejections are input validation (`:2218-2220`), regression
   (`:2222-2226`), beyond-tail (`:2237-2245`), and receipt-split
   (`:2246-2259`). All four are unconditional and all four throw. The
   task prompt cites `:2222-2258` for regression and beyond-tail; the
   verified ranges are `:2222-2226` and `:2241-2245`, and `:2246-2259` is
   the third, separate guard. Correction recorded, no substantive change.
2. **`storage-claim-operations.ts:2237-2239`.** The tail query is
   `SELECT MAX(id) AS tail FROM claim_operation_effects` with **no project
   predicate**, while the checkpoint being written is per project. So a high
   effect id in project B licenses a checkpoint in project A up to that id. The
   receipt-split guard at `:2246-2254` *is* project-scoped (`?1` bound to
   `project_id` on both sides), so the two guards disagree about scope. The
   in-code comment at `:2227-2236` explains the tail check's purpose in
   global terms, so this reads deliberate; it nonetheless means beyond-tail is a
   weaker bound than a reader would assume.
3. **`storage-claim-memory-schema.ts:427-456` versus `:289-297`.**
   `claim_operation_effects` carries five triggers, including a delete guard
   that demands the prune capability and an id at or below the recorded
   watermark (`:433-438`). `claim_outbox_consumer_checkpoints` carries **zero
   triggers**, as do the other three tables the fragment calls mutable at
   `:27-30`. Its `CHECK` constraints cover type and non-negativity only.
   Monotonicity is not enforced at the database boundary.
4. **`pruneClaimOperationEffectsInCurrentTransaction` has no production
   caller.** `rg` across the repository, excluding `node_modules`, `dist`, and
   `*.test.ts`, matches only the definition at
   `storage-claim-operations.ts:2289` and its own error string at `:2295`. The
   only callers are seven sites in `storage-claim-operations.test.ts`
   (`:873`, `:889`, `:925`, `:944`, `:994`, `:1079`).
5. **`module-state-sync.ts:2224-2228, 2246-2254`.** In production
   `throughReceiptId` is always supplied (`hook.ts:977`), so `scopedProjectIds`
   is always set to the target receipt's projects, and the drain breaks at
   `:2351` as soon as the target group is delivered. The effects consumer
   therefore only ever acknowledges projects that a mutation touched, and only
   up to that mutation's receipt. Effects in any other project accumulate with
   no checkpoint row at all.
6. **`module-state-sync.ts:1710` and `:1760`.** The mirror seed path sets each
   authorized project's checkpoint to `maxClaimEffectId(db, projectId)` — the
   project's whole tail — and advances to it after
   `decodeClaimMirrorSnapshotResponse` returns. So seeding is a bulk skip of
   every pending effect, justified entirely by the replace being total.
7. **`module-wire.ts:284-286` versus `:550-558`.** The mirror snapshot vector's
   `databaseIncarnationId` is validated `/^[0-9a-f]{32}$/`. The claim intent
   *binding*'s `databaseIncarnationId` is decoded with a bare `wireString` and
   no format check. Same field name, same wire, two different standards.
8. **`hook.ts:917-920` and `:958`.** The producer's binding identity comes from
   `readDirectFormatMarker(db)`, which rejects a marker whose incarnation fails
   `isValidDatabaseIncarnationId` (`storage-format-epoch.ts:222-224`), and that
   predicate is the 32-hex pattern (`:80-82`) over a value minted as
   `randomBytes(16).toString("hex")` (`:74-78`). So the producer supplies a
   valid 32-hex incarnation.
9. **`context-authority.ts:445-457`.** `ensureContextStoreUuid` mints
   `randomUUID()` — dashed, 36 characters. This is the value passed as
   `context_store_uuid` on every `authorityStatus` call (`hook.ts:925`,
   `context-authority.ts:565`, `:585`, `:619`, `:1122`). It is a *different*
   identity from the binding's incarnation, and both cross the same wire.
10. **`storage-session-runtime-schema.ts:1190-1255`.** Three authority guard
    triggers exist, all three on the `notes` table, all three standing down when
    `context_privilege_state.enabled = 1`. `rg` for `authority_managed` in
    `storage-claim-memory-schema.ts` returns nothing. No claim table is fenced
    by the authority marker.
11. **`storage-session-runtime-schema.ts:870-879`.** `authority_managed` and
    `authority_repair_pending` are plain tables with no triggers. The functions
    that write them wrap in `withPrivilegedWriter`
    (`context-authority.ts:522`, `:530`, `:536`, `:544`, `:601`, `:745`), but
    that wrapper sets a flag other tables' triggers consult
    (`shared/sqlite.ts:329-354`); it does not gate writes to the authority
    tables themselves.
12. **`context-authority.ts:610-659` versus the outbox.**
    `reconcileAuthorityProject` contains a real reset-and-repull reconciliation:
    delete `mirror_identity` and `mirror_note_revisions`, set `mirror_cursors`
    to 0, then pull pages until exhausted. Its domain loop is
    `for (const domain of ["notes"] as const)` at `:617` — a one-element loop
    that pointedly excludes `memories`. It never touches
    `claim_outbox_consumer_checkpoints`.
13. **`packages/cli/src/commands/doctor-authority.ts:173-227`.**
    `runDoctorDrainAuthority` is a second process that drives `drainAuthority`
    and, on success, leaves the marker removed (`context-authority.ts:1128-1130`)
    and bumps the project memory epoch. It does not reset any outbox checkpoint.
14. **`hook.ts:924-937`.** The memories-domain authority gate is a single
    module-reported `status.authority?.state !== "MODULE"` test performed once,
    before staging. The subsequent commit, drain, delivery, and checkpoint
    advance all run without re-reading it.
15. **`context-authority.ts:173-179`.** A comment on the
    `context-committed` arm asserts that an intent's effects "still reach the
    mirror through the outbox consumer, which drains independently of this
    coordinator". True of `rust-module-claim-mirror-v1`, whose handler does
    write (Part 4d, `lib.rs:10326`). Not true of `rust-module-claims-v1`, which
    drains only inside `settleContext`.
16. **`module-state-sync.ts:2011` and `:2059`.** The mirror drain is bounded at
    `CLAIM_MIRROR_MAX_GROUPS_PER_SYNC = 1_000` (`:1622`) and throws on
    exhaustion, which `suppressClaimMirror` (`:1933-1952`) converts into a
    suppressed lane that logs once and omits project memories from every Rust
    transform. The effects drain's equivalent bound is `maxReceipts`
    (`:2219`, clamped to 1000) and it throws at `:2354-2358`.
17. **Existing checks are strong on the guards and absent on the composition.**
    `storage-claim-operations.test.ts:954-1016` covers beyond-tail plus
    post-prune idempotence, `:1018-1058` covers split and regression,
    `:842-900` and `:902-952` cover the prune boundary and the per-project
    pairing, and `:1060-1087` covers prune plus reopen. `module-state-sync.test.ts:1399-1442`
    covers ordering and the split rejection. `context-authority-crash.test.ts:214-231`
    is a modelled honest consumer that stores each receipt group, refuses a
    receipt that changed on replay, and refuses an effect crossing groups; it is
    driven through injected crash cuts at `:330-370`. Every one of these tests
    runs at `ci.yml:257`. None of them exercises a consumer that acks without
    applying, which is the shipped consumer.

## Candidate properties

### outbox-b-checkpoint-advance-is-the-point-of-no-return

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `context-authority-crash.test.ts:330-370` drives the advance
under injected crashes, but against a consumer fake that applies
(`:214-231`), so it proves the crash ordering and not the irreversibility.
Guarantee: Once a consumer checkpoint commits at effect id N, no code path in
either tree can cause effects at or below N to be selected for that consumer
again, so the advance must never commit for a prefix whose delivery obligation
is unfulfilled.
Check: `always` — at every commit of the upsert at
`storage-claim-operations.ts:2260-2266`, assert the committed `acked_effect_id`
is greater than or equal to the prior value and that the delivering call
returned without error. `always` rather than `always-or-unreached` because the
advance is on the mandatory settle path of every module-mode memory mutation
(`hook.ts:974-988`), so it is evaluated on every such operation.
Fault/timing angle: The single `await` between `deliver` returning at
`module-state-sync.ts:2322` and the transaction committing at `:2345`. A crash
inside it is the safe direction; the checkpoint stays put and the next drain
re-delivers.
Required faults and enabling state: None to reach the advance. To make the
advance harmful, a consumer that returns the expected id without retaining the
prefix, which is the shipped consumer per Part 4d.
Confidence: high — [evidence](../evidence/outbox-b-checkpoint-advance-is-the-point-of-no-return.md).
Verified the advance site, the two read predicates, the absence of any lowering
path via a repository-wide search for the table name, and that the table has no
`crates/` reference.
Existing check: `storage-claim-operations.test.ts:1018-1058` asserts regression
throws (status: unaudited). No check asserts that no repair path exists.
Impact: A silently unfulfilled delivery obligation with no missing row to
notice it by. The claim mirror the module serves diverges from the producer's
claim store for the life of the database.
Open questions:
- Should a checkpoint reset exist at all, or is the design intent that a
  divergent consumer is repaired only by whole-database reset? (needs human
  input)

### outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — every existing test supplies a `deliver` closure that
either applies the receipt (`context-authority-crash.test.ts:214-231`) or is a
pure echo (`module-state-sync.test.ts:1409-1415`); neither distinguishes the
two, which is precisely the property.
Guarantee: The producer's checkpoint advance is justified by evidence the
consumer durably applied the delivered prefix, not merely by the consumer
returning a value the producer already knew.
Check: `always` — at every advance, assert the producer holds at least one fact
about the consumer's state that was not derivable from the request it just
sent. Today the assertion fails by construction, so the implementable form is
the coverage-check pair in the evidence file: assert the independent
preconditions (an ack was accepted, and the accepted value equals
`request.receipt.effects.at(-1).id`) rather than the violation.
Fault/timing angle: None. No interleaving is required; the deficiency is in the
information content of the response, not its timing.
Required faults and enabling state: None. Default module-mode operation.
Confidence: high — [evidence](../evidence/outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix.md).
Verified both equality checks, the transport's derivation of `expectedEffectId`
from the outgoing request, and Part 4d's module-side reading at `HEAD`.
Existing check: `module-wire.ts:729-733` and `module-state-sync.ts:2323-2327`
both enforce the echo (status: unaudited). Part 4d records that
`decodeClaimEffectDeliveryResponse` has zero test references.
Impact: The checkpoint's meaning is unenforceable. Everything downstream of it
in this lens rests on an ack that carries no information.
Open questions:
- Is `claim.effects.apply` intended to apply, or is it a protocol-conformance
  ack with the mirror lane as the only writer? Part 4d left this open and it is
  the same question. (needs human input)

### outbox-b-checkpoint-monotonicity-is-application-enforced-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the TypeScript guards are covered
(`storage-claim-operations.test.ts:954-1058`), but no test writes the table
through any path other than the guarded function.
Guarantee: A checkpoint row's `acked_effect_id` never decreases and never
exceeds the outbox tail, for every writer of the database file, not only for
callers of `advanceOutboxConsumerCheckpointInCurrentTransaction`.
Check: `always` — after any transaction that modifies
`claim_outbox_consumer_checkpoints`, assert the new `acked_effect_id` is at
least the old one and at most `MAX(id)` of `claim_operation_effects`. `always`
because the invariant is claimed unconditionally by
`storage-claim-memory-schema.ts:286-288`.
Fault/timing angle: None required. The gap is structural: the table has no
triggers, so a direct `UPDATE` from any other connection bypasses all four
guards.
Required faults and enabling state: A writer other than the guarded function.
The CLI already opens the same file for mutation
(`doctor-authority.ts:174`, and the 5d-scoped `doctor-repair-db.ts` and
`migrate.ts`), and `storage-db.ts` exists precisely because other-version
binaries can reach the file.
Confidence: high — [evidence](../evidence/outbox-b-checkpoint-monotonicity-is-application-enforced-only.md).
Verified the full trigger inventory of the claim-memory schema and confirmed
zero triggers name the checkpoint table.
Existing check: `storage-claim-operations.test.ts:1018-1058` covers the
in-process guards (status: unaudited). No check covers an out-of-band writer.
Impact: The one mutable table in an otherwise trigger-fenced schema is the one
whose corruption is silent and irreversible.
Open questions:
- Why does `claim_operation_effects` get a capability-gated delete trigger while
  its cursor table gets none? A deliberate trade or an oversight is not
  determinable from the code. (needs human input)

### outbox-b-checkpoint-never-passes-the-outbox-tail

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `storage-claim-operations.test.ts:954-1016` asserts
`maxEffectId + 1` throws "beyond the outbox tail", then asserts the tail itself
is accepted and that re-acknowledging it after a full prune stays idempotent.
Guarantee: A checkpoint never claims to have observed an effect id that has not
been allocated, and the tail bound remains sound after pruning empties the
table.
Check: `always` — at each advance, assert `ackedEffectId <= COALESCE(MAX(id) of
claim_operation_effects, existing)`. `always` because the guard at
`storage-claim-operations.ts:2241-2245` is unconditional.
Fault/timing angle: The interaction with pruning. The tail falls back to the
existing cursor rather than zero (`:2240`), so an empty table does not force a
regression error on re-acknowledgement. The comment at `:2234-2236` states this
intent.
Required faults and enabling state: To exercise the fallback branch, a pruned
outbox, which in a shipped install never occurs (see
`outbox-b-effects-are-never-pruned-in-a-shipped-install`).
Confidence: high — [evidence](../evidence/outbox-b-checkpoint-never-passes-the-outbox-tail.md).
Verified the guard, the fallback, and that the tail query carries no project
predicate while the write it authorizes is per project.
Existing check: `storage-claim-operations.test.ts:954-1016` (status: unaudited).
It does not cover the cross-project weakness in observation 2.
Impact: Stated in the code's own comment at `:2227-2232`: once every required
consumer holds a future cursor, the prune boundary becomes that future id and
effects allocated below it afterwards are deleted having never been published.
Open questions:
- Is the global `MAX(id)` deliberate, given the receipt-split guard beside it is
  project-scoped? A per-project tail would be strictly tighter. (needs human
  input)

### outbox-b-checkpoint-never-splits-a-receipt-group

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `storage-claim-operations.test.ts:1018-1058` and
`module-state-sync.test.ts:1424-1441` both assert a mid-group id throws
"splits a receipt group".
Guarantee: A consumer's visible prefix never contains part of one claim
operation, so a page can never expose half an operation.
Check: `always` — at each advance, assert no `claim_operation_effects` row in
the project sits at or below `ackedEffectId` whose `receipt_id` also has a row
above it. `always` because the guard at `storage-claim-operations.ts:2246-2259`
is unconditional and the drain enforces the same thing from the other side at
`:2298-2309`.
Fault/timing angle: A receipt whose effects span more than one project. Then the
per-project advances at `module-state-sync.ts:2337-2343` happen inside one
transaction, so the intermediate state where one project has advanced and
another has not is never visible to a reader; but the split guard evaluates
against that intermediate state within the transaction.
Required faults and enabling state: A multi-project receipt to reach the
interesting case. Whether the claim operations that ship can produce one is
unresolved.
Confidence: medium — [evidence](../evidence/outbox-b-checkpoint-never-splits-a-receipt-group.md).
Verified both guards and both tests. The multi-project ordering above is read
from the code and not constructed.
Existing check: the two tests above (status: unaudited). Both use
single-project receipts.
Impact: A consumer applies a fragment of an operation and treats it as
complete, which for a mirror means a claim at a revision its own operation never
finished producing.
Open questions:
- Can a shipped claim operation produce effects in more than one project? The
  advance loop and `vectorsAdvanceOneReceipt` (`module-state-sync.ts:1786-1809`)
  are both written as though it can. Unresolved, needs a pass over the claim
  operation writers in `storage-claim-operations.ts:1-2100`.

### outbox-b-effects-are-never-pruned-in-a-shipped-install

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the prune function is covered by seven test call sites, and
zero production call sites exist, so the tests establish behaviour that never
runs in a shipped install.
Guarantee: `claim_operation_effects` either stays bounded or its growth is
accounted for, and the retention contract the schema describes is the one the
product executes.
Check: `always` — over a session's lifetime, assert that either the
`claim_operation_effects` row count is bounded by some stated function of live
claims, or that the prune path executed at least once. `always` because the
schema states a retention contract unconditionally
(`storage-claim-memory-schema.ts:25-27`, `:430-432`).
Fault/timing angle: None. This is a static wiring fact, not a race.
Required faults and enabling state: None. A default install, any number of
memory mutations.
Confidence: high — [evidence](../evidence/outbox-b-effects-are-never-pruned-in-a-shipped-install.md).
Verified by `rg` across the repository excluding `node_modules`, `dist`, and
`*.test.ts`: the only matches for `pruneClaimOperationEffects` are its own
definition and its own error string.
Existing check: `storage-claim-operations.test.ts:842-900`, `:902-952`,
`:1060-1087` cover the prune semantics thoroughly (status: unaudited). None
covers whether anything calls it.
Impact: Two consequences with opposite signs. Unbounded growth of an
append-only table for the life of the database, which is a slow durable-size
problem. And, in the other direction, the point of no return is *softened*: no
effect row is ever deleted, so a checkpoint reset would in fact be able to
recover a diverged consumer if such a reset existed. It does not.
Open questions:
- Is the prune path unwired deliberately, pending a decision about required
  consumers, or is this a missing call? The function's own signature demands a
  non-empty required-consumer list (`:2298-2300`), and no code anywhere defines
  that list. (needs human input)

### outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test constructs a diverged consumer, because no test
uses a consumer that acks without applying.
Guarantee: For every consumer whose checkpoint has advanced, divergence between
the acknowledged prefix and the consumer's actual state is either detectable or
repairable.
Check: `always` — assert that for each `(consumer, project_id)` row, some
executable code path can either compare the acked prefix against the consumer's
state or reset the row. `always` and not `unreachable`: this is a forbidden
*state* (an undetectable, unrepairable divergence) with no dedicated detection
point, which METHOD.md's rule maps to `always(!X)` rather than `unreachable`.
Fault/timing angle: The clearest concrete window is an authority round trip. A
CLI `doctor drain-authority` run (`doctor-authority.ts:173-227`) returns
memories to TypeScript ownership and removes the marker
(`context-authority.ts:1128-1130`) without resetting either claim consumer's
checkpoint; a later `prepareAuthority` hands ownership back to a module whose
claim state was never seeded with the already-acked prefix.
Required faults and enabling state: No injected fault. An authority drain and a
re-prepare, both shipped operations, are sufficient to produce a module that has
never seen effects the producer records as delivered.
Confidence: high — [evidence](../evidence/outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint.md).
Verified the absence of any checkpoint write other than the forward upsert, and
verified that `reconcileAuthorityProject` reconciles the notes mirror by reset
and re-pull while its domain loop excludes `memories`. The evidence file narrows
the gap: the notes-only loop is explained by its note-specific body, and the
claim *mirror* does reseed per process (`module-state-sync.ts:1986-1994`). The
lane with no reconciliation, no seeding, and a durable cursor is the claim
*effects* lane specifically.
Existing check: none for the claim effects lane. The notes lane has
`context-authority.ts:633-657` (status: unaudited), which is the shape the claim
effects lane lacks.
Impact: Part 3 established that the claim mirror's divergence is prevented at
admission and never detected afterwards. This is the producer-side confirmation:
the other end has no detector either. Divergence is a permanent, silent state on
both sides.
Open questions:
- Why does the claim effects lane combine a durable cursor with no seeding
  protocol and no reconciliation, when both sibling lanes have one or the other?
  (needs human input)

### outbox-b-authority-write-fence-covers-notes-but-not-claim-tables

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test attempts a claim write while the authority marker
is installed and asserts the outcome.
Guarantee: While a project's authority is module-owned, the local database
refuses local writes to the state the module owns, for claims as it does for
notes.
Check: `always` — with `authority_managed` holding a row for the project,
assert an unprivileged write to `claims`, `claim_revisions`,
`claim_operation_receipts`, or `claim_operation_effects` is refused, exactly as
`notes_authority_guard_insert` refuses a note write. `always` because the fence
is claimed for the project, not for a subset of tables.
Fault/timing angle: The gate that does exist for claims is a single
module-reported read at `hook.ts:924-937`, performed once before staging. The
commit, the drain, the delivery, and the checkpoint advance all follow without
re-reading it, so an authority drain concurrent with a memory mutation lands the
mutation and its checkpoint advance under an authority that has already gone.
Required faults and enabling state: For the trigger gap, only an installed
marker. For the timing window, a drain that begins after `hook.ts:924` returns.
Confidence: high — [evidence](../evidence/outbox-b-authority-write-fence-covers-notes-but-not-claim-tables.md).
Verified that all ten `authority_managed` references in the schema file are the
table definition plus the three notes triggers, and that the claim-memory schema
names it nowhere.
Existing check: `storage-session-runtime-schema.ts:1190-1255` fences `notes`
(status: unaudited). Nothing fences a claim table.
Impact: The authority contract is enforced at the database boundary for the
smaller of the two domains and only in application code for the larger one, so
a code path that forgets the `hook.ts` check writes claim state the module
believes it owns.
Open questions:
- Is the claim lane deliberately outside the trigger fence because the claim
  tables have their own append-only guards, or is the memories domain simply
  unfenced? (needs human input)

### outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `module-wire.ts:284-286` is exercised through the mirror
snapshot tests; the binding decoder at `:550-558` has no format assertion to
exercise.
Guarantee: Every `databaseIncarnationId` crossing the claim wire is 32
lowercase hex characters, in both directions and on both the mirror and the
intent lanes.
Check: `always` — on every encode and decode of a claim binding or mirror
vector, assert the incarnation matches `/^[0-9a-f]{32}$/`. `always` because the
value's only consumers compare it for equality against a 32-hex column.
Fault/timing angle: None. A format question, not a race.
Required faults and enabling state: A malformed or substituted binding on the
inbound path. The outbound path cannot produce one, because
`readDirectFormatMarker` rejects an invalid marker
(`storage-format-epoch.ts:222-224`) before `hook.ts:958` reads it.
Confidence: high — [evidence](../evidence/outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only.md).
Verified the mint, the validator, the marker read, the producer's use, and the
two different decoder standards. Also verified that this producer is **not** one
of the four dashed-UUID callers Part 3 found: those are all inside
`crates/mc-store/src/lib.rs` and all pass `context_store_uuid`.
Existing check: `module-wire.ts:284-286` for the mirror vector only (status:
unaudited).
Impact: Bounded on the outbound path. The value that matters is the one Part 3's
trap turns on: if Rust's guard were repaired without changing its argument, the
column would hold a `context_store_uuid` and every comparison against this
producer's correct 32-hex value would fail `IncarnationMismatch`.
Open questions: None.

### outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — `module-state-sync.test.ts:1400-1422` constructs exactly
this situation with two groups and asserts the delivery order, but with a
`deliver` closure that echoes. The situation is reached; the operational state
that makes it interesting is not.
Guarantee: A campaign produces at least one drain in which the unacknowledged
prefix contains a receipt group other than the one the current mutation just
committed, so ordering and partial-progress behaviour are observed rather than
assumed.
Check: `sometimes` — mark `EFFECTS_DRAIN_DELIVERED_BACKLOG_GROUP` when
`drainClaimEffectPrefix` delivers a group whose `receiptId` differs from
`throughReceiptId`. `sometimes` and not `reachable`: the loop at
`module-state-sync.ts:2256` executes its lines on every single mutation, so line
coverage says nothing; what must occur at least once is the *state* of a
non-empty prior backlog.
Fault/timing angle: The backlog only exists if a previous drain did not
complete. Reaching it needs an earlier delivery that failed after the receipt
committed and before the checkpoint advanced, or a mutation in a project whose
effects an earlier scoped drain excluded (observation 5).
Required faults and enabling state: One prior failed delivery, or two mutations
in projects that do not share a receipt. Both are producible with the existing
in-test consumer.
Confidence: high — [evidence](../evidence/outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign.md).
Verified the scoping logic, the break at `:2351`, and the existing two-group
test.
Existing check: `module-state-sync.test.ts:1400-1422` (status: unaudited).
Impact: Without this situation, every observation of the drain is of the
degenerate one-group case, and the ordering guarantees the code invests in are
untested where they matter.
Open questions: None.

### outbox-b-checkpoint-advances-against-a-module-with-no-open-store

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test on either side drives a delivery while the module's
store is opening.
Guarantee: A campaign reaches at least one delivery accepted while the consumer
cannot possibly have applied it, so the producer's inability to distinguish that
case is observed rather than argued.
Check: `sometimes` — mark `EFFECTS_ACK_ACCEPTED_DURING_STORE_OPENING` when a
delivery is accepted and the module's store phase is `STORE_OPENING`. Assert the
two independent preconditions separately, per METHOD.md's coverage-check rule:
the ack was accepted, and the module reported a non-ready store phase in the
same window. Neither marker observes a defect, so both fire on a correct
implementation too.
Fault/timing angle: The store-open window itself. Part 4d records that during
`STORE_OPENING` (`lib.rs:12007-12011`) `claim.intent.stage` returns
`store_unavailable_error` (`:10097-10099`) while `claim.effects.apply` returns a
successful ack (`:10251-10254`), because the latter never calls `self.store()`.
Required faults and enabling state: A delivery timed into the module's store-open
window. Reaching it from the producer requires the intent to have staged before
the store closed and reopened, or a restart between staging and settling.
Confidence: medium — [evidence](../evidence/outbox-b-checkpoint-advances-against-a-module-with-no-open-store.md).
Verified Part 4d's four module-side references at `HEAD`. The producer-side
sequencing that reaches the window is reasoned from `hook.ts:917-990` and not
constructed.
Existing check: none.
Impact: This is the cleanest possible demonstration that the ack carries no
information, and it needs no fault injection beyond timing: the producer commits
an irreversible checkpoint against a consumer that provably had no store to
write to.
Open questions:
- Can the producer observe the module's store phase at all from the claim path?
  `hook.ts:924` reads `authorityStatus`, not health. Unresolved, needs a pass
  over the transport's health surface, which 5c scopes.

## Contract-vs-code leads

1. **The schema promises a retention contract the product never executes.**
   `storage-claim-memory-schema.ts:25-27` says outbox effects "admit only
   watermark-gated pruning", and `:430-432` says "an effect leaves only through
   consumption-driven pruning". Both are true as written and both describe a
   path with no production caller
   (`storage-claim-operations.ts:2289`, callers only in tests). The doc
   describes a mechanism, and a reader takes it as describing behaviour.
2. **The schema states monotonicity as a property of the table and then names
   the function that actually enforces it.**
   `storage-claim-memory-schema.ts:286-288` is simultaneously the contract and
   its own disclaimer. Against it: the table has no trigger, while every table
   the same fragment calls append-only carries three to six
   (`:313`, `:324`, `:352`, `:388`, `:412`, `:427`). The checkpoint table is
   classified with the two harmlessly-mutable tables at `:27-30`, and it is the
   only member of that group whose corruption is unrecoverable.
3. **`storage-claim-operations.ts:2209-2211` says the cursor "may not run past
   the current outbox tail"; the implementation's tail is global.**
   `:2237-2239` selects `MAX(id)` from the whole table with no project
   predicate, while the guard two statements later is project-scoped
   (`:2246-2254`). Both sides cited; not resolved here.
4. **`context-authority.ts:175-177` says a `context-committed` intent's effects
   "still reach the mirror through the outbox consumer, which drains
   independently of this coordinator".** Independently true for
   `rust-module-claim-mirror-v1` (`module-state-sync.ts:1954-2089`, invoked from
   the state-sync path). Not true for `rust-module-claims-v1`, whose only drain
   is inside `settleContext` (`hook.ts:974-988`), which is exactly the
   coordinator the comment says it is independent of.
5. **`module-state-sync.ts:1618-1620` states the consumer-identity obligation in
   both directions; the consumer honours neither half.** Part 4d,
   `lib.rs:10198-10204`: `consumer` must be a non-empty string and its value is
   never compared. So the producer's care in defining two distinct consumer
   constants (`:1617`, `:1621`) is unobservable at the other end.
6. **`module-transport.ts:1073-1075` calls the last effect "the delivery
   checkpoint (same contract as the outbox drain and the mirror receipt
   decoder)", asserting a three-way shared contract.** The mirror receipt
   decoder does verify a module-side outcome — `appliedEffectCount` and
   `replayed` (`module-wire.ts:783-791`) — while the effects decoder verifies
   only the echoed id (`:717-735`). The two are not the same contract, and the
   difference is exactly the one that matters.
7. **`reconcileAuthorityProject` is named for the project and reconciles one
   domain.** `context-authority.ts:610-614` takes a `projectPath` and no domain;
   `:617` loops over `["notes"]`. A caller reading the name has no reason to
   expect `memories` to be excluded.

## Open questions

- Is `claim.effects.apply` meant to apply? Part 4d could not resolve it and
  neither can this pass. Every name on the producer side asserts delivery, and
  the handler writes nothing. The producer's behaviour is unsafe under one
  reading and correct under the other, and the two differ only in what the
  module is supposed to do. (needs human input)
- Should a checkpoint reset exist? If `claim.effects.apply` is meant to apply,
  the absence of a reset makes every divergence permanent. If it is a
  conformance ack, the checkpoint is bookkeeping and a reset is pointless. The
  answer to the previous question decides this one. (needs human input)
- Why is `pruneClaimOperationEffectsInCurrentTransaction` unwired? Nothing
  anywhere defines the required-consumer list its signature demands
  (`storage-claim-operations.ts:2291`, `:2298-2300`). Either the list is a
  pending decision or the call site was lost. (needs human input)
- Why does the claim effects lane have a durable cursor and neither a seeding
  protocol nor a reconciliation? The notes lane has reset-and-repull
  (`context-authority.ts:633-657`), and the claim mirror lane reseeds per process
  (`module-state-sync.ts:1986-1994`). The effects lane has neither, and its
  cursor is the one that survives restarts. (needs human input)
- Is the global tail at `storage-claim-operations.ts:2237-2239` deliberate? The
  comment above it argues in global terms, but the write it authorizes and the
  guard beside it are both per project. Unresolved; a per-project tail would be
  strictly tighter and no weaker, which is a suspicious asymmetry to leave
  unexplained.
- Can one claim operation produce effects in more than one project? Three
  separate pieces of code are written as though it can
  (`module-state-sync.ts:1786-1809`, `:2330-2343`,
  `storage-claim-operations.ts:2302-2313`), and every test uses one project.
  Unresolved, needs a pass over the claim operation writers, which sit in this
  sub-part's file set but outside this lens's focus.
- Can the producer observe the module's store-open phase from the claim path?
  Needed to implement `outbox-b-checkpoint-advances-against-a-module-with-no-open-store`
  as a producer-side check rather than a cross-tree one. Unresolved, needs the
  transport health surface that 5c scopes.
