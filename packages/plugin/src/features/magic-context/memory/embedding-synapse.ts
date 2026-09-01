import { createHash, randomUUID } from "node:crypto";
import { getDataDir } from "../../../shared/data-path";
import { getHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import {
    DAEMON_GENERATION_CHANGED_CODE,
    isMcHostCallError,
    processMcHostClient,
    resetProcessMcHostClientsForTest,
} from "../../../shared/mc-host-client";
import {
    type ConnectionOrigin,
    defaultConnectionFilePath,
    OUTER_AGGREGATE_MS,
    resolveConnectionOrigin,
    STORAGE_HARD_BUDGET_MS,
    type StorageReadiness,
    WaiterDetachedError,
} from "../../../shared/mc-host-lifecycle";
import {
    createSynapseLedgerPage,
    findSynapseLedgerPage,
    markSynapseLedgerObsolete,
    markSynapseLedgerOutcome,
    markSynapseLedgerPolling,
    markSynapseLedgerReady,
    recordSynapseLedgerCursor,
    recordSynapseLedgerJob,
    recordSynapseLedgerRestart,
    retrySynapseLedgerPage,
    SynapseLedgerConflictError,
    type SynapseLedgerManifestItem,
    type SynapseLedgerPageIdentity,
} from "../storage-embedding-measurements";
import type {
    DetailedEmbedContext,
    DetailedEmbedItem,
    DetailedEmbedResult,
    EmbeddingPageReceipt,
    EmbeddingProvider,
} from "./embedding-provider";

export const SYNAPSE_DEFAULT_MODEL = "gte-modernbert-base-f16";
export const SYNAPSE_MAX_INPUT_TOKENS = 8192;
export const SYNAPSE_MAX_INPUT_BYTES = 1024 * 1024;
export const SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS = 3_000;
export const SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS = 120_000;
const SYNAPSE_POLL_INITIAL_DELAY_MS = 1;
const SYNAPSE_POLL_DELAY_MULTIPLIER = 1.6;
const SYNAPSE_POLL_MIN_DELAY_MS = 10;
const SYNAPSE_POLL_DEFAULT_DELAY_MS = 50;
/**
 * Admission rejection retries until the caller's deadline or 64 attempts.
 * The caller's deadline stops retries when `now + delay >= deadlineAtMs`.
 * The cap prevents unbounded retries when the host supplies a small delay hint.
 */
const SYNAPSE_QUEUE_FULL_MAX_ATTEMPTS = 64;
/**
 * The handshake timeout covers a memoized long-lived client rather than the hook transport's per-pass reconnection.
 * The budget covers the connection-file read, dial, and authentication.
 * A failed connection leaves the provider uninitialized, so embeddings degrade to no-ops.
 */
export const SYNAPSE_HANDSHAKE_TIMEOUT_MS = 10_000;

export type SynapseErrorCode =
    | "queue_full"
    | "model_loading"
    | "transport"
    | "timeout"
    | "artifact_invalid"
    | "substitution_rejected"
    | "not_certified"
    | "probe_required"
    | "idempotency_conflict"
    | "page_terminal"
    | "schema_violation"
    | "cancelled"
    | "module_restarted";

export interface SynapseCatalogEntry {
    model: string;
    fingerprint: string;
    table_epoch: number;
    // The provider adopts dimensions from its first embed response because live catalogs omit `dims`.
    // The provider pins dimensions from its first embed response for its lifetime.
    dims?: number;
    /** The service's measured per-lane policy sets rows per `embed.batch` call. */
    recommended_batch?: number;
    /** Pages split when the row or token limit is reached. */
    recommended_token_budget?: number;
    /** The client uses its default per-input token window when catalogs omit this field. */
    max_input_tokens?: number;
    /** The client uses its default per-input UTF-8 byte ceiling when catalogs omit this field. */
    max_input_bytes?: number;
    provenance?: unknown;
    certified?: boolean;
    status?: string;
}

export interface SynapseLaneMetadata extends SynapseCatalogEntry {
    laneIdentity: string;
}

export interface SynapseClientLike {
    call<Response = unknown>(
        moduleId: string,
        method: string,
        params?: unknown,
        options?: {
            timeoutMs?: number;
            identity?: { project_root: string; harness: string; session: string };
            targetKind?: "management_surface" | "tool_provider";
            expectedDaemonId?: Uint8Array;
        },
    ): Promise<Response>;
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
    authenticatedDaemonId?: Uint8Array;
}>;

let configuredManagedDemandStart: SynapseDemandStart | undefined;

export function configureSynapseManagedDemandStart(
    demandStart: SynapseDemandStart | undefined,
): void {
    configuredManagedDemandStart = demandStart;
}

/**
 * A per-query timeout would detach every waiter mid-startup and demote the lane to its fallback while shared startup succeeds.
 */
const SYNAPSE_DEMAND_STARTUP_BUDGET_MS = OUTER_AGGREGATE_MS + STORAGE_HARD_BUDGET_MS;
/** A failed demand is not retried per embed call; each retry spawns a native lifecycle process. */
const SYNAPSE_DEMAND_RETRY_BACKOFF_MS = 5_000;

function defaultConnectionFile(): string {
    // The managed lifecycle owner publishes the daemon under the lifecycle data root.
    // The client must use the same resolver byte-for-byte to avoid dialing a different path after demand reports ready.
    return defaultConnectionFilePath(getDataDir());
}

async function raceSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        throw signal.reason ?? new Error("Synapse initialization aborted");
    }
    let onAbort: (() => void) | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                onAbort = () =>
                    reject(signal.reason ?? new Error("Synapse initialization aborted"));
                signal.addEventListener("abort", onAbort, { once: true });
            }),
        ]);
    } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

export class SynapseEmbeddingError extends Error {
    readonly code: SynapseErrorCode;
    readonly retryAfterMs?: number;
    readonly permanent: boolean;
    /** The ledger receipt identifies the record of this failure when one exists. */
    ledgerRowId?: number;
    /**
     * The fence failure maps to `transport` because no byte was enqueued.
     * Classification maps the fence failure to `transport`; only `module_restarted` evidence spends a page's retry budget.
     * A caller that can re-derive the binding can resubmit the identical request key without consuming the durable restart budget.
     */
    prePublicationFence?: boolean;
    /**
     * The failed attempt records the daemon identity it published against.
     * Recovery compares `attemptDaemonId` with the certified identity because the installed identity can advance during an attempt.
     */
    attemptDaemonId?: Uint8Array | null;

    constructor(
        code: SynapseErrorCode,
        message: string,
        options?: { retryAfterMs?: number; permanent?: boolean; cause?: unknown },
    ) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "SynapseEmbeddingError";
        this.code = code;
        this.permanent = options?.permanent ?? isPermanentSynapseCode(code);
        this.retryAfterMs =
            options?.retryAfterMs ?? (this.permanent || code === "cancelled" ? undefined : 100);
    }
}

function isPermanentSynapseCode(code: string): boolean {
    return (
        code === "artifact_invalid" ||
        code === "substitution_rejected" ||
        code === "not_certified" ||
        code === "probe_required" ||
        code === "idempotency_conflict" ||
        code === "page_terminal" ||
        code === "schema_violation"
    );
}

/**
 * Only lane-wide permanent-code evidence can condemn a lane.
 *
 * `idempotency_conflict` and `page_terminal` apply only to the affected ledger row.
 * `schema_violation` applies only to the request that produced it.
 * `schema_violation` covers the request items or reply shape.
 * A host per-input-cap violation applies only to the affected row.
 * Other pages remain embeddable after a per-input-cap violation.
 *
 * `artifact_invalid`, `substitution_rejected`, `not_certified`, and `probe_required` are lane-wide because they describe the served model.
 * Each lane-wide condition holds for every page the lane would submit.
 * Lane-wide permanent failures disable the lane until rediscovery.
 */
function isPageScopedSynapseCode(code: string): boolean {
    return (
        code === "idempotency_conflict" || code === "page_terminal" || code === "schema_violation"
    );
}

/**
 * Invalid advertisements preserve the client default.
 *
 */
export function normalizeSynapseTokenBudget(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    const floored = Math.floor(value);
    return floored > 0 && Number.isSafeInteger(floored) ? floored : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function responseBody(value: unknown): Record<string, unknown> {
    const record = asRecord(value);
    const result = asRecord(record?.result);
    return result ? { ...record, ...result } : (record ?? {});
}

function readRetryAfter(value: unknown): number | undefined {
    const record = asRecord(value);
    const candidate = record?.retry_after_ms ?? record?.retryAfterMs;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)
        return undefined;
    return Math.ceil(candidate);
}

function readErrorCode(value: unknown): string | undefined {
    const record = asRecord(value);
    if (typeof record?.code === "string") return record.code;
    if (value instanceof Error && "code" in value && typeof value.code === "string") {
        return value.code;
    }
    return undefined;
}

function classifyError(value: unknown): SynapseEmbeddingError {
    if (value instanceof SynapseEmbeddingError) return value;
    const code = readErrorCode(value) ?? (value instanceof Error ? value.name : "transport");
    const normalized = code.toLowerCase();
    let mapped: SynapseErrorCode = "transport";
    if (normalized.includes("queue_full")) mapped = "queue_full";
    else if (normalized.includes("model_loading")) mapped = "model_loading";
    else if (normalized.includes("timeout") || normalized.includes("deadline")) mapped = "timeout";
    else if (normalized.includes("artifact_invalid")) mapped = "artifact_invalid";
    else if (normalized.includes("substitution")) mapped = "substitution_rejected";
    else if (normalized.includes("not_certified")) mapped = "not_certified";
    else if (normalized.includes("probe_required")) mapped = "probe_required";
    else if (normalized.includes("idempotency_conflict")) mapped = "idempotency_conflict";
    else if (normalized.includes("schema")) mapped = "schema_violation";
    // A `daemon_generation_changed` rejection is a pre-publication transport failure, not `module_restarted` evidence.
    // No request reaches the daemon after a `daemon_generation_changed` rejection.
    // `module_restarted` evidence consumes a page's single durable restart budget.
    else if (normalized.includes("daemon_generation_changed")) mapped = "transport";
    else if (normalized.includes("abort")) mapped = "cancelled";
    else if (normalized.includes("cancel")) mapped = "transport";
    else if (normalized.includes("module_restarted") || normalized.includes("module restarted"))
        mapped = "module_restarted";
    const message = value instanceof Error ? value.message : String(value);
    return new SynapseEmbeddingError(mapped, message, {
        retryAfterMs:
            readRetryAfter(value) ??
            (isPermanentSynapseCode(mapped) || mapped === "cancelled" ? undefined : 100),
        cause: value,
    });
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 */
type SynapseCallParams =
    | Record<string, unknown>
    | ((deadlineMs: number) => Record<string, unknown>);

interface PollDelayState {
    nextDelayMs: number;
    defaultDelayMs: number;
}

/**
 * `null` means no delay; done replies and cursored vector pages return `null`.
 */
function pendingPollDelay(
    parsed: Record<string, unknown>,
    hasVectors: boolean,
    deadlineAt: number,
    state: PollDelayState,
    now: number,
): number | null {
    if (parsed.done === true || (hasVectors && parsed.next_cursor != null)) return null;
    const cap = Math.max(SYNAPSE_POLL_MIN_DELAY_MS, readRetryAfter(parsed) ?? state.defaultDelayMs);
    const current = state.nextDelayMs;
    state.nextDelayMs = Math.max(
        SYNAPSE_POLL_MIN_DELAY_MS,
        current * SYNAPSE_POLL_DELAY_MULTIPLIER,
    );
    return Math.min(current, cap, Math.max(0, deadlineAt - now));
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

export function getSynapseLaneIdentity(model: string, fingerprint: string): string {
    return `synapse:v1:${sha256(stableJson({ model, fingerprint }))}`;
}

export function getSynapseBatchRequestKey(args: {
    model: string;
    fingerprint: string;
    tableEpoch: number;
    items: readonly { id: string; contentSha256: string }[];
}): string {
    return sha256(
        stableJson({
            op: "embed.batch",
            model: args.model,
            required_fingerprint: args.fingerprint,
            required_epoch: args.tableEpoch,
            allow_equivalent: false,
            accept_declared: false,
            ids: args.items.map((item) => item.id),
            content_sha256: args.items.map((item) => item.contentSha256),
        }),
    );
}

function hashContent(text: string): string {
    return sha256(text);
}

function extractCatalogEntries(value: unknown): SynapseCatalogEntry[] {
    const body = responseBody(value);
    const raw = Array.isArray(body.models)
        ? body.models
        : Array.isArray(body.entries)
          ? body.entries
          : Array.isArray(value)
            ? value
            : [];
    const envelopeEpoch =
        typeof body.table_epoch === "number" && Number.isInteger(body.table_epoch)
            ? body.table_epoch
            : undefined;
    return raw.flatMap((entry) => {
        const record = asRecord(entry);
        if (!record) return [];
        const model =
            typeof record.model === "string" && record.model.length > 0
                ? record.model
                : typeof record.model_id === "string"
                  ? record.model_id
                  : "";
        const fingerprint =
            typeof record.fingerprint === "string" && record.fingerprint.length > 0
                ? record.fingerprint
                : Array.isArray(record.fingerprints) && typeof record.fingerprints[0] === "string"
                  ? record.fingerprints[0]
                  : "";
        const entryEpoch = record.table_epoch ?? record.tableEpoch;
        const tableEpoch =
            typeof entryEpoch === "number" && Number.isInteger(entryEpoch)
                ? entryEpoch
                : envelopeEpoch;
        const dims = record.dims ?? record.dimensions;
        if (
            model.length === 0 ||
            fingerprint.length === 0 ||
            typeof tableEpoch !== "number" ||
            !Number.isInteger(tableEpoch)
        ) {
            return [];
        }
        const rawBatch = record.recommended_batch ?? record.recommendedBatch;
        const batchRecord = asRecord(rawBatch);
        const recommendedBatch =
            typeof rawBatch === "number" ? rawBatch : batchRecord ? batchRecord.rows : undefined;
        const recommendedTokenBudget = batchRecord
            ? normalizeSynapseTokenBudget(batchRecord.token_budget)
            : undefined;
        const maxInputTokens = record.max_input_tokens ?? record.maxInputTokens;
        const maxInputBytes = record.max_input_bytes ?? record.maxInputBytes;
        if (
            maxInputBytes !== undefined &&
            (typeof maxInputBytes !== "number" ||
                !Number.isInteger(maxInputBytes) ||
                maxInputBytes < 4)
        ) {
            return [];
        }
        const state = typeof record.state === "string" ? record.state : undefined;
        return [
            {
                model,
                fingerprint,
                table_epoch: tableEpoch,
                ...(typeof dims === "number" && Number.isInteger(dims) && dims > 0 ? { dims } : {}),
                ...(typeof recommendedBatch === "number" && recommendedBatch > 0
                    ? { recommended_batch: Math.floor(recommendedBatch) }
                    : {}),
                ...(recommendedTokenBudget !== undefined
                    ? { recommended_token_budget: recommendedTokenBudget }
                    : {}),
                ...(typeof maxInputTokens === "number" &&
                Number.isInteger(maxInputTokens) &&
                maxInputTokens > 0
                    ? { max_input_tokens: maxInputTokens }
                    : {}),
                ...(typeof maxInputBytes === "number" &&
                Number.isInteger(maxInputBytes) &&
                maxInputBytes >= 4
                    ? { max_input_bytes: maxInputBytes }
                    : {}),
                ...(record.provenance !== undefined ? { provenance: record.provenance } : {}),
                ...(typeof record.certified === "boolean" ? { certified: record.certified } : {}),
                ...(typeof record.status === "string"
                    ? { status: record.status }
                    : state
                      ? { status: state }
                      : {}),
            },
        ];
    });
}

function extractVector(
    value: unknown,
): { vector: Float32Array; metadata: Record<string, unknown> } | null {
    const body = responseBody(value);
    const fromVectors = Array.isArray(body.vectors) ? asRecord(body.vectors[0])?.vector : undefined;
    const raw = fromVectors ?? body.vector ?? body.embedding;
    if (
        !Array.isArray(raw) ||
        raw.some((item) => typeof item !== "number" || !Number.isFinite(item))
    ) {
        return null;
    }
    return { vector: Float32Array.from(raw), metadata: body };
}

function extractBatchItems(value: unknown): Array<Record<string, unknown>> {
    const body = responseBody(value);
    const raw = Array.isArray(body.vectors)
        ? body.vectors
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.results)
            ? body.results
            : [];
    return raw.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
    });
}

const factoryClients = new WeakMap<() => Promise<SynapseClientLike>, Promise<SynapseClientLike>>();
let sharedClient: SynapseClientLike | null = null;
let sharedClientFile: string | null = null;
let sharedClientPromise: Promise<SynapseClientLike> | null = null;

async function getSharedClient(
    options: SynapseEmbeddingProviderOptions,
): Promise<SynapseClientLike> {
    const factory = options.clientFactory;
    if (factory) {
        // same process.
        let promise = factoryClients.get(factory);
        if (!promise) {
            promise = factory();
            factoryClients.set(factory, promise);
            promise.catch(() => {
                // The rejection handler evicts only the promise it rejected, preserving any replacement promise.
                // The next call creates a fresh client after a rejected connection promise.
                if (factoryClients.get(factory) === promise) factoryClients.delete(factory);
            });
        }
        return promise;
    }
    const file = options.connectionFile ?? defaultConnectionFile();
    const promise = processMcHostClient({
        connectionFile: file,
        handshakeTimeoutMs: SYNAPSE_HANDSHAKE_TIMEOUT_MS,
    });
    sharedClientFile = file;
    sharedClientPromise = promise;
    void promise.then(
        (client) => {
            if (sharedClientPromise === promise) sharedClient = client;
        },
        () => {
            if (sharedClientPromise !== promise) return;
            sharedClient = null;
            sharedClientFile = null;
            sharedClientPromise = null;
        },
    );
    return promise;
}

export class SynapseEmbeddingProvider implements EmbeddingProvider {
    modelId: string;
    maxInputTokens: number;
    maxInputBytes: number;
    metadata: SynapseLaneMetadata | null;

    /**
     * provider.
     *
     * The registry replaces lanes with lane-wide permanent failures but retains pending `models.list` lanes.
     * `initialize()` cannot rediscover a lane after `permanentFailure` latches.
     * A pending lane must remain cached because its `onLaneReady` callback is bound to that instance.
     * The registry identity guard drops the callback commit if a replacement takes the pending lane's place.
     */
    get laneDiscoveryState(): "pending" | "resolved" | "failed" {
        if (this.metadata) return "resolved";
        return this.permanentFailure ? "failed" : "pending";
    }

    /// `pageTimeoutMs` gives provider pages and external reopens of the same row one deadline basis.
    readonly pageTimeoutMs: number;

    private readonly options: SynapseEmbeddingProviderOptions;
    private readonly connectionOrigin: ConnectionOrigin;
    private readonly demandStart: SynapseDemandStart | undefined;
    private compatibleDaemonId: Uint8Array | null = null;
    private client: SynapseClientLike | null = null;
    private initialized = false;
    private initializing: Promise<boolean> | null = null;
    private managedDemand: ReturnType<SynapseDemandStart> | null = null;
    private demandFailedUntilMs = 0;
    private permanentFailure = false;
    private batchLimit = 16;
    private tokenBudget: number | null = null;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly pollInitialDelayMs: number;
    private readonly pollDefaultDelayMs: number;

    constructor(options: SynapseEmbeddingProviderOptions) {
        this.options = options;
        this.connectionOrigin = options.clientFactory
            ? "injected"
            : (options.connectionOrigin ??
              resolveConnectionOrigin({ connectionFile: options.connectionFile }));
        this.demandStart = options.demandStart ?? configuredManagedDemandStart;
        this.sleep = options.sleep ?? wait;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.pollInitialDelayMs = this.positiveOption(
            options.pollInitialDelayMs,
            SYNAPSE_POLL_INITIAL_DELAY_MS,
        );
        this.pollDefaultDelayMs = this.positiveOption(
            options.pollDefaultDelayMs,
            SYNAPSE_POLL_DEFAULT_DELAY_MS,
        );
        this.pageTimeoutMs = options.batchTimeoutMs ?? SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS;
        const model = options.model || SYNAPSE_DEFAULT_MODEL;
        const fingerprint = options.fingerprint ?? "";
        const maxInputTokens =
            typeof options.maxInputTokens === "number" &&
            Number.isInteger(options.maxInputTokens) &&
            options.maxInputTokens > 0
                ? options.maxInputTokens
                : undefined;
        const maxInputBytes =
            typeof options.maxInputBytes === "number" &&
            Number.isInteger(options.maxInputBytes) &&
            options.maxInputBytes >= 4
                ? options.maxInputBytes
                : undefined;
        const recommendedTokenBudget = normalizeSynapseTokenBudget(options.recommendedTokenBudget);
        this.metadata =
            fingerprint &&
            Number.isInteger(options.tableEpoch) &&
            Number.isInteger(options.dims) &&
            (options.dims ?? 0) > 0
                ? {
                      model,
                      fingerprint,
                      table_epoch: options.tableEpoch as number,
                      dims: options.dims as number,
                      ...(options.recommendedBatch
                          ? { recommended_batch: Math.max(1, Math.floor(options.recommendedBatch)) }
                          : {}),
                      ...(recommendedTokenBudget !== undefined
                          ? { recommended_token_budget: recommendedTokenBudget }
                          : {}),
                      ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
                      ...(maxInputBytes !== undefined ? { max_input_bytes: maxInputBytes } : {}),
                      ...(options.provenance !== undefined
                          ? { provenance: options.provenance }
                          : {}),
                      laneIdentity: getSynapseLaneIdentity(model, fingerprint),
                  }
                : null;
        this.modelId = this.metadata?.laneIdentity ?? "synapse:v1:pending";
        this.batchLimit = this.metadata?.recommended_batch ?? 16;
        this.tokenBudget = this.metadata?.recommended_token_budget ?? null;
        this.maxInputTokens = maxInputTokens ?? SYNAPSE_MAX_INPUT_TOKENS;
        this.maxInputBytes = maxInputBytes ?? SYNAPSE_MAX_INPUT_BYTES;
    }

    /**
     */
    private nextPage(
        items: readonly { id: string; text: string; contentSha256: string }[],
        start: number,
    ): readonly { id: string; text: string; contentSha256: string }[] {
        const hardEnd = Math.min(items.length, start + this.batchLimit);
        if (this.tokenBudget === null) return items.slice(start, hardEnd);
        let end = start;
        let tokens = 0;
        while (end < hardEnd) {
            tokens += Math.ceil(items[end].text.length / 4);
            if (tokens > this.tokenBudget && end > start) break;
            end += 1;
        }
        return items.slice(start, Math.max(end, start + 1));
    }

    static async discover(options: SynapseEmbeddingProviderOptions): Promise<SynapseLaneMetadata> {
        const provider = new SynapseEmbeddingProvider(options);
        if (!(await provider.initialize()) || !provider.metadata) {
            throw new SynapseEmbeddingError("not_certified", "Synapse lane is not ready");
        }
        return provider.metadata;
    }

    /**
     * The initialization flight shares one managed-daemon demand and native invocation among concurrent initializers.
     * A missing lifecycle owner leaves initialization dial-only so explicit and CLI contexts can reach an already-running daemon.
     */
    private async demandManagedLane(deadlineMs?: number): Promise<void> {
        if (this.connectionOrigin !== "managed-default" || !this.demandStart) return;
        if (this.now() < this.demandFailedUntilMs) {
            throw new SynapseEmbeddingError(
                "transport",
                "managed Synapse demand recently failed; backing off",
            );
        }
        // A `demandStart` rejection arms the same backoff as `{ ok: false }`.
        // Shared initialization never passes a waiter's abort signal to `demandStart`.
        let demand = this.managedDemand;
        if (!demand) {
            demand = this.demandStart({
                origin: this.connectionOrigin,
                capability: "synapse",
                deadlineMs: deadlineMs ?? SYNAPSE_DEMAND_STARTUP_BUDGET_MS,
            });
            this.managedDemand = demand;
            const evict = (): void => {
                if (this.managedDemand === demand) this.managedDemand = null;
            };
            void demand.then(evict, evict);
        }
        let outcome: Awaited<ReturnType<SynapseDemandStart>>;
        try {
            outcome = await demand;
        } catch (error) {
            if (error instanceof WaiterDetachedError) throw error;
            this.demandFailedUntilMs = this.now() + SYNAPSE_DEMAND_RETRY_BACKOFF_MS;
            if (error instanceof SynapseEmbeddingError) throw error;
            throw new SynapseEmbeddingError(
                "transport",
                `managed Synapse demand failed: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
        if (!outcome.ok) {
            this.demandFailedUntilMs = this.now() + SYNAPSE_DEMAND_RETRY_BACKOFF_MS;
            throw new SynapseEmbeddingError(
                "transport",
                `managed Synapse demand failed: ${outcome.reason}`,
            );
        }
        if (outcome.authenticatedDaemonId === undefined) {
            // `authenticatedDaemonId` is required to fence this lane.
            // `authenticatedDaemonId === undefined` is a failed demand outcome and arms the retry backoff.
            this.demandFailedUntilMs = this.now() + SYNAPSE_DEMAND_RETRY_BACKOFF_MS;
            throw new SynapseEmbeddingError(
                "transport",
                "managed lifecycle compatibility returned no daemon identity",
            );
        }
        this.compatibleDaemonId = Uint8Array.from(outcome.authenticatedDaemonId);
    }

    async initialize(signal?: AbortSignal, demandDeadlineMs?: number): Promise<boolean> {
        if (this.initialized) return true;
        if (this.permanentFailure) return false;
        if (this.initializing) {
            const shared = this.initializing;
            if (!signal) return shared;
            try {
                return await raceSignal(shared, signal);
            } catch {
                // The provider retains the shared initialization after this waiter detaches.
                return false;
            }
        }
        // The provider creates no flight for an aborted caller; existing flights may outlive detached callers.
        // An aborted caller cannot create a flight because a new flight can start `mc-host` and schedule shadow backfill without a waiter.
        if (signal?.aborted) return false;
        this.initializing = (async () => {
            try {
                await this.demandManagedLane(demandDeadlineMs);
                this.client = await getSharedClient(this.options);
                if (!this.metadata) {
                    const discovered = await this.callWithRetry<SynapseCatalogEntry[]>(
                        "models.list",
                        {},
                        this.options.queryTimeoutMs ?? SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS,
                        false,
                    );
                    const entries = extractCatalogEntries(discovered);
                    const requested = this.options.model?.trim() || SYNAPSE_DEFAULT_MODEL;
                    const entry = entries.find((candidate) => candidate.model === requested);
                    if (!entry) {
                        throw new SynapseEmbeddingError(
                            "artifact_invalid",
                            `Synapse models.list did not return requested model ${requested}`,
                        );
                    }
                    if (entry.certified === false || entry.status === "not_certified") {
                        throw new SynapseEmbeddingError(
                            "not_certified",
                            `Synapse model ${entry.model} is not certified`,
                        );
                    }
                    // The registry refuses rediscovered lanes whose artifact identity differs from the pinned registration.
                    // Pinned registration rows remain keyed by the pinned identity.
                    // The registry rejects the rotated lane so routing rebuilds the registration under its new identity.
                    const pinnedFingerprint = this.options.fingerprint;
                    if (pinnedFingerprint && entry.fingerprint !== pinnedFingerprint) {
                        throw new SynapseEmbeddingError(
                            "substitution_rejected",
                            `Synapse model ${entry.model} now serves fingerprint ${entry.fingerprint}, but this lane is registered under ${pinnedFingerprint}`,
                        );
                    }
                    const pinnedEpoch = this.options.tableEpoch;
                    if (Number.isInteger(pinnedEpoch) && entry.table_epoch !== pinnedEpoch) {
                        throw new SynapseEmbeddingError(
                            "substitution_rejected",
                            `Synapse model ${entry.model} now serves table epoch ${entry.table_epoch}, but this lane is registered under ${pinnedEpoch}`,
                        );
                    }
                    const metadata: SynapseLaneMetadata = {
                        ...entry,
                        laneIdentity: getSynapseLaneIdentity(entry.model, entry.fingerprint),
                    };
                    this.metadata = metadata;
                    this.modelId = metadata.laneIdentity;
                    this.batchLimit = metadata.recommended_batch ?? this.batchLimit;
                    this.tokenBudget = metadata.recommended_token_budget ?? this.tokenBudget;
                    this.maxInputTokens = metadata.max_input_tokens ?? this.maxInputTokens;
                    this.maxInputBytes = metadata.max_input_bytes ?? this.maxInputBytes;
                }
                if (this.metadata) this.options.onLaneReady?.(this.metadata);
                this.initialized = true;
                return true;
            } catch (error) {
                const classified = classifyError(error);
                if (classified.permanent) {
                    this.permanentFailure = true;
                    log(
                        `[magic-context] Synapse lane disabled: ${classified.code}: ${classified.message}`,
                    );
                } else {
                    log(`[magic-context] Synapse lane unavailable: ${classified.message}`);
                }
                this.initialized = false;
                return false;
            } finally {
                this.initializing = null;
            }
        })();
        const initialization = this.initializing;
        if (!signal) return initialization;
        try {
            return await raceSignal(initialization, signal);
        } catch {
            return false;
        }
    }

    /**
     * A restart resubmission requires fresh managed-lane certification within the page's remaining budget.
     * The restart budget permits one resubmission.
     * A resubmission may publish only against a freshly certified incarnation.
     * Clearing `initialized` makes `initialize` re-derive the managed lane identity.
     * demand.
     *
     * A caller-supplied connection cannot be re-derived by this client.
     *
     * Only `initialize` writes the identity, and only after successful initialization.
     * A page that spent its restart budget would otherwise fail permanently on a fence it had already re-established.
     * The client fence rejects an identity rotation before any byte is written.
     * A client-fence rejection consumes the sibling operation's `module_restarted` retry.
     */
    private async rebindAfterModuleRestart(
        deadlineAt: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (this.connectionOrigin !== "managed-default") return;
        this.initialized = false;
        this.managedDemand = null;
        const remainingMs = deadlineAt - this.now();
        if (remainingMs <= 0) {
            throw new SynapseEmbeddingError("timeout", "Synapse page deadline exhausted");
        }
        if (!(await this.initialize(signal, remainingMs))) {
            if (signal?.aborted) {
                throw new SynapseEmbeddingError("cancelled", "Synapse request aborted");
            }
            throw new SynapseEmbeddingError(
                "transport",
                "Synapse daemon compatibility rebind failed",
            );
        }
    }

    async embed(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
        if (!(await this.initialize(signal)) || signal?.aborted || !this.metadata) return null;
        try {
            // `retryEmbeddings=true` retries an ambiguous send.
            // `embed.query` carries no `request_key` because it is a pure computation over its input with no daemon-side state.
            // A duplicate dispatch wastes compute but does not corrupt daemon state.
            // `embed.batch` and `embed.result` create ledger state that the daemon must deduplicate.
            const value = await this.callWithRetry(
                "embed.query",
                (deadlineMs: number) => this.requestConstraints({ text, deadline_ms: deadlineMs }),
                this.options.queryTimeoutMs ?? SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS,
                true,
                signal,
            );
            const extracted = extractVector(value);
            if (!extracted)
                throw new SynapseEmbeddingError(
                    "schema_violation",
                    "Synapse query returned no vector",
                );
            this.validateResponse(extracted.metadata, extracted.vector.length);
            return extracted.vector;
        } catch (error) {
            this.logCallFailure(error, "embed.query");
            return null;
        }
    }

    async embedBatch(texts: string[], signal?: AbortSignal): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) return [];
        const items = texts.map((text, index) => ({
            id: `item:${index}`,
            text,
            contentSha256: hashContent(text),
        }));
        const map = await this.embedItems(items, signal);
        return items.map((item) => map.get(item.id) ?? null);
    }

    async embedItems(
        items: readonly { id: string; text: string; contentSha256: string }[],
        signal?: AbortSignal,
    ): Promise<Map<string, Float32Array>> {
        const output = new Map<string, Float32Array>();
        if (
            items.length === 0 ||
            !(await this.initialize(signal)) ||
            !this.metadata ||
            signal?.aborted
        ) {
            return output;
        }
        for (let start = 0; start < items.length; ) {
            if (signal?.aborted || this.permanentFailure) break;
            // A `module_restarted` failure on an earlier page invalidated the lane's lifecycle certification.
            // The client reruns full initialization so remaining pages proceed only against an incarnation that passed lifecycle compatibility validation.
            // Remaining pages proceed only against an incarnation that re-passed lifecycle compatibility validation.
            if (!this.initialized && !(await this.initialize(signal))) break;
            const page = this.nextPage(items, start);
            start += page.length;
            try {
                const requestKey = this.requestKey(page);
                let body: unknown = {};
                let restarted = false;
                // Submission, polling, and any `module_restarted` resubmission share one absolute page deadline.
                // A `module_restarted` resubmission uses the page's remaining deadline budget.
                const deadlineAt = this.now() + this.pageTimeoutMs;
                for (;;) {
                    try {
                        const remainingMs = deadlineAt - this.now();
                        if (remainingMs <= 0) {
                            throw new SynapseEmbeddingError(
                                "timeout",
                                "Synapse page deadline exhausted",
                            );
                        }
                        body = await this.callWithRetry(
                            "embed.batch",
                            this.batchRequest(page, requestKey),
                            Math.max(0, deadlineAt - this.now()),
                            true,
                            signal,
                        );
                        const first = responseBody(body);
                        const jobId = typeof first.job_id === "string" ? first.job_id : null;
                        if (jobId) {
                            body = await this.pollBatch(
                                jobId,
                                requestKey,
                                readRetryAfter(first),
                                deadlineAt,
                                signal,
                            );
                        }
                        break;
                    } catch (error) {
                        const classified = classifyError(error);
                        if (classified.code !== "module_restarted" || restarted) throw classified;
                        restarted = true;
                        await this.rebindAfterModuleRestart(deadlineAt, signal);
                    }
                }
                const batchEnvelope = responseBody(body);
                for (const item of extractBatchItems(body)) {
                    const id = typeof item.id === "string" ? item.id : "";
                    const vector = item.vector ?? item.embedding;
                    if (!id || !Array.isArray(vector)) {
                        throw new SynapseEmbeddingError(
                            "schema_violation",
                            "Synapse batch item is malformed",
                        );
                    }
                    const expected = page.find((candidate) => candidate.id === id);
                    if (!expected) {
                        throw new SynapseEmbeddingError(
                            "schema_violation",
                            `Synapse returned unknown item ${id}`,
                        );
                    }
                    if (
                        typeof item.content_sha256 === "string" &&
                        item.content_sha256 !== expected.contentSha256
                    ) {
                        throw new SynapseEmbeddingError(
                            "artifact_invalid",
                            `Synapse content hash mismatch for item ${id}`,
                        );
                    }
                    const vectorArray = Float32Array.from(vector as number[]);
                    this.validateResponse({ ...batchEnvelope, ...item }, vectorArray.length);
                    output.set(id, vectorArray);
                }
            } catch (error) {
                const classified = classifyError(error);
                this.logCallFailure(classified, "embed.batch");
                if (classified.code === "idempotency_conflict") throw classified;
                // A page-scoped code applies only to that page, so remaining pages continue on a live lane.
                if (classified.permanent && !isPageScopedSynapseCode(classified.code)) {
                    this.permanentFailure = true;
                    this.initialized = false;
                    break;
                }
            }
        }
        return output;
    }

    async embedItemsDetailed(
        items: readonly DetailedEmbedItem[],
        context: DetailedEmbedContext,
        signal?: AbortSignal,
    ): Promise<DetailedEmbedResult> {
        const result: DetailedEmbedResult = { receipts: [], failures: [] };
        if (items.length === 0) return result;
        const groups = new Map<string, DetailedEmbedItem[]>();
        for (const item of items) {
            const group = groups.get(item.applicationGroup);
            if (group) group.push(item);
            else groups.set(item.applicationGroup, [item]);
        }
        const ready = await this.initialize(signal);
        if (!ready || !this.metadata) {
            const cancelled = signal?.aborted === true;
            for (const [applicationGroup, groupItems] of groups) {
                result.failures.push({
                    applicationGroup,
                    items: groupItems.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                    rowId: null,
                    code: this.permanentFailure
                        ? "artifact_invalid"
                        : cancelled
                          ? "cancelled"
                          : "transport",
                    message: cancelled ? "Synapse request aborted" : "Synapse lane is unavailable",
                    disposition: this.permanentFailure ? "permanent" : "retryable",
                });
            }
            return result;
        }
        for (const [applicationGroup, groupItems] of groups) {
            // The client cuts pages inside one group only, so a provider page can never span two application transaction groups.
            for (let start = 0; start < groupItems.length; ) {
                const page = this.nextPage(groupItems, start) as readonly DetailedEmbedItem[];
                start += page.length;
                const manifest = page.map(({ id, contentSha256 }) => ({ id, contentSha256 }));
                if (signal?.aborted || this.permanentFailure) {
                    result.failures.push({
                        applicationGroup,
                        items: manifest,
                        rowId: null,
                        code: this.permanentFailure ? "artifact_invalid" : "cancelled",
                        message: this.permanentFailure
                            ? "Synapse lane disabled after a permanent failure"
                            : "Synapse request aborted",
                        disposition: this.permanentFailure ? "permanent" : "retryable",
                    });
                    continue;
                }
                // The client re-validates the daemon identity before this page proceeds.
                // The client verifies the daemon identity before resubmitting the page.
                if (!this.initialized && !(await this.initialize(signal))) {
                    // The client re-reads `signal` because `initialize` returns `false` when its await observes an abort.
                    // The client re-reads `signal` because `initialize` returns `false` on abort; otherwise cancellation records the current page as retryable `transport`.
                    const aborted = signal?.aborted === true;
                    result.failures.push({
                        applicationGroup,
                        items: manifest,
                        rowId: null,
                        code: this.permanentFailure
                            ? "artifact_invalid"
                            : aborted
                              ? "cancelled"
                              : "transport",
                        message: this.permanentFailure
                            ? "Synapse lane disabled after a permanent failure"
                            : aborted
                              ? "Synapse request aborted"
                              : "Synapse lane is unavailable",
                        disposition: this.permanentFailure ? "permanent" : "retryable",
                    });
                    continue;
                }
                try {
                    result.receipts.push(
                        await this.runDetailedPage(page, applicationGroup, context, signal),
                    );
                } catch (error) {
                    const classified = classifyError(error);
                    // `logCallFailure` permanently disables the lane only for lane-wide errors; page-scoped errors leave later groups embeddable.
                    this.logCallFailure(classified, "embed.batch");
                    result.failures.push({
                        applicationGroup,
                        items: manifest,
                        rowId: classified.ledgerRowId ?? null,
                        code: classified.code,
                        message: classified.message,
                        disposition: classified.permanent ? "permanent" : "retryable",
                    });
                }
            }
        }
        return result;
    }

    private async runDetailedPage(
        page: readonly DetailedEmbedItem[],
        applicationGroup: string,
        context: DetailedEmbedContext,
        signal?: AbortSignal,
    ): Promise<EmbeddingPageReceipt> {
        const db = context.db;
        const requestKey = this.requestKey(page);
        const manifest: SynapseLedgerManifestItem[] = page.map(({ id, contentSha256 }) => ({
            id,
            contentSha256,
        }));
        const identity: SynapseLedgerPageIdentity = {
            projectPath: context.projectPath,
            sessionId: context.sessionId,
            scope: context.scope,
            laneRole: context.laneRole,
            destinationModel: this.modelId,
            applicationGroup,
            requestKey,
        };
        const timeoutMs = this.pageTimeoutMs;
        const freshPage = () =>
            createSynapseLedgerPage(db, {
                ...identity,
                manifest,
                deadlineAt: this.now() + timeoutMs,
            });
        const openPage = () => {
            const existing = findSynapseLedgerPage(db, identity);
            if (existing) return existing;
            try {
                return freshPage();
            } catch (error) {
                // The client attaches to the concurrently created row because that row already runs the page.
                if (!(error instanceof SynapseLedgerConflictError)) throw error;
                const winner = findSynapseLedgerPage(db, identity);
                if (!winner) throw error;
                return winner;
            }
        };
        let row = openPage();

        if (row.state === "complete") {
            const error = new SynapseEmbeddingError(
                "idempotency_conflict",
                "receipt is already complete; reopening requires destination proof (R24)",
                { permanent: true },
            );
            error.ledgerRowId = row.rowId;
            throw error;
        }
        if (row.state === "failed") {
            if (row.failureDisposition === "permanent") {
                // The client keeps a permanent row because rebuilding it would resubmit the rejected request; changed content hashes, table epoch, or fingerprint produce a different request key.
                const error = new SynapseEmbeddingError(
                    "page_terminal",
                    "page failed permanently; the same request identity is not resubmitted",
                );
                error.ledgerRowId = row.rowId;
                throw error;
            }
            if (row.failureDisposition === "retryable" && (row.deadlineAt ?? 0) > this.now()) {
                row = retrySynapseLedgerPage(db, {
                    rowId: row.rowId,
                    expectedStateVersion: row.stateVersion,
                });
            } else {
                markSynapseLedgerObsolete(db, {
                    rowId: row.rowId,
                    expectedStateVersion: row.stateVersion,
                });
                row = freshPage();
            }
        }
        if (row.state === "ready") {
            // A ready row without applied destinations requires re-deriving vectors from the retained job.
            // The client obsoletes and rebuilds an expired row because polling cannot observe `module_restarted` after its deadline.
            if (row.jobId && (row.deadlineAt ?? 0) > this.now()) {
                try {
                    const vectors = await this.collectJobPages(
                        row.jobId,
                        requestKey,
                        page,
                        row.deadlineAt ?? this.now() + timeoutMs,
                        signal,
                    );
                    return {
                        rowId: row.rowId,
                        stateVersion: row.stateVersion,
                        applicationGroup,
                        items: manifest,
                        vectors,
                    };
                } catch (error) {
                    const classified = classifyError(error);
                    if (classified.code !== "module_restarted") {
                        // The client retires a ready row with lost vectors so the next pass creates and submits a pending row.
                        markSynapseLedgerObsolete(db, {
                            rowId: row.rowId,
                            expectedStateVersion: row.stateVersion,
                        });
                        classified.ledgerRowId = row.rowId;
                        throw classified;
                    }
                    // Resubmitting after restart consumes the page's single durable restart, matching the polling path.
                    // An unchecked rebuild resets `restartCount` to 0, granting a new restart on every pass.
                    // An unchecked rebuild resets restartCount to 0, granting a new restart on every pass.
                    // A restarting daemon can otherwise resubmit the page without bound.
                    // `page_terminal` scopes an exhausted restart budget to this row.
                    // `page_terminal` does not block other pages in the lane.
                    const readyDeadlineAt = row.deadlineAt ?? 0;
                    if (row.restartCount !== 0 || readyDeadlineAt <= this.now()) {
                        const terminal = new SynapseEmbeddingError(
                            "page_terminal",
                            "restart budget or page deadline exhausted",
                        );
                        terminal.ledgerRowId = row.rowId;
                        throw terminal;
                    }
                    await this.rebindAfterModuleRestart(readyDeadlineAt, signal);
                }
            }
            markSynapseLedgerObsolete(db, {
                rowId: row.rowId,
                expectedStateVersion: row.stateVersion,
            });
            row = freshPage();
        }

        const deadlineAt = row.deadlineAt ?? this.now() + timeoutMs;
        let servedPollDelayMs: number | undefined;
        try {
            if (row.state === "pending") {
                const submitted = await this.submitBatchPageWithRebind(
                    page,
                    requestKey,
                    deadlineAt,
                    signal,
                );
                servedPollDelayMs = submitted.retryAfterMs;
                row = markSynapseLedgerPolling(db, {
                    rowId: row.rowId,
                    expectedStateVersion: row.stateVersion,
                    attemptId: randomUUID(),
                    jobId: submitted.jobId,
                });
            }
            for (;;) {
                if (!row.jobId) {
                    const submitted = await this.submitBatchPageWithRebind(
                        page,
                        requestKey,
                        deadlineAt,
                        signal,
                    );
                    servedPollDelayMs = submitted.retryAfterMs;
                    row = recordSynapseLedgerJob(db, {
                        rowId: row.rowId,
                        expectedStateVersion: row.stateVersion,
                        attemptId: randomUUID(),
                        jobId: submitted.jobId,
                    });
                }
                const jobId = row.jobId as string;
                try {
                    const vectors = await this.collectJobPages(
                        jobId,
                        requestKey,
                        page,
                        deadlineAt,
                        signal,
                        (cursor) => {
                            row = recordSynapseLedgerCursor(db, {
                                rowId: row.rowId,
                                expectedStateVersion: row.stateVersion,
                                jobId,
                                cursor,
                            });
                        },
                        servedPollDelayMs,
                    );
                    try {
                        row = markSynapseLedgerReady(db, {
                            rowId: row.rowId,
                            expectedStateVersion: row.stateVersion,
                            jobId,
                        });
                    } catch (casError) {
                        if (!(casError instanceof SynapseLedgerConflictError)) throw casError;
                        // The winner's row and collected vectors describe one validated result.
                        // The recovery path returns collected vectors with the winner's `stateVersion` only when the winner's `jobId` matches `jobId` and its state is `ready` or `complete`.
                        const winner = findSynapseLedgerPage(db, identity);
                        if (
                            !winner ||
                            winner.jobId !== jobId ||
                            (winner.state !== "ready" && winner.state !== "complete")
                        ) {
                            throw casError;
                        }
                        return {
                            rowId: winner.rowId,
                            stateVersion: winner.stateVersion,
                            applicationGroup,
                            items: manifest,
                            vectors,
                        };
                    }
                    return {
                        rowId: row.rowId,
                        stateVersion: row.stateVersion,
                        applicationGroup,
                        items: manifest,
                        vectors,
                    };
                } catch (error) {
                    const classified = classifyError(error);
                    if (classified.code !== "module_restarted") throw classified;
                    try {
                        row = recordSynapseLedgerRestart(db, {
                            rowId: row.rowId,
                            expectedStateVersion: row.stateVersion,
                            jobId,
                        });
                        await this.rebindAfterModuleRestart(deadlineAt, signal);
                    } catch (casError) {
                        if (!(casError instanceof SynapseLedgerConflictError)) throw casError;
                        // The single durable restart is already spent or the deadline passed, so this page cannot resubmit.
                        // `page_terminal` is permanent because retryable dispositions do not spend restartCount.
                        // `retrySynapseLedgerPage` preserves restartCount for retryable rows with a live deadline.
                        // `retrySynapseLedgerPage` returns retryable rows to pending while their deadline remains live.
                        // The spent budget belongs to this row, so exhaustion must not block siblings.
                        // The restart records this page's history, not lane-wide model artifacts.
                        throw new SynapseEmbeddingError(
                            "page_terminal",
                            "restart budget or page deadline exhausted",
                        );
                    }
                }
            }
        } catch (error) {
            const classified = classifyError(error);
            try {
                row = markSynapseLedgerOutcome(db, {
                    rowId: row.rowId,
                    expectedStateVersion: row.stateVersion,
                    disposition: classified.permanent ? "permanent" : "retryable",
                });
            } catch (casError) {
                if (!(casError instanceof SynapseLedgerConflictError)) throw casError;
            }
            classified.ledgerRowId = row.rowId;
            throw classified;
        }
    }

    private async submitBatchPage(
        page: readonly { id: string; text: string; contentSha256: string }[],
        requestKey: string,
        deadlineAt: number,
        signal?: AbortSignal,
    ): Promise<{ jobId: string; retryAfterMs?: number }> {
        const remainingMs = deadlineAt - this.now();
        if (remainingMs <= 0) {
            throw new SynapseEmbeddingError("timeout", "Synapse page deadline exhausted");
        }
        const body = await this.callWithRetry(
            "embed.batch",
            this.batchRequest(page, requestKey),
            remainingMs,
            true,
            signal,
        );
        const parsed = responseBody(body);
        const jobId =
            typeof parsed.job_id === "string" && parsed.job_id.length > 0 ? parsed.job_id : null;
        if (!jobId) {
            throw new SynapseEmbeddingError(
                "schema_violation",
                "embed.batch returned no job descriptor",
            );
        }
        return { jobId, retryAfterMs: readRetryAfter(parsed) };
    }

    /**
     * disposition handling.
     *
     */
    private async submitBatchPageWithRebind(
        page: readonly { id: string; text: string; contentSha256: string }[],
        requestKey: string,
        deadlineAt: number,
        signal?: AbortSignal,
    ): Promise<{ jobId: string; retryAfterMs?: number }> {
        try {
            return await this.submitBatchPage(page, requestKey, deadlineAt, signal);
        } catch (error) {
            const classified = classifyError(error);
            const rotated =
                classified.code === "module_restarted" || classified.prePublicationFence === true;
            if (!rotated) throw classified;
            await this.rebindAfterModuleRestart(deadlineAt, signal);
            return this.submitBatchPage(page, requestKey, deadlineAt, signal);
        }
    }

    private async collectJobPages(
        jobId: string,
        requestKey: string,
        page: readonly { id: string; contentSha256: string }[],
        deadlineAt: number,
        signal?: AbortSignal,
        onCursor?: (cursor: string) => void,
        servedPollDelayMs?: number,
    ): Promise<Map<string, Float32Array>> {
        const metadata = this.metadata;
        if (!metadata) {
            throw new SynapseEmbeddingError("transport", "Synapse metadata is unavailable");
        }
        const expected = new Map(page.map((item) => [item.id, item.contentSha256]));
        const collected = new Map<string, Float32Array>();
        let cursor: string | null = null;
        // The wait ends after `ms` or when `signal` aborts.
        const pollDelay = this.newPollDelayState(servedPollDelayMs);
        for (;;) {
            if (signal?.aborted) {
                throw new SynapseEmbeddingError("cancelled", "Synapse request aborted");
            }
            const remainingMs = deadlineAt - this.now();
            if (remainingMs <= 0) {
                throw new SynapseEmbeddingError("timeout", "Synapse page deadline exhausted");
            }
            const body = await this.callWithRetry(
                "embed.result",
                this.requestConstraints({ job_id: jobId, request_key: requestKey, cursor }),
                remainingMs,
                true,
                signal,
            );
            const parsed = responseBody(body);
            const hasVectors = Array.isArray(parsed.vectors);
            const pendingDelay = pendingPollDelay(
                parsed,
                hasVectors,
                deadlineAt,
                pollDelay,
                this.now(),
            );
            if (pendingDelay !== null) {
                await this.delay(pendingDelay, signal);
                continue;
            }
            if (!hasVectors) {
                throw new SynapseEmbeddingError(
                    "schema_violation",
                    "Synapse result page carries done:true without vectors",
                );
            }
            if (typeof parsed.model === "string" && parsed.model !== metadata.model) {
                throw new SynapseEmbeddingError(
                    "substitution_rejected",
                    `Synapse served model ${parsed.model}, expected ${metadata.model}`,
                );
            }
            for (const item of extractBatchItems(body)) {
                const id = typeof item.id === "string" ? item.id : "";
                if (!id || !expected.has(id)) {
                    throw new SynapseEmbeddingError(
                        "schema_violation",
                        `Synapse returned unknown item ${id || "<missing id>"}`,
                    );
                }
                if (collected.has(id)) {
                    throw new SynapseEmbeddingError(
                        "schema_violation",
                        `Synapse returned duplicate item ${id}`,
                    );
                }
                const hash = item.content_sha256;
                if (typeof hash !== "string" || hash !== expected.get(id)) {
                    throw new SynapseEmbeddingError(
                        "artifact_invalid",
                        `Synapse content hash mismatch for item ${id}`,
                    );
                }
                const raw = item.vector ?? item.embedding;
                if (
                    !Array.isArray(raw) ||
                    raw.length === 0 ||
                    raw.some((value) => typeof value !== "number" || !Number.isFinite(value))
                ) {
                    throw new SynapseEmbeddingError(
                        "schema_violation",
                        `Synapse vector for item ${id} is malformed or non-finite`,
                    );
                }
                const vector = Float32Array.from(raw as number[]);
                this.validateResponse({ ...parsed, ...item }, vector.length);
                collected.set(id, vector);
            }
            if (parsed.done === true) break;
            const nextCursor = parsed.next_cursor;
            if (typeof nextCursor !== "string") {
                throw new SynapseEmbeddingError(
                    "schema_violation",
                    "Synapse non-final result page has no next_cursor",
                );
            }
            cursor = nextCursor;
            onCursor?.(nextCursor);
        }
        if (collected.size !== page.length) {
            throw new SynapseEmbeddingError(
                "schema_violation",
                `Synapse returned ${collected.size} of ${page.length} requested items`,
            );
        }
        return collected;
    }

    async dispose(): Promise<void> {
        this.initialized = false;
        this.client = null;
    }

    isLoaded(): boolean {
        return this.initialized;
    }

    private requestConstraints(extra: Record<string, unknown>): Record<string, unknown> {
        const metadata = this.metadata;
        if (!metadata) return extra;
        return {
            ...extra,
            model: metadata.model,
            required_fingerprint: metadata.fingerprint,
            required_epoch: metadata.table_epoch,
            allow_equivalent: false,
            accept_declared: false,
        };
    }

    private batchRequest(
        items: readonly { id: string; text: string; contentSha256: string }[],
        requestKey: string,
    ): Record<string, unknown> {
        return this.requestConstraints({
            items: items.map((item) => ({
                id: item.id,
                text: item.text,
                content_sha256: item.contentSha256,
            })),
            request_key: requestKey,
        });
    }

    /**
     *
     * An abortable delay prevents an aborted request from waiting for the remaining delay.
     *
     * The finally block removes the abort listener on every exit path, preventing retained listeners on long-lived signals.
     */
    private async delay(ms: number, signal?: AbortSignal): Promise<void> {
        if (!signal) {
            await this.sleep(ms);
            return;
        }
        let onAbort: (() => void) | undefined;
        try {
            await Promise.race([
                // The abort promise precedes `sleep` so its listener is installed before the delay starts.
                // The second `signal.aborted` check closes the race between an earlier check and listener registration.
                new Promise<never>((_resolve, reject) => {
                    const fail = () =>
                        reject(new SynapseEmbeddingError("cancelled", "Synapse request aborted"));
                    if (signal.aborted) {
                        fail();
                        return;
                    }
                    onAbort = fail;
                    signal.addEventListener("abort", fail, { once: true });
                }),
                this.sleep(ms),
            ]);
        } finally {
            if (onAbort) signal.removeEventListener("abort", onAbort);
        }
    }

    private positiveOption(value: number | undefined, fallback: number): number {
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    }

    private newPollDelayState(servedPollDelayMs?: number): PollDelayState {
        const random = Math.min(Math.max(this.random(), 0), 1 - Number.EPSILON);
        const defaultDelayMs = Math.max(
            SYNAPSE_POLL_MIN_DELAY_MS,
            servedPollDelayMs ?? this.pollDefaultDelayMs,
        );
        return {
            nextDelayMs: Math.min(this.pollInitialDelayMs * (1 + random), defaultDelayMs),
            defaultDelayMs,
        };
    }

    private requestKey(
        items: readonly { id: string; text: string; contentSha256: string }[],
    ): string {
        if (!this.metadata)
            throw new SynapseEmbeddingError("transport", "Synapse metadata is unavailable");
        return getSynapseBatchRequestKey({
            model: this.metadata.model,
            fingerprint: this.metadata.fingerprint,
            tableEpoch: this.metadata.table_epoch,
            items,
        });
    }

    /** `pollBatch` accepts the legacy `complete` and `cursor` host aliases for `embedItems` and `embedBatch`.
     * A reply containing items and no cursor terminates `pollBatch`.
     * A reply with no items is pending, even when its cursor is absent.
     * For an itemless reply, `pollBatch` uses `pendingPollDelay` instead of treating an absent cursor as completion.
     * `collectJobPages` applies the pending-reply rule to every detailed and ledger reply.
     * */
    private async pollBatch(
        jobId: string,
        requestKey: string,
        servedPollDelayMs: number | undefined,
        deadlineAt: number,
        signal?: AbortSignal,
    ): Promise<unknown> {
        let cursor: unknown = null;
        const allItems: Array<Record<string, unknown>> = [];
        // `pollBatch` retains the caller's deadline so submission and polling share one page-timeout budget.
        // Re-anchoring the deadline in `pollBatch` would grant polling a second full page-timeout budget.
        // Re-anchoring would allow one page to consume up to twice `pageTimeoutMs`.
        // The first `embed.result` is sent immediately; the first pending reply consumes the fast-first seed.
        const pollDelay = this.newPollDelayState(servedPollDelayMs);
        for (;;) {
            if (signal?.aborted)
                throw new SynapseEmbeddingError("cancelled", "Synapse request aborted");
            const remainingMs = deadlineAt - this.now();
            if (remainingMs <= 0) {
                throw new SynapseEmbeddingError("timeout", "Synapse job poll deadline exhausted");
            }
            const body = await this.callWithRetry(
                "embed.result",
                this.requestConstraints({
                    job_id: jobId,
                    cursor,
                    request_key: requestKey,
                }),
                remainingMs,
                true,
                signal,
            );
            const parsed = responseBody(body);
            const items = extractBatchItems(body);
            const nextCursor = parsed.next_cursor ?? parsed.cursor;
            if (
                parsed.complete !== true &&
                items.length === 0 &&
                (nextCursor === undefined || nextCursor === null)
            ) {
                const pendingDelay = pendingPollDelay(
                    parsed,
                    false,
                    deadlineAt,
                    pollDelay,
                    this.now(),
                );
                if (pendingDelay !== null) {
                    await this.delay(pendingDelay, signal);
                    continue;
                }
            }
            allItems.push(...items);
            const done =
                parsed.done === true ||
                parsed.complete === true ||
                nextCursor === undefined ||
                nextCursor === null;
            if (done) {
                return { ...parsed, result: undefined, vectors: allItems, items: allItems };
            }
            cursor = nextCursor;
        }
    }

    private async callWithRetry<T>(
        method: string,
        params: SynapseCallParams,
        timeoutMs: number,
        retryEmbeddings: boolean,
        signal?: AbortSignal,
    ): Promise<T> {
        // One absolute application deadline spans the retry sequence; each retry is a new managed call bounded by the remaining budget.
        const deadlineAtMs = this.now() + timeoutMs;
        let attempt = 0;
        for (;;) {
            if (signal?.aborted)
                throw new SynapseEmbeddingError("cancelled", "Synapse request aborted");
            const remainingMs = deadlineAtMs - this.now();
            if (remainingMs < 1)
                throw new SynapseEmbeddingError(
                    "timeout",
                    `Synapse ${method} deadline of ${timeoutMs}ms exhausted`,
                );
            const attemptDeadlineMs = Math.floor(remainingMs);
            // Reading the identity before the call ensures failures report the binding used by that call.
            // A concurrent re-certification must not change the identity reported for an earlier call.
            const attemptDaemonId = this.compatibleDaemonId;
            try {
                if (!this.client)
                    throw new SynapseEmbeddingError("transport", "Synapse client is unavailable");
                // Managed `demandStart` lanes require `compatibleDaemonId` to fence publication.
                // When a `demandStart` lane configures an identity, a missing `compatibleDaemonId` leaves publication unfenced.
                // owned.
                if (
                    this.connectionOrigin === "managed-default" &&
                    this.demandStart &&
                    this.compatibleDaemonId === null
                )
                    throw new SynapseEmbeddingError(
                        "module_restarted",
                        "managed Synapse lane has no certified daemon identity",
                    );
                const attemptParams =
                    typeof params === "function" ? params(attemptDeadlineMs) : params;
                return await this.client.call<T>(
                    this.options.moduleId ?? "synapse",
                    method,
                    attemptParams,
                    {
                        timeoutMs: attemptDeadlineMs,
                        targetKind: "management_surface",
                        identity: {
                            project_root: this.options.projectRoot,
                            harness: getHarness(),
                            session: this.options.session,
                        },
                        ...(this.compatibleDaemonId === null
                            ? {}
                            : { expectedDaemonId: this.compatibleDaemonId }),
                    },
                );
            } catch (error) {
                const classified = classifyError(error);
                // `DAEMON_GENERATION_CHANGED_CODE` invalidates `compatibleDaemonId` before publication.
                if (readErrorCode(error) === DAEMON_GENERATION_CHANGED_CODE) {
                    this.initialized = false;
                    this.compatibleDaemonId = null;
                    classified.prePublicationFence = true;
                    throw classified;
                }
                if (classified.code === "idempotency_conflict") throw classified;
                if (classified.code === "module_restarted") {
                    classified.attemptDaemonId = attemptDaemonId;
                    throw classified;
                }
                if (classified.code === "cancelled") throw classified;
                const outcomeUnknown = isMcHostCallError(error) && error.kind === "outcome_unknown";
                const retryable = !classified.permanent && (retryEmbeddings || !outcomeUnknown);
                const attemptCap =
                    classified.code === "queue_full" ? SYNAPSE_QUEUE_FULL_MAX_ATTEMPTS - 1 : 3;
                if (!retryable || attempt >= attemptCap) throw classified;
                const base = Math.max(
                    1,
                    classified.retryAfterMs ?? Math.min(2_000, 100 * 2 ** Math.min(attempt, 4)),
                );
                const random = Math.min(Math.max(this.random(), 0), 1 - Number.EPSILON);
                const delay = base + random * 2 * base;
                if (this.now() + delay >= deadlineAtMs) throw classified;
                attempt += 1;
                await this.delay(delay, signal);
            }
        }
    }

    private validateResponse(body: Record<string, unknown>, dims: number): void {
        const metadata = this.metadata;
        if (!metadata) {
            throw new SynapseEmbeddingError("artifact_invalid", "Synapse lane metadata missing");
        }
        if (metadata.dims === undefined) {
            const envelopeDims = body.dims;
            if (typeof envelopeDims === "number" && envelopeDims !== dims) {
                throw new SynapseEmbeddingError(
                    "artifact_invalid",
                    `Synapse envelope declares ${envelopeDims} dimensions but the vector has ${dims}`,
                );
            }
            metadata.dims = dims;
        }
        if (dims !== metadata.dims) {
            throw new SynapseEmbeddingError(
                "artifact_invalid",
                `Synapse returned ${dims} dimensions, expected ${metadata.dims}`,
            );
        }
        const fingerprint = body.fingerprint ?? body.served_fingerprint;
        if (typeof fingerprint !== "string") {
            throw new SynapseEmbeddingError(
                "artifact_invalid",
                "Synapse response omitted the served fingerprint",
            );
        }
        if (fingerprint !== metadata.fingerprint) {
            throw new SynapseEmbeddingError(
                "substitution_rejected",
                `Synapse fingerprint changed from ${metadata.fingerprint} to ${fingerprint}`,
            );
        }
        const epoch = body.table_epoch ?? body.tableEpoch;
        if (typeof epoch !== "number") {
            throw new SynapseEmbeddingError(
                "artifact_invalid",
                "Synapse response omitted the served table epoch",
            );
        }
        if (epoch !== metadata.table_epoch) {
            throw new SynapseEmbeddingError(
                "substitution_rejected",
                `Synapse table epoch changed from ${metadata.table_epoch} to ${epoch}`,
            );
        }
    }

    private logCallFailure(error: unknown, operation: string): void {
        const classified = classifyError(error);
        if (
            classified.code === "module_restarted" &&
            (classified.attemptDaemonId === undefined ||
                classified.attemptDaemonId === this.compatibleDaemonId)
        ) {
            this.initialized = false;
            this.compatibleDaemonId = null;
        }
        if (classified.permanent && !isPageScopedSynapseCode(classified.code)) {
            this.permanentFailure = true;
        }
        const suffix =
            classified.retryAfterMs === undefined
                ? ""
                : ` retry_after_ms=${classified.retryAfterMs}`;
        log(
            `[magic-context] Synapse ${operation} failed: ${classified.code}${suffix}: ${classified.message}`,
        );
    }
}

export function _resetSynapseClientForTests(): void {
    resetProcessMcHostClientsForTest();
    sharedClient = null;
    sharedClientFile = null;
    sharedClientPromise = null;
}

export function _synapseSharedClientStateForTests(): {
    hasClient: boolean;
    hasPromise: boolean;
    file: string | null;
} {
    return {
        hasClient: sharedClient !== null,
        hasPromise: sharedClientPromise !== null,
        file: sharedClientFile,
    };
}
