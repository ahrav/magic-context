/**
 * Versioned quality-metric contract (U4: R49-R52, KTD5/KTD6).
 *
 * Pure functions over parent-plan U4 facade DTOs: resolved ranked results
 * (`resolveRankedLocators`) and per-query judged grades. Relevance truth is
 * canonical-identity based; duplicate aliases keep their diagnostic rank
 * positions but earn relevance credit once (AE3), and an unjudged pair is
 * NEVER coerced to grade 0 — it is excluded from condensed scoring and
 * reported through coverage counts instead (R50).
 *
 * Cutoff semantics (KTD5): each cutoff applies to the PHYSICAL ranking
 * first; the condensed judged view then re-ranks the judged non-duplicate
 * entries inside that physical window. Both rank views are retained.
 *
 * Any change to a gain, discount, condensation, or aggregation rule opens a
 * new METRIC_POLICY_VERSION and therefore a new baseline (KTD6).
 */

import type { JudgmentsArtifact } from "./contract";
import type { ResolvedRankedResult } from "./identity";

export const METRIC_POLICY_VERSION = "retrieval-metric-policy/v1";

export const METRIC_CUTOFFS = [10, 50] as const;
export type MetricCutoff = (typeof METRIC_CUTOFFS)[number];
export const NDCG_CUTOFF: MetricCutoff = 10;

export type JudgedGrade = 0 | 1 | 2;

/** Relevance under this policy: judged grade >= 1 (KTD6). */
export function isRelevantGrade(grade: JudgedGrade): boolean {
    return grade >= 1;
}

export class MetricError extends Error {}

/** documentId -> grade for one query, extracted from the judgments artifact.
 *  Document ids map 1:1 onto canonical relevance identities (parseCorpus
 *  rejects payload twins), so identity-unique crediting can key on either. */
export function judgedGradesByQuery(
    judgments: JudgmentsArtifact,
): Map<string, ReadonlyMap<string, JudgedGrade>> {
    const byQuery = new Map<string, Map<string, JudgedGrade>>();
    for (const judgment of judgments.judgments) {
        let grades = byQuery.get(judgment.queryId);
        if (!grades) {
            grades = new Map();
            byQuery.set(judgment.queryId, grades);
        }
        grades.set(judgment.documentId, judgment.grade);
    }
    return byQuery;
}

/** One physical-rank entry with its judgment annotation retained. Duplicates
 *  keep their diagnostic position and judgment but earn no credit. */
export type PhysicalRankEntry =
    | {
          rank: number;
          status: "resolved" | "duplicate";
          documentId: string;
          canonicalId: string;
          judgment: { status: "judged"; grade: JudgedGrade } | { status: "unjudged" };
      }
    | { rank: number; status: "unresolved"; reason: "malformed" | "unknown-alias" };

/** One condensed-rank entry: judged, non-duplicate, inside the physical
 *  cutoff window, re-ranked 1..m (the versioned judged-list condensation). */
export interface CondensedRankEntry {
    condensedRank: number;
    physicalRank: number;
    documentId: string;
    canonicalId: string;
    grade: JudgedGrade;
}

export interface JudgmentCoverage {
    judged: number;
    unjudged: number;
    unresolved: number;
    duplicates: number;
    total: number;
}

export interface CutoffMetrics {
    cutoff: number;
    physical: readonly PhysicalRankEntry[];
    condensed: readonly CondensedRankEntry[];
    coverage: JudgmentCoverage;
    /** Unique judged relevant identities retrieved within the cutoff. */
    relevantRetrieved: number;
    /** Unique judged relevant identities for the query (recall denominator). */
    relevantTotal: number;
    /** null when the query has no judged relevant identity. */
    recall: number | null;
    /** duplicates / total physical entries within the cutoff; null when empty. */
    duplicateRate: number | null;
}

export interface QueryMetrics {
    metricPolicyVersion: typeof METRIC_POLICY_VERSION;
    queryId: string;
    cutoffs: readonly CutoffMetrics[];
    /** 1 / first judged relevant PHYSICAL rank over the full resolved list;
     *  0 when no judged relevant identity was retrieved. */
    reciprocalRank: number;
    firstRelevantPhysicalRank: number | null;
    firstRelevantCondensedRank: number | null;
    /** Condensed linear-gain nDCG at NDCG_CUTOFF; null when IDCG is zero. */
    ndcgAt10: number | null;
}

export interface QueryScoringInput {
    queryId: string;
    /** Physical ranking already resolved through `resolveRankedLocators`. */
    resolved: readonly ResolvedRankedResult[];
    /** documentId -> judged grade for this query. Absent = unjudged. */
    judgedGrades: ReadonlyMap<string, JudgedGrade>;
}

function annotate(
    entry: ResolvedRankedResult,
    judgedGrades: ReadonlyMap<string, JudgedGrade>,
): PhysicalRankEntry {
    if (entry.status === "unresolved") {
        return { rank: entry.rank, status: "unresolved", reason: entry.reason };
    }
    const grade = judgedGrades.get(entry.documentId);
    return {
        rank: entry.rank,
        status: entry.status,
        documentId: entry.documentId,
        canonicalId: entry.canonicalId,
        judgment: grade === undefined ? { status: "unjudged" } : { status: "judged", grade },
    };
}

/** Judged-list condensation over one physical window: judged non-duplicate
 *  entries re-ranked 1..m. Unjudged entries are OMITTED, never graded 0. */
function condense(
    window: readonly ResolvedRankedResult[],
    judgedGrades: ReadonlyMap<string, JudgedGrade>,
): CondensedRankEntry[] {
    const condensed: CondensedRankEntry[] = [];
    for (const entry of window) {
        if (entry.status !== "resolved") continue;
        const grade = judgedGrades.get(entry.documentId);
        if (grade === undefined) continue;
        condensed.push({
            condensedRank: condensed.length + 1,
            physicalRank: entry.rank,
            documentId: entry.documentId,
            canonicalId: entry.canonicalId,
            grade,
        });
    }
    return condensed;
}

function discountedGain(grade: JudgedGrade, rank: number): number {
    return grade / Math.log2(rank + 1);
}

/** Ideal DCG at `cutoff` from every judged grade for the query. */
function idealDcg(judgedGrades: ReadonlyMap<string, JudgedGrade>, cutoff: number): number {
    const grades = [...judgedGrades.values()].sort((a, b) => b - a).slice(0, cutoff);
    return grades.reduce((sum: number, grade, i) => sum + discountedGain(grade, i + 1), 0);
}

/** Score one query under METRIC_POLICY_VERSION. Rejects a ranking whose
 *  physical ranks are not consecutive one-based positions. */
export function computeQueryMetrics(input: QueryScoringInput): QueryMetrics {
    const { resolved, judgedGrades } = input;
    for (const [i, entry] of resolved.entries()) {
        if (entry.rank !== i + 1) {
            throw new MetricError(
                `ranking for ${input.queryId} is not one-based consecutive at position ${i}`,
            );
        }
    }
    const relevantTotal = [...judgedGrades.values()].filter(isRelevantGrade).length;

    const cutoffs: CutoffMetrics[] = METRIC_CUTOFFS.map((cutoff) => {
        const window = resolved.slice(0, cutoff);
        const physical = window.map((entry) => annotate(entry, judgedGrades));
        const condensed = condense(window, judgedGrades);
        const coverage: JudgmentCoverage = {
            judged: 0,
            unjudged: 0,
            unresolved: 0,
            duplicates: 0,
            total: physical.length,
        };
        for (const entry of physical) {
            if (entry.status === "unresolved") coverage.unresolved += 1;
            else if (entry.status === "duplicate") coverage.duplicates += 1;
            else if (entry.judgment.status === "judged") coverage.judged += 1;
            else coverage.unjudged += 1;
        }
        const relevantRetrieved = condensed.filter((entry) => isRelevantGrade(entry.grade)).length;
        return {
            cutoff,
            physical,
            condensed,
            coverage,
            relevantRetrieved,
            relevantTotal,
            recall: relevantTotal === 0 ? null : relevantRetrieved / relevantTotal,
            duplicateRate:
                coverage.total === 0 ? null : coverage.duplicates / coverage.total,
        };
    });

    // First judged relevant occurrence over the FULL resolved list, in both
    // rank views (KTD5 retains both). Duplicates never earn the credit.
    const fullCondensed = condense(resolved, judgedGrades);
    const firstRelevant = fullCondensed.find((entry) => isRelevantGrade(entry.grade)) ?? null;

    const ndcgWindow = cutoffs.find((c) => c.cutoff === NDCG_CUTOFF);
    if (!ndcgWindow) throw new MetricError("missing nDCG cutoff window");
    const idcg = idealDcg(judgedGrades, NDCG_CUTOFF);
    const dcg = ndcgWindow.condensed.reduce(
        (sum, entry) => sum + discountedGain(entry.grade, entry.condensedRank),
        0,
    );

    return {
        metricPolicyVersion: METRIC_POLICY_VERSION,
        queryId: input.queryId,
        cutoffs,
        reciprocalRank: firstRelevant ? 1 / firstRelevant.physicalRank : 0,
        firstRelevantPhysicalRank: firstRelevant?.physicalRank ?? null,
        firstRelevantCondensedRank: firstRelevant?.condensedRank ?? null,
        ndcgAt10: idcg === 0 ? null : dcg / idcg,
    };
}

// ---------------------------------------------------------------------------
// Reranker lift (R51) and context tokens per useful delivered result.
// ---------------------------------------------------------------------------

export type RerankerLift =
    | { status: "not_applicable" }
    | {
          status: "computed";
          ndcgBefore: number | null;
          ndcgAfter: number | null;
          delta: number | null;
      };

/** `not_applicable` until BOTH a before and an after ranking exist; a
 *  computed lift is a same-candidate delta, so differing credited identity
 *  sets reject rather than comparing incomparable rankings. */
export function computeRerankerLift(
    before: readonly ResolvedRankedResult[] | null,
    after: readonly ResolvedRankedResult[] | null,
    judgedGrades: ReadonlyMap<string, JudgedGrade>,
): RerankerLift {
    if (!before || !after) return { status: "not_applicable" };
    const identities = (ranked: readonly ResolvedRankedResult[]): Set<string> => {
        const set = new Set<string>();
        for (const entry of ranked) {
            if (entry.status !== "unresolved") set.add(entry.canonicalId);
        }
        return set;
    };
    const beforeIds = identities(before);
    const afterIds = identities(after);
    if (
        beforeIds.size !== afterIds.size ||
        [...beforeIds].some((id) => !afterIds.has(id))
    ) {
        throw new MetricError("reranker lift requires identical candidate identity sets");
    }
    const score = (ranked: readonly ResolvedRankedResult[]): number | null =>
        computeQueryMetrics({ queryId: "reranker-lift", resolved: ranked, judgedGrades })
            .ndcgAt10;
    const ndcgBefore = score(before);
    const ndcgAfter = score(after);
    return {
        status: "computed",
        ndcgBefore,
        ndcgAfter,
        delta: ndcgBefore === null || ndcgAfter === null ? null : ndcgAfter - ndcgBefore,
    };
}

/** Delivered token cost per useful delivered result: useful = unique judged
 *  relevant identities that survived packing. Zero useful results yields
 *  null, never a division by zero or an implicit infinity (R51). */
export function contextTokensPerUsefulResult(
    deliveredTokens: number,
    delivered: readonly ResolvedRankedResult[],
    judgedGrades: ReadonlyMap<string, JudgedGrade>,
): number | null {
    if (!Number.isFinite(deliveredTokens) || deliveredTokens < 0) {
        throw new MetricError("delivered token count must be a nonnegative finite number");
    }
    let useful = 0;
    for (const entry of delivered) {
        if (entry.status !== "resolved") continue;
        const grade = judgedGrades.get(entry.documentId);
        if (grade !== undefined && isRelevantGrade(grade)) useful += 1;
    }
    return useful === 0 ? null : deliveredTokens / useful;
}

// ---------------------------------------------------------------------------
// Macro aggregation (KTD6, R52): paraphrase group -> partition x mode.
// ---------------------------------------------------------------------------

export type Partition = "development" | "holdout";
export type QueryMode = "explicit" | "automatic";

export interface ScoredQuery {
    queryId: string;
    paraphraseGroup: string;
    partition: Partition;
    mode: QueryMode;
    values: {
        recallAt10: number | null;
        recallAt50: number | null;
        reciprocalRank: number;
        ndcgAt10: number | null;
    };
}

export interface MacroAggregate {
    metricPolicyVersion: typeof METRIC_POLICY_VERSION;
    partition: Partition;
    mode: QueryMode;
    queryCount: number;
    groupCount: number;
    recallAt10: number | null;
    recallAt50: number | null;
    mrr: number | null;
    ndcgAt10: number | null;
}

/** Extract the aggregation-facing values from full query metrics. */
export function scoredQueryValues(metrics: QueryMetrics): ScoredQuery["values"] {
    const at = (cutoff: number): number | null =>
        metrics.cutoffs.find((c) => c.cutoff === cutoff)?.recall ?? null;
    return {
        recallAt10: at(10),
        recallAt50: at(50),
        reciprocalRank: metrics.reciprocalRank,
        ndcgAt10: metrics.ndcgAt10,
    };
}

function meanOrNull(values: readonly (number | null)[]): number | null {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    return present.reduce((sum, value) => sum + value, 0) / present.length;
}

/**
 * Macro-average per (partition, mode): queries average within their
 * paraphrase group first, then groups average with equal weight, so a
 * heavily paraphrased intent cannot overweight its base intent (KTD6).
 * Null query values are excluded, never treated as zero.
 */
export function macroAggregate(queries: readonly ScoredQuery[]): MacroAggregate[] {
    const cells = new Map<string, ScoredQuery[]>();
    for (const query of queries) {
        const key = `${query.partition}\u0000${query.mode}`;
        const cell = cells.get(key);
        if (cell) cell.push(query);
        else cells.set(key, [query]);
    }
    const aggregates: MacroAggregate[] = [];
    for (const cell of cells.values()) {
        const groups = new Map<string, ScoredQuery[]>();
        for (const query of cell) {
            const group = groups.get(query.paraphraseGroup);
            if (group) group.push(query);
            else groups.set(query.paraphraseGroup, [query]);
        }
        const groupMeans = [...groups.values()].map((group) => ({
            recallAt10: meanOrNull(group.map((q) => q.values.recallAt10)),
            recallAt50: meanOrNull(group.map((q) => q.values.recallAt50)),
            mrr: meanOrNull(group.map((q) => q.values.reciprocalRank)),
            ndcgAt10: meanOrNull(group.map((q) => q.values.ndcgAt10)),
        }));
        aggregates.push({
            metricPolicyVersion: METRIC_POLICY_VERSION,
            partition: cell[0].partition,
            mode: cell[0].mode,
            queryCount: cell.length,
            groupCount: groups.size,
            recallAt10: meanOrNull(groupMeans.map((g) => g.recallAt10)),
            recallAt50: meanOrNull(groupMeans.map((g) => g.recallAt50)),
            mrr: meanOrNull(groupMeans.map((g) => g.mrr)),
            ndcgAt10: meanOrNull(groupMeans.map((g) => g.ndcgAt10)),
        });
    }
    return aggregates.sort((a, b) =>
        a.partition === b.partition
            ? a.mode.localeCompare(b.mode)
            : a.partition.localeCompare(b.partition),
    );
}

/** Regression gates consume holdout aggregates only (R52); development
 *  aggregates stay diagnostic. Explicit and automatic remain separate cells. */
export function gateAggregates(aggregates: readonly MacroAggregate[]): MacroAggregate[] {
    return aggregates.filter((aggregate) => aggregate.partition === "holdout");
}
