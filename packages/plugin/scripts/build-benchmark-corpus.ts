#!/usr/bin/env bun
/**
 * Author, build, and check the judged retrieval-benchmark release.
 *
 * The authored artifact content below is the reviewed source of truth for
 * the checked-in `scripts/fixtures/retrieval-benchmark/` release. Commands:
 * `fingerprint`, `build`, and `check <manifest.json>`.
 *
 * The builder is DB-free and cannot recover queries or mint approvals; the
 * approval records below bind one exact release tuple, and any content or
 * policy edit makes promotion fail until new operator approvals are recorded.
 */

import { dirname, resolve } from "node:path";

import {
    type CorpusArtifact,
    CORPUS_SCHEMA_VERSION,
    type CorpusDocument,
    type DocumentKind,
    JUDGMENTS_SCHEMA_VERSION,
    type JudgmentsArtifact,
    QUERY_CATEGORIES,
    type QueryCategory,
    type QueryScenario,
    RUBRIC_VERSION,
    SYNTHETIC_SCHEMA_VERSION,
    type SyntheticProfilesArtifact,
    canonicalFingerprint,
    loadReviewedRelease,
} from "./retrieval-benchmark/index";
import { buildReleaseTuple, promoteRelease } from "./retrieval-benchmark/promote";
import { SYNTHETIC_GENERATOR_VERSION } from "./retrieval-benchmark/synthetic";

export const FIXTURE_PROJECT_SCOPE = "git:benchmark-fixture-project";
export const RELEASES_ROOT = resolve(import.meta.dir, "fixtures", "retrieval-benchmark");
export const RELEASE_VERSION = "v1";

interface AuthoredEntry {
    category: QueryCategory;
    partition: "development" | "holdout";
    slug: string;
    queryText: string;
    /** Extra queries in the same paraphrase group targeting the same document. */
    paraphrases?: string[];
    mode: "explicit" | "automatic";
    sourceFilters: QueryScenario["sourceFilters"];
    docKind: DocumentKind;
    docLocator: string;
    docTitle: string;
    docBody: string;
    /** Additional structured aliases for the target document. */
    extraAliases?: Array<{ namespace: string; locator: string }>;
    /** Pooled grade-0 distractor document, when present. */
    distractor?: { kind: DocumentKind; locator: string; title: string; body: string };
}

const AUTHORED: AuthoredEntry[] = [
    {
        category: "exact-symbol-path",
        partition: "development",
        slug: "exact-symbol-path-dev",
        queryText: "where is normalizeSearchResultLimit defined",
        mode: "explicit",
        sourceFilters: ["message"],
        docKind: "message",
        docLocator: "msg-fixture-0001",
        docTitle: "search bounds module walkthrough",
        docBody:
            "normalizeSearchResultLimit lives in the search-bounds module next to the explicit query preflight; it clamps the requested limit into the supported result window.",
        distractor: {
            kind: "message",
            locator: "msg-fixture-0002",
            title: "unrelated limit discussion",
            body: "The rate limiter for embedding batches uses a token bucket, unrelated to result limits.",
        },
    },
    {
        category: "exact-symbol-path",
        partition: "holdout",
        slug: "exact-symbol-path-hold",
        queryText: "which file builds the alias index for benchmark identities",
        mode: "explicit",
        sourceFilters: null,
        docKind: "memory",
        docLocator: "9101",
        docTitle: "benchmark identity module map",
        docBody:
            "The alias index builder sits in the benchmark identity module; it maps scoped physical locators onto content-addressed relevance identities.",
    },
    {
        category: "error-message",
        partition: "development",
        slug: "error-message-dev",
        queryText: "SQLITE_BUSY thrown during shadow measurement write",
        mode: "automatic",
        sourceFilters: null,
        docKind: "message",
        docLocator: "msg-fixture-0003",
        docTitle: "shadow write failure triage",
        docBody:
            "SQLITE_BUSY during the shadow measurement insert is contained by the telemetry guard; the search results path never rejects because of it.",
    },
    {
        category: "error-message",
        partition: "holdout",
        slug: "error-message-hold",
        queryText: "unknown alias namespace failure when resolving ranked results",
        mode: "explicit",
        sourceFilters: null,
        docKind: "note",
        docLocator: "7301",
        docTitle: "alias namespace failure note",
        docBody:
            "Resolving a ranked result with an unrecognized locator namespace reports an unresolved status instead of guessing a target document.",
        distractor: {
            kind: "note",
            locator: "7302",
            title: "unrelated namespace note",
            body: "TypeScript namespace imports are banned by the lint config; prefer module imports.",
        },
    },
    {
        category: "architecture-rationale",
        partition: "development",
        slug: "architecture-rationale-dev",
        queryText: "why keep relevance identity separate from storage row ids",
        mode: "explicit",
        sourceFilters: ["memory"],
        docKind: "memory",
        docLocator: "9102",
        docTitle: "identity separation rationale",
        docBody:
            "Relevance truth follows the immutable semantic payload rather than a storage row id, so a correct storage migration cannot register as a false recall loss.",
        extraAliases: [{ namespace: "retrieval-document", locator: "rdoc-9102" }],
    },
    {
        category: "architecture-rationale",
        partition: "holdout",
        slug: "architecture-rationale-hold",
        queryText: "reason recovery drafts live outside the repository worktree",
        mode: "automatic",
        sourceFilters: null,
        docKind: "primer",
        docLocator: "501",
        docTitle: "draft staging boundary primer",
        docBody:
            "Recovered drafts stage in an owner-only directory outside source, publication, and version-control trees so raw candidate text can never reach a tracked file.",
    },
    {
        category: "debugging-history",
        partition: "development",
        slug: "debugging-history-dev",
        queryText: "how we fixed duplicate metric credit for alias spellings",
        mode: "explicit",
        sourceFilters: null,
        docKind: "git_commit",
        docLocator: "a1b2c3d4e5f6071829",
        docTitle: "dedupe ranked alias credit",
        docBody:
            "fix(benchmark): credit only the first ranked occurrence of a canonical identity; later alias spellings of the same payload count as duplicates.",
    },
    {
        category: "debugging-history",
        partition: "holdout",
        slug: "debugging-history-hold",
        queryText: "what caused the false recall drop in the migration rehearsal",
        mode: "explicit",
        sourceFilters: ["git_commit", "message"],
        docKind: "git_commit",
        docLocator: "b2c3d4e5f60718293a",
        docTitle: "migration rehearsal recall fix",
        docBody:
            "fix(migration): rehearsal recall drop traced to physical result ids changing shape; scoring now resolves canonical identities before recall is computed.",
    },
    {
        category: "user-directive",
        partition: "development",
        slug: "user-directive-dev",
        queryText: "directive to use graded judgments instead of binary labels",
        mode: "automatic",
        sourceFilters: ["memory"],
        docKind: "memory",
        docLocator: "9103",
        docTitle: "graded judgment directive",
        docBody:
            "Directive: relevance labels use grades zero, one, and two; binary labels are not acceptable for the judged corpus.",
    },
    {
        category: "user-directive",
        partition: "holdout",
        slug: "user-directive-hold",
        queryText: "rule about never persisting plaintext query telemetry",
        mode: "explicit",
        sourceFilters: null,
        docKind: "memory",
        docLocator: "9104",
        docTitle: "plaintext telemetry rule",
        docBody:
            "Standing rule: production telemetry stores normalized query hashes only; no new plaintext query capture sink may be added.",
    },
    {
        category: "current-constraint",
        partition: "development",
        slug: "current-constraint-dev",
        queryText: "maximum bytes allowed for an explicit search query",
        mode: "explicit",
        sourceFilters: null,
        docKind: "compartment",
        docLocator: "3401",
        docTitle: "query bounds compartment",
        docBody:
            "Explicit queries reject past sixteen kilobytes of UTF-8; automatic queries truncate to the same byte budget before token and atom caps apply.",
    },
    {
        category: "current-constraint",
        partition: "holdout",
        slug: "current-constraint-hold",
        queryText: "per session row cap on the measurement corpus",
        mode: "automatic",
        sourceFilters: null,
        docKind: "compartment",
        docLocator: "3402",
        docTitle: "measurement retention compartment",
        docBody:
            "The measurement corpus keeps at most two thousand rows per session; the oldest overflow rows are pruned when an insert lands.",
    },
    {
        category: "benchmark-result",
        partition: "development",
        slug: "benchmark-result-dev",
        queryText: "latest recall at ten for the shadow embedding cohort",
        mode: "explicit",
        sourceFilters: ["note"],
        docKind: "note",
        docLocator: "7303",
        docTitle: "shadow cohort recall snapshot",
        docBody:
            "Benchmark snapshot: the shadow cohort reached recall at ten of zero point eight one on the development partition, up four points over primary.",
    },
    {
        category: "benchmark-result",
        partition: "holdout",
        slug: "benchmark-result-hold",
        queryText: "p95 latency measured for the vector scan stage",
        mode: "explicit",
        sourceFilters: null,
        docKind: "note",
        docLocator: "7304",
        docTitle: "vector scan latency note",
        docBody:
            "Stage timing: vector scan p95 sits at nineteen milliseconds at the hundred-thousand document scale point with the current layout.",
    },
    {
        category: "temporal",
        partition: "development",
        slug: "temporal-dev",
        queryText: "what changed in the search pipeline last sprint",
        mode: "automatic",
        sourceFilters: ["git_commit"],
        docKind: "git_commit",
        docLocator: "c3d4e5f60718293a4b",
        docTitle: "sprint search pipeline change",
        docBody:
            "refactor(search): last sprint moved locator encoding behind the production codec and froze the measurement string vocabulary.",
    },
    {
        category: "temporal",
        partition: "holdout",
        slug: "temporal-hold",
        queryText: "when the judgments schema version was frozen",
        mode: "explicit",
        sourceFilters: null,
        docKind: "primer",
        docLocator: "502",
        docTitle: "judgments schema freeze primer",
        docBody:
            "The judgments schema froze at version one together with the graded pooled rubric; changes require a new schema version and fresh approvals.",
    },
    {
        category: "contradictory-memory",
        partition: "development",
        slug: "contradictory-memory-dev",
        queryText: "are duplicate aliases credited once or per spelling",
        mode: "explicit",
        sourceFilters: ["memory"],
        docKind: "memory",
        docLocator: "9105",
        docTitle: "alias credit resolution",
        docBody:
            "Resolved contradiction: duplicate aliases are credited once per canonical identity; an earlier note that credited each spelling separately is superseded.",
    },
    {
        category: "contradictory-memory",
        partition: "holdout",
        slug: "contradictory-memory-hold",
        queryText: "is an unjudged pair scored as nonrelevant",
        mode: "automatic",
        sourceFilters: null,
        docKind: "memory",
        docLocator: "9106",
        docTitle: "unjudged semantics resolution",
        docBody:
            "Resolved contradiction: unjudged pairs stay explicitly unjudged and are excluded from grading; treating them as grade zero was rejected.",
    },
    {
        category: "paraphrased-decision",
        partition: "development",
        slug: "paraphrased-decision-dev",
        queryText: "decision to grade every pooled query document pair",
        paraphrases: ["we agreed each pooled pair gets a grade"],
        mode: "explicit",
        sourceFilters: null,
        docKind: "note",
        docLocator: "7305",
        docTitle: "pooled grading decision",
        docBody:
            "Decision: every pooled query-document pair receives a human grade; absent nonpooled pairs remain unjudged rather than defaulting to nonrelevant.",
    },
    {
        category: "paraphrased-decision",
        partition: "holdout",
        slug: "paraphrased-decision-hold",
        queryText: "why the holdout partition is frozen before ranking work",
        paraphrases: ["rationale for locking holdout intents ahead of tuning"],
        mode: "explicit",
        sourceFilters: null,
        docKind: "primer",
        docLocator: "503",
        docTitle: "holdout freeze decision",
        docBody:
            "Decision: development and holdout partitions are assigned by base intent before any ranking work so the holdout can gate changes without being tuned against.",
    },
];

const ALIAS_NAMESPACE: Record<DocumentKind, string> = {
    memory: "memory",
    message: "message",
    compartment: "chunk",
    git_commit: "commit",
    primer: "primer",
    note: "note",
};

const REFERENCE_TIME_MS = 1_755_400_000_000;

function makeScenario(
    entry: AuthoredEntry,
    id: string,
    queryText: string,
    origin: "recovered" | "curated",
): QueryScenario {
    return {
        id,
        category: entry.category,
        mode: entry.mode,
        queryText,
        sourceFilters: entry.sourceFilters,
        fixtureScope: { projectScope: FIXTURE_PROJECT_SCOPE, sessionScope: null },
        visibleState: { visibleMemoryIds: [], messageOrdinalCutoff: 0 },
        referenceTimeMs: REFERENCE_TIME_MS,
        partition: entry.partition,
        paraphraseGroup: `pg-${entry.slug}`,
        resultLimit: 10,
        provenance: { origin },
    };
}

function makeAuthoredDocument(
    id: string,
    kind: DocumentKind,
    locator: string,
    title: string,
    body: string,
    extraAliases: Array<{ namespace: string; locator: string }> = [],
): CorpusDocument {
    return {
        id,
        kind,
        semanticPayload: { kind, title, body },
        aliases: [
            {
                namespace: ALIAS_NAMESPACE[kind],
                locator,
                projectScope: FIXTURE_PROJECT_SCOPE,
                sessionScope: null,
            },
            ...extraAliases.map((alias) => ({
                ...alias,
                projectScope: FIXTURE_PROJECT_SCOPE,
                sessionScope: null,
            })),
        ],
    };
}

export interface AuthoredArtifacts {
    corpus: CorpusArtifact;
    judgments: JudgmentsArtifact;
    syntheticProfiles: SyntheticProfilesArtifact;
}

export function buildCorpusArtifacts(): AuthoredArtifacts {
    const queries: QueryScenario[] = [];
    const documents: CorpusDocument[] = [];
    const pools: JudgmentsArtifact["pools"] = [];
    const judgments: JudgmentsArtifact["judgments"] = [];

    for (const entry of AUTHORED) {
        const documentId = `d-${entry.slug}`;
        documents.push(
            makeAuthoredDocument(
                documentId,
                entry.docKind,
                entry.docLocator,
                entry.docTitle,
                entry.docBody,
                entry.extraAliases,
            ),
        );
        const queryIds = [`q-${entry.slug}`];
        queries.push(makeScenario(entry, queryIds[0], entry.queryText, "curated"));
        for (const [i, paraphrase] of (entry.paraphrases ?? []).entries()) {
            const paraphraseId = `q-${entry.slug}-p${i + 2}`;
            queryIds.push(paraphraseId);
            queries.push(makeScenario(entry, paraphraseId, paraphrase, "curated"));
        }

        let distractorId: string | null = null;
        if (entry.distractor) {
            distractorId = `d-${entry.slug}-distractor`;
            documents.push(
                makeAuthoredDocument(
                    distractorId,
                    entry.distractor.kind,
                    entry.distractor.locator,
                    entry.distractor.title,
                    entry.distractor.body,
                ),
            );
        }

        for (const queryId of queryIds) {
            pools.push({
                queryId,
                documentIds: distractorId ? [documentId, distractorId] : [documentId],
            });
            judgments.push({
                queryId,
                documentId,
                grade: 2,
                provenance: { judge: "human", pooledFrom: ["primary", "manual"] },
            });
            if (distractorId) {
                judgments.push({
                    queryId,
                    documentId: distractorId,
                    grade: 0,
                    provenance: { judge: "human", pooledFrom: ["shadow"] },
                });
            }
        }
    }

    return {
        corpus: { schemaVersion: CORPUS_SCHEMA_VERSION, queries, documents },
        judgments: {
            schemaVersion: JUDGMENTS_SCHEMA_VERSION,
            rubricVersion: RUBRIC_VERSION,
            pools,
            judgments,
        },
        syntheticProfiles: {
            schemaVersion: SYNTHETIC_SCHEMA_VERSION,
            profiles: ([1_000, 10_000, 100_000, 1_000_000] as const).map((scale) => ({
                id: `syn-scale-${scale}`,
                generatorVersion: SYNTHETIC_GENERATOR_VERSION,
                prng: "splitmix32",
                seed: 20_260_818,
                scale,
                sourceDistribution: { memory: 4, message: 6, compartment: 5, note: 2 },
                textSize: { minWords: 12, maxWords: 96 },
            })),
        },
    };
}

/** Operator approval records for the exact authored release tuple. Any edit
 *  to artifact content or policy versions invalidates both. */
export const OPERATOR_APPROVALS = [
    {
        kind: "privacy",
        approver: "operator-privacy-review",
        releaseTupleFingerprint:
            "edf2e7329c6493be6d4a788d551e88762dfd54bab12088c78a386d0ee9748996",
    },
    {
        kind: "relevance-intent",
        approver: "operator-relevance-review",
        releaseTupleFingerprint:
            "edf2e7329c6493be6d4a788d551e88762dfd54bab12088c78a386d0ee9748996",
    },
] as const;

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function main(): void {
    const command = process.argv[2];
    if (command === "fingerprint") {
        process.stdout.write(
            `${canonicalFingerprint(buildReleaseTuple(buildCorpusArtifacts()))}\n`,
        );
        return;
    }
    if (command === "build") {
        const artifacts = buildCorpusArtifacts();
        const { releaseDir } = promoteRelease({
            ...artifacts,
            approvals: OPERATOR_APPROVALS,
            releasesRoot: RELEASES_ROOT,
            releaseVersion: RELEASE_VERSION,
        });
        process.stdout.write(`installed ${releaseDir}\n`);
        return;
    }
    if (command === "check") {
        const manifestPath = process.argv[3];
        if (!manifestPath) fail("usage: build-benchmark-corpus.ts check <manifest.json>");
        const release = loadReviewedRelease(dirname(resolve(manifestPath)));
        const categories = new Set(release.corpus.queries.map((q) => q.category));
        if (categories.size !== QUERY_CATEGORIES.length) {
            fail("check failed: missing category coverage");
        }
        process.stdout.write(
            `ok: ${release.corpus.queries.length} queries, ${release.corpus.documents.length} documents, manifest ${release.fingerprints.manifest}\n`,
        );
        return;
    }
    fail("usage: build-benchmark-corpus.ts fingerprint|build|check <manifest.json>");
}

if (import.meta.main) {
    main();
}
