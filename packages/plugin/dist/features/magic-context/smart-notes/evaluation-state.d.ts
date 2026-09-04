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
import { type SmartNoteCheckStatus } from "./types";
export declare const MAX_COMPILE_PER_RUN = 5;
export declare const MAX_FALLBACK_PER_RUN = 3;
export declare const MAX_LIVENESS_PER_RUN = 3;
export declare const MAX_COMPILATION_FAILURES = 3;
export declare const MAX_FAILURES_BEFORE_REAUTHOR = 3;
export type EvaluationPhase = "compile" | "due" | "liveness" | "fallback";
/** Normalized compiler output recorded with its producing source revision. */
export interface CompiledCheckArtifact {
    compiledCheck: string;
    /** Normalized manifest serialized in fixed key order (compiler output order). */
    manifestJson: string;
    checkHash: string;
    checkCron: string;
}
export type SmartNoteEvaluationOutcome = {
    phase: "compile";
    kind: "compiled_met" | "compiled_false";
    artifact: CompiledCheckArtifact;
} | {
    phase: "compile";
    kind: "compilation_failed";
} | {
    phase: "due";
    kind: "met" | "false" | "logic_failed" | "network_failed";
} | {
    phase: "liveness";
    kind: "met" | "false" | "logic_failed" | "network_failed";
} | {
    phase: "fallback";
    kind: "met" | "false";
};
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
export declare function evaluationBackoffMs(failureCount: number): number;
/** Host-derived ready reason for a due-phase met result. */
export declare function dueReadyReason(noteId: number, manifestJson: string | null): string;
/**
 * Derive the complete next lifecycle state for one phase outcome.
 *
 * The outcome's phase is the authority-selected phase; outcomes are
 * phase-scoped by construction so a smuggled cross-phase result cannot
 * type-check.
 */
export declare function reduceSmartNoteEvaluation(pre: SmartNoteLifecycleState, outcome: SmartNoteEvaluationOutcome, ctx: SmartNoteReductionContext): SmartNoteReduction;
/** Read the lifecycle projection off a full note row shape. */
export declare function lifecycleStateFromNote(note: {
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
}): SmartNoteLifecycleState;
/**
 * Persist a reduction on the file authority.
 *
 * Writes the full lifecycle projection and advances `state_version` (a
 * lifecycle transition never changes compiler inputs, so `source_revision`
 * stays). Callers wrap this in `commitSmartNoteState` so the stale-result CAS
 * guard and the write share one transaction.
 */
export declare function applySmartNoteReduction(db: Database, noteId: number, reduction: SmartNoteReduction): void;
//# sourceMappingURL=evaluation-state.d.ts.map