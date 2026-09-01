/**
 *
 * The manager runs marker mutations after compartment publication.
 *
 * The marker makes `filterCompacted` stop at the boundary.
 * transform receives only the live tail.
 */

import { join } from "node:path";
import {
    closeCompactionMarkerDb,
    compareOpenCodeMessagesByCanonicalOrder,
    findBoundaryUserMessage,
    getOpenCodeMessageById,
    injectCompactionMarker,
    listSessionCompactionMarkers,
    removeCompactionMarker,
    removeForeignCompactionMarker,
} from "../../features/magic-context/compaction-marker";
import { getCompartmentsByEndMessageId } from "../../features/magic-context/compartment-storage";
import {
    clearPendingCompactionMarkerStateIf,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    type PersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getTagNumberByMessageId,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { getDataDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { Database as SqliteDb } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

/** The transform injects the real session history. */
export const MARKER_SUMMARY_TEXT =
    "[Compacted by magic-context — session history is managed by the plugin]";

function dropMarkerSummaryTag(db: Database, sessionId: string, summaryMessageId: string): void {
    const tagNumber = getTagNumberByMessageId(db, sessionId, `${summaryMessageId}:p0`);
    if (tagNumber !== null) updateTagStatus(db, sessionId, tagNumber, "dropped");
}

function persistMarkerStateAndDropReplacedTag(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState | null,
    replacedSummaryMessageId: string | null,
): void {
    db.transaction(() => {
        setPersistedCompactionMarkerState(db, sessionId, state);
        if (replacedSummaryMessageId !== null) {
            dropMarkerSummaryTag(db, sessionId, replacedSummaryMessageId);
        }
    })();
}

/**
 *
 * Applied, already-current, and stale requests can clear their pending blob.
 * Retryable failures keep the pending blob and deferred-history signal so the next consuming pass can repeat the deterministic mutation.
 */
export type MarkerUpdateOutcome =
    | {
          kind: "applied";
          markerOrdinal: number;
      }
    | { kind: "already-current" }
    | {
          kind: "stale-skip";
          reason: "compartment-removed" | "target-superseded";
      }
    | { kind: "retryable-failure"; error: Error };

/**
 * `pending` must still identify the published compartment.
 *
 * The raw OpenCode message at `pending.endMessageId` must exist; recompilation, revert, or partial recompilation can remove the deferred target before the consuming pass.
 * Matching both fields detects compartmentalization changes that preserve the raw message but resequence or redistribute boundaries.
 *
 * Returns `"ok"` only when both checks pass.
 * Return `"compartment-removed"` when the raw message or compartment row is absent.
 * Return `"target-superseded"` when the row at `pending.endMessageId` has an ordinal other than `pending.ordinal`.
 *
 * The consuming pass maps DB-access failures to `retryable-failure`.
 */
function validatePendingTarget(
    db: Database,
    sessionId: string,
    pending: PendingCompactionMarker,
): "ok" | "compartment-removed" | "target-superseded" {
    // `getOpenCodeMessageById` may throw on DB failure; the outer catch returns `retryable-failure`.
    const ocMessage = getOpenCodeMessageById(sessionId, pending.endMessageId);
    if (!ocMessage) {
        return "compartment-removed";
    }

    const compartments = getCompartmentsByEndMessageId(db, sessionId, pending.endMessageId);
    if (compartments.length === 0) {
        return "compartment-removed";
    }
    if (compartments.length > 1) {
        // Multiple compartments for one `endMessageId` return `compartment-removed` rather than selecting one.
        log(
            `[magic-context][${sessionId}] WARNING: ${compartments.length} compartments share endMessageId=${pending.endMessageId} — schema invariant violated; treating as stale`,
        );
        return "compartment-removed";
    }
    const compartment = compartments[0];
    if (compartment.endMessage !== pending.ordinal) {
        return "target-superseded";
    }
    return "ok";
}

function getCompartmentEndMessageIdForOrdinal(
    db: Database,
    sessionId: string,
    endOrdinal: number,
): string | null {
    const row = db
        .prepare(
            `SELECT end_message_id
             FROM compartments
             WHERE session_id = ? AND end_message = ?
             ORDER BY sequence DESC
             LIMIT 1`,
        )
        .get(sessionId, endOrdinal) as { end_message_id?: unknown } | undefined;
    return typeof row?.end_message_id === "string" && row.end_message_id.length > 0
        ? row.end_message_id
        : null;
}

function existingMarkerAlreadyCoversTarget(
    sessionId: string,
    existing: NonNullable<ReturnType<typeof getPersistedCompactionMarkerState>>,
    targetOrdinal: number,
    targetEndMessageId: string,
): boolean {
    if (existing.boundaryOrdinal < targetOrdinal) {
        return false;
    }

    if (existing.boundaryOrdinal === targetOrdinal) {
        const boundaryCompare = compareOpenCodeMessagesByCanonicalOrder(
            sessionId,
            existing.boundaryMessageId,
            targetEndMessageId,
        );
        if (boundaryCompare === null || boundaryCompare > 0) {
            return false;
        }
        if (
            existing.targetEndMessageId !== null &&
            existing.targetEndMessageId !== targetEndMessageId
        ) {
            return false;
        }
        return true;
    }

    // A different ordinal means the deferred target no longer matches the published compartment.
    if (existing.targetEndMessageId !== null) {
        const targetCompare = compareOpenCodeMessagesByCanonicalOrder(
            sessionId,
            existing.targetEndMessageId,
            targetEndMessageId,
        );
        if (targetCompare !== null && targetCompare <= 0) {
            return false;
        }
    }

    return true;
}

/**
 *
 * Returns one of four outcomes; the drain interprets each:
 * `applied` → CAS-clear pending.
 *   - `already-current` → CAS-clear pending (boundary already at this ordinal)
 *   - `stale-skip`      → CAS-clear pending (target gone or superseded)
 * `retryable-failure` → Keep pending; retry on the next consuming pass.
 *
 * Removal is a no-op for absent rows; deterministic IDs and exact-row upserts make retries idempotent.
 * Deterministic IDs and exact-row upserts reuse a committed marker when its context-state write failed.
 */
export function applyDeferredCompactionMarker(
    db: Database,
    sessionId: string,
    pending: PendingCompactionMarker,
    directory?: string,
): MarkerUpdateOutcome {
    try {
        // The manager validates stale targets before mutating state; DB failures return `retryable-failure`.
        // If stale-target validation throws on a DB failure, the outer catch returns `retryable-failure`.
        const validation = validatePendingTarget(db, sessionId, pending);
        if (validation !== "ok") {
            sessionLog(
                sessionId,
                `compaction-marker drain: stale-skip (${validation}) for ordinal ${pending.ordinal} endMessageId=${pending.endMessageId}`,
            );
            return { kind: "stale-skip", reason: validation };
        }

        const existing = getPersistedCompactionMarkerState(db, sessionId);
        if (
            existing &&
            existingMarkerAlreadyCoversTarget(
                sessionId,
                existing,
                pending.ordinal,
                pending.endMessageId,
            )
        ) {
            return { kind: "already-current" };
        }

        // The manager resolves the replacement boundary first so an unmapped target leaves the existing marker intact.
        const boundary = findBoundaryUserMessage(sessionId, pending.endMessageId);
        if (!boundary) {
            return {
                kind: "retryable-failure",
                error: new Error(
                    `no user boundary found at or before endMessageId ${pending.endMessageId} (ordinal ${pending.ordinal}); preserving existing marker`,
                ),
            };
        }

        // The manager passes the old summary ID when advancing marker state so its tag is removed.
        const removedSummaryMessageId = existing?.summaryMessageId ?? null;
        // An already-missing row is a successful no-op; return `false` only when the DELETE transaction fails.
        // On delete failure, return `retryable-failure` without injecting a replacement marker.
        if (existing) {
            const removed = removeCompactionMarker(existing);
            if (!removed) {
                return {
                    kind: "retryable-failure",
                    error: new Error(
                        `failed to remove old compaction marker at ordinal ${existing.boundaryOrdinal}`,
                    ),
                };
            }
            sessionLog(
                sessionId,
                `compaction-marker drain: removed old boundary at ordinal ${existing.boundaryOrdinal}, advancing to ${pending.ordinal}`,
            );
        }

        const result = injectCompactionMarker({
            sessionId,
            endOrdinal: pending.ordinal,
            endMessageId: pending.endMessageId,
            summaryText: MARKER_SUMMARY_TEXT,
            directory: directory ?? process.cwd(),
            resolvedBoundary: boundary,
        });
        if (!result) {
            return {
                kind: "retryable-failure",
                error: new Error(
                    `injectCompactionMarker returned null for ordinal ${pending.ordinal}; will retry`,
                ),
            };
        }

        persistMarkerStateAndDropReplacedTag(
            db,
            sessionId,
            {
                ...result,
                boundaryOrdinal: pending.ordinal,
                targetEndMessageId: pending.endMessageId,
            },
            removedSummaryMessageId,
        );
        sessionLog(
            sessionId,
            `compaction-marker drain: applied at ordinal ${pending.ordinal}, boundary user msg ${result.boundaryMessageId}`,
        );
        return {
            kind: "applied",
            markerOrdinal: pending.ordinal,
        };
    } catch (err) {
        // Thrown paths:
        const error = err instanceof Error ? err : new Error(String(err));
        sessionLog(
            sessionId,
            `compaction-marker drain: retryable failure for ordinal ${pending.ordinal}:`,
            error,
        );
        return { kind: "retryable-failure", error };
    }
}

/**
 * The manager injects or moves the compaction marker after historian publishes new compartments.
 * The manager only moves the boundary forward; the summary text is a static placeholder.
 *
 * Direct calls require `preserveInjectionCacheUntilConsumed === false`.
 * When `preserveInjectionCacheUntilConsumed` is true, the postprocess drain uses `applyDeferredCompactionMarker`.
 */
export function updateCompactionMarkerAfterPublication(
    db: Database,
    sessionId: string,
    lastCompartmentEnd: number,
    directory?: string,
): boolean {
    // Pi reaches this function through shared recompilation runners.
    // Pi writes its native marker through `pi-recomp-marker.ts`.
    // On Pi-only installs, the `opencode.db` parent directory may not exist.
    // `opencode.db` open failures must not fail recompilation on Pi-only installs.
    // `updateCompactionMarkerAfterPublication` has no OpenCode marker to update, so it returns success.
    if (getHarness() !== "opencode") {
        return true;
    }
    const targetEndMessageId = getCompartmentEndMessageIdForOrdinal(
        db,
        sessionId,
        lastCompartmentEnd,
    );
    if (!targetEndMessageId) {
        sessionLog(
            sessionId,
            `compaction-marker: no compartment endMessageId for ordinal ${lastCompartmentEnd}; preserving existing marker`,
        );
        return false;
    }

    const existing = getPersistedCompactionMarkerState(db, sessionId);
    const removedSummaryMessageId = existing?.summaryMessageId ?? null;

    if (existing) {
        if (
            existingMarkerAlreadyCoversTarget(
                sessionId,
                existing,
                lastCompartmentEnd,
                targetEndMessageId,
            )
        ) {
            // Same/newer boundary — nothing to do (placeholder text never changes).
            return true;
        }
    }

    // `applyDeferredCompactionMarker` leaves the old marker intact when the target is stale or no user exists at or before it.
    // Retaining the old marker avoids cache churn and history-boundary loss.
    const boundary = findBoundaryUserMessage(sessionId, targetEndMessageId);
    if (!boundary) {
        sessionLog(
            sessionId,
            `compaction-marker: no user boundary found at or before endMessageId ${targetEndMessageId} (ordinal ${lastCompartmentEnd}); preserving existing marker`,
        );
        return false;
    }

    if (existing) {
        // `removeCompactionMarker` can return `false`; clear persisted state only after it returns `true`.
        // Clearing persisted state after a failed removal would orphan the old marker rows.
        // If injection also fails, clearing persisted state loses the durable retry path.
        // caller (and the next pass) can retry against the still-persisted state.
        const removed = removeCompactionMarker(existing);
        if (!removed) {
            sessionLog(
                sessionId,
                `compaction-marker: failed to remove old boundary at ordinal ${existing.boundaryOrdinal}; preserving persisted state for retry (not injecting new marker this pass)`,
            );
            return false;
        }
        persistMarkerStateAndDropReplacedTag(db, sessionId, null, removedSummaryMessageId);
        sessionLog(
            sessionId,
            `compaction-marker: removed old boundary at ordinal ${existing.boundaryOrdinal}, moving to ${lastCompartmentEnd}`,
        );
    }

    const result = injectCompactionMarker({
        sessionId,
        endOrdinal: lastCompartmentEnd,
        endMessageId: targetEndMessageId,
        summaryText: MARKER_SUMMARY_TEXT,
        directory: directory ?? process.cwd(),
        resolvedBoundary: boundary,
    });

    if (result) {
        persistMarkerStateAndDropReplacedTag(
            db,
            sessionId,
            {
                ...result,
                boundaryOrdinal: lastCompartmentEnd,
                targetEndMessageId,
            },
            removedSummaryMessageId,
        );
        sessionLog(
            sessionId,
            `compaction-marker: injected at ordinal ${lastCompartmentEnd}, boundary user msg ${result.boundaryMessageId}`,
        );
        return true;
    }
    // `false` preserves callers' pending retry state.
    return false;
}

/**
 * `removeCompactionMarkerForSession` runs during session deletion.
 */
export function removeCompactionMarkerForSession(db: Database, sessionId: string): void {
    const existing = getPersistedCompactionMarkerState(db, sessionId);
    if (existing) {
        try {
            removeCompactionMarker(existing);
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(sessionId, "compaction-marker: removed on session cleanup");
        } catch (error) {
            // Session deletion clears persisted state even when marker removal fails; orphaned OpenCode rows are acceptable.
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(
                sessionId,
                "compaction-marker: removal failed during session cleanup, cleared persisted state:",
                error,
            );
        }
    }
}

/**
 *
 * `removed` counts foreign markers deleted this pass.
 * `failed` indicates that at least one attempted deletion did not complete.
 * `failed` causes the caller to retry during the next degraded pass.
 * fatal error.
 */
export interface OrphanMarkerReconcileResult {
    removed: number;
    failed: boolean;
}

/**
 *
 * OpenCode's `/fork` copies parent magic-context compaction-marker rows without copying persisted marker state.
 * OpenCode re-mints message IDs on fork, so entry-ID-keyed migration is unsafe.
 * `filterCompacted` honors the orphan marker before the newly injected marker.
 * The orphan hides the boundary message, causing `inject-compartments` to degrade.
 *
 * A fork-orphan is a session marker not identified by persisted state as the current marker.
 *
 * Reconciliation treats only markers with `magic-context` summary lineage as fork-orphans.
 * Only boundaries that sort after the owned boundary can outrank the owned marker.
 *
 * Plain DELETEs make concurrent orphan removal idempotent.
 * state below.
 *
 * Callers invoke reconciliation only during degraded mode, so steady-state passes perform no database work.
 * `failed` causes the next degraded pass to retry.
 */
export function reconcileForkOrphanedCompactionMarkers(
    db: Database,
    sessionId: string,
): OrphanMarkerReconcileResult {
    // Only OpenCode sessions have marker rows in `opencode.db` to reconcile.
    if (getHarness() !== "opencode") {
        return { removed: 0, failed: false };
    }

    try {
        // Without persisted marker state, the function cannot identify or protect its own marker.
        const owned = getPersistedCompactionMarkerState(db, sessionId);
        if (!owned) {
            return { removed: 0, failed: false };
        }

        const markers = listSessionCompactionMarkers(sessionId);
        let removed = 0;
        let failed = false;

        for (const marker of markers) {
            if (marker.compactionPartId === owned.compactionPartId) {
                continue; // our own marker
            }
            if (marker.summaryMessageIds.length === 0) {
                continue;
            }
            // Reconciliation skips markers unless canonical ordering proves their boundaries are newer than the owned boundary.
            const ordering = compareOpenCodeMessagesByCanonicalOrder(
                sessionId,
                marker.boundaryMessageId,
                owned.boundaryMessageId,
            );
            if (ordering === null || ordering <= 0) {
                continue;
            }

            // Reconciliation re-reads persisted state before deletion to avoid deleting a marker that became owned after the scan.
            const currentOwned = getPersistedCompactionMarkerState(db, sessionId);
            if (!currentOwned || marker.compactionPartId === currentOwned.compactionPartId) {
                continue;
            }

            const ok = removeForeignCompactionMarker(
                sessionId,
                marker,
                currentOwned.summaryMessageId,
            );
            if (ok) {
                removed += 1;
                sessionLog(
                    sessionId,
                    `compaction-marker hygiene: removed fork-orphaned marker part=${marker.compactionPartId} boundary=${marker.boundaryMessageId} (outranked owned boundary ${currentOwned.boundaryMessageId})`,
                );
            } else {
                failed = true;
            }
        }

        if (removed > 0) {
            log(
                `[magic-context][${sessionId}] compaction-marker hygiene: removed ${removed} fork-orphaned marker(s); filterCompacted will now stop at this session's own marker`,
            );
        }
        return { removed, failed };
    } catch (error) {
        // Reconciliation treats a missing, locked, or schema-incompatible `opencode.db` as nonfatal.
        sessionLog(
            sessionId,
            "compaction-marker hygiene: scan failed (will retry on next degraded pass):",
            error,
        );
        return { removed: 0, failed: true };
    }
}

/**
 */
export function closeCompactionMarkerConnection(): void {
    closeCompactionMarkerDb();
}

/**
 *
 *
 * A missing referenced row leaves phantom persisted state.
 *
 * re-inject cleanly.
 *
 */
export function checkCompactionMarkerConsistency(db: Database): void {
    const opencodeDbPath = join(getDataDir(), "opencode", "opencode.db");
    let opencodeDb: SqliteDb;
    try {
        opencodeDb = new SqliteDb(opencodeDbPath, { readonly: true });
    } catch (error) {
        log(
            `[magic-context] compaction-marker consistency check skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    try {
        const persistedRows = db
            .prepare(
                "SELECT session_id, compaction_marker_state FROM session_meta WHERE compaction_marker_state IS NOT NULL AND compaction_marker_state != ''",
            )
            .all() as Array<{ session_id: string; compaction_marker_state: string }>;

        if (persistedRows.length === 0) return;

        const checkMessage = opencodeDb.prepare("SELECT 1 FROM message WHERE id = ? LIMIT 1");
        const checkPart = opencodeDb.prepare("SELECT 1 FROM part WHERE id = ? LIMIT 1");

        let reconciledCount = 0;

        for (const row of persistedRows) {
            const state = getPersistedCompactionMarkerState(db, row.session_id);
            if (!state) continue;

            // `bun:sqlite` returns `undefined` for missing rows, so the row-existence check uses `!= null`; `!== null` would treat a deleted row as present.
            const boundaryExists = checkMessage.get(state.boundaryMessageId) != null;
            const summaryMessageExists = checkMessage.get(state.summaryMessageId) != null;
            const compactionPartExists = checkPart.get(state.compactionPartId) != null;
            const summaryPartExists = checkPart.get(state.summaryPartId) != null;

            const allPresent =
                boundaryExists && summaryMessageExists && compactionPartExists && summaryPartExists;

            if (allPresent) continue;

            //
            let removedOk = false;
            try {
                removedOk = removeCompactionMarker(state);
            } catch (error) {
                sessionLog(
                    row.session_id,
                    "compaction-marker consistency: partial cleanup of half-written marker failed:",
                    error,
                );
            }

            if (removedOk) {
                setPersistedCompactionMarkerState(db, row.session_id, null);
                sessionLog(
                    row.session_id,
                    `compaction-marker consistency: cleared orphaned state (boundary=${boundaryExists} summary=${summaryMessageExists} cPart=${compactionPartExists} sPart=${summaryPartExists}); next publication will re-inject`,
                );
                reconciledCount++;
            } else {
                sessionLog(
                    row.session_id,
                    `compaction-marker consistency: cleanup failed for orphaned state (boundary=${boundaryExists} summary=${summaryMessageExists} cPart=${compactionPartExists} sPart=${summaryPartExists}); will retry on next startup`,
                );
            }
        }

        if (reconciledCount > 0) {
            log(
                `[magic-context] compaction-marker consistency: reconciled ${reconciledCount} session(s) with orphaned marker state at startup`,
            );
        }
    } catch (error) {
        log(
            `[magic-context] compaction-marker consistency check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        try {
            closeQuietly(opencodeDb);
        } catch {
            // ignore
        }
    }
}
/**
 * Advance the compaction marker after an explicit (eager-cache-clear) publish
 * and CAS-clear any stale pending marker blob a prior in-flight incremental
 * publish may have left behind. The pending blob is cleared ONLY when the
 * boundary actually advanced: on a failed update it is preserved so the
 * deferred drain keeps its durable retry path. Returns whether the boundary
 * advanced.
 */
export function advanceCompactionMarkerAndClearStalePending(
    db: Database,
    sessionId: string,
    ordinal: number,
    directory: string,
): boolean {
    const markerUpdated = updateCompactionMarkerAfterPublication(db, sessionId, ordinal, directory);
    if (markerUpdated) {
        const stalePending = getPendingCompactionMarkerState(db, sessionId);
        if (stalePending) {
            clearPendingCompactionMarkerStateIf(db, sessionId, stalePending);
        }
    }
    return markerUpdated;
}
