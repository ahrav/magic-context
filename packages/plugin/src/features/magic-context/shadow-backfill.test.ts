import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import {
    countEmbeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { upsertCommits } from "./git-commits/storage-git-commits";
import { makeSeededGitCommit } from "./git-commits/test-support";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    flushShadowEmbeddingBacklog,
    getProjectEmbeddingSnapshot,
    getShadowBackfillRemaining,
    getShadowEmbeddingMeasurementCohort,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectShadowEmbedding,
    sweepStaleEmbeddingIdentitiesForProject,
} from "./project-embedding-registry";
import { closeDatabase, openDatabase } from "./storage";
import {
    DetailedSynapseTestHost,
    detailedSynapseTestProvider,
    SYNAPSE_TEST_LANE_IDENTITY,
    synapseTestConfig,
} from "./synapse-detailed-test-support";

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
        return new Float32Array([text.length, 1]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        return texts.map((text) => new Float32Array([text.length, 1]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function localConfig(model: string): EmbeddingConfig {
    return { provider: "local", model };
}

/** Two fingerprints yield two distinct Synapse shadow identities (modelIds). */
function synapseConfig(fingerprint: string): EmbeddingConfig {
    return {
        provider: "synapse",
        model: "synapse-model",
        synapse_fingerprint: fingerprint,
        synapse_table_epoch: 1,
        synapse_dims: 8,
    } as unknown as EmbeddingConfig;
}

function primaryModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
}

/** The shadow lane's current modelId (a Synapse identity), distinct from primary. */
function shadowModelId(projectIdentity: string): string {
    return getShadowEmbeddingMeasurementCohort(projectIdentity)?.modelId ?? "off";
}

function commitSha(seed: string): string {
    return seed.padEnd(40, seed);
}

describe("shadow embedding historical backfill", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "shadow-backfill-"));
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
                /* */
            }
        }
        tempDirs.length = 0;
    });

    function useFakeProviders() {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "shadow"),
        );
    }

    function seedPrimaryCommits(
        db: NonNullable<ReturnType<typeof openDatabase>>,
        projectIdentity: string,
        count: number,
    ): void {
        const modelId = primaryModelId(projectIdentity);
        const commits = Array.from({ length: count }, (_, i) =>
            makeSeededGitCommit(`s${i}x`, 1000 + i),
        );
        upsertCommits(db, projectIdentity, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 1]), modelId);
        }
    }

    it("re-embeds the historical corpus under the new identity after a rotation, in bounded chunks", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-rotate";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-rotate",
        );
        // 150 exceeds SHADOW_MAX_ITEMS_PER_TICK (64), so the drain requires multiple bounded worker passes.
        seedPrimaryCommits(db, projectIdentity, 150);

        // The corpus is already mirrored under identity A.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-rotate",
        );
        const shadowA = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowA)).toBe(150);

        // A new fingerprint registers a new shadow identity.
        // The historical corpus lacks rows under the new identity and must be re-embedded.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-rotate",
        );
        const shadowB = shadowModelId(projectIdentity);
        expect(shadowB).not.toBe(shadowA);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(150);

        let passes = 0;
        const remainingSeen: number[] = [];
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
            remainingSeen.push(getShadowBackfillRemaining(db, projectIdentity).commit);
        });

        expect(countEmbeddedCommits(db, projectIdentity, shadowB)).toBe(150);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(0);
        expect(passes).toBeGreaterThanOrEqual(2);
        // The outstanding count falls monotonically to zero.
        expect(remainingSeen[remainingSeen.length - 1]).toBe(0);
        for (let i = 1; i < remainingSeen.length; i++) {
            expect(remainingSeen[i]).toBeLessThanOrEqual(
                remainingSeen[i - 1] ?? Number.MAX_SAFE_INTEGER,
            );
        }
        // The old identity's rows coexist until the 14-day GC ages them out.
        expect(countEmbeddedCommits(db, projectIdentity, shadowA)).toBe(150);
    });

    it("backfills commits alongside memories on rotation", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-rotate-commits";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-rotate-commits",
        );
        upsertCommits(db, projectIdentity, [
            makeSeededGitCommit("c-a", 1000),
            makeSeededGitCommit("c-b", 2000),
        ]);
        const modelId = primaryModelId(projectIdentity);
        saveCommitEmbedding(db, "c-a".padEnd(40, "c-a"), new Float32Array([1, 1]), modelId);
        saveCommitEmbedding(db, "c-b".padEnd(40, "c-b"), new Float32Array([1, 1]), modelId);

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-rotate-commits",
        );
        const shadowA = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowA)).toBe(2);

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-rotate-commits",
        );
        const shadowB = shadowModelId(projectIdentity);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(2);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowB)).toBe(2);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(0);
    });

    it("arms the backfill on a first registration over an existing primary corpus (rotation while down)", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-cold-start";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-cold-start",
        );
        seedPrimaryCommits(db, projectIdentity, 5);

        // The process has no in-memory shadow registration, but the database has historical primary rows.
        // the current shadow identity must still detect the gap and backfill it.
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-current"),
            "/tmp/shadow-cold-start",
        );
        const shadowModel = shadowModelId(projectIdentity);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(5);

        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowModel)).toBe(5);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(0);
    });

    it("does not enqueue a backfill when the shadow identity is unchanged", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-unchanged";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-unchanged",
        );
        seedPrimaryCommits(db, projectIdentity, 5);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-same"),
            "/tmp/shadow-unchanged",
        );
        const shadowModel = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowModel)).toBe(5);

        // Re-registering the same identity must not re-arm a backfill.
        // The corpus is already covered under the same identity.
        let passes = 0;
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-same"),
            "/tmp/shadow-unchanged",
        );
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
        });
        expect(passes).toBe(0);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, shadowModel)).toBe(5);
    });

    it("does not enqueue a backfill while the project's config load is untrusted", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-untrusted";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-untrusted",
        );
        seedPrimaryCommits(db, projectIdentity, 5);

        // A degraded config load latches the project after trusted primary registration.
        // The shadow backfill must respect the degraded-load latch and not enqueue.
        markProjectLoadUntrusted(projectIdentity);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-untrusted",
        );
        const shadowModel = shadowModelId(projectIdentity);

        let passes = 0;
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
        });
        expect(passes).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, shadowModel)).toBe(0);
        // The gap is still outstanding; a later trusted registration would clear it.
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(5);
    });

    it("is idempotent: re-detecting after a completed backfill enqueues no duplicates", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-idempotent";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-idempotent",
        );
        seedPrimaryCommits(db, projectIdentity, 5);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-idempotent",
        );
        const shadowModel = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowModel)).toBe(5);

        // A process restart clears in-memory registrations but preserves the database.
        // Re-registering the same identity reruns detection.
        // Re-registering the same identity reruns detection, finds no missing rows, and does not enqueue.
        _resetProjectEmbeddingRegistryForTests();
        useFakeProviders();
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-idempotent",
        );
        let passes = 0;
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-idempotent",
        );
        await flushShadowEmbeddingBacklog(projectIdentity, () => {
            passes += 1;
        });
        expect(passes).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, shadowModel)).toBe(5);
        expect(getShadowBackfillRemaining(db, projectIdentity).commit).toBe(0);
    });

    it("GC protects the new shadow identity while the old one ages out", async () => {
        useFakeProviders();
        const db = useTempDb();
        const projectIdentity = "git:shadow-gc";
        const now = Date.now();
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-gc",
        );
        seedPrimaryCommits(db, projectIdentity, 3);

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-a"),
            "/tmp/shadow-gc",
        );
        const shadowA = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseConfig("fp-b"),
            "/tmp/shadow-gc",
        );
        const shadowB = shadowModelId(projectIdentity);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(countEmbeddedCommits(db, projectIdentity, shadowA)).toBe(3);
        expect(countEmbeddedCommits(db, projectIdentity, shadowB)).toBe(3);

        // The old shadow identity has aged past the 14-day grace period.
        // GC must keep the live shadow registration protected.
        db.prepare(
            "UPDATE embedding_identity_active SET last_active_at = ? WHERE project_path = ? AND model_id = ?",
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, shadowA);

        const swept = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(swept.commitRowsDeleted).toBe(3);
        // Old identity aged out; new identity (current shadow) is protected.
        expect(countEmbeddedCommits(db, projectIdentity, shadowA)).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, shadowB)).toBe(3);
    });
});

describe("shadow lane writes through versioned synapse receipts", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "shadow-detailed-"));
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
                /* */
            }
        }
    });

    it("shadow commit backfill applies groups atomically under the shadow lane identity", async () => {
        const host = new DetailedSynapseTestHost();
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse"
                ? detailedSynapseTestProvider(host)
                : new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:shadow-detailed";
        upsertCommits(db, projectIdentity, [makeSeededGitCommit("d-a", 1000)]);
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-detailed",
        );
        saveCommitEmbedding(
            db,
            commitSha("d-a"),
            new Float32Array([1, 1]),
            primaryModelId(projectIdentity),
        );

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseTestConfig(),
            "/tmp/shadow-detailed",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(shadowModelId(projectIdentity)).toBe(SYNAPSE_TEST_LANE_IDENTITY);
        expect(countEmbeddedCommits(db, projectIdentity, SYNAPSE_TEST_LANE_IDENTITY)).toBe(1);
        const ledger = db
            .prepare(
                "SELECT session_id, lane_role, scope, state FROM synapse_batch_ledger ORDER BY id",
            )
            .all() as Array<{
            session_id: string;
            lane_role: string;
            scope: string;
            state: string;
        }>;
        expect(ledger.length).toBeGreaterThan(0);
        expect(
            ledger.every(
                (row) =>
                    row.lane_role === "shadow" &&
                    row.session_id === `shadow:${projectIdentity}` &&
                    row.scope === "commit" &&
                    row.state === "complete",
            ),
        ).toBe(true);
    });

    it("a shadow group failure writes nothing and completes no receipt", async () => {
        const host = new DetailedSynapseTestHost();
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse"
                ? detailedSynapseTestProvider(host)
                : new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:shadow-detailed-fail";
        upsertCommits(db, projectIdentity, [makeSeededGitCommit("f-a", 1000)]);
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/shadow-detailed-fail",
        );
        saveCommitEmbedding(
            db,
            commitSha("f-a"),
            new Float32Array([1, 1]),
            primaryModelId(projectIdentity),
        );

        host.resultPages = (_jobId, items) => {
            db.prepare("UPDATE git_commits SET message = ? WHERE sha = ?").run(
                "edited before shadow apply",
                commitSha("f-a"),
            );
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
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            synapseTestConfig(),
            "/tmp/shadow-detailed-fail",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(countEmbeddedCommits(db, projectIdentity, SYNAPSE_TEST_LANE_IDENTITY)).toBe(0);
        const ledger = db
            .prepare("SELECT state FROM synapse_batch_ledger ORDER BY id")
            .all() as Array<{ state: string }>;
        expect(ledger.length).toBeGreaterThan(0);
        expect(ledger.every((row) => row.state !== "complete")).toBe(true);
    });
});
