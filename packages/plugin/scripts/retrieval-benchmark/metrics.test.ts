import { describe, expect, it } from "bun:test";

import {
    computeQueryMetrics,
    computeRerankerLift,
    contextTokensPerUsefulResult,
    gateAggregates,
    isRelevantGrade,
    type JudgedGrade,
    judgedGradesByQuery,
    macroAggregate,
    METRIC_POLICY_VERSION,
    MetricError,
    type QueryMetrics,
    type ScoredQuery,
    scoredQueryValues,
} from "./metrics";

import type { ResolvedRankedResult } from "./identity";

// Hand-built resolver outputs: documentId doubles as canonicalId because the
// corpus maps them 1:1; duplicates reuse the first occurrence's identity.
function hit(rank: number, documentId: string): ResolvedRankedResult {
    return { status: "resolved", rank, canonicalId: `c-${documentId}`, documentId };
}

function dup(rank: number, documentId: string): ResolvedRankedResult {
    return { status: "duplicate", rank, canonicalId: `c-${documentId}`, documentId };
}

function miss(rank: number): ResolvedRankedResult {
    return { status: "unresolved", rank, reason: "unknown-alias" };
}

function grades(entries: Record<string, JudgedGrade>): Map<string, JudgedGrade> {
    return new Map(Object.entries(entries));
}

function cutoff(metrics: QueryMetrics, n: number) {
    const found = metrics.cutoffs.find((c) => c.cutoff === n);
    if (!found) throw new Error(`missing cutoff ${n}`);
    return found;
}

// Golden constants, hand-calculated:
// log2(3) = 1.5849625007211562
// idcg for grades {2, 1}: 2/log2(2) + 1/log2(3) = 2 + 0.6309297535714574
const IDCG_2_1 = 2 + 1 / Math.log2(3);

describe("computeQueryMetrics", () => {
    const judged = grades({ d1: 2, d2: 1, d3: 0 });

    it("no hit: all-unjudged ranking scores zero recall and reciprocal rank", () => {
        const metrics = computeQueryMetrics({
            queryId: "q-none",
            resolved: [hit(1, "d8"), hit(2, "d9")],
            judgedGrades: judged,
        });
        expect(cutoff(metrics, 10).recall).toBe(0);
        expect(cutoff(metrics, 50).recall).toBe(0);
        expect(metrics.reciprocalRank).toBe(0);
        expect(metrics.firstRelevantPhysicalRank).toBeNull();
        // Unjudged entries are OMITTED from the condensed view — they are
        // never coerced to grade 0.
        expect(cutoff(metrics, 10).condensed).toHaveLength(0);
        expect(cutoff(metrics, 10).coverage).toEqual({
            judged: 0,
            unjudged: 2,
            unresolved: 0,
            duplicates: 0,
            total: 2,
        });
        // nDCG is 0 (not null): the query HAS judged relevant identities.
        expect(metrics.ndcgAt10).toBe(0);
    });

    it("first-rank hit: golden reciprocal rank, recall, and nDCG", () => {
        const metrics = computeQueryMetrics({
            queryId: "q-first",
            resolved: [hit(1, "d1"), hit(2, "d9")],
            judgedGrades: judged,
        });
        expect(metrics.reciprocalRank).toBe(1);
        expect(metrics.firstRelevantPhysicalRank).toBe(1);
        expect(metrics.firstRelevantCondensedRank).toBe(1);
        // recall@10 = 1 of 2 judged relevant identities.
        expect(cutoff(metrics, 10).recall).toBe(0.5);
        // dcg = 2/log2(2) = 2; ndcg = 2 / 2.6309297535714574 = 0.7601836382...
        expect(metrics.ndcgAt10).toBeCloseTo(2 / IDCG_2_1, 12);
        expect(metrics.ndcgAt10).toBeCloseTo(0.760183, 5);
    });

    it("multiple grades: golden condensed linear-gain nDCG", () => {
        // Physical: d2(g1) @1, unjudged @2, d1(g2) @3, d3(g0) @4.
        // Condensed: d2 cr1, d1 cr2, d3 cr3 (unjudged omitted).
        const metrics = computeQueryMetrics({
            queryId: "q-multi",
            resolved: [hit(1, "d2"), hit(2, "d9"), hit(3, "d1"), hit(4, "d3")],
            judgedGrades: judged,
        });
        // dcg = 1/log2(2) + 2/log2(3) + 0/log2(4) = 1 + 1.2618595071429148
        const dcg = 1 + 2 / Math.log2(3);
        expect(metrics.ndcgAt10).toBeCloseTo(dcg / IDCG_2_1, 12);
        expect(metrics.ndcgAt10).toBeCloseTo(0.859721, 5);
        expect(cutoff(metrics, 10).recall).toBe(1);
        expect(metrics.reciprocalRank).toBe(1);
        // Both rank views retained: d1 is physical 3 but condensed 2.
        const condensed = cutoff(metrics, 10).condensed;
        expect(condensed.map((c) => [c.documentId, c.physicalRank, c.condensedRank])).toEqual([
            ["d2", 1, 1],
            ["d1", 3, 2],
            ["d3", 4, 3],
        ]);
    });

    it("duplicate aliases keep diagnostic positions but earn credit once (AE3)", () => {
        const metrics = computeQueryMetrics({
            queryId: "q-dup",
            resolved: [hit(1, "d1"), dup(2, "d1"), hit(3, "d2")],
            judgedGrades: judged,
        });
        const at10 = cutoff(metrics, 10);
        // The duplicate stays visible at physical rank 2...
        expect(at10.physical[1]).toMatchObject({ rank: 2, status: "duplicate" });
        expect(at10.coverage.duplicates).toBe(1);
        expect(at10.duplicateRate).toBeCloseTo(1 / 3, 12);
        // ...but is excluded from condensed credit: recall counts d1 once.
        expect(at10.relevantRetrieved).toBe(2);
        expect(at10.recall).toBe(1);
        expect(at10.condensed.map((c) => c.documentId)).toEqual(["d1", "d2"]);
        // Perfect condensed ordering: ndcg = idcg/idcg = 1.
        expect(metrics.ndcgAt10).toBe(1);
    });

    it("zero IDCG: no judged relevant identity yields null recall and null nDCG", () => {
        const metrics = computeQueryMetrics({
            queryId: "q-zero-idcg",
            resolved: [hit(1, "d3")],
            judgedGrades: grades({ d3: 0 }),
        });
        expect(metrics.ndcgAt10).toBeNull();
        expect(cutoff(metrics, 10).recall).toBeNull();
        expect(metrics.reciprocalRank).toBe(0);
    });

    it("cutoffs 10 and 50 window the physical ranking first", () => {
        // Relevant target at physical rank 15: outside @10, inside @50.
        const resolved = Array.from({ length: 60 }, (_, i) =>
            i === 14 ? hit(15, "d1") : hit(i + 1, `d-filler-${i}`),
        );
        const metrics = computeQueryMetrics({
            queryId: "q-window",
            resolved,
            judgedGrades: grades({ d1: 2 }),
        });
        expect(cutoff(metrics, 10).recall).toBe(0);
        expect(cutoff(metrics, 50).recall).toBe(1);
        expect(cutoff(metrics, 10).physical).toHaveLength(10);
        expect(cutoff(metrics, 50).physical).toHaveLength(50);
        // nDCG@10 windows physically: the rank-15 hit cannot enter it.
        expect(metrics.ndcgAt10).toBe(0);
        // MRR uses the full physical list.
        expect(metrics.reciprocalRank).toBeCloseTo(1 / 15, 12);
        expect(metrics.firstRelevantCondensedRank).toBe(1);
    });

    it("condensation ignores physical gaps: a judged hit behind unjudged noise", () => {
        // d1(g2) at physical rank 3 behind two unjudged entries condenses to
        // rank 1: perfect condensed nDCG. Coercing unjudged to grade 0 would
        // instead discount d1 at rank 3 — this pins the difference.
        const metrics = computeQueryMetrics({
            queryId: "q-condense",
            resolved: [hit(1, "d8"), hit(2, "d9"), hit(3, "d1")],
            judgedGrades: grades({ d1: 2 }),
        });
        expect(metrics.ndcgAt10).toBe(1);
        expect(metrics.firstRelevantPhysicalRank).toBe(3);
        expect(metrics.firstRelevantCondensedRank).toBe(1);
        expect(cutoff(metrics, 10).coverage.unjudged).toBe(2);
    });

    it("unresolved entries are reported separately, never judged", () => {
        const metrics = computeQueryMetrics({
            queryId: "q-unresolved",
            resolved: [miss(1), hit(2, "d1")],
            judgedGrades: judged,
        });
        const at10 = cutoff(metrics, 10);
        expect(at10.coverage.unresolved).toBe(1);
        expect(at10.physical[0]).toMatchObject({ status: "unresolved", reason: "unknown-alias" });
        expect(at10.condensed).toHaveLength(1);
    });

    it("rejects a ranking whose ranks are not one-based consecutive", () => {
        expect(() =>
            computeQueryMetrics({
                queryId: "q-bad",
                resolved: [hit(2, "d1")],
                judgedGrades: judged,
            }),
        ).toThrow(MetricError);
    });

    it("declares the versioned policy and grade-1 relevance threshold", () => {
        expect(METRIC_POLICY_VERSION).toBe("retrieval-metric-policy/v1");
        expect(isRelevantGrade(0)).toBe(false);
        expect(isRelevantGrade(1)).toBe(true);
        expect(isRelevantGrade(2)).toBe(true);
    });
});

describe("computeRerankerLift", () => {
    const judged = grades({ d1: 2, d2: 1 });

    it("is not_applicable until both rankings exist", () => {
        expect(computeRerankerLift(null, null, judged)).toEqual({ status: "not_applicable" });
        expect(computeRerankerLift([hit(1, "d1")], null, judged)).toEqual({
            status: "not_applicable",
        });
        expect(computeRerankerLift(null, [hit(1, "d1")], judged)).toEqual({
            status: "not_applicable",
        });
    });

    it("computes a same-candidate delta when both rankings exist", () => {
        const before = [hit(1, "d9"), hit(2, "d2"), hit(3, "d1")];
        const after = [hit(1, "d1"), hit(2, "d2"), hit(3, "d9")];
        const lift = computeRerankerLift(before, after, judged);
        expect(lift.status).toBe("computed");
        if (lift.status !== "computed") return;
        // before condensed: d2 cr1, d1 cr2 -> dcg = 1 + 2/log2(3)
        // after condensed: d1 cr1, d2 cr2 -> dcg = 2 + 1/log2(3) = idcg
        expect(lift.ndcgBefore).toBeCloseTo((1 + 2 / Math.log2(3)) / IDCG_2_1, 12);
        expect(lift.ndcgAfter).toBe(1);
        expect(lift.delta).toBeCloseTo(1 - (1 + 2 / Math.log2(3)) / IDCG_2_1, 12);
    });

    it("rejects rankings over different candidate identity sets", () => {
        expect(() =>
            computeRerankerLift([hit(1, "d1")], [hit(1, "d2")], judged),
        ).toThrow(MetricError);
    });
});

describe("contextTokensPerUsefulResult", () => {
    const judged = grades({ d1: 2, d2: 1, d3: 0 });

    it("divides delivered tokens by delivered judged-relevant identities", () => {
        const delivered = [hit(1, "d1"), hit(2, "d2"), hit(3, "d9")];
        expect(contextTokensPerUsefulResult(300, delivered, judged)).toBe(150);
    });

    it("yields null with zero useful results, never a division", () => {
        expect(contextTokensPerUsefulResult(300, [hit(1, "d9")], judged)).toBeNull();
        expect(contextTokensPerUsefulResult(300, [hit(1, "d3")], judged)).toBeNull();
        expect(contextTokensPerUsefulResult(0, [], judged)).toBeNull();
    });

    it("duplicates and unresolved entries earn no useful-result credit", () => {
        const delivered = [hit(1, "d1"), dup(2, "d1"), miss(3)];
        expect(contextTokensPerUsefulResult(100, delivered, judged)).toBe(100);
    });

    it("rejects a negative or non-finite token count", () => {
        expect(() => contextTokensPerUsefulResult(-1, [], judged)).toThrow(MetricError);
        expect(() => contextTokensPerUsefulResult(Number.NaN, [], judged)).toThrow(MetricError);
    });
});

describe("macroAggregate", () => {
    function scored(
        queryId: string,
        paraphraseGroup: string,
        partition: ScoredQuery["partition"],
        mode: ScoredQuery["mode"],
        value: number,
    ): ScoredQuery {
        return {
            queryId,
            paraphraseGroup,
            partition,
            mode,
            values: {
                recallAt10: value,
                recallAt50: value,
                reciprocalRank: value,
                ndcgAt10: value,
            },
        };
    }

    it("averages within a paraphrase group before averaging groups", () => {
        const aggregates = macroAggregate([
            scored("q-a1", "pg-a", "holdout", "explicit", 1),
            scored("q-a2", "pg-a", "holdout", "explicit", 0),
            scored("q-b1", "pg-b", "holdout", "explicit", 1),
        ]);
        expect(aggregates).toHaveLength(1);
        // Micro average would be 2/3; the macro answer weighs each base
        // intent equally: (0.5 + 1) / 2.
        expect(aggregates[0].recallAt10).toBe(0.75);
        expect(aggregates[0].mrr).toBe(0.75);
        expect(aggregates[0].queryCount).toBe(3);
        expect(aggregates[0].groupCount).toBe(2);
    });

    it("keeps partitions and modes in separate cells", () => {
        const aggregates = macroAggregate([
            scored("q-1", "pg-1", "development", "explicit", 1),
            scored("q-2", "pg-2", "holdout", "explicit", 0.5),
            scored("q-3", "pg-3", "holdout", "automatic", 0.25),
        ]);
        expect(
            aggregates.map((aggregate) => [aggregate.partition, aggregate.mode]),
        ).toEqual([
            ["development", "explicit"],
            ["holdout", "automatic"],
            ["holdout", "explicit"],
        ]);
        // Gate aggregates: holdout only — development stays diagnostic and a
        // strong explicit cell cannot mask the automatic cell.
        const gates = gateAggregates(aggregates);
        expect(gates.map((aggregate) => aggregate.partition)).toEqual(["holdout", "holdout"]);
        expect(gates.map((aggregate) => aggregate.mode)).toEqual(["automatic", "explicit"]);
    });

    it("excludes null metric values instead of treating them as zero", () => {
        const withNull: ScoredQuery = {
            queryId: "q-null",
            paraphraseGroup: "pg-n",
            partition: "holdout",
            mode: "explicit",
            values: { recallAt10: null, recallAt50: null, reciprocalRank: 0, ndcgAt10: null },
        };
        const aggregates = macroAggregate([
            withNull,
            {
                queryId: "q-v",
                paraphraseGroup: "pg-v",
                partition: "holdout",
                mode: "explicit",
                values: { recallAt10: 1, recallAt50: 1, reciprocalRank: 1, ndcgAt10: 1 },
            },
        ]);
        expect(aggregates[0].recallAt10).toBe(1);
        expect(aggregates[0].ndcgAt10).toBe(1);
        expect(aggregates[0].mrr).toBe(0.5);
    });

    it("scoredQueryValues projects full metrics into aggregation values", () => {
        const metrics = computeQueryMetrics({
            queryId: "q-proj",
            resolved: [hit(1, "d1")],
            judgedGrades: grades({ d1: 2 }),
        });
        expect(scoredQueryValues(metrics)).toEqual({
            recallAt10: 1,
            recallAt50: 1,
            reciprocalRank: 1,
            ndcgAt10: 1,
        });
    });
});

describe("judgedGradesByQuery", () => {
    it("splits the judgments artifact into per-query grade maps", () => {
        const byQuery = judgedGradesByQuery({
            schemaVersion: "retrieval-benchmark-judgments/v1",
            rubricVersion: "graded-pooled/v1",
            pools: [{ queryId: "q-1", documentIds: ["d-1", "d-2"] }],
            judgments: [
                {
                    queryId: "q-1",
                    documentId: "d-1",
                    grade: 2,
                    provenance: { judge: "human", pooledFrom: ["manual"] },
                },
                {
                    queryId: "q-1",
                    documentId: "d-2",
                    grade: 0,
                    provenance: { judge: "human", pooledFrom: ["manual"] },
                },
            ],
        });
        expect(byQuery.get("q-1")?.get("d-1")).toBe(2);
        expect(byQuery.get("q-1")?.get("d-2")).toBe(0);
        // Absent pair stays absent — the caller must treat it as unjudged.
        expect(byQuery.get("q-1")?.has("d-3")).toBe(false);
    });
});
