import { createHash } from "node:crypto";

import type { Database } from "../../../shared/sqlite";
import type {
    AutonomousManifestBinding,
    AutonomousManifestIdentity,
} from "../memory/storage-claim-autonomous";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
    type ProjectMemoryClaimSnapshot,
} from "../memory/storage-claim-current-state";
import type { ClaimEvidenceProvenance } from "../memory/storage-claim-operations";
import { getLeaseGeneration } from "./lease";

export function readDreamerProjectClaims(
    db: Database,
    projectIdentity: string,
): ProjectMemoryClaimSnapshot[] {
    const [projectId] = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectId === undefined) return [];
    const result = readProjectMemoryCurrentState(db, {
        projectIds: [projectId],
        lifecycleStates: ["active"],
        surface: "explicit_search",
        workspaceEpoch: `dreamer:${projectIdentity}`,
    });
    return result.status === "ok" ? result.items : [];
}

export function claimManifestBinding(
    claim: ProjectMemoryClaimSnapshot,
): AutonomousManifestBinding {
    return {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        contentDigest: claim.contentDigest,
        token: claim.mutationToken,
    };
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
        .update([...args.publicClaimIds].sort((left, right) => left.localeCompare(right)).join("\n"))
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
