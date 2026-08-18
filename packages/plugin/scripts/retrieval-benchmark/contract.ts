/**
 * Strict artifact contracts for the judged retrieval corpus (KTD2, R38-R42).
 *
 * Four versioned artifacts — corpus, judgments, synthetic profiles, manifest —
 * each parsed with recursively-strict schemas (unknown fields reject) and
 * diagnostics that carry only JSON paths and codes, never field values.
 */

import { z } from "zod";
import {
    MAX_SEARCH_RESULT_LIMIT,
    prepareExplicitQuery,
} from "../../src/features/magic-context/search-bounds";
import { SOURCE_LOCATOR_KIND } from "../../src/features/magic-context/search-result-locator";
import { normalizeQueryText } from "../../src/features/magic-context/storage-embedding-measurements";
import {
    AUTO_SEARCH_RESULT_LIMIT,
    AUTO_SEARCH_SOURCES,
    extractBoundedAutoSearchQuery,
} from "../../src/hooks/magic-context/auto-search-prompt";
import type { CtxSearchSource } from "../../src/tools/ctx-search/types";
import { canonicalFingerprint } from "./canonical-json";
import { dialectNamespace, relevanceIdentity } from "./identity";

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

/** ctx-search source filter vocabulary. `satisfies` ties this to the tool's
 *  `sources` arg type, so vocabulary drift is a compile error. */
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
    /** null = all enabled sources (the tool's omitted-sources meaning). */
    sourceFilters: z.array(z.enum(SOURCE_FILTERS)).nullable(),
    fixtureScope: scopeSchema,
    visibleState: z.strictObject({
        visibleMemoryIds: z.array(z.number().int().nonnegative()),
        /** Inclusive maximum message ordinal, or null for no cutoff. The
         *  production automatic path searches ALL indexed history (null);
         *  the explicit path always computes a compartment-boundary cutoff
         *  (non-null). parseCorpus enforces the mode pairing. */
        messageOrdinalCutoff: z.number().int().nonnegative().nullable(),
    }),
    referenceTimeMs: z.number().int().nonnegative(),
    partition: z.enum(["development", "holdout"]),
    /** Base-intent group: paraphrases of one intent share this value. */
    paraphraseGroup: z.string().min(1),
    /** Bounded by the production ceiling: unifiedSearch silently clamps to
     *  MAX_SEARCH_RESULT_LIMIT, so a larger declared limit would execute
     *  fewer results than the approved scenario states. */
    resultLimit: z.number().int().positive().max(MAX_SEARCH_RESULT_LIMIT),
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
    /** splitmix32 state is unsigned 32-bit (`seed >>> 0`): a larger seed
     *  would silently collide with its low 32 bits, so the release would
     *  not execute the seed it declares. */
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
    const partitionByNormalizedText = new Map<string, { partition: string; queryId: string }>();
    for (const [i, query] of corpus.queries.entries()) {
        if (queryIds.has(query.id)) diagnostics.push(`corpus.queries[${i}].id: duplicate`);
        queryIds.add(query.id);
        // The same query text in both partitions exposes the holdout intent
        // to development tuning even when the paraphrase groups differ.
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
        // A query production search cannot execute as written is a structural
        // defect, not a ranking signal: explicit mode rejects out-of-bounds
        // queries (QueryBoundsError) and trims whitespace-only ones to no
        // results; automatic mode silently truncates, which would replay a
        // DIFFERENT query than the one that was judged.
        if (query.mode === "explicit") {
            const prepared = prepareExplicitQuery(query.queryText);
            if (!prepared.ok || prepared.query.length === 0) {
                diagnostics.push(`corpus.queries[${i}].queryText: not-executable`);
            }
        } else {
            // The LIVE extractor, not only the bounds preflight: the
            // automatic path strips plugin markup and collapses whitespace,
            // so the approved text must survive that whole pipeline
            // unchanged or production would search a different query.
            const prepared = extractBoundedAutoSearchQuery(query.queryText);
            if (prepared.length === 0 || prepared !== query.queryText.trim()) {
                diagnostics.push(`corpus.queries[${i}].queryText: not-executable`);
            }
            // The production automatic path always searches exactly
            // AUTO_SEARCH_SOURCES; a narrower declared filter would drop
            // competing lanes and inflate the target's rank, a broader or
            // null one would not benchmark automatic behavior at all.
            const declared = [...(query.sourceFilters ?? [])].sort();
            const required = [...AUTO_SEARCH_SOURCES].sort();
            if (
                declared.length !== required.length ||
                declared.some((filter, f) => filter !== required[f])
            ) {
                diagnostics.push(`corpus.queries[${i}].sourceFilters: automatic-mismatch`);
            }
            // The automatic path also fixes its result limit; a different
            // declared cutoff would change recall against production.
            if (query.resultLimit !== AUTO_SEARCH_RESULT_LIMIT) {
                diagnostics.push(`corpus.queries[${i}].resultLimit: automatic-mismatch`);
            }
            // Production automatic search applies NO message cutoff; a
            // bounded replay would drop competing results above it.
            if (query.visibleState.messageOrdinalCutoff !== null) {
                diagnostics.push(
                    `corpus.queries[${i}].visibleState.messageOrdinalCutoff: automatic-mismatch`,
                );
            }
        }
        // The explicit path always computes a compartment-boundary cutoff;
        // an unbounded explicit scenario cannot occur in production.
        if (query.mode === "explicit" && query.visibleState.messageOrdinalCutoff === null) {
            diagnostics.push(
                `corpus.queries[${i}].visibleState.messageOrdinalCutoff: explicit-unbounded`,
            );
        }
    }
    const documentIds = new Set<string>();
    const documentByIdentity = new Map<string, number>();
    for (const [i, doc] of corpus.documents.entries()) {
        if (documentIds.has(doc.id)) diagnostics.push(`corpus.documents[${i}].id: duplicate`);
        documentIds.add(doc.id);
        if (doc.semanticPayload.kind !== doc.kind) {
            diagnostics.push(`corpus.documents[${i}].semanticPayload.kind: mismatch`);
        }
        // Two documents with one semantic payload collapse to one canonical
        // relevance identity: judgments and partition checks keyed by
        // document id would silently disagree with identity-keyed crediting.
        const identity = relevanceIdentity(doc.semanticPayload);
        if (documentByIdentity.has(identity)) {
            diagnostics.push(`corpus.documents[${i}].semanticPayload: duplicate-identity`);
        } else {
            documentByIdentity.set(identity, i);
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
    // Every scale exactly once: a release missing a scale leaves U5 without
    // a descriptor for a required run, and a duplicate makes the run set
    // ambiguous — both despite the release otherwise loading successfully.
    const diagnostics: string[] = [];
    const seen = new Map<number, number>();
    const profileIds = new Set<string>();
    for (const [i, profile] of artifact.profiles.entries()) {
        seen.set(profile.scale, (seen.get(profile.scale) ?? 0) + 1);
        // Synthetic document ids embed the profile id (`syn:<id>:<i>`), so
        // two profiles sharing an id collide across their scale runs.
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
                // Dangling entries get this diagnostic only; keeping them out
                // of the pool set stops the unjudged loop from echoing the
                // unconstrained (non-corpus) id into diagnostics.
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

    // Every corpus document must be judged somewhere: a document absent
    // from every pool would ship (and could be seeded and returned) with no
    // reviewed relevance label for any scenario, silently expanding the
    // benchmark with unreviewed content.
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

    // Diagnostics echo regex-bounded query ids, never the free-form
    // paraphraseGroup value (diagnostics are an output channel too).
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
        // One base intent has one category; a mixed group would count the
        // same intent toward multiple category-coverage cells.
        if (group.categories.size > 1) {
            diagnostics.push(
                `corpus: paraphrase group mixes categories (${group.queryIds.sort().join(", ")})`,
            );
        }
    }

    // A document positively judged from both partitions leaks holdout targets
    // into development tuning. Keyed on the canonical relevance identity so a
    // payload twin under a different document id cannot re-register holdout
    // content in development (parseCorpus rejects twins; this holds even for
    // corpora that bypassed it). Grade-0 occurrences count as exposure too:
    // a holdout target sitting in a development pool as a labeled distractor
    // reveals its exact content and identity to development tuning.
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

    // A positive target that the scenario's own visible state can never
    // return is a structural recall loss, not a ranking signal: message and
    // compartment search treat the cutoff as an inclusive maximum ordinal and
    // ordinals are 1-based, so cutoff 0 excludes every such document. The
    // same holds for source filters (compartment chunks ride the "message"
    // lane; every other kind is its own filter name), for automatic-mode
    // scenarios (the production automatic path queries AUTO_SEARCH_SOURCES
    // only), and for alias scope (resolution tries the scenario's session
    // scope, then the project-only fallback — an alias bound to a different
    // project or session can never resolve).
    const automaticSources: ReadonlySet<string> = new Set(AUTO_SEARCH_SOURCES);
    const documentById = new Map(corpus.documents.map((d) => [d.id, d]));
    // Resolution prefers a session-scoped alias over the project fallback:
    // a project-scoped alias whose (namespace, locator, project) is claimed
    // by ANOTHER document for the scenario's session can never resolve to
    // this document under that scenario.
    // Keys use the resolver's namespace canonicalization: `compartment` and
    // `chunk` are one namespace, so a dialect spelling shadows exactly like
    // the production spelling does.
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
            // Reachability-of-intent checks apply to POSITIVE targets: an
            // unreachable positive is a structural recall loss. Alias scope
            // and producibility below apply to EVERY judged document — a
            // grade-0 distractor with an unresolvable alias would surface as
            // unjudged instead of applying its reviewed grade.
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
                // Project fallback: unreachable when a session-scoped alias
                // of a DIFFERENT document shadows the same key.
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
                // (applies to every judged document, grade 0 included)
                // At least one scoped alias must be producible by the CURRENT
                // search path: production encodes results as
                // SOURCE_LOCATOR_KIND[kind]:<locator>, with numeric ids for
                // memories, compartments, primers, and notes — so a target
                // carrying only migration-dialect or wrong-shape aliases can
                // never resolve. Migration aliases remain valid as
                // ADDITIONAL spellings.
                const producibleNamespace = SOURCE_LOCATOR_KIND[document.kind];
                const numericLocator =
                    document.kind === "memory" ||
                    document.kind === "compartment" ||
                    document.kind === "primer" ||
                    document.kind === "note";
                // Canonical decimal AND exactly representable: production
                // interpolates the numeric id through a JS number, so
                // `memory:042` and `memory:9007199254740993` (above
                // MAX_SAFE_INTEGER, rounds on read) can never byte-match an
                // emitted locator. Number->String round-trip covers both.
                const producible = reachableAliases.filter(
                    (alias) =>
                        alias.namespace === producibleNamespace &&
                        (!numericLocator ||
                            (/^\d+$/.test(alias.locator) &&
                                String(Number(alias.locator)) === alias.locator)),
                );
                if (producible.length === 0) {
                    diagnostics.push(
                        `corpus: target has no production-producible alias (${queryId}, ${documentId})`,
                    );
                }
                // Production memory search hard-filters every id in
                // visibleMemoryIds; a memory target whose PRODUCIBLE aliases
                // are all hidden is unretrievable even when a migration
                // spelling survives, because production cannot emit it.
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
