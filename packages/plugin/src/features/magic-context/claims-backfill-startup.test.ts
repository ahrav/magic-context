/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { ClaimsBackfillRunSummary } from "./claims-backfill";
import { runClaimsBackfillStartup } from "./claims-backfill-startup";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { CLAIMS_BACKFILL_META_KEYS } from "./storage-memory-claims-schema";

const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs.splice(0)) closeQuietly(db);
});

function database(migrate: boolean, withMemory = false): Database {
    const db = new Database(":memory:");
    dbs.push(db);
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    if (withMemory) {
        db.prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash,
                 first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('git:startup', 'CONSTRAINTS', 'startup row', 'startup-hash', 1, 1, 1, 1)`,
        ).run();
    }
    if (migrate) runMigrations(db);
    return db;
}

function writeMeta(db: Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

const COMPLETE_SUMMARY: ClaimsBackfillRunSummary = {
    status: "complete",
    phaseBefore: "rows",
    phaseAfter: "complete",
    rowsAdopted: 1,
    batches: 3,
    problems: [],
};

describe("runClaimsBackfillStartup", () => {
    test("pre-v84 storage runs only the legacy v22 scheduler", async () => {
        const db = database(false);
        let v22Runs = 0;
        let claimRuns = 0;
        const result = await runClaimsBackfillStartup(db, {
            runV22Backfill: async () => {
                v22Runs += 1;
            },
            runBackfill: async () => {
                claimRuns += 1;
                return COMPLETE_SUMMARY;
            },
        });
        expect(result).toEqual({ ranV22Backfill: true, summary: null });
        expect({ v22Runs, claimRuns }).toEqual({ v22Runs: 1, claimRuns: 0 });
    });

    test("v22 takeover resolves before an empty complete claims checkpoint becomes a no-op", async () => {
        const db = database(true);
        let claimRuns = 0;
        const result = await runClaimsBackfillStartup(db, {
            runV22Backfill: async (target) => {
                writeMeta(target, "v22_legacy_memory_backfill", "completed");
                writeMeta(target, CLAIMS_BACKFILL_META_KEYS.v22Takeover, "none");
            },
            runBackfill: async () => {
                claimRuns += 1;
                return COMPLETE_SUMMARY;
            },
        });
        expect(result).toEqual({ ranV22Backfill: true, summary: null });
        expect(claimRuns).toBe(0);
    });

    test("a still-pending v22 takeover prevents the complete checkpoint no-op", async () => {
        const db = database(true);
        let claimRuns = 0;
        const result = await runClaimsBackfillStartup(db, {
            runV22Backfill: async () => {},
            runBackfill: async () => {
                claimRuns += 1;
                return {
                    ...COMPLETE_SUMMARY,
                    status: "blocked",
                    phaseBefore: "complete",
                    phaseAfter: "complete",
                    rowsAdopted: 0,
                    batches: 0,
                    problems: ["pending v22 identity work"],
                };
            },
        });
        expect(result.ranV22Backfill).toBeTrue();
        expect(result.summary?.status).toBe("blocked");
        expect(claimRuns).toBe(1);
    });

    test("a nonempty lazy checkpoint invokes the shared claims runner once", async () => {
        const db = database(false, true);
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR REPLACE INTO schema_migrations_meta (key, value)
            VALUES ('v22_legacy_memory_backfill', 'completed');
        `);
        runMigrations(db);
        let v22Runs = 0;
        let claimRuns = 0;
        const messages: string[] = [];
        const result = await runClaimsBackfillStartup(db, {
            log: (message) => messages.push(message),
            runV22Backfill: async () => {
                v22Runs += 1;
            },
            runBackfill: async () => {
                claimRuns += 1;
                return COMPLETE_SUMMARY;
            },
        });
        expect(result.summary).toEqual(COMPLETE_SUMMARY);
        expect({ v22Runs, claimRuns }).toEqual({ v22Runs: 0, claimRuns: 1 });
        expect(messages.join("\n")).toContain("rows adopted this run: 1");
    });

    test("repeat startups over an unchanged blocked corpus skip the full re-scan", async () => {
        const db = database(false);
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR REPLACE INTO schema_migrations_meta (key, value)
            VALUES ('v22_legacy_memory_backfill', 'completed');
        `);
        // A raw project path never resolves, so the lazy runner blocks.
        db.prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash,
                 first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('raw-legacy-path', 'CONSTRAINTS', 'blocked row', 'blocked-hash', 1, 1, 1, 1)`,
        ).run();
        runMigrations(db);

        const first = await runClaimsBackfillStartup(db, { log: () => {} });
        expect(first.summary?.status).toBe("blocked");
        expect(first.summary?.batches).toBeGreaterThan(0);

        const messages: string[] = [];
        const second = await runClaimsBackfillStartup(db, {
            log: (message) => messages.push(message),
        });
        expect(second.summary?.status).toBe("blocked");
        expect(second.summary?.batches).toBe(0);
        expect(messages.join("\n")).toContain("--retry-claims-backfill");
    });

    test("post-completion within-boundary blocking rows surface at startup instead of a silent no-op", async () => {
        const db = database(false, true);
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR REPLACE INTO schema_migrations_meta (key, value)
            VALUES ('v22_legacy_memory_backfill', 'completed');
        `);
        runMigrations(db);
        const first = await runClaimsBackfillStartup(db, { log: () => {} });
        expect(first.summary?.status).toBe("complete");

        // A live writer records a blocking diagnostic inside the boundary
        // corpus while the checkpoint still reads `complete`; the startup
        // gate must run the oracle and surface it instead of early-returning
        // on the raw phase.
        db.prepare(
            `INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
             VALUES ('rows', 'memory', '1', 'unresolved-project-identity', '', 'blocking', 1, 1)`,
        ).run();

        const messages: string[] = [];
        const second = await runClaimsBackfillStartup(db, {
            log: (message) => messages.push(message),
        });
        expect(second.summary?.status).toBe("blocked");
        expect(messages.join("\n")).toContain("--retry-claims-backfill");
    });
});
