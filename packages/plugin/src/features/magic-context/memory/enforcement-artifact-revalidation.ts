/**
 * Ongoing enforcement-artifact revalidation (direct claim kernel).
 *
 * ENFORCED maturity is earned by a passing evaluation of exact artifact
 * bytes; editing or deleting the recorded `canonical_path` after the fact
 * would otherwise leave the rung standing forever, because validity reads
 * only the stored `pass` result and explicit revocation events. A missing or
 * digest-drifted artifact gets a revocation event plus a policy refresh, so
 * `supportedMaturity` falls back to the revision's next supported rung. A
 * missing PROJECT ROOT is treated as "cannot judge" (checkout absent or
 * moved) and revokes nothing.
 *
 * Revocations commit through the claim operation kernel, so each one leaves
 * a durable receipt, a lifecycle effect for the module mirror, and a policy
 * generation bump that invalidates every derived cache.
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

/** Per-project throttle for the artifact-revalidation probe: rehashing every
 *  enforced artifact on every transform pass would put file I/O on the hot
 *  path for a condition (a deleted or edited artifact) that is rare. */
const artifactRevalidationLastRunMs = new Map<string, number>();
const ARTIFACT_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;
// A long-lived host cycling through many checkouts accumulates one entry per
// identity+root pair; the map is not Database-scoped (roots outlive handles),
// so cap it by evicting oldest-inserted entries instead.
const ARTIFACT_REVALIDATION_THROTTLE_MAX_ENTRIES = 512;

/** Test seam: clears the per-project throttle. */
export function __resetArtifactRevalidationThrottleForTests(): void {
    artifactRevalidationLastRunMs.clear();
}

/**
 * Re-verify that every currently valid enforcement artifact still exists on
 * disk with the recorded bytes. Throttled per identity+root; the filesystem
 * walk runs off the caller's synchronous path.
 */
export function revalidateEnforcementArtifacts(
    db: Database,
    projectIdentity: string,
    projectRoot: string,
    nowMs = Date.now(),
): void {
    if (!hasClaimPolicySchema(db)) return;
    // Canonicalize the checkout root first: enforcement records the real
    // root, and probing under a symlinked alias spelling would neither match
    // the recorded rows nor share the alias's throttle window.
    const canonicalRoot = safeRealpath(projectRoot);
    if (canonicalRoot === null) return;
    // The throttle key carries the CHECKOUT root, not just the identity:
    // worktrees and clones share one identity, artifacts are scoped by
    // enforced_from_root, and an identity-only key would let whichever
    // checkout runs first after each interval starve the others' probes.
    const throttleKey = `${projectIdentity}\u0000${canonicalRoot}`;
    const last = artifactRevalidationLastRunMs.get(throttleKey) ?? 0;
    if (nowMs - last < ARTIFACT_REVALIDATION_INTERVAL_MS) return;
    // Refresh insertion order so the cap below evicts the least-recently
    // PROBED key, then bound the map.
    artifactRevalidationLastRunMs.delete(throttleKey);
    artifactRevalidationLastRunMs.set(throttleKey, nowMs);
    while (artifactRevalidationLastRunMs.size > ARTIFACT_REVALIDATION_THROTTLE_MAX_ENTRIES) {
        const oldest = artifactRevalidationLastRunMs.keys().next().value;
        if (oldest === undefined) break;
        artifactRevalidationLastRunMs.delete(oldest);
    }
    // The filesystem walk runs OFF the caller's synchronous path AND uses
    // asynchronous reads: the probe is invoked from the transform hot path,
    // and a large artifact must not block the event loop even when the
    // deferred callback runs — each read and hash yields. The throttle
    // above already coalesces concurrent passes.
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
    // Resolve the owning root once: per-artifact containment compares live
    // resolved paths, a legitimately symlinked root must not itself read as
    // an escape, and the row selection below matches the canonical spelling
    // (what enforcement records) alongside the lexical one (legacy rows).
    // An unresolvable root leaves nothing to validate.
    let rootReal: string;
    try {
        rootReal = await realpath(projectRoot);
    } catch {
        return;
    }
    const artifacts = db
        .prepare(
            // Scoped to artifacts THIS checkout enforced: clones and
            // worktrees share the project identity, and another checkout
            // legitimately lacks or differs at the same relative path — a
            // NULL owning root (legacy row) is unjudgeable and skipped.
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
        // canonical_path is recorded project-relative and traversal-checked
        // at record time; re-guard here so a corrupted row cannot make the
        // probe hash a file outside the owning root.
        const relative = normalize(artifact.canonicalPath);
        if (isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`)) {
            continue;
        }
        const absolute = join(projectRoot, relative);
        let drifted: string | null = null;
        try {
            // The lexical guard above cannot see symlinks: the artifact or a
            // parent directory replaced by a link out of the owning root
            // would pass the join and hash an external file that happens to
            // hold the recorded bytes. Require the LIVE resolved path to
            // stay under the resolved root before trusting any digest.
            const live = await realpath(absolute);
            if (!isWithin(rootReal, live)) {
                drifted = "artifact escapes the owning root";
            } else if (!statSync(live).isFile()) {
                // A FIFO or other non-regular replacement would make the
                // streamed read below block forever waiting for a writer —
                // the pass would never reach the revoking transaction, and
                // each throttle window would strand another hung stream.
                drifted = "artifact replaced by a non-file";
            } else {
                // Streamed hash: reading AND hashing yield per chunk, so a
                // large artifact never pins the event loop. ENOENT means the
                // file is gone (a drift); any other read error is
                // indistinguishable from transient I/O.
                const digest = await sha256FileStreaming(live);
                if (digest !== artifact.bytesDigest) drifted = "artifact bytes drifted";
            }
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === "ENOENT") {
                drifted = "artifact file missing";
            } else if (code === "EISDIR" || code === "ENOTDIR" || code === "ELOOP") {
                // A path replaced by a directory, a parent replaced by a
                // file, or a symlink loop is a PERMANENT type change, not
                // transient I/O: the recorded regular file no longer exists,
                // and skipping would keep the claim ENFORCED forever on a
                // recurring error.
                drifted = "artifact replaced by a non-file";
            } else {
                continue;
            }
        }
        if (drifted === null) continue;
        const driftReason = drifted;
        try {
            // One kernel operation per revocation: the nonce makes each
            // probe's key unique (a restored artifact must be re-judged by a
            // LATER probe, so replaying an old stored outcome would be
            // wrong), while the in-transaction bytes and validity rechecks
            // below keep the revocation itself idempotent.
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
                    // Re-read the FILE inside the transaction too: an artifact
                    // edited or removed and then restored to its recorded bytes
                    // between the check above and this write must not be
                    // permanently revoked while valid — the same
                    // bytes-at-commit discipline the enforcement command applies
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
                        // ENOENT/EISDIR/ENOTDIR at commit time confirm the drift
                        // being committed (missing file or a path replaced by a
                        // non-file) — fall through to revoke, or the permanent
                        // type change would keep the claim ENFORCED on every
                        // recurring probe. Anything else is indistinguishable
                        // from transient I/O; keep the artifact and retry later.
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
                    // Re-check inside the transaction: a concurrent revocation
                    // must not be doubled. Every drifted artifact is revoked —
                    // not only the latest — because an older still-valid pass
                    // row becomes the support again the moment a newer one is
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
