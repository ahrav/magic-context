import { createHash } from "node:crypto";

import type { Database } from "../../../shared/sqlite";
import { canonicalClaimMutationToken } from "../memory/claim-operation-contract";
import type {
    AutonomousManifestBinding,
    AutonomousManifestIdentity,
} from "../memory/storage-claim-autonomous";
import { recordAutonomousManifestRejectionInCurrentTransaction } from "../memory/storage-claim-autonomous";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../memory/storage-claim-current-state";
import type { ClaimEvidenceProvenance } from "../memory/storage-claim-operations";
import { getLeaseGeneration, runLeaseGuardedWrite } from "./lease";

export type DreamerMaintenanceLane = "hygiene" | "verification";

export function readDreamerProjectClaims(
    db: Database,
    projectIdentity: string,
    lane: DreamerMaintenanceLane,
): ProjectMemoryClaimSnapshot[] {
    const [projectId] = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectId === undefined) return [];
    const result = readProjectMemoryCurrentState(db, {
        projectIds: [projectId],
        lifecycleStates: ["active"],
        surface: lane === "hygiene" ? "maintenance_hygiene" : "maintenance_verification",
        workspaceEpoch: `dreamer:${lane}:${projectIdentity}`,
    });
    return result.status === "ok" ? result.items : [];
}

export function claimManifestBinding(claim: ProjectMemoryClaimSnapshot): AutonomousManifestBinding {
    return {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        contentDigest: claim.contentDigest,
        token: claim.mutationToken,
    };
}

export function sameClaimManifestBinding(
    left: AutonomousManifestBinding,
    right: AutonomousManifestBinding,
): boolean {
    return (
        left.publicClaimId === right.publicClaimId &&
        left.revisionLocator === right.revisionLocator &&
        left.contentDigest === right.contentDigest &&
        canonicalClaimMutationToken(left.token) === canonicalClaimMutationToken(right.token)
    );
}

export function refreshDreamerClaimBatch(args: {
    db: Database;
    projectIdentity: string;
    lane: DreamerMaintenanceLane;
    claims: readonly ProjectMemoryClaimSnapshot[];
}): ProjectMemoryClaimSnapshot[] {
    const current = new Map(
        readDreamerProjectClaims(args.db, args.projectIdentity, args.lane).map((claim) => [
            claim.publicClaimId,
            claim,
        ]),
    );
    return args.claims.flatMap((claim) => {
        const refreshed = current.get(claim.publicClaimId);
        return refreshed &&
            sameClaimManifestBinding(claimManifestBinding(claim), claimManifestBinding(refreshed))
            ? [refreshed]
            : [];
    });
}

export function dreamerManifestIdentity(args: {
    db: Database;
    holderId: string;
    leaseKey: string;
    parentSessionId?: string;
    task: string;
    publicClaimIds: readonly string[];
}): AutonomousManifestIdentity {
    const generation = getLeaseGeneration(args.db, args.leaseKey);
    if (generation === null) throw new Error("Dream lease generation is missing");
    const batchId = createHash("sha256")
        .update(
            [...args.publicClaimIds].sort((left, right) => left.localeCompare(right)).join("\n"),
        )
        .digest("hex")
        .slice(0, 24);
    return {
        producer: `dreamer-${args.task}`,
        task: args.task,
        runId: args.parentSessionId ?? args.holderId,
        leaseKey: args.leaseKey,
        leaseGeneration: generation,
        batchId,
    };
}

export function recordDreamerManifestRejection(args: {
    db: Database;
    holderId: string;
    leaseKey: string;
    identity: AutonomousManifestIdentity;
    rawManifest: string;
    reason: string;
}): void {
    runLeaseGuardedWrite(
        args.db,
        args.holderId,
        args.leaseKey,
        () => {
            recordAutonomousManifestRejectionInCurrentTransaction(args);
        },
        typeof args.identity.leaseGeneration === "number"
            ? args.identity.leaseGeneration
            : undefined,
    );
}

export function dreamerInferenceProvenance(args: {
    identity: AutonomousManifestIdentity;
    binding: AutonomousManifestBinding;
    sourceContent: string;
}): ClaimEvidenceProvenance {
    return {
        sourceLocator: `dreamer://${args.identity.task}/${args.binding.revisionLocator}`,
        sourceContent: args.sourceContent,
        extractor: `dreamer-${args.identity.task}`,
        extractorVersion: "direct-claims-v1",
        extractorRunId: args.identity.runId,
        independenceKey: `${args.identity.task}:${args.identity.leaseGeneration}:${args.binding.publicClaimId}`,
        sourceTrustClass: "model_inference",
    };
}
