import {
    type ContextLimitProvenance,
    normalizeContextLimitProvenance,
} from "../../shared/context-limit-provenance";
import { escalationBands } from "../../shared/escalation-bands";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";
import { ensureSessionMetaRow } from "./storage-meta-shared";
import type { ContextUsage } from "./types";

const emergencyRecoveryArmedSessions = new Set<string>();
const emergencyRecoveryArmedAtBySession = new Map<string, number>();
const providerOverflowReconfirmedSessions = new Set<string>();

export function isEmergencyRecoveryArmed(sessionId: string): boolean {
    return emergencyRecoveryArmedSessions.has(sessionId);
}

export function isProviderOverflowReconfirmed(sessionId: string): boolean {
    return providerOverflowReconfirmedSessions.has(sessionId);
}

export function getEmergencyRecoveryArmedAt(sessionId: string): number | null {
    return emergencyRecoveryArmedAtBySession.get(sessionId) ?? null;
}

export function resetEmergencyRecoveryRegistryForTest(): void {
    emergencyRecoveryArmedSessions.clear();
    emergencyRecoveryArmedAtBySession.clear();
    providerOverflowReconfirmedSessions.clear();
}

interface PersistedUsageRow {
    last_context_percentage: number;
    last_input_tokens: number;
    last_response_time: number;
    last_observed_model_key: string | null;
    last_usage_context_limit: number | null;
}

interface PersistedReasoningWatermarkRow {
    cleared_reasoning_through_tag: number;
}

interface PersistedNoteNudgeRow {
    note_nudge_trigger_pending: number;
    note_nudge_trigger_message_id: string;
    note_nudge_sticky_text: string;
    note_nudge_sticky_message_id: string;
}

interface PersistedTodoSyntheticAnchorRow {
    todo_synthetic_call_id: string;
    todo_synthetic_anchor_message_id: string;
    todo_synthetic_state_json: string;
}

interface PersistedTodoPermissionRow {
    todo_permission_denied: number;
}

interface PersistedHistorianFailureRow {
    historian_failure_count: number;
    historian_last_error: string | null;
    historian_last_failure_at: number | null;
}

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

export type AutoSearchHintNoHintReason =
    | "below-threshold"
    | "timeout"
    | "empty"
    | "error"
    | "stacked"
    | "too-short"
    | "policy-reset";

export type AutoSearchHintDecision =
    | {
          messageId: string;
          decision: "hint";
          text: string;
          /**
           * `memoryFragments` binds each referenced memory ID to the normalized content hash used to produce the hint.
           */
          memoryFragments?: Array<{ id: number; hash: string }>;
          /**
           * `nativeBlockId` records the `messageId#blockIndex` block under which the decision was seeded.
           */
          nativeBlockId?: string;
      }
    | {
          messageId: string;
          decision: "no-hint";
          reason: AutoSearchHintNoHintReason;
          /** `nativeBlockId` records the last-seeded native module block as `messageId#blockIndex`. */
          nativeBlockId?: string;
      };

export type NoteNudgeDeliveryOutcome =
    | { ok: true; kind: "appended" }
    | { ok: true; kind: "already-present" }
    | { ok: false; kind: "conflict" }
    | { ok: false; kind: "cas-exhausted" };

export type AppendAutoSearchHintOutcome =
    | { ok: true; kind: "appended"; decision: AutoSearchHintDecision }
    | { ok: true; kind: "already-present"; decision: AutoSearchHintDecision }
    | { ok: false; kind: "cas-exhausted" };

export interface PersistedTodoSyntheticAnchor {
    callId: string;
    messageId: string;
    /**
     * `stateJson` snapshots the todos at injection time.
     * `stateJson` preserves identical prefix bytes from T0 cache bust through T1 defer if `todowrite` changes `last_todo_state`.
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
    // `emergencyDrainActive` is `0` when inactive; otherwise it stores the timestamp when the session entered emergency drain catch-up at usage >=95%.
    emergencyDrainActive: number;
    // `historianDrainFailureAt` stores the last historian failure timestamp and suppresses latch bypass during backoff to prevent retry thrashing.
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

export type AcquireWrapupResult =
    | { ok: true; state: WrapupInProgressState }
    | { ok: false; state: WrapupInProgressState | null };

const CAS_RETRY_LIMIT = 5;
const AUTO_SEARCH_NO_HINT_REASONS = new Set<string>([
    "below-threshold",
    "timeout",
    "empty",
    "error",
    "stacked",
    "too-short",
    // A pre-policy hint decision converted to `no-hint` retains its block ID to revoke an already-seeded native hint.
    "policy-reset",
]);

function isPersistedUsageRow(row: unknown): row is PersistedUsageRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
        typeof r.last_response_time === "number" &&
        (typeof r.last_observed_model_key === "string" || r.last_observed_model_key === null) &&
        (typeof r.last_usage_context_limit === "number" || r.last_usage_context_limit === null)
    );
}

function isPersistedReasoningWatermarkRow(row: unknown): row is PersistedReasoningWatermarkRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.cleared_reasoning_through_tag === "number";
}

function isPersistedNoteNudgeRow(row: unknown): row is PersistedNoteNudgeRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.note_nudge_trigger_pending === "number" &&
        typeof r.note_nudge_trigger_message_id === "string" &&
        typeof r.note_nudge_sticky_text === "string" &&
        typeof r.note_nudge_sticky_message_id === "string"
    );
}

function isValidNoteNudgeAnchor(value: unknown): value is NoteNudgeAnchor {
    if (value === null || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return (
        typeof row.messageId === "string" &&
        row.messageId.length > 0 &&
        typeof row.text === "string" &&
        row.text.length > 0
    );
}

function isValidAutoSearchHintDecision(value: unknown): value is AutoSearchHintDecision {
    if (value === null || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    if (typeof row.messageId !== "string" || row.messageId.length === 0) return false;
    if (row.nativeBlockId !== undefined && typeof row.nativeBlockId !== "string") return false;
    if (row.decision === "hint") {
        if (typeof row.text !== "string" || row.text.length === 0) return false;
        return (
            row.memoryFragments === undefined ||
            (Array.isArray(row.memoryFragments) &&
                row.memoryFragments.every(
                    (fragment) =>
                        fragment !== null &&
                        typeof fragment === "object" &&
                        Number.isInteger((fragment as { id?: unknown }).id) &&
                        typeof (fragment as { hash?: unknown }).hash === "string",
                ))
        );
    }
    if (row.decision === "no-hint") {
        return typeof row.reason === "string" && AUTO_SEARCH_NO_HINT_REASONS.has(row.reason);
    }
    return false;
}

function parseJsonArray<T>(
    json: string | null | undefined,
    validator: (value: unknown) => value is T,
): T[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(validator);
    } catch {
        return [];
    }
}

function isPersistedTodoSyntheticAnchorRow(row: unknown): row is PersistedTodoSyntheticAnchorRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.todo_synthetic_call_id === "string" &&
        typeof r.todo_synthetic_anchor_message_id === "string" &&
        typeof r.todo_synthetic_state_json === "string"
    );
}

function isPersistedHistorianFailureRow(row: unknown): row is PersistedHistorianFailureRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.historian_failure_count === "number" &&
        (typeof r.historian_last_error === "string" || r.historian_last_error === null) &&
        (typeof r.historian_last_failure_at === "number" || r.historian_last_failure_at === null)
    );
}

function getDefaultPersistedNoteNudge(): PersistedNoteNudge {
    return {
        triggerPending: false,
        triggerMessageId: null,
        stickyText: null,
        stickyMessageId: null,
    };
}

function getDefaultHistorianFailureState(): PersistedHistorianFailureState {
    return {
        failureCount: 0,
        lastError: null,
        lastFailureAt: null,
    };
}

export function loadPersistedUsage(db: Database, sessionId: string): PersistedUsageState | null {
    const result = db
        .prepare(
            "SELECT last_context_percentage, last_input_tokens, last_response_time, last_observed_model_key, last_usage_context_limit FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (
        !isPersistedUsageRow(result) ||
        (result.last_context_percentage === 0 && result.last_input_tokens === 0)
    ) {
        return null;
    }

    return {
        usage: {
            percentage: result.last_context_percentage,
            inputTokens: result.last_input_tokens,
        },
        updatedAt: result.last_response_time || Date.now(),
        lastObservedModelKey: result.last_observed_model_key,
        lastUsageContextLimit:
            typeof result.last_usage_context_limit === "number"
                ? result.last_usage_context_limit
                : 0,
    };
}

const DEFAULT_PROTECTED_TAIL_META: ProtectedTailMeta = {
    priorBoundaryOrdinal: 1,
    protectedTailPolicyVersion: 0,
    protectedTailDrainWindowStartedAt: 0,
    protectedTailDrainTokens: 0,
    recoveryNoEligibleHeadCount: 0,
    forceEmergencyBypassWindowStart: 0,
    forceEmergencyBypassUsed: 0,
    emergencyDrainActive: 0,
    historianDrainFailureAt: 0,
};

function toProtectedTailMeta(row: unknown): ProtectedTailMeta {
    if (row === null || typeof row !== "object") return { ...DEFAULT_PROTECTED_TAIL_META };
    const r = row as Record<string, unknown>;
    const numberOr = (value: unknown, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return {
        priorBoundaryOrdinal: Math.max(1, numberOr(r.prior_boundary_ordinal, 1)),
        protectedTailPolicyVersion: numberOr(r.protected_tail_policy_version, 0),
        protectedTailDrainWindowStartedAt: numberOr(r.protected_tail_drain_window_started_at, 0),
        protectedTailDrainTokens: numberOr(r.protected_tail_drain_tokens, 0),
        recoveryNoEligibleHeadCount: numberOr(r.recovery_no_eligible_head_count, 0),
        forceEmergencyBypassWindowStart: numberOr(r.force_emergency_bypass_window_start, 0),
        forceEmergencyBypassUsed: numberOr(r.force_emergency_bypass_used, 0),
        emergencyDrainActive: numberOr(r.emergency_drain_active, 0),
        historianDrainFailureAt: numberOr(r.historian_drain_failure_at, 0),
    };
}

export function loadProtectedTailMeta(db: Database, sessionId: string): ProtectedTailMeta {
    ensureSessionMetaRow(db, sessionId);
    const row = db
        .prepare(
            `SELECT prior_boundary_ordinal, protected_tail_policy_version,
                    protected_tail_drain_window_started_at, protected_tail_drain_tokens,
                    recovery_no_eligible_head_count, force_emergency_bypass_window_start,
                    force_emergency_bypass_used, emergency_drain_active, historian_drain_failure_at
             FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId);
    return toProtectedTailMeta(row);
}

export function markProtectedTailPolicyV3Seeded(
    db: Database,
    sessionId: string,
    priorBoundaryOrdinal: number,
): ProtectedTailSeedResult {
    let seeded = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const existing = loadProtectedTailMeta(db, sessionId);
        if (existing.protectedTailPolicyVersion < 3) {
            db.prepare(
                `UPDATE session_meta
                 SET prior_boundary_ordinal = ?, protected_tail_policy_version = 3
                 WHERE session_id = ? AND protected_tail_policy_version < 3`,
            ).run(Math.max(1, Math.floor(priorBoundaryOrdinal)), sessionId);
            seeded = true;
        }
    })();
    return { ...loadProtectedTailMeta(db, sessionId), seeded };
}

export function recordProtectedTailPublicationFloor(
    db: Database,
    sessionId: string,
    floorOrdinal: number,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            `UPDATE session_meta
             SET prior_boundary_ordinal = MAX(COALESCE(prior_boundary_ordinal, 1), ?),
                 recovery_no_eligible_head_count = 0
             WHERE session_id = ?`,
        ).run(Math.max(1, Math.floor(floorOrdinal)), sessionId);
    })();
}

export function recordProtectedTailNoEligibleHead(db: Database, sessionId: string): number {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            `UPDATE session_meta
             SET recovery_no_eligible_head_count = COALESCE(recovery_no_eligible_head_count, 0) + 1
             WHERE session_id = ?`,
        ).run(sessionId);
    })();
    return loadProtectedTailMeta(db, sessionId).recoveryNoEligibleHeadCount;
}

export function resetProtectedTailNoEligibleHead(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET recovery_no_eligible_head_count = 0 WHERE session_id = ?",
        ).run(sessionId);
    })();
}

export const DRAIN_WINDOW_MS = 10 * 60 * 1000;

export const WRAPUP_IN_PROGRESS_TTL_MS = 5 * 60 * 1000;

function parseWrapupState(value: unknown): WrapupInProgressState | null {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(value) as Partial<WrapupInProgressState> | null;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.holderId !== "string" || parsed.holderId.length === 0) return null;
        const numberFields: Array<keyof WrapupInProgressState> = [
            "acquiredAt",
            "expiresAt",
            "messagesToKeep",
            "anchorRawMessageCount",
            "targetEligibleEndOrdinal",
            "lastCompartmentEnd",
            "chunkIndex",
            "expectedChunks",
            "updatedAt",
        ];
        for (const field of numberFields) {
            if (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field])) return null;
        }
        return parsed as WrapupInProgressState;
    } catch {
        return null;
    }
}

function readRawWrapupState(db: Database, sessionId: string): WrapupInProgressState | null {
    const row = db
        .prepare<[string], { wrapup_in_progress_state: string | null }>(
            "SELECT wrapup_in_progress_state FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);
    return parseWrapupState(row?.wrapup_in_progress_state);
}

export function getWrapupInProgressState(
    db: Database,
    sessionId: string,
    now = Date.now(),
): WrapupInProgressState | null {
    const state = readRawWrapupState(db, sessionId);
    if (!state) return null;
    if (state.expiresAt > now) return state;
    try {
        db.exec("BEGIN IMMEDIATE");
    } catch {
        // The transaction path treats an expired marker as absent; a later standalone check reclaims its stale blob.
        return null;
    }
    let finished = false;
    try {
        const current = readRawWrapupState(db, sessionId);
        if (current && current.expiresAt <= now) {
            db.prepare(
                "UPDATE session_meta SET wrapup_in_progress_state = NULL WHERE session_id = ?",
            ).run(sessionId);
        }
        db.exec("COMMIT");
        finished = true;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
    return null;
}

export function isWrapupInProgress(db: Database, sessionId: string, now = Date.now()): boolean {
    return getWrapupInProgressState(db, sessionId, now) !== null;
}

export function acquireWrapupInProgress(
    db: Database,
    sessionId: string,
    state: Omit<WrapupInProgressState, "acquiredAt" | "expiresAt" | "updatedAt">,
    now = Date.now(),
): AcquireWrapupResult {
    const acquiredAt = now;
    const next: WrapupInProgressState = {
        ...state,
        acquiredAt,
        expiresAt: acquiredAt + WRAPUP_IN_PROGRESS_TTL_MS,
        updatedAt: acquiredAt,
    };
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        ensureSessionMetaRow(db, sessionId);
        const current = readRawWrapupState(db, sessionId);
        if (current && current.expiresAt > now && current.holderId !== state.holderId) {
            db.exec("COMMIT");
            finished = true;
            return { ok: false, state: current };
        }
        db.prepare("UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?").run(
            stableStringify(next),
            sessionId,
        );
        db.exec("COMMIT");
        finished = true;
        return { ok: true, state: next };
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
}

export function updateWrapupInProgress(
    db: Database,
    sessionId: string,
    holderId: string,
    updates: Partial<Omit<WrapupInProgressState, "holderId" | "acquiredAt">>,
    now = Date.now(),
): WrapupInProgressState | null {
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        const current = readRawWrapupState(db, sessionId);
        if (!current || current.holderId !== holderId || current.expiresAt <= now) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }
        const next: WrapupInProgressState = {
            ...current,
            ...updates,
            holderId,
            expiresAt: now + WRAPUP_IN_PROGRESS_TTL_MS,
            updatedAt: now,
        };
        db.prepare("UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?").run(
            stableStringify(next),
            sessionId,
        );
        db.exec("COMMIT");
        finished = true;
        return next;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
}

export function releaseWrapupInProgress(db: Database, sessionId: string, holderId: string): void {
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        const current = readRawWrapupState(db, sessionId);
        if (current?.holderId === holderId) {
            db.prepare(
                "UPDATE session_meta SET wrapup_in_progress_state = NULL WHERE session_id = ?",
            ).run(sessionId);
        }
        db.exec("COMMIT");
        finished = true;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
}

/**
 * `NULL` means no record; transition logic treats it as `on`, and sessions that boot in compaction-off mode run off cleanup.
 * `on` and `off` represent the session's settled mode.
 * `on_notice_pending` and `off_notice_pending` mean the matching mode is active, but its transition notice retries after restart until delivery succeeds.
 * `off_cleanup_pending` means off mode remains active while marker cleanup awaits a later verification pass, preserving cleanup retries after notice delivery.
 *
 * Helpers update the session row without compare-and-swap because the transform path has one writer per session.
 * The record is row-scoped, so clearSession() removes it with the row.
 */
export type CompactionModeRecord =
    | "on"
    | "off"
    | "on_notice_pending"
    | "off_notice_pending"
    | "off_cleanup_pending";

export type ResolvedCompactionModeRecord = "on" | "off";

const COMPACTION_MODE_RECORD_VALUES: ReadonlySet<CompactionModeRecord> = new Set([
    "on",
    "off",
    "on_notice_pending",
    "off_notice_pending",
    "off_cleanup_pending",
]);

function normalizeCompactionModeRecord(value: unknown): CompactionModeRecord | null {
    if (value === null || value === undefined) return null;
    if (
        typeof value === "string" &&
        COMPACTION_MODE_RECORD_VALUES.has(value as CompactionModeRecord)
    ) {
        return value as CompactionModeRecord;
    }
    return null;
}

/** The resolver maps transient delivery and cleanup records to the settled mode that controls their gates. */
export function resolveCompactionModeRecord(
    record: CompactionModeRecord | null,
): ResolvedCompactionModeRecord | null {
    switch (record) {
        case "on":
        case "on_notice_pending":
            return "on";
        case "off":
        case "off_notice_pending":
        case "off_cleanup_pending":
            return "off";
        default:
            return null;
    }
}

/* */
export function getCompactionModeRecord(
    db: Database,
    sessionId: string,
): CompactionModeRecord | null {
    const row = db
        .prepare<[string], { compaction_mode_record: string | null }>(
            "SELECT compaction_mode_record FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);
    return normalizeCompactionModeRecord(row?.compaction_mode_record);
}

/**
 */
export function setCompactionModeRecord(
    db: Database,
    sessionId: string,
    value: CompactionModeRecord | null,
): void {
    if (value !== null && !COMPACTION_MODE_RECORD_VALUES.has(value)) {
        throw new Error(
            `Invalid compaction_mode_record value: ${String(value)} (expected a supported compaction mode record or null)`,
        );
    }
    ensureSessionMetaRow(db, sessionId);
    db.prepare("UPDATE session_meta SET compaction_mode_record = ? WHERE session_id = ?").run(
        value,
        sessionId,
    );
}

export function protectedTailWindowBudget(
    usagePercentage: number,
    usable: number,
    perRunCap: number,
): number {
    if (usagePercentage >= 95)
        return Math.min(1_000_000, Math.max(4 * perRunCap, Math.round(0.5 * usable)));
    if (usagePercentage >= 80)
        return Math.min(750_000, Math.max(3 * perRunCap, Math.round(0.35 * usable)));
    return Math.min(500_000, Math.max(perRunCap, Math.round(0.2 * usable)));
}

/**
 * The latch exits at `executeThreshold - 10`, leaving headroom for a normal execute cycle after usage drops.
 */
export const EMERGENCY_DRAIN_EXIT_MARGIN = 10;
/**
 * When the execute threshold is unknown or `0`, the exit threshold is `55` because the schema-default execute threshold is `65` and the hysteresis margin is `10`.
 */
export const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE = 55;
/**
 * A genuine historian failure suppresses the latch bypass for the configured backoff duration to prevent retry thrashing.
 */
export const EMERGENCY_DRAIN_FAILURE_BACKOFF_MS = 60_000;
/**
 * The system expires the latch after its maximum active duration if an irreducible floor prevents usage from falling below the exit threshold.
 */
export const EMERGENCY_DRAIN_MAX_LATCH_MS = 30 * 60 * 1000;

/* */
export function emergencyDrainExitThreshold(executeThresholdPercentage: number): number {
    if (!Number.isFinite(executeThresholdPercentage) || executeThresholdPercentage <= 0) {
        return EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE;
    }
    return Math.max(0, executeThresholdPercentage - EMERGENCY_DRAIN_EXIT_MARGIN);
}

export function reserveProtectedTailDrainTokens(args: {
    db: Database;
    sessionId: string;
    runId: string;
    trueRawTokens: number;
    usagePercentage: number;
    usable: number;
    perRunCap: number;
    executeThresholdPercentage: number;
    now?: number;
}): ProtectedTailDrainReserveResult {
    const now = args.now ?? Date.now();
    const requested = Math.max(0, Math.floor(args.trueRawTokens));
    if (requested === 0) {
        return { ok: true, reservedTokens: 0, overQuotaBypass: false, reservation: null };
    }
    let result: ProtectedTailDrainReserveResult = {
        ok: false,
        reservedTokens: 0,
        overQuotaBypass: false,
        reservation: null,
        skippedReason: "quota exhausted",
    };
    args.db.transaction(() => {
        ensureSessionMetaRow(args.db, args.sessionId);
        let meta = loadProtectedTailMeta(args.db, args.sessionId);
        if (now - meta.protectedTailDrainWindowStartedAt > DRAIN_WINDOW_MS) {
            // The emergency latch persists across window boundaries until usage falls below the safe-zone threshold or the latch expires.
            args.db
                .prepare(
                    `UPDATE session_meta
                     SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 0
                     WHERE session_id = ?`,
                )
                .run(now, args.sessionId);
            meta = loadProtectedTailMeta(args.db, args.sessionId);
        }

        // The transaction persists latch changes before early returns so later passes observe the resolved state.
        const exitThreshold = emergencyDrainExitThreshold(args.executeThresholdPercentage);
        let latchActiveSince = meta.emergencyDrainActive;
        const { forceMaterializationPercentage } = escalationBands(args.executeThresholdPercentage);
        if (args.usagePercentage >= forceMaterializationPercentage) {
            if (latchActiveSince <= 0) latchActiveSince = now;
        } else if (latchActiveSince > 0) {
            const expired = now - latchActiveSince > EMERGENCY_DRAIN_MAX_LATCH_MS;
            if (args.usagePercentage < exitThreshold || expired) latchActiveSince = 0;
        }
        if (latchActiveSince !== meta.emergencyDrainActive) {
            args.db
                .prepare("UPDATE session_meta SET emergency_drain_active = ? WHERE session_id = ?")
                .run(latchActiveSince, args.sessionId);
        }
        const latchActive = latchActiveSince > 0;

        const budget = protectedTailWindowBudget(args.usagePercentage, args.usable, args.perRunCap);
        const remaining = Math.max(0, budget - meta.protectedTailDrainTokens);
        let reserved = Math.min(requested, args.perRunCap, remaining);
        let bypass = false;
        // When the window budget is exhausted, an active latch bypasses it unless historian failure backoff is active.
        // Historian failure backoff disables the latch budget bypass to prevent repeated retries.
        const inFailureBackoff =
            meta.historianDrainFailureAt > 0 &&
            now - meta.historianDrainFailureAt < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS;
        if (reserved <= 0 && latchActive && !inFailureBackoff) {
            reserved = Math.min(requested, args.perRunCap);
            bypass = true;
        }
        if (reserved <= 0) return;
        args.db
            .prepare(
                `UPDATE session_meta
                 SET protected_tail_drain_window_started_at = CASE WHEN protected_tail_drain_window_started_at = 0 THEN ? ELSE protected_tail_drain_window_started_at END,
                     protected_tail_drain_tokens = COALESCE(protected_tail_drain_tokens, 0) + ?
                 WHERE session_id = ?`,
            )
            .run(now, reserved, args.sessionId);
        result = {
            ok: true,
            reservedTokens: reserved,
            overQuotaBypass: bypass,
            reservation: { sessionId: args.sessionId, runId: args.runId, tokens: reserved },
        };
    })();
    return result;
}

/**
 * */
export function clearEmergencyDrainLatch(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET emergency_drain_active = 0 WHERE session_id = ?").run(
            sessionId,
        );
    })();
}

/**
 * Historian drain failure disables the latch bypass for `EMERGENCY_DRAIN_FAILURE_BACKOFF_MS`. */
export function recordHistorianDrainFailure(db: Database, sessionId: string, now?: number): void {
    const ts = now ?? Date.now();
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_drain_failure_at = ? WHERE session_id = ?",
        ).run(ts, sessionId);
    })();
}

/* */
export function clearHistorianDrainFailure(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_drain_failure_at = 0 WHERE session_id = ?",
        ).run(sessionId);
    })();
}

export function rollbackProtectedTailDrainReservation(
    db: Database,
    reservation: ProtectedTailDrainReservation | null,
): void {
    if (!reservation || reservation.tokens <= 0) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, reservation.sessionId);
        db.prepare(
            `UPDATE session_meta
             SET protected_tail_drain_tokens = MAX(0, COALESCE(protected_tail_drain_tokens, 0) - ?)
             WHERE session_id = ?`,
        ).run(reservation.tokens, reservation.sessionId);
    })();
}

export function getPersistedReasoningWatermark(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT cleared_reasoning_through_tag FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    return isPersistedReasoningWatermarkRow(result) ? result.cleared_reasoning_through_tag : 0;
}

export function setPersistedReasoningWatermark(
    db: Database,
    sessionId: string,
    tagNumber: number,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        "UPDATE session_meta SET cleared_reasoning_through_tag = ? WHERE session_id = ?",
    ).run(tagNumber, sessionId);
}

/**
 * Model switches clear the reasoning watermark so prior-model state cannot affect pressure or replay decisions.
 */
export function clearPersistedReasoningWatermark(db: Database, sessionId: string): void {
    setPersistedReasoningWatermark(db, sessionId, 0);
}

// `last_emergency_input_sample` prevents repeated drops for the same provider usage sample.
// A tag-number cursor would exclude active lower-numbered tags after a non-contiguous tier-ordered drop.
// The provider reports pre-drop usage until the next assistant response provides a new sample.
// The watermark prevents a second force-band pass with the same usage sample from over-dropping the active tail.
// Emergency-drop evaluation skips a usage sample already recorded for the active model.
// A model change resets `last_emergency_input_sample` because the usage ceiling changes.
interface PersistedEmergencyInputSampleRow {
    last_emergency_input_sample: number;
}

function isEmergencyInputSampleRow(row: unknown): row is PersistedEmergencyInputSampleRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedEmergencyInputSampleRow).last_emergency_input_sample === "number"
    );
}

export function getEmergencyInputSample(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT last_emergency_input_sample FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return isEmergencyInputSampleRow(result) ? result.last_emergency_input_sample : 0;
}

/**
 * Every emergency acting pass records its usage sample.
 * When the selector finds no eligible target, recording the sample prevents repeated cache busts on that stale sample.
 */
export function setEmergencyDropSample(db: Database, sessionId: string, inputSample: number): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_emergency_input_sample = ? WHERE session_id = ?",
        ).run(Math.max(0, Math.round(inputSample)), sessionId);
    })();
}

export function clearEmergencyDropSample(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_emergency_input_sample = 0 WHERE session_id = ?",
        ).run(sessionId);
    })();
}

// `last_nudge_undropped` stores the `undropped` estimate from the most recent Channel 1 firing.
// `last_nudge_level` stores the highest band surfaced in the current cycle.
// `ctx_reduce` resets `last_nudge_undropped` and `last_nudge_level` so the next accumulation starts a gentle→firm→urgent sequence without repeating a band.
export type PersistedChannel1NudgeLevel = "" | "gentle" | "firm" | "urgent";

interface PersistedLastNudgeUndroppedRow {
    last_nudge_undropped: number;
}

interface PersistedLastNudgeLevelRow {
    last_nudge_level: string;
}

function isLastNudgeUndroppedRow(row: unknown): row is PersistedLastNudgeUndroppedRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedLastNudgeUndroppedRow).last_nudge_undropped === "number"
    );
}

function isLastNudgeLevelRow(row: unknown): row is PersistedLastNudgeLevelRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedLastNudgeLevelRow).last_nudge_level === "string"
    );
}

function normalizeLastNudgeLevel(value: string): PersistedChannel1NudgeLevel {
    return value === "gentle" || value === "firm" || value === "urgent" ? value : "";
}

export function getLastNudgeUndropped(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT last_nudge_undropped FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return isLastNudgeUndroppedRow(result) ? result.last_nudge_undropped : 0;
}

export function setLastNudgeUndropped(db: Database, sessionId: string, value: number): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET last_nudge_undropped = ? WHERE session_id = ?").run(
            Math.max(0, Math.round(value)),
            sessionId,
        );
    })();
}

export function getLastNudgeLevel(db: Database, sessionId: string): PersistedChannel1NudgeLevel {
    const result = db
        .prepare("SELECT last_nudge_level FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return isLastNudgeLevelRow(result) ? normalizeLastNudgeLevel(result.last_nudge_level) : "";
}

export function setLastNudgeLevel(
    db: Database,
    sessionId: string,
    value: PersistedChannel1NudgeLevel,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET last_nudge_level = ? WHERE session_id = ?").run(
            normalizeLastNudgeLevel(value),
            sessionId,
        );
    })();
}

export function resetLastNudgeCycle(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_nudge_undropped = 0, last_nudge_level = '' WHERE session_id = ?",
        ).run(sessionId);
    })();
}

/**
 * The cadence cycle resets when the reclaimable tail falls below its prior watermark.
 *
 * Historian publication, emergency eviction, or pending-op replay can shrink the tail without a `ctx_reduce` tool call.
 * The persisted nudge state can refer to a reclaimable tail that has already shrunk.
 * The reset restarts the gentle→firm→urgent cycle instead of retaining the stale band.
 */
export function resetLastNudgeCycleIfTailShrank(
    db: Database,
    sessionId: string,
    measuredUndropped: number,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const result = db
            .prepare(
                "UPDATE session_meta SET last_nudge_undropped = 0, last_nudge_level = '' WHERE session_id = ? AND last_nudge_undropped > ?",
            )
            .run(sessionId, Math.max(0, Math.round(measuredUndropped)));
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

// `''` means no intent and initializes the state machine.
// `'pending'` means the transform recorded the ceiling condition; the next event delivers it.
// `'claimed'` marks a delivery attempt CAS-claimed before send.
// `channel2_nudge_claimed_at` stores the lease timestamp so boot recovery rewinds only stale claims.
// OpenCode writes `channel2_nudge_claim_token` so a slow sender cannot confirm a lease after another process re-delivers it.
//                re-delivers it.
// `'delivered'` marks a confirmed send and consumes the current tail-reset cycle.
// On send failure, the caller reverts `'claimed'` to `'pending'` so transient errors do not consume the cycle.
// Callers must not re-arm after confirm failure; leave the lease non-pending.
export type Channel2NudgeState = "" | "pending" | "claimed" | "delivered";

interface PersistedChannel2StateRow {
    channel2_nudge_state: string;
}

interface PersistedChannel2ClaimRow {
    channel2_nudge_state?: string;
    channel2_nudge_claimed_at: number;
    channel2_nudge_claim_token?: string | null;
}

function isChannel2StateRow(row: unknown): row is PersistedChannel2StateRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedChannel2StateRow).channel2_nudge_state === "string"
    );
}

export function getChannel2NudgeState(db: Database, sessionId: string): Channel2NudgeState {
    const result = db
        .prepare("SELECT channel2_nudge_state FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    if (!isChannel2StateRow(result)) return "";
    const raw = result.channel2_nudge_state;
    return raw === "pending" || raw === "claimed" || raw === "delivered" ? raw : "";
}

export function getChannel2NudgeClaimedAt(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT channel2_nudge_claimed_at FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return typeof result === "object" &&
        result !== null &&
        typeof (result as PersistedChannel2ClaimRow).channel2_nudge_claimed_at === "number"
        ? (result as PersistedChannel2ClaimRow).channel2_nudge_claimed_at
        : 0;
}

export interface Channel2NudgeClaim {
    state: Channel2NudgeState;
    claimedAt: number;
    claimToken: string;
}

export function getChannel2NudgeClaim(db: Database, sessionId: string): Channel2NudgeClaim {
    const result = db
        .prepare(
            "SELECT channel2_nudge_state, channel2_nudge_claimed_at, channel2_nudge_claim_token FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as PersistedChannel2ClaimRow | null;
    const rawState =
        typeof result?.channel2_nudge_state === "string" ? result.channel2_nudge_state : "";
    const state: Channel2NudgeState =
        rawState === "pending" || rawState === "claimed" || rawState === "delivered"
            ? rawState
            : "";
    return {
        state,
        claimedAt:
            typeof result?.channel2_nudge_claimed_at === "number"
                ? result.channel2_nudge_claimed_at
                : 0,
        claimToken:
            typeof result?.channel2_nudge_claim_token === "string"
                ? result.channel2_nudge_claim_token
                : "",
    };
}

export function setChannel2NudgeState(
    db: Database,
    sessionId: string,
    state: Channel2NudgeState,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const claimedAt = state === "claimed" ? Date.now() : 0;
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = '' WHERE session_id = ?",
        ).run(state, claimedAt, sessionId);
    })();
}

/**
 * Atomically change the Channel-2 lease from `from` to `to`; return true only when the row was `from`, preventing concurrent processes from both delivering the ceiling nudge.
 */
export function casChannel2NudgeState(
    db: Database,
    sessionId: string,
    from: Channel2NudgeState,
    to: Channel2NudgeState,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const claimedAt = to === "claimed" ? Date.now() : 0;
        const result = db
            .prepare(
                "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = '' WHERE session_id = ? AND channel2_nudge_state = ?",
            )
            .run(to, claimedAt, sessionId, from);
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

export function claimChannel2NudgeState(
    db: Database,
    sessionId: string,
    claimToken: string,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const result = db
            .prepare(
                "UPDATE session_meta SET channel2_nudge_state = 'claimed', channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'pending'",
            )
            .run(Date.now(), claimToken, sessionId);
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

export function casChannel2NudgeClaim(
    db: Database,
    sessionId: string,
    to: Channel2NudgeState,
    claimToken: string,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const claimedAt = to === "claimed" ? Date.now() : 0;
        const nextClaimToken = to === "claimed" ? claimToken : "";
        const result = db
            .prepare(
                "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'claimed' AND channel2_nudge_claim_token = ?",
            )
            .run(to, claimedAt, nextClaimToken, sessionId, claimToken);
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

export function getPersistedNoteNudge(db: Database, sessionId: string): PersistedNoteNudge {
    const result = db
        .prepare(
            "SELECT note_nudge_trigger_pending, note_nudge_trigger_message_id, note_nudge_sticky_text, note_nudge_sticky_message_id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedNoteNudgeRow(result)) {
        return getDefaultPersistedNoteNudge();
    }

    return {
        triggerPending: result.note_nudge_trigger_pending === 1,
        triggerMessageId:
            result.note_nudge_trigger_message_id.length > 0
                ? result.note_nudge_trigger_message_id
                : null,
        stickyText: result.note_nudge_sticky_text.length > 0 ? result.note_nudge_sticky_text : null,
        stickyMessageId:
            result.note_nudge_sticky_message_id.length > 0
                ? result.note_nudge_sticky_message_id
                : null,
    };
}

export function setPersistedNoteNudgeTrigger(
    db: Database,
    sessionId: string,
    triggerMessageId = "",
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_pending = 1, note_nudge_trigger_message_id = ? WHERE session_id = ?",
        ).run(triggerMessageId, sessionId);
    })();
}

export function setPersistedNoteNudgeTriggerMessageId(
    db: Database,
    sessionId: string,
    triggerMessageId: string,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_message_id = ? WHERE session_id = ?",
        ).run(triggerMessageId, sessionId);
    })();
}

export function clearPersistedNoteNudge(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '', note_nudge_sticky_text = '', note_nudge_sticky_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
}

export function getNoteNudgeAnchors(db: Database, sessionId: string): NoteNudgeAnchor[] {
    const row = db
        .prepare("SELECT note_nudge_anchors FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { note_nudge_anchors?: string | null } | undefined;
    return parseJsonArray(row?.note_nudge_anchors, isValidNoteNudgeAnchor);
}

export function getAutoSearchHintDecisions(
    db: Database,
    sessionId: string,
): AutoSearchHintDecision[] {
    const row = db
        .prepare("SELECT auto_search_hint_decisions FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { auto_search_hint_decisions?: string | null } | undefined;
    return parseJsonArray(row?.auto_search_hint_decisions, isValidAutoSearchHintDecision);
}

/**
 * The resolver records the native module block ID under which it seeded the decision and tolerates CAS exhaustion because the next successful raw resolution restores revocation independence.
 */
export function recordAutoSearchHintNativeBlockId(
    db: Database,
    sessionId: string,
    messageId: string,
    nativeBlockId: string,
): void {
    casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const index = current.findIndex((decision) => decision.messageId === messageId);
            if (index < 0) return null;
            if (current[index].nativeBlockId === nativeBlockId) return null;
            const next = [...current];
            next[index] = { ...next[index], nativeBlockId };
            return next;
        },
        { ensureRow: false },
    );
}

const CAS_JSON_ARRAY_COLUMNS = [
    "note_nudge_anchors",
    "auto_search_hint_decisions",
    "merged_reasoning_stripped_ids",
    "stale_reduce_stripped_ids",
    "processed_image_stripped_ids",
] as const;

type CasJsonArrayColumn = (typeof CAS_JSON_ARRAY_COLUMNS)[number];

function casUpdateJsonArrayColumn<T>(
    db: Database,
    sessionId: string,
    column: CasJsonArrayColumn,
    validator: (value: unknown) => value is T,
    mutate: (current: T[]) => T[] | null,
    options?: { ensureRow?: boolean },
): boolean {
    // Runtime allow-set guard. `column` is string-interpolated into SELECT/
    // UPDATE SQL below; the TS union is the only compile-time guard, so a
    // future JS-interop or untyped caller could otherwise inject SQL. Throw on
    // any column outside the known set so interpolation is always safe.
    if (!CAS_JSON_ARRAY_COLUMNS.includes(column)) {
        throw new Error(`casUpdateJsonArrayColumn: refusing unknown column "${column}"`);
    }
    if (options?.ensureRow === false) {
        const exists = db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId);
        if (!exists) return true;
    } else {
        ensureSessionMetaRow(db, sessionId);
    }
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare(`SELECT ${column} FROM session_meta WHERE session_id = ?`)
            .get(sessionId) as Record<string, string | null> | undefined;
        // The update preserves NULL so the CAS predicate can match it.
        // The CAS predicate uses `IS ?` with the uncoalesced expected value so it can match a stored NULL.
        // A `= ?` predicate using coalesced `"[]"` cannot match a stored NULL because `NULL = '[]'` is NULL in SQLite.
        const rawCurrent = (row?.[column] ?? null) as string | null;
        const currentBlob = rawCurrent ?? "[]";
        const current = parseJsonArray(currentBlob, validator);
        const next = mutate(current);
        if (next === null) return true;
        const nextBlob = stableStringify(next);
        if (nextBlob === currentBlob) return true;
        const result = db
            .prepare(
                `UPDATE session_meta SET ${column} = ? WHERE session_id = ? AND ${column} IS ?`,
            )
            .run(nextBlob, sessionId, rawCurrent);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `${column} CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

export function appendNoteNudgeAnchor(
    db: Database,
    sessionId: string,
    messageId: string,
    text: string,
): boolean {
    if (!messageId || !text) return false;
    return casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            if (current.some((anchor) => anchor.messageId === messageId && anchor.text === text)) {
                return null;
            }
            if (current.some((anchor) => anchor.messageId === messageId)) {
                sessionLog(sessionId, "note-nudge: messageId conflict, refusing append");
                return null;
            }
            return [...current, { messageId, text }];
        },
    );
}

type NoteNudgeDeliveryPlan = { kind: "appended" | "already-present" | "conflict" };

export function deliverNoteNudgeAtomic(
    db: Database,
    sessionId: string,
    messageId: string,
    text: string,
): NoteNudgeDeliveryOutcome {
    let plan: NoteNudgeDeliveryPlan | null = null;
    const casOk = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            if (current.some((anchor) => anchor.messageId === messageId && anchor.text === text)) {
                plan = { kind: "already-present" };
                return null;
            }
            if (current.some((anchor) => anchor.messageId === messageId)) {
                plan = { kind: "conflict" };
                sessionLog(sessionId, "note-nudge: messageId conflict, refusing append");
                return null;
            }
            plan = { kind: "appended" };
            return [...current, { messageId, text }];
        },
    );
    if (!casOk) {
        sessionLog(sessionId, `note-nudge: CAS exhausted for ${messageId}; skipping wire append`);
        return { ok: false, kind: "cas-exhausted" };
    }
    const committedPlan = plan as NoteNudgeDeliveryPlan | null;
    if (!committedPlan) {
        sessionLog(
            sessionId,
            "note-nudge: CAS reported success with no plan staged; treating as failure",
        );
        return { ok: false, kind: "cas-exhausted" };
    }
    if (committedPlan.kind === "conflict") {
        return { ok: false, kind: "conflict" };
    }
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
    return { ok: true, kind: committedPlan.kind };
}

export function appendAutoSearchHintDecision(
    db: Database,
    sessionId: string,
    entry: AutoSearchHintDecision,
): AppendAutoSearchHintOutcome {
    if (!entry.messageId) return { ok: false, kind: "cas-exhausted" };
    let staged: { kind: "appended" | "already-present"; decision: AutoSearchHintDecision } | null =
        null;
    const casOk = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const existing = current.find((decision) => decision.messageId === entry.messageId);
            if (existing) {
                staged = { kind: "already-present", decision: existing };
                return null;
            }
            staged = { kind: "appended", decision: entry };
            return [...current, entry];
        },
    );
    if (!casOk) return { ok: false, kind: "cas-exhausted" };
    const committed = staged as {
        kind: "appended" | "already-present";
        decision: AutoSearchHintDecision;
    } | null;
    if (!committed) {
        sessionLog(sessionId, "auto-search: CAS reported success with no staged outcome");
        return { ok: false, kind: "cas-exhausted" };
    }
    return { ok: true, kind: committed.kind, decision: committed.decision };
}

export function pruneNoteNudgeAnchors(
    db: Database,
    sessionId: string,
    visibleMessageIds: Set<string>,
): number {
    let pruned = 0;
    casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            const next = current.filter((anchor) => visibleMessageIds.has(anchor.messageId));
            pruned = current.length - next.length;
            return pruned > 0 ? next : null;
        },
    );
    return pruned;
}

export function pruneAutoSearchHintDecisions(
    db: Database,
    sessionId: string,
    visibleMessageIds: Set<string>,
): number {
    let pruned = 0;
    casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const next = current.filter((decision) => visibleMessageIds.has(decision.messageId));
            pruned = current.length - next.length;
            return pruned > 0 ? next : null;
        },
    );
    return pruned;
}

export function removeNoteNudgeAnchorByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    let removed = false;
    const ok = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            const next = current.filter((anchor) => anchor.messageId !== messageId);
            removed = next.length !== current.length;
            return removed ? next : null;
        },
        { ensureRow: false },
    );
    return ok && removed;
}

export function removeAutoSearchHintDecisionByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    let removed = false;
    const ok = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const next = current.filter((decision) => decision.messageId !== messageId);
            removed = next.length !== current.length;
            return removed ? next : null;
        },
        { ensureRow: false },
    );
    return ok && removed;
}

export function getPersistedTodoPermissionDenied(db: Database, sessionId: string): boolean | null {
    const row = db
        .prepare("SELECT todo_permission_denied FROM session_meta WHERE session_id = ?")
        .get(sessionId) as PersistedTodoPermissionRow | undefined;
    if (row?.todo_permission_denied === 1) return true;
    if (row?.todo_permission_denied === 0) return false;
    return null;
}

export function setPersistedTodoPermissionDenied(
    db: Database,
    sessionId: string,
    denied: boolean,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare("UPDATE session_meta SET todo_permission_denied = ? WHERE session_id = ?").run(
        denied ? 1 : 0,
        sessionId,
    );
}

export function getPersistedTodoSyntheticAnchor(
    db: Database,
    sessionId: string,
): PersistedTodoSyntheticAnchor | null {
    const result = db
        .prepare(
            "SELECT todo_synthetic_call_id, todo_synthetic_anchor_message_id, todo_synthetic_state_json FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedTodoSyntheticAnchorRow(result)) {
        return null;
    }

    if (
        result.todo_synthetic_call_id.length === 0 ||
        result.todo_synthetic_anchor_message_id.length === 0
    ) {
        return null;
    }

    return {
        callId: result.todo_synthetic_call_id,
        messageId: result.todo_synthetic_anchor_message_id,
        stateJson: result.todo_synthetic_state_json,
    };
}

export function setPersistedTodoSyntheticAnchor(
    db: Database,
    sessionId: string,
    callId: string,
    messageId: string,
    stateJson: string,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET todo_synthetic_call_id = ?, todo_synthetic_anchor_message_id = ?, todo_synthetic_state_json = ? WHERE session_id = ?",
        ).run(callId, messageId, stateJson, sessionId);
    })();
}

export function clearPersistedTodoSyntheticAnchor(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET todo_synthetic_call_id = '', todo_synthetic_anchor_message_id = '', todo_synthetic_state_json = '' WHERE session_id = ?",
    ).run(sessionId);
}

/**
 * The note-nudger uses `note_read_at` to suppress recent reminders.
 */
export function getNoteLastReadAt(db: Database, sessionId: string): number {
    try {
        const result = db
            .prepare("SELECT note_last_read_at FROM session_meta WHERE session_id = ?")
            .get(sessionId);
        if (!result || typeof result !== "object") return 0;
        const value = (result as { note_last_read_at?: unknown }).note_last_read_at;
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
        // Return `0` when no persisted watermark exists; the watermark only suppresses nudges.
        // Treat an absent watermark as no completed `ctx_note(read)`.
        return 0;
    }
}

/**
 * Nudge decisions compare this watermark with each note's `updated_at` or `created_at`.
 */
export function setNoteLastReadAt(db: Database, sessionId: string, at = Date.now()): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET note_last_read_at = ? WHERE session_id = ?").run(
            at,
            sessionId,
        );
    })();
}

export function getHistorianFailureState(
    db: Database,
    sessionId: string,
): PersistedHistorianFailureState {
    const result = db
        .prepare(
            "SELECT historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedHistorianFailureRow(result)) {
        return getDefaultHistorianFailureState();
    }

    return {
        failureCount: result.historian_failure_count,
        lastError:
            typeof result.historian_last_error === "string" &&
            result.historian_last_error.length > 0
                ? result.historian_last_error
                : null,
        lastFailureAt:
            typeof result.historian_last_failure_at === "number"
                ? result.historian_last_failure_at
                : null,
    };
}

/**
 * */
export function incrementHistorianFailure(db: Database, sessionId: string, error: string): number {
    let nextCount = 1;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const current = getHistorianFailureState(db, sessionId);
        nextCount = current.failureCount + 1;
        db.prepare(
            "UPDATE session_meta SET historian_failure_count = ?, historian_last_error = ?, historian_last_failure_at = ? WHERE session_id = ?",
        ).run(nextCount, error, Date.now(), sessionId);
        // The log stores errors as one line for grep.
        const reason = error.replace(/\s+/g, " ").trim().slice(0, 300);
        sessionLog(sessionId, `historian failure recorded: count=${nextCount} reason="${reason}"`);
    })();
    return nextCount;
}

export function clearHistorianFailureState(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_failure_count = 0, historian_last_error = NULL, historian_last_failure_at = NULL WHERE session_id = ?",
        ).run(sessionId);
    })();
}

//
// Only a provider-overflow rejection permits the transform to abort before another request.

export type EmergencyRecoveryOrigin = "provider_overflow" | "proactive_model_shrink";

export interface PersistedOverflowState {
    /** The detected limit is provider-reported; `0` means none detected. */
    detectedContextLimit: number;
    /** The model key identifies the model that produced the detected limit, when known. */
    detectedContextLimitModelKey: string | null;
    /** The flag states whether the detected number is prompt-only, combined, or ambiguous. */
    detectedContextLimitProvenance: ContextLimitProvenance;
    /* */
    needsEmergencyRecovery: boolean;
    /** Why recovery was armed; null for unarmed or untyped legacy state. */
    emergencyRecoveryOrigin: EmergencyRecoveryOrigin | null;
}

function normalizeDetectedLimitModelKey(modelKey: string | null | undefined): string | null {
    return typeof modelKey === "string" && modelKey.length > 0
        ? piModelRefToCanonical(modelKey)
        : null;
}

function normalizeEmergencyRecoveryOrigin(value: unknown): EmergencyRecoveryOrigin | null {
    return value === "provider_overflow" || value === "proactive_model_shrink" ? value : null;
}

export function getOverflowState(
    db: Database,
    sessionId: string,
    modelKey?: string | null,
): PersistedOverflowState {
    const result = db
        .prepare(
            "SELECT detected_context_limit, detected_context_limit_model_key, detected_context_limit_provenance, needs_emergency_recovery, emergency_recovery_origin FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
              detected_context_limit?: number;
              detected_context_limit_model_key?: string | null;
              detected_context_limit_provenance?: string | null;
              needs_emergency_recovery?: number;
              emergency_recovery_origin?: string | null;
          }
        | undefined;
    if (!result) {
        return {
            detectedContextLimit: 0,
            detectedContextLimitModelKey: null,
            detectedContextLimitProvenance: "unknown",
            needsEmergencyRecovery: false,
            emergencyRecoveryOrigin: null,
        };
    }
    const storedModelKey = normalizeDetectedLimitModelKey(result.detected_context_limit_model_key);
    const requestedModelKey = normalizeDetectedLimitModelKey(modelKey);
    const provenance = normalizeContextLimitProvenance(result.detected_context_limit_provenance);
    const limit =
        typeof result.detected_context_limit === "number" && result.detected_context_limit > 0
            ? result.detected_context_limit
            : 0;
    const modelMatches =
        limit > 0 && requestedModelKey && storedModelKey
            ? requestedModelKey === storedModelKey
            : true;
    const needs =
        typeof result.needs_emergency_recovery === "number" && result.needs_emergency_recovery > 0;
    const persistedOrigin = normalizeEmergencyRecoveryOrigin(result.emergency_recovery_origin);
    // An armed row without a persisted origin uses `provider_overflow` only when its detected limit is positive; otherwise it has no recovery origin.
    const recoveryOrigin = needs
        ? (persistedOrigin ?? (limit > 0 ? "provider_overflow" : null))
        : null;
    return {
        detectedContextLimit: modelMatches ? limit : 0,
        detectedContextLimitModelKey: storedModelKey,
        detectedContextLimitProvenance: provenance,
        needsEmergencyRecovery: needs,
        emergencyRecoveryOrigin: recoveryOrigin,
    };
}

/**
 * The transaction persists a parsed provider limit with the recovery arm.
 * overflow while recovery is already durable records a process-local reconfirmation.
 */
export function recordOverflowDetected(
    db: Database,
    sessionId: string,
    reportedLimit: number | undefined,
    modelKey?: string | null,
    origin: EmergencyRecoveryOrigin = "provider_overflow",
    provenance: ContextLimitProvenance = "unknown",
): void {
    // The function arms recovery before the durable write so an unreadable or failed write remains fail-closed.
    emergencyRecoveryArmedSessions.add(sessionId);
    emergencyRecoveryArmedAtBySession.set(sessionId, Date.now());
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const prior = db
            .prepare("SELECT needs_emergency_recovery FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { needs_emergency_recovery?: number } | undefined;
        if (
            origin === "provider_overflow" &&
            typeof prior?.needs_emergency_recovery === "number" &&
            prior.needs_emergency_recovery > 0
        ) {
            providerOverflowReconfirmedSessions.add(sessionId);
        }
        if (typeof reportedLimit === "number" && reportedLimit > 0) {
            db.prepare(
                "UPDATE session_meta SET detected_context_limit = ?, detected_context_limit_model_key = ?, detected_context_limit_provenance = ?, needs_emergency_recovery = 1, emergency_recovery_origin = ?, observed_safe_input_tokens = 0, cache_alert_sent = 0 WHERE session_id = ?",
            ).run(
                reportedLimit,
                normalizeDetectedLimitModelKey(modelKey),
                normalizeContextLimitProvenance(provenance),
                origin,
                sessionId,
            );
        } else {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 1, emergency_recovery_origin = ?, observed_safe_input_tokens = 0, cache_alert_sent = 0 WHERE session_id = ?",
            ).run(origin, sessionId);
        }
    })();
}

/**
 * The function records the provider-reported limit without arming recovery.
 * Subagent overflows retain the detected limit for pressure calculations.
 * but subagents can't run historian so the recovery flag would be orphan state.
 */
export function recordDetectedContextLimit(
    db: Database,
    sessionId: string,
    reportedLimit: number,
    modelKey?: string | null,
    provenance: ContextLimitProvenance = "unknown",
): void {
    if (!(reportedLimit > 0)) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET detected_context_limit = ?, detected_context_limit_model_key = ?, detected_context_limit_provenance = ?, observed_safe_input_tokens = 0, cache_alert_sent = 0 WHERE session_id = ?",
        ).run(
            reportedLimit,
            normalizeDetectedLimitModelKey(modelKey),
            normalizeContextLimitProvenance(provenance),
            sessionId,
        );
    })();
}

/** The function clears the recovery flag but retains the detected limit for pressure calculations. */
export function clearEmergencyRecovery(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        try {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 0, emergency_recovery_origin = '', recovery_no_eligible_head_count = 0 WHERE session_id = ?",
            ).run(sessionId);
        } catch {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 0, emergency_recovery_origin = '' WHERE session_id = ?",
            ).run(sessionId);
        }
    })();
    emergencyRecoveryArmedSessions.delete(sessionId);
    emergencyRecoveryArmedAtBySession.delete(sessionId);
    providerOverflowReconfirmedSessions.delete(sessionId);
}

/**
 */
export function clearDetectedContextLimit(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET detected_context_limit = 0, detected_context_limit_model_key = NULL, detected_context_limit_provenance = 'unknown' WHERE session_id = ?",
        ).run(sessionId);
    })();
}

export interface PersistedCompactionMarkerState {
    boundaryMessageId: string;
    summaryMessageId: string;
    compactionPartId: string;
    summaryPartId: string;
    /* */
    boundaryOrdinal: number;
    /* */
    targetEndMessageId: string | null;
}

export function getPersistedCompactionMarkerState(
    db: Database,
    sessionId: string,
): PersistedCompactionMarkerState | null {
    const row = db
        .prepare(
            "SELECT compaction_marker_state, compaction_marker_target_end_message_id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as {
        compaction_marker_state?: string;
        compaction_marker_target_end_message_id?: string | null;
    } | null;
    const raw = row?.compaction_marker_state;
    if (!raw || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.boundaryMessageId === "string" &&
            typeof parsed.summaryMessageId === "string" &&
            typeof parsed.compactionPartId === "string" &&
            typeof parsed.summaryPartId === "string" &&
            typeof parsed.boundaryOrdinal === "number"
        ) {
            const targetEndMessageId =
                typeof row?.compaction_marker_target_end_message_id === "string" &&
                row.compaction_marker_target_end_message_id.length > 0
                    ? row.compaction_marker_target_end_message_id
                    : typeof parsed.targetEndMessageId === "string" &&
                        parsed.targetEndMessageId.length > 0
                      ? parsed.targetEndMessageId
                      : null;
            return {
                ...(parsed as Omit<PersistedCompactionMarkerState, "targetEndMessageId">),
                targetEndMessageId,
            };
        }
    } catch {}
    return null;
}

export function setPersistedCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const json = state ? JSON.stringify(state) : "";
    db.prepare(
        "UPDATE session_meta SET compaction_marker_state = ?, compaction_marker_target_end_message_id = ? WHERE session_id = ?",
    ).run(json, state?.targetEndMessageId ?? null, sessionId);
}

export function getStrippedPlaceholderIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { stripped_placeholder_ids?: string } | null;
    const raw = row?.stripped_placeholder_ids;
    if (!raw || raw.length === 0) return new Set();
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return new Set(parsed.filter((v: unknown) => typeof v === "string"));
    } catch {}
    return new Set();
}

export function setStrippedPlaceholderIds(db: Database, sessionId: string, ids: Set<string>): void {
    ensureSessionMetaRow(db, sessionId);
    const json = ids.size > 0 ? JSON.stringify([...ids]) : "";
    db.prepare("UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ?").run(
        json,
        sessionId,
    );
}

/**
 * The function CAS-merges add/remove deltas to preserve concurrently discovered IDs.
 *
 * CAS retries reapply the delta to the latest persisted set.
 * A whole-set overwrite can silently undo a sibling's concurrent change by reapplying a stale-read-derived set.
 *
 * The function returns true after applying the delta or when the set already reflects it, including no-op deltas.
 * The function returns false only after all CAS retries are exhausted.
 */
export function applyStrippedPlaceholderDelta(
    db: Database,
    sessionId: string,
    delta: { add?: Iterable<string>; remove?: Iterable<string> },
): boolean {
    const add = delta.add ? [...delta.add] : [];
    const remove = delta.remove ? [...delta.remove] : [];
    if (add.length === 0 && remove.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { stripped_placeholder_ids?: string | null } | undefined;
        // The CAS predicate retains NULL and "" because SQLite `IS` matches NULL and equal non-NULL values.
        const rawStored = row ? (row.stripped_placeholder_ids ?? null) : null;
        const current = new Set<string>(parseStrippedBlob(rawStored));
        for (const id of add) current.add(id);
        for (const id of remove) current.delete(id);
        const nextBlob = current.size > 0 ? JSON.stringify([...current]) : "";
        if (nextBlob === (rawStored ?? "")) return true;
        const result = db
            .prepare(
                "UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ? AND stripped_placeholder_ids IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `stripped_placeholder_ids CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

function parseStrippedBlob(raw: string | null | undefined): string[] {
    if (!raw || raw.length === 0) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed.filter((v: unknown): v is string => typeof v === "string");
    } catch {
        // Invalid JSON is treated as an empty set.
    }
    return [];
}

export function removeStrippedPlaceholderId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    const before = getStrippedPlaceholderIds(db, sessionId);
    if (!before.has(messageId)) {
        return false;
    }
    applyStrippedPlaceholderDelta(db, sessionId, { remove: [messageId] });
    return true;
}

// The persisted set is a frozen replay watermark for merged-assistant reasoning.

/**
 * The set records assistant message IDs whose merged-run reasoning neutralization first ran on a cache-busting pass.
 * Every pass replays the set.
 * The set never shrinks while the session exists.
 * The immutable set prevents tail growth and object rebuilds from introducing prefix mutations on defer passes.
 */
export function getMergedReasoningStrippedIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT merged_reasoning_stripped_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { merged_reasoning_stripped_ids?: string } | null;
    return new Set(parseStrippedBlob(row?.merged_reasoning_stripped_ids));
}

/**
 * Callers must persist newly detected IDs before mutating messages so defer passes can reproduce the bytes after a fresh rebuild.
 */

function isStrippedId(value: unknown): value is string {
    return typeof value === "string";
}

/**
 * CAS-merge message ids into a frozen-set column, retrying on a concurrent
 * write so sibling processes sharing the session DB merge instead of
 * clobbering. Insertion order is preserved: existing ids keep their stored
 * order and new ids append. Returns true when the set ended in the intended
 * state (incl. no-op), false only when retries were exhausted.
 */
function casMergeStrippedIds(
    db: Database,
    sessionId: string,
    column: Extract<
        CasJsonArrayColumn,
        | "merged_reasoning_stripped_ids"
        | "stale_reduce_stripped_ids"
        | "processed_image_stripped_ids"
    >,
    ids: Iterable<string>,
): boolean {
    const add = [...ids];
    if (add.length === 0) return true;
    return casUpdateJsonArrayColumn(db, sessionId, column, isStrippedId, (current) => {
        const merged = new Set(current);
        let changed = false;
        for (const id of add) {
            if (!merged.has(id)) {
                merged.add(id);
                changed = true;
            }
        }
        return changed ? [...merged] : null;
    });
}

export function addMergedReasoningStrippedIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    return casMergeStrippedIds(db, sessionId, "merged_reasoning_stripped_ids", ids);
}

// The persisted map is a frozen replay map for trailing assistant blank decisions.

export type PersistedTrailingBlankDecision = "keep" | `keep:${number}` | "strip";

function isPersistedTrailingBlankDecision(value: unknown): value is PersistedTrailingBlankDecision {
    if (value === "keep" || value === "strip") return true;
    if (typeof value !== "string" || !value.startsWith("keep:")) return false;
    const countText = value.slice("keep:".length);
    if (!/^[1-9]\d*$/.test(countText)) return false;
    const count = Number(countText);
    return Number.isSafeInteger(count) && count > 1 && count <= 10_000;
}

function parseTrailingBlankDecisions(
    raw: string | null | undefined,
): Map<string, PersistedTrailingBlankDecision> {
    if (!raw) return new Map();
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
        const decisions = new Map<string, PersistedTrailingBlankDecision>();
        for (const [id, decision] of Object.entries(parsed)) {
            if (id.length > 0 && isPersistedTrailingBlankDecision(decision)) {
                decisions.set(id, decision);
            }
        }
        return decisions;
    } catch {
        return new Map();
    }
}

/**
 */
export function getTrailingBlankDecisions(
    db: Database,
    sessionId: string,
): Map<string, PersistedTrailingBlankDecision> {
    const row = db
        .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { trailing_blank_decisions?: string } | null;
    return parseTrailingBlankDecisions(row?.trailing_blank_decisions);
}

/* */
export function addTrailingBlankDecisions(
    db: Database,
    sessionId: string,
    additions: Iterable<readonly [string, PersistedTrailingBlankDecision]>,
    options?: { overwriteMessageId?: string },
): boolean {
    const add = [...additions];
    if (add.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { trailing_blank_decisions?: string | null } | undefined;
        const rawStored = row ? (row.trailing_blank_decisions ?? null) : null;
        const current = parseTrailingBlankDecisions(rawStored);
        let changed = false;
        for (const [id, decision] of add) {
            const currentDecision = current.get(id);
            if (
                currentDecision === undefined ||
                (id === options?.overwriteMessageId && currentDecision !== decision)
            ) {
                current.set(id, decision);
                changed = true;
            }
        }
        if (!changed) return true;
        const nextBlob = JSON.stringify(Object.fromEntries(current));
        const result = db
            .prepare(
                "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `trailing_blank_decisions CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

// The persisted set is a frozen replay watermark for stale ctx_reduce-stripped message IDs.

/**
 * The set records IDs whose ctx_reduce parts were sentinel-stripped after aging past the protected window.
 * Only cache-busting passes advance the set because only they may change the wire.
 * Every pass replays the set verbatim.
 * Replaying frozen IDs avoids recomputing the live `messages.length - protected` boundary.
 * The frozen boundary keeps defer passes byte-identical despite tail growth.
 * A defer pass does not strip IDs that newly age past the live boundary.
 * Stripping a mid-prefix ctx_reduce call on a defer pass would bust Anthropic's prompt cache.
 */
export function getStaleReduceStrippedIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT stale_reduce_stripped_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { stale_reduce_stripped_ids?: string } | null;
    return new Set(parseStrippedBlob(row?.stale_reduce_stripped_ids));
}

/**
 * The function CAS-merges `ctx_reduce` IDs to prevent sibling processes from clobbering concurrent updates.
 * The function returns true when the set reaches the intended state, including a no-op.
 * The function returns false only after CAS_RETRY_LIMIT failed updates.
 */
export function addStaleReduceStrippedIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    return casMergeStrippedIds(db, sessionId, "stale_reduce_stripped_ids", ids);
}

/**
 * The set contains message IDs whose processed-image file parts have been sentinel-stripped.
 * The set is a frozen replay watermark for stripProcessedImages.
 * The watermark advances only on cache-busting passes.
 * Every pass replays the watermark verbatim.
 * A defer pass never first-removes images from an aged image message.
 * The empty sentinel is filtered from the Anthropic wire and therefore busts the Anthropic prompt cache.
 */
export function getProcessedImageStrippedIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT processed_image_stripped_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { processed_image_stripped_ids?: string } | null;
    return new Set(parseStrippedBlob(row?.processed_image_stripped_ids));
}

/**
 * CAS retries prevent sibling processes sharing the session database from clobbering each other's IDs.
 * The function returns true when the set reaches the intended state, including a no-op.
 * The function returns false only after CAS_RETRY_LIMIT failed updates.
 */
export function addProcessedImageStrippedIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    return casMergeStrippedIds(db, sessionId, "processed_image_stripped_ids", ids);
}

/**
 * The payload persists in session_meta.pending_compaction_marker_state between publication and consumption.
 * A background historian or compressor publishes the payload before the transform consumes it.
 * CAS comparison preserves a payload published after the consumer read `expected`.
 *
 * endMessageId lets the consuming pass validate that the marker target still exists.
 * The consuming pass requires both the raw OpenCode message and compartment row before writing persisted state.
 * The consuming pass writes PersistedCompactionMarkerState and clears pending state atomically.
 *
 * The persistence layer serializes the pending marker with `stableStringify` so CAS compares byte-identical blobs.
 * SQL NULL, not "", represents absence.
 * `healNullTextColumns`.
 */
export interface PendingCompactionMarker {
    /* */
    ordinal: number;
    /** endMessageId identifies the final OpenCode message in the compartment target. */
    endMessageId: string;
    /** The publication timestamp is diagnostic only and supports doctor stale-pending checks. */
    publishedAt: number;
}

export interface DeferredExecutePayload {
    id: string;
    reason: string;
    recordedAt: number;
}

/* */
function isPendingCompactionMarker(value: unknown): value is PendingCompactionMarker {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { ordinal?: unknown }).ordinal === "number" &&
        typeof (value as { endMessageId?: unknown }).endMessageId === "string" &&
        typeof (value as { publishedAt?: unknown }).publishedAt === "number"
    );
}

export function getPendingCompactionMarkerState(
    db: Database,
    sessionId: string,
): PendingCompactionMarker | null {
    const row = db
        .prepare("SELECT pending_compaction_marker_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { pending_compaction_marker_state?: string | null } | null;
    const raw = row?.pending_compaction_marker_state;
    // The parser treats SQL NULL and "" as absent.
    if (raw === null || raw === undefined || raw === "") return null;
    try {
        const parsed = JSON.parse(raw);
        if (isPendingCompactionMarker(parsed)) {
            return parsed;
        }
    } catch {
        // The parser treats corrupt JSON as absent; a subsequent publish overwrites it.
    }
    return null;
}

/**
 *
 * Writing state === null stores SQL NULL rather than "".
 * The serializer uses `stableStringify` so callers can CAS-compare the same serialized value.
 */
export function setPendingCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PendingCompactionMarker | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const blob = state ? stableStringify(state) : null;
    db.prepare(
        "UPDATE session_meta SET pending_compaction_marker_state = ? WHERE session_id = ?",
    ).run(blob, sessionId);
}

/**
 * The clear operation clears the row only if its stored blob byte-matches `expected`; it returns true when the update changes a row.
 * The newer marker remains pending for its consuming pass.
 *
 */
export function clearPendingCompactionMarkerStateIf(
    db: Database,
    sessionId: string,
    expected: PendingCompactionMarker,
): boolean {
    const expectedBlob = stableStringify(expected);
    const result = db
        .prepare(
            `UPDATE session_meta SET pending_compaction_marker_state = NULL
             WHERE session_id = ? AND pending_compaction_marker_state = ?`,
        )
        .run(sessionId, expectedBlob);
    return result.changes > 0;
}

/**
 * The persistence layer uses `stableStringify` so the CAS clear compares bytes exactly.
 */
export interface PendingPiCompactionMarker {
    firstKeptEntryId: string;
    endMessageId: string;
    ordinal: number;
    tokensBefore: number;
    summary: string;
    publishedAt: number;
}

function isPendingPiCompactionMarker(value: unknown): value is PendingPiCompactionMarker {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { firstKeptEntryId?: unknown }).firstKeptEntryId === "string" &&
        typeof (value as { endMessageId?: unknown }).endMessageId === "string" &&
        typeof (value as { ordinal?: unknown }).ordinal === "number" &&
        typeof (value as { tokensBefore?: unknown }).tokensBefore === "number" &&
        typeof (value as { summary?: unknown }).summary === "string" &&
        typeof (value as { publishedAt?: unknown }).publishedAt === "number"
    );
}

export function getPendingPiCompactionMarkerState(
    db: Database,
    sessionId: string,
): PendingPiCompactionMarker | null {
    const row = db
        .prepare("SELECT pending_pi_compaction_marker_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { pending_pi_compaction_marker_state?: string | null } | null;
    const raw = row?.pending_pi_compaction_marker_state;
    if (raw === null || raw === undefined || raw === "") return null;
    try {
        const parsed = JSON.parse(raw);
        if (isPendingPiCompactionMarker(parsed)) {
            return parsed;
        }
    } catch {}
    db.prepare(
        "UPDATE session_meta SET pending_pi_compaction_marker_state = NULL WHERE session_id = ? AND pending_pi_compaction_marker_state = ?",
    ).run(sessionId, raw);
    return null;
}

export function setPendingPiCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PendingPiCompactionMarker | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const blob = state ? stableStringify(state) : null;
    db.prepare(
        "UPDATE session_meta SET pending_pi_compaction_marker_state = ? WHERE session_id = ?",
    ).run(blob, sessionId);
}

export function clearPendingPiCompactionMarkerStateIf(
    db: Database,
    sessionId: string,
    expected: PendingPiCompactionMarker,
): boolean {
    const expectedBlob = stableStringify(expected);
    const result = db
        .prepare(
            `UPDATE session_meta SET pending_pi_compaction_marker_state = NULL
             WHERE session_id = ? AND pending_pi_compaction_marker_state = ?`,
        )
        .run(sessionId, expectedBlob);
    return result.changes > 0;
}

export function getSessionsWithPendingPiMarker(db: Database): string[] {
    const rows = db
        .prepare(
            `SELECT session_id FROM session_meta
             WHERE pending_pi_compaction_marker_state IS NOT NULL
               AND pending_pi_compaction_marker_state != ''`,
        )
        .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
}

export function peekDeferredExecutePending(
    db: Database,
    sessionId: string,
): DeferredExecutePayload | null {
    const row = db
        .prepare("SELECT deferred_execute_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { deferred_execute_state?: string | null } | null;
    const raw = row?.deferred_execute_state;
    if (raw === null || raw === undefined || raw === "") return null;
    try {
        return JSON.parse(raw) as DeferredExecutePayload;
    } catch {
        return null;
    }
}

export function setDeferredExecutePendingIfAbsent(
    db: Database,
    sessionId: string,
    payload: DeferredExecutePayload,
): boolean {
    ensureSessionMetaRow(db, sessionId);
    const payloadBlob = stableStringify(payload);
    const result = db
        .prepare(
            `UPDATE session_meta SET deferred_execute_state = ?
             WHERE session_id = ? AND deferred_execute_state IS NULL`,
        )
        .run(payloadBlob, sessionId);
    return result.changes > 0;
}

export function clearDeferredExecutePendingIfMatches(
    db: Database,
    sessionId: string,
    expected: DeferredExecutePayload,
): boolean {
    const expectedBlob = stableStringify(expected);
    const result = db
        .prepare(
            `UPDATE session_meta SET deferred_execute_state = NULL
             WHERE session_id = ? AND deferred_execute_state = ?`,
        )
        .run(sessionId, expectedBlob);
    return result.changes > 0;
}

/**
 *
 * absent.
 */
export function getSessionsWithPendingMarker(db: Database): string[] {
    const rows = db
        .prepare(
            `SELECT session_id FROM session_meta
             WHERE pending_compaction_marker_state IS NOT NULL
               AND pending_compaction_marker_state != ''`,
        )
        .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
}

export function setSessionWorkMetrics(
    db: Database,
    sessionId: string,
    newWorkTokens: number,
    totalInputTokens: number,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        `UPDATE session_meta
         SET new_work_tokens = ?, total_input_tokens = ?
         WHERE session_id = ?`,
    ).run(
        Math.max(0, Math.floor(newWorkTokens)),
        Math.max(0, Math.floor(totalInputTokens)),
        sessionId,
    );
}

export function getSessionWorkMetrics(
    db: Database,
    sessionId: string,
): { newWorkTokens: number; totalInputTokens: number } {
    const row = db
        .prepare(
            "SELECT new_work_tokens, total_input_tokens FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as {
        new_work_tokens?: number | null;
        total_input_tokens?: number | null;
    } | null;
    return {
        newWorkTokens: typeof row?.new_work_tokens === "number" ? row.new_work_tokens : 0,
        totalInputTokens: typeof row?.total_input_tokens === "number" ? row.total_input_tokens : 0,
    };
}
