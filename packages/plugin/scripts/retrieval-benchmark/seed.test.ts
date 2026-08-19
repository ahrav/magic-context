import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unifiedSearch } from "../../src/features/magic-context/search";
import { encodePhysicalResultLocator } from "../../src/features/magic-context/search-result-locator";
import { closeQuietly } from "../../src/shared/sqlite-helpers";
import { canonicalFingerprint } from "./canonical-json";
import { loadReviewedRelease } from "./index";
import {
    BENCHMARK_EMBEDDING_MODEL_ID,
    deterministicVector,
    fixtureSessionId,
    measureMessageSelectivity,
    openFixtureSnapshot,
    producibleAliases,
    SeedError,
    type SeedFixtureOptions,
    type SeedReleaseInput,
    type SeedResult,
    seedFixture,
} from "./seed";
import { makeValidRelease, type ReleaseArtifacts } from "./test-support";

const V1_RELEASE_DIR = join(import.meta.dir, "..", "fixtures", "retrieval-benchmark", "v1");

const tempDirs: string[] = [];

function tempFixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rb-seed-"));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toSeedInput(release: ReleaseArtifacts): SeedReleaseInput {
    return {
        corpus: release.corpus,
        judgments: release.judgments,
        fingerprints: {
            corpus: canonicalFingerprint(release.corpus),
            judgments: canonicalFingerprint(release.judgments),
        },
    };
}

function seedV1(options?: Partial<SeedFixtureOptions>): SeedResult {
    const release = loadReviewedRelease(V1_RELEASE_DIR);
    return seedFixture(
        {
            corpus: release.corpus,
            judgments: release.judgments,
            fingerprints: {
                corpus: release.fingerprints.corpus,
                judgments: release.fingerprints.judgments,
            },
        },
        { fixtureDir: tempFixtureDir(), dims: 32, ...options },
    );
}

async function searchSnapshot(
    snapshotPath: string,
    query: string,
    options: {
        sources?: ("memory" | "message" | "git_commit" | "primer" | "note")[];
        maxMessageOrdinal?: number;
        candidateDepth?: number;
    },
): Promise<string[]> {
    const db = openFixtureSnapshot(snapshotPath);
    try {
        const results = await unifiedSearch(
            db,
            fixtureSessionId("git:benchmark-fixture-project", null),
            "git:benchmark-fixture-project",
            query,
            {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: true,
                gitCommitsEnabled: true,
                explicitSearch: true,
                countRetrievals: false,
                measurementDisabled: true,
                embeddingModelIdOverride: BENCHMARK_EMBEDDING_MODEL_ID,
                chunkModelIdOverride: BENCHMARK_EMBEDDING_MODEL_ID,
                embedQuery: async (text) => ({
                    vector: deterministicVector(`query:${text}`, 32),
                    modelId: BENCHMARK_EMBEDDING_MODEL_ID,
                    chunkModelId: BENCHMARK_EMBEDDING_MODEL_ID,
                    generation: 0,
                }),
                isEmbeddingRuntimeEnabled: () => true,
                ...options,
            },
        );
        return results.map(encodePhysicalResultLocator);
    } finally {
        closeQuietly(db);
    }
}

describe("seedFixture on the reviewed v1 release", () => {
    it("emits every production-producible approved alias byte-exactly", () => {
        const release = loadReviewedRelease(V1_RELEASE_DIR);
        const result = seedV1();

        const expected = new Set<string>();
        for (const document of release.corpus.documents) {
            for (const alias of producibleAliases(document)) {
                expected.add(`${document.id}\u0000${alias.namespace}:${alias.locator}`);
            }
        }
        const emitted = new Set(
            result.manifest.documents.map((entry) => `${entry.documentId}\u0000${entry.locator}`),
        );
        expect(emitted).toEqual(expected);

        const db = openFixtureSnapshot(result.snapshotPath);
        try {
            const memoryIds = (
                db.prepare("SELECT id FROM memories ORDER BY id").all() as { id: number }[]
            ).map((row) => row.id);
            expect(memoryIds).toEqual([9101, 9102, 9103, 9104, 9105, 9106]);
            const noteIds = (
                db.prepare("SELECT id FROM notes ORDER BY id").all() as { id: number }[]
            ).map((row) => row.id);
            expect(noteIds).toEqual([7301, 7302, 7303, 7304, 7305]);
            const compartmentIds = (
                db.prepare("SELECT id FROM compartments ORDER BY id").all() as { id: number }[]
            ).map((row) => row.id);
            expect(compartmentIds).toEqual([3401, 3402]);
            const primerIds = (
                db.prepare("SELECT id FROM primers ORDER BY id").all() as { id: number }[]
            ).map((row) => row.id);
            expect(primerIds).toEqual([501, 502, 503]);
        } finally {
            closeQuietly(db);
        }
    });

    it("produces the same manifest fingerprint and ranked behavior across two seeds", async () => {
        const first = seedV1();
        const second = seedV1();
        expect(first.databasePath).not.toBe(second.databasePath);
        expect(first.manifestFingerprint).toBe(second.manifestFingerprint);
        expect(first.manifestFingerprint).toBe(canonicalFingerprint(first.manifest));

        const query = "where is normalizeSearchResultLimit defined";
        const firstRanked = await searchSnapshot(first.snapshotPath, query, {
            sources: ["message"],
        });
        const secondRanked = await searchSnapshot(second.snapshotPath, query, {
            sources: ["message"],
        });
        expect(firstRanked.length).toBeGreaterThan(0);
        expect(firstRanked).toEqual(secondRanked);
        expect(firstRanked).toContain("message:msg-fixture-0001");
    });

    it("executes candidate K=100 and both selectivity endpoints through production seams", async () => {
        const result = seedV1();
        const deep = await searchSnapshot(
            result.snapshotPath,
            "where is normalizeSearchResultLimit defined",
            { candidateDepth: 100 },
        );
        expect(deep.length).toBeGreaterThan(0);

        const messageEntries = result.manifest.documents.filter(
            (entry) => entry.kind === "message",
        );
        const maxOrdinal = Math.max(...messageEntries.map((entry) => entry.ordinal ?? 0));
        const unbounded = await searchSnapshot(
            result.snapshotPath,
            "where is normalizeSearchResultLimit defined",
            { sources: ["message"], maxMessageOrdinal: maxOrdinal },
        );
        expect(unbounded).toContain("message:msg-fixture-0001");
        const narrow = await searchSnapshot(
            result.snapshotPath,
            "where is normalizeSearchResultLimit defined",
            { sources: ["message"], maxMessageOrdinal: 1 },
        );
        // msg-fixture-0001 has ordinal 1 and matches the query, so an empty
        // result would make the containment loop below vacuously pass.
        expect(narrow.length).toBeGreaterThan(0);
        const narrowOrdinals = new Set(
            messageEntries
                .filter((entry) => entry.ordinal !== null && entry.ordinal <= 1)
                .map((entry) => entry.locator),
        );
        for (const locator of narrow) expect(narrowOrdinals.has(locator)).toBe(true);
    });

    it("snapshots committed rows into a read-only fixture that rejects writes", () => {
        const result = seedV1();
        expect(result.evidence.indexBuildMs).toBeGreaterThan(0);
        expect(result.evidence.snapshotBytes).toBeGreaterThan(0);

        const db = openFixtureSnapshot(result.snapshotPath);
        try {
            const messages = db
                .prepare("SELECT COUNT(*) AS count FROM message_history_fts")
                .get() as { count: number };
            expect(messages.count).toBe(
                result.manifest.documents.filter((entry) => entry.kind === "message").length,
            );
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO memories (project_path, category, content) VALUES (?, ?, ?)",
                    )
                    .run("git:x", "NAMING", "nope"),
            ).toThrow();
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses to reuse a fixture directory", () => {
        const release = loadReviewedRelease(V1_RELEASE_DIR);
        const input = {
            corpus: release.corpus,
            judgments: release.judgments,
            fingerprints: release.fingerprints,
        };
        const fixtureDir = tempFixtureDir();
        seedFixture(input, { fixtureDir, dims: 8 });
        expect(() => seedFixture(input, { fixtureDir, dims: 8 })).toThrow(SeedError);
    });
});

describe("seed-time positive-target validation (AE2)", () => {
    function releaseWithCutoff(queryId: string, cutoff: number): ReleaseArtifacts {
        const release = makeValidRelease();
        const query = release.corpus.queries.find((candidate) => candidate.id === queryId);
        if (!query) throw new Error(`missing fixture query ${queryId}`);
        query.visibleState.messageOrdinalCutoff = cutoff;
        return release;
    }

    it("keeps a message target at exactly the cutoff reachable", () => {
        // d-error-message-dev is the first message/compartment document; its seeded ordinal is 1.
        const release = releaseWithCutoff("q-error-message-dev", 1);
        const result = seedFixture(toSeedInput(release), {
            fixtureDir: tempFixtureDir(),
            dims: 8,
        });
        const entry = result.manifest.documents.find(
            (candidate) => candidate.documentId === "d-error-message-dev",
        );
        expect(entry?.ordinal).toBe(1);
    });

    it("fails a message target one ordinal beyond the cutoff with an id-only diagnostic", () => {
        // d-error-message-hold is the second message document; its seeded ordinal is 2.
        const release = releaseWithCutoff("q-error-message-hold", 1);
        let caught: SeedError | null = null;
        try {
            seedFixture(toSeedInput(release), { fixtureDir: tempFixtureDir(), dims: 8 });
        } catch (error) {
            if (!(error instanceof SeedError)) throw error;
            caught = error;
        }
        expect(caught?.diagnostics).toEqual([
            "seed: target ordinal beyond cutoff (q-error-message-hold, d-error-message-hold)",
        ]);
    });

    it("applies the same inclusive cutoff to compartment end ordinals", () => {
        // Reviewed compartments draw from a dedicated low counter so scale
        // filler cannot push them past explicit cutoffs:
        // d-architecture-rationale-dev is the first compartment (ordinal 1),
        // d-architecture-rationale-hold the second (ordinal 2).
        const atCutoff = releaseWithCutoff("q-architecture-rationale-dev", 1);
        expect(() =>
            seedFixture(toSeedInput(atCutoff), { fixtureDir: tempFixtureDir(), dims: 8 }),
        ).not.toThrow();

        const beyond = releaseWithCutoff("q-architecture-rationale-hold", 1);
        expect(() =>
            seedFixture(toSeedInput(beyond), { fixtureDir: tempFixtureDir(), dims: 8 }),
        ).toThrow(SeedError);
    });

    it("fails a positive target excluded by the scenario's source filters", () => {
        const release = makeValidRelease();
        const query = release.corpus.queries.find(
            (candidate) => candidate.id === "q-error-message-dev",
        );
        if (!query) throw new Error("missing fixture query");
        query.sourceFilters = ["memory"];
        expect(() =>
            seedFixture(toSeedInput(release), { fixtureDir: tempFixtureDir(), dims: 8 }),
        ).toThrow(SeedError);
    });
});

describe("synthetic scale seeding", () => {
    function syntheticProfile(release: ReleaseArtifacts) {
        return release.syntheticProfiles.profiles.find((profile) => profile.scale === 1_000);
    }

    it("seeds unlabeled scale documents that never enter the judged manifest", () => {
        const release = makeValidRelease();
        const profile = syntheticProfile(release);
        if (!profile) throw new Error("missing 1k synthetic profile");
        const result = seedFixture(toSeedInput(release), {
            fixtureDir: tempFixtureDir(),
            dims: 8,
            synthetic: { profile, documentLimit: 300 },
        });
        expect(result.manifest.synthetic?.seededDocuments).toBe(300);
        expect(
            result.manifest.documents.some((entry) => entry.documentId.startsWith("syn:")),
        ).toBe(false);
        for (const judgment of release.judgments.judgments) {
            expect(judgment.documentId.startsWith("syn:")).toBe(false);
        }
    });

    it("rejects a release that grades a synthetic document before writing anything", () => {
        const release = makeValidRelease();
        release.judgments.judgments.push({
            queryId: release.corpus.queries[0].id,
            documentId: "syn:smoke:0",
            grade: 2,
            provenance: { judge: "human", pooledFrom: ["manual"] },
        });
        const fixtureDir = tempFixtureDir();
        expect(() => seedFixture(toSeedInput(release), { fixtureDir, dims: 8 })).toThrow(
            SeedError,
        );
        expect(existsSync(join(fixtureDir, "seed.sqlite"))).toBe(false);
        expect(readdirSync(fixtureDir)).toEqual([]);
    });

    it("matches declared selectivity cardinalities against the seeded message index", () => {
        const release = makeValidRelease();
        const profile = syntheticProfile(release);
        if (!profile) throw new Error("missing 1k synthetic profile");
        const result = seedFixture(toSeedInput(release), {
            fixtureDir: tempFixtureDir(),
            dims: 8,
            synthetic: { profile, documentLimit: 400 },
        });
        const db = openFixtureSnapshot(result.snapshotPath);
        try {
            const projectScope = "git:fixture-project";
            const total = measureMessageSelectivity(db, {
                projectScope,
                sessionScope: null,
                messageOrdinalCutoff: null,
            });
            expect(total.preFilterDenominator).toBeGreaterThan(100);
            expect(total.eligibleCount).toBe(total.preFilterDenominator);

            const cutoff = Math.max(1, Math.round(total.preFilterDenominator * 0.01));
            const narrow = measureMessageSelectivity(db, {
                projectScope,
                sessionScope: null,
                messageOrdinalCutoff: cutoff,
            });
            expect(narrow.preFilterDenominator).toBe(total.preFilterDenominator);
            expect(narrow.eligibleCount).toBeLessThanOrEqual(cutoff);
            expect(narrow.eligibleCount).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });
});
