import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    type ClaimsBackfillRunSummary,
    getClaimsBackfillStatus,
    runClaimsBackfill,
} from "./claims-backfill";
import { hasMemoryClaimsCompatSchema } from "./memory/storage-memory-claims";
import { runDeferredV22Backfill } from "./v22-deferred-backfill";

export interface ClaimsBackfillStartupOptions {
    log?: (message: string) => void;
    runV22Backfill?: (db: Database) => Promise<unknown>;
    runBackfill?: (db: Database) => Promise<ClaimsBackfillRunSummary>;
}

export interface ClaimsBackfillStartupResult {
    ranV22Backfill: boolean;
    summary: ClaimsBackfillRunSummary | null;
}

export async function runClaimsBackfillStartup(
    db: Database,
    options: ClaimsBackfillStartupOptions = {},
): Promise<ClaimsBackfillStartupResult> {
    const emit = options.log ?? log;
    const runV22 = options.runV22Backfill ?? runDeferredV22Backfill;
    const runBackfill = options.runBackfill ?? runClaimsBackfill;

    if (!hasMemoryClaimsCompatSchema(db)) {
        await runV22(db);
        return { ranV22Backfill: true, summary: null };
    }

    let status = getClaimsBackfillStatus(db);
    if (!status.applicable) {
        return { ranV22Backfill: false, summary: null };
    }

    let ranV22Backfill = false;
    if (status.v22Takeover === "pending") {
        ranV22Backfill = true;
        await runV22(db);
        status = getClaimsBackfillStatus(db);
    }
    if (status.phase === "complete" && status.v22Takeover !== "pending") {
        return { ranV22Backfill, summary: null };
    }

    const summary = await runBackfill(db);
    if (summary.status === "blocked") {
        emit(
            `[claims-backfill] blocked in phase ${summary.phaseAfter}: ${summary.problems.join("; ") || "see doctor status"}; run magic-context doctor --retry-claims-backfill`,
        );
    } else if (summary.status === "pending") {
        emit(
            "[claims-backfill] write lock stayed busy; work remains pending and resumes next start",
        );
    } else if (
        (summary.status === "complete" || summary.status === "complete-with-warnings") &&
        summary.batches > 0
    ) {
        emit(`[claims-backfill] ${summary.status}; rows adopted this run: ${summary.rowsAdopted}`);
    }
    return { ranV22Backfill, summary };
}
