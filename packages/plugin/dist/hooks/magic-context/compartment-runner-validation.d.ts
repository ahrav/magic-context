import type { StoredCompartmentRange, ValidatedHistorianPassResult } from "./compartment-runner-types";
export declare const HISTORIAN_BOUNDARY_HEALING_SLACK = 2;
export interface HistorianValidationChunk {
    startIndex: number;
    endIndex: number;
    lines: Array<{
        ordinal: number;
        messageId: string;
    }>;
    /** Optional — when provided, gaps inside these ranges heal at any size. */
    toolOnlyRanges?: ReadonlyArray<{
        start: number;
        end: number;
    }>;
    /** Completed invocation/result arcs visible in the raw snapshot. */
    completedToolArcs?: ReadonlyArray<{
        start: number;
        end: number;
    }>;
}
/**
 * Do not discard the last historian compartment when that would leave the persisted
 * end boundary inside a completed tool invocation/result pair.
 */
export declare function shouldDiscardLastHistorianCompartment(compartments: ReadonlyArray<{
    endMessage: number;
}>, chunk: Pick<HistorianValidationChunk, "endIndex" | "completedToolArcs">): boolean;
export declare function validateHistorianOutput(text: string, _sessionId: string, chunk: HistorianValidationChunk, _priorCompartments: StoredCompartmentRange[], sequenceOffset: number): ValidatedHistorianPassResult;
/**
 * Number of CONSECUTIVE historian failures before a failure notice escalates
 * from "transient, will retry" reassurance to an actionable "your historian
 * model needs attention" alert. The historian retries on every turn and silently
 * iterates its whole fallback chain, so a single failure is almost always a
 * transient blip (a model hiccup, a provider timeout) that the next turn fixes on
 * its own. Only a sustained run of failures indicates a real misconfiguration
 * worth alarming the user about. 3 mirrors the dreamer circuit-breaker threshold.
 */
export declare const HISTORIAN_PERSISTENT_FAILURE_THRESHOLD = 3;
/**
 * User-facing notice for a historian (history-comparting) failure. The framing is
 * chosen by `failureCount` so users aren't alarmed by harmless transient blips:
 *
 *   - Below the threshold → calm reassurance: Magic Context retries automatically
 *     on the next turn, nothing is lost, and the conversation continues normally.
 *     We explicitly promise we'll only speak up again if it keeps failing.
 *   - At/above the threshold → escalation: the failures are persistent, so it's
 *     likely the configured historian model is misconfigured or unreachable, with
 *     the last error and the actionable next step (check magic-context.jsonc).
 *
 * Shared by both harnesses so the wording (and the transient/persistent contract)
 * never drifts between OpenCode and Pi.
 */
export declare function buildHistorianFailureNotice(failureCount: number, lastError: string): string;
export declare function buildHistorianRepairPrompt(originalPrompt: string, previousOutput: string, validationError: string, language?: string): string;
export declare function validateStoredCompartments(compartments: Array<{
    startMessage: number;
    endMessage: number;
}>): string | null;
export declare function validateChunkCoverage(chunk: {
    startIndex: number;
    endIndex: number;
    lines: Array<{
        ordinal: number;
    }>;
}): string | null;
export declare function getReducedRecompTokenBudget(currentBudget: number): number | null;
//# sourceMappingURL=compartment-runner-validation.d.ts.map