/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory, recordMemoryVerifications, setMemoryClassification } from "../memory";
import {
    getCurrentMemoryClaimByLegacyMemoryId,
    runInMemoryClaimsWriteTransaction,
} from "../memory/storage-memory-claims";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { evaluateTaskGate, getDreamTaskBacklog } from "./task-gates";
import { processedDreamTaskItems } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

describe("dream task backlog probes", () => {
    test("keeps claim-backed backlog probes on legacy memory shapes", () => {
        const database = freshDb();
        db = database;
        const projectIdentity = "git:u6-dreamer-reader";
        const content = "dreamer projection bytes: café";
        const memory = insertMemory(database, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content,
        });
        expect(getCurrentMemoryClaimByLegacyMemoryId(database, memory.id)?.content).toBe(content);

        const statements: string[] = [];
        const originalPrepare = database.prepare.bind(database);
        database.prepare = ((sql: string) => {
            statements.push(sql);
            return originalPrepare(sql);
        }) as typeof database.prepare;
        let backlog: ReturnType<typeof getDreamTaskBacklog>;
        try {
            backlog = getDreamTaskBacklog(database, projectIdentity, "classify-memories");
        } finally {
            database.prepare = originalPrepare;
        }

        expect(backlog).toEqual({ pending: 1, total: 1 });
        expect(Buffer.from(JSON.stringify(backlog))).toEqual(
            Buffer.from('{"pending":1,"total":1}'),
        );
        expect(statements.some((sql) => /\bmemories\b/i.test(sql))).toBeTrue();
        expect(
            statements.some((sql) => /legacy_memory_claims|claim_revisions|\bclaims\b/i.test(sql)),
        ).toBeFalse();
    });

    test("map and classify probes match seeded candidate counts", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        const first = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Keep the first memory mapped.",
        });
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "The second memory still needs mapping and classification.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());

        expect(getDreamTaskBacklog(db, projectIdentity, "map-memories")).toEqual({
            pending: 1,
            total: 2,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 2,
            total: 2,
        });

        setMemoryClassification(db, first.id, { importance: 80 });
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("verify probe counts only mapped memories that are still unverified", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        const pending = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "This mapped memory still needs verification.",
        });
        const verified = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "This mapped memory has already been verified.",
        });
        recordMemoryVerifications(db, pending.id, ["src/pending.ts"], Date.now());
        recordMemoryVerifications(db, verified.id, ["src/verified.ts"], Date.now());
        const database = db;
        runInMemoryClaimsWriteTransaction(database, () =>
            database
                .prepare("UPDATE memory_verifications SET verified_at = ? WHERE memory_id = ?")
                .run(0, pending.id),
        );

        expect(getDreamTaskBacklog(db, projectIdentity, "verify")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("processed count is the start-to-end backlog reduction", () => {
        expect(processedDreamTaskItems(17, 5)).toBe(12);
        expect(processedDreamTaskItems(5, 7)).toBe(0);
    });
});

describe("evaluateTaskGate", () => {
    test("classify-memories runs when active memories exist", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: null,
                promotionThreshold: 3,
            }),
        ).toBe(false);

        insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Use Bun for package scripts in this repo.",
        });

        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: Date.now(),
                promotionThreshold: 3,
            }),
        ).toBe(true);
    });

    test("retrospective gates on the CONTENT watermark, not lastRunAt", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("s1", "opencode", projectIdentity, 200);

        // Never scanned → runs.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: null,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Session newer than watermark → runs (even if lastRunAt is newer — the
        // session was updated mid-run, so its content hasn't been scanned).
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: 9999,
                retrospectiveWatermarkMs: 100,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Watermark at/after the session update → nothing new → skip.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: 300,
                promotionThreshold: 3,
            }),
        ).toBe(false);
    });
});
