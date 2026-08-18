/**
 * Pure storage-independent facade for the judged retrieval corpus.
 *
 * The only entry point U5 may import. Loads reviewed immutable releases,
 * resolves scenario-scoped physical locators onto canonical relevance
 * identities, keeps unjudged distinct from nonrelevant, and iterates
 * deterministic synthetic scale corpora. No database, recovery, or promotion
 * code is reachable from this module.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
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
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ContractError([`release.${name}: invalid-json`]);
    }
    // The parsed view must account for every byte on disk. JSON.parse keeps
    // the LAST of duplicate object members, so a duplicated key could hide
    // sensitive plaintext in the file bytes while the scan, schema, and
    // recomputed fingerprints all see only the clean survivor. Requiring the
    // exact promoter serialization (stringify + trailing newline) makes any
    // dropped or reformatted byte a rejection.
    if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
        throw new ContractError([`release.${name}: non-canonical-bytes`]);
    }
    return parsed;
}

/**
 * Load one reviewed release directory, failing closed before any scoring or
 * timing consumer can see inconsistent data: privacy scan first (so no later
 * diagnostic can echo rejected content), then strict schemas, recomputed
 * fingerprints against the approved release tuple, current privacy policy and
 * sanitizer versions, approvals bound to the exact tuple, and referential and
 * partition integrity.
 *
 * `forbiddenTokens` is an optional operator deny list (project codenames,
 * customer names) applied on top of the pattern gates. It is optional here
 * because the tokens are themselves sensitive: they cannot ship inside the
 * repository or the release, so a loader without access to the list must
 * still be able to validate the fingerprinted bytes deterministically.
 */
/** Every entry in a reviewed release directory must be one of the four
 *  reviewed artifacts, as a regular file: an extra file (a raw recovery
 *  draft, say) would live under the approved version directory without ever
 *  passing the privacy or approval boundary. Diagnostics carry counts, not
 *  names — an unexpected filename is itself unreviewed content. */
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
        /** Trust anchor from OUTSIDE the release directory (reviewed source,
         *  CI config): the recomputed manifest fingerprint must match, which
         *  binds the approval records themselves — a release directory is
         *  otherwise self-consistent under fabricated approvals. */
        expectedManifestFingerprint?: string;
    } = {},
): ReviewedRelease {
    checkReleaseEntries(releaseDir);
    const corpusRaw = readJson(releaseDir, RELEASE_FILES.corpus);
    const judgmentsRaw = readJson(releaseDir, RELEASE_FILES.judgments);
    const syntheticRaw = readJson(releaseDir, RELEASE_FILES.syntheticProfiles);
    const manifestRaw = readJson(releaseDir, RELEASE_FILES.manifest);

    // The privacy gate runs before any parse or cross-artifact validation:
    // no later diagnostic can echo content the scan would have rejected.
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
    // The tuple binds the three artifacts, and approvals bind to the tuple —
    // but nothing inside the directory can authenticate the approvals
    // themselves. When the caller supplies a trusted manifest fingerprint,
    // the whole manifest (approval records included) must match it.
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
    // Generator invariants are enforced at load, not first iteration: a
    // release with an unusable profile must reject here rather than pass
    // review and then fail hours into a scale run.
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
