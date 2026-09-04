/**
 * Compaction-off mode transitions (issue #266, slice S3).
 *
 * The mode is boot-resolved and process-stable, so a transition is only ever
 * observed on a session's first transform pass after a restart that changed
 * the resolved value. Each session reconciles its durable per-session mode
 * record (`session_meta.compaction_mode_record`: NULL = no record, settled
 * "on"/"off", or durable pending-delivery/cleanup variants) against the
 * resolved mode:
 *
 *   - NULL resolves to "on" (every pre-feature session ran with compaction
 *     enabled), so `no record + configured-off` IS the off-transition — the
 *     upgrade path that guarantees marker cleanup reaches legacy sessions.
 *   - `no record + on` → write "on", no transition work.
 *   - `no record | on  → off` → exactly ONE off-transition per session:
 *       delete MC-owned compaction-marker lineages (canonical + supported
 *       legacy), clear the marker bookkeeping that references those rows,
 *       clear the emergency-recovery latch, clear any persisted Channel-2
 *       pending/claimed intent, clear pre-existing pending_ops, invalidate
 *       the cached m[0]/m[1] baseline (so the off-mode render never replays
 *       an on-mode `<session-history>`), then write "off".
 *   - `off → on` → exactly ONE on-transition: invalidate the cached
 *       m[0]/m[1] baseline (so the dormant compartments' session-history
 *       re-renders before raw-tail trimming resumes), write the historian
 *       catch-up signal (compartmentInProgress, conditioned on the historian
 *       being runnable) and offer the `/ctx-wrapup` suggestion out of band.
 *
 * Crash safety: every cleanup operation is idempotent. A transition that
 * emits a notice stages a durable `*_notice_pending` record before returning
 * to the caller for delivery; a restart therefore retries that notice rather
 * than inferring it from already-cleared state. Duplicate delivery after a
 * crash remains the accepted at-least-once cost.
 *
 * Notices are delivered OUT OF BAND by the caller (the boot-warning /
 * command-output surface) — never into the message array, never through the
 * nudge machinery. A transition pass's message-array output is
 * indistinguishable from a steady-state pass of the resolved mode.
 */
import { type McOwnedMarkerCleanupResult } from "../../features/magic-context/compaction-marker";
import { type CompactionModeRecord } from "../../features/magic-context/storage-meta-persisted";
/**
 * Flip-off unfold notice. Delivered out of band on the transition pass that
 * actually cleared something. The one-cycle warning wording is contractual
 * (spec #266): removing MC's markers exposes the history hidden solely by
 * MC, and on a long session that expansion can exceed the model window once
 * before native compaction reacts. Docs quote this same constant.
 */
export declare const COMPACTION_OFF_FLIP_NOTICE: string;
/**
 * Flip-back suggestion, emitted out of band exactly once per off→on
 * transition and only when the historian is runnable (never advertising an
 * unavailable command). The gap accumulated while off is digested by the
 * normal chunked historian paths; /ctx-wrapup makes it explicit.
 */
export declare const COMPACTION_ON_WRAPUP_SUGGESTION: string;
export interface CompactionModeTransitionResult {
    /**
     * The settled record value the caller commits AFTER emitting `notice`.
     * `*_notice_pending` is staged durably by this reconciler before it returns;
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
export declare function reconcileCompactionMode(args: {
    db: import("../../shared/sqlite").Database;
    sessionId: string;
    /** Boot-resolved mode for this process. */
    compactionOff: boolean;
    /** False when historian.disable=true; conditions the on-transition signal. */
    historianRunnable: boolean;
    /** Pass-local session meta (drives the stale compartmentInProgress clear). */
    compartmentInProgress: boolean;
}): CompactionModeTransitionResult;
/**
 * Commit the mode record AFTER transition work + notice emission. Kept
 * separate so the caller controls the at-least-once notice ordering.
 */
export declare function commitCompactionModeRecord(db: import("../../shared/sqlite").Database, sessionId: string, record: CompactionModeRecord): void;
//# sourceMappingURL=compaction-off-transition.d.ts.map