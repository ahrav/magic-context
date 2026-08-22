import { readSync, writeSync } from "node:fs";
import { Database } from "../../../../shared/sqlite.ts";
import {
    type ClaimsBackfillFailpointId,
    type ClaimsMigrationFailpointId,
    runClaimsBackfill,
    setClaimsBackfillCalibrationForTests,
    setClaimsBackfillFailpoint,
} from "../../claims-backfill.ts";
import { runMigrations } from "../../migrations.ts";
import { insertMemory } from "../storage-memory.ts";
import {
    acknowledgeMemoryClaimResult,
    type MemoryClaimFailpointId,
    setMemoryClaimFailpoint,
} from "../storage-memory-claims.ts";

const [, , command, dbPath, siteArg] = process.argv;
if (!command || !dbPath) throw new Error("usage: claims-crash-worker <command> <db> [site]");

const message = (event: string, extra: Record<string, unknown> = {}): void => {
    writeSync(1, `CLAIMS_CRASH ${JSON.stringify({ event, ...extra })}\n`);
};

const blockAtSite = (site: string): void => {
    message("reached", { site });
    const input = Buffer.alloc(4);
    const bytes = readSync(0, input, 0, input.length, null);
    if (bytes < 3 || input.subarray(0, bytes).toString("utf8").trim() !== "act") {
        throw new Error(`invalid supervisor action at ${site}`);
    }
    message("act-ready", { site });
    readSync(0, input, 0, input.length, null);
    throw new Error(`supervisor closed action pipe at ${site}`);
};

const open = (): Database => {
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    return db;
};

const memoryInput = {
    projectPath: "git:claims-crash",
    category: "CONSTRAINTS" as const,
    content: "crash-safe claim tuple",
    sourceSessionId: "ses_claims_crash",
    sourceType: "agent" as const,
    nowMs: 1_777_777,
};
const memoryEnvelope = {
    producer: "claims-crash-worker",
    operationKey: "memory-create-v1",
    requestDigest: "c".repeat(64),
};

const runMemory = (db: Database): void => {
    insertMemory(db, memoryInput, memoryEnvelope);
};

const sqliteVersion = (db: Database): string =>
    (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;

const main = async (): Promise<void> => {
    const db = open();
    try {
        if (command === "crash-memory") {
            const site = siteArg as MemoryClaimFailpointId;
            setMemoryClaimFailpoint(site, () => blockAtSite(site));
            runMemory(db);
            if (site === "memory-claim.070.ack.after") {
                message("acknowledged", { site });
                acknowledgeMemoryClaimResult();
            }
            throw new Error(`planned failpoint was unreachable: ${site}`);
        }
        if (command === "crash-backfill") {
            const site = siteArg as ClaimsBackfillFailpointId;
            setClaimsBackfillFailpoint(site, () => blockAtSite(site));
            await runClaimsBackfill(db, { batchSize: 1, yieldToEventLoop: async () => {} });
            throw new Error(`planned failpoint was unreachable: ${site}`);
        }
        if (command === "crash-migration") {
            const site = siteArg as ClaimsMigrationFailpointId;
            setClaimsBackfillCalibrationForTests({
                cutoffRows: 10,
                evidenceDigest: "e".repeat(64),
            });
            setClaimsBackfillFailpoint(site, () => blockAtSite(site));
            runMigrations(db);
            throw new Error(`planned failpoint was unreachable: ${site}`);
        }
        if (command === "recover-memory") runMemory(db);
        else if (command === "recover-backfill") {
            await runClaimsBackfill(db, { batchSize: 1, yieldToEventLoop: async () => {} });
        } else if (command === "recover-migration") {
            setClaimsBackfillCalibrationForTests({
                cutoffRows: 10,
                evidenceDigest: "e".repeat(64),
            });
            runMigrations(db);
        } else if (command !== "reopen") {
            throw new Error(`unknown command: ${command}`);
        }
        message("done", { command, sqliteVersion: sqliteVersion(db) });
    } finally {
        db.close();
    }
};

main().catch((error) => {
    message("error", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
});
