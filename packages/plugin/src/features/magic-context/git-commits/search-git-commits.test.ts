import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { countingDatabase } from "../sql-counters";
import { initializeDatabase } from "../storage-db";
import type { GitCommit } from "./git-log-reader";
import { searchGitCommitsSync } from "./search-git-commits";
import { saveCommitEmbedding } from "./storage-git-commit-embeddings";
import { upsertCommits } from "./storage-git-commits";

function makeCommit(index: number): GitCommit {
    const sha = index.toString(16).padStart(40, "0");
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `semantic commit ${index}`,
        author: "dev@example.com",
        committedAtMs: 1_700_000_000_000 + index,
    };
}

describe("searchGitCommitsSync", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("loads a large semantic-only commit set through one JSON batch", () => {
        const projectPath = "git:semantic-batch";
        const modelId = "mock:model";
        const commits = Array.from({ length: 1_200 }, (_, index) => makeCommit(index));
        upsertCommits(db, projectPath, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 0]), modelId);
        }

        const results = searchGitCommitsSync(db, projectPath, "lexical-miss-token", {
            limit: 5,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results).toHaveLength(5);
        expect(results.every((result) => result.matchType === "semantic")).toBe(true);
        expect(results.map((result) => result.commit.sha)).toEqual(
            commits
                .slice(-5)
                .reverse()
                .map((commit) => commit.sha),
        );
    });

    it("hydrates exactly the selected top-K commits (AE6)", () => {
        const projectPath = "git:topk";
        const modelId = "mock:model";
        const commits = Array.from({ length: 50 }, (_, index) => makeCommit(index));
        upsertCommits(db, projectPath, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 0]), modelId);
        }
        const counter = countingDatabase(db);

        const results = searchGitCommitsSync(counter.db, projectPath, "lexical-miss-token", {
            limit: 5,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results).toHaveLength(5);
        const hydrations = counter.matching(/short_sha, message, author/);
        expect(hydrations).toHaveLength(1);
        expect(hydrations[0].rowCount).toBe(5);
        const payload = JSON.parse(String(hydrations[0].bindings[1])) as string[];
        expect(payload).toHaveLength(5);
        expect(payload).toEqual(results.map((result) => result.commit.sha));
    });

    it("keeps hybrid weighting and newer-commit tie-breaking", () => {
        const projectPath = "git:hybrid";
        const modelId = "mock:model";
        const hybrid = {
            sha: "a".repeat(40),
            shortSha: "aaaaaaa",
            message: "queue drain backpressure fix",
            author: "dev@example.com",
            committedAtMs: 1_700_000_000_000,
        };
        const ftsOnlyOlder = {
            sha: "b".repeat(40),
            shortSha: "bbbbbbb",
            message: "queue drain backpressure docs",
            author: "dev@example.com",
            committedAtMs: 1_700_000_000_001,
        };
        upsertCommits(db, projectPath, [hybrid, ftsOnlyOlder]);
        saveCommitEmbedding(db, hybrid.sha, new Float32Array([1, 0]), modelId);

        const results = searchGitCommitsSync(db, projectPath, "queue drain backpressure", {
            limit: 5,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results.map((result) => [result.commit.sha, result.matchType])).toEqual([
            [hybrid.sha, "hybrid"],
            [ftsOnlyOlder.sha, "fts"],
        ]);
        expect(results[0].score).toBeCloseTo(0.7 * 1 + 0.3 * 1, 10);
        expect(results[1].score).toBeCloseTo(0.5 * 0.8, 10);
    });

    it("restores selected order when hydration rows come back shuffled", () => {
        const projectPath = "git:order";
        const modelId = "mock:model";
        const commits = Array.from({ length: 4 }, (_, index) => makeCommit(index));
        upsertCommits(db, projectPath, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 0]), modelId);
        }

        const shuffling = new Proxy(db, {
            get(target, prop) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        const statement = target.prepare(sql);
                        if (!sql.includes("short_sha, message, author")) return statement;
                        return {
                            ...statement,
                            all: (...bindings: unknown[]) =>
                                (statement.all as (...args: unknown[]) => unknown[])(
                                    ...bindings,
                                ).reverse(),
                        } as typeof statement;
                    };
                }
                const value = (target as unknown as Record<string | symbol, unknown>)[prop];
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Database;

        const shuffled = searchGitCommitsSync(shuffling, projectPath, "lexical-miss-token", {
            limit: 4,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });
        const direct = searchGitCommitsSync(db, projectPath, "lexical-miss-token", {
            limit: 4,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(shuffled.map((result) => result.commit.sha)).toEqual(
            direct.map((result) => result.commit.sha),
        );
        expect(shuffled.map((result) => result.commit.sha)).toEqual(
            commits
                .slice()
                .reverse()
                .map((commit) => commit.sha),
        );
    });

    it("cannot rank an embedding whose commit metadata is gone", () => {
        const projectPath = "git:orphan";
        const modelId = "mock:model";
        const kept = makeCommit(1);
        const orphaned = makeCommit(2);
        upsertCommits(db, projectPath, [kept, orphaned]);
        saveCommitEmbedding(db, kept.sha, new Float32Array([1, 0]), modelId);
        saveCommitEmbedding(db, orphaned.sha, new Float32Array([1, 0]), modelId);
        db.prepare("DELETE FROM git_commits WHERE sha = ?").run(orphaned.sha);

        const results = searchGitCommitsSync(db, projectPath, "lexical-miss-token", {
            limit: 5,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results.map((result) => result.commit.sha)).toEqual([kept.sha]);
    });

    it("keeps surviving order when one hydrated row is absent", () => {
        const projectPath = "git:partial";
        const modelId = "mock:model";
        const commits = Array.from({ length: 3 }, (_, index) => makeCommit(index));
        upsertCommits(db, projectPath, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 0]), modelId);
        }
        const dropped = commits[commits.length - 1].sha;

        const dropping = new Proxy(db, {
            get(target, prop) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        const statement = target.prepare(sql);
                        if (!sql.includes("short_sha, message, author")) return statement;
                        return {
                            ...statement,
                            all: (...bindings: unknown[]) =>
                                (statement.all as (...args: unknown[]) => unknown[])(
                                    ...bindings,
                                ).filter((row) => (row as { sha: string }).sha !== dropped),
                        } as typeof statement;
                    };
                }
                const value = (target as unknown as Record<string | symbol, unknown>)[prop];
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Database;

        const results = searchGitCommitsSync(dropping, projectPath, "lexical-miss-token", {
            limit: 3,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results.map((result) => result.commit.sha)).toEqual([
            commits[1].sha,
            commits[0].sha,
        ]);
    });

    it("runs no hydration for blank queries, non-positive limits, or no candidates", () => {
        const projectPath = "git:empty";
        upsertCommits(db, projectPath, [makeCommit(1)]);
        const counter = countingDatabase(db);

        expect(searchGitCommitsSync(counter.db, projectPath, "   ", { limit: 5 })).toEqual([]);
        expect(searchGitCommitsSync(counter.db, projectPath, "anything", { limit: 0 })).toEqual([]);
        expect(
            searchGitCommitsSync(counter.db, projectPath, "zzzznotpresentzzzz", { limit: 5 }),
        ).toEqual([]);
        expect(counter.count(/short_sha, message, author/)).toBe(0);
    });
});
