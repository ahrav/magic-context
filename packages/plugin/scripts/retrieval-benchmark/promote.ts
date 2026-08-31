/**
 * The promoter creates an immutable release directory from a reviewed draft without a database.
 *
 * The promoter validates operator-supplied artifacts and approvals against the exact release tuple.
 * The promoter re-loads the full release through the strict consumer path.
 * The promoter uses an owner-only review directory outside every VCS tree.
 * The promoter stages validated bytes next to the destination only after every validation gate passes.
 * The promoter atomically renames staged bytes into place and cannot create approvals.
 * The promoter never modifies an existing release.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonicalFingerprint } from "./canonical-json";
import {
    ContractError,
    CORPUS_SCHEMA_VERSION,
    JUDGMENTS_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION,
    type ManifestArtifact,
    parseCorpus,
    parseJudgments,
    parseSyntheticProfiles,
    type ReleaseTuple,
    RUBRIC_VERSION,
    SYNTHETIC_SCHEMA_VERSION,
    validateRelease,
} from "./contract";
import { hasGitAncestor } from "./fs-boundary";
import { loadReviewedRelease, RELEASE_FILES } from "./index";
import {
    PRIVACY_POLICY_VERSION,
    SANITIZER_VERSION,
    scanForSensitiveContent,
} from "./privacy";

const approvalFileSchema = z.strictObject({
    kind: z.enum(["privacy", "relevance-intent"]),
    approver: z.string().min(1),
    releaseTupleFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface PromotionInput {
    corpus: unknown;
    judgments: unknown;
    syntheticProfiles: unknown;
    /** Operators supply exactly one approval of each kind; the promoter cannot create approvals.
     * The promoter does not repair supplied approvals. */
    approvals: readonly unknown[];
    /** The privacy gate applies forbiddenTokens to project codenames and customer names during both validating reloads.
     * forbiddenTokens is optional because the tokens are sensitive.
     *  tokens are themselves sensitive and never ship with the release. */
    forbiddenTokens?: readonly string[];
    /** The privacy gate matches forbiddenIdentifiers as whole words. */
    forbiddenIdentifiers?: readonly string[];
    releasesRoot: string;
    releaseVersion: string;
}

export function buildReleaseTuple(input: {
    corpus: unknown;
    judgments: unknown;
    syntheticProfiles: unknown;
}): ReleaseTuple {
    return {
        corpusFingerprint: canonicalFingerprint(input.corpus),
        judgmentsFingerprint: canonicalFingerprint(input.judgments),
        syntheticProfilesFingerprint: canonicalFingerprint(input.syntheticProfiles),
        corpusSchemaVersion: CORPUS_SCHEMA_VERSION,
        judgmentsSchemaVersion: JUDGMENTS_SCHEMA_VERSION,
        syntheticSchemaVersion: SYNTHETIC_SCHEMA_VERSION,
        rubricVersion: RUBRIC_VERSION,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        sanitizerVersion: SANITIZER_VERSION,
    };
}

function checkApprovals(
    approvals: readonly unknown[],
    tupleFingerprint: string,
): ManifestArtifact["approvals"] {
    const diagnostics: string[] = [];
    const byKind = new Map<string, z.infer<typeof approvalFileSchema>>();
    for (const [i, raw] of approvals.entries()) {
        const parsed = approvalFileSchema.safeParse(raw);
        if (!parsed.success) {
            diagnostics.push(`approvals[${i}]: malformed`);
            continue;
        }
        if (byKind.has(parsed.data.kind)) diagnostics.push(`approvals[${i}]: duplicate-kind`);
        byKind.set(parsed.data.kind, parsed.data);
        if (parsed.data.releaseTupleFingerprint !== tupleFingerprint) {
            diagnostics.push(`approvals[${i}]: stale-or-foreign-tuple`);
        }
    }
    const privacy = byKind.get("privacy");
    const relevanceIntent = byKind.get("relevance-intent");
    if (!privacy) diagnostics.push("approvals: missing privacy approval");
    if (!relevanceIntent) diagnostics.push("approvals: missing relevance-intent approval");
    if (diagnostics.length > 0 || !privacy || !relevanceIntent) {
        throw new ContractError(diagnostics.sort());
    }
    return { privacy, relevanceIntent };
}

/**
 * The manifest deterministically binds validated artifacts to the release tuple and approvals.
 * Consumers fingerprint the manifest document itself.
 * The manifest contains no fingerprint of itself.
 */
export function buildManifest(
    input: Omit<PromotionInput, "releasesRoot">,
): ManifestArtifact {
    const releaseTuple = buildReleaseTuple(input);
    const approvals = checkApprovals(input.approvals, canonicalFingerprint(releaseTuple));
    if (!/^v\d+$/.test(input.releaseVersion)) {
        throw new ContractError(["release: invalid version"]);
    }
    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        releaseVersion: input.releaseVersion,
        releaseTuple,
        approvals,
    };
}

/**
 * A failed promotion leaves every prior release byte-identical.
 * The promoter provides process-level atomicity only because it does not fsync staged files or directories.
 * Power loss can leave a renamed directory with truncated files.
 *
 * Unvetted bytes never enter releasesRoot.
 * The promoter re-loads fingerprints, approvals, privacy checks, and partitions before staging release bytes.
 * The consumer-path reload runs in an owner-only review directory outside every VCS tree.
 */
export function promoteRelease(input: PromotionInput): { releaseDir: string } {
    // The privacy gate runs before parsers and validators because their diagnostics can expose artifact IDs.
    // Schema and release diagnostics interpolate regex-bounded artifact IDs.
    // An identifying artifact ID in an invalid draft could otherwise reach exception messages before deny-list checks run.
    const violations = scanForSensitiveContent(
        {
            corpus: input.corpus,
            judgments: input.judgments,
            syntheticProfiles: input.syntheticProfiles,
            approvals: input.approvals,
        },
        {
            forbiddenTokens: input.forbiddenTokens,
            forbiddenIdentifiers: input.forbiddenIdentifiers,
        },
    );
    if (violations.length > 0) {
        throw new ContractError(
            violations.map((v) => `privacy.${v.category}: ${v.path}`).sort(),
        );
    }
    const corpus = parseCorpus(input.corpus);
    const judgments = parseJudgments(input.judgments);
    parseSyntheticProfiles(input.syntheticProfiles);
    validateRelease(corpus, judgments);
    const manifest = buildManifest(input);

    const destination = join(input.releasesRoot, input.releaseVersion);
    if (existsSync(destination)) {
        throw new ContractError(["release: version already installed"]);
    }
    const files: Array<[string, string]> = (
        [
            [RELEASE_FILES.corpus, input.corpus],
            [RELEASE_FILES.judgments, input.judgments],
            [RELEASE_FILES.syntheticProfiles, input.syntheticProfiles],
            [RELEASE_FILES.manifest, manifest],
        ] as Array<[string, unknown]>
    ).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]);

    // The review directory is outside every VCS tree, so a crash cannot leave unreviewed bytes in an existing work tree.
    const reviewDir = mkdtempSync(
        join(realpathSync.native(tmpdir()), "magic-context-benchmark-promote-"),
    );
    try {
        if (hasGitAncestor(reviewDir)) {
            throw new ContractError(["release: review staging is inside a VCS tree"]);
        }
        for (const [name, content] of files) {
            writeFileSync(join(reviewDir, name), content, { flag: "wx" });
        }
        loadReviewedRelease(reviewDir, {
            forbiddenTokens: input.forbiddenTokens,
            forbiddenIdentifiers: input.forbiddenIdentifiers,
        });
    } catch (error) {
        rmSync(reviewDir, { recursive: true, force: true });
        throw error;
    }
    rmSync(reviewDir, { recursive: true, force: true });

    mkdirSync(input.releasesRoot, { recursive: true });
    // A unique staging directory prevents concurrent promotions of the same version from exchanging contents.
    // Only bytes that passed the review-directory validation are written to `staging`.
    const staging = mkdtempSync(join(input.releasesRoot, ".staging-"));
    try {
        for (const [name, content] of files) {
            writeFileSync(join(staging, name), content, { flag: "wx" });
        }
        // Reloading `staging` detects tampering after its files are written and before the atomic rename.
        loadReviewedRelease(staging, {
            forbiddenTokens: input.forbiddenTokens,
            forbiddenIdentifiers: input.forbiddenIdentifiers,
        });
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    return { releaseDir: destination };
}
