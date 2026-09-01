import type { Database } from "../../../shared/sqlite";
import type { ClaimDerivationRelation } from "../storage-claim-memory-schema";
import {
    type ClaimMutationToken,
    computeClaimOperationRequestDigest,
    formatRevisionLocator,
} from "./claim-operation-contract";
import {
    type ClaimEffectDescriptor,
    ClaimOperationInputError,
    type ClaimOperationRunResult,
    type ClaimOperationStageOutcome,
    getProjectMemoryClaimByPublicId,
    type ProducerIdentity,
    type ProjectMemoryClaimRef,
    runClaimOperation,
    stageCreateProjectMemoryClaimInCurrentTransaction,
    stageSetProjectMemoryClaimLifecycleInCurrentTransaction,
    validateProjectMemoryMutationToken,
} from "./storage-claim-operations";
import { resolveProjectId } from "./storage-claims";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export type ClaimRelocationMode = "copy" | "move";

export interface RelocateProjectMemoryClaimsInput {
    sourceTokens: readonly ClaimMutationToken[];
    targetProjectIdentity: string;
    mode: ClaimRelocationMode;
    actor?: string;
    nowMs?: number;
}

interface DirectClaimAttributes {
    category: string;
    normalizedHash: string;
    importance: number;
    memoryScope: "project" | "ecosystem" | "universe";
    sharing: "private" | "shareable";
    expiresAt: number | null;
}

interface ValidatedRelocationSource {
    token: ClaimMutationToken;
    claim: ProjectMemoryClaimRef;
    attributes: DirectClaimAttributes;
}

function directClaimAttributes(db: Database, revisionId: number): DirectClaimAttributes {
    const row = db
        .prepare(
            `SELECT category, normalized_hash AS normalizedHash, importance,
                    memory_scope AS memoryScope, sharing, expires_at AS expiresAt
               FROM claim_memory_revision_attributes WHERE revision_id = ?`,
        )
        .get(revisionId) as DirectClaimAttributes | undefined;
    if (!row) {
        throw new ClaimOperationInputError(
            `project-memory revision ${revisionId} has no claim-memory attributes`,
        );
    }
    return row;
}

function attributesEqual(left: DirectClaimAttributes, right: DirectClaimAttributes): boolean {
    return (
        left.category === right.category &&
        left.normalizedHash === right.normalizedHash &&
        left.importance === right.importance &&
        left.memoryScope === right.memoryScope &&
        left.sharing === right.sharing &&
        left.expiresAt === right.expiresAt
    );
}

function currentLifecycleState(db: Database, claimId: number): string {
    const row = db
        .prepare("SELECT state FROM claim_memory_lifecycle_heads WHERE claim_id = ?")
        .get(claimId) as { state: string } | undefined;
    if (!row) {
        throw new ClaimOperationInputError(`project-memory claim ${claimId} has no lifecycle head`);
    }
    return row.state;
}

function activeTargetForSource(
    db: Database,
    targetProjectId: number,
    source: ValidatedRelocationSource,
): ProjectMemoryClaimRef | null {
    const row = db
        .prepare(
            `SELECT public_id AS publicClaimId
               FROM claim_memory_current_heads
               JOIN claim_public_ids USING (claim_id)
              WHERE project_id = ? AND category = ? AND normalized_hash = ?
                AND lifecycle_state = 'active'`,
        )
        .get(targetProjectId, source.attributes.category, source.attributes.normalizedHash) as
        | { publicClaimId: string }
        | undefined;
    return row ? getProjectMemoryClaimByPublicId(db, row.publicClaimId) : null;
}

function conservativeRelocationProvenance(
    source: ValidatedRelocationSource,
    targetProjectId: number,
    relation: ClaimDerivationRelation,
    producer: ProducerIdentity,
) {
    return {
        sourceLocator: `claim-derivation:${source.claim.publicClaimId}:${relation}:project:${targetProjectId}`,
        sourceContent: source.claim.content,
        extractor: "claim-relocation",
        extractorVersion: "1",
        extractorRunId: `${producer.producer}:${producer.operationKey}`,
        independenceKey: `claim-relocation:${source.claim.publicClaimId}:${targetProjectId}`,
        sourceTrustClass: "model_inference" as const,
    };
}

/**
 * A batch with a stale token stores one zero-effect receipt.
 * Targets receive fresh conservative evidence.
 * Targets receive explicit derivation lineage; source evidence, approvals, and maturity are never inherited.
 */
export function relocateProjectMemoryClaims(
    db: Database,
    producer: ProducerIdentity,
    input: RelocateProjectMemoryClaimsInput,
): ClaimOperationRunResult {
    if (input.sourceTokens.length === 0) {
        throw new ClaimOperationInputError("claim relocation requires at least one source token");
    }
    const targetProjectId = resolveProjectId(db, input.targetProjectIdentity);
    if (targetProjectId === null) {
        throw new ClaimOperationInputError(
            `unknown target project identity: ${input.targetProjectIdentity}`,
        );
    }
    const relation: ClaimDerivationRelation = input.mode === "move" ? "moved_from" : "copied_from";
    const nowMs = input.nowMs ?? Date.now();
    // The resolved actor is part of the request identity.
    // Target initialization records the resolved actor in the target's initial lifecycle event.
    // A move records the resolved actor in the source lifecycle event.
    // Reusing a producer and operation key with a different actor reports an identity conflict rather than retaining the original actor's audit records.
    const request = {
        actor: input.actor ?? producer.producer,
        mode: input.mode,
        sourceTokens: input.sourceTokens,
        targetProjectIdentity: input.targetProjectIdentity,
    };

    return runClaimOperation(
        db,
        {
            producer: producer.producer,
            operationKey: producer.operationKey,
            requestDigest: computeClaimOperationRequestDigest(request),
        },
        (): ClaimOperationStageOutcome => {
            const seen = new Set<string>();
            const sources: ValidatedRelocationSource[] = [];

            for (const token of input.sourceTokens) {
                if (seen.has(token.publicClaimId)) {
                    throw new ClaimOperationInputError(
                        `duplicate relocation source: ${token.publicClaimId}`,
                    );
                }
                seen.add(token.publicClaimId);
                const validation = validateProjectMemoryMutationToken(db, token);
                if (!validation.ok) {
                    return {
                        kind: "stale",
                        reason: `${token.publicClaimId} ${validation.stalePart}: ${validation.reason}`,
                        payload: { kind: "claim-relocation", mappings: [] },
                    };
                }
                if (validation.claim.projectId === targetProjectId) {
                    throw new ClaimOperationInputError(
                        `claim ${token.publicClaimId} already belongs to target project ${targetProjectId}`,
                    );
                }
                if (currentLifecycleState(db, validation.claim.claimId) !== "active") {
                    throw new ClaimOperationInputError(
                        `claim ${token.publicClaimId} is not active and cannot be relocated`,
                    );
                }
                sources.push({
                    token,
                    claim: validation.claim,
                    attributes: directClaimAttributes(db, validation.claim.currentRevisionId),
                });
            }

            const effects: ClaimEffectDescriptor[] = [];
            const policyRevisionIds = new Set<number>();
            const mutationTokenIds = new Set<string>();
            const mappings: Array<{
                sourceClaim: string;
                sourceRevision: string;
                targetClaim: string;
                targetRevision: string;
            }> = [];

            // The operation builds every target before retiring any move source; any failure rolls back the savepoint.
            // No move source is archived before target construction completes.
            for (const source of sources) {
                const existing = activeTargetForSource(db, targetProjectId, source);
                if (existing) {
                    const targetAttributes = directClaimAttributes(db, existing.currentRevisionId);
                    if (
                        existing.contentDigest !== source.claim.contentDigest ||
                        !attributesEqual(targetAttributes, source.attributes)
                    ) {
                        throw new ClaimOperationInputError(
                            `target dedup slot for ${source.claim.publicClaimId} is not semantically equal`,
                        );
                    }
                }

                const targetStage = stageCreateProjectMemoryClaimInCurrentTransaction(
                    db,
                    {
                        projectId: targetProjectId,
                        content: source.claim.content,
                        category: source.attributes.category,
                        importance: source.attributes.importance,
                        memoryScope: source.attributes.memoryScope,
                        sharing: source.attributes.sharing,
                        expiresAt: source.attributes.expiresAt,
                        provenance: conservativeRelocationProvenance(
                            source,
                            targetProjectId,
                            relation,
                            producer,
                        ),
                        actor: input.actor ?? producer.producer,
                    },
                    nowMs,
                );
                if (targetStage.kind !== "effects") {
                    throw new ClaimOperationInputError(
                        `target derivation for ${source.claim.publicClaimId} produced ${targetStage.kind}`,
                    );
                }
                for (const effect of targetStage.effects) {
                    effects.push({
                        ...effect,
                        effectKey: `source:${source.claim.publicClaimId}:${effect.effectKey}`,
                    });
                }
                for (const revisionId of targetStage.policyRevisionIds ?? []) {
                    policyRevisionIds.add(revisionId);
                }

                const target = activeTargetForSource(db, targetProjectId, source);
                if (!target) {
                    throw new Error(
                        `claim relocation created no target for ${source.claim.publicClaimId}`,
                    );
                }
                mutationTokenIds.add(source.claim.publicClaimId);
                mutationTokenIds.add(target.publicClaimId);

                const existingLineage = db
                    .prepare(
                        `SELECT 1 FROM claim_derivations
                          WHERE source_claim_id = ? AND target_claim_id = ? AND relation = ?`,
                    )
                    .get(source.claim.claimId, target.claimId, relation);
                if (!existingLineage) {
                    db.prepare(
                        `INSERT INTO claim_derivations
                            (source_claim_id, target_claim_id, relation, created_at)
                         VALUES (?, ?, ?, ?)`,
                    ).run(source.claim.claimId, target.claimId, relation, nowMs);
                    effects.push({
                        effectKey: `derivation:${relation}:${source.claim.publicClaimId}:${target.publicClaimId}`,
                        projectId: target.projectId,
                        claimId: target.claimId,
                        revisionId: target.currentRevisionId,
                        changeKind: "derivation",
                    });
                }

                mappings.push({
                    sourceClaim: source.claim.publicClaimId,
                    sourceRevision: formatRevisionLocator(source.claim),
                    targetClaim: target.publicClaimId,
                    targetRevision: formatRevisionLocator(target),
                });
            }

            // Move retires no source until every target and lineage row exists.
            if (input.mode === "move") {
                for (const source of sources) {
                    const lifecycleStage = stageSetProjectMemoryClaimLifecycleInCurrentTransaction(
                        db,
                        {
                            token: source.token,
                            state: "archived",
                            actor: input.actor ?? producer.producer,
                            reason: `moved to project ${targetProjectId}`,
                        },
                        nowMs,
                    );
                    if (lifecycleStage.kind !== "effects") {
                        throw new ClaimOperationInputError(
                            `source archive for ${source.claim.publicClaimId} produced ${lifecycleStage.kind}`,
                        );
                    }
                    for (const effect of lifecycleStage.effects) {
                        effects.push({
                            ...effect,
                            effectKey: `source:${source.claim.publicClaimId}:${effect.effectKey}`,
                        });
                    }
                }
            }

            return {
                kind: "effects",
                payload: {
                    kind: "claim-relocation",
                    mappings,
                    mode: input.mode,
                    targetProjectId,
                },
                effects,
                policyRevisionIds: [...policyRevisionIds],
                mutationTokenPublicClaimIds: [...mutationTokenIds],
            };
        },
        nowMs,
    );
}

export function copyProjectMemoryClaims(
    db: Database,
    producer: ProducerIdentity,
    input: Omit<RelocateProjectMemoryClaimsInput, "mode">,
): ClaimOperationRunResult {
    return relocateProjectMemoryClaims(db, producer, { ...input, mode: "copy" });
}

export function moveProjectMemoryClaims(
    db: Database,
    producer: ProducerIdentity,
    input: Omit<RelocateProjectMemoryClaimsInput, "mode">,
): ClaimOperationRunResult {
    return relocateProjectMemoryClaims(db, producer, { ...input, mode: "move" });
}
