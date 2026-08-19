import type { CompileSmartNoteResult } from "./compiler";
import type {
    CompiledCheckArtifact,
    EvaluationPhase,
    SmartNoteEvaluationOutcome,
} from "./evaluation-state";
import type { RunCompiledSmartNoteCheckResult } from "./sandbox-runner";

export interface SmartNotePhaseSnapshot {
    phase: EvaluationPhase;
    noteId: number;
    content: string;
    surfaceCondition: string | null;
    compiledCheck: string | null;
}

export type SmartNoteEvaluatorResult =
    | { ok: true; outcome: SmartNoteEvaluationOutcome }
    | { ok: false; abandoned: true; reason: string };

export interface SmartNotePhaseExecutors {
    compile: () => Promise<CompileSmartNoteResult>;
    runCompiled: (compiledCheck: string) => Promise<RunCompiledSmartNoteCheckResult>;
    /** Null means the confirmation was cancelled, not that it returned false. */
    confirmFallback: () => Promise<boolean | null>;
}

function abandoned(reason: string): SmartNoteEvaluatorResult {
    return { ok: false, abandoned: true, reason };
}

function outcome(value: SmartNoteEvaluationOutcome): SmartNoteEvaluatorResult {
    return { ok: true, outcome: value };
}

async function evaluateCompile(
    executors: SmartNotePhaseExecutors,
): Promise<SmartNoteEvaluatorResult> {
    const result = await executors.compile();
    if (!result.ok) {
        if (result.cancelled) return abandoned(result.error);
        return outcome({ phase: "compile", kind: "compilation_failed" });
    }
    const artifact: CompiledCheckArtifact = {
        compiledCheck: result.compiledCheck,
        manifestJson: JSON.stringify(result.manifest),
        checkHash: result.checkHash,
        checkCron: result.checkCron,
    };
    return outcome({
        phase: "compile",
        kind: result.dryRun.met ? "compiled_met" : "compiled_false",
        artifact,
    });
}

async function evaluateCompiledCheck(
    phase: "due" | "liveness",
    snapshot: SmartNotePhaseSnapshot,
    executors: SmartNotePhaseExecutors,
): Promise<SmartNoteEvaluatorResult> {
    if (!snapshot.compiledCheck) {
        return outcome({ phase, kind: "logic_failed" });
    }
    const result = await executors.runCompiled(snapshot.compiledCheck);
    if (result.ok) {
        return outcome({ phase, kind: result.result.met ? "met" : "false" });
    }
    if (result.cancelled) return abandoned(result.error);
    return outcome({ phase, kind: result.network ? "network_failed" : "logic_failed" });
}

export async function evaluateSmartNotePhase(
    snapshot: SmartNotePhaseSnapshot,
    executors: SmartNotePhaseExecutors,
): Promise<SmartNoteEvaluatorResult> {
    switch (snapshot.phase) {
        case "compile":
            return evaluateCompile(executors);
        case "due":
        case "liveness":
            return evaluateCompiledCheck(snapshot.phase, snapshot, executors);
        case "fallback": {
            const met = await executors.confirmFallback();
            if (met === null) return abandoned("fallback confirmation cancelled");
            return outcome({ phase: "fallback", kind: met ? "met" : "false" });
        }
    }
}
