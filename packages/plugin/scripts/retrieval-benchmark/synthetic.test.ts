import { describe, expect, it } from "bun:test";

import { parseCorpus, validateRelease } from "./contract";
import {
    SYNTHETIC_GENERATOR_VERSION,
    SyntheticProfileError,
    iterateSyntheticDocuments,
    syntheticStreamHash,
} from "./synthetic";
import { makeValidRelease, makeValidSyntheticProfiles } from "./test-support";

function profile() {
    return makeValidSyntheticProfiles().profiles[0];
}

function firstDocuments(p: ReturnType<typeof profile>, count: number) {
    const docs = [];
    for (const doc of iterateSyntheticDocuments(p)) {
        docs.push(doc);
        if (docs.length >= count) break;
    }
    return docs;
}

describe("iterateSyntheticDocuments", () => {
    it("reproduces identical ordered streams for the same descriptor", () => {
        const a = [...iterateSyntheticDocuments(profile())];
        const b = [...iterateSyntheticDocuments(profile())];
        expect(a).toEqual(b);
        expect(a).toHaveLength(1_000);
        expect(syntheticStreamHash(profile())).toBe(syntheticStreamHash(profile()));
    });

    it("matches the pinned golden stream hash for the smoke descriptor", () => {
        // The pinned hash detects changes to the generated stream itself,
        // which same-process rerun comparisons cannot see.
        expect(syntheticStreamHash(profile())).toBe(
            "2a1ac6853363fdd069e34508c81e1ff3cd636b100ea67c90fe837cb44ac17d47",
        );
    });

    it("changes the stream hash when seed, scale, or distribution changes", () => {
        const base = syntheticStreamHash(profile());
        expect(syntheticStreamHash({ ...profile(), seed: 1338 })).not.toBe(base);
        expect(syntheticStreamHash({ ...profile(), scale: 10_000 })).not.toBe(base);
        expect(
            syntheticStreamHash({
                ...profile(),
                sourceDistribution: { memory: 1, note: 9 },
            }),
        ).not.toBe(base);
    });

    it("yields the first bounded page of a 1M descriptor lazily", () => {
        const docs = firstDocuments({ ...profile(), id: "syn-smoke-1m", scale: 1_000_000 }, 5);
        expect(docs).toHaveLength(5);
        expect(docs[0].id).toBe("syn:syn-smoke-1m:0");
        expect(docs[4].id).toBe("syn:syn-smoke-1m:4");
    });

    it("emits no judgments, provenance, paths, session ids, or corpus aliases", () => {
        for (const doc of firstDocuments(profile(), 50)) {
            expect(Object.keys(doc).sort((a, b) => a.localeCompare(b))).toEqual([
                "body",
                "id",
                "kind",
                "title",
            ]);
            const text = JSON.stringify(doc);
            expect(text).not.toMatch(/grade|qrel|judg|ses[_-]|\/home\/|\/Users\//);
        }
    });

    it("rejects unsupported generator versions and scales", () => {
        expect(() => [
            ...iterateSyntheticDocuments({ ...profile(), generatorVersion: "synthetic-generator/v999" }),
        ]).toThrow(SyntheticProfileError);
        expect(() => [
            ...iterateSyntheticDocuments({ ...profile(), scale: 5 as 1_000 }),
        ]).toThrow(SyntheticProfileError);
        expect(SYNTHETIC_GENERATOR_VERSION).toBe(profile().generatorVersion);
    });

    it("rejects a source distribution whose total weight overflows", () => {
        // Each weight passes the positive-finite schema, but the sum is
        // Infinity: every draw would silently land on the last source kind.
        expect(() => [
            ...iterateSyntheticDocuments({
                ...profile(),
                sourceDistribution: {
                    memory: Number.MAX_VALUE,
                    message: Number.MAX_VALUE,
                },
            }),
        ]).toThrow(/non-finite-source-distribution/);
    });
});

describe("judged-loader separation", () => {
    it("synthetic ids cannot enter the judged corpus or qrels", () => {
        const { corpus, judgments } = makeValidRelease();
        const raw = JSON.parse(JSON.stringify(corpus));
        raw.documents[0].id = "syn:syn-smoke-1k:0";
        expect(() => parseCorpus(raw)).toThrow();

        judgments.pools[0].documentIds.push("syn:syn-smoke-1k:0");
        judgments.judgments.push({
            queryId: corpus.queries[0].id,
            documentId: "syn:syn-smoke-1k:0",
            grade: 2,
            provenance: { judge: "human", pooledFrom: ["manual"] },
        });
        // The synthetic id is rejected as a dangling reference (it can never
        // name a corpus document); a bare toThrow could pass for any reason.
        expect(() => validateRelease(corpus, judgments)).toThrow(/dangling/);
    });
});
