import { type ContextLimitProvenance } from "../../shared/context-limit-provenance";
import type { Database } from "../../shared/sqlite";
import type { ContextUsage } from "./types";
export declare function isEmergencyRecoveryArmed(sessionId: string): boolean;
export declare function isProviderOverflowReconfirmed(sessionId: string): boolean;
export declare function getEmergencyRecoveryArmedAt(sessionId: string): number | null;
export declare function resetEmergencyRecoveryRegistryForTest(): void;
export interface PersistedNoteNudge {
    triggerPending: boolean;
    triggerMessageId: string | null;
    stickyText: string | null;
    stickyMessageId: string | null;
}
export interface NoteNudgeAnchor {
    messageId: string;
    text: string;
}
export type AutoSearchHintNoHintReason = "below-threshold" | "timeout" | "empty" | "error" | "stacked" | "too-short" | "policy-reset";
export type AutoSearchHintDecision = {
    messageId: string;
    decision: "hint";
    text: string;
    /**
     * Memories whose fragments the hint text carries, each bound to the
     * normalized content hash that produced it. Replay gates re-check
     * both against live state so a memory hidden after the hint was
     * computed — or rewritten in place, even if the replacement later
     * becomes eligible — stops being served; a decision without the
     * field (written before the field existed, or reseeded through a
     * lane that drops it) cannot prove its fragments are clean and
     * fails closed under an effective claim policy.
     */
    memoryFragments?: Array<{
        id: number;
        hash: string;
    }>;
    /**
     * The native module block id (`messageId#blockIndex`) this decision
     * was last seeded under. Recorded on the first successful raw-block
     * resolution so a later revocation can reach the module's stored
     * hint row even when the raw message can no longer be loaded.
     */
    nativeBlockId?: string;
} | {
    messageId: string;
    decision: "no-hint";
    reason: AutoSearchHintNoHintReason;
    /** See the hint variant: last-seeded native module block id. */
    nativeBlockId?: string;
};
export type NoteNudgeDeliveryOutcome = {
    ok: true;
    kind: "appended";
} | {
    ok: true;
    kind: "already-present";
} | {
    ok: false;
    kind: "conflict";
} | {
    ok: false;
    kind: "cas-exhausted";
};
export type AppendAutoSearchHintOutcome = {
    ok: true;
    kind: "appended";
    decision: AutoSearchHintDecision;
} | {
    ok: true;
    kind: "already-present";
    decision: AutoSearchHintDecision;
} | {
    ok: false;
    kind: "cas-exhausted";
};
export interface PersistedTodoSyntheticAnchor {
    callId: string;
    messageId: string;
    /**
     * Snapshot JSON of the todos as they existed at the moment we injected.
     * Source of truth for defer-pass replay so the prefix bytes stay
     * identical across T0-cache-bust → T1-defer even when a real
     * `todowrite` mutates `last_todo_state` between T0 and T1.
     */
    stateJson: string;
}
export interface PersistedHistorianFailureState {
    failureCount: number;
    lastError: string | null;
    lastFailureAt: number | null;
}
export interface PersistedUsageState {
    usage: ContextUsage;
    updatedAt: number;
    lastObservedModelKey: string | null;
    lastUsageContextLimit: number;
}
export interface ProtectedTailMeta {
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    protectedTailDrainWindowStartedAt: number;
    protectedTailDrainTokens: number;
    recoveryNoEligibleHeadCount: number;
    forceEmergencyBypassWindowStart: number;
    forceEmergencyBypassUsed: number;
    emergencyDrainActive: number;
    historianDrainFailureAt: number;
}
export interface ProtectedTailSeedResult extends ProtectedTailMeta {
    seeded: boolean;
}
export interface ProtectedTailDrainReservation {
    sessionId: string;
    runId: string;
    tokens: number;
}
export interface ProtectedTailDrainReserveResult {
    ok: boolean;
    reservedTokens: number;
    overQuotaBypass: boolean;
    reservation: ProtectedTailDrainReservation | null;
    skippedReason?: string;
}
export interface WrapupInProgressState {
    holderId: string;
    acquiredAt: number;
    expiresAt: number;
    messagesToKeep: number;
    anchorRawMessageCount: number;
    targetEligibleEndOrdinal: number;
    lastCompartmentEnd: number;
    chunkIndex: number;
    expectedChunks: number;
    updatedAt: number;
}
export type AcquireWrapupResult = {
    ok: true;
    state: WrapupInProgressState;
} | {
    ok: false;
    state: WrapupInProgressState | null;
};
export declare function loadPersistedUsage(db: Database, sessionId: string): PersistedUsageState | null;
export declare function loadProtectedTailMeta(db: Database, sessionId: string): ProtectedTailMeta;
export declare function markProtectedTailPolicyV3Seeded(db: Database, sessionId: string, priorBoundaryOrdinal: number): ProtectedTailSeedResult;
export declare function recordProtectedTailPublicationFloor(db: Database, sessionId: string, floorOrdinal: number): void;
export declare function recordProtectedTailNoEligibleHead(db: Database, sessionId: string): number;
export declare function resetProtectedTailNoEligibleHead(db: Database, sessionId: string): void;
export declare const DRAIN_WINDOW_MS: number;
export declare const WRAPUP_IN_PROGRESS_TTL_MS: number;
export declare function getWrapupInProgressState(db: Database, sessionId: string, now?: number): WrapupInProgressState | null;
export declare function isWrapupInProgress(db: Database, sessionId: string, now?: number): boolean;
export declare function acquireWrapupInProgress(db: Database, sessionId: string, state: Omit<WrapupInProgressState, "acquiredAt" | "expiresAt" | "updatedAt">, now?: number): AcquireWrapupResult;
export declare function updateWrapupInProgress(db: Database, sessionId: string, holderId: string, updates: Partial<Omit<WrapupInProgressState, "holderId" | "acquiredAt">>, now?: number): WrapupInProgressState | null;
export declare function releaseWrapupInProgress(db: Database, sessionId: string, holderId: string): void;
/**
 * Per-session compaction mode record. Stored in the `compaction_mode_record`
 * column added by migration v72. Value domain:
 *   - NULL  → no record (treated as "on" by the transition logic, so a
 *             pre-existing row is unambiguously no-record; a session with no
 *             record that boots into compaction-off mode runs the off cleanup)
 *   - "on" / "off" → settled mode for this session
 *   - "on_notice_pending" / "off_notice_pending" → the matching mode is
 *     already active, but its out-of-band transition notice must be retried
 *     after a restart until delivery succeeds
 *   - "off_cleanup_pending" → off mode is active while marker cleanup awaits
 *     a later verification pass; this keeps cleanup retry durable after its
 *     notice has already been delivered
 *
 * Helpers use a simple UPDATE under the session row (no compare-and-swap)
 * because there is a single writer per session on the transform path.
 * clearSession() needs no change (the column is row-scoped).
 */
export type CompactionModeRecord = "on" | "off" | "on_notice_pending" | "off_notice_pending" | "off_cleanup_pending";
export type ResolvedCompactionModeRecord = "on" | "off";
/** Resolves transient delivery/cleanup records to the mode their gates must use. */
export declare function resolveCompactionModeRecord(record: CompactionModeRecord | null): ResolvedCompactionModeRecord | null;
/** Reads the persisted compaction mode record for a session. NULL → no record. */
export declare function getCompactionModeRecord(db: Database, sessionId: string): CompactionModeRecord | null;
/**
 * Writes the compaction mode record for a session. Ensures the session_meta row
 * exists first. Pass `null` to clear the record (no record). Only supported
 * settled or transient `CompactionModeRecord` values (or null) are accepted;
 * any other value throws (defensive — callers should pass a typed record).
 */
export declare function setCompactionModeRecord(db: Database, sessionId: string, value: CompactionModeRecord | null): void;
export declare function protectedTailWindowBudget(usagePercentage: number, usable: number, perRunCap: number): number;
/**
 * The latch exits when usage falls this far BELOW the execute threshold, leaving
 * headroom for a normal execute cycle to resume after the drops (exiting exactly
 * at the threshold would immediately re-enter the force-fire band).
 */
export declare const EMERGENCY_DRAIN_EXIT_MARGIN = 10;
/**
 * Fallback exit threshold when the execute threshold is unknown/0 (schema default
 * execute threshold is 65 → 65 − 10 = 55).
 */
export declare const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE = 55;
/**
 * After a genuine historian FAILURE, suppress the latch bypass for this long so a
 * broken historian backs off instead of retry-thrashing every pass under the latch.
 */
export declare const EMERGENCY_DRAIN_FAILURE_BACKOFF_MS = 60000;
/**
 * Self-expiry backstop: clear the latch once it has been active this long, in case
 * a high irreducible floor (system + tools + m[0]/m[1] + protected tail) keeps usage
 * above the exit threshold forever and a usage-driven exit never fires.
 */
export declare const EMERGENCY_DRAIN_MAX_LATCH_MS: number;
/** Resolve the usage % below which the emergency drain latch clears. */
export declare function emergencyDrainExitThreshold(executeThresholdPercentage: number): number;
export declare function reserveProtectedTailDrainTokens(args: {
    db: Database;
    sessionId: string;
    runId: string;
    trueRawTokens: number;
    usagePercentage: number;
    usable: number;
    perRunCap: number;
    executeThresholdPercentage: number;
    now?: number;
}): ProtectedTailDrainReserveResult;
/** Clear the emergency drain catch-up latch (called when the historian no-ops on
 *  an exhausted tail — nothing left to drain, so the latch has done its job). */
export declare function clearEmergencyDrainLatch(db: Database, sessionId: string): void;
/** Record a genuine historian drain FAILURE (model error / no output). Suppresses
 *  the latch bypass for EMERGENCY_DRAIN_FAILURE_BACKOFF_MS. */
export declare function recordHistorianDrainFailure(db: Database, sessionId: string, now?: number): void;
/** Clear the historian drain-failure backoff (called on a successful publish). */
export declare function clearHistorianDrainFailure(db: Database, sessionId: string): void;
export declare function rollbackProtectedTailDrainReservation(db: Database, reservation: ProtectedTailDrainReservation | null): void;
export declare function getPersistedReasoningWatermark(db: Database, sessionId: string): number;
export declare function setPersistedReasoningWatermark(db: Database, sessionId: string, tagNumber: number): void;
/**
 * Reset the persisted reasoning watermark for a session. Used during model
 * switches to make sure stale reasoning state from the previous model does
 * not leak into pressure or replay decisions for the new one.
 */
export declare function clearPersistedReasoningWatermark(db: Database, sessionId: string): void;
export declare function getEmergencyInputSample(db: Database, sessionId: string): number;
/**
 * Latch the usage sample on every emergency acting pass, including when the
 * selector finds no eligible target. This stops repeated cache busts on the same
 * stale sample; the 95% block remains the backstop for genuine "nothing left to drop".
 */
export declare function setEmergencyDropSample(db: Database, sessionId: string, inputSample: number): void;
export declare function clearEmergencyDropSample(db: Database, sessionId: string): void;
export type PersistedChannel1NudgeLevel = "" | "gentle" | "firm" | "urgent";
export declare function getLastNudgeUndropped(db: Database, sessionId: string): number;
export declare function setLastNudgeUndropped(db: Database, sessionId: string, value: number): void;
export declare function getLastNudgeLevel(db: Database, sessionId: string): PersistedChannel1NudgeLevel;
export declare function setLastNudgeLevel(db: Database, sessionId: string, value: PersistedChannel1NudgeLevel): void;
export declare function resetLastNudgeCycle(db: Database, sessionId: string): void;
/**
 * Clear the persisted Channel-1 cadence/band state when a fresh baseline sees
 * that the reclaimable tail already shrank below the old watermark.
 *
 * Why this exists: historian publication, emergency eviction, or pending-op
 * replay can shrink the tail WITHOUT a `ctx_reduce` tool call. The old nudge then
 * referred to a pile that no longer exists, so a regrowth must start a new
 * gentle→firm→urgent cycle instead of inheriting a stale persisted band.
 */
export declare function resetLastNudgeCycleIfTailShrank(db: Database, sessionId: string, measuredUndropped: number): boolean;
export type Channel2NudgeState = "" | "pending" | "claimed" | "delivered";
export declare function getChannel2NudgeState(db: Database, sessionId: string): Channel2NudgeState;
export declare function getChannel2NudgeClaimedAt(db: Database, sessionId: string): number;
export interface Channel2NudgeClaim {
    state: Channel2NudgeState;
    claimedAt: number;
    claimToken: string;
}
export declare function getChannel2NudgeClaim(db: Database, sessionId: string): Channel2NudgeClaim;
export declare function setChannel2NudgeState(db: Database, sessionId: string, state: Channel2NudgeState): void;
/**
 * Atomically move the Channel-2 lease from one state to another. Returns true
 * only if the row was in `from` and is now `to` — a cross-process CAS so two
 * concurrent processes can't both claim+deliver the single ceiling nudge.
 */
export declare function casChannel2NudgeState(db: Database, sessionId: string, from: Channel2NudgeState, to: Channel2NudgeState): boolean;
export declare function claimChannel2NudgeState(db: Database, sessionId: string, claimToken: string): boolean;
export declare function casChannel2NudgeClaim(db: Database, sessionId: string, to: Channel2NudgeState, claimToken: string): boolean;
export declare function getPersistedNoteNudge(db: Database, sessionId: string): PersistedNoteNudge;
export declare function setPersistedNoteNudgeTrigger(db: Database, sessionId: string, triggerMessageId?: string): void;
export declare function setPersistedNoteNudgeTriggerMessageId(db: Database, sessionId: string, triggerMessageId: string): void;
export declare function clearPersistedNoteNudge(db: Database, sessionId: string): void;
export declare function getNoteNudgeAnchors(db: Database, sessionId: string): NoteNudgeAnchor[];
export declare function getAutoSearchHintDecisions(db: Database, sessionId: string): AutoSearchHintDecision[];
/**
 * Record the native module block id a decision was seeded under. Idempotent;
 * a lost write only delays revocation-independence until the next successful
 * raw resolution, so CAS exhaustion is tolerated silently.
 */
export declare function recordAutoSearchHintNativeBlockId(db: Database, sessionId: string, messageId: string, nativeBlockId: string): void;
export declare function appendNoteNudgeAnchor(db: Database, sessionId: string, messageId: string, text: string): boolean;
export declare function deliverNoteNudgeAtomic(db: Database, sessionId: string, messageId: string, text: string): NoteNudgeDeliveryOutcome;
export declare function appendAutoSearchHintDecision(db: Database, sessionId: string, entry: AutoSearchHintDecision): AppendAutoSearchHintOutcome;
export declare function pruneNoteNudgeAnchors(db: Database, sessionId: string, visibleMessageIds: Set<string>): number;
export declare function pruneAutoSearchHintDecisions(db: Database, sessionId: string, visibleMessageIds: Set<string>): number;
export declare function removeNoteNudgeAnchorByMessageId(db: Database, sessionId: string, messageId: string): boolean;
export declare function removeAutoSearchHintDecisionByMessageId(db: Database, sessionId: string, messageId: string): boolean;
export declare function getPersistedTodoPermissionDenied(db: Database, sessionId: string): boolean | null;
export declare function setPersistedTodoPermissionDenied(db: Database, sessionId: string, denied: boolean): void;
export declare function getPersistedTodoSyntheticAnchor(db: Database, sessionId: string): PersistedTodoSyntheticAnchor | null;
export declare function setPersistedTodoSyntheticAnchor(db: Database, sessionId: string, callId: string, messageId: string, stateJson: string): void;
export declare function clearPersistedTodoSyntheticAnchor(db: Database, sessionId: string): void;
/**
 * Return the timestamp of the most recent ctx_note(read) call for this session,
 * or 0 when the session has never called it. Used by note-nudger to suppress
 * reminders when the agent has already seen notes in recent context.
 */
export declare function getNoteLastReadAt(db: Database, sessionId: string): number;
/**
 * Record that ctx_note(read) was just called for this session. The watermark is
 * compared against note updated_at / created_at on each nudge decision.
 */
export declare function setNoteLastReadAt(db: Database, sessionId: string, at?: number): void;
export declare function getHistorianFailureState(db: Database, sessionId: string): PersistedHistorianFailureState;
/** Records a failure and returns the new consecutive-failure count (callers may
 *  ignore the return). The count drives whether a failure notice is framed as
 *  transient (low count — Magic Context will just retry) or escalated to an
 *  actionable "your historian model needs attention" notice (persistent). */
export declare function incrementHistorianFailure(db: Database, sessionId: string, error: string): number;
export declare function clearHistorianFailureState(db: Database, sessionId: string): void;
export type EmergencyRecoveryOrigin = "provider_overflow" | "proactive_model_shrink";
export interface PersistedOverflowState {
    /** Provider-reported context limit from the overflow error; 0 means none detected. */
    detectedContextLimit: number;
    /** Model key that produced the detected limit, when known. */
    detectedContextLimitModelKey: string | null;
    /** Whether the detected number is prompt-only, combined, or ambiguous. */
    detectedContextLimitProvenance: ContextLimitProvenance;
    /** True while emergency recovery is still required. */
    needsEmergencyRecovery: boolean;
    /** Why recovery was armed; null for unarmed or untyped legacy state. */
    emergencyRecoveryOrigin: EmergencyRecoveryOrigin | null;
}
export declare function getOverflowState(db: Database, sessionId: string, modelKey?: string | null): PersistedOverflowState;
/**
 * Arm emergency recovery with its source. Provider overflow is the default;
 * proactive model-shrink callers must pass that origin explicitly. A parsed
 * provider limit is persisted transactionally with the arm. Repeating a provider
 * overflow while recovery is already durable records a process-local reconfirmation.
 */
export declare function recordOverflowDetected(db: Database, sessionId: string, reportedLimit: number | undefined, modelKey?: string | null, origin?: EmergencyRecoveryOrigin, provenance?: ContextLimitProvenance): void;
/**
 * Record the real provider-reported context limit WITHOUT arming emergency
 * recovery. Used for subagent overflow: the limit is useful data for accurate
 * pressure math (consumed by `resolveContextLimit()` via `getOverflowState()`),
 * but subagents can't run historian so the recovery flag would be orphan state.
 */
export declare function recordDetectedContextLimit(db: Database, sessionId: string, reportedLimit: number, modelKey?: string | null, provenance?: ContextLimitProvenance): void;
/** Clear the recovery flag. Keeps the detected limit (valuable even after recovery). */
export declare function clearEmergencyRecovery(db: Database, sessionId: string): void;
/**
 * Clear the detected limit. Called when the session switches to a different
 * model — the old limit is no longer relevant.
 */
export declare function clearDetectedContextLimit(db: Database, sessionId: string): void;
export interface PersistedCompactionMarkerState {
    boundaryMessageId: string;
    summaryMessageId: string;
    compactionPartId: string;
    summaryPartId: string;
    /** The raw ordinal at which the boundary was set */
    boundaryOrdinal: number;
    /** OpenCode message id of the compartment target used to resolve this marker. */
    targetEndMessageId: string | null;
}
export declare function getPersistedCompactionMarkerState(db: Database, sessionId: string): PersistedCompactionMarkerState | null;
export declare function setPersistedCompactionMarkerState(db: Database, sessionId: string, state: PersistedCompactionMarkerState | null): void;
export declare function getStrippedPlaceholderIds(db: Database, sessionId: string): Set<string>;
export declare function setStrippedPlaceholderIds(db: Database, sessionId: string, ids: Set<string>): void;
/**
 * Compare-and-swap a delta (add/remove) onto the persisted stripped-placeholder
 * set, retrying on a concurrent write so sibling OpenCode/Pi processes sharing
 * the session DB merge instead of clobbering each other's discovered IDs.
 *
 * The mutation is expressed as a delta (not a whole-set overwrite) precisely so
 * the CAS retry is meaningful: each attempt re-reads the current set, re-applies
 * `(current ∪ add) \ remove`, and CAS-writes against the exact bytes it read.
 * A whole-set overwrite would re-apply a stale-read-derived set and silently
 * undo a sibling's concurrent change.
 *
 * Returns true when the set ended in the intended state (incl. no-op), false
 * only when retries were exhausted.
 */
export declare function applyStrippedPlaceholderDelta(db: Database, sessionId: string, delta: {
    add?: Iterable<string>;
    remove?: Iterable<string>;
}): boolean;
export declare function removeStrippedPlaceholderId(db: Database, sessionId: string, messageId: string): boolean;
/**
 * Assistant message ids whose merged-run reasoning neutralization has already
 * been first-applied on a cache-busting pass. The set is replayed on every pass
 * and never shrinks while the session exists, so tail growth or a fresh object
 * rebuild cannot introduce a new prefix mutation on a defer pass.
 */
export declare function getMergedReasoningStrippedIds(db: Database, sessionId: string): Set<string>;
/**
 * Atomically merge assistant message ids into the persisted applied set. Persistence
 * must succeed before callers first mutate newly detected messages; otherwise a
 * later defer pass could not reproduce those bytes from a fresh rebuild.
 */
export declare function addMergedReasoningStrippedIds(db: Database, sessionId: string, ids: Iterable<string>): boolean;
export type PersistedTrailingBlankDecision = "keep" | `keep:${number}` | "strip";
/**
 * Read each assistant's replay choice. A historical choice is immutable; the live
 * newest assistant may replace its choice until a later assistant freezes it.
 */
export declare function getTrailingBlankDecisions(db: Database, sessionId: string): Map<string, PersistedTrailingBlankDecision>;
/** Persist new decisions, optionally refreshing the still-live newest assistant. */
export declare function addTrailingBlankDecisions(db: Database, sessionId: string, additions: Iterable<readonly [string, PersistedTrailingBlankDecision]>, options?: {
    overwriteMessageId?: string;
}): boolean;
/**
 * Message ids whose ctx_reduce parts have been sentinel-stripped because they
 * aged past the protected window. This set is the FROZEN replay watermark for
 * `dropStaleReduceCalls`: it advances ONLY on cache-busting passes (where the
 * wire is allowed to change) and is replayed verbatim on every pass. Replaying
 * a frozen id set — instead of recomputing a live `messages.length - protected`
 * boundary every pass — is what keeps defer passes byte-identical: tail growth
 * can never push an older ctx_reduce call past a moving boundary and strip it
 * mid-prefix on a defer pass (which busts the Anthropic prompt cache).
 */
export declare function getStaleReduceStrippedIds(db: Database, sessionId: string): Set<string>;
/**
 * CAS-merge new aged ctx_reduce message ids into the frozen set, retrying on a
 * concurrent write so sibling processes sharing the session DB merge instead of
 * clobbering. Returns true when the set ended in the intended state (incl.
 * no-op), false only when retries were exhausted.
 */
export declare function addStaleReduceStrippedIds(db: Database, sessionId: string, ids: Iterable<string>): boolean;
/**
 * Message ids whose processed-image file parts have been sentinel-stripped.
 * Frozen replay watermark for `stripProcessedImages`, identical in purpose to
 * `stale_reduce_stripped_ids`: it advances ONLY on cache-busting passes and is
 * replayed verbatim every pass, so an aged image message can never have its
 * images first-removed on a defer pass (which busts the Anthropic prompt cache,
 * because the empty sentinel is filtered off the Anthropic wire).
 */
export declare function getProcessedImageStrippedIds(db: Database, sessionId: string): Set<string>;
/**
 * CAS-merge new processed-image message ids into the frozen set, retrying on a
 * concurrent write so sibling processes sharing the session DB merge instead of
 * clobbering. Returns true when the set ended in the intended state (incl.
 * no-op), false only when retries were exhausted.
 */
export declare function addProcessedImageStrippedIds(db: Database, sessionId: string, ids: Iterable<string>): boolean;
/**
 * Payload stored in `session_meta.pending_compaction_marker_state` between
 * a background historian/compressor publish and its consuming pass in the
 * transform. The transform's drain step CAS-compares this blob against its
 * own copy so concurrent publishers don't double-clear.
 *
 * `endMessageId` lets the consuming pass validate the marker target is still
 * present (raw OpenCode message + compartment row), then write
 * `PersistedCompactionMarkerState` and clear pending atomically.
 *
 * Stored as a JSON string via `stableStringify` for byte-identical CAS.
 * Absence is signalled as SQL NULL, NEVER as `""` — the migration v13 column
 * is intentionally declared without a DEFAULT clause and is excluded from
 * `healNullTextColumns`.
 */
export interface PendingCompactionMarker {
    /** Raw ordinal at which the marker should land. */
    ordinal: number;
    /** OpenCode message ID at the end of the compartment target. */
    endMessageId: string;
    /** Unix ms of publication. Diagnostic only; used by doctor stale-pending checks. */
    publishedAt: number;
}
export interface DeferredExecutePayload {
    id: string;
    reason: string;
    recordedAt: number;
}
export declare function getPendingCompactionMarkerState(db: Database, sessionId: string): PendingCompactionMarker | null;
/**
 * Write or clear the pending-marker blob.
 *
 * Setting `state === null` writes SQL NULL (NOT `""`) so the absence sentinel
 * stays consistent across upgrades. Stringification uses `stableStringify`
 * so callers can later CAS-compare with the same serializer.
 */
export declare function setPendingCompactionMarkerState(db: Database, sessionId: string, state: PendingCompactionMarker | null): void;
/**
 * Compare-and-swap clear: only writes NULL when the currently-stored blob
 * matches `expected` byte-for-byte. Returns true if the CAS succeeded (we
 * cleared the row), false if the row had drifted (another publish overwrote
 * it; that publish's own consuming pass owns the heal).
 *
 * Used by the transform postprocess drain to clear pending without racing
 * a newer background publish: if Publish A's drain reads blob_X then Publish
 * B overwrites with blob_Y before A's CAS runs, A's CAS fails and B's
 * pending stays intact for B's own next consuming pass.
 */
export declare function clearPendingCompactionMarkerStateIf(db: Database, sessionId: string, expected: PendingCompactionMarker): boolean;
/**
 * Payload stored in `session_meta.pending_pi_compaction_marker_state` between
 * a Pi historian/recomp publication and the next materializing Pi context pass.
 * Stored with `stableStringify` so CAS clear can compare byte-for-byte.
 */
export interface PendingPiCompactionMarker {
    firstKeptEntryId: string;
    endMessageId: string;
    ordinal: number;
    tokensBefore: number;
    summary: string;
    publishedAt: number;
}
export declare function getPendingPiCompactionMarkerState(db: Database, sessionId: string): PendingPiCompactionMarker | null;
export declare function setPendingPiCompactionMarkerState(db: Database, sessionId: string, state: PendingPiCompactionMarker | null): void;
export declare function clearPendingPiCompactionMarkerStateIf(db: Database, sessionId: string, expected: PendingPiCompactionMarker): boolean;
export declare function getSessionsWithPendingPiMarker(db: Database): string[];
export declare function peekDeferredExecutePending(db: Database, sessionId: string): DeferredExecutePayload | null;
export declare function setDeferredExecutePendingIfAbsent(db: Database, sessionId: string, payload: DeferredExecutePayload): boolean;
export declare function clearDeferredExecutePendingIfMatches(db: Database, sessionId: string, expected: DeferredExecutePayload): boolean;
/**
 * List all sessions with a deferred marker still pending. Used at hook init
 * to re-seed `deferredHistoryRefreshSessions` and
 * `deferredMaterializationSessions` after a plugin restart — without this,
 * a publish that ran before a crash would lose its deferred-history signal
 * and the next transform pass would not consume the marker.
 *
 * Defensive `!= ''` filter: even though setter writes NULL, an earlier
 * codepath or external write could have left an empty string. Treat both as
 * absent.
 */
export declare function getSessionsWithPendingMarker(db: Database): string[];
export declare function setSessionWorkMetrics(db: Database, sessionId: string, newWorkTokens: number, totalInputTokens: number): void;
export declare function getSessionWorkMetrics(db: Database, sessionId: string): {
    newWorkTokens: number;
    totalInputTokens: number;
};
//# sourceMappingURL=storage-meta-persisted.d.ts.map