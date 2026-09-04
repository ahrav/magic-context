import type { Database } from "../../../shared/sqlite";
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
export declare function promoteSessionFactsDurable(db: Database, sessionId: string, projectIdentity: string, facts: readonly SessionFact[], identity: HistorianPromotionIdentity): PromotedMemoryRef[];
export {};
//# sourceMappingURL=promotion.d.ts.map