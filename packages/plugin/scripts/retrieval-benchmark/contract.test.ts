import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    ContractError,
    parseCorpus,
    parseJudgments,
    parseManifest,
    parseSyntheticProfiles,
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

    it("rejects queries production search cannot execute as written", () => {
        // Whitespace-only explicit query: schema-valid, but production trims
        // it to nothing.
        const blank = corpusJson();
        (blank.queries as Record<string, unknown>[])[0].queryText = "   ";
        expect(diagnosticsOf(() => parseCorpus(blank))).toContain(
            "corpus.queries[0].queryText: not-executable",
        );
        // Over-bounds explicit query: production rejects with QueryBoundsError.
        const oversized = corpusJson();
        (oversized.queries as Record<string, unknown>[])[0].queryText = "x".repeat(17 * 1024);
        expect(diagnosticsOf(() => parseCorpus(oversized))).toContain(
            "corpus.queries[0].queryText: not-executable",
        );
        // Over-bounds automatic query: production silently truncates, which
        // would replay a different query than the judged one.
        const truncated = corpusJson();
        const autoQuery = (truncated.queries as Record<string, unknown>[]).find(
            (q) => q.mode === "automatic",
        );
        const explicitOnly = autoQuery === undefined;
        if (!explicitOnly) {
            autoQuery.queryText = "word ".repeat(8 * 1024);
            expect(diagnosticsOf(() => parseCorpus(truncated)).join(";")).toContain(
                "not-executable",
            );
        } else {
            // Fixture corpus is explicit-only: exercise the automatic arm via
            // a mode flip on the first query.
            const q = (truncated.queries as Record<string, unknown>[])[0];
            q.mode = "automatic";
            q.queryText = "word ".repeat(8 * 1024);
            expect(diagnosticsOf(() => parseCorpus(truncated)).join(";")).toContain(
                "not-executable",
            );
        }
    });

    it("rejects a query text reused across partitions", () => {
        const corpus = corpusJson();
        const queries = corpus.queries as Record<string, unknown>[];
        const dev = queries.find((q) => q.id === "q-error-message-dev");
        const hold = queries.find((q) => q.id === "q-error-message-hold");
        if (!dev || !hold) throw new Error("fixture queries missing");
        // Different paraphrase groups, same normalized text: the holdout
        // intent is already exposed to development tuning.
        hold.queryText = `  ${String(dev.queryText).toUpperCase()} `;
        expect(diagnosticsOf(() => parseCorpus(corpus))).toContain(
            "corpus: query text reused across partitions (q-error-message-dev, q-error-message-hold)",
        );
    });

    it("rejects a result limit above the production ceiling", () => {
        const corpus = corpusJson();
        (corpus.queries as Record<string, unknown>[])[0].resultLimit = 51;
        expect(diagnosticsOf(() => parseCorpus(corpus))).toContain(
            "corpus.queries.0.resultLimit: too_big",
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

    it("rejects a positive target excluded by the scenario's source filters", () => {
        const { corpus, judgments } = makeValidRelease();
        const query = corpus.queries.find((q) => q.id === "q-error-message-dev");
        if (!query) throw new Error("fixture query missing");
        // The paired document is "message"-kind; filters omitting "message"
        // make the target structurally unreachable in production search.
        query.sourceFilters = ["memory"];
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: target excluded by source filters (q-error-message-dev, d-error-message-dev)",
        );
        // Compartment chunks ride the "message" lane: a compartment target
        // is reachable iff "message" is present.
        const compartmentQuery = corpus.queries.find((q) => q.id === "q-architecture-rationale-dev");
        if (!compartmentQuery) throw new Error("fixture query missing");
        compartmentQuery.sourceFilters = ["message"];
        query.sourceFilters = ["message"];
        expect(() => validateRelease(corpus, judgments)).not.toThrow();
    });

    it("rejects a paraphrase group whose queries disagree on category", () => {
        const { corpus, judgments } = makeValidRelease();
        // Same partition, same group, different categories.
        const a = corpus.queries.find((q) => q.id === "q-error-message-dev");
        const b = corpus.queries.find((q) => q.id === "q-temporal-dev");
        if (!a || !b) throw new Error("fixture queries missing");
        b.paraphraseGroup = a.paraphraseGroup;
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: paraphrase group mixes categories (q-error-message-dev, q-temporal-dev)",
        );
    });

    it("rejects an automatic scenario whose positive target is outside automatic sources", () => {
        const { corpus, judgments } = makeValidRelease();
        // user-directive pairs with a "primer"-kind document in the fixture
        // rotation; the production automatic path never searches primers.
        const query = corpus.queries.find((q) => q.id === "q-user-directive-dev");
        if (!query) throw new Error("fixture query missing");
        query.mode = "automatic";
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: target outside automatic search sources (q-user-directive-dev, d-user-directive-dev)",
        );
        // A message-kind target stays valid under automatic mode.
        const messageQuery = corpus.queries.find((q) => q.id === "q-error-message-dev");
        if (!messageQuery) throw new Error("fixture query missing");
        query.mode = "explicit";
        messageQuery.mode = "automatic";
        expect(() => validateRelease(corpus, judgments)).not.toThrow();
    });

    it("rejects a positive target with no alias reachable from the scenario scope", () => {
        const { corpus, judgments } = makeValidRelease();
        const document = corpus.documents.find((d) => d.id === "d-error-message-dev");
        if (!document) throw new Error("fixture document missing");
        // All aliases now belong to a different project: session-scoped and
        // project-only resolution both miss, so the target can never resolve.
        for (const alias of document.aliases) {
            alias.projectScope = "git:some-other-project";
        }
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: target has no alias in scenario scope (q-error-message-dev, d-error-message-dev)",
        );
        // A session-bound alias in the right project is unreachable from a
        // session-less scenario; a session-less alias is always reachable.
        for (const alias of document.aliases) {
            alias.projectScope = "git:fixture-project";
            alias.sessionScope = "ses-someone-elses";
        }
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: target has no alias in scenario scope (q-error-message-dev, d-error-message-dev)",
        );
    });

    it("rejects a memory target hidden by the scenario's visible-memory set", () => {
        const { corpus, judgments } = makeValidRelease();
        // exact-symbol-path pairs with a "memory"-kind document whose single
        // alias locator is a numeric memory id; hiding that id makes the
        // target structurally unretrievable (production hard-filters it).
        const query = corpus.queries.find((q) => q.id === "q-exact-symbol-path-dev");
        const document = corpus.documents.find((d) => d.id === "d-exact-symbol-path-dev");
        if (!query || !document) throw new Error("fixture entries missing");
        query.visibleState.visibleMemoryIds = [Number(document.aliases[0].locator)];
        expect(diagnosticsOf(() => validateRelease(corpus, judgments))).toContain(
            "corpus: target hidden by visible memories (q-exact-symbol-path-dev, d-exact-symbol-path-dev)",
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

describe("parseSyntheticProfiles", () => {
    it("requires every synthetic scale exactly once", () => {
        const { syntheticProfiles } = makeValidRelease();
        const missing = JSON.parse(JSON.stringify(syntheticProfiles));
        missing.profiles = missing.profiles.filter(
            (p: { scale: number }) => p.scale !== 1_000_000,
        );
        expect(diagnosticsOf(() => parseSyntheticProfiles(missing))).toContain(
            "syntheticProfiles.profiles: missing scale 1000000",
        );

        const duplicated = JSON.parse(JSON.stringify(syntheticProfiles));
        duplicated.profiles.push({
            ...duplicated.profiles[0],
            id: "syn-smoke-1000-twin",
        });
        expect(diagnosticsOf(() => parseSyntheticProfiles(duplicated))).toContain(
            "syntheticProfiles.profiles: duplicate scale 1000",
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
