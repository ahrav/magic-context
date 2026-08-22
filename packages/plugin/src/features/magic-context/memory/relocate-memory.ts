import { randomUUID } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import { recordAdoptedMemoryVerifiedEventInCurrentTransaction } from "../claims-backfill";
import {
    effectiveSeenCountSql,
    hasMemoryStatsTable,
    requireEffectiveSeenCount,
} from "./storage-memory";
import {
    computeClaimRequestDigest,
    ensureMemoryClaimLinkInCurrentTransaction,
    hasMemoryClaimsCompatSchema,
    type MemoryClaimEffect,
    type MemoryClaimLink,
    type MemoryClaimLinkFailureReason,
    type MemoryClaimOperationEnvelope,
    memoryClaimAdoptionFailureReason,
    readCurrentClaimSemanticState,
    readMemoryClaimLink,
    recordMemoryClaimLinkFailure,
    recordMemoryClaimSupersessionInCurrentTransaction,
    resolveMemoryClaimProjectInCurrentTransaction,
    retireMemoryClaimInCurrentTransaction,
    runMemoryClaimOperationInCurrentTransaction,
    setClaimLifecycleStateInCurrentTransaction,
    sharedClaimStateFromLiveLinks,
    translateMemoryClaimRelationshipsInCurrentTransaction,
    withClaimsWriteCapabilityInCurrentTransaction,
    withMemoryClaimGenerationContextInCurrentTransaction,
} from "./storage-memory-claims";
import { type MemoryProjectionRow, readMemoryProjectionRow } from "./storage-memory-projection";
import type { MemoryStatus } from "./types";

/**
 * Memory relocation primitives shared by the v22 dir-identity backfill and the
 * `doctor migrate-session` command (re-homing a session to a different project).
 *
 * All operations are collision-aware against UNIQUE(project_path, category,
 * normalized_hash): the target identity may already hold an equivalent memory,
 * and a blind write there would abort the surrounding transaction. MUST run
 * inside a transaction.
 */

export interface RelocateMemorySelection {
    /** Status set to operate on. Archived memories are deliberately excluded by
     *  default — they are suppressed history, not injectable knowledge. */
    statuses?: MemoryStatus[];
    /** When set, restrict to memories whose `source_session_id` matches (the
     *  "only memories originated from this session" option). */
    sourceSessionId?: string;
}

const DEFAULT_STATUSES: MemoryStatus[] = ["active", "permanent"];

/**
 * Resolve the memory ids under `fromProjectPath` that a relocation should act
 * on, honoring the status filter and the optional originator-session filter.
 */
export function selectRelocatableMemoryIds(
    db: Database,
    fromProjectPath: string,
    selection: RelocateMemorySelection = {},
): number[] {
    const statuses = selection.statuses ?? DEFAULT_STATUSES;
    if (statuses.length === 0) return [];
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const params: Array<string> = [fromProjectPath, ...statuses];
    let sql = `SELECT id FROM memories WHERE project_path = ? AND status IN (${statusPlaceholders})`;
    if (selection.sourceSessionId !== undefined) {
        sql += " AND source_session_id = ?";
        params.push(selection.sourceSessionId);
    }
    sql += " ORDER BY id ASC";
    const rows = db.prepare(sql).all(...params) as Array<{ id: number }>;
    return rows.map((row) => row.id);
}

/**
 * Collision-aware single-row rekey. If the target identity already holds an
 * equivalent memory (same category + normalized_hash), merge into it (keep the
 * larger seen_count, delete the source — embedding FK-cascades) instead of
 * aborting the transaction on the UNIQUE violation; otherwise do the guarded
 * UPDATE. Returns true if the row was rekeyed or merged. MUST run inside a
 * transaction.
 */
export function rekeyMemoryRowWithCollisionMerge(
    db: Database,
    rowId: number,
    fromProjectPath: string,
    toIdentity: string,
): boolean {
    if (hasMemoryClaimsCompatSchema(db)) {
        return withClaimsWriteCapabilityInCurrentTransaction(db, () =>
            rekeyMemoryRowWithCollisionMergeInner(db, rowId, fromProjectPath, toIdentity),
        );
    }
    return rekeyMemoryRowWithCollisionMergeInner(db, rowId, fromProjectPath, toIdentity);
}

const RELOCATION_PRODUCER = "memory-relocation";

function relocationEnvelope(operation: string, request: unknown): MemoryClaimOperationEnvelope {
    return {
        producer: RELOCATION_PRODUCER,
        operationKey: `${operation}:${randomUUID()}`,
        requestDigest: computeClaimRequestDigest(request),
        // The random key can never be presented again, so a zero-effect run
        // has no replay value and must not persist an operation row.
        ephemeral: true,
    };
}

/**
 * Claims-active relocations require a resolvable target project. Silently
 * skipping claim work on an unresolved target would delete source rows
 * without lineage or leave fresh rows permanently unlinked (the crosswalk is
 * append-only), so an unresolvable target fails the operation instead.
 */
function requireRelocationTargetProject(db: Database, toIdentity: string): number {
    const targetProjectId = resolveMemoryClaimProjectInCurrentTransaction(db, toIdentity);
    if (targetProjectId === null) {
        throw new Error(
            `memory relocation target ${toIdentity} does not resolve to a canonical git:/dir: project; claims-linked rows cannot relocate to an unresolvable identity`,
        );
    }
    return targetProjectId;
}

/**
 * Lifecycle half of the adopted-claim sync: adoption reuses whatever
 * canonical claim already owns the (project, category, hash) tuple —
 * including one archived by a prior delete of the target-project
 * equivalent — so the claim state is re-derived from the adopted projection
 * row and an active row never points at an archived claim. Exported
 * separately for callers that own their verification recording and must not
 * double-record the row's verified event. Returns the effects the caller
 * must emit for what actually changed.
 */
export function syncAdoptedClaimLifecycleState(
    db: Database,
    row: MemoryProjectionRow,
    link: MemoryClaimLink,
    projectId: number,
    producer: string,
): MemoryClaimEffect[] {
    const effects: MemoryClaimEffect[] = [];
    // Shared-claim rule: the claim holds the max-rank state across its
    // surviving linked projections, so adopting one row cannot downgrade a
    // permanent sibling's claim.
    const desiredState = sharedClaimStateFromLiveLinks(db, link.claimId, row.id, row.status);
    if (readCurrentClaimSemanticState(db, link.claimId).state !== desiredState) {
        if (desiredState === "archived") {
            retireMemoryClaimInCurrentTransaction(db, link.claimId, producer);
        } else {
            setClaimLifecycleStateInCurrentTransaction(db, link.claimId, desiredState);
        }
        effects.push({
            effectKey: `memory:${row.id}:lifecycle`,
            projectId,
            claimId: link.claimId,
            effectType: "lifecycle" as const,
        });
    }
    return effects;
}

/**
 * Full adopted-claim sync: the lifecycle re-derivation above plus the row's
 * verified status carried onto the claim as evidence. The producer stamps
 * the lifecycle and verification events with the adopting operation's
 * identity. Returns the effects the caller must emit for what actually
 * changed.
 */
export function syncAdoptedRelocationClaimState(
    db: Database,
    row: MemoryProjectionRow,
    link: MemoryClaimLink,
    projectId: number,
    producer: string,
): MemoryClaimEffect[] {
    const effects = syncAdoptedClaimLifecycleState(db, row, link, projectId, producer);
    if (recordAdoptedMemoryVerifiedEventInCurrentTransaction(db, row, link.claimId, producer)) {
        effects.push({
            effectKey: `memory:${row.id}:evidence`,
            projectId,
            claimId: link.claimId,
            effectType: "evidence" as const,
        });
    }
    return effects;
}

/**
 * Claim adoption for a plain rekey. An unlinked row adopts its preimage
 * under the TARGET numeric project — the raw source path is what made it
 * unlinkable — which also satisfies the v84 boundary identity guard before
 * the project_path UPDATE runs. A row already linked to the target project
 * (the routine dir: → git: adoption) needs nothing: the numeric project and
 * claims are retained.
 */
function adoptRelocationRekeyClaim(db: Database, rowId: number, targetProjectId: number): void {
    const row = readMemoryProjectionRow(db, rowId);
    if (!row || row.content.length === 0) return;
    runMemoryClaimOperationInCurrentTransaction(
        db,
        relocationEnvelope("rekey", { rowId, targetProjectId }),
        () => {
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, targetProjectId, {
                kind: "migration",
            });
            const stateEffects = syncAdoptedRelocationClaimState(
                db,
                row,
                link,
                targetProjectId,
                RELOCATION_PRODUCER,
            );
            const relationshipEffects = translateMemoryClaimRelationshipsInCurrentTransaction(
                db,
                row,
            );
            return {
                result: link.claimId,
                effects: [
                    {
                        effectKey: `memory:${rowId}:upsert`,
                        projectId: targetProjectId,
                        claimId: link.claimId,
                        effectType: "upsert" as const,
                    },
                    ...stateEffects,
                    ...relationshipEffects,
                ],
            };
        },
    );
}

/**
 * Blocking diagnostic for a collision merge the caller cannot take: the
 * surviving target row is unadoptable, so no canonical claim can anchor the
 * source's crosswalk link before the source row leaves the corpus — and the
 * merge keeps the TARGET's bytes, so folding the source into an unadoptable
 * survivor would silently discard content. Mirrors the repoint diagnostic
 * shape so the repair lane surfaces the stalled merge; the leading
 * `memory:<sourceId>` in the item key is what the boundary gating parser
 * reads, keeping completion fail-closed while a boundary source is stranded.
 */
export function recordSkippedCollisionMergeDiagnostic(
    db: Database,
    sourceId: number,
    targetId: number,
    reason: MemoryClaimLinkFailureReason,
): void {
    const now = Date.now();
    db.prepare(
        `INSERT INTO claim_backfill_failures
            (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
         VALUES ('relationships', 'merge', ?, ?, ?, 'blocking', ?, ?)
         ON CONFLICT(phase, item_kind, item_key)
         DO UPDATE SET reason_code = excluded.reason_code, detail = excluded.detail,
                       disposition = 'blocking', updated_at = excluded.updated_at`,
    ).run(
        `memory:${sourceId}:collision-merge:${targetId}`,
        reason,
        JSON.stringify({ collisionTargetMemoryId: targetId }),
        now,
        now,
    );
}

/**
 * Flip a skipped collision merge's blocking/retry diagnostic to resolved once
 * the same (source, target) merge completes — the merge twin of
 * `resolveMemoryClaimLinkFailure`. Nothing sweeps the `merge` item kind, so
 * without this the diagnostic outlives the repaired-and-retried merge and
 * pins reconciliation forever. Warnings stay visible on the repair surface.
 */
export function resolveSkippedCollisionMergeDiagnostic(
    db: Database,
    sourceId: number,
    targetId: number,
): void {
    db.prepare(
        `UPDATE claim_backfill_failures SET disposition = 'resolved', updated_at = ?
          WHERE phase = 'relationships' AND item_kind = 'merge' AND item_key = ?
            AND disposition IN ('blocking', 'retry')`,
    ).run(Date.now(), `memory:${sourceId}:collision-merge:${targetId}`);
}

/**
 * Claim canonicalization for a collision merge: the surviving target row
 * owns (or adopts) the canonical claim, the deleted source row records its
 * link to that canonical claim (duplicate crosswalk link), and a source that
 * carried its OWN claim retires it with supersession lineage. The source
 * bytes stay retained on the duplicate link's root observation, so the
 * canonical claim keeps reflecting the surviving projection row.
 *
 * Returns false — merge must not proceed — when either row is unadoptable:
 * an unadoptable target can anchor no canonical claim, so the source link
 * the boundary delete guard demands cannot anchor anywhere, and the merge
 * would delete the source while the unadoptable target keeps its (empty)
 * bytes; an unlinked unadoptable source (empty content, claim-invalid
 * metadata) can never acquire the crosswalk link that must outlive its
 * delete, so proceeding would either abort the transaction or silently
 * discard the row's lineage. Each skip records a blocking diagnostic
 * instead of losing data.
 */
function adoptRelocationMergeClaims(
    db: Database,
    sourceId: number,
    targetId: number,
    toIdentity: string,
): boolean {
    const targetProjectId = requireRelocationTargetProject(db, toIdentity);
    const targetRow = readMemoryProjectionRow(db, targetId);
    if (!targetRow) return false;
    const targetFailure = memoryClaimAdoptionFailureReason(targetRow, targetProjectId);
    if (targetFailure !== null) {
        recordSkippedCollisionMergeDiagnostic(db, sourceId, targetId, targetFailure);
        return false;
    }
    const sourceRow = readMemoryProjectionRow(db, sourceId);
    if (sourceRow && !readMemoryClaimLink(db, sourceId)) {
        const sourceFailure = memoryClaimAdoptionFailureReason(sourceRow, targetProjectId);
        if (sourceFailure !== null) {
            // The merge deletes the source row, so an unlinked source must be
            // able to adopt its duplicate crosswalk link first — unlike
            // identity-merge, which archives the source in place and can
            // proceed past a diagnosed link failure.
            recordSkippedCollisionMergeDiagnostic(db, sourceId, targetId, sourceFailure);
            return false;
        }
    }
    runMemoryClaimOperationInCurrentTransaction(
        db,
        relocationEnvelope("merge", { sourceId, targetId, toIdentity }),
        () => {
            const effects: MemoryClaimEffect[] = [];
            const targetWasLinked = readMemoryClaimLink(db, targetId) !== null;
            const targetLink = ensureMemoryClaimLinkInCurrentTransaction(
                db,
                targetRow,
                targetProjectId,
                { kind: "migration" },
            );
            if (!targetWasLinked) {
                effects.push({
                    effectKey: `memory:${targetId}:upsert`,
                    projectId: targetProjectId,
                    claimId: targetLink.claimId,
                    effectType: "upsert" as const,
                });
            }
            // Adoption can reuse a canonical claim archived by a prior delete
            // of the target-project equivalent; the sync reactivates it from
            // the surviving row's status. Only a first adoption carries the
            // row's verified state onto the claim as evidence — an
            // already-linked target's claim carries its own verified event,
            // and the unconditional carry would append a duplicate per
            // equivalent merge.
            effects.push(
                ...(targetWasLinked
                    ? syncAdoptedClaimLifecycleState(
                          db,
                          targetRow,
                          targetLink,
                          targetProjectId,
                          RELOCATION_PRODUCER,
                      )
                    : syncAdoptedRelocationClaimState(
                          db,
                          targetRow,
                          targetLink,
                          targetProjectId,
                          RELOCATION_PRODUCER,
                      )),
            );
            let sourceLink = readMemoryClaimLink(db, sourceId);
            if (!sourceLink && sourceRow) {
                sourceLink = ensureMemoryClaimLinkInCurrentTransaction(
                    db,
                    sourceRow,
                    targetProjectId,
                    { kind: "migration" },
                    { adoptDivergentContent: false },
                );
                // The adoption dedups onto the target's canonical claim
                // (same project + category + hash), so the divergent-claim
                // block below no-ops for a freshly-linked source. This
                // upsert is the fresh crosswalk row's only outbox effect —
                // without it the boundary reconciliation oracle flags the
                // link forever once the caller deletes the source row.
                effects.push({
                    effectKey: `memory:${sourceId}:upsert`,
                    projectId: targetProjectId,
                    claimId: sourceLink.claimId,
                    effectType: "upsert" as const,
                });
            }
            if (sourceLink && sourceRow) {
                effects.push(
                    ...translateMemoryClaimRelationshipsInCurrentTransaction(db, sourceRow),
                );
            }
            if (sourceLink && sourceLink.claimId !== targetLink.claimId) {
                // Shared-claim rule: the source claim holds the max-rank
                // state across its surviving linked projections — the caller
                // deletes this row after the merge, but a live alias sibling
                // keeps the claim live, so retirement lands only with the
                // last live link. The supersession recorder itself
                // suppresses the lineage edge while a live sibling remains.
                const desiredSourceState = sharedClaimStateFromLiveLinks(
                    db,
                    sourceLink.claimId,
                    sourceId,
                    "archived",
                );
                if (
                    readCurrentClaimSemanticState(db, sourceLink.claimId).state !==
                    desiredSourceState
                ) {
                    if (desiredSourceState === "archived") {
                        retireMemoryClaimInCurrentTransaction(
                            db,
                            sourceLink.claimId,
                            RELOCATION_PRODUCER,
                        );
                    } else {
                        setClaimLifecycleStateInCurrentTransaction(
                            db,
                            sourceLink.claimId,
                            desiredSourceState,
                        );
                    }
                    effects.push({
                        effectKey: `memory:${sourceId}:lifecycle`,
                        projectId: sourceLink.projectId,
                        claimId: sourceLink.claimId,
                        effectType: "lifecycle" as const,
                    });
                }
                if (recordMemoryClaimSupersessionInCurrentTransaction(db, sourceLink, targetLink)) {
                    effects.push({
                        effectKey: `memory:${targetId}:supersede`,
                        projectId: targetProjectId,
                        claimId: targetLink.claimId,
                        effectType: "evidence" as const,
                    });
                }
            }
            return { result: targetLink.claimId, effects };
        },
    );
    // A prior attempt at this same (source, target) pair may have skipped
    // with a blocking diagnostic; the completed merge is its repair.
    resolveSkippedCollisionMergeDiagnostic(db, sourceId, targetId);
    return true;
}

/**
 * Blocking relationships-phase diagnostic for a supersession edge the move
 * cannot repoint: the referrer is unadoptable, so no claim link — and
 * therefore no relationship snapshot — can authorize rewriting its lineage
 * columns. The item key lives under the referrer's `relations:` namespace
 * so the first relationship translation of the linked referrer resolves it:
 * translation snapshots the referrer's lineage and records (or re-diagnoses
 * under digest-scoped keys) the stranded edge, which is exactly the state
 * this diagnostic reports as missing. A `repoint` segment stands where a
 * translation key carries its hex source digest, so the two key families
 * never collide.
 */
function recordSkippedReferrerRepointDiagnostic(
    db: Database,
    referencingId: number,
    supersededById: number,
    reason: MemoryClaimLinkFailureReason,
): void {
    const now = Date.now();
    db.prepare(
        `INSERT INTO claim_backfill_failures
            (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
         VALUES ('relationships', 'supersession', ?, ?, ?, 'blocking', ?, ?)
         ON CONFLICT(phase, item_kind, item_key)
         DO UPDATE SET reason_code = excluded.reason_code, detail = excluded.detail,
                       disposition = 'blocking', updated_at = excluded.updated_at`,
    ).run(
        `memory:${referencingId}:relations:repoint:${supersededById}`,
        reason,
        JSON.stringify({ supersededByMemoryId: supersededById }),
        now,
        now,
    );
}

/**
 * Authorized cross-project MOVE of a claim-linked row. The crosswalk is
 * append-only and keyed by memory id, so a linked row can never re-link to a
 * second numeric project in place. The move therefore inserts a fresh
 * projection row at the target (carrying stats, embedding, and verification
 * mappings), creates the target claim for it, retires the source claim with
 * cross-project lineage only when no live sibling link remains, repoints
 * sibling supersession references, and deletes the source row — whose durable
 * link survives the delete.
 */
export function moveLinkedMemoryAcrossProjects(
    db: Database,
    rowId: number,
    fromProjectPath: string,
    toIdentity: string,
    targetProjectId: number,
    sourceLink: MemoryClaimLink,
): boolean {
    const current = db.prepare("SELECT project_path FROM memories WHERE id = ?").get(rowId) as
        | { project_path: string }
        | undefined;
    if (current?.project_path !== fromProjectPath) return false;
    const sourceRow = readMemoryProjectionRow(db, rowId);
    if (sourceRow) translateMemoryClaimRelationshipsInCurrentTransaction(db, sourceRow);
    const referencingIds = (
        db
            .prepare("SELECT id FROM memories WHERE superseded_by_memory_id = ? ORDER BY id")
            .all(rowId) as Array<{ id: number }>
    ).map((row) => row.id);
    const repointableIds: number[] = [];
    const adoptedReferrers: Array<{
        row: MemoryProjectionRow;
        link: MemoryClaimLink;
        projectId: number;
    }> = [];
    for (const referencingId of referencingIds) {
        const referencingRow = readMemoryProjectionRow(db, referencingId);
        if (!referencingRow) continue;
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(
            db,
            referencingRow.project_path,
        );
        const failure = memoryClaimAdoptionFailureReason(referencingRow, projectId);
        if (projectId === null || failure !== null) {
            // An unadoptable referrer cannot carry the relationship snapshot
            // the v84 guard demands, so the repoint below must leave it
            // pointing at the deleted source row. Record the stranded edge as
            // a blocking diagnostic for the repair lane instead of letting
            // the guard abort the whole move.
            recordSkippedReferrerRepointDiagnostic(
                db,
                referencingId,
                rowId,
                failure ?? "unresolved-project-identity",
            );
            continue;
        }
        const referrerWasLinked = readMemoryClaimLink(db, referencingId) !== null;
        const referrerLink = ensureMemoryClaimLinkInCurrentTransaction(
            db,
            referencingRow,
            projectId,
            { kind: "migration" },
        );
        if (!referrerWasLinked) {
            adoptedReferrers.push({ row: referencingRow, link: referrerLink, projectId });
        }
        translateMemoryClaimRelationshipsInCurrentTransaction(db, referencingRow);
        repointableIds.push(referencingId);
    }

    const columns = getMemoryCopyColumns(db);
    const selectExprs = columns.map((c) => (c === "project_path" ? "? AS project_path" : c));
    const inserted = db
        .prepare(
            `INSERT INTO memories (${columns.join(", ")})
             SELECT ${selectExprs.join(", ")} FROM memories WHERE id = ?`,
        )
        .run(toIdentity, rowId) as { lastInsertRowid?: number | bigint };
    const newId = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(newId) || newId <= 0) {
        throw new Error(`cross-project memory move produced no target row for memory ${rowId}`);
    }
    db.prepare(
        `INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, model_id)
         SELECT ?, embedding, model_id FROM memory_embeddings WHERE memory_id = ?`,
    ).run(newId, rowId);
    if (hasMemoryStatsTable(db)) {
        db.prepare(
            `UPDATE memory_stats
                SET (seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at) =
                    (SELECT seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at
                       FROM memory_stats WHERE memory_id = ?)
              WHERE memory_id = ?`,
        ).run(rowId, newId);
    }
    db.prepare(
        `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
         SELECT ?, file_path, verified_at, mapped_at FROM memory_verifications WHERE memory_id = ?`,
    ).run(newId, rowId);
    if (repointableIds.length > 0) {
        // Only referrers whose current lineage is snapshotted may change
        // their lineage columns; the v84 relationship guard aborts the
        // UPDATE for any other row.
        db.prepare(
            `UPDATE memories SET superseded_by_memory_id = ?
              WHERE superseded_by_memory_id = ? AND id IN (${repointableIds.map(() => "?").join(", ")})`,
        ).run(newId, rowId, ...repointableIds);
    }

    runMemoryClaimOperationInCurrentTransaction(
        db,
        relocationEnvelope("move", { rowId, newId, toIdentity }),
        () => {
            const newRow = readMemoryProjectionRow(db, newId);
            if (!newRow) throw new Error(`moved memory row ${newId} vanished inside its move`);
            const newLink = ensureMemoryClaimLinkInCurrentTransaction(db, newRow, targetProjectId, {
                kind: "migration",
            });
            const stateEffects = syncAdoptedRelocationClaimState(
                db,
                newRow,
                newLink,
                targetProjectId,
                RELOCATION_PRODUCER,
            );
            // Shared-claim rule: the source claim holds the max-rank state
            // across its surviving linked projections. The moved row's link
            // stays behind on the source claim but its memories row deletes
            // below, so its next status is archived; a live sibling link
            // (dedup branch, project-path aliases) keeps the claim live.
            // Mirrors the status/delete kernels — the supersession recorder
            // below only suppresses the lineage edge, not this state change.
            const sourceStateEffects: MemoryClaimEffect[] = [];
            const desiredSourceState = sharedClaimStateFromLiveLinks(
                db,
                sourceLink.claimId,
                rowId,
                "archived",
            );
            if (
                readCurrentClaimSemanticState(db, sourceLink.claimId).state !== desiredSourceState
            ) {
                if (desiredSourceState === "archived") {
                    retireMemoryClaimInCurrentTransaction(
                        db,
                        sourceLink.claimId,
                        RELOCATION_PRODUCER,
                    );
                } else {
                    setClaimLifecycleStateInCurrentTransaction(
                        db,
                        sourceLink.claimId,
                        desiredSourceState,
                    );
                }
                sourceStateEffects.push({
                    effectKey: `memory:${rowId}:lifecycle`,
                    projectId: sourceLink.projectId,
                    claimId: sourceLink.claimId,
                    effectType: "lifecycle",
                });
            }
            const supersessionRecorded = recordMemoryClaimSupersessionInCurrentTransaction(
                db,
                sourceLink,
                newLink,
            );
            const effects: MemoryClaimEffect[] = [
                {
                    effectKey: `memory:${newId}:upsert`,
                    projectId: targetProjectId,
                    claimId: newLink.claimId,
                    effectType: "upsert",
                },
                ...stateEffects,
                ...sourceStateEffects,
            ];
            if (supersessionRecorded) {
                effects.push({
                    effectKey: `memory:${newId}:supersede`,
                    projectId: targetProjectId,
                    claimId: newLink.claimId,
                    effectType: "evidence",
                });
            }
            // The inserted copy inherits the source row's merged_from /
            // superseded_by_memory_id under a fresh id, so no relationship
            // source exists for it yet. Translating here records that source
            // row (which the v84 relationship guards check before any later
            // mutation or delete) and re-links the lineage edges to the
            // target claim.
            effects.push(...translateMemoryClaimRelationshipsInCurrentTransaction(db, newRow));
            // A referrer first adopted by the repoint loop above holds a
            // fresh claim with no outbox effect of its own — the relationship
            // translations attach their effects to the TARGET claims — so the
            // boundary reconciliation oracle would flag its crosswalk row as
            // missing an outbox effect forever (the row is linked, so the
            // backfill skips it). Emit the first-adoption upsert here, inside
            // the move envelope, and run the full adopted-claim sync:
            // adoption can dedup onto a canonical claim archived by a prior
            // delete of the referrer's equivalent, so the claim state
            // re-derives from the live referrer row and the row's verified
            // status carries onto the claim as evidence.
            for (const adopted of adoptedReferrers) {
                effects.push({
                    effectKey: `memory:${adopted.link.memoryId}:upsert`,
                    projectId: adopted.projectId,
                    claimId: adopted.link.claimId,
                    effectType: "upsert",
                });
                effects.push(
                    ...syncAdoptedRelocationClaimState(
                        db,
                        adopted.row,
                        adopted.link,
                        adopted.projectId,
                        RELOCATION_PRODUCER,
                    ),
                );
            }
            for (const referencingId of referencingIds) {
                const referencingRow = readMemoryProjectionRow(db, referencingId);
                if (referencingRow) {
                    effects.push(
                        ...translateMemoryClaimRelationshipsInCurrentTransaction(
                            db,
                            referencingRow,
                        ),
                    );
                }
            }
            return { result: newLink.claimId, effects };
        },
    );

    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(rowId);
    db.prepare("DELETE FROM memories WHERE id = ?").run(rowId);
    return true;
}

function rekeyMemoryRowWithCollisionMergeInner(
    db: Database,
    rowId: number,
    fromProjectPath: string,
    toIdentity: string,
): boolean {
    const statsBacked = hasMemoryStatsTable(db);
    const seenCountSql = effectiveSeenCountSql(db);
    const row = db
        .prepare(
            `SELECT category, normalized_hash, ${seenCountSql}
               FROM memories WHERE id = ? AND project_path = ?`,
        )
        .get(rowId, fromProjectPath) as
        | { category: string; normalized_hash: string; seen_count: number | null }
        | undefined;
    if (!row) return false;
    const claimsActive = hasMemoryClaimsCompatSchema(db);

    const collision = db
        .prepare(
            `SELECT id, ${seenCountSql} FROM memories
             WHERE project_path = ? AND category = ? AND normalized_hash = ?
             LIMIT 1`,
        )
        .get(toIdentity, row.category, row.normalized_hash) as
        | { id: number; seen_count: number | null }
        | undefined;

    if (collision && collision.id !== rowId) {
        // The canonical claim and both crosswalk links must exist BEFORE the
        // source row deletes: the v84 boundary guard refuses to delete an
        // unlinked boundary row. An unadoptable target — or an unlinked
        // unadoptable source — cannot anchor those links, so the merge is
        // skipped there (fail-visible diagnostic, source row preserved)
        // before any stats or embedding mutation.
        if (claimsActive && !adoptRelocationMergeClaims(db, rowId, collision.id, toIdentity)) {
            return false;
        }
        // requireEffectiveSeenCount rejects a NULL stats read on a v80 database
        // (a missing stats row is corruption) before the merge computes a
        // default count and deletes the source row. The check lives inside the
        // merge branch so a plain rekey — which never consumes seen_count —
        // still succeeds for such a row.
        const sourceSeen = requireEffectiveSeenCount(db, rowId, row.seen_count);
        const targetSeen = requireEffectiveSeenCount(db, collision.id, collision.seen_count);
        const mergedSeen = Math.max(targetSeen, sourceSeen);
        if (mergedSeen !== targetSeen) {
            if (statsBacked) {
                db.prepare("UPDATE memory_stats SET seen_count = ? WHERE memory_id = ?").run(
                    mergedSeen,
                    collision.id,
                );
            } else {
                db.prepare("UPDATE memories SET seen_count = ? WHERE id = ?").run(
                    mergedSeen,
                    collision.id,
                );
            }
        }
        // Preserve an embedding on the surviving target BEFORE the source row's
        // embedding FK-cascades away on DELETE (memory_embeddings.memory_id
        // REFERENCES memories(id) ON DELETE CASCADE). INSERT OR IGNORE keeps the
        // target's existing embedding when it has one; otherwise it adopts the
        // source's — so a merged memory never ends up with NO vector (the two are
        // equivalent: same category + normalized_hash, so either vector is valid).
        db.prepare(
            `INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, model_id)
             SELECT ?, embedding, model_id FROM memory_embeddings WHERE memory_id = ?`,
        ).run(collision.id, rowId);
        db.prepare("DELETE FROM memories WHERE id = ?").run(rowId);
        return true;
    }

    if (claimsActive) {
        const targetProjectId = requireRelocationTargetProject(db, toIdentity);
        const link = readMemoryClaimLink(db, rowId);
        if (link && link.projectId !== targetProjectId) {
            return moveLinkedMemoryAcrossProjects(
                db,
                rowId,
                fromProjectPath,
                toIdentity,
                targetProjectId,
                link,
            );
        }
        if (!link) {
            const projectionRow = readMemoryProjectionRow(db, rowId);
            if (!projectionRow) return false;
            const failure = memoryClaimAdoptionFailureReason(projectionRow, targetProjectId);
            if (failure !== null) {
                // A claim-invalid row (empty content, bad metadata) cannot
                // acquire the crosswalk link the boundary identity guard
                // demands before the project_path UPDATE, so the rekey skips
                // it fail-visible (blocking diagnostic) instead of aborting
                // the caller's batch.
                recordMemoryClaimLinkFailure(db, rowId, toIdentity, failure);
                return false;
            }
            adoptRelocationRekeyClaim(db, rowId, targetProjectId);
        }
    }

    const result = db
        .prepare("UPDATE memories SET project_path = ? WHERE id = ? AND project_path = ?")
        .run(toIdentity, rowId, fromProjectPath) as { changes?: number };
    return (result.changes ?? 0) > 0;
}

export interface RelocateResult {
    /** Rows rekeyed/inserted under the target identity. */
    relocated: number;
    /** Rows merged into a pre-existing equivalent at the target (move only). */
    merged: number;
    /** Rows skipped because an equivalent already existed at the target (copy only). */
    skipped: number;
}

/**
 * MOVE a set of memory ids from `fromProjectPath` to `toIdentity`. The source
 * project loses them. Collision-safe (merge into an existing equivalent at the
 * target). Embeddings follow automatically (memory_id is unchanged on a rekey,
 * FK-cascade on a merge-delete). MUST run inside a transaction.
 */
export function moveMemoriesToProject(
    db: Database,
    ids: number[],
    fromProjectPath: string,
    toIdentity: string,
): RelocateResult {
    return withMemoryClaimGenerationContextInCurrentTransaction(db, () => {
        let relocated = 0;
        let merged = 0;
        for (const id of ids) {
            // Detect the merge branch by checking for a pre-existing equivalent
            // before the rekey, so we can report move-vs-merge accurately.
            const row = db
                .prepare(
                    "SELECT category, normalized_hash FROM memories WHERE id = ? AND project_path = ?",
                )
                .get(id, fromProjectPath) as
                | { category: string; normalized_hash: string }
                | undefined;
            if (!row) continue;
            const collision = db
                .prepare(
                    `SELECT id FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ? LIMIT 1`,
                )
                .get(toIdentity, row.category, row.normalized_hash) as { id: number } | undefined;
            const changed = rekeyMemoryRowWithCollisionMerge(db, id, fromProjectPath, toIdentity);
            if (!changed) continue;
            if (collision && collision.id !== id) merged += 1;
            else relocated += 1;
        }
        return { relocated, merged, skipped: 0 };
    });
}

const memoryCopyColumnsCache = new WeakMap<Database, string[]>();
function getMemoryCopyColumns(db: Database): string[] {
    const cached = memoryCopyColumnsCache.get(db);
    if (cached) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    // Every column EXCEPT the autoincrement id — the copy gets a fresh id.
    const names = columns
        .map((c) => c.name)
        .filter((n): n is string => typeof n === "string" && n !== "id");
    memoryCopyColumnsCache.set(db, names);
    return names;
}

/**
 * COPY a set of memory ids under `toIdentity`, leaving the source rows intact.
 * Each copy gets a fresh id; its embedding (if any) is duplicated. Collision-safe
 * via INSERT OR IGNORE against the UNIQUE constraint — a row already present at
 * the target is skipped (no duplicate). `project_path` is overridden to the
 * target; all other columns (including source_session_id and timestamps) are
 * preserved for provenance. MUST run inside a transaction.
 */
export function copyMemoriesToProject(
    db: Database,
    ids: number[],
    toIdentity: string,
): RelocateResult {
    if (hasMemoryClaimsCompatSchema(db)) {
        return withClaimsWriteCapabilityInCurrentTransaction(db, () =>
            withMemoryClaimGenerationContextInCurrentTransaction(db, () =>
                copyMemoriesToProjectInner(db, ids, toIdentity),
            ),
        );
    }
    return copyMemoriesToProjectInner(db, ids, toIdentity);
}

function copyMemoriesToProjectInner(
    db: Database,
    ids: number[],
    toIdentity: string,
): RelocateResult {
    const columns = getMemoryCopyColumns(db);
    const selectExprs = columns.map((c) => (c === "project_path" ? "? AS project_path" : c));
    const insertSql = `INSERT OR IGNORE INTO memories (${columns.join(", ")})
        SELECT ${selectExprs.join(", ")} FROM memories WHERE id = ?`;
    const insertStmt = db.prepare(insertSql);
    const copyEmbeddingStmt = db.prepare(
        `INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, model_id)
         SELECT ?, embedding, model_id FROM memory_embeddings WHERE memory_id = ?`,
    );
    // The copy gets a fresh id, so a bare INSERT cannot conflict. The rows
    // must land before the claim adoption below: adoption derives the copied
    // claim's verified event from the side table, and compat readers filter
    // on these mappings. Callers migrating from external harness databases
    // may lack the side table entirely, so the copy is probed like
    // memory_stats.
    const copyVerificationsStmt = db
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_verifications'",
        )
        .get()
        ? db.prepare(
              `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
               SELECT ?, file_path, verified_at, mapped_at FROM memory_verifications WHERE memory_id = ?`,
          )
        : null;
    const copyStatsStmt = hasMemoryStatsTable(db)
        ? db.prepare(
              `UPDATE memory_stats
                  SET (seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at) =
                      (SELECT seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at
                         FROM memory_stats WHERE memory_id = ?)
                WHERE memory_id = ?`,
          )
        : null;
    const claimsActive = hasMemoryClaimsCompatSchema(db);
    const targetProjectId = claimsActive ? requireRelocationTargetProject(db, toIdentity) : null;
    let relocated = 0;
    let skipped = 0;
    for (const id of ids) {
        if (targetProjectId !== null) {
            const source = readMemoryProjectionRow(db, id);
            const failure = source
                ? memoryClaimAdoptionFailureReason(source, targetProjectId)
                : null;
            if (failure !== null) {
                // A claim-invalid source row (empty content, bad metadata)
                // cannot acquire the target-project link its copy needs, so
                // the copy skips it fail-visible (blocking diagnostic)
                // instead of aborting the caller's batch.
                recordMemoryClaimLinkFailure(db, id, toIdentity, failure);
                skipped += 1;
                continue;
            }
        }
        const result = insertStmt.run(toIdentity, id) as {
            changes?: number;
            lastInsertRowid?: number | bigint;
        };
        if ((result.changes ?? 0) > 0) {
            relocated += 1;
            const newId = Number(result.lastInsertRowid);
            copyEmbeddingStmt.run(newId, id);
            copyStatsStmt?.run(id, newId);
            copyVerificationsStmt?.run(newId, id);
            // The copy is an authorized operation that creates a target
            // claim; the source row and its claim stay intact.
            if (targetProjectId !== null) {
                adoptRelocationRekeyClaim(db, newId, targetProjectId);
            }
        } else {
            skipped += 1;
        }
    }
    return { relocated, merged: 0, skipped };
}
