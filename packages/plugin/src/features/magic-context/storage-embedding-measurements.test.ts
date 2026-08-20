import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { closeDatabase, openDatabase } from "./storage";
import { initializeDatabase } from "./storage-db";
import {
    completeSynapseLedgerReceipt,
    createSynapseLedgerPage,
    findSynapseLedgerPage,
    getSynapseLedgerPage,
    listEmbeddingMeasurements,
    listMeasurementRowsWithOwnership,
    MEASUREMENT_CORPUS_SESSION_ROW_CAP,
    markSynapseLedgerObsolete,
    markSynapseLedgerOutcome,
    markSynapseLedgerPolling,
    markSynapseLedgerReady,
    normalizedQueryHash,
    recordEmbeddingMeasurement,
    recordSynapseLedgerCursor,
    recordSynapseLedgerRestart,
    reopenCompleteSynapseLedgerPage,
    retrySynapseLedgerPage,
    SynapseLedgerConflictError,
    type SynapseLedgerPageInput,
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

describe("synapse batch ledger CAS journal", () => {
    function ledgerDb(): Database {
        const db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(db);
        runMigrations(db);
        return db;
    }

    function pageInput(overrides: Partial<SynapseLedgerPageInput> = {}): SynapseLedgerPageInput {
        return {
            projectPath: "/repo",
            sessionId: "ses-1",
            scope: "memory",
            laneRole: "primary",
            destinationModel: "synapse:v1:m",
            applicationGroup: "memory:1",
            requestKey: "k".repeat(64),
            manifest: [{ id: "memory:1", contentSha256: "h1" }],
            deadlineAt: Date.now() + 60_000,
            ...overrides,
        };
    }

    it("gives equal provider request keys distinct rows per context field", () => {
        const db = ledgerDb();
        try {
            const variants: Partial<SynapseLedgerPageInput>[] = [
                {},
                { projectPath: "/other" },
                { sessionId: "ses-2" },
                { scope: "commit", applicationGroup: "commit:x" },
                { laneRole: "shadow" },
                { destinationModel: "synapse:v1:other" },
                { applicationGroup: "memory:2" },
            ];
            const rowIds = variants.map((v) => createSynapseLedgerPage(db, pageInput(v)).rowId);
            expect(new Set(rowIds).size).toBe(variants.length);
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects a duplicate live page but allows a fresh row once the old one is obsolete", () => {
        const db = ledgerDb();
        try {
            const first = createSynapseLedgerPage(db, pageInput());
            expect(() => createSynapseLedgerPage(db, pageInput())).toThrow(
                SynapseLedgerConflictError,
            );
            markSynapseLedgerObsolete(db, {
                rowId: first.rowId,
                expectedStateVersion: first.stateVersion,
            });
            const second = createSynapseLedgerPage(db, pageInput());
            expect(second.rowId).not.toBe(first.rowId);
            expect(findSynapseLedgerPage(db, pageInput())?.rowId).toBe(second.rowId);
        } finally {
            closeQuietly(db);
        }
    });

    it("walks the legal pending -> polling -> ready -> complete path with monotonic versions", () => {
        const db = ledgerDb();
        try {
            let page = createSynapseLedgerPage(db, pageInput());
            expect(page.state).toBe("pending");
            expect(page.stateVersion).toBe(0);
            expect(page.deadlineAt).toBeGreaterThan(Date.now());

            page = markSynapseLedgerPolling(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                attemptId: "attempt-1",
                jobId: "job-1",
            });
            expect(page.state).toBe("polling");
            expect(page.stateVersion).toBe(1);
            expect(page.attemptId).toBe("attempt-1");
            expect(page.jobId).toBe("job-1");

            page = recordSynapseLedgerCursor(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                jobId: "job-1",
                cursor: "cursor-1",
            });
            expect(page.cursor).toBe("cursor-1");

            page = markSynapseLedgerReady(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                jobId: "job-1",
            });
            expect(page.state).toBe("ready");

            page = completeSynapseLedgerReceipt(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
            });
            expect(page.state).toBe("complete");
            expect(page.stateVersion).toBe(4);
        } finally {
            closeQuietly(db);
        }
    });

    it("treats a zero-row CAS as a hard conflict and never mutates the row", () => {
        const db = ledgerDb();
        try {
            const page = createSynapseLedgerPage(db, pageInput());
            expect(() =>
                markSynapseLedgerPolling(db, {
                    rowId: page.rowId,
                    expectedStateVersion: page.stateVersion + 1,
                    attemptId: "attempt-1",
                    jobId: "job-1",
                }),
            ).toThrow(SynapseLedgerConflictError);
            const after = getSynapseLedgerPage(db, page.rowId);
            expect(after?.state).toBe("pending");
            expect(after?.stateVersion).toBe(page.stateVersion);
            expect(after?.jobId).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("lets one of two selectors sharing a prior version win and hard-rejects the loser", () => {
        const db = ledgerDb();
        try {
            const created = createSynapseLedgerPage(db, pageInput());
            const snapshotVersion = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-1",
                jobId: "job-1",
            }).stateVersion;
            const winner = markSynapseLedgerReady(db, {
                rowId: created.rowId,
                expectedStateVersion: snapshotVersion,
                jobId: "job-1",
            });
            expect(winner.state).toBe("ready");
            expect(() =>
                markSynapseLedgerOutcome(db, {
                    rowId: created.rowId,
                    expectedStateVersion: snapshotVersion,
                    disposition: "retryable",
                }),
            ).toThrow(SynapseLedgerConflictError);
            expect(getSynapseLedgerPage(db, created.rowId)?.state).toBe("ready");
        } finally {
            closeQuietly(db);
        }
    });

    it("spends the single restart once, only under the current job and inside the deadline", () => {
        const db = ledgerDb();
        try {
            const created = createSynapseLedgerPage(db, pageInput());
            let page = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-1",
                jobId: "job-1",
            });
            expect(() =>
                recordSynapseLedgerRestart(db, {
                    rowId: page.rowId,
                    expectedStateVersion: page.stateVersion,
                    jobId: "job-other",
                }),
            ).toThrow(SynapseLedgerConflictError);
            page = recordSynapseLedgerRestart(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                jobId: "job-1",
            });
            expect(page.restartCount).toBe(1);
            expect(page.jobId).toBeNull();
            expect(page.cursor).toBeNull();
            const rejoined = db
                .prepare("UPDATE synapse_batch_ledger SET job_id = 'job-2' WHERE id = ?")
                .run(page.rowId);
            expect(rejoined.changes).toBe(1);
            expect(() =>
                recordSynapseLedgerRestart(db, {
                    rowId: page.rowId,
                    expectedStateVersion: page.stateVersion,
                    jobId: "job-2",
                }),
            ).toThrow(SynapseLedgerConflictError);
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects a restart after the absolute deadline", () => {
        const db = ledgerDb();
        try {
            const created = createSynapseLedgerPage(db, pageInput({ deadlineAt: Date.now() - 1 }));
            const page = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-1",
                jobId: "job-1",
            });
            expect(() =>
                recordSynapseLedgerRestart(db, {
                    rowId: page.rowId,
                    expectedStateVersion: page.stateVersion,
                    jobId: "job-1",
                }),
            ).toThrow(SynapseLedgerConflictError);
        } finally {
            closeQuietly(db);
        }
    });

    it("permits a retry only for a retryable disposition inside the deadline", () => {
        const db = ledgerDb();
        try {
            const retryable = createSynapseLedgerPage(db, pageInput());
            let page = markSynapseLedgerOutcome(db, {
                rowId: retryable.rowId,
                expectedStateVersion: retryable.stateVersion,
                disposition: "retryable",
            });
            page = retrySynapseLedgerPage(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
            });
            expect(page.state).toBe("pending");
            expect(page.failureDisposition).toBeNull();

            const permanent = createSynapseLedgerPage(
                db,
                pageInput({ applicationGroup: "memory:permanent" }),
            );
            const failed = markSynapseLedgerOutcome(db, {
                rowId: permanent.rowId,
                expectedStateVersion: permanent.stateVersion,
                disposition: "permanent",
            });
            expect(() =>
                retrySynapseLedgerPage(db, {
                    rowId: failed.rowId,
                    expectedStateVersion: failed.stateVersion,
                }),
            ).toThrow(SynapseLedgerConflictError);

            const expired = createSynapseLedgerPage(
                db,
                pageInput({
                    applicationGroup: "memory:expired",
                    deadlineAt: Date.now() - 1,
                }),
            );
            const expiredFailed = markSynapseLedgerOutcome(db, {
                rowId: expired.rowId,
                expectedStateVersion: expired.stateVersion,
                disposition: "retryable",
            });
            expect(() =>
                retrySynapseLedgerPage(db, {
                    rowId: expiredFailed.rowId,
                    expectedStateVersion: expiredFailed.stateVersion,
                }),
            ).toThrow(SynapseLedgerConflictError);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps complete absorbing except the destination-proof reopen, and obsolete terminal", () => {
        const db = ledgerDb();
        try {
            const created = createSynapseLedgerPage(db, pageInput());
            let page = markSynapseLedgerPolling(db, {
                rowId: created.rowId,
                expectedStateVersion: created.stateVersion,
                attemptId: "attempt-1",
                jobId: "job-1",
            });
            page = markSynapseLedgerReady(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                jobId: "job-1",
            });
            page = completeSynapseLedgerReceipt(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
            });
            expect(() =>
                markSynapseLedgerObsolete(db, {
                    rowId: page.rowId,
                    expectedStateVersion: page.stateVersion,
                }),
            ).toThrow(SynapseLedgerConflictError);
            expect(() =>
                markSynapseLedgerOutcome(db, {
                    rowId: page.rowId,
                    expectedStateVersion: page.stateVersion,
                    disposition: "retryable",
                }),
            ).toThrow(SynapseLedgerConflictError);

            page = reopenCompleteSynapseLedgerPage(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                deadlineAt: Date.now() + 60_000,
            });
            expect(page.state).toBe("pending");
            expect(page.jobId).toBeNull();
            expect(page.restartCount).toBe(0);

            page = markSynapseLedgerObsolete(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
            });
            expect(page.state).toBe("obsolete");
            const obsoleteVersion = page.stateVersion;
            for (const attempt of [
                () =>
                    retrySynapseLedgerPage(db, {
                        rowId: page.rowId,
                        expectedStateVersion: obsoleteVersion,
                    }),
                () =>
                    markSynapseLedgerPolling(db, {
                        rowId: page.rowId,
                        expectedStateVersion: obsoleteVersion,
                        attemptId: "a",
                        jobId: "j",
                    }),
                () =>
                    completeSynapseLedgerReceipt(db, {
                        rowId: page.rowId,
                        expectedStateVersion: obsoleteVersion,
                    }),
            ]) {
                expect(attempt).toThrow(SynapseLedgerConflictError);
            }
        } finally {
            closeQuietly(db);
        }
    });
});
