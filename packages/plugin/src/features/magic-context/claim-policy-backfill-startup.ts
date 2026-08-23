import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    type ClaimPolicySeedRunSummary,
    getClaimPolicySeedStatus,
    reconcileCompatibilityVerificationsAtStartup,
    runClaimPolicySeed,
} from "./claim-policy-backfill";

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
export async function runClaimPolicySeedStartup(
    db: Database,
    options: ClaimPolicySeedStartupOptions = {},
): Promise<ClaimPolicySeedRunSummary | null> {
    const emit = options.log ?? log;
    const status = getClaimPolicySeedStatus(db);
    // A "complete" phase still runs: the seeder's own anti-join probe catches
    // revisions a held-open v85 writer appended after completion published
    // (it returns a cheap noop when completion holds).
    if (!status.applicable || status.phase === null) return null;
    const run = options.runSeed ?? runClaimPolicySeed;
    const summary = await run(db);
    if (summary.status === "complete") {
        emit(
            `[claim-policy-seed] complete; seeded ${summary.seeded} revision(s), ` +
                `${summary.autoHidden} moved out of automatic visibility ` +
                `(${JSON.stringify(summary.seededCounts)})`,
        );
    } else if (summary.status === "pending") {
        emit(
            `[claim-policy-seed] ${summary.batches} batch(es) left work pending; resumes next start`,
        );
    }
    // Positive verification events from a held-open v85 writer never run the
    // ladder reducer, and the read path only lets negative facts override the
    // projection — reconcile them here, where every host already runs.
    const reconciled = reconcileCompatibilityVerificationsAtStartup(db);
    if (reconciled > 0) {
        emit(
            `[claim-policy-seed] refreshed ${reconciled} revision(s) with unreconciled compatibility verification`,
        );
    }
    return summary;
}
