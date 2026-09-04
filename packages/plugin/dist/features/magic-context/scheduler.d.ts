import type { ContextUsage, SchedulerDecision, SessionMeta } from "./types";
export interface Scheduler {
    shouldExecute(sessionMeta: SessionMeta, contextUsage: ContextUsage, currentTime?: number, sessionId?: string, modelKey?: string, contextLimit?: number): SchedulerDecision;
}
interface SchedulerConfig {
    executeThresholdPercentage: number | {
        default: number;
        [modelKey: string]: number;
    };
    executeThresholdTokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
}
export declare function parseCacheTtl(ttl: string): number;
export declare function createScheduler(config: SchedulerConfig): Scheduler;
export {};
//# sourceMappingURL=scheduler.d.ts.map