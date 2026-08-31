export type MemoryCategory =
    | "PROJECT_RULES"
    | "ARCHITECTURE"
    | "CONFIG_VALUES"
    | "ARCHITECTURE_DECISIONS"
    | "CONSTRAINTS"
    | "CONFIG_DEFAULTS"
    | "NAMING"
    | "USER_PREFERENCES"
    | "USER_DIRECTIVES"
    | "ENVIRONMENT"
    | "WORKFLOW_RULES"
    | "KNOWN_ISSUES";

export type AntiMemoryCategory = "REJECTED_APPROACH";
/**
 */
export type WritableMemoryCategory = MemoryCategory | AntiMemoryCategory;

export type MemoryStatus = "active" | "permanent" | "archived";
export type MemoryScope = "project" | "ecosystem" | "universe";
export type VerificationStatus = "unverified" | "verified" | "stale" | "flagged";
export type MemorySourceType = "historian" | "agent" | "dreamer" | "user";

export interface Memory {
    id: number;
    projectPath: string;
    category: MemoryCategory;
    content: string;
    normalizedHash: string;
    importance: number;
    scope: MemoryScope;
    /** SQLite INTEGER boolean: 1 = shareable, 0 = private. */
    shareable: number;
    sourceSessionId: string | null;
    sourceType: MemorySourceType;
    seenCount: number;
    retrievalCount: number;
    firstSeenAt: number;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    lastRetrievedAt: number | null;
    status: MemoryStatus;
    expiresAt: number | null;
    verificationStatus: VerificationStatus;
    verifiedAt: number | null;
    supersededByMemoryId: number | null;
    mergedFrom: string | null; // JSON array
    metadataJson: string | null;
}
