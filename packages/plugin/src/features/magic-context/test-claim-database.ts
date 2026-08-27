import type { Database } from "../../shared/sqlite";
import type { ClaimMutationToken } from "./memory/claim-operation-contract";
import {
    type ClaimEvidenceProvenance,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
} from "./memory/storage-claim-operations";
import { ensureProject } from "./memory/storage-claims";
import type { MemoryScope } from "./memory/types";
import type { ClaimMemorySharing } from "./storage-claim-memory-schema";
import { createDirectTestDatabase } from "./test-database";

export function createClaimReaderTestDatabase(): Database {
    return createDirectTestDatabase().db;
}

export interface SeedProjectMemoryClaimArgs {
    projectIdentity: string;
    content: string;
    category?: string;
    importance?: number;
    memoryScope?: MemoryScope;
    sharing?: ClaimMemorySharing;
    expiresAt?: number | null;
    operationKey?: string;
    actor?: string;
    provenance?: Partial<ClaimEvidenceProvenance>;
}

export interface SeededProjectMemoryClaim {
    projectId: number;
    publicClaimId: string;
    revisionLocator: string;
    revision: number;
    contentDigest: string;
    token: ClaimMutationToken;
}

let seedCounter = 0;

export function seedProjectMemoryClaim(
    db: Database,
    args: SeedProjectMemoryClaimArgs,
): SeededProjectMemoryClaim {
    seedCounter += 1;
    const operationKey = args.operationKey ?? `seed-claim-${seedCounter}`;
    const projectId = ensureProject(db, args.projectIdentity);
    const result = createProjectMemoryClaim(
        db,
        { producer: "test-seed", operationKey },
        {
            projectId,
            content: args.content,
            category: args.category ?? "ARCHITECTURE",
            ...(args.importance === undefined ? {} : { importance: args.importance }),
            ...(args.memoryScope === undefined ? {} : { memoryScope: args.memoryScope }),
            ...(args.sharing === undefined ? {} : { sharing: args.sharing }),
            ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
            provenance: {
                sourceLocator: `transcript://seed/${operationKey}`,
                sourceContent: `seed source for ${operationKey}`,
                extractor: "historian",
                extractorVersion: "1",
                extractorRunId: `run-${operationKey}`,
                independenceKey: `ik-${operationKey}`,
                sourceTrustClass: "explicit_user",
                ...args.provenance,
            },
            actor: args.actor ?? "user:test",
        },
    );
    const payload = result.result.payload as {
        claim: {
            publicClaimId: string;
            revisionLocator: string;
            revision: number;
            contentDigest: string;
        };
    };
    return {
        projectId,
        publicClaimId: payload.claim.publicClaimId,
        revisionLocator: payload.claim.revisionLocator,
        revision: payload.claim.revision,
        contentDigest: payload.claim.contentDigest,
        token: computeProjectMemoryMutationToken(db, payload.claim.publicClaimId),
    };
}
