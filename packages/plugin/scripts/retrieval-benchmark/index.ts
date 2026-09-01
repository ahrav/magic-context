/**
 *
 * This module resolves scenario-scoped locators to canonical relevance identities.
 * This module preserves unjudged results separately from nonrelevant results.
 * This module iterates deterministic synthetic-scale corpora.
 * This module cannot reach database, recovery, or promotion code.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
    canonicalFingerprint,
    canonicalJson,
    readCanonicalJsonFile,
} from "./canonical-json";
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
import { checkSyntheticProfile, SyntheticProfileError } from "./synthetic";

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
    checkSyntheticProfile,
    iterateSyntheticDocuments,
    SYNTHETIC_GENERATOR_VERSION,
    type SyntheticDocument,
    SyntheticProfileError,
    syntheticStreamHash,
} from "./synthetic";

export interface ReviewedRelease {
    corpus: CorpusArtifact;
    judgments: JudgmentsArtifact;
    syntheticProfiles: SyntheticProfilesArtifact;
    manifest: ManifestArtifact;
    aliasIndex: AliasIndex;
    /** The loader recomputes these artifact fingerprints instead of trusting declared values. */
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
    return readCanonicalJsonFile(
        join(dir, name),
        (code) => new ContractError([`release.${name}: ${code}`]),
    );
}

/**
 * The loader fails closed before scoring consumers receive inconsistent data.
 * The loader scans privacy before parsing so diagnostics cannot echo rejected content.
 * The loader validates strict schemas and recomputes fingerprints against the approved release tuple.
 * The loader checks the current privacy-policy and sanitizer versions and binds approvals to the exact tuple.
 * The loader validates referential and partition integrity.
 * partition integrity.
 *
 * `forbiddenTokens` is an optional operator deny list applied in addition to the pattern gates.
 * A loader without the list can validate the fingerprinted bytes deterministically.
 */
/**
 * Every release-directory entry must be a reviewed regular artifact; extra files bypass privacy and approval validation.
 * An unreviewed draft could otherwise remain in the approved version directory without passing privacy or approval validation.
 * */
function checkReleaseEntries(releaseDir: string): void {
    let entries: string[];
    try {
        entries = readdirSync(releaseDir);
    } catch {
        throw new ContractError(["release: unreadable"]);
    }
    const expected = new Set<string>(Object.values(RELEASE_FILES));
    const unexpected = entries.filter((entry) => !expected.has(entry)).length;
    if (unexpected > 0) {
        throw new ContractError([`release: unexpected entries (${unexpected})`]);
    }
    const irregular = entries.filter(
        (entry) => !lstatSync(join(releaseDir, entry)).isFile(),
    ).length;
    if (irregular > 0) {
        throw new ContractError([`release: non-regular entries (${irregular})`]);
    }
}

export function loadReviewedRelease(
    releaseDir: string,
    options: {
        forbiddenTokens?: readonly string[];
        forbiddenIdentifiers?: readonly string[];
        /** The caller provides the trust anchor outside the release directory.
         * The recomputed manifest fingerprint must match the externally trusted fingerprint.
         * Matching the trusted manifest fingerprint binds the approval records.
         * */
        expectedManifestFingerprint?: string;
    } = {},
): ReviewedRelease {
    checkReleaseEntries(releaseDir);
    const corpusRaw = readJson(releaseDir, RELEASE_FILES.corpus);
    const judgmentsRaw = readJson(releaseDir, RELEASE_FILES.judgments);
    const syntheticRaw = readJson(releaseDir, RELEASE_FILES.syntheticProfiles);
    const manifestRaw = readJson(releaseDir, RELEASE_FILES.manifest);

    // The privacy gate runs before parsing and cross-artifact validation.
    const violations = scanForSensitiveContent(
        {
            corpus: corpusRaw,
            judgments: judgmentsRaw,
            syntheticProfiles: syntheticRaw,
            manifest: manifestRaw,
        },
        {
            forbiddenTokens: options.forbiddenTokens,
            forbiddenIdentifiers: options.forbiddenIdentifiers,
        },
    );
    if (violations.length > 0) {
        throw new ContractError(
            violations.map((v) => `privacy.${v.category}: ${v.path}`).sort(),
        );
    }

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
    // The release tuple binds the three artifacts, and approvals bind to that tuple.
    // Nothing inside the directory can authenticate the approval records.
    // The manifest, including approval records, must match the trusted fingerprint.
    if (
        options.expectedManifestFingerprint !== undefined &&
        fingerprints.manifest !== options.expectedManifestFingerprint
    ) {
        diagnostics.push("release.manifest: fingerprint-untrusted");
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
    const profileDiagnostics: string[] = [];
    for (const [i, profile] of syntheticProfiles.profiles.entries()) {
        try {
            checkSyntheticProfile(profile);
        } catch (error) {
            const code = error instanceof SyntheticProfileError ? error.message : "invalid";
            profileDiagnostics.push(`syntheticProfiles.profiles[${i}]: ${code}`);
        }
    }
    if (profileDiagnostics.length > 0) throw new ContractError(profileDiagnostics.sort());
    validateRelease(corpus, judgments);

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
