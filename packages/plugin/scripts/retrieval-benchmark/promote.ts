/**
 * DB-free promotion of a reviewed draft into an immutable release directory.
 *
 * The promoter validates operator-supplied artifacts and approvals against
 * the exact release tuple, re-loads the full release through the strict
 * consumer path in an owner-only review directory outside every VCS tree,
 * and only then stages the validated bytes next to the destination and
 * atomically renames them into place. It has no API for creating approvals
 * and never modifies an existing release.
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
import { PRIVACY_POLICY_VERSION, SANITIZER_VERSION } from "./privacy";

const approvalFileSchema = z.strictObject({
    kind: z.enum(["privacy", "relevance-intent"]),
    approver: z.string().min(1),
    releaseTupleFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface PromotionInput {
    corpus: unknown;
    judgments: unknown;
    syntheticProfiles: unknown;
    /** Operator-supplied, exactly one per kind. The promoter never creates
     *  or repairs these. */
    approvals: readonly unknown[];
    /** Operator deny list (project codenames, customer names) applied by the
     *  privacy gate during both validating re-loads. Optional because the
     *  tokens are themselves sensitive and never ship with the release. */
    forbiddenTokens?: readonly string[];
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
 * Assemble the manifest for validated artifacts. The manifest is a
 * deterministic envelope over the release tuple and its approvals; its own
 * fingerprint is computed by consumers over the manifest document, which
 * carries no self-reference.
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
 * Validate and atomically install a new immutable release directory.
 * Rejection, write failure, or process interruption leaves the releases root
 * without a partial version directory and any prior release byte-identical.
 * (Process-level atomicity only: no fsync, so a power loss can leave a
 * renamed directory with truncated files — loadReviewedRelease then fails
 * loudly on a fingerprint mismatch.)
 *
 * Unvetted bytes never touch the releases root: the full consumer-path
 * re-load (fingerprints, approvals, privacy, partitions) runs against an
 * owner-only review directory outside every VCS tree, and only content that
 * passed every gate is staged next to the destination for the atomic rename.
 */
export function promoteRelease(input: PromotionInput): { releaseDir: string } {
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

    // Consumer-path re-load happens in an owner-only directory outside any
    // worktree, so a crash mid-promotion cannot leave privacy-unvetted bytes
    // where a `git add` could commit them.
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
        loadReviewedRelease(reviewDir, { forbiddenTokens: input.forbiddenTokens });
    } catch (error) {
        rmSync(reviewDir, { recursive: true, force: true });
        throw error;
    }
    rmSync(reviewDir, { recursive: true, force: true });

    mkdirSync(input.releasesRoot, { recursive: true });
    // Unique staging directory per attempt: concurrent promotions of the same
    // version cannot swap each other's contents between the validating
    // re-load below and the rename. Only gate-passing bytes reach this point.
    const staging = mkdtempSync(join(input.releasesRoot, ".staging-"));
    try {
        for (const [name, content] of files) {
            writeFileSync(join(staging, name), content, { flag: "wx" });
        }
        // Re-load the exact directory being renamed into place, so tampering
        // with staged bytes between write and rename is still caught.
        loadReviewedRelease(staging, { forbiddenTokens: input.forbiddenTokens });
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    return { releaseDir: destination };
}
