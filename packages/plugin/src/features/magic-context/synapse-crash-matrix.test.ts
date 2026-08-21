import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { DetailedEmbedItem, EmbeddingPageReceipt } from "./memory/embedding-provider";
import { insertMemory } from "./memory/storage-memory";
import { withClaimsWriteCapabilityInCurrentTransaction } from "./memory/storage-memory-claims";
import { runMigrations } from "./migrations";
import { contentSha256 } from "./project-embedding-registry";
import { initializeDatabase } from "./storage-db";
import {
    applySynapseReceiptGroup,
    getSynapseLedgerPage,
    pruneSynapseBatchLedgerForProject,
    reopenCompleteSynapseLedgerGroupWithProof,
    SynapseLedgerConflictError,
} from "./storage-embedding-measurements";
import {
    crashingDatabase,
    DetailedSynapseTestHost,
    detailedSynapseTestProvider,
    SYNAPSE_TEST_LANE_IDENTITY,
} from "./synapse-detailed-test-support";

const PROJECT = "git:crash-matrix";

interface LedgerRow {
    id: number;
    state: string;
    state_version: number;
    job_id: string | null;
    cursor: string | null;
}

function openInitializedDb(path: string): Database {
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function ledgerRows(db: Database): LedgerRow[] {
    return db
        .prepare(
            "SELECT id, state, state_version, job_id, cursor FROM synapse_batch_ledger ORDER BY id",
        )
        .all() as LedgerRow[];
}

function memoryVectorIds(db: Database): number[] {
    return (
        db
            .prepare(
                "SELECT memory_id AS memoryId FROM memory_embeddings WHERE model_id = ? ORDER BY memory_id",
            )
            .all(SYNAPSE_TEST_LANE_IDENTITY) as Array<{ memoryId: number }>
    ).map((row) => row.memoryId);
}

function memoryItems(
    memories: readonly { id: number; content: string }[],
    group = "g1",
): DetailedEmbedItem[] {
    return memories.map((memory) => ({
        id: `memory:${memory.id}`,
        text: memory.content,
        contentSha256: contentSha256(memory.content),
        applicationGroup: group,
    }));
}

async function embedToReceipts(
    db: Database,
    host: DetailedSynapseTestHost,
    items: DetailedEmbedItem[],
): Promise<{ receipts: EmbeddingPageReceipt[]; failureCodes: string[] }> {
    const provider = detailedSynapseTestProvider(host);
    const result = await provider.embedItemsDetailed(items, {
        db,
        projectPath: PROJECT,
        sessionId: PROJECT,
        scope: "memory",
        laneRole: "primary",
    });
    return {
        receipts: result.receipts,
        failureCodes: result.failures.map((failure) => failure.code),
    };
}

function applyMemoryReceipts(db: Database, receipts: readonly EmbeddingPageReceipt[]): void {
    applySynapseReceiptGroup(db, {
        receipts,
        expectation: {
            scope: "memory",
            laneRole: "primary",
            destinationModel: SYNAPSE_TEST_LANE_IDENTITY,
        },
        readCurrentHashes: (ids) => {
            const map = new Map<string, string>();
            for (const id of ids) {
                const row = db
                    .prepare(
                        "SELECT content FROM memories WHERE id = ? AND project_path = ? AND status = 'active'",
                    )
                    .get(Number(id.slice("memory:".length)), PROJECT) as
                    | { content?: string }
                    | undefined;
                if (row && typeof row.content === "string") {
                    map.set(id, contentSha256(row.content));
                }
            }
            return map;
        },
        writeDestination: () => {
            for (const receipt of receipts) {
                for (const [id, vector] of receipt.vectors) {
                    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
                    db.prepare(
                        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?)",
                    ).run(Number(id.slice("memory:".length)), blob, SYNAPSE_TEST_LANE_IDENTITY);
                }
            }
        },
    });
}

function assertCrashInvariant(db: Database, expectedMemoryIds: number[]): void {
    const rows = ledgerRows(db);
    const vectors = memoryVectorIds(db);
    const anyComplete = rows.some((row) => row.state === "complete");
    if (anyComplete) {
        expect(rows.every((row) => row.state === "complete")).toBe(true);
        expect(vectors).toEqual(expectedMemoryIds);
    } else {
        expect(vectors).toEqual([]);
        expect(rows.every((row) => row.state !== "complete")).toBe(true);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("synapse crash matrix (file-backed)", () => {
    const tempDirs: string[] = [];
    const openDbs: Database[] = [];

    function newDbPath(): string {
        const dir = mkdtempSync(join(tmpdir(), "synapse-crash-"));
        tempDirs.push(dir);
        return join(dir, "crash.db");
    }

    function track(db: Database): Database {
        openDbs.push(db);
        return db;
    }

    afterEach(() => {
        for (const db of openDbs.splice(0)) closeQuietly(db);
        for (const dir of tempDirs.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* Windows EBUSY */
            }
        }
    });

    function seedMemories(db: Database, count = 2): Array<{ id: number; content: string }> {
        const memories: Array<{ id: number; content: string }> = [];
        for (let index = 0; index < count; index += 1) {
            const memory = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: `memory body ${index}`,
            });
            memories.push({ id: memory.id, content: memory.content });
        }
        return memories;
    }

    const providerSideCrashes = [
        {
            name: "admission persistence (pending->polling CAS)",
            skipLedgerWrites: 0,
            multiPage: false,
        },
        { name: "diagnostic cursor update", skipLedgerWrites: 1, multiPage: true },
        { name: "ready CAS", skipLedgerWrites: 1, multiPage: false },
    ] as const;

    for (const crash of providerSideCrashes) {
        it(`crash at ${crash.name} leaves recoverable state and converges on rerun`, async () => {
            const path = newDbPath();
            const db = track(openInitializedDb(path));
            const memories = seedMemories(db);
            const host = new DetailedSynapseTestHost();
            if (crash.multiPage) {
                host.resultPages = (_jobId, items, index) => {
                    if (index === 0) {
                        return {
                            result: {
                                ...host.envelope(),
                                done: false,
                                next_cursor: "cursor-1",
                                vectors: items.slice(0, 1).map((item) => ({
                                    id: item.id,
                                    content_sha256: item.content_sha256,
                                    vector: [1, 2, 3],
                                })),
                            },
                        };
                    }
                    return {
                        result: {
                            ...host.envelope(),
                            done: true,
                            vectors: items.slice(1).map((item) => ({
                                id: item.id,
                                content_sha256: item.content_sha256,
                                vector: [1, 2, 3],
                            })),
                        },
                    };
                };
            }
            const crashed = crashingDatabase(db, {
                matcher: /UPDATE synapse_batch_ledger/,
                skip: crash.skipLedgerWrites,
                times: 99,
            });
            const firstRun = await embedToReceipts(crashed, host, memoryItems(memories));
            expect(firstRun.receipts).toEqual([]);
            expect(firstRun.failureCodes.length).toBeGreaterThan(0);

            const reopened = track(openInitializedDb(path));
            assertCrashInvariant(reopened, []);

            host.resultPages = undefined;
            const secondRun = await embedToReceipts(reopened, host, memoryItems(memories));
            expect(secondRun.failureCodes).toEqual([]);
            applyMemoryReceipts(reopened, secondRun.receipts);

            const final = track(openInitializedDb(path));
            assertCrashInvariant(
                final,
                memories.map((memory) => memory.id),
            );
            expect(ledgerRows(final).some((row) => row.state === "complete")).toBe(true);
        });
    }

    const applySideCrashes = [
        { name: "destination insert statement", matcher: /INSERT INTO memory_embeddings/ },
        { name: "receipt complete CAS", matcher: /UPDATE synapse_batch_ledger/ },
    ] as const;

    for (const crash of applySideCrashes) {
        it(`crash at ${crash.name} rolls back destination and ledger together`, async () => {
            const path = newDbPath();
            const db = track(openInitializedDb(path));
            const memories = seedMemories(db);
            const host = new DetailedSynapseTestHost();
            const ready = await embedToReceipts(db, host, memoryItems(memories));
            expect(ready.failureCodes).toEqual([]);
            const readyVersions = ledgerRows(db).map((row) => row.state_version);

            const crashed = crashingDatabase(db, { matcher: crash.matcher, times: 99 });
            expect(() => applyMemoryReceipts(crashed, ready.receipts)).toThrow();

            const reopened = track(openInitializedDb(path));
            assertCrashInvariant(reopened, []);
            const rows = ledgerRows(reopened);
            expect(rows.every((row) => row.state === "ready")).toBe(true);
            expect(rows.map((row) => row.state_version)).toEqual(readyVersions);

            applyMemoryReceipts(reopened, ready.receipts);
            const final = track(openInitializedDb(path));
            assertCrashInvariant(
                final,
                memories.map((memory) => memory.id),
            );
        });
    }

    it("outer rollback following a nested helper return preserves ready receipts and destination cardinality", async () => {
        const path = newDbPath();
        const db = track(openInitializedDb(path));
        const memories = seedMemories(db);
        const host = new DetailedSynapseTestHost();
        const ready = await embedToReceipts(db, host, memoryItems(memories));

        expect(() =>
            db.transaction(() => {
                applyMemoryReceipts(db, ready.receipts);
                throw new Error("outer caller crash following nested helper return");
            })(),
        ).toThrow("outer caller crash");

        const reopened = track(openInitializedDb(path));
        expect(memoryVectorIds(reopened)).toEqual([]);
        expect(ledgerRows(reopened).every((row) => row.state === "ready")).toBe(true);

        applyMemoryReceipts(reopened, ready.receipts);
        assertCrashInvariant(
            track(openInitializedDb(path)),
            memories.map((memory) => memory.id),
        );
    });

    it("crash immediately following outer commit leaves vectors and complete receipts together", async () => {
        const path = newDbPath();
        const db = track(openInitializedDb(path));
        const memories = seedMemories(db);
        const host = new DetailedSynapseTestHost();
        const ready = await embedToReceipts(db, host, memoryItems(memories));
        applyMemoryReceipts(db, ready.receipts);
        closeQuietly(openDbs.pop() as Database);

        const reopened = track(openInitializedDb(path));
        assertCrashInvariant(
            reopened,
            memories.map((memory) => memory.id),
        );
        expect(ledgerRows(reopened).every((row) => row.state === "complete")).toBe(true);
    });

    it("pruning the row mid-application aborts the transaction without destination writes", async () => {
        const path = newDbPath();
        const db = track(openInitializedDb(path));
        const memories = seedMemories(db);
        const host = new DetailedSynapseTestHost();
        const ready = await embedToReceipts(db, host, memoryItems(memories));

        db.prepare("UPDATE synapse_batch_ledger SET updated_at = ?").run(
            Date.now() - 15 * 24 * 60 * 60 * 1000,
        );
        expect(pruneSynapseBatchLedgerForProject(db, PROJECT)).toBeGreaterThan(0);

        expect(() => applyMemoryReceipts(db, ready.receipts)).toThrow(SynapseLedgerConflictError);
        expect(memoryVectorIds(db)).toEqual([]);
    });

    it("a stale worker with the prior state_version cannot complete or touch destination tables", async () => {
        const path = newDbPath();
        const db = track(openInitializedDb(path));
        const memories = seedMemories(db);
        const host = new DetailedSynapseTestHost();
        const ready = await embedToReceipts(db, host, memoryItems(memories));

        applyMemoryReceipts(db, ready.receipts);
        const afterFirst = ledgerRows(db);
        const vectorsAfterFirst = memoryVectorIds(db);

        expect(() => applyMemoryReceipts(db, ready.receipts)).toThrow(SynapseLedgerConflictError);
        expect(ledgerRows(db)).toEqual(afterFirst);
        expect(memoryVectorIds(db)).toEqual(vectorsAfterFirst);
    });

    it("source drift during application aborts everything and retires the drifted receipt", async () => {
        const path = newDbPath();
        const db = track(openInitializedDb(path));
        const memories = seedMemories(db);
        const host = new DetailedSynapseTestHost();
        const ready = await embedToReceipts(db, host, memoryItems(memories));

        // Simulates a concurrent claims-kernel writer editing the source
        // mid-flight; the capability opens the v84 semantic-write guard the
        // way the kernel would.
        withClaimsWriteCapabilityInCurrentTransaction(db, () =>
            db
                .prepare("UPDATE memories SET content = ? WHERE id = ?")
                .run("edited while embedding", memories[0].id),
        );
        expect(() => applyMemoryReceipts(db, ready.receipts)).toThrow(SynapseLedgerConflictError);
        expect(memoryVectorIds(db)).toEqual([]);
        const rows = ledgerRows(db);
        expect(rows.some((row) => row.state === "obsolete")).toBe(true);
        expect(rows.every((row) => row.state !== "complete")).toBe(true);
    });

    it("a complete row reopens only with destination proof and stays absorbing otherwise", async () => {
        const path = newDbPath();
        const db = track(openInitializedDb(path));
        const memories = seedMemories(db, 1);
        const host = new DetailedSynapseTestHost();
        const ready = await embedToReceipts(db, host, memoryItems(memories));
        applyMemoryReceipts(db, ready.receipts);
        const rowId = ledgerRows(db)[0].id;

        const destinationState = (item: { id: string }) =>
            db
                .prepare("SELECT 1 FROM memory_embeddings WHERE memory_id = ? AND model_id = ?")
                .get(Number(item.id.slice("memory:".length)), SYNAPSE_TEST_LANE_IDENTITY)
                ? ("current" as const)
                : ("absent" as const);

        expect(
            reopenCompleteSynapseLedgerGroupWithProof(db, {
                rowIds: [rowId],
                deadlineAt: Date.now() + 60_000,
                destinationState,
                invalidateDestination: () => {},
            }),
        ).toBe(0);
        expect(getSynapseLedgerPage(db, rowId)?.state).toBe("complete");

        db.prepare("DELETE FROM memory_embeddings WHERE model_id = ?").run(
            SYNAPSE_TEST_LANE_IDENTITY,
        );
        expect(
            reopenCompleteSynapseLedgerGroupWithProof(db, {
                rowIds: [rowId],
                deadlineAt: Date.now() + 60_000,
                destinationState,
                invalidateDestination: () => {},
            }),
        ).toBe(1);
        expect(getSynapseLedgerPage(db, rowId)?.state).toBe("pending");

        const rerun = await embedToReceipts(db, host, memoryItems(memories));
        expect(rerun.failureCodes).toEqual([]);
        applyMemoryReceipts(db, rerun.receipts);
        assertCrashInvariant(db, [memories[0].id]);
    });
});
