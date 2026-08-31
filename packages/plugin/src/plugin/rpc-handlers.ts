/**
 */
import { isCompactionEnabled } from "../config/agent-disable";
import type { MagicContextConfig } from "../config/schema/magic-context";
import { getMostRecentTaskRunAt } from "../features/magic-context/dreamer/storage-task-schedule";
import { getDreamTaskBacklogs } from "../features/magic-context/dreamer/task-gates";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskBacklogMap,
} from "../features/magic-context/dreamer/task-registry";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { getMural } from "../features/magic-context/mural/storage-mural";
import { getEmbeddingCoverageStatus } from "../features/magic-context/project-embedding-registry";
import { parseCacheTtl } from "../features/magic-context/scheduler";
import {
    type ContextDatabase as Database,
    openDatabase,
    setSessionWorkMetrics,
} from "../features/magic-context/storage";
import {
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "../features/magic-context/storage-db";
import { getMeasuredToolDefinitionTokens } from "../features/magic-context/tool-definition-tokens";
import {
    computeOpenCodeWorkMetricsIncremental,
    emptyWorkMetricsCarry,
    type WorkMetricsCarry,
} from "../features/magic-context/work-metrics";
import { getEmbedDrainUiStatus } from "../hooks/magic-context/embed-session-state";
import {
    resolveContextLimit,
    resolveContextWindowGeometry,
    resolveExecuteThresholdDetail,
} from "../hooks/magic-context/event-resolvers";
import { formatEmbedStatusText } from "../hooks/magic-context/format-embed-status";
import { getLiveNotificationParams } from "../hooks/magic-context/hook-handlers";
import { readProjectClaimLaneSnapshot } from "../hooks/magic-context/inject-compartments";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import { computeM0BlockTokens } from "../hooks/magic-context/m0-token-breakdown";
import {
    findLastAssistantModelFromOpenCodeDb,
    openCodeDbExists,
    withReadOnlySessionDb,
} from "../hooks/magic-context/read-session-db";
import type { ManagedRecompContext } from "../hooks/magic-context/recomp-orchestrator";
import type { RustModeModuleClient } from "../hooks/magic-context/rust-mode-transform";
import {
    calibrateBuckets,
    resolveModelCalibration,
} from "../hooks/magic-context/tokenizer-calibration";
import {
    ANNOUNCEMENT_FEATURES,
    ANNOUNCEMENT_FOOTER,
    ANNOUNCEMENT_VERSION,
    markAnnouncementSeen,
    shouldShowAnnouncement,
} from "../shared/announcement";
import { getLoggerDiagnostics, log } from "../shared/logger";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
import {
    resolveTailHygieneStatus,
    type WireTailHygieneBaseline,
} from "../shared/tail-hygiene-status";
import { applyStickySnapshotCache } from "./sidebar-snapshot-cache";

// Each poll processes only assistant rows newer than its watermark because the long-lived RPC server retains each session's carry across polls.
// A restart discards the in-memory carry; the next poll cold-starts from persisted session metadata.
const workMetricsCarryBySession = new Map<string, WorkMetricsCarry>();
const RUST_STATUS_CACHE_TTL_MS = 2_000;
export interface RustSessionStatus {
    usage?: { current_total_input_tokens?: number; context_limit_tokens?: number };
    tail_hygiene?: WireTailHygieneBaseline | null;
    boundary_present?: boolean;
    coverage_ordinal?: number | null;
    compartment_count?: number;
    compartment_tokens?: number;
    pending_drop_count?: number;
    tag_count?: number;
    pending_m1_delta?: boolean;
    pending_m1_age_ms?: number | null;
    wrapup_active?: boolean;
    wrapup_rounds?: number | null;
}
const rustStatusCache = new Map<string, { status: RustSessionStatus; cachedAt: number }>();

/**
 * When OpenCode's DB is unavailable or unreadable, the sidebar returns the persisted fallback.
 */
function resolveSidebarWorkMetrics(
    db: Database,
    sessionId: string,
    persistedNewWork: number,
    persistedTotalInput: number,
): { newWorkTokens: number; totalInputTokens: number } {
    if (!openCodeDbExists()) {
        return { newWorkTokens: persistedNewWork, totalInputTokens: persistedTotalInput };
    }
    try {
        const carry = workMetricsCarryBySession.get(sessionId) ?? emptyWorkMetricsCarry();
        const { carry: nextCarry, metrics } = withReadOnlySessionDb((openCodeDb) =>
            computeOpenCodeWorkMetricsIncremental(openCodeDb, sessionId, carry),
        );
        workMetricsCarryBySession.set(sessionId, nextCarry);
        // The handler writes the fresh value through so the sidebar can warm-start after a restart.
        try {
            setSessionWorkMetrics(db, sessionId, metrics.newWorkTokens, metrics.totalInputTokens);
        } catch {
            // A failed persistence write does not prevent returning the in-memory value.
        }
        return metrics;
    } catch {
        return { newWorkTokens: persistedNewWork, totalInputTokens: persistedTotalInput };
    }
}

function getDb(): Database | null {
    try {
        return openDatabase();
    } catch {
        return null;
    }
}

async function loadRustSessionStatus(
    client: RustModeModuleClient | undefined,
    sessionId: string,
    directory: string,
): Promise<RustSessionStatus | undefined> {
    if (!client) return undefined;
    const cached = rustStatusCache.get(sessionId);
    if (cached && Date.now() - cached.cachedAt < RUST_STATUS_CACHE_TTL_MS) {
        return cached.status;
    }
    try {
        const response = await client.call({
            sessionId,
            projectRoot: directory,
            method: "session.status",
            body: { method: "session.status", v: 1, session_id: sessionId },
        });
        const raw =
            response && typeof response === "object" ? (response as Record<string, unknown>) : {};
        const value =
            raw.result && typeof raw.result === "object"
                ? (raw.result as Record<string, unknown>)
                : raw;
        if (value.error || value.ok === false) return undefined;
        const status = value as RustSessionStatus;
        rustStatusCache.set(sessionId, { status, cachedAt: Date.now() });
        return status;
    } catch (error) {
        log(`[rpc] Rust session.status unavailable for ${sessionId}:`, error);
        return undefined;
    }
}

function safeParseTtl(ttl: string): number {
    try {
        return parseCacheTtl(ttl);
    } catch {
        return 5 * 60 * 1000;
    }
}

function resolveConfigValue<T>(
    cfg: Record<string, unknown> | undefined,
    key: string,
    modelKey: string | undefined,
    defaultValue: T,
): T {
    if (!cfg) return defaultValue;
    const val = cfg[key];
    if (typeof val === typeof defaultValue) return val as T;
    if (val && typeof val === "object") {
        const obj = val as Record<string, T>;
        if (modelKey && obj[modelKey] !== undefined) return obj[modelKey];
        if (modelKey) {
            const bare = modelKey.split("/").slice(1).join("/");
            if (bare && obj[bare] !== undefined) return obj[bare];
        }
        if (obj.default !== undefined) return obj.default;
    }
    return defaultValue;
}

export function buildSidebarSnapshot(
    db: Database,
    sessionId: string,
    directory: string,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    // The optional execute-threshold config lets the sidebar display the effective threshold with usagePercentage.
    // If the execute-threshold config is omitted, the snapshot uses the 65% runtime default.
    config?: Record<string, unknown>,
    moduleStatus?: RustSessionStatus,
    compactionEnabled = true,
): SidebarSnapshot {
    try {
        const projectIdentity = resolveProjectIdentity(directory);

        const meta = db
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);

        const usagePercentage = meta
            ? Number(meta.last_context_percentage ?? meta.last_usage_percentage ?? 0)
            : 0;
        const inputTokens = meta ? Number(meta.last_input_tokens ?? 0) : 0;
        const moduleUsage = moduleStatus?.usage;
        const moduleInputTokens = moduleUsage?.current_total_input_tokens;
        const moduleContextLimit = moduleUsage?.context_limit_tokens;
        const effectiveInputTokens =
            typeof moduleInputTokens === "number" && moduleInputTokens > 0
                ? moduleInputTokens
                : inputTokens;
        const effectiveUsagePercentage =
            typeof moduleInputTokens === "number" &&
            moduleInputTokens > 0 &&
            typeof moduleContextLimit === "number" &&
            moduleContextLimit > 0
                ? (moduleInputTokens / moduleContextLimit) * 100
                : usagePercentage;
        // The sidebar computes work metrics lazily and incrementally to keep computation off the transform hot path.
        // Persisted session_meta columns provide a warm-start fallback on cold start or when the DB is absent.
        const persistedNewWork = meta ? Number(meta.new_work_tokens ?? 0) : 0;
        const persistedTotalInput = meta ? Number(meta.total_input_tokens ?? 0) : 0;
        const { newWorkTokens, totalInputTokens } = resolveSidebarWorkMetrics(
            db,
            sessionId,
            persistedNewWork,
            persistedTotalInput,
        );
        const systemPromptTokens = meta ? Number(meta.system_prompt_tokens ?? 0) : 0;
        // messagesBlockTokens estimates tokens in text, reasoning, and image parts of transformed output.messages[].
        // messagesBlockTokens includes injected compartments, facts, and memories in output.messages[0].
        const messagesBlockTokens = meta ? Number(meta.conversation_tokens ?? 0) : 0;
        // toolCallTokensRaw estimates tokens in tool_use, tool_result, and tool-invocation parts of output.messages[].
        // toolCallTokensRaw excludes tool schemas; it counts only conversation tool-call I/O.
        const toolCallTokensRaw = meta ? Number(meta.tool_call_tokens ?? 0) : 0;
        const compartmentInProgress = meta ? Boolean(meta.compartment_in_progress) : false;
        const cacheTtl = meta ? String(meta.cache_ttl ?? "5m") : "5m";
        const memoryBlockCount = meta ? Number(meta.memory_block_count ?? 0) : 0;

        const compartmentRow = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
            )
            .get(sessionId);
        const archivedCompartmentCount = compartmentRow?.count ?? 0;
        const compartmentCount =
            typeof moduleStatus?.compartment_count === "number"
                ? moduleStatus.compartment_count
                : archivedCompartmentCount;

        const claimLane = projectIdentity
            ? readProjectClaimLaneSnapshot(db, projectIdentity)
            : null;
        const memoryClaims = (claimLane?.items ?? []).map((item) => ({
            publicClaimId: item.publicClaimId,
            revisionLocator: item.revisionLocator,
        }));
        const memoryCount = memoryClaims.length;
        const memorySnapshotVector = claimLane?.snapshotVector ?? null;

        let pendingOpsCount = 0;
        try {
            const pendingRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?",
                )
                .get(sessionId);
            pendingOpsCount = pendingRow?.count ?? 0;
        } catch {
            // pending_ops table may not exist
        }
        if (typeof moduleStatus?.pending_drop_count === "number") {
            pendingOpsCount = moduleStatus.pending_drop_count;
        }

        let sessionNoteCount = 0;
        try {
            const noteRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM notes WHERE session_id = ? AND type = 'session' AND status = 'active'",
                )
                .get(sessionId);
            sessionNoteCount = noteRow?.count ?? 0;
        } catch {
        }

        let readySmartNoteCount = 0;
        if (projectIdentity) {
            try {
                const smartRow = db
                    .prepare<[string], { count: number }>(
                        "SELECT COUNT(*) as count FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'ready'",
                    )
                    .get(projectIdentity);
                readySmartNoteCount = smartRow?.count ?? 0;
            } catch {
                // notes table may not exist
            }
        }

        const m0Bytes = meta?.cached_m0_bytes;
        const m0Text =
            m0Bytes instanceof Uint8Array
                ? Buffer.from(m0Bytes).toString("utf8")
                : typeof m0Bytes === "string"
                  ? (m0Bytes as string)
                  : "";
        const m0Blocks = computeM0BlockTokens(db, sessionId, {
            m0Text,
            projectIdentity,
            injectionBudgetTokens,
            memoryBlockCount,
            compartmentTokensOverride: moduleStatus?.compartment_tokens,
        });
        const compartmentTokens = m0Blocks.compartmentTokens;
        const factTokens = m0Blocks.factTokens;
        const memoryTokens = m0Blocks.memoryTokens;
        const docsTokens = m0Blocks.docsTokens;
        const profileTokens = m0Blocks.profileTokens;

        let lastDreamerRunAt: number | null = null;
        let dreamerBacklog: DreamTaskBacklogMap | undefined;
        const dreamerProgress = projectIdentity
            ? (liveSessionState?.dreamerProgressByProject?.get(projectIdentity) ?? null)
            : null;
        if (projectIdentity) {
            try {
                dreamerBacklog = getDreamTaskBacklogs(db, projectIdentity, CANONICAL_DREAM_TASKS);
            } catch {
                // Pre-Dreamer-V2 databases may not have all task tables.
            }
        }
        if (projectIdentity) {
            try {
                lastDreamerRunAt = getMostRecentTaskRunAt(db, projectIdentity);
            } catch {
                // task_schedule_state may not exist on a pre-V2 DB
            }
        }

        // Display-layer attribution.
        //
        // tokenizer-calibration.ts captures empirically measured per-model tokenizer drift.
        // Tokenizer drift between local raw counts and API token counts varies significantly across providers and model generations.
        // Dynamic buckets receive the remainder proportionally so they sum to exactly inputTokens and overhead is 0.
        //
        // messagesBlockTokens includes the injected <session-history> block in output.messages[0].
        // The handler subtracts injected session-history tokens so conversationLocal excludes compartments, facts, and memories.
        const injectedInMessages =
            compartmentTokens + factTokens + memoryTokens + docsTokens + profileTokens;
        const conversationLocal = Math.max(0, messagesBlockTokens - injectedInMessages);
        const toolCallsLocal = Math.max(0, toolCallTokensRaw);

        // When the cache lacks a model or agent, the handler recovers missing values from OpenCode's SQLite database.
        // Caching recovered values prevents Tool Defs from showing 0 until the next chat.message.
        let measuredToolDefTokens = 0;
        let activeProviderID: string | undefined;
        let activeModelID: string | undefined;
        if (liveSessionState) {
            let model = liveSessionState.liveModelBySession.get(sessionId);
            let agent = liveSessionState.agentBySession.get(sessionId);
            if (!model || !agent) {
                const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
                if (recovered) {
                    if (!model) {
                        model = {
                            providerID: recovered.providerID,
                            modelID: recovered.modelID,
                        };
                        liveSessionState.liveModelBySession.set(sessionId, model);
                    }
                    if (!agent && recovered.agent) {
                        agent = recovered.agent;
                        liveSessionState.agentBySession.set(sessionId, agent);
                    }
                }
            }
            if (model) {
                activeProviderID = model.providerID;
                activeModelID = model.modelID;
                measuredToolDefTokens =
                    getMeasuredToolDefinitionTokens(model.providerID, model.modelID, agent) ?? 0;
            }
        }

        const contextLimit =
            typeof moduleContextLimit === "number" && moduleContextLimit > 0
                ? moduleContextLimit
                : activeProviderID && activeModelID
                  ? resolveContextLimit(activeProviderID, activeModelID, {
                        db,
                        sessionID: sessionId,
                    })
                  : 0;

        // The sidebar uses the configured default threshold when no live model is known.
        let executeThreshold = 65;
        let executeThresholdClamped = false;
        if (config) {
            const modelKey =
                activeProviderID && activeModelID
                    ? `${activeProviderID}/${activeModelID}`
                    : undefined;
            const pctCfg = config.execute_threshold_percentage as
                | number
                | { default: number; [k: string]: number }
                | undefined;
            const tokensCfg = config.execute_threshold_tokens as
                | { default?: number; [k: string]: number | undefined }
                | undefined;
            const thresholdDetail = resolveExecuteThresholdDetail(pctCfg ?? 65, modelKey, 65, {
                tokensConfig: tokensCfg,
                contextLimit: contextLimit || undefined,
                sessionId,
            });
            executeThreshold = thresholdDetail.percentage;
            executeThresholdClamped = thresholdDetail.clamped === true;
        }

        // Native compaction uses the model's full context window rather than Magic Context's reserved limit.
        // nativeContextUsagePercentage uses the unreserved context limit because native compaction watches the model's full window.
        const nativeContextLimit =
            activeProviderID && activeModelID
                ? resolveContextLimit(activeProviderID, activeModelID, {
                      db,
                      sessionID: sessionId,
                      reservation: "none",
                  })
                : contextLimit;
        const nativeContextUsagePercentage =
            nativeContextLimit > 0 ? (effectiveInputTokens / nativeContextLimit) * 100 : undefined;

        const calibration = resolveModelCalibration(activeProviderID, activeModelID);
        const tailHygiene = resolveTailHygieneStatus(
            liveSessionState?.channel1StateBySession.get(sessionId),
            moduleStatus?.tail_hygiene,
        );

        const calibrated = calibrateBuckets({
            inputTokens: effectiveInputTokens,
            systemLocal: systemPromptTokens,
            toolDefsLocal: measuredToolDefTokens,
            compartmentsLocal: compartmentTokens,
            factsLocal: factTokens,
            memoriesLocal: memoryTokens,
            docsLocal: docsTokens,
            profileLocal: profileTokens,
            conversationLocal,
            toolCallsLocal,
            calibration,
        });

        const fresh: SidebarSnapshot = {
            sessionId,
            usagePercentage: effectiveUsagePercentage,
            inputTokens: effectiveInputTokens,
            contextLimit,
            native_context_usage_percentage: nativeContextUsagePercentage,
            compaction_enabled: compactionEnabled,
            systemPromptTokens: calibrated.systemTokens,
            compartmentCount,
            archivedCompartmentCount,
            memoryCount,
            memoryClaims,
            memorySnapshotVector,
            memoryBlockCount,
            pendingOpsCount,
            historianRunning: moduleStatus?.wrapup_active === true || compartmentInProgress,
            compartmentInProgress: moduleStatus?.wrapup_active === true || compartmentInProgress,
            sessionNoteCount,
            readySmartNoteCount,
            cacheTtl,
            lastTransformError: meta?.last_transform_error
                ? String(meta.last_transform_error)
                : null,
            lastDreamerRunAt,
            projectIdentity,
            dreamerBacklog,
            dreamerProgress,
            compartmentTokens: calibrated.compartmentTokens,
            factTokens: calibrated.factTokens,
            memoryTokens: calibrated.memoryTokens,
            docsTokens: calibrated.docsTokens,
            profileTokens: calibrated.profileTokens,
            conversationTokens: calibrated.conversationTokens,
            toolCallTokens: calibrated.toolCallTokens,
            toolDefinitionTokens: calibrated.toolDefinitionTokens,
            ...(tailHygiene === undefined ? {} : { tailHygiene }),
            executeThreshold,
            executeThresholdClamped,
            boundaryPresent: moduleStatus?.boundary_present,
            coverageOrdinal: moduleStatus?.coverage_ordinal,
            newWorkTokens,
            totalInputTokens,
            recompProgress: (() => {
                const p = liveSessionState?.recompProgressBySession.get(sessionId);
                if (!p) return null;
                return {
                    kind: p.kind ?? "recomp",
                    phase: p.phase,
                    processedMessages: p.processedMessages,
                    totalMessages: p.totalMessages,
                    passCount: p.passCount,
                    compartmentsCreated: p.compartmentsCreated,
                    message: p.message,
                    note: p.note,
                };
            })(),
        };
        // The breakdown retains its last nonzero value when inputTokens is 0 to prevent bar flicker.
        return applyStickySnapshotCache(sessionId, fresh);
    } catch (err) {
        log("[rpc] sidebar-snapshot error:", err);
        throw err;
    }
}

/** Snapshot-build failures return a transport-failure envelope.
 * zero snapshot remains a successful value so deleted sessions stay deleted. */
export function buildSidebarSnapshotRpcResponse(
    db: Database,
    sessionId: string,
    directory: string,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    config?: Record<string, unknown>,
    moduleStatus?: RustSessionStatus,
    compactionEnabled = true,
): Record<string, unknown> {
    try {
        // SAFETY: RPC results serialize to JSON; the handler map's value type is the JSON-object envelope.
        return buildSidebarSnapshot(
            db,
            sessionId,
            directory,
            liveSessionState,
            injectionBudgetTokens,
            config,
            moduleStatus,
            compactionEnabled,
        ) as unknown as Record<string, unknown>;
    } catch {
        return { error: "sidebar snapshot unavailable" };
    }
}

export function buildStatusDetail(
    db: Database,
    sessionId: string,
    directory: string,
    modelKey?: string,
    config?: Record<string, unknown>,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    moduleStatus?: RustSessionStatus,
    compactionEnabled = true,
): StatusDetail {
    const base = buildSidebarSnapshot(
        db,
        sessionId,
        directory,
        liveSessionState,
        injectionBudgetTokens,
        config,
        moduleStatus,
        compactionEnabled,
    );
    const detail: StatusDetail = {
        ...base,
        tagCounter: 0,
        activeTags: 0,
        droppedTags: 0,
        totalTags: 0,
        activeBytes: 0,
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastTransformError: null,
        isSubagent: false,
        pendingOps: [],
        contextLimit: 0,
        cacheTtlMs: 0,
        cacheRemainingMs: 0,
        cacheExpired: false,
        cacheNeverExpires: false,
        executeThreshold: 65,
        executeThresholdMode: "percentage",
        protectedTagCount: 20,
        historyBudgetPercentage: 0.15,
        historyBlockTokens: 0,
        compressionBudget: null,
        compressionUsage: null,
        toastDurationMs: 5000,
        mural: undefined,
        loggerDiagnostics: getLoggerDiagnostics(),
        storage_versions: {
            // null means the probe read failed; 0 means the migrations table is absent; a positive value is the highest applied upstream-lane migration.
            context_db_schema_version: null as number | null,
            plugin_supported_version: LATEST_SUPPORTED_VERSION,
        },
    };

    try {
        detail.storage_versions = {
            context_db_schema_version: getPersistedSchemaVersion(db),
            plugin_supported_version: LATEST_SUPPORTED_VERSION,
        };
        const muralConfig = (config?.experimental as { mural?: { enabled?: boolean } } | undefined)
            ?.mural;
        if (muralConfig?.enabled && base.projectIdentity) {
            const row = getMural(db, base.projectIdentity);
            detail.mural = {
                present: row !== null,
                ageMs: row ? Math.max(0, Date.now() - row.renderedAt) : null,
            };
        }
        const meta = db
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);
        if (meta) {
            detail.tagCounter = Number(meta.counter ?? 0);
            detail.lastResponseTime = Number(meta.last_response_time ?? 0);
            detail.lastNudgeTokens = Number(meta.last_nudge_tokens ?? 0);
            detail.lastTransformError = meta.last_transform_error
                ? String(meta.last_transform_error)
                : null;
            detail.isSubagent = Boolean(meta.is_subagent);
        }

        // Tags
        try {
            const activeRow = db
                .prepare<[string], { count: number; bytes: number }>(
                    "SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as bytes FROM tags WHERE session_id = ? AND status = 'active'",
                )
                .get(sessionId);
            detail.activeTags = activeRow?.count ?? 0;
            detail.activeBytes = activeRow?.bytes ?? 0;
            const droppedRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM tags WHERE session_id = ? AND status = 'dropped'",
                )
                .get(sessionId);
            detail.droppedTags = droppedRow?.count ?? 0;
            detail.totalTags = detail.activeTags + detail.droppedTags;
        } catch {
        }

        // Because the dialog displays only pendingOpsCount, status polls limit pendingOps to 100 rows and avoid serializing unused rows.
        try {
            const ops = db
                .prepare<[string], { tag_id: number; operation: string }>(
                    "SELECT tag_id, operation FROM pending_ops WHERE session_id = ? LIMIT 100",
                )
                .all(sessionId);
            detail.pendingOps = ops.map((o) => ({ tagId: o.tag_id, operation: o.operation }));
        } catch {
            // Return an empty pending-op list when pending_ops is absent.
        }

        const modelSlash = modelKey?.indexOf("/") ?? -1;
        if (modelKey && modelSlash > 0) {
            detail.windowGeometry = resolveContextWindowGeometry(
                modelKey.slice(0, modelSlash),
                modelKey.slice(modelSlash + 1),
                { db, sessionID: sessionId },
            );
        }

        const contextLimitForTokens =
            base.contextLimit > 0
                ? base.contextLimit
                : base.usagePercentage > 0
                  ? Math.round(base.inputTokens / (base.usagePercentage / 100))
                  : 0;

        if (config) {
            const pctCfg = config.execute_threshold_percentage as
                | number
                | { default: number; [k: string]: number }
                | undefined;
            const tokensCfg = config.execute_threshold_tokens as
                | { default?: number; [k: string]: number | undefined }
                | undefined;
            // The RPC uses resolveExecuteThresholdDetail to return the threshold mode and absolute-token threshold.
            const thresholdDetail = resolveExecuteThresholdDetail(pctCfg ?? 65, modelKey, 65, {
                tokensConfig: tokensCfg,
                contextLimit: contextLimitForTokens || undefined,
                sessionId,
            });
            detail.executeThreshold = thresholdDetail.percentage;
            detail.executeThresholdMode = thresholdDetail.mode;
            detail.executeThresholdClamped = thresholdDetail.clamped;
            if (thresholdDetail.absoluteTokens !== undefined) {
                detail.executeThresholdTokens = thresholdDetail.absoluteTokens;
            }

            const ct = resolveConfigValue<string>(config, "cache_ttl", modelKey, "5m");
            detail.cacheTtl = ct;

            if (typeof config.protected_tags === "number") {
                detail.protectedTagCount = config.protected_tags;
            }
            if (typeof config.history_budget_percentage === "number") {
                detail.historyBudgetPercentage = config.history_budget_percentage;
            }
            detail.toastDurationMs = resolveConfigValue<number>(
                config,
                "toast_duration_ms",
                modelKey,
                5000,
            );
        }

        // Derived values
        if (base.contextLimit > 0) {
            detail.contextLimit = base.contextLimit;
        } else if (base.usagePercentage > 0) {
            detail.contextLimit = Math.round(base.inputTokens / (base.usagePercentage / 100));
        }
        detail.cacheTtlMs = safeParseTtl(detail.cacheTtl);
        if (detail.cacheTtlMs === Number.POSITIVE_INFINITY) {
            // JSON.stringify emits null for Infinity, so use -1 as the never-expires sentinel.
            // cacheTtlMs uses -1 because 0 represents an expired or unset cache.
            // cacheTtlMs uses -1 for a non-expiring cache.
            detail.cacheNeverExpires = true;
            detail.cacheTtlMs = -1;
        }
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            if (detail.cacheNeverExpires) {
                detail.cacheRemainingMs = -1;
                detail.cacheExpired = false;
            } else {
                detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
                detail.cacheExpired = detail.cacheRemainingMs === 0;
            }
        }

        // History compression
        try {
            const histTokens = base.compartmentTokens + base.factTokens;
            detail.historyBlockTokens = histTokens;

            if (detail.contextLimit > 0) {
                const budget = Math.floor(
                    detail.contextLimit *
                        (Math.min(detail.executeThreshold, 80) / 100) *
                        detail.historyBudgetPercentage,
                );
                detail.compressionBudget = budget;
                detail.compressionUsage = `${((histTokens / budget) * 100).toFixed(0)}%`;
            }
        } catch {
        }
    } catch (err) {
        log("[rpc] status-detail error:", err);
    }

    return detail;
}

function buildEmbedDetail(
    db: Database,
    sessionId: string,
    dir: string,
    liveSessionState: LiveSessionState,
): EmbedDetail {
    const projectIdentity = resolveProjectIdentity(dir);
    const coverage = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
    const progress = liveSessionState.recompProgressBySession.get(sessionId);
    const drainUi = getEmbedDrainUiStatus(sessionId, progress);
    const statusText = formatEmbedStatusText(coverage, {
        status: drainUi.status,
        embedded: progress?.processedMessages,
        total: progress?.totalMessages,
    });
    return {
        enabled: coverage.enabled,
        model: coverage.model,
        provider: coverage.provider,
        session: coverage.session,
        commits: coverage.commits,
        statusText,
    };
}

/**
 */
export function registerRpcHandlers(
    rpcServer: MagicContextRpcServer,
    args: {
        directory: string;
        config: MagicContextConfig;
        client: unknown;
        liveSessionState: LiveSessionState;
        rustModeModuleClient?: RustModeModuleClient;
    },
): void {
    const { directory, config, liveSessionState, rustModeModuleClient } = args;
    const compactionEnabled = isCompactionEnabled(config);

    // RPC results serialize to JSON, so handler-map values use the JSON-object envelope.
    const rawConfig = config as unknown as Record<string, unknown>;
    const getNotificationParams = (sessionId: string) =>
        getLiveNotificationParams(
            sessionId,
            liveSessionState.liveModelBySession,
            liveSessionState.variantBySession,
            liveSessionState.agentBySession,
            config.toast_duration_ms,
        );

    const injectionBudgetTokens = config.memory?.injection_budget_tokens;

    rpcServer.handle("sidebar-snapshot", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        const moduleStatus =
            config.transform_mode === "rust"
                ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
                : undefined;
        return buildSidebarSnapshotRpcResponse(
            db,
            sessionId,
            dir,
            liveSessionState,
            injectionBudgetTokens,
            rawConfig,
            moduleStatus,
            compactionEnabled,
        );
    });

    rpcServer.handle("status-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const modelKey = params.modelKey ? String(params.modelKey) : undefined;
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        const moduleStatus =
            config.transform_mode === "rust"
                ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
                : undefined;
        return buildStatusDetail(
            db,
            sessionId,
            dir,
            modelKey,
            rawConfig,
            liveSessionState,
            injectionBudgetTokens,
            moduleStatus,
            compactionEnabled,
        ) as unknown as Record<string, unknown>;
    });

    rpcServer.handle("embed-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        try {
            return buildEmbedDetail(db, sessionId, dir, liveSessionState) as unknown as Record<
                string,
                unknown
            >;
        } catch (err) {
            log("[rpc] embed-detail error:", err);
            return { error: "unavailable" };
        }
    });

    rpcServer.handle("compartment-count", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const db = getDb();
        if (!db || !sessionId) return { count: 0 };
        try {
            const row = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
                )
                .get(sessionId);
            return { count: row?.count ?? 0 };
        } catch {
            return { count: 0 };
        }
    });

    // Both RPC dialog paths use the shared runners, so they share model fallback, progress, terminal state, and messaging.
    const buildManagedCtx = async (
        db: NonNullable<ReturnType<typeof getDb>>,
    ): Promise<ManagedRecompContext> => {
        const { deriveHistorianChunkTokens, resolveHistorianContextLimit } = await import(
            "../hooks/magic-context/derive-budgets"
        );
        const { resolveFallbackChain } = await import("../shared/resolve-fallbacks");
        const { userMemoryCollectionEnabled } = await import(
            "../features/magic-context/dreamer/task-config"
        );
        const DEFAULT_HISTORIAN_TIMEOUT_MS = 10 * 60 * 1000;
        return {
            client: args.client as ManagedRecompContext["client"],
            db,
            liveSessionState,
            directory,
            historianChunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(config.historian?.model),
            ),
            historianTimeoutMs: config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
            memoryEnabled: config.memory?.enabled ?? true,
            autoPromote: config.memory?.auto_promote ?? true,
            fallbackModels: resolveFallbackChain(config.historian?.fallback_models),
            userMemoriesEnabled: userMemoryCollectionEnabled(config.dreamer),
            historianTwoPass: config.historian?.two_pass === true,
            getNotificationParams,
        };
    };

    rpcServer.handle("recomp", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedRecomp } = await import("../hooks/magic-context/recomp-orchestrator");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        log(`[rpc] recomp requested for session ${sessionId}`);
        const ctx = await buildManagedCtx(db);
        // Force-persist fire-and-forget recomp outcomes so multi-minute results remain visible in scrollback instead of a 5s toast.
        void runManagedRecomp(ctx, sessionId)
            .then((message) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    message,
                    getNotificationParams(sessionId),
                    true,
                ).catch(() => {});
            })
            .catch((error: unknown) => log("[rpc] recomp failed:", error));
        return { ok: true };
    });

    // `/ctx-session-upgrade` performs a full recomp and updates memory once per project.
    rpcServer.handle("upgrade", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedUpgrade } = await import("../hooks/magic-context/recomp-orchestrator");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        log(`[rpc] session-upgrade requested for session ${sessionId}`);
        const ctx = await buildManagedCtx(db);
        void runManagedUpgrade(ctx, sessionId)
            .then((message) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    message,
                    getNotificationParams(sessionId),
                    true, // force-persist: a multi-minute upgrade's outcome must stay visible
                ).catch(() => {});
            })
            .catch((error: unknown) => log("[rpc] session-upgrade failed:", error));
        return { ok: true };
    });

    // Stamp only Confirm or Cancel so a dismissed dialog reappears in the next process.
    // A dialog closed or ctrl-c'd before action must reappear in the next process.
    rpcServer.handle("dismiss-upgrade-reminder", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };
        try {
            const { updateSessionMeta } = await import(
                "../features/magic-context/storage-meta-session"
            );
            updateSessionMeta(db, sessionId, { upgradeRemindedAt: Date.now() });
            return { ok: true };
        } catch (error) {
            log("[rpc] dismiss-upgrade-reminder failed:", error);
            return { ok: false, error: String(error) };
        }
    });

    rpcServer.handle("toast-duration", async () => {
        const resolved =
            typeof config.toast_duration_ms === "number" &&
            Number.isFinite(config.toast_duration_ms)
                ? config.toast_duration_ms
                : 5000;
        return { toastDurationMs: resolved };
    });


    rpcServer.handle("get-announcement", async () => {
        if (!shouldShowAnnouncement()) {
            return { show: false } as unknown as Record<string, unknown>;
        }
        return {
            show: true,
            version: ANNOUNCEMENT_VERSION,
            features: [...ANNOUNCEMENT_FEATURES],
            footer: ANNOUNCEMENT_FOOTER,
        } as unknown as Record<string, unknown>;
    });

    rpcServer.handle("mark-announced", async () => {
        if (ANNOUNCEMENT_VERSION) {
            markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        }
        return { ok: true } as unknown as Record<string, unknown>;
    });
}
