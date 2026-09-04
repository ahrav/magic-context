/**
 * Compaction Marker Manager
 *
 * Coordinates compaction marker injection/update/removal with historian
 * publication. Called after compartments are published. Always-on since
 * v0.21.4 — the `compaction_markers` config knob was removed because the
 * feature is required for sane transform performance on long sessions.
 *
 * The marker summary text is a static placeholder — the real <session-history>
 * is injected by the transform pipeline via inject-compartments.ts. The marker
 * exists solely to make OpenCode's filterCompacted stop at the boundary so the
 * transform receives only the live tail.
 */
import { type PendingCompactionMarker } from "../../features/magic-context/storage-meta-persisted";
import type { Database } from "../../shared/sqlite";
/** Static placeholder. The real session-history comes from transform injection. */
export declare const MARKER_SUMMARY_TEXT = "[Compacted by magic-context \u2014 session history is managed by the plugin]";
/**
 * Result of draining one persisted marker request.
 *
 * Applied, already-current, and stale requests can clear their pending blob.
 * Retryable failures keep both the blob and deferred-history signal so the
 * next consuming pass can repeat the deterministic mutation.
 */
export type MarkerUpdateOutcome = {
    kind: "applied";
    markerOrdinal: number;
} | {
    kind: "already-current";
} | {
    kind: "stale-skip";
    reason: "compartment-removed" | "target-superseded";
} | {
    kind: "retryable-failure";
    error: Error;
};
/**
 * Apply a deferred compaction-marker mutation owned by a specific pending
 * blob. Called from the transform postprocess drain — see
 * `transform-postprocess-phase.ts` Plan v6 §1.
 *
 * Returns one of four outcomes; the drain interprets each:
 *   - `applied`         → CAS-clear pending (we did the work)
 *   - `already-current` → CAS-clear pending (boundary already at this ordinal)
 *   - `stale-skip`      → CAS-clear pending (target gone or superseded)
 *   - `retryable-failure` → KEEP pending (transient failure; next consuming
 *                          pass will retry; another publish may overwrite
 *                          blob and that publish's drain heals)
 *
 * Retrying the full sequence is safe. Removal is a no-op when rows are already
 * absent, and injection uses deterministic IDs with exact-row upserts, so a
 * committed marker whose context-state write failed is reused rather than duplicated.
 */
export declare function applyDeferredCompactionMarker(db: Database, sessionId: string, pending: PendingCompactionMarker, directory?: string): MarkerUpdateOutcome;
/**
 * After historian publishes new compartments, inject or move the compaction marker.
 * Only moves the boundary forward; summary text is a static placeholder.
 *
 * Plan v6: callers in incremental / recomp / partial-recomp paths invoke this
 * directly only when they are NOT deferring (i.e.
 * `preserveInjectionCacheUntilConsumed === false`). Deferred path uses
 * `applyDeferredCompactionMarker` from postprocess drain.
 */
export declare function updateCompactionMarkerAfterPublication(db: Database, sessionId: string, lastCompartmentEnd: number, directory?: string): boolean;
/**
 * Remove the compaction marker for a session (e.g. on session.deleted).
 */
export declare function removeCompactionMarkerForSession(db: Database, sessionId: string): void;
/**
 * Result of a fork-orphan marker hygiene pass (#263).
 *
 * `removed` counts foreign markers deleted this pass. `failed` signals that at
 * least one deletion was attempted but could not complete (e.g. SQLITE_BUSY);
 * the caller treats that as "retry on the next degraded pass" and never as a
 * fatal error.
 */
export interface OrphanMarkerReconcileResult {
    removed: number;
    failed: boolean;
}
/**
 * Fork-orphan compaction-marker hygiene (#263).
 *
 * OpenCode's `/fork` copies the parent session's message rows into the fork —
 * including the parent's magic-context compaction-marker rows — but does NOT
 * inherit magic-context's durable state (PARITY.md gap #25: OpenCode re-mints
 * message ids on fork, so entry-id-keyed migration is unsafe). The fork then
 * injects its own fresh marker at its own (much older) historian boundary, and
 * `filterCompacted` — which walks newest→oldest and stops at the FIRST marker
 * it sees (opencode message-v2.ts `filterCompacted`) — honours the NEWER
 * orphan instead of ours. The visible window is cut at the orphan, our boundary
 * message falls below the cut, and inject-compartments degrades with no
 * recovery path while context usage climbs.
 *
 * A marker row in opencode.db for this session that the durable state does not
 * recognize as its own current marker is a fork-orphan. This pass scans for
 * them and removes the ones that actively outrank ours:
 *
 *   - not owned: `part.id != persisted.compactionPartId`
 *   - magic-context-shaped: carries one of OUR summary messages
 *     (providerID="magic-context") — OpenCode-native /compact markers carry the
 *     real provider id and are never touched
 *   - newer than ours: its boundary message sorts AFTER ours in canonical
 *     order, which is exactly the case where `filterCompacted` stops at the
 *     orphan first. Older foreign markers are harmless (ours already wins) and
 *     are left alone to keep the repair minimally invasive.
 *
 * Removal is idempotent (plain DELETEs) so concurrent processes racing on the
 * same orphan converge on the same end state; the only guarded invariant is
 * never deleting our own marker, re-checked against freshly-read persisted
 * state below.
 *
 * Cost gate: callers invoke this only when degraded mode fires (never on every
 * pass), so steady state pays nothing. Any failure is swallowed and reported
 * via the result so the next degraded pass retries.
 */
export declare function reconcileForkOrphanedCompactionMarkers(db: Database, sessionId: string): OrphanMarkerReconcileResult;
/**
 * Close the writable OpenCode DB connection used for marker injection.
 */
export declare function closeCompactionMarkerConnection(): void;
/**
 * Startup consistency check for compaction markers.
 *
 * Magic Context persists marker state in context.db's `session_meta`, while the
 * actual marker rows (compaction part + summary message + summary part) live in
 * OpenCode's separate `opencode.db`. There is no cross-DB transaction between
 * the two stores, so a crash between writes — or any external cleanup of
 * OpenCode's DB — can leave the two in an inconsistent state:
 *
 * - Phantom state: persisted in context.db but the referenced rows no longer
 *   exist in opencode.db. On next publication, the manager tries to remove a
 *   marker that isn't there, ignores the failure, and re-injects, but the
 *   stale persisted state can also confuse readers that trust it.
 * - Orphaned rows: rows in opencode.db exist without matching context.db
 *   state. Those can't be surfaced from here (we don't track them), but the
 *   natural-healing path already handles them: the next historian publication
 *   moves the boundary forward and the new injection replaces the orphans by
 *   moving filterCompacted past them.
 *
 * This function scans all persisted marker states and, for each one, verifies
 * that the referenced rows still exist in opencode.db. If any referenced row
 * is missing, it treats the marker as inconsistent, attempts to remove
 * whatever rows ARE still present (best-effort cleanup of half-written
 * markers), and clears the persisted state so the next publication can
 * re-inject cleanly.
 *
 * Called once at plugin startup. Safe to call multiple times (idempotent).
 */
export declare function checkCompactionMarkerConsistency(db: Database): void;
//# sourceMappingURL=compaction-marker-manager.d.ts.map