import type { CompileSmartNoteResult } from "./compiler";
import type { EvaluationPhase, SmartNoteEvaluationOutcome } from "./evaluation-state";
import type { RunCompiledSmartNoteCheckResult } from "./sandbox-runner";
export interface SmartNotePhaseSnapshot {
    phase: EvaluationPhase;
    noteId: number;
    content: string;
    surfaceCondition: string | null;
    compiledCheck: string | null;
}
export type SmartNoteEvaluatorResult = {
    ok: true;
    outcome: SmartNoteEvaluationOutcome;
} | {
    ok: false;
    abandoned: true;
    reason: string;
};
export interface SmartNotePhaseExecutors {
    compile: () => Promise<CompileSmartNoteResult>;
    runCompiled: (compiledCheck: string) => Promise<RunCompiledSmartNoteCheckResult>;
    /** Null means the confirmation was cancelled, not that it returned false. */
    confirmFallback: () => Promise<boolean | null>;
}
export declare function evaluateSmartNotePhase(snapshot: SmartNotePhaseSnapshot, executors: SmartNotePhaseExecutors): Promise<SmartNoteEvaluatorResult>;
//# sourceMappingURL=evaluator.d.ts.map