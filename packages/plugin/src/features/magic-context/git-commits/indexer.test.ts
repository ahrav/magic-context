import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import type { Database } from "../../../shared/sqlite";
import type { EmbeddingProvider, EmbeddingPurpose } from "../memory/embedding-provider";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    registerProjectEmbedding,
} from "../project-embedding-registry";
import { closeDatabase, openDatabase } from "../storage";
import {
    DetailedSynapseTestHost,
    detailedSynapseTestProvider,
    SYNAPSE_TEST_LANE_IDENTITY,
    synapseTestConfig,
} from "../synapse-detailed-test-support";
import type { GitCommit } from "./git-log-reader";
import { _resetIndexerGuards, embedUnembeddedCommits } from "./indexer";
import { countEmbeddedCommits } from "./storage-git-commit-embeddings";
import { upsertCommits } from "./storage-git-commits";

class FakeLocalProvider implements EmbeddingProvider {
    readonly modelId = "fake-local";
    async initialize(): Promise<boolean> {
        return true;
    }
    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        return new Float32Array([text.length]);
    }
    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        return texts.map((text) => new Float32Array([text.length]));
    }
    async dispose(): Promise<void> {}
    isLoaded(): boolean {
        return true;
    }
}

function makeGitCommit(shaSeed: string, committedAtMs: number): GitCommit {
    const sha = shaSeed.padEnd(40, "0");
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `commit ${shaSeed}`,
        author: "dev@example.com",
        committedAtMs,
    };
}

function ledgerRows(db: Database): Array<Record<string, unknown>> {
    return db
        .prepare("SELECT scope, lane_role, state FROM synapse_batch_ledger ORDER BY id")
        .all() as Array<Record<string, unknown>>;
}

describe("commit indexer embedding through versioned receipts", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb(): Database {
        const dir = mkdtempSync(join(tmpdir(), "indexer-detailed-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        if (!db) throw new Error("failed to open test database");
        return db;
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _resetIndexerGuards();
        closeDatabase();
        process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* Windows EBUSY */
            }
        }
    });

    function registerSynapseProject(
        db: Database,
        projectIdentity: string,
        host: DetailedSynapseTestHost,
    ): void {
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse"
                ? detailedSynapseTestProvider(host)
                : new FakeLocalProvider(),
        );
        registerProjectEmbedding(
            db,
            projectIdentity,
            synapseTestConfig(),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/indexer-detailed",
        );
    }

    it("persists commit vectors and completes every contributing receipt in one transaction", async () => {
        const db = useTempDb();
        const projectIdentity = "git:indexer-happy";
        const host = new DetailedSynapseTestHost();
        upsertCommits(db, projectIdentity, [
            makeGitCommit("aaa", 1000),
            makeGitCommit("bbb", 2000),
        ]);
        registerSynapseProject(db, projectIdentity, host);

        const embedded = await embedUnembeddedCommits(db, projectIdentity);

        expect(embedded).toBe(2);
        expect(countEmbeddedCommits(db, projectIdentity, SYNAPSE_TEST_LANE_IDENTITY)).toBe(2);
        const rows = ledgerRows(db);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.scope === "commit" && row.state === "complete")).toBe(true);
        expect(rows.every((row) => row.lane_role === "primary")).toBe(true);
    });

    it("aborts vector write and receipt CAS together when a commit message mutates mid-flight", async () => {
        const db = useTempDb();
        const projectIdentity = "git:indexer-mutated";
        const host = new DetailedSynapseTestHost();
        const commit = makeGitCommit("ccc", 3000);
        upsertCommits(db, projectIdentity, [commit]);
        registerSynapseProject(db, projectIdentity, host);

        host.resultPages = (_jobId, items) => {
            db.prepare("UPDATE git_commits SET message = ? WHERE sha = ?").run(
                "rewritten message",
                commit.sha,
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

        const embedded = await embedUnembeddedCommits(db, projectIdentity);

        expect(embedded).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, SYNAPSE_TEST_LANE_IDENTITY)).toBe(0);
        const rows = ledgerRows(db);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.state !== "complete")).toBe(true);
    });

    it("aborts both writes when the commit row is deleted between inference and commit", async () => {
        const db = useTempDb();
        const projectIdentity = "git:indexer-deleted";
        const host = new DetailedSynapseTestHost();
        const commit = makeGitCommit("ddd", 4000);
        upsertCommits(db, projectIdentity, [commit]);
        registerSynapseProject(db, projectIdentity, host);

        host.resultPages = (_jobId, items) => {
            db.prepare("DELETE FROM git_commits WHERE sha = ?").run(commit.sha);
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

        const embedded = await embedUnembeddedCommits(db, projectIdentity);

        expect(embedded).toBe(0);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM git_commit_embeddings").get() as {
                count: number;
            },
        ).toEqual({ count: 0 });
        expect(ledgerRows(db).every((row) => row.state !== "complete")).toBe(true);
    });

    it("keeps non-synapse providers on their existing path with zero ledger rows", async () => {
        const db = useTempDb();
        const projectIdentity = "git:indexer-local";
        upsertCommits(db, projectIdentity, [makeGitCommit("eee", 5000)]);
        _setTestProviderFactoryForProject(() => new FakeLocalProvider());
        registerProjectEmbedding(
            db,
            projectIdentity,
            { provider: "local", model: "model-a" } as EmbeddingConfig,
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/indexer-local",
        );

        const embedded = await embedUnembeddedCommits(db, projectIdentity);

        expect(embedded).toBe(1);
        expect(ledgerRows(db)).toEqual([]);
    });
});
