import type { Scheduler } from "../../features/magic-context/scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
};
export declare function loadContextUsage(contextUsageMap: Map<string, ContextUsageCacheEntry>, db: ContextDatabase, sessionId: string): ContextUsage;
export declare function resolveSchedulerDecision(scheduler: Scheduler, sessionMeta: SessionMeta, contextUsage: ContextUsage, sessionId: string, modelKey?: string, contextLimit?: number): "execute" | "defer";
export {};
//# sourceMappingURL=transform-context-state.d.ts.map