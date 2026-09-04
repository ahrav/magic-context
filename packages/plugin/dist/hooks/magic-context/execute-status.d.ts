import type { DreamTaskBacklogMap, DreamTaskProgress } from "../../features/magic-context/dreamer/task-registry";
import type { TailHygieneStatus } from "../../shared/rpc-types";
import type { Database } from "../../shared/sqlite";
import { type WindowGeometryResult } from "../../shared/window-geometry";
export declare function executeStatus(db: Database, sessionId: string, protectedTags: number, executeThresholdPercentageConfig?: number | {
    default: number;
    [modelKey: string]: number;
}, liveModelKey?: string, historyBudgetPercentage?: number, commitClusterTrigger?: {
    enabled: boolean;
    min_clusters: number;
}, executeThresholdTokens?: {
    default?: number;
    [modelKey: string]: number | undefined;
}, contextLimit?: number, dreamer?: {
    backlog?: DreamTaskBacklogMap;
    progress?: DreamTaskProgress | null;
}, windowGeometry?: WindowGeometryResult, tailHygiene?: TailHygieneStatus): string;
//# sourceMappingURL=execute-status.d.ts.map