/**
 * Strict artifact contracts for the judged retrieval corpus (KTD2, R38-R42).
 *
 * Four versioned artifacts — corpus, judgments, synthetic profiles, manifest —
 * each parsed with recursively-strict schemas (unknown fields reject) and
 * diagnostics that carry only JSON paths and codes, never field values.
 */

import { z } from "zod";
import { canonicalFingerprint } from "./canonical-json";

export const CORPUS_SCHEMA_VERSION = "retrieval-benchmark-corpus/v1";
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

/** ctx-search source filter vocabulary (mirrors the tool's `sources` arg). */
export const SOURCE_FILTERS = ["memory", "message", "git_commit", "primer", "note"] as const;

const scopeSchema = z.strictObject({
    projectScope: z.string().min(1),
    sessionScope: z.string().min(1).nullable(),
});
export type FixtureScope = z.infer<typeof scopeSchema>;

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
    /** null = all enabled sources (the tool's omitted-sources meaning). */
    sourceFilters: z.array(z.enum(SOURCE_FILTERS)).nullable(),
    fixtureScope: scopeSchema,
    visibleState: z.strictObject({
        visibleMemoryIds: z.array(z.number().int().nonnegative()),
        messageOrdinalCutoff: z.number().int().nonnegative(),
    }),
    referenceTimeMs: z.number().int().nonnegative(),
    partition: z.enum(["development", "holdout"]),
    /** Base-intent group: paraphrases of one intent share this value. */
    paraphraseGroup: z.string().min(1),
    resultLimit: z.number().int().positive(),
    provenance: z.strictObject({
        origin: z.enum(["recovered", "curated"]),
    }),
});
export type QueryScenario = z.infer<typeof querySchema>;

const documentSchema = z.strictObject({
    id: z.string().regex(/^d-[a-z0-9-]+$/),
    kind: z.enum(DOCUMENT_KINDS),
    /** Immutable semantic content; the canonical relevance identity hashes
     *  a versioned projection of exactly this value. */
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
    seed: z.number().int().nonnegative(),
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
    /** canonicalFingerprint of the manifest's releaseTuple. */
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

/** Path + code only — never the offending value (privacy: diagnostics are an
 *  output channel too). */
function formatIssues(artifact: string, error: z.ZodError): string[] {
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
    for (const [i, query] of corpus.queries.entries()) {
        if (queryIds.has(query.id)) diagnostics.push(`corpus.queries[${i}].id: duplicate`);
        queryIds.add(query.id);
    }
    const documentIds = new Set<string>();
    for (const [i, doc] of corpus.documents.entries()) {
        if (documentIds.has(doc.id)) diagnostics.push(`corpus.documents[${i}].id: duplicate`);
        documentIds.add(doc.id);
        if (doc.semanticPayload.kind !== doc.kind) {
            diagnostics.push(`corpus.documents[${i}].semanticPayload.kind: mismatch`);
        }
    }
    if (diagnostics.length > 0) throw new ContractError(diagnostics.sort());
    return corpus;
}

export function parseJudgments(value: unknown): JudgmentsArtifact {
    return parseArtifact(judgmentsSchema, "judgments", value);
}

export function parseSyntheticProfiles(value: unknown): SyntheticProfilesArtifact {
    return parseArtifact(syntheticProfilesSchema, "syntheticProfiles", value);
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
 * Cross-artifact referential and partition validation (R39-R40):
 * dangling references, unjudged pooled pairs, judgments outside their pool,
 * missing positive judgments, cross-partition paraphrase groups or target
 * documents, and category coverage across both partitions.
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
                diagnostics.push(`judgments.pools[${i}].documentIds[${j}]: dangling`);
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

    const groupPartitions = new Map<string, Set<string>>();
    for (const query of corpus.queries) {
        let partitions = groupPartitions.get(query.paraphraseGroup);
        if (!partitions) {
            partitions = new Set();
            groupPartitions.set(query.paraphraseGroup, partitions);
        }
        partitions.add(query.partition);
    }
    for (const [group, partitions] of groupPartitions) {
        if (partitions.size > 1) {
            diagnostics.push(`corpus: paraphrase group crosses partitions (${group})`);
        }
    }

    // A document positively judged from both partitions leaks holdout targets
    // into development tuning.
    const docPartitions = new Map<string, Set<string>>();
    for (const [queryId, byDoc] of judged) {
        const query = queryById.get(queryId);
        if (!query) continue;
        for (const [documentId, judgment] of byDoc) {
            if (judgment.grade === 0) continue;
            let partitions = docPartitions.get(documentId);
            if (!partitions) {
                partitions = new Set();
                docPartitions.set(documentId, partitions);
            }
            partitions.add(query.partition);
        }
    }
    for (const [documentId, partitions] of docPartitions) {
        if (partitions.size > 1) {
            diagnostics.push(`judgments: target document crosses partitions (${documentId})`);
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
