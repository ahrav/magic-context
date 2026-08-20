import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedUnembeddedMemoriesForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "../project-embedding-registry";
import { closeDatabase, openDatabase } from "../storage";
import {
    DetailedSynapseTestHost,
    detailedSynapseTestProvider,
    SYNAPSE_TEST_LANE_IDENTITY,
    synapseTestConfig,
} from "../synapse-detailed-test-support";
import { ensureMemoryEmbeddings } from "./embedding-backfill";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
import { insertMemory } from "./storage-memory";
import { loadAllEmbeddings } from "./storage-memory-embeddings";

class FakeEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    constructor(modelId: string) {
        this.modelId = modelId;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        return new Float32Array([text.length, this.modelId.length]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        return texts.map((text) => new Float32Array([text.length, this.modelId.length]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function localConfig(model: string): EmbeddingConfig {
    return { provider: "local", model };
}

function currentModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
}

describe("ensureMemoryEmbeddings (read-path backfill)", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "embedding-backfill-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        if (!db) throw new Error("failed to open test database");
        return db;
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
        tempDirs.length = 0;
    });

    it("saves and caches the vector when the memory content stays unchanged", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:backfill-happy";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Backfill me on the read path.",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill-happy",
        );

        const cache = await ensureMemoryEmbeddings({
            db,
            projectIdentity,
            memories: [memory],
            existingEmbeddings: new Map(),
        });

        expect(cache.has(memory.id)).toBe(true);
        expect(
            loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity)).has(memory.id),
        ).toBe(true);
    });

    it("discards the stale vector, skips the cache, and leaves the row for the guarded drain when the memory is edited mid-flight", async () => {
        let release: (() => void) | undefined;
        let batchStarted: (() => void) | undefined;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    firstBatch = true;
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        // Gate only the first batch so the follow-up guarded drain
                        // (which embeds again) runs without blocking.
                        if (this.firstBatch) {
                            this.firstBatch = false;
                            batchStarted?.();
                            await new Promise<void>((resolve) => {
                                release = resolve;
                            });
                        }
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:backfill-stale";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Old memory body",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill-stale",
        );

        const started = new Promise<void>((resolve) => {
            batchStarted = resolve;
        });
        const inFlight = ensureMemoryEmbeddings({
            db,
            projectIdentity,
            memories: [memory],
            existingEmbeddings: new Map(),
        });
        await started;
        // Edit the memory while the provider call is in flight: the vector the
        // backfill receives was computed from the OLD content.
        db.prepare(
            "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
        ).run("New memory body (edited)", "new-memory-hash", Date.now(), memory.id);
        release?.();

        const cache = await inFlight;

        // The stale vector is neither persisted nor cached.
        expect(cache.has(memory.id)).toBe(false);
        expect(loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity)).size).toBe(
            0,
        );

        // Because no embedding row was written, the row still looks unembedded and
        // the guarded proactive drain re-embeds the CURRENT content next round.
        const embedded = await embedUnembeddedMemoriesForProject(db, projectIdentity, 10);
        expect(embedded).toBe(1);
        const stored = loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity));
        expect(stored.size).toBe(1);
        // The fake provider encodes text length into the vector's first element:
        // the stored vector must be the NEW content's (24 chars), not the stale
        // old one (15 chars).
        expect(stored.get(memory.id)?.embedding[0]).toBe("New memory body (edited)".length);
    });
});

describe("ensureMemoryEmbeddings through versioned synapse receipts", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "embedding-backfill-detailed-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        if (!db) throw new Error("failed to open test database");
        return db;
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
    });

    it("writes vectors, completes receipts, and merges the cache only for committed rows", async () => {
        const db = useTempDb();
        const projectIdentity = "git:backfill-detailed";
        const host = new DetailedSynapseTestHost();
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse" ? detailedSynapseTestProvider(host) : null,
        );
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Backfill me through receipts.",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            synapseTestConfig(),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill-detailed",
        );

        const cache = await ensureMemoryEmbeddings({
            db,
            projectIdentity,
            memories: [memory],
            existingEmbeddings: new Map(),
        });

        expect(cache.get(memory.id)?.modelId).toBe(SYNAPSE_TEST_LANE_IDENTITY);
        expect(loadAllEmbeddings(db, projectIdentity, SYNAPSE_TEST_LANE_IDENTITY).size).toBe(1);
        const ledger = db
            .prepare("SELECT state, scope FROM synapse_batch_ledger ORDER BY id")
            .all() as Array<{ state: string; scope: string }>;
        expect(ledger.length).toBeGreaterThan(0);
        expect(ledger.every((row) => row.state === "complete" && row.scope === "memory")).toBe(
            true,
        );
    });

    it("merges no cache entry and writes nothing when the memory drifts before the transaction", async () => {
        const db = useTempDb();
        const projectIdentity = "git:backfill-detailed-drift";
        const host = new DetailedSynapseTestHost();
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse" ? detailedSynapseTestProvider(host) : null,
        );
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Original body",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            synapseTestConfig(),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill-detailed-drift",
        );
        host.resultPages = (_jobId, items) => {
            db.prepare(
                "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
            ).run("Edited mid-flight", "edited-hash", Date.now(), memory.id);
            return {
                result: {
                    ...host.envelope(),
                    done: true,
                    vectors: items.map((item) => ({
                        id: item.id,
                        content_sha256: item.content_sha256,
                        vector: [1, 2, 3],
                    })),
                },
            };
        };

        const cache = await ensureMemoryEmbeddings({
            db,
            projectIdentity,
            memories: [memory],
            existingEmbeddings: new Map(),
        });

        expect(cache.has(memory.id)).toBe(false);
        expect(loadAllEmbeddings(db, projectIdentity, SYNAPSE_TEST_LANE_IDENTITY).size).toBe(0);
        const ledger = db
            .prepare("SELECT state FROM synapse_batch_ledger ORDER BY id")
            .all() as Array<{ state: string }>;
        expect(ledger.every((row) => row.state !== "complete")).toBe(true);
    });
});
