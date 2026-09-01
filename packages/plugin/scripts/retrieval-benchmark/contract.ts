/**
 *
 * Schemas reject unknown fields recursively.
 * Diagnostics expose only JSON paths and codes, never field values.
 */

import { z } from "zod";
import {
    MAX_SEARCH_RESULT_LIMIT,
    prepareExplicitQuery,
} from "../../src/features/magic-context/search-bounds";
import { SOURCE_LOCATOR_KIND } from "./physical-locator";
import { normalizeMemoryContent } from "../../src/features/magic-context/memory/normalize-hash";
import { normalizeQueryText } from "../../src/features/magic-context/query-normalization";
import { parseIdShapedQuery } from "../../src/features/magic-context/search-bounds";
import {
    AUTO_SEARCH_RESULT_LIMIT,
    AUTO_SEARCH_SOURCES,
    extractBoundedAutoSearchQuery,
} from "../../src/hooks/magic-context/auto-search-prompt";
import type { CtxSearchSource } from "../../src/tools/ctx-search/types";
import { canonicalFingerprint } from "./canonical-json";
import { dialectNamespace, relevanceIdentity } from "./identity";

export const CORPUS_SCHEMA_VERSION = "retrieval-benchmark-corpus/v1";

/**
 *  on producibility. */
export function isProducibleNumericLocator(locator: string): boolean {
    const numeric = Number(locator);
    return (
        /^[1-9]\d*$/.test(locator) &&
        Number.isSafeInteger(numeric) &&
        String(numeric) === locator
    );
}
export const JUDGMENTS_SCHEMA_VERSION = "retrieval-benchmark-judgments/v1";
export const SYNTHETIC_SCHEMA_VERSION = "retrieval-benchmark-synthetic/v1";
export const MANIFEST_SCHEMA_VERSION = "retrieval-benchmark-manifest/v1";
export const RUBRIC_VERSION = "graded-pooled/v1";

export const QUERY_CATEGORIES = [
    "exact-symbol-path",
    "error-message",
    "architecture-rationale",
    "debugging-history",
    "user-directive",
    "current-constraint",
    "benchmark-result",
    "temporal",
    "contradictory-memory",
    "paraphrased-decision",
] as const;
export type QueryCategory = (typeof QUERY_CATEGORIES)[number];

export const DOCUMENT_KINDS = [
    "memory",
    "message",
    "compartment",
    "git_commit",
    "primer",
    "note",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * */
export const SOURCE_FILTERS = [
    "memory",
    "message",
    "git_commit",
    "primer",
    "note",
] as const satisfies readonly CtxSearchSource[];

const scopeSchema = z.strictObject({
    projectScope: z.string().min(1),
    sessionScope: z.string().min(1).nullable(),
});

const aliasSchema = z.strictObject({
    namespace: z.string().min(1),
    locator: z.string().min(1),
    projectScope: z.string().min(1),
    sessionScope: z.string().min(1).nullable(),
});
export type StructuredAlias = z.infer<typeof aliasSchema>;

const querySchema = z.strictObject({
    id: z.string().regex(/^q-[a-z0-9-]+$/),
    category: z.enum(QUERY_CATEGORIES),
    mode: z.enum(["explicit", "automatic"]),
    queryText: z.string().min(1),
    /** A null `sourceFilters` value selects all enabled sources, matching the tool's omitted-sources behavior. */
    sourceFilters: z.array(z.enum(SOURCE_FILTERS)).nullable(),
    fixtureScope: scopeSchema,
    visibleState: z.strictObject({
        visibleMemoryIds: z.array(z.number().int().nonnegative()),
        /** The message ordinal cutoff is inclusive; null disables the cutoff.
         *  production automatic path searches ALL indexed history (null);
         *  the explicit path always computes a compartment-boundary cutoff
         * parseCorpus requires a non-null compartment-boundary cutoff in explicit mode. */
        messageOrdinalCutoff: z.number().int().nonnegative().nullable(),
    }),
    referenceTimeMs: z.number().int().nonnegative(),
    partition: z.enum(["development", "holdout"]),
    /** Paraphrases of one intent share a base-intent group. */
    paraphraseGroup: z.string().min(1),
    /** Declared limits cannot exceed MAX_SEARCH_RESULT_LIMIT because unifiedSearch clamps larger values.
     * A declared limit above MAX_SEARCH_RESULT_LIMIT executes fewer results than the scenario declares.
     * */
    resultLimit: z.number().int().positive().max(MAX_SEARCH_RESULT_LIMIT),
    provenance: z.strictObject({
        origin: z.enum(["recovered", "curated"]),
    }),
});
export type QueryScenario = z.infer<typeof querySchema>;

const documentSchema = z.strictObject({
    id: z.string().regex(/^d-[a-z0-9-]+$/),
    kind: z.enum(DOCUMENT_KINDS),
    /** The canonical relevance identity hashes a versioned projection of the immutable semantic content.
     * */
    semanticPayload: z.strictObject({
        kind: z.enum(DOCUMENT_KINDS),
        title: z.string(),
        body: z.string().min(1),
    }),
    aliases: z.array(aliasSchema).min(1),
});
export type CorpusDocument = z.infer<typeof documentSchema>;

const corpusSchema = z.strictObject({
    schemaVersion: z.literal(CORPUS_SCHEMA_VERSION),
    queries: z.array(querySchema).min(1),
    documents: z.array(documentSchema).min(1),
});
export type CorpusArtifact = z.infer<typeof corpusSchema>;

const judgmentSchema = z.strictObject({
    queryId: z.string().min(1),
    documentId: z.string().min(1),
    grade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    provenance: z.strictObject({
        judge: z.literal("human"),
        pooledFrom: z.array(z.enum(["primary", "shadow", "manual"])).min(1),
    }),
});
export type Judgment = z.infer<typeof judgmentSchema>;

const judgmentsSchema = z.strictObject({
    schemaVersion: z.literal(JUDGMENTS_SCHEMA_VERSION),
    rubricVersion: z.literal(RUBRIC_VERSION),
    pools: z.array(
        z.strictObject({
            queryId: z.string().min(1),
            documentIds: z.array(z.string().min(1)).min(1),
        }),
    ),
    judgments: z.array(judgmentSchema).min(1),
});
export type JudgmentsArtifact = z.infer<typeof judgmentsSchema>;

export const SYNTHETIC_SCALES = [1_000, 10_000, 100_000, 1_000_000] as const;

const syntheticProfileSchema = z.strictObject({
    id: z.string().regex(/^syn-[a-z0-9-]+$/),
    generatorVersion: z.string().min(1),
    prng: z.literal("splitmix32"),
    /** splitmix32 retains only the low 32 bits of `seed` through `seed >>> 0`.
     * Seeds must fit unsigned 32 bits; larger seeds collide with their low 32 bits.
     * */
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    scale: z.union([
        z.literal(SYNTHETIC_SCALES[0]),
        z.literal(SYNTHETIC_SCALES[1]),
        z.literal(SYNTHETIC_SCALES[2]),
        z.literal(SYNTHETIC_SCALES[3]),
    ]),
    sourceDistribution: z.partialRecord(z.enum(DOCUMENT_KINDS), z.number().positive()),
    textSize: z.strictObject({
        minWords: z.number().int().positive(),
        maxWords: z.number().int().positive(),
    }),
});
export type SyntheticProfile = z.infer<typeof syntheticProfileSchema>;

const syntheticProfilesSchema = z.strictObject({
    schemaVersion: z.literal(SYNTHETIC_SCHEMA_VERSION),
    profiles: z.array(syntheticProfileSchema).min(1),
});
export type SyntheticProfilesArtifact = z.infer<typeof syntheticProfilesSchema>;

const releaseTupleSchema = z.strictObject({
    corpusFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    judgmentsFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    syntheticProfilesFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    corpusSchemaVersion: z.literal(CORPUS_SCHEMA_VERSION),
    judgmentsSchemaVersion: z.literal(JUDGMENTS_SCHEMA_VERSION),
    syntheticSchemaVersion: z.literal(SYNTHETIC_SCHEMA_VERSION),
    rubricVersion: z.literal(RUBRIC_VERSION),
    privacyPolicyVersion: z.string().min(1),
    sanitizerVersion: z.string().min(1),
});
export type ReleaseTuple = z.infer<typeof releaseTupleSchema>;

const approvalSchema = z.strictObject({
    kind: z.enum(["privacy", "relevance-intent"]),
    approver: z.string().min(1),
    /* */
    releaseTupleFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Approval = z.infer<typeof approvalSchema>;

const manifestSchema = z.strictObject({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    releaseVersion: z.string().regex(/^v\d+$/),
    releaseTuple: releaseTupleSchema,
    approvals: z.strictObject({
        privacy: approvalSchema,
        relevanceIntent: approvalSchema,
    }),
});
export type ManifestArtifact = z.infer<typeof manifestSchema>;

export class ContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: string[]) {
        super(diagnostics.join("; "));
        this.diagnostics = diagnostics;
    }
}

/**
 * */
export function formatIssues(artifact: string, error: z.ZodError): string[] {
    return error.issues
        .map((issue) => `${artifact}.${issue.path.join(".")}: ${issue.code}`)
        .sort();
}

function parseArtifact<T>(schema: z.ZodType<T>, artifact: string, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ContractError(formatIssues(artifact, parsed.error));
    return parsed.data;
}

export function parseCorpus(value: unknown): CorpusArtifact {
    const corpus = parseArtifact(corpusSchema, "corpus", value);
    const diagnostics: string[] = [];
    const queryIds = new Set<string>();
    const partitionByNormalizedText = new Map<string, { partition: string; queryId: string }>();
    for (const [i, query] of corpus.queries.entries()) {
        if (queryIds.has(query.id)) diagnostics.push(`corpus.queries[${i}].id: duplicate`);
        queryIds.add(query.id);
        // The same query text must not appear in both partitions because it exposes the holdout intent.
        // Cross-partition duplicate text exposes holdout queries to development tuning.
        const normalized = normalizeQueryText(query.queryText);
        const existing = partitionByNormalizedText.get(normalized);
        if (existing && existing.partition !== query.partition) {
            diagnostics.push(
                `corpus: query text reused across partitions (${[existing.queryId, query.id]
                    .sort()
                    .join(", ")})`,
            );
        } else if (!existing) {
            partitionByNormalizedText.set(normalized, {
                partition: query.partition,
                queryId: query.id,
            });
        }
        // The benchmark treats queries that production cannot execute as structural defects, not ranking signals.
        // Explicit mode rejects out-of-bounds queries.
        // Explicit mode returns no results for whitespace-only queries.
        // Automatic mode silently truncates queries.
        // Truncation replays a query different from the judged query.
        if (query.mode === "explicit") {
            const prepared = prepareExplicitQuery(query.queryText);
            if (!prepared.ok || prepared.query.length === 0) {
                diagnostics.push(`corpus.queries[${i}].queryText: not-executable`);
            }
            // Production explicit search routes ID-shaped queries to direct lookup.
            // ID-shaped queries such as `9101` and `#9101` never reach unified retrieval.
            // Benchmarking ID-shaped queries through `unifiedSearch` reports misses that production answers.
            if (parseIdShapedQuery(query.queryText) !== null) {
                diagnostics.push(`corpus.queries[${i}].queryText: id-shaped-bypasses-retrieval`);
            }
        } else {
            // The live extractor must validate automatic queries, not only the bounds preflight.
            // The automatic path strips plugin markup and collapses whitespace.
            // Approved text must survive the automatic pipeline unchanged.
            // Changing approved text makes production search a different query.
            const prepared = extractBoundedAutoSearchQuery(query.queryText);
            if (prepared.length === 0 || prepared !== query.queryText.trim()) {
                diagnostics.push(`corpus.queries[${i}].queryText: not-executable`);
            }
            // The production automatic path always uses exactly `AUTO_SEARCH_SOURCES`.
            // A narrower declared filter drops competing lanes and inflates the target's rank.
            // A broader or null declared filter does not benchmark automatic behavior.
            const declared = [...(query.sourceFilters ?? [])].sort();
            const required = [...AUTO_SEARCH_SOURCES].sort();
            if (
                declared.length !== required.length ||
                declared.some((filter, f) => filter !== required[f])
            ) {
                diagnostics.push(`corpus.queries[${i}].sourceFilters: automatic-mismatch`);
            }
            // The automatic path uses `AUTO_SEARCH_RESULT_LIMIT`.
            // A declared result limit changes recall relative to production.
            if (query.resultLimit !== AUTO_SEARCH_RESULT_LIMIT) {
                diagnostics.push(`corpus.queries[${i}].resultLimit: automatic-mismatch`);
            }
            // Production automatic search applies no message cutoff.
            // A bounded replay drops competing results above the message cutoff.
            if (query.visibleState.messageOrdinalCutoff !== null) {
                diagnostics.push(
                    `corpus.queries[${i}].visibleState.messageOrdinalCutoff: automatic-mismatch`,
                );
            }
        }
        // The explicit path always computes a compartment-boundary cutoff.
        // an unbounded explicit scenario cannot occur in production.
        if (query.mode === "explicit" && query.visibleState.messageOrdinalCutoff === null) {
            diagnostics.push(
                `corpus.queries[${i}].visibleState.messageOrdinalCutoff: explicit-unbounded`,
            );
        }
    }
    const documentIds = new Set<string>();
    const documentByIdentity = new Map<string, number>();
    const memoryByNormalizedContent = new Map<string, number>();
    for (const [i, doc] of corpus.documents.entries()) {
        if (documentIds.has(doc.id)) diagnostics.push(`corpus.documents[${i}].id: duplicate`);
        documentIds.add(doc.id);
        if (doc.semanticPayload.kind !== doc.kind) {
            diagnostics.push(`corpus.documents[${i}].semanticPayload.kind: mismatch`);
        }
        // Documents with one semantic payload share one canonical relevance identity.
        // Document-ID-keyed judgments and partition checks disagree with identity-keyed crediting.
        const identity = relevanceIdentity(doc.semanticPayload);
        if (documentByIdentity.has(identity)) {
            diagnostics.push(`corpus.documents[${i}].semanticPayload: duplicate-identity`);
        } else {
            documentByIdentity.set(identity, i);
        }
        // `memories` enforces `UNIQUE(project_path, category, normalized_hash)`.
        // Reviewed memories seed under one category.
        // Normalization collapses case and whitespace.
        // Documents that pass exact-byte identity checks can still collide at insert time.
        // SQLite then raises a raw constraint error.
        // The validator rejects normalized-content collisions before SQLite raises a raw constraint error.
        if (doc.kind === "memory") {
            const normalized = normalizeMemoryContent(
                `${doc.semanticPayload.title} ${doc.semanticPayload.body}`,
            );
            for (const alias of doc.aliases) {
                // Only production-producible memory aliases insert rows;
                // evaluation-only namespaces never reach the table.
                if (alias.namespace !== SOURCE_LOCATOR_KIND.memory) continue;
                const key = `${alias.projectScope}\u0000${normalized}`;
                if (memoryByNormalizedContent.has(key)) {
                    diagnostics.push(
                        `corpus.documents[${i}].semanticPayload: duplicate-normalized-memory-content`,
                    );
                } else {
                    memoryByNormalizedContent.set(key, i);
                }
            }
        }
    }
    if (diagnostics.length > 0) throw new ContractError(diagnostics.sort());
    return corpus;
}

export function parseJudgments(value: unknown): JudgmentsArtifact {
    return parseArtifact(judgmentsSchema, "judgments", value);
}

export function parseSyntheticProfiles(value: unknown): SyntheticProfilesArtifact {
    const artifact = parseArtifact(syntheticProfilesSchema, "syntheticProfiles", value);
    // Each scale must appear exactly once; a missing scale leaves U5 without a descriptor for a required run, and duplicates make the run set ambiguous.
    const diagnostics: string[] = [];
    const seen = new Map<number, number>();
    const profileIds = new Set<string>();
    for (const [i, profile] of artifact.profiles.entries()) {
        seen.set(profile.scale, (seen.get(profile.scale) ?? 0) + 1);
        // Synthetic document IDs embed profile IDs, so duplicate profile IDs collide across scale runs.
        if (profileIds.has(profile.id)) {
            diagnostics.push(`syntheticProfiles.profiles[${i}].id: duplicate`);
        }
        profileIds.add(profile.id);
    }
    for (const scale of SYNTHETIC_SCALES) {
        const count = seen.get(scale) ?? 0;
        if (count === 0) diagnostics.push(`syntheticProfiles.profiles: missing scale ${scale}`);
        if (count > 1) diagnostics.push(`syntheticProfiles.profiles: duplicate scale ${scale}`);
    }
    if (diagnostics.length > 0) throw new ContractError(diagnostics.sort());
    return artifact;
}

export function parseManifest(value: unknown): ManifestArtifact {
    const manifest = parseArtifact(manifestSchema, "manifest", value);
    const diagnostics: string[] = [];
    const tupleFingerprint = canonicalFingerprint(manifest.releaseTuple);
    for (const [name, approval] of [
        ["privacy", manifest.approvals.privacy],
        ["relevanceIntent", manifest.approvals.relevanceIntent],
    ] as const) {
        if (approval.releaseTupleFingerprint !== tupleFingerprint) {
            diagnostics.push(`manifest.approvals.${name}.releaseTupleFingerprint: stale`);
        }
    }
    if (manifest.approvals.privacy.kind !== "privacy") {
        diagnostics.push("manifest.approvals.privacy.kind: wrong-kind");
    }
    if (manifest.approvals.relevanceIntent.kind !== "relevance-intent") {
        diagnostics.push("manifest.approvals.relevanceIntent.kind: wrong-kind");
    }
    if (diagnostics.length > 0) throw new ContractError(diagnostics.sort());
    return manifest;
}

/**
 */
export function validateRelease(corpus: CorpusArtifact, judgments: JudgmentsArtifact): void {
    const diagnostics: string[] = [];
    const queryById = new Map(corpus.queries.map((q) => [q.id, q]));
    const documentIds = new Set(corpus.documents.map((d) => d.id));

    const pooled = new Map<string, Set<string>>();
    for (const [i, pool] of judgments.pools.entries()) {
        if (!queryById.has(pool.queryId)) {
            diagnostics.push(`judgments.pools[${i}].queryId: dangling`);
            continue;
        }
        if (pooled.has(pool.queryId)) diagnostics.push(`judgments.pools[${i}].queryId: duplicate`);
        const ids = new Set<string>();
        for (const [j, documentId] of pool.documentIds.entries()) {
            if (!documentIds.has(documentId)) {
                // Excluding dangling entries from the pool set prevents the unjudged loop from reporting non-corpus IDs.
                diagnostics.push(`judgments.pools[${i}].documentIds[${j}]: dangling`);
                continue;
            }
            ids.add(documentId);
        }
        pooled.set(pool.queryId, ids);
    }

    const judged = new Map<string, Map<string, Judgment>>();
    for (const [i, judgment] of judgments.judgments.entries()) {
        if (!queryById.has(judgment.queryId)) {
            diagnostics.push(`judgments.judgments[${i}].queryId: dangling`);
            continue;
        }
        if (!documentIds.has(judgment.documentId)) {
            diagnostics.push(`judgments.judgments[${i}].documentId: dangling`);
            continue;
        }
        const pool = pooled.get(judgment.queryId);
        if (!pool || !pool.has(judgment.documentId)) {
            diagnostics.push(`judgments.judgments[${i}]: outside-pool`);
        }
        let byDoc = judged.get(judgment.queryId);
        if (!byDoc) {
            byDoc = new Map();
            judged.set(judgment.queryId, byDoc);
        }
        if (byDoc.has(judgment.documentId)) {
            diagnostics.push(`judgments.judgments[${i}]: duplicate-pair`);
        }
        byDoc.set(judgment.documentId, judgment);
    }

    // Every corpus document must appear in a pool; otherwise seeded content can ship without a reviewed relevance label.
    const pooledDocuments = new Set<string>();
    for (const pool of pooled.values()) {
        for (const documentId of pool) pooledDocuments.add(documentId);
    }
    for (const document of corpus.documents) {
        if (!pooledDocuments.has(document.id)) {
            diagnostics.push(`corpus: document absent from every pool (${document.id})`);
        }
    }

    for (const query of corpus.queries) {
        const pool = pooled.get(query.id);
        if (!pool) {
            diagnostics.push(`judgments.pools: missing pool for ${query.id}`);
            continue;
        }
        const byDoc = judged.get(query.id);
        for (const documentId of pool) {
            if (!byDoc?.has(documentId)) {
                diagnostics.push(`judgments: pooled pair unjudged (${query.id}, ${documentId})`);
            }
        }
        const hasPositive = [...(byDoc?.values() ?? [])].some((j) => j.grade > 0);
        if (!hasPositive) diagnostics.push(`judgments: no positive judgment for ${query.id}`);
    }

    // Diagnostics echo regex-bounded query IDs, never free-form paraphraseGroup values, because diagnostics are an output channel.
    const groupPartitions = new Map<
        string,
        { partitions: Set<string>; categories: Set<string>; queryIds: string[] }
    >();
    for (const query of corpus.queries) {
        let group = groupPartitions.get(query.paraphraseGroup);
        if (!group) {
            group = { partitions: new Set(), categories: new Set(), queryIds: [] };
            groupPartitions.set(query.paraphraseGroup, group);
        }
        group.partitions.add(query.partition);
        group.categories.add(query.category);
        group.queryIds.push(query.id);
    }
    for (const group of groupPartitions.values()) {
        if (group.partitions.size > 1) {
            diagnostics.push(
                `corpus: paraphrase group crosses partitions (${group.queryIds.sort().join(", ")})`,
            );
        }
        // Each base intent must have one category; mixed groups count one intent toward multiple category-coverage cells.
        if (group.categories.size > 1) {
            diagnostics.push(
                `corpus: paraphrase group mixes categories (${group.queryIds.sort().join(", ")})`,
            );
        }
    }

    // A document with positive judgments in both partitions exposes holdout targets to development tuning; canonical relevance identity prevents payload twins under different IDs from bypassing this check.
    // The canonical relevance-identity key detects payload twins under different document IDs.
    // Grade-0 occurrences count as exposure because a holdout target in a development pool reveals its exact content and identity.
    const identityByDocument = new Map(
        corpus.documents.map((d) => [d.id, relevanceIdentity(d.semanticPayload)]),
    );
    const identityPartitions = new Map<
        string,
        { positive: Set<string>; judged: Set<string>; documentIds: Set<string> }
    >();
    for (const [queryId, byDoc] of judged) {
        const query = queryById.get(queryId);
        if (!query) continue;
        for (const [documentId, judgment] of byDoc) {
            const identity = identityByDocument.get(documentId);
            if (!identity) continue;
            let entry = identityPartitions.get(identity);
            if (!entry) {
                entry = { positive: new Set(), judged: new Set(), documentIds: new Set() };
                identityPartitions.set(identity, entry);
            }
            entry.judged.add(query.partition);
            if (judgment.grade > 0) {
                entry.positive.add(query.partition);
                entry.documentIds.add(documentId);
            }
        }
    }
    for (const entry of identityPartitions.values()) {
        if (entry.positive.size > 1) {
            diagnostics.push(
                `judgments: target document crosses partitions (${[...entry.documentIds]
                    .sort()
                    .join(", ")})`,
            );
        } else if (entry.positive.size === 1 && entry.judged.size > 1) {
            diagnostics.push(
                `judgments: positive target pooled in opposite partition (${[
                    ...entry.documentIds,
                ]
                    .sort()
                    .join(", ")})`,
            );
        }
    }

    // A positive target unavailable through the scenario's visible state is a structural recall loss, not a ranking signal.
    // Message and compartment searches use an inclusive, 1-based ordinal cutoff.
    // A cutoff of 0 excludes every message and compartment document.
    // Compartment chunks use the `message` source filter; every other kind uses its kind name.
    // Alias resolution falls back from the scenario session scope to the project-only scope.
    // An alias bound to another project or session cannot resolve.
    const automaticSources: ReadonlySet<string> = new Set(AUTO_SEARCH_SOURCES);
    const documentById = new Map(corpus.documents.map((d) => [d.id, d]));
    // Session-scoped aliases take precedence over project-scoped aliases.
    // A session-scoped alias for another document shadows a project-scoped alias with the same namespace, locator, and project.
    // The shadowed project-scoped alias cannot resolve to its document in that scenario.
    // `compartment` and `chunk` share an alias namespace.
    // `compartment` and `chunk` aliases shadow each other.
    const aliasOwner = new Map<string, string>();
    for (const doc of corpus.documents) {
        for (const alias of doc.aliases) {
            aliasOwner.set(
                JSON.stringify([
                    dialectNamespace(alias.namespace) ?? alias.namespace,
                    alias.locator,
                    alias.projectScope,
                    alias.sessionScope,
                ]),
                doc.id,
            );
        }
    }
    for (const [queryId, byDoc] of judged) {
        const query = queryById.get(queryId);
        if (!query) continue;
        for (const [documentId, judgment] of byDoc) {
            const document = documentById.get(documentId);
            if (!document) continue;
            const kind = document.kind;
            const laneFilter = kind === "compartment" ? "message" : kind;
            // An unreachable positive is a structural recall loss.
            // An unresolvable grade-0 distractor is unjudged instead of receiving its reviewed grade.
            if (judgment.grade > 0) {
                if (
                    query.visibleState.messageOrdinalCutoff === 0 &&
                    (kind === "message" || kind === "compartment")
                ) {
                    diagnostics.push(
                        `corpus: target unreachable under zero message cutoff (${queryId}, ${documentId})`,
                    );
                }
                if (query.sourceFilters !== null && !query.sourceFilters.includes(laneFilter)) {
                    diagnostics.push(
                        `corpus: target excluded by source filters (${queryId}, ${documentId})`,
                    );
                }
                if (query.mode === "automatic" && !automaticSources.has(laneFilter)) {
                    diagnostics.push(
                        `corpus: target outside automatic search sources (${queryId}, ${documentId})`,
                    );
                }
            }
            const scope = query.fixtureScope;
            const reachableAliases = document.aliases.filter((alias) => {
                if (alias.projectScope !== scope.projectScope) return false;
                if (alias.sessionScope !== null) {
                    return alias.sessionScope === scope.sessionScope;
                }
                if (scope.sessionScope !== null) {
                    const shadowOwner = aliasOwner.get(
                        JSON.stringify([
                            dialectNamespace(alias.namespace) ?? alias.namespace,
                            alias.locator,
                            alias.projectScope,
                            scope.sessionScope,
                        ]),
                    );
                    if (shadowOwner !== undefined && shadowOwner !== documentId) return false;
                }
                return true;
            });
            if (reachableAliases.length === 0) {
                diagnostics.push(
                    `corpus: target has no alias in scenario scope (${queryId}, ${documentId})`,
                );
            } else {
                // At least one scoped alias must match an identifier the active search path can produce.
                // Production encodes results as `SOURCE_LOCATOR_KIND[kind]:<locator>`.
                // Memories, compartments, primers, and notes require numeric locators.
                // A target with only migration-dialect or wrong-shape aliases cannot resolve.
                // ADDITIONAL spellings.
                const producibleNamespace = SOURCE_LOCATOR_KIND[document.kind];
                const numericLocator =
                    document.kind === "memory" ||
                    document.kind === "compartment" ||
                    document.kind === "primer" ||
                    document.kind === "note";
                const producible = reachableAliases.filter(
                    (alias) =>
                        alias.namespace === producibleNamespace &&
                        (!numericLocator || isProducibleNumericLocator(alias.locator)),
                );
                if (producible.length === 0) {
                    diagnostics.push(
                        `corpus: target has no production-producible alias (${queryId}, ${documentId})`,
                    );
                }
                // Memory search returns only IDs in `visibleMemoryIds`.
                // A memory target whose producible aliases are all hidden is unretrievable.
                const visible = new Set(query.visibleState.visibleMemoryIds.map(String));
                const allHidden =
                    judgment.grade > 0 &&
                    document.kind === "memory" &&
                    producible.length > 0 &&
                    producible.every((alias) => visible.has(alias.locator));
                if (allHidden) {
                    diagnostics.push(
                        `corpus: target hidden by visible memories (${queryId}, ${documentId})`,
                    );
                }
            }
        }
    }

    for (const category of QUERY_CATEGORIES) {
        for (const partition of ["development", "holdout"] as const) {
            const groups = new Set(
                corpus.queries
                    .filter((q) => q.category === category && q.partition === partition)
                    .map((q) => q.paraphraseGroup),
            );
            if (groups.size === 0) {
                diagnostics.push(`corpus: no ${partition} base intent for ${category}`);
            }
        }
    }

    if (diagnostics.length > 0) throw new ContractError(diagnostics.sort());
}
