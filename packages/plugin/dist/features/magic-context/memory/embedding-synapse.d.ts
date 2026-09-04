import { type ConnectionOrigin, type StorageReadiness } from "../../../shared/mc-host-lifecycle";
import type { DetailedEmbedContext, DetailedEmbedItem, DetailedEmbedResult, EmbeddingProvider } from "./embedding-provider";
export declare const SYNAPSE_DEFAULT_MODEL = "gte-modernbert-base-f16";
export declare const SYNAPSE_MAX_INPUT_TOKENS = 8192;
export declare const SYNAPSE_MAX_INPUT_BYTES: number;
export declare const SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS = 3000;
export declare const SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS = 120000;
/**
 * Connect budget for the shared provider client. The client-wide default is
 * sized for the hook transport, which reconnects on a per-pass deadline; this
 * lane instead memoizes one long-lived client, and the budget must cover the
 * connection-file read plus dial and auth. Failing it leaves the provider
 * uninitialized, which silently degrades embeddings to no-ops rather than
 * surfacing an error, so the wait is deliberately generous.
 */
export declare const SYNAPSE_HANDSHAKE_TIMEOUT_MS = 10000;
export type SynapseErrorCode = "queue_full" | "model_loading" | "transport" | "timeout" | "artifact_invalid" | "substitution_rejected" | "not_certified" | "probe_required" | "idempotency_conflict" | "page_terminal" | "schema_violation" | "cancelled" | "module_restarted";
export interface SynapseCatalogEntry {
    model: string;
    fingerprint: string;
    table_epoch: number;
    dims?: number;
    /** Rows per embed.batch call, from the service's measured per-lane policy. */
    recommended_batch?: number;
    /** Token ceiling per embed.batch call; pages split on whichever limit hits first. */
    recommended_token_budget?: number;
    /** Advertised per-input token window; absent catalogs keep the client default. */
    max_input_tokens?: number;
    /** Advertised per-input UTF-8 byte ceiling; absent catalogs keep the client default. */
    max_input_bytes?: number;
    provenance?: unknown;
    certified?: boolean;
    status?: string;
}
export interface SynapseLaneMetadata extends SynapseCatalogEntry {
    laneIdentity: string;
}
export interface SynapseClientLike {
    call<Response = unknown>(moduleId: string, method: string, params?: unknown, options?: {
        timeoutMs?: number;
        identity?: {
            project_root: string;
            harness: string;
            session: string;
        };
        targetKind?: "management_surface" | "tool_provider";
    }): Promise<Response>;
    close(): void;
}
export interface SynapseEmbeddingProviderOptions {
    connectionFile?: string;
    connectionOrigin?: ConnectionOrigin;
    projectRoot: string;
    session: string;
    model?: string;
    fingerprint?: string;
    tableEpoch?: number;
    dims?: number;
    recommendedBatch?: number;
    recommendedTokenBudget?: number;
    maxInputTokens?: number;
    maxInputBytes?: number;
    provenance?: unknown;
    moduleId?: string;
    queryTimeoutMs?: number;
    batchTimeoutMs?: number;
    clientFactory?: () => Promise<SynapseClientLike>;
    demandStart?: SynapseDemandStart;
    onLaneReady?: (metadata: SynapseLaneMetadata) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
    pollInitialDelayMs?: number;
    pollDefaultDelayMs?: number;
}
export type SynapseDemandStart = (request: {
    origin: ConnectionOrigin;
    capability: "synapse";
    deadlineMs?: number;
}) => Promise<{
    ok: boolean;
    reason: string;
    storage: StorageReadiness | null;
}>;
export declare function configureSynapseManagedDemandStart(demandStart: SynapseDemandStart | undefined): void;
export declare class SynapseEmbeddingError extends Error {
    readonly code: SynapseErrorCode;
    readonly retryAfterMs?: number;
    readonly permanent: boolean;
    /** Ledger receipt this failure was recorded against, when one exists. */
    ledgerRowId?: number;
    constructor(code: SynapseErrorCode, message: string, options?: {
        retryAfterMs?: number;
        permanent?: boolean;
        cause?: unknown;
    });
}
/**
 * Normalize an advertised per-call token budget to a positive safe integer,
 * flooring a fractional advertisement the way `recommended_batch` floors its row
 * count. Flooring keeps the served budget as a ceiling the client never exceeds.
 * A value that is not a finite positive number, or whose floor falls to zero or
 * leaves the safe-integer range, carries no usable budget and is dropped so the
 * lane keeps the client default.
 *
 * Every guard that admits this field shares this function so the catalog parser,
 * the provider constructor, the registry, and routing cannot disagree about
 * which advertisements survive.
 */
export declare function normalizeSynapseTokenBudget(value: unknown): number | undefined;
export declare function getSynapseLaneIdentity(model: string, fingerprint: string): string;
export declare function getSynapseBatchRequestKey(args: {
    model: string;
    fingerprint: string;
    tableEpoch: number;
    items: readonly {
        id: string;
        contentSha256: string;
    }[];
}): string;
export declare class SynapseEmbeddingProvider implements EmbeddingProvider {
    modelId: string;
    maxInputTokens: number;
    maxInputBytes: number;
    metadata: SynapseLaneMetadata | null;
    /**
     * Where lane discovery stands, for callers deciding whether to replace this
     * provider.
     *
     * `metadata` alone cannot answer that: it is null both while the first
     * `models.list` is still in flight and after a lane-wide permanent error, and
     * those need opposite treatment. A failed lane must be replaced, because
     * `initialize()` refuses to rediscover once `permanentFailure` latches. A
     * pending lane must be kept, because its `onLaneReady` callback is bound to
     * this instance and the identity guard in the registry drops the commit if a
     * replacement has taken its place.
     */
    get laneDiscoveryState(): "pending" | "resolved" | "failed";
    readonly pageTimeoutMs: number;
    private readonly options;
    private readonly connectionOrigin;
    private readonly demandStart;
    private client;
    private initialized;
    private initializing;
    private demandFailedUntilMs;
    private permanentFailure;
    private batchLimit;
    private tokenBudget;
    private readonly sleep;
    private readonly now;
    private readonly random;
    private readonly pollInitialDelayMs;
    private readonly pollDefaultDelayMs;
    constructor(options: SynapseEmbeddingProviderOptions);
    /**
     * Page split honors both halves of the service's measured policy: at most
     * batchLimit rows AND (when the lane publishes one) at most the token budget
     * per call, estimated at 4 chars/token. Splitting on whichever limit hits
     * first keeps a page's GPU/ANE occupancy inside the measured knee, so one
     * oversized page cannot recreate the uninterruptible-latency regression the
     * budget exists to bound. A single item over budget still ships alone: the
     * service truncates per its own contract, the client never drops work.
     */
    private nextPage;
    static discover(options: SynapseEmbeddingProviderOptions): Promise<SynapseLaneMetadata>;
    /**
     * Demand the shared managed daemon inside the initialization flight, so
     * concurrent initializers share one demand and one native invocation. A
     * missing lifecycle owner keeps this path passive (dial-only): explicit
     * and CLI contexts must be able to reach an already-running daemon.
     */
    private demandManagedLane;
    initialize(signal?: AbortSignal): Promise<boolean>;
    embed(text: string, signal?: AbortSignal): Promise<Float32Array | null>;
    embedBatch(texts: string[], signal?: AbortSignal): Promise<(Float32Array | null)[]>;
    embedItems(items: readonly {
        id: string;
        text: string;
        contentSha256: string;
    }[], signal?: AbortSignal): Promise<Map<string, Float32Array>>;
    embedItemsDetailed(items: readonly DetailedEmbedItem[], context: DetailedEmbedContext, signal?: AbortSignal): Promise<DetailedEmbedResult>;
    private runDetailedPage;
    private submitBatchPage;
    private collectJobPages;
    dispose(): Promise<void>;
    isLoaded(): boolean;
    private requestConstraints;
    private batchRequest;
    /**
     * Waits `ms`, but stops as soon as `signal` aborts.
     *
     * Every delay in this provider sits between two abort checks, so an
     * unconditional wait leaves the request pending for the whole delay after
     * the caller has already given up. That is not academic here: a `queue_full`
     * retry ladder can wait seconds, so an aborted embedding would hold its
     * caller — and anything awaiting shutdown behind it — for that long.
     *
     * The injected `sleep` seam is preserved: it still drives the timing, and
     * tests that supply their own `sleep` keep full control of it. The listener
     * is removed on every exit path so a long-lived signal does not accumulate
     * one per delay.
     */
    private delay;
    private positiveOption;
    private newPollDelayState;
    private requestKey;
    /** Lenient polling for `embedItems`/`embedBatch` callers only: it tolerates
     *  pre-canonical hosts (`complete`, `cursor` aliases) and treats a missing
     *  cursor on a reply that carried items as termination. A reply carrying no
     *  items at all is the canonical pending shape, so it defers to the shared
     *  R13 rule in `pendingPollDelay` rather than reading the absent cursor as
     *  completion; the detailed/ledger paths apply that rule in
     *  `collectJobPages` for every reply. */
    private pollBatch;
    private callWithRetry;
    private validateResponse;
    private logCallFailure;
}
export declare function _resetSynapseClientForTests(): void;
export declare function _synapseSharedClientStateForTests(): {
    hasClient: boolean;
    hasPromise: boolean;
    file: string | null;
};
//# sourceMappingURL=embedding-synapse.d.ts.map