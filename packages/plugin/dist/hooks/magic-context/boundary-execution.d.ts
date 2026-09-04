export type BypassReason = "force-materialize" | "explicit-bust" | "subagent" | "none";
export interface BypassInput {
    contextUsage: {
        percentage: number;
    };
    sessionMeta: {
        isSubagent: boolean;
    };
    historyRefreshSessions: Set<string>;
    sessionId: string;
    effectiveExecuteThresholdPercentage: number;
}
export declare function detectMidTurnBypassReason(input: BypassInput): BypassReason;
export interface ApplyMidTurnDeferralInput {
    base: "execute" | "defer";
    bypassReason: BypassReason;
    midTurn: boolean;
}
export interface ApplyMidTurnDeferralOutput {
    midTurnAdjustedSchedulerDecision: "execute" | "defer";
    sideEffect: "set-flag" | "none";
}
export declare function applyMidTurnDeferral(input: ApplyMidTurnDeferralInput): ApplyMidTurnDeferralOutput;
//# sourceMappingURL=boundary-execution.d.ts.map