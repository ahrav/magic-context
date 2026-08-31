/**
 * Compaction-off mode transitions.
 *
 * A session transitions only on its first transform pass after a restart changes the resolved mode.
 * Each session reconciles its durable mode record with the resolved mode.
 * `session_meta.compaction_mode_record` is NULL when absent and otherwise stores a settled or pending-delivery/cleanup mode.
 * resolved mode:
 *
 * `NULL` resolves to `on`.
 * With no record and configured-off mode, a legacy session runs the off-transition.
 * The no-record configured-off path cleans MC-owned markers from legacy sessions.
 * When no record exists and the resolved mode is `on`, the session writes `on` without transition work.
 * A session performs the off-transition once when its record is absent or `on` and the resolved mode is `off`.
 * The off-transition deletes canonical and supported legacy MC-owned compaction-marker lineages.
 * The off-transition clears marker bookkeeping that references deleted rows.
 * The off-transition clears the emergency-recovery latch and persisted Channel-2 intent.
 * The off-transition clears pre-existing `pending_ops` and invalidates the cached `m[0]/m[1]` baseline.
 * The off-transition invalidates cached `m[0]/m[1]` so off-mode rendering cannot replay on-mode `<session-history>`.
 * The off-transition writes `off` after cleanup.
 * A session performs the on-transition once when its record is `off` and the resolved mode is `on`.
 * The on-transition invalidates cached `m[0]/m[1]` so dormant compartments re-render session history.
 * The on-transition restores session-history rendering before raw-tail trimming resumes.
 * The on-transition writes `compartmentInProgress` only when the historian is runnable.
 *
 * Every cleanup operation is idempotent.
 * A notice-emitting transition stages a durable `*_notice_pending` record before returning to the caller.
 * A restart retries a staged notice instead of inferring it from cleared state.
 * A crash can duplicate notice delivery.
 * Notice delivery is at least once.
 *
 * The caller delivers notices out of band through the boot-warning or command-output surface.
 * The caller never delivers notices through the message array or nudge machinery.
 * A transition pass produces the same message-array output as steady state under the resolved mode.
 */

import { existsSync } from "node:fs";
import {
    getOpenCodeDbPath,
    type McOwnedMarkerCleanupResult,
    removeMcOwnedCompactionMarkers,
} from "../../features/magic-context/compaction-marker";
import {
    clearPendingOps,
    getPendingOps,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    type CompactionModeRecord,
    clearEmergencyRecovery,
    clearPendingCompactionMarkerStateIf,
    getChannel2NudgeState,
    getCompactionModeRecord,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    resolveCompactionModeRecord,
    setChannel2NudgeState,
    setCompactionModeRecord,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";

let loggedUnverifiedMarkerCleanupRetry = false;

/**
 * Flip-off unfold notice. Delivered out of band on the transition pass that
 * actually cleared something. The one-cycle warning wording is contractual
 * (per the compaction-off spec): removing MC's markers exposes the history hidden solely by
 * MC, and on a long session that expansion can exceed the model window once
 * before native compaction reacts. Docs quote this same constant.
 */
export const COMPACTION_OFF_FLIP_NOTICE = [
    "## Magic Context — compaction-off mode is now active",
    "",
    "Magic Context no longer manages this session's context window; native compaction (or nothing) owns it. Memory, dreamer, notes and ctx_search stay live.",
    "",
    "Magic Context's compaction markers for this session were removed, so history previously hidden by them becomes visible again — the first turn after disabling may trigger one native compaction cycle on long sessions.",
].join("\n");

/**
 * The on-transition offers the `/ctx-wrapup` suggestion out of band only when the historian is runnable.
 * The on-transition offers the `/ctx-wrapup` suggestion only when the historian is runnable.
 */
export const COMPACTION_ON_WRAPUP_SUGGESTION = [
    "## Magic Context — compaction re-enabled",
    "",
    "Context-window management resumed for this session. History that grew while compaction was off will be picked up by the historian automatically; run `/ctx-wrapup` to digest the backlog now in bounded chunks.",
].join("\n");

export interface CompactionModeTransitionResult {
    /**
     * null means either the stored mode already matches or a durable cleanup
     * retry remains pending.
     */
    recordToWrite: CompactionModeRecord | null;
    /** Out-of-band notice text; null when the transition emits nothing. */
    notice: string | null;
    /**
     * True when the cached m[0]/m[1] baseline was invalidated. The caller
     * must drop the pass-local session-meta cached bytes too, so this pass's
     * injection re-materializes instead of replaying the pre-flip baseline.
     */
    invalidatedM0Baseline: boolean;
    /** True when the historian catch-up signal (compartmentInProgress) was written. */
    historianCatchUpSignaled: boolean;
    /** True when a stale compartmentInProgress flag was cleared (off mode). */
    clearedCompartmentInProgress: boolean;
    /** True when the off-transition cleared at least one durable MC state item. */
    clearedSomething: boolean;
    /** Marker-row cleanup detail (off-transition only; zeros otherwise). */
    markerCleanup: McOwnedMarkerCleanupResult;
}

const NO_TRANSITION: CompactionModeTransitionResult = {
    recordToWrite: null,
    notice: null,
    invalidatedM0Baseline: false,
    historianCatchUpSignaled: false,
    clearedCompartmentInProgress: false,
    clearedSomething: false,
    markerCleanup: {
        verified: true,
        removedLineages: 0,
        removedRows: 0,
        retainedLineages: 0,
    },
};

/**
 * Null the persisted m[0]/m[1] baseline bytes so the next injection pass
 * re-materializes from the mode's own render rules. The marker columns are
 * left alone: `mustMaterialize` answers `first_render` as soon as the bytes
 * are NULL, before reading any marker, and the fresh materialize overwrites
 * every marker atomically with the bytes it rendered.
 */
function clearCachedM0Baseline(
    db: import("../../shared/sqlite").Database,
    sessionId: string,
): boolean {
    const result = db
        .prepare(
            "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL, cached_m0_mural_data_url = NULL WHERE session_id = ?",
        )
        .run(sessionId);
    return (result.changes ?? 0) > 0;
}

function cleanupOffMarkers(sessionId: string): McOwnedMarkerCleanupResult {
    if (!existsSync(getOpenCodeDbPath())) {
        return { verified: true, removedLineages: 0, removedRows: 0, retainedLineages: 0 };
    }
    return removeMcOwnedCompactionMarkers(sessionId, MARKER_SUMMARY_TEXT);
}

export function reconcileCompactionMode(args: {
    db: import("../../shared/sqlite").Database;
    sessionId: string;
    /** The process resolves this mode at boot. */
    compactionOff: boolean;
    /** The historian-runnable flag is false when `historian.disable` is true and gates the on-transition signal. */
    historianRunnable: boolean;
    /** The pass-local session metadata determines whether off mode clears stale `compartmentInProgress`. */
    compartmentInProgress: boolean;
}): CompactionModeTransitionResult {
    const { db, sessionId } = args;
    const stored = getCompactionModeRecord(db, sessionId);

    // A pending notice wins over a newly resolved configuration: this process
    // may be the first one after a crash, so it must finish the prior
    // transition's at-least-once delivery before reconciling another flip.
    if (stored === "on_notice_pending") {
        return {
            ...NO_TRANSITION,
            recordToWrite: "on",
            notice: COMPACTION_ON_WRAPUP_SUGGESTION,
        };
    }
    const completingOffNotice = stored === "off_notice_pending";

    if (!args.compactionOff && !completingOffNotice) {
        if (stored === null || resolveCompactionModeRecord(stored) === "on") {
            return stored === null ? { ...NO_TRANSITION, recordToWrite: "on" } : NO_TRANSITION;
        }

        // Invalidate the cached baseline FIRST: the off-mode baseline carries
        // no <session-history>, and raw-tail trimming resumes on flip-back.
        // Rebuild the baseline before the first compaction pass so trimming
        // uses the same history range that the renderer will display; otherwise
        // the dormant range could be trimmed without being rendered.
        const invalidatedM0Baseline = clearCachedM0Baseline(db, sessionId);
        let historianCatchUpSignaled = false;
        if (args.historianRunnable) {
            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            historianCatchUpSignaled = true;
        }
        if (!historianCatchUpSignaled) {
            return {
                ...NO_TRANSITION,
                recordToWrite: "on",
                invalidatedM0Baseline,
            };
        }

        // Persist `on_notice_pending` before returning so a later process can retry the notice after a crash or transport failure.
        // After on_notice_pending is persisted, the caller may crash or lose its transport.
        // A later process retries COMPACTION_ON_WRAPUP_SUGGESTION from on_notice_pending.
        setCompactionModeRecord(db, sessionId, "on_notice_pending");
        return {
            ...NO_TRANSITION,
            recordToWrite: "on",
            notice: COMPACTION_ON_WRAPUP_SUGGESTION,
            invalidatedM0Baseline,
            historianCatchUpSignaled,
        };
    }

    if (stored === "off") return NO_TRANSITION;

    if (stored === "off_cleanup_pending") {
        // off_cleanup_pending retries marker cleanup after verification fails.
        // `off_cleanup_pending` resolves to `off` for mode gates.
        const markerCleanup = cleanupOffMarkers(sessionId);
        return {
            ...NO_TRANSITION,
            recordToWrite: markerCleanup.verified ? "off" : null,
            markerCleanup,
        };
    }

    if (!completingOffNotice) {
        setCompactionModeRecord(db, sessionId, "off_notice_pending");
    }
    let clearedSomething = false;

    const markerCleanup = cleanupOffMarkers(sessionId);
    if (markerCleanup.removedRows > 0) clearedSomething = true;

    if (getPersistedCompactionMarkerState(db, sessionId) !== null) {
        setPersistedCompactionMarkerState(db, sessionId, null);
        clearedSomething = true;
    }
    const pendingMarker = getPendingCompactionMarkerState(db, sessionId);
    if (pendingMarker !== null) {
        clearPendingCompactionMarkerStateIf(db, sessionId, pendingMarker);
        clearedSomething = true;
    }

    if (getOverflowState(db, sessionId).needsEmergencyRecovery) {
        clearEmergencyRecovery(db, sessionId);
        clearedSomething = true;
    }

    const channel2State = getChannel2NudgeState(db, sessionId);
    if (channel2State === "pending" || channel2State === "claimed") {
        setChannel2NudgeState(db, sessionId, "");
        clearedSomething = true;
    }

    if (getPendingOps(db, sessionId).length > 0) {
        clearPendingOps(db, sessionId);
        clearedSomething = true;
    }

    //    items above.
    const invalidatedM0Baseline = clearCachedM0Baseline(db, sessionId);

    let clearedCompartmentInProgress = false;
    if (args.compartmentInProgress) {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        clearedCompartmentInProgress = true;
    }

    sessionLog(
        sessionId,
        `compaction-off transition: marker cleanup verified=${markerCleanup.verified}, removed=${markerCleanup.removedLineages} lineage(s)/${markerCleanup.removedRows} row(s), retained=${markerCleanup.retainedLineages}, clearedSomething=${clearedSomething}`,
    );
    if (!markerCleanup.verified && !loggedUnverifiedMarkerCleanupRetry) {
        loggedUnverifiedMarkerCleanupRetry = true;
        sessionLog(
            sessionId,
            "compaction-off transition could not verify complete marker cleanup; durable cleanup retry will run on the next pass",
        );
    }

    const notice = clearedSomething || completingOffNotice ? COMPACTION_OFF_FLIP_NOTICE : null;
    if (!notice && !markerCleanup.verified) {
        setCompactionModeRecord(db, sessionId, "off_cleanup_pending");
    }

    return {
        recordToWrite: notice
            ? markerCleanup.verified
                ? "off"
                : "off_cleanup_pending"
            : markerCleanup.verified
              ? "off"
              : null,
        notice,
        invalidatedM0Baseline,
        historianCatchUpSignaled: false,
        clearedCompartmentInProgress,
        clearedSomething,
        markerCleanup,
    };
}

/**
 */
export function commitCompactionModeRecord(
    db: import("../../shared/sqlite").Database,
    sessionId: string,
    record: CompactionModeRecord,
): void {
    setCompactionModeRecord(db, sessionId, record);
}
