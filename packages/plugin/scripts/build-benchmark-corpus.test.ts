import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    OPERATOR_APPROVALS,
    RELEASES_ROOT,
    RELEASE_VERSION,
    buildCorpusArtifacts,
} from "./build-benchmark-corpus";
import { buildManifest } from "./retrieval-benchmark/promote";
import { canonicalFingerprint } from "./retrieval-benchmark/canonical-json";
import {
    ContractError,
    DOCUMENT_KINDS,
    QUERY_CATEGORIES,
    parseCorpus,
    parseJudgments,
    validateRelease,
} from "./retrieval-benchmark/contract";
import {
    buildJudgmentLookup,
    loadReviewedRelease,
    resolveRankedLocators,
} from "./retrieval-benchmark/index";
import { iterateSyntheticDocuments } from "./retrieval-benchmark/synthetic";

const RELEASE_DIR = join(RELEASES_ROOT, RELEASE_VERSION);

describe("authored artifacts", () => {
    it("validate under the strict contract", () => {
        const { corpus, judgments } = buildCorpusArtifacts();
        validateRelease(parseCorpus(corpus), parseJudgments(judgments));
    });

    it("cover every category in both partitions with independent base intents", () => {
        const { corpus } = buildCorpusArtifacts();
        for (const category of QUERY_CATEGORIES) {
            for (const partition of ["development", "holdout"] as const) {
                const groups = new Set(
                    corpus.queries
                        .filter((q) => q.category === category && q.partition === partition)
                        .map((q) => q.paraphraseGroup),
                );
                expect(groups.size).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it("exercise every source representation, both modes, and source filters", () => {
        const { corpus } = buildCorpusArtifacts();
        expect(new Set(corpus.documents.map((d) => d.kind))).toEqual(new Set(DOCUMENT_KINDS));
        expect(new Set(corpus.queries.map((q) => q.mode))).toEqual(
            new Set(["explicit", "automatic"]),
        );
        expect(corpus.queries.some((q) => q.sourceFilters !== null)).toBe(true);
        for (const query of corpus.queries) {
            expect(query.resultLimit).toBeGreaterThan(0);
            expect(query.referenceTimeMs).toBeGreaterThan(0);
        }
    });

    it("give every query a positive human grade and keep provenance out of grading", () => {
        const { corpus, judgments } = buildCorpusArtifacts();
        const lookup = buildJudgmentLookup(judgments);
        for (const query of corpus.queries) {
            const positives = judgments.judgments.filter(
                (j) => j.queryId === query.id && j.grade > 0,
            );
            expect(positives.length).toBeGreaterThanOrEqual(1);
        }
        for (const judgment of judgments.judgments) {
            expect(judgment.provenance.judge).toBe("human");
            const state = lookup(judgment.queryId, judgment.documentId);
            expect(state).toEqual({ status: "judged", grade: judgment.grade });
        }
    });
});

describe("checked-in release", () => {
    it("matches the authored source byte-for-byte (drift guard)", () => {
        const artifacts = buildCorpusArtifacts();
        const release = loadReviewedRelease(RELEASE_DIR);
        expect(release.fingerprints.corpus).toBe(canonicalFingerprint(artifacts.corpus));
        expect(release.fingerprints.judgments).toBe(canonicalFingerprint(artifacts.judgments));
        expect(release.fingerprints.syntheticProfiles).toBe(
            canonicalFingerprint(artifacts.syntheticProfiles),
        );
    });

    it("fails closed when any artifact is tampered with", () => {
        for (const [file, mutate] of [
            ["corpus.json", (doc: any) => (doc.queries[0].queryText = "tampered query")],
            ["judgments.json", (doc: any) => (doc.judgments[0].grade = 1)],
            ["synthetic-profiles.json", (doc: any) => (doc.profiles[0].seed += 1)],
            ["manifest.json", (doc: any) => (doc.releaseTuple.rubricVersion = "graded-pooled/v2")],
        ] as const) {
            const copy = mkdtempSync(join(tmpdir(), "release-tamper-"));
            cpSync(RELEASE_DIR, copy, { recursive: true });
            const path = join(copy, file);
            const artifact = JSON.parse(readFileSync(path, "utf8"));
            mutate(artifact);
            writeFileSync(path, JSON.stringify(artifact, null, 2));
            expect(() => loadReviewedRelease(copy)).toThrow(ContractError);
        }
    });

    it("supports a U5-shaped consumer without any database access", () => {
        const release = loadReviewedRelease(RELEASE_DIR);
        const scope = {
            projectScope: release.corpus.queries[0].fixtureScope.projectScope,
            sessionScope: null,
        };

        const migrationDoc = release.corpus.documents.find((d) =>
            d.aliases.some((a) => a.namespace === "retrieval-document"),
        );
        expect(migrationDoc).toBeDefined();
        if (!migrationDoc) return;
        const legacy = migrationDoc.aliases[0];
        const migrated = migrationDoc.aliases.find(
            (a) => a.namespace === "retrieval-document",
        );
        if (!migrated) return;
        const ranked = resolveRankedLocators(
            [
                `${legacy.namespace}:${legacy.locator}`,
                `${migrated.namespace}:${migrated.locator}`,
                "memory:404404",
            ],
            scope,
            release.aliasIndex,
        );
        expect(ranked.map((r) => r.status)).toEqual(["resolved", "duplicate", "unresolved"]);

        const lookup = buildJudgmentLookup(release.judgments);
        const query = release.corpus.queries[0];
        expect(lookup(query.id, "d-unpooled-anything")).toEqual({ status: "unjudged" });

        const profile = release.syntheticProfiles.profiles.find((p) => p.scale === 1_000);
        expect(profile).toBeDefined();
        if (!profile) return;
        let count = 0;
        for (const doc of iterateSyntheticDocuments(profile)) {
            expect(doc.id.startsWith("syn:")).toBe(true);
            count += 1;
            if (count >= 10) break;
        }
        expect(count).toBe(10);
    });

    it("passes the release lint command shape used by CI", () => {
        // Trust anchor recomputed from reviewed source (authored artifacts +
        // pinned approvals): a checked-in release with fabricated approvals
        // is internally consistent, so the unanchored load alone would
        // accept it — this test IS the CI gate that binds the release bytes
        // to code review.
        const expectedManifestFingerprint = canonicalFingerprint(
            buildManifest({
                ...buildCorpusArtifacts(),
                approvals: OPERATOR_APPROVALS,
                releaseVersion: RELEASE_VERSION,
            }),
        );
        const release = loadReviewedRelease(RELEASE_DIR, { expectedManifestFingerprint });
        expect(release.fingerprints.manifest).toBe(expectedManifestFingerprint);
        expect(new Set(release.corpus.queries.map((q) => q.category)).size).toBe(
            QUERY_CATEGORIES.length,
        );
        expect(release.manifest.approvals.privacy.kind).toBe("privacy");
        expect(release.manifest.approvals.relevanceIntent.kind).toBe("relevance-intent");
    });
});
