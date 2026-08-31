/**
 *
 * ENFORCED maturity requires a passing evaluation of the artifact's exact bytes.
 * Editing or deleting the recorded `canonical_path` requires revocation.
 * Validity reads only stored `pass` results and explicit revocation events.
 * A missing or digest-drifted artifact triggers revocation and a policy refresh.
 * After revocation, `supportedMaturity` falls back to the revision's next supported rung.
 * A missing project root revokes no artifacts.
 *
 * The claim operation kernel commits revocations.
 * Each revocation leaves a durable receipt and updates the module mirror lifecycle.
 * Each revocation increments the policy generation and invalidates derived caches.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { computeClaimOperationRequestDigest } from "./claim-operation-contract";
import { type ClaimOperationStageOutcome, runClaimOperation } from "./storage-claim-operations";
import {
    hasClaimPolicySchema,
    revokeEnforcementArtifactInCurrentTransaction,
} from "./storage-claim-policy";
import { isWithin, safeRealpath, sha256FileStreaming, sha256FileSync } from "./verification-paths";

/** The per-project throttle prevents rehashing enforced artifacts on every transform pass.
 * Rehashing every enforced artifact on every transform pass puts file I/O on the hot path.
 * */
const artifactRevalidationLastRunMs = new Map<string, number>();
const ARTIFACT_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;
// A long-lived host can accumulate one throttle entry per identity-and-root pair.
// The throttle map is process-scoped rather than Database-scoped.
// The map evicts the least-recently-probed key when its size exceeds the entry cap.
const ARTIFACT_REVALIDATION_THROTTLE_MAX_ENTRIES = 512;

/* */
export function __resetArtifactRevalidationThrottleForTests(): void {
    artifactRevalidationLastRunMs.clear();
}

/**
 * The function re-verifies each currently valid enforcement artifact against its recorded bytes.
 * The filesystem walk runs asynchronously rather than on the caller's synchronous path.
 */
export function revalidateEnforcementArtifacts(
    db: Database,
    projectIdentity: string,
    projectRoot: string,
    nowMs = Date.now(),
): void {
    if (!hasClaimPolicySchema(db)) return;
    // Enforcement records canonical checkout roots.
    // Symlink aliases resolve to the canonical root before row matching.
    // Symlink aliases share the canonical root's throttle window.
    const canonicalRoot = safeRealpath(projectRoot);
    if (canonicalRoot === null) return;
    // Worktrees and clones can share an identity while using separate artifact scopes.
    // An identity-only throttle key would let the first checkout suppress other checkouts' probes.
    const throttleKey = `${projectIdentity}\u0000${canonicalRoot}`;
    const last = artifactRevalidationLastRunMs.get(throttleKey) ?? 0;
    if (nowMs - last < ARTIFACT_REVALIDATION_INTERVAL_MS) return;
    // Deleting and reinserting the throttle key makes insertion order track probe recency.
    artifactRevalidationLastRunMs.delete(throttleKey);
    artifactRevalidationLastRunMs.set(throttleKey, nowMs);
    while (artifactRevalidationLastRunMs.size > ARTIFACT_REVALIDATION_THROTTLE_MAX_ENTRIES) {
        const oldest = artifactRevalidationLastRunMs.keys().next().value;
        if (oldest === undefined) break;
        artifactRevalidationLastRunMs.delete(oldest);
    }
    // The transform hot path schedules the probe asynchronously.
    // Large artifacts must not block the event loop when the deferred callback runs.
    // Each read and hash yields so large artifacts do not block the event loop.
    // The throttle suppresses new probes for ARTIFACT_REVALIDATION_INTERVAL_MS after each scheduled run.
    void revalidateEnforcementArtifactsNow(db, projectIdentity, projectRoot, nowMs).catch(
        (error) => {
            log(
                `[claim-policy] artifact revalidation failed (retrying on a later probe): ${error instanceof Error ? error.message : String(error)}`,
            );
        },
    );
}

async function revalidateEnforcementArtifactsNow(
    db: Database,
    projectIdentity: string,
    projectRoot: string,
    nowMs: number,
): Promise<void> {
    if (!existsSync(projectRoot)) return;
    const projectRow = db
        .prepare("SELECT id FROM projects WHERE canonical_identity = ?")
        .get(projectIdentity) as { id: number } | null | undefined;
    if (!projectRow) return;
    // The resolved project root keeps containment checks on resolved paths.
    // Resolved containment permits a symlinked project root.
    // The query matches resolved and lexical root spellings.
    // Legacy rows use the lexical root spelling.
    let rootReal: string;
    try {
        rootReal = await realpath(projectRoot);
    } catch {
        return;
    }
    const artifacts = db
        .prepare(
            // The query excludes artifacts enforced from other checkouts.
            // Clones and worktrees share project identity.
            // Another checkout can differ at the same relative path.
            `SELECT artifact.id AS id, artifact.revision_id AS revisionId,
                    artifact.canonical_path AS canonicalPath,
                    artifact.bytes_digest AS bytesDigest,
                    claim_revisions.claim_id AS claimId,
                    claims.project_id AS projectId,
                    claim_public_ids.public_id AS publicClaimId
               FROM claim_enforcement_artifacts artifact
               JOIN claim_revisions ON claim_revisions.id = artifact.revision_id
               JOIN claims ON claims.id = claim_revisions.claim_id
               JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id
              WHERE artifact.project_id = ?
                AND artifact.evaluator_result = 'pass'
                AND artifact.enforced_from_root IN (?, ?)
                AND NOT EXISTS (
                    SELECT 1 FROM claim_enforcement_artifact_events event
                    WHERE event.artifact_id = artifact.id AND event.action = 'revoked'
                )`,
        )
        .all(projectRow.id, projectRoot, rootReal) as Array<{
        id: number;
        revisionId: number;
        canonicalPath: string;
        bytesDigest: string;
        claimId: number;
        projectId: number;
        publicClaimId: string;
    }>;
    for (const artifact of artifacts) {
        // The validator ignores canonical paths that lexically escape the owning root.
        const relative = normalize(artifact.canonicalPath);
        if (isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`)) {
            continue;
        }
        const absolute = join(projectRoot, relative);
        let drifted: string | null = null;
        try {
            // Lexical checks do not detect symlinks.
            // A symlinked artifact or parent can escape the owning root.
            // Such a path could hash an external file with the recorded bytes.
            const live = await realpath(absolute);
            if (!isWithin(rootReal, live)) {
                drifted = "artifact escapes the owning root";
            } else if (!statSync(live).isFile()) {
                // FIFO reads can block indefinitely, so the validator rejects non-regular files.
                // A blocked read prevents the revoking transaction from running.
                drifted = "artifact replaced by a non-file";
            } else {
                // ENOENT denotes an absent artifact, so the validator treats it as drift.
                // The validator treats read errors other than ENOENT, EISDIR, ENOTDIR, and ELOOP as transient because their causes are unknown.
                const digest = await sha256FileStreaming(live);
                if (digest !== artifact.bytesDigest) drifted = "artifact bytes drifted";
            }
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === "ENOENT") {
                drifted = "artifact file missing";
            } else if (code === "EISDIR" || code === "ENOTDIR" || code === "ELOOP") {
                // A path replaced by a directory, a parent replaced by a file, or a symlink loop means the recorded regular file is absent, not unreadable due to transient I/O.
                // Revoking prevents a path-type change from leaving the claim ENFORCED.
                // recurring error.
                drifted = "artifact replaced by a non-file";
            } else {
                continue;
            }
        }
        if (drifted === null) continue;
        const driftReason = drifted;
        try {
            // Each probe uses a unique operationKey so a restored artifact is re-judged.
            // Replaying a prior outcome could skip revalidation after an artifact is restored.
            const operation = runClaimOperation(
                db,
                {
                    producer: "artifact-revalidation",
                    operationKey: `revoke:${artifact.id}:${randomUUID()}`,
                    requestDigest: computeClaimOperationRequestDigest({
                        action: "revoke-drifted-artifact",
                        artifactId: artifact.id,
                        bytesDigest: artifact.bytesDigest,
                        reason: driftReason,
                        revisionId: artifact.revisionId,
                    }),
                },
                (): ClaimOperationStageOutcome => {
                    // The transaction re-reads the file to avoid revoking an artifact restored to its recorded bytes.
                    // before recording.
                    try {
                        const live = realpathSync(absolute);
                        if (
                            isWithin(rootReal, live) &&
                            statSync(live).isFile() &&
                            sha256FileSync(live) === artifact.bytesDigest
                        ) {
                            return { kind: "noop", payload: { restored: true } };
                        }
                    } catch (error) {
                        // ENOENT, EISDIR, ENOTDIR, and ELOOP permit revocation.
                        // The validator revokes path-type changes so recurring probes cannot leave the claim ENFORCED.
                        const code = (error as { code?: string } | null)?.code;
                        if (
                            code !== "ENOENT" &&
                            code !== "EISDIR" &&
                            code !== "ENOTDIR" &&
                            code !== "ELOOP"
                        ) {
                            return { kind: "noop", payload: { transientIo: true } };
                        }
                    }
                    // The validator revokes every drifted artifact because an older valid pass can support the claim after a newer pass is revoked.
                    // revoked.
                    const stillValid = db
                        .prepare(
                            `SELECT 1 FROM claim_enforcement_artifacts artifact
                              WHERE artifact.id = ?
                                AND NOT EXISTS (
                                    SELECT 1 FROM claim_enforcement_artifact_events event
                                    WHERE event.artifact_id = artifact.id
                                      AND event.action = 'revoked'
                                )`,
                        )
                        .get(artifact.id);
                    if (!stillValid) return { kind: "noop", payload: { alreadyRevoked: true } };
                    revokeEnforcementArtifactInCurrentTransaction(
                        db,
                        artifact.id,
                        `revalidation: ${driftReason}`,
                        nowMs,
                    );
                    return {
                        kind: "effects",
                        payload: { revokedArtifactId: artifact.id },
                        effects: [
                            {
                                effectKey: `policy:${artifact.publicClaimId}:enforcement`,
                                projectId: artifact.projectId,
                                claimId: artifact.claimId,
                                revisionId: artifact.revisionId,
                                changeKind: "lifecycle",
                            },
                        ],
                        policyRevisionIds: [artifact.revisionId],
                    };
                },
                nowMs,
            );
            if (operation.outcome === "applied") {
                log(
                    `[claim-policy] revoked enforcement artifact ${artifact.id} for revision ${artifact.revisionId}: ${driftReason}`,
                );
            }
        } catch (error) {
            log(
                `[claim-policy] artifact revalidation revoke failed (retrying on a later probe): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
