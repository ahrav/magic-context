import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";
import {
    listEmbeddingMeasurements,
    listMeasurementRowsWithOwnership,
    MEASUREMENT_CORPUS_SESSION_ROW_CAP,
    normalizedQueryHash,
    recordEmbeddingMeasurement,
} from "./storage-embedding-measurements";

describe("embedding measurement corpus", () => {
    const dirs: string[] = [];
    const original = process.env.XDG_DATA_HOME;

    function openTestDb() {
        const db = openDatabase();
        if (!db) throw new Error("openDatabase returned null in test setup");
        return db;
    }

    afterEach(() => {
        closeDatabase();
        process.env.XDG_DATA_HOME = original;
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("stores hashed, bounded rank lists once per query cohort", () => {
        const dir = mkdtempSync(join(tmpdir(), "embedding-measurements-"));
        dirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openTestDb();
        const input = {
            sessionId: "ses-measure",
            projectPath: "/repo",
            queryText: "  Queue   backpressure ",
            cohortKey: "fp-a:0|fp-b:0",
            primaryResultIds: Array.from({ length: 12 }, (_, index) => `p:${index}`),
            shadowResultIds: ["s:1"],
            primaryLatencyMs: 10,
            shadowLatencyMs: 20,
            primaryFailed: false,
            shadowFailed: false,
            primaryModelId: "local-id",
            shadowModelId: "synapse-id",
            primaryFingerprint: "",
            shadowFingerprint: "fp-b",
            primaryEpoch: 0,
            shadowEpoch: 0,
            corpusHash: "corpus",
            coverage: { primary: 12, shadow: 1 },
        } as const;

        expect(recordEmbeddingMeasurement(db, input)).toBe(true);
        expect(recordEmbeddingMeasurement(db, input)).toBe(false);
        const rows = listEmbeddingMeasurements(db, "ses-measure");
        expect(rows).toHaveLength(1);
        expect(rows[0].query_text_hash).toBe(normalizedQueryHash(input.queryText));
        expect(JSON.parse(rows[0].primary_result_ids_json)).toHaveLength(10);
        expect(rows[0].query_text_hash).not.toContain(input.queryText);
    });

    it("bounds a session's corpus rows, keeping the newest when the cap is exceeded", () => {
        const dir = mkdtempSync(join(tmpdir(), "embedding-measurements-cap-"));
        dirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openTestDb();
        const overflow = 5;
        const total = MEASUREMENT_CORPUS_SESSION_ROW_CAP + overflow;
        for (let i = 0; i < total; i++) {
            recordEmbeddingMeasurement(db, {
                sessionId: "ses-cap",
                projectPath: "/repo",
                // Unique query text per row: dedup is on (query hash, cohort), so
                // distinct queries simulate the cohort-transition growth.
                queryText: `query ${i}`,
                cohortKey: "fp-a:0|fp-b:0",
                primaryResultIds: [],
                shadowResultIds: [],
                primaryLatencyMs: 1,
                shadowLatencyMs: 1,
                primaryFailed: false,
                shadowFailed: false,
                primaryModelId: "local-id",
                shadowModelId: "synapse-id",
                primaryFingerprint: "",
                shadowFingerprint: "fp-b",
                primaryEpoch: 0,
                shadowEpoch: 0,
                corpusHash: `corpus-${i}`,
                coverage: {},
            });
        }

        const rows = listEmbeddingMeasurements(db, "ses-cap");
        expect(rows).toHaveLength(MEASUREMENT_CORPUS_SESSION_ROW_CAP);
        // The oldest `overflow` rows were pruned; the newest cap rows survive.
        expect(rows[0].query_text_hash).toBe(normalizedQueryHash(`query ${overflow}`));
        expect(rows[rows.length - 1].query_text_hash).toBe(
            normalizedQueryHash(`query ${total - 1}`),
        );
    });

    it("classifies measurement ownership from session_projects without writing", () => {
        const dir = mkdtempSync(join(tmpdir(), "embedding-measurements-owner-"));
        dirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openTestDb();
        const record = (sessionId: string, queryText: string) =>
            recordEmbeddingMeasurement(db, {
                sessionId,
                projectPath: "/repo",
                queryText,
                cohortKey: "fp-a:0|fp-b:0",
                primaryResultIds: [],
                shadowResultIds: [],
                primaryLatencyMs: 1,
                shadowLatencyMs: 1,
                primaryFailed: false,
                shadowFailed: false,
                primaryModelId: "local-id",
                shadowModelId: "synapse-id",
                primaryFingerprint: "",
                shadowFingerprint: "fp-b",
                primaryEpoch: 0,
                shadowEpoch: 0,
                corpusHash: "corpus",
                coverage: {},
            });
        const bind = (sessionId: string, harness: string, projectPath = "/repo") =>
            db
                .prepare(
                    "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, 0)",
                )
                .run(sessionId, harness, projectPath);

        record("ses-oc", "opencode query");
        bind("ses-oc", "opencode");
        record("ses-pi", "pi query");
        bind("ses-pi", "pi");
        record("ses-none", "unowned query");
        record("ses-both", "shared query");
        bind("ses-both", "opencode");
        bind("ses-both", "pi");
        record("ses-other", "other harness query");
        bind("ses-other", "mystery");
        // Ownership correlates on (session_id, project_path): a session that
        // is opencode in THIS project and pi in another still resolves here.
        record("ses-cross", "cross project query");
        bind("ses-cross", "opencode");
        bind("ses-cross", "pi", "/other-repo");

        const owned = listMeasurementRowsWithOwnership(db, { afterId: 0, limit: 100 });
        expect(owned.map((row) => [row.sessionId, row.ownership])).toEqual([
            ["ses-oc", "opencode"],
            ["ses-pi", "pi"],
            ["ses-none", "missing"],
            ["ses-both", "ambiguous"],
            ["ses-other", "ambiguous"],
            ["ses-cross", "opencode"],
        ]);
        expect(owned[0].queryTextHash).toBe(normalizedQueryHash("opencode query"));

        // Keyset paging covers the same rows without overlap or gaps.
        const firstPage = listMeasurementRowsWithOwnership(db, { afterId: 0, limit: 2 });
        expect(firstPage).toHaveLength(2);
        const secondPage = listMeasurementRowsWithOwnership(db, {
            afterId: firstPage[1].id,
            limit: 100,
        });
        expect([...firstPage, ...secondPage]).toEqual(owned);
    });
});
