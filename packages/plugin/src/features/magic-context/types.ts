export interface TagEntry {
    tagNumber: number;
    messageId: string;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    /**
     * A dropped tool tag's rendering policy is frozen when the tag is dropped.
     * Each replay deterministically re-derives the rendering from the original wire part.
     * `"full"` removes the entire tool call from the transcript.
     * `"truncated"` retains the `tool_use` call and replaces its output with `[dropped N]`.
     * `"truncated"` clamps every input argument value to five characters.
     * `"edit_marker"` applies when a later edit supersedes an edit or write to the same file.
     * `"edit_marker"` preserves `filePath` verbatim and a short diff region-hint prefix.
     * `"edit_marker"` identifies the edited file and region.
     * `"edit_marker"` is produced only when `smart_drops` is enabled.
     */
    dropMode: "full" | "truncated" | "edit_marker";
    toolName: string | null;
    inputByteSize: number;
    byteSize: number;
    reasoningByteSize: number;
    sessionId: string;
    /**
     * `cavemanDepth` records the compression depth applied to a tag's text part.
     * `cavemanDepth` values are 0 for none, 1 for lite, 2 for full, and 3 for ultra compression.
     * `tool` and `file` tags always use `cavemanDepth` 0.
     * The age-tier caveman heuristic avoids recompressing text already at its target depth.
     * The target caveman depth depends on the tag's age band.
     */
    cavemanDepth: number;
    /**
     * For `type: "tool"` tags, `toolOwnerMessageId` identifies the assistant message that invoked the underlying tool call.
     * A tool tag is identified by `(sessionId, messageId/callID, toolOwnerMessageId)`.
     * `toolOwnerMessageId` disambiguates repeated call IDs across turns.
     * OpenCode can reuse a per-turn `callID` in different turns.
     *
     * NULL on:
     * `toolOwnerMessageId` is `NULL` for all `type: "message"` and `type: "file"` tags.
     * Legacy tool tags can have a `NULL` `toolOwnerMessageId`.
     * The runtime assigns `toolOwnerMessageId` to legacy tool tags on first observation.
     * Plugin startup backfills missing `toolOwnerMessageId` values from the OpenCode DB.
     *
     */
    toolOwnerMessageId: string | null;
}

export interface PendingOp {
    id: number;
    sessionId: string;
    tagId: number;
    operation: "drop";
    queuedAt: number;
}

export interface SessionMeta {
    sessionId: string;
    lastResponseTime: number;
    cacheTtl: string;
    counter: number;
    lastNudgeTokens: number;
    lastNudgeBand: "far" | "near" | "urgent" | "critical" | null;
    lastTransformError: string | null;
    isSubagent: boolean;
    lastContextPercentage: number;
    lastInputTokens: number;
    observedSafeInputTokens: number;
    cacheAlertSent: boolean;
    timesExecuteThresholdReached: number;
    compartmentInProgress: boolean;
    systemPromptHash: string;
    systemPromptTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
    clearedReasoningThroughTag: number;
    toolReclaimWatermark: number;
    lastTodoState: string;
    cachedM0Bytes: Buffer | null;
    /** The cache updates `cachedM0MuralDataUrl` atomically with `cachedM0Bytes`. */
    cachedM0MuralDataUrl: string | null;
    cachedM0MuralHash: string | null;
    cachedM1Bytes: Buffer | null;
    cachedM0ClaimFormatEpoch: number | null;
    cachedM0ClaimSnapshotVector: string | null;
    cachedM0RenderedRevisionLocators: string | null;
    cachedM0ProjectMemoryEpoch: number | null;
    cachedM0WorkspaceFingerprint: string | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    /**
     * Pi uses the stored version to select its message stable-ID scheme; OpenCode ignores the version.
     * Pi's stored scheme uses `NULL` or `0` for legacy index-based `pi-msg-*` IDs and values at least `1` for real `SessionEntry` IDs.
     * The runtime forces one execute-and-materialize cutover for sessions whose stored scheme is below `PI_STABLE_ID_SCHEME`.
     */
    piStableIdScheme: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    /** HARD-bust markers signal provider-side cache eviction for system, tools, or model changes. */
    cachedM0SystemHash: string | null;
    cachedM0ToolSetHash: string | null;
    cachedM0ModelKey: string | null;
    /** The Pi-only HARD marker records project identity in the cached `m[0]` baseline. */
    cachedM0ProjectIdentity: string | null;
    lastObservedModelKey: string | null;
    lastUsageContextLimit: number;
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    protectedTailDrainWindowStartedAt: number;
    protectedTailDrainTokens: number;
    recoveryNoEligibleHeadCount: number;
    forceEmergencyBypassWindowStart: number;
    forceEmergencyBypassUsed: number;
    /** An explicit OpenCode dialog choice sets `upgradeRemindedAt` and keeps the fresh dialog dismissed. */
    upgradeRemindedAt: number | null;
    /* */
    upgradeReminderLastSentAt: number | null;
    /* */
    upgradeReminderCount: number;
}

export type SchedulerDecision = "execute" | "defer";

export interface ContextUsage {
    percentage: number;
    inputTokens: number;
}
