/**
 * Pure storage-independent facade for the judged retrieval corpus.
 *
 * The only entry point U5 may import. Loads reviewed immutable releases,
 * resolves scenario-scoped physical locators onto canonical relevance
 * identities, keeps unjudged distinct from nonrelevant, and iterates
 * deterministic synthetic scale corpora. No database, recovery, or promotion
 * code is reachable from this module.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalFingerprint, canonicalJson } from "./canonical-json";
import {
    type CorpusArtifact,
    ContractError,
    type JudgmentsArtifact,
    type ManifestArtifact,
    type SyntheticProfilesArtifact,
    parseCorpus,
    parseJudgments,
    parseManifest,
    parseSyntheticProfiles,
    validateRelease,
} from "./contract";
import { type AliasIndex, buildAliasIndex } from "./identity";
import {
    PRIVACY_POLICY_VERSION,
    SANITIZER_VERSION,
    scanForSensitiveContent,
} from "./privacy";

export {
    CORPUS_SCHEMA_VERSION,
    JUDGMENTS_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION,
    QUERY_CATEGORIES,
    RUBRIC_VERSION,
    SYNTHETIC_SCALES,
    SYNTHETIC_SCHEMA_VERSION,
    ContractError,
} from "./contract";
export type {
    Approval,
    CorpusArtifact,
    CorpusDocument,
    DocumentKind,
    Judgment,
    JudgmentsArtifact,
    ManifestArtifact,
    QueryCategory,
    QueryScenario,
    ReleaseTuple,
    StructuredAlias,
    SyntheticProfile,
    SyntheticProfilesArtifact,
} from "./contract";
export { canonicalFingerprint, canonicalJson } from "./canonical-json";
export {
    type AliasIndex,
    buildAliasIndex,
    relevanceIdentity,
    type ResolvedRankedResult,
    resolveRankedLocators,
    type ScenarioScope,
} from "./identity";
export { PRIVACY_POLICY_VERSION, SANITIZER_VERSION, scanForSensitiveContent } from "./privacy";
export {
    iterateSyntheticDocuments,
    SYNTHETIC_GENERATOR_VERSION,
    type SyntheticDocument,
    syntheticStreamHash,
} from "./synthetic";

export interface ReviewedRelease {
    corpus: CorpusArtifact;
    judgments: JudgmentsArtifact;
    syntheticProfiles: SyntheticProfilesArtifact;
    manifest: ManifestArtifact;
    aliasIndex: AliasIndex;
    /** Recomputed (not declared) artifact fingerprints. */
    fingerprints: {
        corpus: string;
        judgments: string;
        syntheticProfiles: string;
        manifest: string;
    };
}

export const RELEASE_FILES = {
    corpus: "corpus.json",
    judgments: "judgments.json",
    syntheticProfiles: "synthetic-profiles.json",
    manifest: "manifest.json",
} as const;

function readJson(dir: string, name: string): unknown {
    let text: string;
    try {
        text = readFileSync(join(dir, name), "utf8");
    } catch {
        throw new ContractError([`release.${name}: unreadable`]);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ContractError([`release.${name}: invalid-json`]);
    }
}

/**
 * Load one reviewed release directory, failing closed before any scoring or
 * timing consumer can see inconsistent data: strict schemas, recomputed
 * fingerprints against the approved release tuple, current privacy policy and
 * sanitizer versions, approvals bound to the exact tuple, referential and
 * partition integrity, and a residual privacy scan.
 */
export function loadReviewedRelease(releaseDir: string): ReviewedRelease {
    const corpusRaw = readJson(releaseDir, RELEASE_FILES.corpus);
    const judgmentsRaw = readJson(releaseDir, RELEASE_FILES.judgments);
    const syntheticRaw = readJson(releaseDir, RELEASE_FILES.syntheticProfiles);
    const manifestRaw = readJson(releaseDir, RELEASE_FILES.manifest);

    const manifest = parseManifest(manifestRaw);
    const tuple = manifest.releaseTuple;
    const diagnostics: string[] = [];
    const fingerprints = {
        corpus: canonicalFingerprint(corpusRaw),
        judgments: canonicalFingerprint(judgmentsRaw),
        syntheticProfiles: canonicalFingerprint(syntheticRaw),
        manifest: canonicalFingerprint(manifestRaw),
    };
    if (fingerprints.corpus !== tuple.corpusFingerprint) {
        diagnostics.push("release.corpus: fingerprint-mismatch");
    }
    if (fingerprints.judgments !== tuple.judgmentsFingerprint) {
        diagnostics.push("release.judgments: fingerprint-mismatch");
    }
    if (fingerprints.syntheticProfiles !== tuple.syntheticProfilesFingerprint) {
        diagnostics.push("release.synthetic-profiles: fingerprint-mismatch");
    }
    if (tuple.privacyPolicyVersion !== PRIVACY_POLICY_VERSION) {
        diagnostics.push("release.manifest: stale-privacy-policy");
    }
    if (tuple.sanitizerVersion !== SANITIZER_VERSION) {
        diagnostics.push("release.manifest: stale-sanitizer");
    }
    if (diagnostics.length > 0) throw new ContractError(diagnostics);

    const corpus = parseCorpus(corpusRaw);
    const judgments = parseJudgments(judgmentsRaw);
    const syntheticProfiles = parseSyntheticProfiles(syntheticRaw);
    validateRelease(corpus, judgments);

    const violations = scanForSensitiveContent({
        corpus: corpusRaw,
        judgments: judgmentsRaw,
        syntheticProfiles: syntheticRaw,
        manifest: manifestRaw,
    });
    if (violations.length > 0) {
        throw new ContractError(
            violations.map((v) => `privacy.${v.category}: ${v.path}`).sort(),
        );
    }

    return {
        corpus,
        judgments,
        syntheticProfiles,
        manifest,
        aliasIndex: buildAliasIndex(corpus.documents),
        fingerprints,
    };
}

export type JudgmentState =
    | { status: "judged"; grade: 0 | 1 | 2 }
    | { status: "unjudged" };

export interface JudgmentLookup {
    (queryId: string, documentId: string): JudgmentState;
}

/**
 * Judgment lookup with an explicit unjudged state: a pair outside the
 * recorded pool is UNJUDGED, never grade 0 (validateRelease already
 * guarantees every pooled pair carries a grade).
 */
export function buildJudgmentLookup(judgments: JudgmentsArtifact): JudgmentLookup {
    const grades = new Map<string, 0 | 1 | 2>();
    for (const judgment of judgments.judgments) {
        grades.set(canonicalJson([judgment.queryId, judgment.documentId]), judgment.grade);
    }
    return (queryId, documentId) => {
        const grade = grades.get(canonicalJson([queryId, documentId]));
        return grade === undefined ? { status: "unjudged" } : { status: "judged", grade };
    };
}
