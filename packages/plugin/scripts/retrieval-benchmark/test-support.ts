/* */

import { SOURCE_LOCATOR_KIND } from "./physical-locator";
import { canonicalFingerprint } from "./canonical-json";
import {
    type CorpusArtifact,
    CORPUS_SCHEMA_VERSION,
    type CorpusDocument,
    type DocumentKind,
    JUDGMENTS_SCHEMA_VERSION,
    type JudgmentsArtifact,
    MANIFEST_SCHEMA_VERSION,
    type ManifestArtifact,
    QUERY_CATEGORIES,
    type QueryScenario,
    RUBRIC_VERSION,
    SYNTHETIC_SCALES,
    SYNTHETIC_SCHEMA_VERSION,
    type SyntheticProfilesArtifact,
} from "./contract";
import { buildReleaseTuple } from "./promote";
import { SYNTHETIC_GENERATOR_VERSION } from "./synthetic";

export const FIXTURE_PROJECT_SCOPE = "git:fixture-project";

const KIND_ROTATION: DocumentKind[] = [
    "memory",
    "message",
    "compartment",
    "git_commit",
    "primer",
    "note",
];

const ALIAS_NAMESPACE: Record<DocumentKind, string> = SOURCE_LOCATOR_KIND;

export function makeDocument(
    slug: string,
    kind: DocumentKind,
    locator: string,
    body: string,
): CorpusDocument {
    return {
        id: `d-${slug}`,
        kind,
        semanticPayload: { kind, title: `doc ${slug}`, body },
        aliases: [
            {
                namespace: ALIAS_NAMESPACE[kind],
                locator,
                projectScope: FIXTURE_PROJECT_SCOPE,
                sessionScope: null,
            },
        ],
    };
}

export function makeQuery(
    slug: string,
    category: QueryScenario["category"],
    partition: QueryScenario["partition"],
    queryText: string,
): QueryScenario {
    return {
        id: `q-${slug}`,
        category,
        mode: "explicit",
        queryText,
        sourceFilters: null,
        fixtureScope: { projectScope: FIXTURE_PROJECT_SCOPE, sessionScope: null },
        visibleState: { visibleMemoryIds: [], messageOrdinalCutoff: 100_000 },
        referenceTimeMs: 1_700_000_000_000,
        partition,
        paraphraseGroup: `pg-${slug}`,
        resultLimit: 10,
        provenance: { origin: "curated" },
    };
}

/* */
export function makeValidCorpus(): CorpusArtifact {
    const queries: QueryScenario[] = [];
    const documents: CorpusDocument[] = [];
    QUERY_CATEGORIES.forEach((category, c) => {
        for (const partition of ["development", "holdout"] as const) {
            const slug = `${category}-${partition === "development" ? "dev" : "hold"}`;
            queries.push(
                makeQuery(slug, category, partition, `how does ${category} work in ${partition}`),
            );
            documents.push(
                makeDocument(
                    slug,
                    KIND_ROTATION[c % KIND_ROTATION.length],
                    String(c * 10 + (partition === "development" ? 1 : 2)),
                    `answer text for ${category} in ${partition}`,
                ),
            );
        }
    });
    return { schemaVersion: CORPUS_SCHEMA_VERSION, queries, documents };
}

export function makeValidJudgments(corpus: CorpusArtifact): JudgmentsArtifact {
    return {
        schemaVersion: JUDGMENTS_SCHEMA_VERSION,
        rubricVersion: RUBRIC_VERSION,
        pools: corpus.queries.map((query, i) => ({
            queryId: query.id,
            documentIds: [corpus.documents[i].id],
        })),
        judgments: corpus.queries.map((query, i) => ({
            queryId: query.id,
            documentId: corpus.documents[i].id,
            grade: 2 as const,
            provenance: { judge: "human" as const, pooledFrom: ["manual" as const] },
        })),
    };
}

const SCALE_LABELS: Record<number, string> = {
    1_000: "1k",
    10_000: "10k",
    100_000: "100k",
    1_000_000: "1m",
};

export function makeValidSyntheticProfiles(): SyntheticProfilesArtifact {
    return {
        schemaVersion: SYNTHETIC_SCHEMA_VERSION,
        profiles: SYNTHETIC_SCALES.map((scale) => ({
            id: `syn-smoke-${SCALE_LABELS[scale]}`,
            generatorVersion: SYNTHETIC_GENERATOR_VERSION,
            prng: "splitmix32",
            seed: 1337,
            scale,
            sourceDistribution: { memory: 3, message: 5, compartment: 2 },
            textSize: { minWords: 8, maxWords: 64 },
        })),
    };
}

export function makeManifestFor(
    corpus: unknown,
    judgments: unknown,
    syntheticProfiles: unknown,
): ManifestArtifact {
    const releaseTuple = buildReleaseTuple({ corpus, judgments, syntheticProfiles });
    const releaseTupleFingerprint = canonicalFingerprint(releaseTuple);
    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        releaseVersion: "v1",
        releaseTuple,
        approvals: {
            privacy: {
                kind: "privacy",
                approver: "privacy-reviewer",
                releaseTupleFingerprint,
            },
            relevanceIntent: {
                kind: "relevance-intent",
                approver: "relevance-reviewer",
                releaseTupleFingerprint,
            },
        },
    };
}

export interface ReleaseArtifacts {
    corpus: CorpusArtifact;
    judgments: JudgmentsArtifact;
    syntheticProfiles: SyntheticProfilesArtifact;
    manifest: ManifestArtifact;
}

export function makeValidRelease(): ReleaseArtifacts {
    const corpus = makeValidCorpus();
    const judgments = makeValidJudgments(corpus);
    const syntheticProfiles = makeValidSyntheticProfiles();
    return {
        corpus,
        judgments,
        syntheticProfiles,
        manifest: makeManifestFor(corpus, judgments, syntheticProfiles),
    };
}
