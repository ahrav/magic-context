import type { Database } from "../../shared/sqlite";
import { type SubagentInvocationStatus, type SubagentKind } from "./storage-subagent-invocations";
export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
export interface LastAssistantModel {
    providerId: string | null;
    modelId: string | null;
}
export interface ChildInvocationRecordInput {
    db: Database | null;
    parentSessionId: string;
    harness: "opencode" | "pi";
    subagent: SubagentKind;
    startedAt: number;
    endedAt?: number;
    status: SubagentInvocationStatus;
    task?: string | null;
    messages?: unknown[];
    tokens?: TokenTotals;
    providerId?: string | null;
    modelId?: string | null;
    error?: unknown;
    parentInvocationId?: number | null;
}
export declare function emptyTokenTotals(): TokenTotals;
export declare function sumTokensFromChildMessages(messages: unknown[]): TokenTotals;
export declare function findLastAssistantModel(messages: unknown[]): LastAssistantModel;
export declare function recordChildInvocation(input: ChildInvocationRecordInput): number | null;
//# sourceMappingURL=subagent-token-capture.d.ts.map