import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { Database } from "../../shared/sqlite";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    getShadowEmbeddingMeasurementCohort,
    registerProjectShadowEmbedding,
} from "./project-embedding-registry";
import type { UnifiedSearchOptions, UnifiedSearchResult } from "./search";
import { recordShadowMeasurement } from "./search-measurement";
import { closeDatabase, openDatabase } from "./storage";
import { listEmbeddingMeasurements } from "./storage-embedding-measurements";

class FakeShadowProvider implements EmbeddingProvider {
    readonly modelId = "synapse:v1:fake";

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        _text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        return new Float32Array([1, 2]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array([1, 2]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

const synapseConfig = {
    provider: "synapse",
    model: "synapse-model",
    synapse_fingerprint: "fp-shadow",
    synapse_table_epoch: 1,
    synapse_dims: 8,
} as unknown as EmbeddingConfig;

describe("recordShadowMeasurement", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "search-measurement-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        if (!db) throw new Error("openDatabase returned null in test setup");
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

    function makeMeasurementArgs(dbOverride: Database) {
        return {
            db: dbOverride,
            sessionId: "ses-shadow",
            projectPath: "git:shadow-measure",
            query: "queue backpressure",
            options: {} as UnifiedSearchOptions,
            primaryResults: [] as UnifiedSearchResult[],
            primaryQuery: null,
            primaryLatencyMs: 5,
            search: async () => [] as UnifiedSearchResult[],
        };
    }

    it("resolves even when the measurement corpus write throws", async () => {
        const db = useTempDb();
        _setTestProviderFactoryForProject(() => new FakeShadowProvider());
        registerProjectShadowEmbedding(db, "git:shadow-measure", synapseConfig, "/tmp/shadow");

        // A closed database makes the terminal recordEmbeddingMeasurement write
        // throw (the SQLITE_BUSY class of failure the guard must contain).
        const closedDb = new Database(":memory:");
        closedDb.close();

        await expect(
            recordShadowMeasurement(makeMeasurementArgs(closedDb)),
        ).resolves.toBeUndefined();
    });

    it("never raises an unhandled rejection when floated like the search call site", async () => {
        const db = useTempDb();
        _setTestProviderFactoryForProject(() => new FakeShadowProvider());
        registerProjectShadowEmbedding(db, "git:shadow-measure", synapseConfig, "/tmp/shadow");

        const closedDb = new Database(":memory:");
        closedDb.close();

        const rejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        process.on("unhandledRejection", onUnhandledRejection);
        try {
            // Mirrors unifiedSearch (search.ts): the measurement is void-floated
            // after results are built, so any rejection would be unhandled.
            void recordShadowMeasurement(makeMeasurementArgs(closedDb));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(rejections).toHaveLength(0);
        } finally {
            process.off("unhandledRejection", onUnhandledRejection);
        }
    });

    it("embeds the replayed query with purpose query, reuses the vector, and disables recursion (AE4)", async () => {
        const db = useTempDb();
        const embedCalls: { text: string; purpose?: EmbeddingPurpose }[] = [];
        const shadowVector = new Float32Array([1, 2]);
        class RecordingShadowProvider extends FakeShadowProvider {
            override async embed(
                text: string,
                _signal?: AbortSignal,
                purpose?: EmbeddingPurpose,
            ): Promise<Float32Array> {
                embedCalls.push({ text, ...(purpose === undefined ? {} : { purpose }) });
                return shadowVector;
            }
        }
        _setTestProviderFactoryForProject(() => new RecordingShadowProvider());
        registerProjectShadowEmbedding(db, "git:shadow-measure", synapseConfig, "/tmp/shadow");

        const seenOptions: UnifiedSearchOptions[] = [];
        await recordShadowMeasurement({
            ...makeMeasurementArgs(db),
            search: async (_db, _sessionId, _projectPath, _query, options) => {
                seenOptions.push(options ?? {});
                const replayed = await options?.embedQuery?.("queue backpressure");
                expect(replayed).toBe(shadowVector);
                return [];
            },
        });

        expect(embedCalls).toEqual([{ text: "queue backpressure", purpose: "query" }]);
        expect(seenOptions).toHaveLength(1);
        expect(seenOptions[0].measurementDisabled).toBe(true);
    });

    it("records rank lists and corpus hash byte-identical to the legacy inline encoding", async () => {
        const db = useTempDb();
        _setTestProviderFactoryForProject(() => new FakeShadowProvider());
        registerProjectShadowEmbedding(db, "git:shadow-measure", synapseConfig, "/tmp/shadow");

        const primaryResults = [
            { source: "memory", memoryId: 42 },
            { source: "compartment", compartmentId: 7 },
            { source: "git_commit", sha: "abc123" },
        ] as unknown as UnifiedSearchResult[];
        const shadowResults = [
            { source: "message", messageId: "msg_1" },
            { source: "primer", primerId: 3 },
            { source: "note", noteId: 11 },
        ] as unknown as UnifiedSearchResult[];

        await recordShadowMeasurement({
            ...makeMeasurementArgs(db),
            primaryResults,
            search: async () => shadowResults,
        });

        const rows = listEmbeddingMeasurements(db, "ses-shadow");
        expect(rows).toHaveLength(1);
        const primaryIds = ["memory:42", "chunk:7", "commit:abc123"];
        const shadowIds = ["message:msg_1", "primer:3", "note:11"];
        expect(rows[0].primary_result_ids_json).toBe(JSON.stringify(primaryIds));
        expect(rows[0].shadow_result_ids_json).toBe(JSON.stringify(shadowIds));
        expect(rows[0].corpus_hash).toBe(
            createHash("sha256")
                .update(JSON.stringify({ query: "queue backpressure", primaryIds, shadowIds }))
                .digest("hex"),
        );
    });

    it("records the resolved lane when the shadow query itself resolves a deferred one", async () => {
        const db = useTempDb();
        // A deferred lane has no fingerprint yet, so the registration publishes
        // the placeholder identity until the first embed resolves it.
        const deferredConfig = {
            provider: "synapse",
            model: "gte-modernbert-base-f16",
            synapse_connection_origin: "managed-default",
            synapse_fallback: { provider: "off" },
        } as unknown as EmbeddingConfig;

        let announceLane: (() => void) | undefined;
        class DeferredLaneProvider extends FakeShadowProvider {
            override async embed(
                _text: string,
                _signal?: AbortSignal,
                _purpose?: EmbeddingPurpose,
            ): Promise<Float32Array> {
                // The real Synapse provider announces its lane from inside the
                // first embed; the registry then commits the resolved identity.
                announceLane?.();
                return new Float32Array([1, 2]);
            }
        }
        _setTestProviderFactoryForProject((_config, context) => {
            announceLane = () =>
                context?.onSynapseLaneReady?.({
                    laneIdentity: "lane-resolved",
                    model: "gte-modernbert-base-f16",
                    fingerprint: "fp-resolved",
                    table_epoch: 7,
                    dims: 8,
                });
            return new DeferredLaneProvider();
        });
        registerProjectShadowEmbedding(db, "git:shadow-measure", deferredConfig, "/tmp/shadow");

        const placeholder = getShadowEmbeddingMeasurementCohort("git:shadow-measure");
        expect(placeholder?.fingerprint).toBe("");

        const overrides: (string | undefined)[] = [];
        await recordShadowMeasurement({
            ...makeMeasurementArgs(db),
            search: async (_db, _sessionId, _projectPath, _query, options) => {
                overrides.push(options?.embeddingModelIdOverride);
                return [];
            },
        });

        const resolved = getShadowEmbeddingMeasurementCohort("git:shadow-measure");
        expect(resolved?.fingerprint).toBe("fp-resolved");
        expect(resolved?.modelId).not.toBe(placeholder?.modelId);
        // The replayed search must query the lane that answered, not the
        // placeholder model_id nothing is stored under.
        expect(overrides).toEqual([resolved?.modelId]);

        const rows = listEmbeddingMeasurements(db, "ses-shadow");
        expect(rows).toHaveLength(1);
        expect(rows[0].shadow_model_id).toBe(resolved?.modelId as string);
        expect(rows[0].shadow_fingerprint).toBe("fp-resolved");
        expect(rows[0].shadow_epoch).toBe(7);
        expect(rows[0].shadow_failed).toBe(0);
    });
});
