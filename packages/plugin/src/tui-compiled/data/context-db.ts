/**
 * The TUI accesses data through RPC and never accesses SQLite directly.
 * The TUI fetches all data from the server plugin through HTTP RPC.
 */
import os from "node:os";
import path from "node:path";
import { MagicContextRpcClient } from "../../shared/rpc-client";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";

export type { EmbedDetail, SidebarSnapshot, StatusDetail };

let rpcClient: MagicContextRpcClient | null = null;
let rpcGeneration = 0;

function getStorageDir(): string {
    // OpenCode and Pi share state through `cortexkit/magic-context`.
    // The TUI must use the server plugin's storage directory for lock-file discovery.
    // discovery convention.
    const dataDir = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    return path.join(dataDir, "cortexkit", "magic-context");
}

/** The TUI must call initRpcClient once at startup. */
export function initRpcClient(directory: string): void {
    const storageDir = getStorageDir();
    // initRpcClient increments rpcGeneration before replacing rpcClient so the WebSocket socket ignores callbacks from the disposed client.
    // The WebSocket socket abandons an in-flight connection when rpcGeneration changes.
    rpcGeneration += 1;
    rpcClient = new MagicContextRpcClient(storageDir, directory);
}

export function getRpcGeneration(): number {
    return rpcGeneration;
}

/** The WS notification socket uses this client for endpoint discovery.
 * */
export function getRpcClient(): MagicContextRpcClient | null {
    return rpcClient;
}

/* */
export function closeRpc(): void {
    // closeRpc increments rpcGeneration before resetting rpcClient so callbacks from issued calls abandon their work.
    rpcGeneration += 1;
    rpcClient?.reset();
    rpcClient = null;
}

function isRpcError(value: unknown): boolean {
    return value !== null && typeof value === "object" && "error" in value;
}

const EMPTY_SNAPSHOT: SidebarSnapshot = {
    sessionId: "",
    usagePercentage: 0,
    inputTokens: 0,
    contextLimit: 0,
    systemPromptTokens: 0,
    compartmentCount: 0,
    memoryCount: 0,
    memoryClaims: [],
    memorySnapshotVector: null,
    memoryBlockCount: 0,
    pendingOpsCount: 0,
    historianRunning: false,
    compartmentInProgress: false,
    sessionNoteCount: 0,
    readySmartNoteCount: 0,
    cacheTtl: "5m",
    lastTransformError: null,
    lastDreamerRunAt: null,
    projectIdentity: null,
    compartmentTokens: 0,
    factTokens: 0,
    memoryTokens: 0,
    docsTokens: 0,
    profileTokens: 0,
    conversationTokens: 0,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
    executeThreshold: 65,
    newWorkTokens: null,
    totalInputTokens: null,
};

/**
 * The cache returns the latest snapshot for a session after an RPC failure.
 * The client treats timeouts, aborts, and parse errors as RPC failures.
 * The client treats a missing port file or exhausted retries as an RPC failure.
 * The client treats an RPC error envelope as an RPC failure.
 *
 * Without the cache, an RPC failure hides the breakdown bar until the next successful refresh.
 * The client returns the most recent good snapshot for the same session after an RPC failure.
 * The 5-minute staleness ceiling prevents the UI from showing old data after a long disconnect.
 */
interface CachedSnapshot {
    snapshot: SidebarSnapshot;
    cachedAt: number;
}
const STICKY_TTL_MS = 5 * 60 * 1000;
const STICKY_MAX_ENTRIES = 100;
const stickySidebarCache = new Map<string, CachedSnapshot>();

function rememberSidebarSnapshot(snapshot: SidebarSnapshot): void {
    if (!snapshot.sessionId) return;
    if (snapshot.inputTokens <= 0) {
        // A successful snapshot with `inputTokens <= 0` clears the cache so later failures cannot resurrect old values.
        stickySidebarCache.delete(snapshot.sessionId);
        return;
    }
    // The cache deletes its oldest entry when it reaches 100 entries.
    // The cap prevents unbounded cache growth across session switches in a long TUI session.
    if (
        stickySidebarCache.size >= STICKY_MAX_ENTRIES &&
        !stickySidebarCache.has(snapshot.sessionId)
    ) {
        const firstKey = stickySidebarCache.keys().next().value;
        if (firstKey) stickySidebarCache.delete(firstKey);
    }
    stickySidebarCache.set(snapshot.sessionId, {
        snapshot,
        cachedAt: Date.now(),
    });
}

function recallSidebarSnapshot(sessionId: string, fallback: SidebarSnapshot): SidebarSnapshot {
    const cached = stickySidebarCache.get(sessionId);
    if (!cached) return fallback;
    if (Date.now() - cached.cachedAt > STICKY_TTL_MS) {
        stickySidebarCache.delete(sessionId);
        return fallback;
    }
    return cached.snapshot;
}

/* */
export async function loadSidebarSnapshot(
    sessionId: string,
    directory: string,
): Promise<SidebarSnapshot> {
    const empty: SidebarSnapshot = { ...EMPTY_SNAPSHOT, sessionId };
    if (!rpcClient) return recallSidebarSnapshot(sessionId, empty);
    try {
        const result = await rpcClient.call<SidebarSnapshot>("sidebar-snapshot", {
            sessionId,
            directory,
        });
        if (isRpcError(result)) {
            // The client treats snapshot-build error envelopes as transport failures.
            // The client retains the last known-good snapshot after a snapshot-build error envelope.
            return recallSidebarSnapshot(sessionId, empty);
        }
        // Successful RPC responses, including `inputTokens === 0`, replace the client snapshot.
        //
        rememberSidebarSnapshot(result);
        return result;
    } catch {
        return recallSidebarSnapshot(sessionId, empty);
    }
}

/* */
export async function loadStatusDetail(
    sessionId: string,
    directory: string,
    modelKey?: string,
): Promise<StatusDetail> {
    const emptyDetail: StatusDetail = {
        ...EMPTY_SNAPSHOT,
        sessionId,
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
        loggerDiagnostics: {
            swallowedWriteCount: 0,
            lastErrorMessage: null,
            lastErrorTime: null,
        },
        storage_versions: {
            context_db_schema_version: null,
            plugin_supported_version: 0,
        },
    };

    if (!rpcClient) return emptyDetail;
    try {
        const result = await rpcClient.call<StatusDetail>("status-detail", {
            sessionId,
            directory,
            modelKey,
        });
        if (isRpcError(result)) {
            return emptyDetail;
        }
        return result;
    } catch {
        return emptyDetail;
    }
}

const EMPTY_EMBED_DETAIL: EmbedDetail = {
    enabled: false,
    model: "off",
    provider: "off",
    session: { embedded: 0, total: 0 },
    commits: { embedded: 0, total: 0, gitEnabled: false },
    statusText: "Embedding is off (no provider configured).",
};

/* */
export async function loadEmbedDetail(sessionId: string, directory: string): Promise<EmbedDetail> {
    if (!rpcClient) return EMPTY_EMBED_DETAIL;
    try {
        const result = await rpcClient.call<EmbedDetail>("embed-detail", {
            sessionId,
            directory,
        });
        if (isRpcError(result)) {
            return EMPTY_EMBED_DETAIL;
        }
        return result;
    } catch {
        return EMPTY_EMBED_DETAIL;
    }
}

export type CompartmentCountResult = { ok: true; count: number } | { ok: false; error: string };

/** The client preserves a transport failure instead of returning a real zero for the compartment count. */
export async function getCompartmentCount(sessionId: string): Promise<CompartmentCountResult> {
    if (!rpcClient) return { ok: false, error: "RPC client is not initialized" };
    try {
        const result = await rpcClient.call<{ count?: number; error?: string }>(
            "compartment-count",
            { sessionId },
        );
        if (typeof result.error === "string") return { ok: false, error: result.error };
        if (typeof result.count !== "number" || !Number.isFinite(result.count)) {
            return { ok: false, error: "Invalid compartment count response" };
        }
        return { ok: true, count: result.count };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/* */
export async function requestRecomp(sessionId: string): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok: boolean }>("recomp", { sessionId });
        return result.ok ?? false;
    } catch {
        return false;
    }
}

/**
 * */
export async function requestUpgrade(sessionId: string): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok: boolean }>("upgrade", { sessionId });
        return result.ok ?? false;
    } catch {
        return false;
    }
}

/**
 * */
export async function dismissUpgradeReminder(sessionId: string): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok: boolean }>("dismiss-upgrade-reminder", {
            sessionId,
        });
        return result.ok ?? false;
    } catch {
        return false;
    }
}

/* */
export async function loadToastDurationMs(): Promise<number> {
    if (!rpcClient) return 5000;
    try {
        const result = await rpcClient.call<{ toastDurationMs?: number }>("toast-duration", {});
        return typeof result.toastDurationMs === "number" ? result.toastDurationMs : 5000;
    } catch {
        return 5000;
    }
}

/**
 */
export interface AnnouncementResponse {
    show: boolean;
    version?: string;
    features?: string[];
    footer?: string;
}

export async function getAnnouncement(): Promise<AnnouncementResponse> {
    if (!rpcClient) return { show: false };
    try {
        const result = await rpcClient.call<{
            show?: boolean;
            version?: string;
            features?: string[];
            footer?: string;
        }>("get-announcement", {});
        return {
            show: result.show === true,
            version: result.version,
            features: Array.isArray(result.features) ? result.features : undefined,
            footer: typeof result.footer === "string" ? result.footer : undefined,
        };
    } catch {
        return { show: false };
    }
}

/* */
export async function markAnnounced(): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok?: boolean }>("mark-announced", {});
        return result.ok === true;
    } catch {
        return false;
    }
}
