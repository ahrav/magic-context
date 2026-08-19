/**
 * Versioned smart-note evaluation transition contract.
 *
 * One reducer owns every lifecycle transition for the four evaluation phases.
 * Both state authorities consume it: the TypeScript SQLite adapter applies
 * reductions through `applySmartNoteReduction`, and the Rust authority ports
 * the same contract (crates/mc-module/src/smart_note_evaluation.rs). Both
 * implementations replay the frozen characterization fixture
 * (crates/mc-module/testdata/smart-note-evaluation-golden.json), so lifecycle
 * behavior cannot drift between languages.
 *
 * The reducer is pure: callers supply the pre-state, a semantic outcome, and
 * the transition clock. Evaluators never compute persisted lifecycle state;
 * cancellation is an abandon, never an outcome.
 */
import type { Database } from "../../../shared/sqlite";
import { nextSmartNoteCheckDueAt } from "./schedule";
import {
    parseSmartNoteManifest,
    SMART_NOTE_CHECK_POLICY_VERSION,
    type SmartNoteCheckStatus,
} from "./types";

export const MAX_COMPILE_PER_RUN = 5;
export const MAX_FALLBACK_PER_RUN = 3;
export const MAX_COMPILATION_FAILURES = 3;
export const MAX_FAILURES_BEFORE_REAUTHOR = 3;

export type EvaluationPhase = "compile" | "due" | "liveness" | "fallback";

/** Normalized compiler output recorded with its producing source revision. */
export interface CompiledCheckArtifact {
    compiledCheck: string;
    /** Normalized manifest serialized in fixed key order (compiler output order). */
    manifestJson: string;
    checkHash: string;
    checkCron: string;
}

export type SmartNoteEvaluationOutcome =
    | { phase: "compile"; kind: "compiled_met" | "compiled_false"; artifact: CompiledCheckArtifact }
    | { phase: "compile"; kind: "compilation_failed" }
    | { phase: "due"; kind: "met" | "false" | "logic_failed" | "network_failed" }
    | { phase: "liveness"; kind: "met" | "false" | "logic_failed" | "network_failed" }
    | { phase: "fallback"; kind: "met" | "false" };

/** The lifecycle projection owned by this contract. */
export interface SmartNoteLifecycleState {
    status: string;
    readyAt: number | null;
    readyReason: string | null;
    lastCheckedAt: number | null;
    updatedAt: number;
    compiledCheck: string | null;
    manifestJson: string | null;
    checkHash: string | null;
    checkCron: string | null;
    checkVersion: number;
    checkStatus: SmartNoteCheckStatus;
    checkFailureCount: number;
    checkNetworkFailureCount: number;
    checkQuarantinedUntil: number | null;
    checkNextDueAt: number | null;
    checkCompiledAt: number | null;
    checkFalseSinceAt: number | null;
    checkLastLivenessAt: number | null;
    policyVersion: number;
}

export interface SmartNoteReductionContext {
    noteId: number;
    now: number;
}

export interface SmartNoteReduction {
    next: SmartNoteLifecycleState;
    /** True when this transition surfaced the note (status became ready). */
    surfaced: boolean;
}

/** Backoff after the Nth consecutive failure: min(24h, 5 * 2^(N-1)) minutes. */
export function evaluationBackoffMs(failureCount: number): number {
    const minutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, failureCount - 1));
    return minutes * 60 * 1000;
}

/** Host-derived ready reason for a due-phase met result. */
export function dueReadyReason(noteId: number, manifestJson: string | null): string {
    const manifest = parseSmartNoteManifest(manifestJson);
    const signal = manifest.signals?.[0] ?? manifest.summary ?? "compiled check returned met=true";
    const sliced = `Smart note #${noteId}: ${signal}`.slice(0, 240);
    // slice counts UTF-16 units and can split a surrogate pair at the cap. A
    // trailing lone high surrogate cannot survive persistence, and the Rust
    // reducer never emits one, so drop it and store the same 239-unit value
    // in both authorities.
    const last = sliced.charCodeAt(sliced.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function readyFields(
    state: SmartNoteLifecycleState,
    reason: string,
    now: number,
): SmartNoteLifecycleState {
    return {
        ...state,
        status: "ready",
        readyAt: now,
        readyReason: reason,
        lastCheckedAt: now,
        updatedAt: now,
    };
}

function falseFields(
    state: SmartNoteLifecycleState,
    ctx: SmartNoteReductionContext,
    cron: string | null,
    hash: string | null,
): SmartNoteLifecycleState {
    return {
        ...state,
        lastCheckedAt: ctx.now,
        updatedAt: ctx.now,
        checkNextDueAt: nextSmartNoteCheckDueAt(cron, {
            now: ctx.now,
            noteId: ctx.noteId,
            hash,
        }),
        checkFailureCount: 0,
        checkNetworkFailureCount: 0,
        checkFalseSinceAt: state.checkFalseSinceAt ?? ctx.now,
    };
}

function reduceCompile(
    pre: SmartNoteLifecycleState,
    outcome: Extract<SmartNoteEvaluationOutcome, { phase: "compile" }>,
    ctx: SmartNoteReductionContext,
): SmartNoteReduction {
    const { now, noteId } = ctx;
    if (outcome.kind === "compilation_failed") {
        const failureCount = pre.checkFailureCount + 1;
        return {
            surfaced: false,
            next: {
                ...pre,
                checkFailureCount: failureCount,
                checkStatus: failureCount >= MAX_COMPILATION_FAILURES ? "fallback" : "uncompiled",
                checkNextDueAt: now + evaluationBackoffMs(failureCount),
                updatedAt: now,
            },
        };
    }
    const { artifact } = outcome;
    const nextDueAt = nextSmartNoteCheckDueAt(artifact.checkCron, {
        now,
        noteId,
        hash: artifact.checkHash,
    });
    const stored: SmartNoteLifecycleState = {
        ...pre,
        compiledCheck: artifact.compiledCheck,
        manifestJson: artifact.manifestJson,
        checkHash: artifact.checkHash,
        checkCron: artifact.checkCron,
        checkVersion: 1,
        checkStatus: "compiled",
        checkFailureCount: 0,
        checkNetworkFailureCount: 0,
        checkQuarantinedUntil: null,
        checkNextDueAt: nextDueAt,
        checkCompiledAt: now,
        checkFalseSinceAt: pre.checkFalseSinceAt ?? now,
        checkLastLivenessAt: null,
        policyVersion: SMART_NOTE_CHECK_POLICY_VERSION,
        updatedAt: now,
    };
    if (outcome.kind === "compiled_met") {
        return {
            surfaced: true,
            next: readyFields(
                stored,
                `Smart note #${noteId}: compiled check returned met=true`,
                now,
            ),
        };
    }
    return {
        surfaced: false,
        next: falseFields(stored, ctx, artifact.checkCron, artifact.checkHash),
    };
}

function reduceCheckFailure(
    pre: SmartNoteLifecycleState,
    kind: "logic_failed" | "network_failed",
    now: number,
): SmartNoteLifecycleState {
    if (kind === "logic_failed") {
        const failureCount = pre.checkFailureCount + 1;
        return {
            ...pre,
            checkFailureCount: failureCount,
            checkStatus: failureCount >= MAX_FAILURES_BEFORE_REAUTHOR ? "failing" : "compiled",
            checkNextDueAt: now + evaluationBackoffMs(failureCount),
            updatedAt: now,
        };
    }
    const networkCount = pre.checkNetworkFailureCount + 1;
    const quarantinedUntil = now + evaluationBackoffMs(networkCount);
    return {
        ...pre,
        checkNetworkFailureCount: networkCount,
        checkStatus: networkCount >= MAX_FAILURES_BEFORE_REAUTHOR ? "failing" : "compiled",
        checkNextDueAt: quarantinedUntil,
        checkQuarantinedUntil: quarantinedUntil,
        updatedAt: now,
    };
}

function reduceDue(
    pre: SmartNoteLifecycleState,
    outcome: Extract<SmartNoteEvaluationOutcome, { phase: "due" }>,
    ctx: SmartNoteReductionContext,
): SmartNoteReduction {
    switch (outcome.kind) {
        case "met":
            return {
                surfaced: true,
                next: readyFields(pre, dueReadyReason(ctx.noteId, pre.manifestJson), ctx.now),
            };
        case "false":
            return { surfaced: false, next: falseFields(pre, ctx, pre.checkCron, pre.checkHash) };
        default:
            return { surfaced: false, next: reduceCheckFailure(pre, outcome.kind, ctx.now) };
    }
}

function reduceLiveness(
    pre: SmartNoteLifecycleState,
    outcome: Extract<SmartNoteEvaluationOutcome, { phase: "liveness" }>,
    ctx: SmartNoteReductionContext,
): SmartNoteReduction {
    const attempted: SmartNoteLifecycleState = {
        ...pre,
        checkLastLivenessAt: ctx.now,
        updatedAt: ctx.now,
    };
    switch (outcome.kind) {
        case "met":
            return {
                surfaced: true,
                next: readyFields(
                    attempted,
                    `Smart note #${ctx.noteId}: max-staleness liveness check returned met=true`,
                    ctx.now,
                ),
            };
        case "false":
            return {
                surfaced: false,
                next: falseFields(attempted, ctx, pre.checkCron, pre.checkHash),
            };
        case "logic_failed":
            // Liveness runs a previously healthy compiled check; a logic error
            // here means the check itself broke, so reauthoring is immediate
            // rather than counted toward the normal failure threshold.
            return { surfaced: false, next: { ...attempted, checkStatus: "failing" } };
        default:
            return { surfaced: false, next: attempted };
    }
}

function reduceFallback(
    pre: SmartNoteLifecycleState,
    outcome: Extract<SmartNoteEvaluationOutcome, { phase: "fallback" }>,
    ctx: SmartNoteReductionContext,
): SmartNoteReduction {
    if (outcome.kind === "met") {
        return {
            surfaced: true,
            next: readyFields(
                pre,
                `Smart note #${ctx.noteId}: read-only confirmation evaluator returned met=true`,
                ctx.now,
            ),
        };
    }
    return {
        surfaced: false,
        next: {
            ...pre,
            lastCheckedAt: ctx.now,
            updatedAt: ctx.now,
            checkStatus: "fallback",
        },
    };
}

/**
 * Derive the complete next lifecycle state for one phase outcome.
 *
 * The outcome's phase is the authority-selected phase; outcomes are
 * phase-scoped by construction so a smuggled cross-phase result cannot
 * type-check.
 */
export function reduceSmartNoteEvaluation(
    pre: SmartNoteLifecycleState,
    outcome: SmartNoteEvaluationOutcome,
    ctx: SmartNoteReductionContext,
): SmartNoteReduction {
    switch (outcome.phase) {
        case "compile":
            return reduceCompile(pre, outcome, ctx);
        case "due":
            return reduceDue(pre, outcome, ctx);
        case "liveness":
            return reduceLiveness(pre, outcome, ctx);
        case "fallback":
            return reduceFallback(pre, outcome, ctx);
    }
}

/** Read the lifecycle projection off a full note row shape. */
export function lifecycleStateFromNote(note: {
    status: string;
    readyAt: number | null;
    readyReason: string | null;
    lastCheckedAt: number | null;
    updatedAt: number;
    compiledCheck: string | null;
    manifestJson: string | null;
    checkHash: string | null;
    checkCron: string | null;
    checkVersion: number | null;
    checkStatus: SmartNoteCheckStatus | null;
    checkFailureCount: number;
    checkNetworkFailureCount: number;
    checkQuarantinedUntil: number | null;
    checkNextDueAt: number | null;
    checkCompiledAt: number | null;
    checkFalseSinceAt: number | null;
    checkLastLivenessAt: number | null;
    policyVersion: number | null;
}): SmartNoteLifecycleState {
    return {
        status: note.status,
        readyAt: note.readyAt,
        readyReason: note.readyReason,
        lastCheckedAt: note.lastCheckedAt,
        updatedAt: note.updatedAt,
        compiledCheck: note.compiledCheck,
        manifestJson: note.manifestJson,
        checkHash: note.checkHash,
        checkCron: note.checkCron,
        checkVersion: note.checkVersion ?? 0,
        checkStatus: note.checkStatus ?? "uncompiled",
        checkFailureCount: note.checkFailureCount,
        checkNetworkFailureCount: note.checkNetworkFailureCount,
        checkQuarantinedUntil: note.checkQuarantinedUntil,
        checkNextDueAt: note.checkNextDueAt,
        checkCompiledAt: note.checkCompiledAt,
        checkFalseSinceAt: note.checkFalseSinceAt,
        checkLastLivenessAt: note.checkLastLivenessAt,
        policyVersion: note.policyVersion ?? 0,
    };
}

/**
 * Persist a reduction on the file authority.
 *
 * Writes the full lifecycle projection and advances `state_version` (a
 * lifecycle transition never changes compiler inputs, so `source_revision`
 * stays). Callers wrap this in `commitSmartNoteState` so the stale-result CAS
 * guard and the write share one transaction.
 */
export function applySmartNoteReduction(
    db: Database,
    noteId: number,
    reduction: SmartNoteReduction,
): void {
    const next = reduction.next;
    db.prepare(
        `UPDATE notes SET
            status = ?, ready_at = ?, ready_reason = ?, last_checked_at = ?, updated_at = ?,
            compiled_check = ?, manifest_json = ?, check_hash = ?, check_cron = ?,
            check_version = ?, check_status = ?, check_failure_count = ?,
            check_network_failure_count = ?, check_quarantined_until = ?, check_next_due_at = ?,
            check_compiled_at = ?, check_false_since_at = ?, check_last_liveness_at = ?,
            policy_version = ?, state_version = state_version + 1
         WHERE id = ? AND type = 'smart'`,
    ).run(
        next.status,
        next.readyAt,
        next.readyReason,
        next.lastCheckedAt,
        next.updatedAt,
        next.compiledCheck,
        next.manifestJson,
        next.checkHash,
        next.checkCron,
        next.checkVersion,
        next.checkStatus,
        next.checkFailureCount,
        next.checkNetworkFailureCount,
        next.checkQuarantinedUntil,
        next.checkNextDueAt,
        next.checkCompiledAt,
        next.checkFalseSinceAt,
        next.checkLastLivenessAt,
        next.policyVersion,
        noteId,
    );
}
