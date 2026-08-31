# outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint

## Discovery trigger

Part 3 found that the claim mirror's divergence is prevented at admission and
never detected afterwards, on the store side. The obvious follow-up is whether the
producer has a detector the store lacks. It has the machinery — a full
reset-and-repull reconciliation lives in the same file as the authority code — and
it applies that machinery to a different lane.

## Evidence trail

**The reconciliation that exists.**
`packages/plugin/src/features/magic-context/context-authority.ts:610-659`,
`reconcileAuthorityProject`. Its body:

- `:615` — repair the authority marker.
- `:617` — `for (const domain of ["notes"] as const) {`
- `:618-623` — skip unless the module reports `MODULE` for that domain.
- `:624-629` — skip if a `mirror_identity` row already exists.
- `:633-651` — inside `withPrivilegedWriter` and an immediate transaction:
  `DELETE FROM mirror_identity`, `DELETE FROM mirror_note_revisions`, and
  `INSERT ... ON CONFLICT DO UPDATE SET cursor = 0` on `mirror_cursors`.
- `:652-657` — pull pages from `module.mirrorPull` until `!has_more` or the
  cursor stops moving.

That is a complete divergence repair: drop the local projection, reset the
cursor to zero, replay from the authority. The pattern is available and proven in
this codebase.

**The domain loop excludes memories.** `AUTHORITY_DOMAINS` is
`["memories", "notes"] as const` (`:19`), and `reconcileAuthorityProject`'s
sibling `reconcileAuthorityMarker` iterates it in full (`:563`, `:583`). Line
`:617` deliberately iterates a one-element literal instead. A one-element
`for...of` over an inline `as const` array is a construction someone chose; it is
not an accident of a filter.

**Nothing resets a claim consumer checkpoint.** The full write inventory of
`claim_outbox_consumer_checkpoints`, from `rg` over `packages/` and `crates/`
excluding `node_modules`, `dist`, and `*.test.ts`: one `SELECT`
(`storage-claim-operations.ts:2201-2202`), one forward-only upsert (`:2260-2266`),
one `LEFT JOIN` in the prune aggregate (`:2305-2309`), and two `LEFT JOIN`s in the
drain and mirror selectors (`module-state-sync.ts:1776`, `:2261`). Zero `DELETE`,
zero downward `UPDATE`, zero references under `crates/`.

**Nothing detects divergence either.** The producer's only signal from the
consumer on this lane is `ackedEffectId`, which is an echo (see
`outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix`). The mirror lane
does slightly better — `decodeClaimMirrorReceiptResponse` reads `replayed` and
`appliedEffectCount` (`module-wire.ts:783-791`) — but neither is compared against
a local expectation of the consumer's total state, only against the request's own
identity. Part 3's `mirror-staleness-undetectable-on-memory-tool-read-path`
records the same absence from the read side.

**A concrete route to divergence with no injected fault.**
`packages/cli/src/commands/doctor-authority.ts:173-227`,
`runDoctorDrainAuthority`, is a shipped command in a different package. It opens
the database for mutation (`:174`), reads the module's authority state per domain
(`:190-193`), and calls `drainAuthority` up to twice per domain (`:206-213`). On
success `drainAuthority` removes the project marker once neither domain is
module-owned (`context-authority.ts:1119-1130`), and the command then bumps the
project memory epoch (`:221`). It touches no outbox checkpoint.

So the sequence is: authority is `MODULE`, memory mutations run and advance
`rust-module-claims-v1` and `rust-module-claim-mirror-v1` checkpoints, an operator
drains authority back to TypeScript, and later `prepareAuthority`
(`context-authority.ts:807`) hands ownership to a module process whose claim state
was built from whatever seeding it performs — not from the effects already marked
acknowledged. The mirror lane recovers, because `claimMirrorSeeded` is per-process
state (`module-state-sync.ts:1986`) and a fresh process reseeds through
`publishClaimMirrorSnapshot` (`:1988-1994`). The effects lane does not, because
its checkpoint is durable and its consumer never seeds.

## Failure scenario

An operator runs `doctor drain-authority`, then rust mode is re-enabled. The new
module process is told nothing about effects 1 through N, because the producer
records them as delivered to `rust-module-claims-v1`. If that consumer is meant to
apply (Part 4d's reading A), the module's claim state is permanently missing those
N effects, and there is no query on either side that would reveal it: the producer
sees a healthy checkpoint, the module sees no gap because it has no record of what
it should have received, and the drain reports zero pending because the predicate
excludes the prefix.

The mirror lane's periodic reseed would paper over the *content* divergence for
anything the snapshot covers, which makes the failure even harder to see: project
memories still render, because the mirror consumer works. What is lost is whatever
the effects consumer was supposed to derive from the effect stream, which is
exactly the thing nobody can name (Part 4d's open question).

## Timing windows and dependencies

- No injected fault required. Two shipped operations in sequence.
- Depends on `outbox-b-checkpoint-advance-is-the-point-of-no-return` for
  irreversibility and on
  `outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix` for
  undetectability.
- Softened only in theory by
  `outbox-b-effects-are-never-pruned-in-a-shipped-install`: the rows survive, so a
  reset would work if one existed.

## What a test must construct

1. Drive one memory mutation to completion under module-mode so a checkpoint
   advances. Record the row.
2. Run the authority drain path (`drainAuthority` for both domains) and assert the
   marker is removed. Then re-read `claim_outbox_consumer_checkpoints` and assert
   the row is unchanged. That unchanged row is the property, stated positively and
   with no defect observed.
3. Re-prepare authority with a fresh consumer that records what it receives.
   Assert it never receives the pre-drain effects.
4. Positive control on the notes lane: do the same across
   `reconcileAuthorityProject` and assert `mirror_cursors` for `notes` returned to
   zero (`context-authority.ts:645-648`) and the projection was replayed. That
   isolates the missing memories-lane reconciliation as the difference.
5. Coverage-check form, two independent markers:
   `AUTHORITY_RETURNED_TO_TS_WITH_ADVANCED_CLAIM_CHECKPOINT` fires when the
   marker is removed while any `claim_outbox_consumer_checkpoints` row is
   non-zero, and `CLAIM_CHECKPOINT_RESET_INVOKED` fires if any code ever lowers a
   row. The second never fires on the current tree; recording that it does not is
   the evidence, and neither marker requires seeing corruption.

## Investigation log

### Q: Why does `context-authority.ts:617` iterate `["notes"]` rather than `AUTHORITY_DOMAINS`?

- Sources examined: `:19` for `AUTHORITY_DOMAINS`; `reconcileAuthorityMarker`
  at `:554-608`, which iterates the full list twice (`:563`, `:583`) and is
  called from `reconcileAuthorityProject:615`, so the marker half *is*
  domain-complete; the body at `:624-657`, which is entirely about
  `mirror_identity`, `mirror_note_revisions`, `mirror_cursors`, and
  `applyMirrorPage`; `applyMirrorPage` at `:1428`, and `applyNoteRow` at
  `:1340`, which the page application dispatches to.
- Findings: the mechanism the loop uses is note-specific. `mirror_note_revisions`
  is a notes table, `applyNoteRow` handles notes, and the changefeed shape is a
  note changefeed. So the exclusion of `memories` is not an oversight in the loop
  bound; the loop's body simply has no memories implementation. The memories lane
  reconciles by a different route — the claim mirror snapshot replace
  (`module-state-sync.ts:1743-1764`) — which is per-process and does reseed. What
  has no reconciliation is the *effects* lane specifically, whose checkpoint is
  durable and whose consumer has no seeding protocol at all.
- Missing evidence: whether the effects lane was intended to have one. That
  reduces to Part 4d's unresolved question about what the consumer is for.
- Conclusion: resolved with answer, partially — the notes-only loop is explained
  by its note-specific body, and the real gap is narrower than first stated: the
  claim *mirror* does reseed per process, and the claim *effects* consumer has no
  reconciliation, no seeding, and a durable cursor. Why that combination exists
  needs human input.
