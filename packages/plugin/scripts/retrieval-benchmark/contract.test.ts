import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    ContractError,
    parseCorpus,
    parseJudgments,
    parseManifest,
    validateRelease,
} from "./contract";
import { buildJudgmentLookup } from "./index";
import { makeManifestFor, makeValidRelease } from "./test-support";

function corpusJson(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(makeValidRelease().corpus));
}

function diagnosticsOf(fn: () => unknown): string[] {
    try {
        fn();
    } catch (error) {
        if (error instanceof ContractError) return [...error.diagnostics];
        throw error;
    }
    throw new Error("expected ContractError");
}

describe("parseCorpus", () => {
    it("accepts the valid fixture corpus", () => {
        expect(() => parseCorpus(corpusJson())).not.toThrow();
    });

    it("rejects unknown fields recursively", () => {
        const withRootField = corpusJson();
        withRootField.extra = 1;
        expect(() => parseCorpus(withRootField)).toThrow(ContractError);

        const withNestedField = corpusJson();
        (withNestedField.queries as Record<string, unknown>[])[0].surprise = true;
        expect(() => parseCorpus(withNestedField)).toThrow(ContractError);
    });

    it("rejects unsupported schema versions", () => {
        const corpus = corpusJson();
        corpus.schemaVersion = "retrieval-benchmark-corpus/v999";
        expect(diagnosticsOf(() => parseCorpus(corpus))).toContain(
            "corpus.schemaVersion: invalid_value",
        );
    });

    it("rejects duplicate ids", () => {
        const corpus = corpusJson();
        const queries = corpus.queries as Record<string, unknown>[];
        queries[1].id = queries[0].id;
        expect(diagnosticsOf(() => parseCorpus(corpus))).toContain(
            "corpus.queries[1].id: duplicate",
        );
    });

    it("rejects a semantic payload whose kind disagrees with the document", () => {
        const corpus = corpusJson();
        const documents = corpus.documents as Array<{ semanticPayload: { kind: string } }>;
        documents[0].semanticPayload.kind = "note";
        expect(diagnosticsOf(() => parseCorpus(corpus))).toContain(
            "corpus.documents[0].semanticPayload.kind: mismatch",
        );
    });

    it("rejects payload twins that collapse to one canonical relevance identity", () => {
        const corpus = corpusJson();
        const documents = corpus.documents as Array<{
            id: string;
            kind: string;
            semanticPayload: { kind: string; title: string; body: string };
        }>;
        // Distinct id and locator, identical semantic payload: without the
        // gate this re-registers one identity under a second document id.
        documents[1].kind = documents[0].kind;
        documents[1].semanticPayload = { ...documents[0].semanticPayload };
        expect(diagnosticsOf(() => parseCorpus(corpus))).toContain(
            "corpus.documents[1].semanticPayload: duplicate-identity",
        );
    });

    it("does not echo field values in diagnostics", () => {
        const corpus = corpusJson();
        const canary = "sk-super-secret-value-1234567890";
        (corpus.queries as Record<string, unknown>[])[0].category = canary;
        const diagnostics = diagnosticsOf(() => parseCorpus(corpus)).join("\n");
        expect(diagnostics).not.toContain(canary);
    });
});

describe("validateRelease", () => {
    it("accepts the valid fixture release", () => {
        const { corpus, judgments } = makeValidRelease();
        expect(() => validateRelease(corpus, judgments)).not.toThrow();
    });

    it("rejects a pooled pair without a judgment", () => {
        const { corpus, judgments } = makeValidRelease();
        judgments.pools[0].documentIds.push(corpus.documents[5].id);
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("pooled pair unjudged"))).toBe(true);
    });

    it("rejects a judgment outside its recorded pool", () => {
        const { corpus, judgments } = makeValidRelease();
        judgments.judgments.push({
            queryId: corpus.queries[0].id,
            documentId: corpus.documents[5].id,
            grade: 1,
            provenance: { judge: "human", pooledFrom: ["manual"] },
        });
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("outside-pool"))).toBe(true);
    });

    it("rejects dangling query and document references", () => {
        const { corpus, judgments } = makeValidRelease();
        judgments.pools[0].queryId = "q-ghost";
        judgments.judgments[1].documentId = "d-ghost";
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("dangling"))).toBe(true);
    });

    it("rejects a query with no positive judgment", () => {
        const { corpus, judgments } = makeValidRelease();
        judgments.judgments[0].grade = 0;
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("no positive judgment"))).toBe(true);
    });

    it("rejects paraphrase groups that cross the partition boundary", () => {
        const { corpus, judgments } = makeValidRelease();
        const canary = "sk-canary-paraphrase-group-value";
        corpus.queries[0].paraphraseGroup = canary;
        corpus.queries[1].paraphraseGroup = canary;
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("paraphrase group crosses"))).toBe(true);
        // The free-form group value is never echoed; offending queries are
        // named by their regex-bounded ids instead.
        expect(diagnostics.join("\n")).not.toContain(canary);
        expect(diagnostics.some((d) => d.includes(corpus.queries[0].id))).toBe(true);
    });

    it("rejects target documents shared across partitions", () => {
        const { corpus, judgments } = makeValidRelease();
        judgments.pools[1].documentIds.push(corpus.documents[0].id);
        judgments.judgments.push({
            queryId: corpus.queries[1].id,
            documentId: corpus.documents[0].id,
            grade: 2,
            provenance: { judge: "human", pooledFrom: ["manual"] },
        });
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("target document crosses"))).toBe(true);
    });

    it("rejects a payload twin that re-registers holdout target content in development", () => {
        const { corpus, judgments } = makeValidRelease();
        // corpus.documents[i] pairs with corpus.queries[i]; queries alternate
        // development/holdout, so documents[1] is the holdout target twinned
        // into the development pool under a distinct document id.
        const developmentQuery = corpus.queries[0];
        const holdoutTarget = corpus.documents[1];
        const twin = {
            ...holdoutTarget,
            id: "d-holdout-twin",
            semanticPayload: { ...holdoutTarget.semanticPayload },
            aliases: [{ ...holdoutTarget.aliases[0], locator: "twin-locator" }],
        };
        corpus.documents.push(twin);
        judgments.pools[0].documentIds.push(twin.id);
        judgments.judgments.push({
            queryId: developmentQuery.id,
            documentId: twin.id,
            grade: 2,
            provenance: { judge: "human", pooledFrom: ["manual"] },
        });
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics.some((d) => d.includes("target document crosses"))).toBe(true);
    });

    it("rejects a positive message target behind a zero ordinal cutoff", () => {
        const { corpus, judgments } = makeValidRelease();
        // error-message queries pair with a "message"-kind document in the
        // fixture rotation; cutoff 0 makes that target structurally
        // unretrievable (ordinals are 1-based, cutoff is an inclusive max).
        const query = corpus.queries.find((q) => q.id === "q-error-message-dev");
        if (!query) throw new Error("fixture query missing");
        query.visibleState.messageOrdinalCutoff = 0;
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: target unreachable under zero message cutoff (q-error-message-dev, d-error-message-dev)",
        );
    });

    it("rejects a category missing coverage in either partition", () => {
        const { corpus, judgments } = makeValidRelease();
        const removedQuery = corpus.queries.pop();
        expect(removedQuery?.category).toBe("paraphrased-decision");
        expect(removedQuery?.partition).toBe("holdout");
        judgments.pools.pop();
        judgments.judgments.pop();
        const diagnostics = diagnosticsOf(() => validateRelease(corpus, judgments));
        expect(diagnostics).toContain(
            "corpus: no holdout base intent for paraphrased-decision",
        );
    });
});

describe("parseJudgments", () => {
    it("rejects malformed grades", () => {
        const { judgments } = makeValidRelease();
        const raw = JSON.parse(JSON.stringify(judgments));
        raw.judgments[0].grade = 3;
        expect(() => parseJudgments(raw)).toThrow(ContractError);
    });
});

describe("parseManifest", () => {
    it("accepts a manifest whose approvals bind the release tuple", () => {
        const { manifest } = makeValidRelease();
        expect(() => parseManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow();
    });

    it("rejects stale approvals after any release-tuple change", () => {
        const { corpus, judgments, syntheticProfiles } = makeValidRelease();
        const manifest = makeManifestFor(corpus, judgments, syntheticProfiles);
        const raw = JSON.parse(JSON.stringify(manifest));
        raw.releaseTuple.privacyPolicyVersion = "privacy-policy/v999";
        const diagnostics = diagnosticsOf(() => parseManifest(raw));
        expect(diagnostics).toContain(
            "manifest.approvals.privacy.releaseTupleFingerprint: stale",
        );
        expect(diagnostics).toContain(
            "manifest.approvals.relevanceIntent.releaseTupleFingerprint: stale",
        );
    });

    it("rejects two approvals of the same kind", () => {
        const { manifest } = makeValidRelease();
        const raw = JSON.parse(JSON.stringify(manifest));
        raw.approvals.relevanceIntent.kind = "privacy";
        expect(diagnosticsOf(() => parseManifest(raw))).toContain(
            "manifest.approvals.relevanceIntent.kind: wrong-kind",
        );
    });

    it("rejects free-form approval metadata", () => {
        const { manifest } = makeValidRelease();
        const raw = JSON.parse(JSON.stringify(manifest));
        raw.approvals.privacy.note = "looks fine";
        expect(() => parseManifest(raw)).toThrow(ContractError);
    });
});

describe("buildJudgmentLookup", () => {
    it("keeps unjudged distinct from nonrelevant", () => {
        const { corpus, judgments } = makeValidRelease();
        const lookup = buildJudgmentLookup(judgments);
        expect(lookup(corpus.queries[0].id, corpus.documents[0].id)).toEqual({
            status: "judged",
            grade: 2,
        });
        expect(lookup(corpus.queries[0].id, corpus.documents[5].id)).toEqual({
            status: "unjudged",
        });
    });
});

describe("facade boundary", () => {
    it("index.ts imports no database, recovery, or promotion code", () => {
        const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
        const forbidden = ["sqlite", "storage", "promote", "recover", "bun:sqlite"];
        // Covers static imports, re-exports, dynamic import() and require().
        const references = source
            .split("\n")
            .map((line, i) => ({ line, number: i + 1 }))
            .filter(({ line }) => /^import\b|^} from|from "|import\(|require\(/.test(line));
        const violations = references.flatMap(({ line, number }) =>
            forbidden
                .filter((term) => line.includes(term))
                .map((term) => `index.ts:${number} references "${term}": ${line.trim()}`),
        );
        expect(violations).toEqual([]);
    });
});
