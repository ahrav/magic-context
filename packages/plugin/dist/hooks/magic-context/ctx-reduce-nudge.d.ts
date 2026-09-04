import { type TailHygieneBaseline, type TailHygienePartMeasurement } from "./tail-hygiene-walk";
export type Channel1Level = "gentle" | "firm" | "urgent";
export interface ToolReclaimHint {
    tagNumber: number;
    toolName: string | null;
}
export interface Channel1State {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    baselineGeneration: number;
    computedAt: number;
    evaluable: boolean;
    generationInvalidated: boolean;
    baselineParts: TailHygienePartMeasurement[];
    contentSignature: string;
    reducedSinceRefresh: boolean;
    oldestReclaimableToolTags: ToolReclaimHint[];
}
export declare const CHANNEL1_SENTINEL = "<system-reminder>";
export declare const TOKENS_PER_BYTE = 0.25;
export declare const CHANNEL1_MIN_TOKENS = 60000;
export declare const CHANNEL1_FLOOR_TOKENS = 25000;
export declare const CHANNEL1_REFIRE_FLOOR_TOKENS = 25000;
export declare function channel1RefireTokens(tailTokens: number): number;
export declare function isDroppedToolOutput(output: string): boolean;
export declare function tailToolTokensFromStrings(outputs: readonly string[]): number;
export declare function toolOutputTokens(output: string): number;
export interface TailTokenEstimate {
    tailToolTokens: number;
    liveTailTokens: number;
}
export interface Channel1Decision {
    fire: boolean;
    level: Channel1Level;
    undroppedTokens: number;
    tailTokens: number;
    severity: number;
    nextLastNudge: number;
    nextLastNudgeLevel: Channel1Level | "";
}
export declare function decideChannel1(input: {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    lastNudgeUndropped: number;
    lastNudgeLevel: Channel1Level | "";
    hasRecentReduce: boolean;
    evaluable?: boolean;
    generationInvalidated?: boolean;
}): Channel1Decision;
export declare const CHANNEL2_SEVERITY_THRESHOLD = 0.75;
export declare const CHANNEL2_FLOOR_TOKENS = 50000;
export type Channel2PredicateBaseline = Pick<TailHygieneBaseline, "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT" | "evaluable" | "generationInvalidated">;
export interface Channel2PredicateEvaluation {
    evaluable: boolean;
    shouldTrigger: boolean;
    reclaimableTokens: number;
    tailTokens: number;
    severity: number;
}
export declare function evaluateChannel2(input: Channel2PredicateBaseline | undefined): Channel2PredicateEvaluation;
export declare function buildChannel2Reminder(undroppedTokens: number, hint?: readonly ToolReclaimHint[]): string;
export declare function buildChannel1Reminder(level: Channel1Level, undroppedTokens: number, hint?: readonly ToolReclaimHint[]): string;
//# sourceMappingURL=ctx-reduce-nudge.d.ts.map