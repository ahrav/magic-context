import type { Database } from "../../../shared/sqlite";
import { isInTransaction } from "../../../shared/sqlite";
import type { CanonicalJsonValue } from "./claim-operation-contract";
import { V2_MEMORY_CATEGORIES } from "./constants";
import {
    type AutonomousManifestIdentity,
    runAutonomousCreationManifestInCurrentTransaction,
} from "./storage-claim-autonomous";
import { stageCreateProjectMemoryClaimInCurrentTransaction } from "./storage-claim-operations";
import { ensureProject, sha256Utf8Hex } from "./storage-claims";
import type { MemoryCategory } from "./types";

interface SessionFact {
    category: string;
    content: string;
}

export interface HistorianPromotionIdentity {
    producer: "opencode-historian" | "pi-historian" | "test-historian";
    runId: string;
    leaseKey: string;
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
    return V2_MEMORY_CATEGORIES.includes(category as (typeof V2_MEMORY_CATEGORIES)[number]);
}

function assertIdentity(identity: HistorianPromotionIdentity): void {
    if (
        !identity.producer ||
        !identity.runId ||
        !identity.leaseKey ||
        !identity.batchId ||
        (typeof identity.leaseGeneration === "number"
            ? !Number.isSafeInteger(identity.leaseGeneration) || identity.leaseGeneration < 1
            : identity.leaseGeneration.length === 0)
    ) {
        throw new Error("historian promotion identity is incomplete");
    }
}

function refsFromPayload(payload: CanonicalJsonValue): PromotedMemoryRef[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const items = (payload as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    const refs: PromotedMemoryRef[] = [];
    for (const item of items) {
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

export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectIdentity: string,
    facts: readonly SessionFact[],
    identity: HistorianPromotionIdentity,
): PromotedMemoryRef[] {
    assertIdentity(identity);
    const seen = new Set<string>();
    const promotable = facts.flatMap((fact) => {
        const content = fact.content.trim();
        if (!isPromotableCategory(fact.category) || !content) return [];
        const key = `${fact.category}:${sha256Utf8Hex(content)}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ category: fact.category, content }];
    });

    const apply = (): PromotedMemoryRef[] => {
        const projectId = ensureProject(db, projectIdentity);
        const manifestIdentity: AutonomousManifestIdentity = {
            ...identity,
            task: "historian-promotion",
        };
        const operation = runAutonomousCreationManifestInCurrentTransaction({
            db,
            identity: manifestIdentity,
            items: promotable.map((fact, index) => ({
                key: {
                    category: fact.category,
                    contentDigest: sha256Utf8Hex(fact.content),
                    index,
                },
                value: { ...fact, index },
            })),
            manifest: promotable.map((fact) => ({
                category: fact.category,
                content: fact.content,
            })),
            resultSummary: { promotableFacts: promotable.length },
            stageItem: (database, item, nowMs) =>
                stageCreateProjectMemoryClaimInCurrentTransaction(
                    database,
                    {
                        projectId,
                        content: item.value.content,
                        category: item.value.category,
                        provenance: {
                            sourceLocator: `historian://${identity.producer}/${sessionId}/${identity.batchId}/${item.value.index}`,
                            sourceContent: item.value.content,
                            sourceSessionId: sessionId,
                            extractor: "historian",
                            extractorVersion: "direct-claims-v1",
                            extractorRunId: identity.runId,
                            independenceKey: `${identity.producer}:${identity.runId}:${item.value.index}`,
                            sourceTrustClass: "model_inference",
                        },
                        actor: identity.producer,
                        nowMs,
                    },
                    nowMs,
                ),
        });
        const refs = refsFromPayload(operation.operation.result.payload);
        for (let index = 0; index < refs.length; index += 1) {
            refs[index].content = promotable[index]?.content ?? "";
        }
        return refs;
    };

    return isInTransaction(db) ? apply() : db.transaction(apply).immediate();
}
