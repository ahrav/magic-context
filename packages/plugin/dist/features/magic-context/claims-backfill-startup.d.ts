import type { Database } from "../../shared/sqlite";
import { type ClaimsBackfillRunSummary } from "./claims-backfill";
export interface ClaimsBackfillStartupOptions {
    log?: (message: string) => void;
    runV22Backfill?: (db: Database) => Promise<unknown>;
    runBackfill?: (db: Database) => Promise<ClaimsBackfillRunSummary>;
}
export interface ClaimsBackfillStartupResult {
    ranV22Backfill: boolean;
    summary: ClaimsBackfillRunSummary | null;
}
export declare function runClaimsBackfillStartup(db: Database, options?: ClaimsBackfillStartupOptions): Promise<ClaimsBackfillStartupResult>;
//# sourceMappingURL=claims-backfill-startup.d.ts.map