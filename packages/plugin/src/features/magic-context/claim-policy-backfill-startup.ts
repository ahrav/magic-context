import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    type ClaimPolicySeedRunSummary,
    getClaimPolicySeedStatus,
    runClaimPolicySeed,
} from "./claim-policy-backfill";

export interface ClaimPolicySeedStartupOptions {
    log?: (message: string) => void;
    runSeed?: (db: Database) => ClaimPolicySeedRunSummary;
}

export function runClaimPolicySeedStartup(
    db: Database,
    options: ClaimPolicySeedStartupOptions = {},
): ClaimPolicySeedRunSummary | null {
    const emit = options.log ?? log;
    const status = getClaimPolicySeedStatus(db);
    if (!status.applicable || status.phase !== "pending") return null;
    const run = options.runSeed ?? runClaimPolicySeed;
    const summary = run(db);
    if (summary.status === "complete") {
        emit(
            `[claim-policy-seed] complete; seeded ${summary.seeded} revision(s), ` +
                `${summary.autoHidden} moved out of automatic visibility ` +
                `(${JSON.stringify(summary.seededCounts)})`,
        );
    } else if (summary.status === "pending") {
        emit("[claim-policy-seed] bounded run left work pending; resumes next start");
    }
    return summary;
}
