/**
 * TUI data layer — pure RPC client, no direct SQLite access.
 */
import os from "node:os";
import path from "node:path";
import { MagicContextRpcClient } from "../../shared/rpc-client";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";

export type { EmbedDetail, SidebarSnapshot, StatusDetail };

let rpcClient: MagicContextRpcClient | null = null;
let rpcGeneration = 0;

function getStorageDir(): string {
    // discovery convention.
    const dataDir = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    return path.join(dataDir, "cortexkit", "magic-context");
}

/* */
export function initRpcClient(directory: string): void {
    const storageDir = getStorageDir();
    rpcGeneration += 1;
    rpcClient = new MagicContextRpcClient(storageDir, directory);
}

export function getRpcGeneration(): number {
    return rpcGeneration;
}

/**
 * */
export function getRpcClient(): MagicContextRpcClient | null {
    return rpcClient;
}

/* */
export function closeRpc(): void {
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
 * The client caches usable snapshots by session when RPC cannot return one.
 * - RPC call fails before a usable snapshot is received (timeout, abort, parse error)
 *   - Server returns an error envelope
 *
 * The 5-minute staleness ceiling prevents old data after long disconnects.
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
        // A non-positive-token snapshot deletes its cache entry so later RPC failures cannot return stale values.
        stickySidebarCache.delete(snapshot.sessionId);
        return;
    }
    // The entry cap prevents unbounded growth across session switches.
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
            return recallSidebarSnapshot(sessionId, empty);
        }
        // A non-positive-token snapshot deletes its cache entry so later RPC failures cannot return stale values.
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

/* */
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
