/**
 * Shared types for RPC between server and TUI plugins.
 * Both sides import these — no SQLite dependency.
 */

import type {
    DreamTaskBacklogMap,
    DreamTaskProgress,
} from "../features/magic-context/dreamer/task-registry";
import type { SnapshotVector } from "../features/magic-context/memory/claim-operation-contract";
import type { LoggerDiagnostics } from "./logger";

export interface TailHygieneStatus {
    /** Tokens in active, non-protected tail content that the agent can reclaim. */
    u: number;
    /** Tokens in rendered-tail content eligible for hygiene accounting in the same scan. */
    t: number;
    /** Reclaimable-to-eligible token ratio, clamped to 0–1 and shared by both nudge mechanisms. */
    severity: number;
    /** False until a fresh scan runs after existing tail content changes, preventing stale measurements. */
    evaluable: boolean;
    generationInvalidated: boolean;
    baselineGeneration: number;
    computedAt: number;
}

export interface SidebarSnapshot {
    sessionId: string;
    usagePercentage: number;
    inputTokens: number;
    contextLimit: number;
    /**
     * native_context_usage_percentage measures raw wire-input pressure against the resolved model window, independent of Magic Context's execute threshold.
     */
    native_context_usage_percentage?: number;
    /**
     * compaction_enabled is resolved at startup and sent in the status-detail wire payload.
     * The status-detail payload uses snake_case field names.
     */
    compaction_enabled?: boolean;
    systemPromptTokens: number;
    compartmentCount: number;
    /** Historical compartment rows retained while native compaction owns the window. */
    archivedCompartmentCount?: number;
    memoryCount: number;
    memoryClaims: Array<{ publicClaimId: string; revisionLocator: string }>;
    memorySnapshotVector: SnapshotVector | null;
    memoryBlockCount: number;
    pendingOpsCount: number;
    historianRunning: boolean;
    compartmentInProgress: boolean;
    sessionNoteCount: number;
    readySmartNoteCount: number;
    cacheTtl: string;
    /** Persistent runtime failure shown directly in the sidebar when non-null. */
    lastTransformError: string | null;
    lastDreamerRunAt: number | null;
    projectIdentity: string | null;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    /**
     * docsTokens estimates the injected <project-docs> block from root ARCHITECTURE.md and STRUCTURE.md in m[0].
     */
    docsTokens: number;
    /**
     * profileTokens estimates injected promoted user memories in the <user-profile> block in m[0].
     */
    profileTokens: number;
    /**
     * conversationTokens estimates user and assistant text, reasoning, and image content excluding injected session-history, project-docs, and user-profile blocks.
     * "Conversation".
     */
    conversationTokens: number;
    /**
     * toolCallTokens estimates tool call I/O in tool_use, tool_result, tool, and tool-invocation parts.
     */
    toolCallTokens: number;
    /**
     * toolDefinitionTokens measures request `tools` schema tokens keyed by `{providerID, modelID, agentName}` and remains zero until the first measured turn.
     */
    toolDefinitionTokens: number;
    /** Persisted reclaimable (U) and eligible (T) token counts used by both nudge mechanisms. */
    tailHygiene?: TailHygieneStatus;
    /**
     * `executeThreshold` is the effective execute-threshold percentage for the active model.
     * `execute_threshold_tokens` is converted to a percentage after per-model resolution.
     * `executeThreshold` appears beside `usagePercentage` in the sidebar and status dialog.
     * `executeThreshold` lets users compare usage with the compaction threshold.
     * `executeThreshold` defaults to `65` when no live model is known.
     * The scheduler and transform paths default `executeThreshold` to `65` when no live model is known.
     */
    executeThreshold: number;
    /**
     * The clamp flag is true when `executeThreshold` is reduced to the 90% cap.
     * The clamp applies above 90% of `contextLimit`, whether configured in tokens or as a percentage.
     * The sidebar and status dialog mark values clamped below the configured threshold.
     * The marker is absent when no clamp occurred.
     */
    executeThresholdClamped?: boolean;
    /** The session exposes Rust module cache boundary state only in Rust authority mode. */
    boundaryPresent?: boolean;
    coverageOrdinal?: number | null;
    newWorkTokens?: number | null;
    totalInputTokens?: number | null;
    /**
     * The session reports live recomp or session-upgrade progress; otherwise it reports null.
     */
    /* */
    dreamerBacklog?: DreamTaskBacklogMap;
    /** Dreamer task progress; absent or null when no Dreamer task is running. */
    dreamerProgress?: DreamTaskProgress | null;
    recompProgress?: {
        /* */
        kind?: "recomp" | "upgrade" | "embed" | "wrapup";
        phase: "recomp" | "migration" | "done" | "failed" | "skipped";
        processedMessages: number;
        totalMessages: number;
        passCount: number;
        compartmentsCreated: number;
        message?: string;
        note?: string;
    } | null;
}

export interface StatusDetail extends SidebarSnapshot {
    tagCounter: number;
    activeTags: number;
    droppedTags: number;
    totalTags: number;
    activeBytes: number;
    lastResponseTime: number;
    lastNudgeTokens: number;
    lastTransformError: string | null;
    isSubagent: boolean;
    pendingOps: Array<{ tagId: number; operation: string }>;
    contextLimit: number;
    windowGeometry?: {
        usableSoft: number;
        usableHard: number;
        geometry: "shared_upfront" | "shared_truncating" | "separate";
        derivation: {
            window: number;
            reserve: number;
            reserveSource: "output_catalog" | "output_config" | "wall_margin" | "none";
            geometry: "shared_upfront" | "shared_truncating" | "separate";
        };
    };
    /**
     * cacheTtlMs uses -1 for cacheTtl "never".
     * JSON-RPC cannot represent Infinity, and 0 means unset.
     * -1 represents never expiration without relying on `cacheNeverExpires`.
     */
    cacheTtlMs: number;
    /** cacheRemainingMs is the remaining idle-TTL duration: -1 means never expires and 0 means expired.
     * A value of 0 means expired only when lastResponseTime > 0; positive values count down. */
    cacheRemainingMs: number;
    cacheExpired: boolean;
    /** cacheNeverExpires is true when cacheTtl is "never" and disables the idle-TTL heuristic.
     * cacheNeverExpires duplicates `cacheTtlMs === -1` for readability. */
    cacheNeverExpires?: boolean;
    executeThreshold: number;
    /**
     * executeThresholdMode identifies the config source that produced executeThreshold.
     * Tokens mode applies when execute_threshold_tokens matches the session model.
     * Tokens mode converts execute_threshold_tokens to a percentage; percentage mode uses percentage config.
     */
    executeThresholdMode: "percentage" | "tokens";
    /**
     * `executeThresholdTokens` is the token threshold (≤ 80% × `contextLimit`) that triggers execution; it is undefined in percentage mode.
     */
    executeThresholdTokens?: number;
    protectedTagCount: number;
    historyBudgetPercentage: number;
    historyBlockTokens: number;
    compressionBudget: number | null;
    compressionUsage: string | null;
    /** toastDurationMs is the effective configured toast duration in ms after config resolution. */
    toastDurationMs: number;
    /* */
    mural?: { present: boolean; ageMs: number | null };
    /** loggerDiagnostics records runtime logger write failures observed by this plugin process. */
    loggerDiagnostics: LoggerDiagnostics;
    /**
     * Field names use snake_case, mirroring the `storage_versions` block of the mc-module status envelope.
     * `storage_versions` mirrors the mc-module status envelope so fleet probes use one shape across both surfaces.
     * The plugin status surface supplies the live context.db value because the mc-module cannot read context.db.
     * The mc-module status surface supplies the module-store value instead of the live context.db value.
     */
    storage_versions: {
        /**
         * context_db_schema_version is the persisted context.db schema version: MAX(schema_migrations).
         * null means the version probe failed because the read threw.
         * A successful probe on a fresh DB without a migrations table returns 0.
         * Distinct null and 0 values prevent fleet readers from conflating a failed probe with an empty database.
         */
        context_db_schema_version: number | null;
        /** plugin_supported_version is the highest context.db schema version this plugin build supports. */
        plugin_supported_version: number;
    };
}

/** EmbedDetail mirrors getEmbeddingCoverageStatus for `/ctx-embed` status. */
export interface EmbedDetail {
    enabled: boolean;
    model: string;
    provider: string;
    session: { embedded: number; total: number };
    commits: { embedded: number; total: number; gitEnabled: boolean };
    statusText: string;
}

export interface RpcNotificationMessage {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}
