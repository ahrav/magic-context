import type { Database } from "../../shared/sqlite";
import { type ClaimPolicySeedRunSummary } from "./claim-policy-backfill";
export interface ClaimPolicySeedStartupOptions {
    log?: (message: string) => void;
    runSeed?: (db: Database) => Promise<ClaimPolicySeedRunSummary>;
}
/**
 * Start-of-process v86 policy seeding.
 *
 * Runs independently of the v84 claims backfill: until a revision is seeded it
 * reads as automatic-hidden (R26), so a seed that never runs leaves every
 * pre-existing memory invisible to injection, auto-search, and the native
 * mirror. Chaining it behind an unrelated backfill's success would make that
 * outage a side effect of that backfill's failure.
 */
export declare function runClaimPolicySeedStartup(db: Database, options?: ClaimPolicySeedStartupOptions): Promise<ClaimPolicySeedRunSummary | null>;
//# sourceMappingURL=claim-policy-backfill-startup.d.ts.map