export type MemoryCategory =
    // v2 world taxonomy (the 5 categories the historian emits). CONSTRAINTS and
    // NAMING are shared with the legacy set; PROJECT_RULES/ARCHITECTURE/
    // CONFIG_VALUES are new in v2.
    | "PROJECT_RULES"
    | "ARCHITECTURE"
    | "CONFIG_VALUES"
    // Legacy 9-cat taxonomy — retained as an accept-both bridge so the existing
    // memory store (pre-v2 rows) keeps full ordering/TTL/rendering until the
    // one-time recategorization migration (E3 / /ctx-session-upgrade) folds them
    // into the 5-cat set. The historian no longer emits these.
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
 * Every category an agent may NAME on a write, which is wider than the set the
 * generic claim operations accept: an anti-memory category is legal here and
 * routes to the typed anti-memory API instead.
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
