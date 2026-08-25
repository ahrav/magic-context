import type { Database } from "../../../shared/sqlite";
import { isInTransaction } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants";
import { computeNormalizedHash } from "./normalize-hash";
import {
    computeClaimOperationRequestDigest,
    type CanonicalJsonValue,
} from "./claim-operation-contract";
import {
    type ClaimOperationStageOutcome,
    runClaimOperationInCurrentTransaction,
    stageCreateProjectMemoryClaimInCurrentTransaction,
} from "./storage-claim-operations";
import { ensureProject } from "./storage-claims";
import type { MemoryCategory } from "./types";

interface SessionFact {
    category: string;
    content: string;
}

export interface HistorianPromotionIdentity {
    producer: "opencode-historian" | "pi-historian" | "test-historian";
    runId: string;
    leaseGeneration: string | number;
    batchId: string;
}

export interface PromotedMemoryRef {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    content: string;
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.includes(category as MemoryCategory);
}

function resolveExpiresAt(category: MemoryCategory, nowMs: number): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : nowMs + ttl;
}

function mergeStages(outcomes: readonly ClaimOperationStageOutcome[]): ClaimOperationStageOutcome {
    const effects = outcomes.flatMap((outcome) => (outcome.kind === "effects" ? outcome.effects : []));
    if (effects.length === 0) return { kind: "noop", payload: { claims: [] } };
    return {
        kind: "effects",
        payload: { claims: outcomes.map((outcome) => outcome.payload ?? null) },
        effects,
        policyRevisionIds: [
            ...new Set(
                outcomes.flatMap((outcome) =>
                    outcome.kind === "effects" ? (outcome.policyRevisionIds ?? []) : [],
                ),
            ),
        ],
    };
}

function refsFromPayload(payload: CanonicalJsonValue): PromotedMemoryRef[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const claims = (payload as { claims?: unknown }).claims;
    if (!Array.isArray(claims)) return [];
    const refs: PromotedMemoryRef[] = [];
    for (const item of claims) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const claim = (item as { claim?: unknown }).claim;
        if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
        const row = claim as Record<string, unknown>;
        if (
            typeof row.publicClaimId !== "string" ||
            typeof row.revisionLocator !== "string" ||
            typeof row.contentDigest !== "string"
        ) {
            continue;
        }
        refs.push({
            publicClaimId: row.publicClaimId,
            revisionLocator: row.revisionLocator,
            contentDigest: row.contentDigest,
            content: "",
        });
    }
    return refs;
}

/** This function joins an active transaction or creates one for the promotion. */
export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectIdentity: string,
    facts: SessionFact[],
    identity: HistorianPromotionIdentity = {
        producer: "test-historian",
        runId: sessionId,
        leaseGeneration: "test",
        batchId: "default",
    },
): PromotedMemoryRef[] {
    const apply = (): PromotedMemoryRef[] => {
        const nowMs = Date.now();
        const projectId = ensureProject(db, projectIdentity);
        const seen = new Set<string>();
        const promotable = facts.filter((fact) => {
            if (!isPromotableCategory(fact.category) || !fact.content.trim()) return false;
            const key = `${fact.category}:${computeNormalizedHash(fact.content)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const operation = runClaimOperationInCurrentTransaction(
            db,
            {
                producer: identity.producer,
                operationKey: [
                    "publish",
                    identity.runId,
                    String(identity.leaseGeneration),
                    identity.batchId,
                ].join(":"),
                requestDigest: computeClaimOperationRequestDigest({
                    batchId: identity.batchId,
                    facts: promotable.map((fact) => ({
                        category: fact.category,
                        content: fact.content,
                    })),
                    leaseGeneration: String(identity.leaseGeneration),
                    operation: "historian-promote-project-memory",
                    projectId,
                    runId: identity.runId,
                    sessionId,
                }),
            },
            () =>
                mergeStages(
                    promotable.map((fact, index) =>
                        stageCreateProjectMemoryClaimInCurrentTransaction(
                            db,
                            {
                                projectId,
                                content: fact.content,
                                category: fact.category,
                                expiresAt: resolveExpiresAt(fact.category as MemoryCategory, nowMs),
                                provenance: {
                                    sourceLocator: `historian://${identity.producer}/${sessionId}/${identity.batchId}/${index}`,
                                    sourceContent: fact.content,
                                    sourceSessionId: sessionId,
                                    extractor: "historian",
                                    extractorVersion: "direct-claims-v1",
                                    extractorRunId: identity.runId,
                                    independenceKey: `${identity.producer}:${identity.runId}:${index}`,
                                    sourceTrustClass: "model_inference",
                                },
                                actor: identity.producer,
                                nowMs,
                            },
                            nowMs,
                        ),
                    ),
                ),
            nowMs,
        );
        const refs = refsFromPayload(operation.result.payload);
        for (let index = 0; index < refs.length; index += 1) {
            refs[index].content = promotable[index]?.content ?? "";
        }
        return refs;
    };

    return isInTransaction(db) ? apply() : db.transaction(apply).immediate();
}

export async function embedPromotedFacts(): Promise<void> {}
