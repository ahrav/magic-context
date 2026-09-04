import type { Database } from "../../shared/sqlite";
import { type Channel2PredicateBaseline } from "./ctx-reduce-nudge";
export declare function rearmChannel2AfterCoverageAdvancingHardFold(input: {
    db: Database;
    sessionId: string;
    foldExecuted: boolean;
    compactionOff: boolean;
    previousCoverage: number | null;
    currentCoverage: number | null;
}): boolean;
export declare function rearmChannel2AfterMeasuredCollapse(input: {
    db: Database;
    sessionId: string;
    baseline: Channel2PredicateBaseline;
}): boolean;
//# sourceMappingURL=channel2-cycle.d.ts.map