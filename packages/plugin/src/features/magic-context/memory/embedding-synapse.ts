import { createHash, randomUUID } from "node:crypto";
import { getDataDir } from "../../../shared/data-path";
import { getHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import { isMcHostCallError, McHostClient } from "../../../shared/mc-host-client";
import {
    type ConnectionOrigin,
    defaultConnectionFilePath,
    OUTER_AGGREGATE_MS,
    resolveConnectionOrigin,
    STORAGE_HARD_BUDGET_MS,
    type StorageReadiness,
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
 * Attempt safety cap for `queue_full` retries. Admission rejection is a
 * deadline-bounded wait for a slot, not evidence the request is doomed, so
 * the binding budget is the caller's deadline (`now + delay >= deadlineAtMs`
 * stops the sequence). At the host-served 50 ms hint the deadline is always
 * reached first; the cap only bounds amplification when a host serves a
 * pathologically small hint.
 */
const SYNAPSE_QUEUE_FULL_MAX_ATTEMPTS = 64;
/**
 * Connect budget for the shared provider client. The client-wide default is
 * sized for the hook transport, which reconnects on a per-pass deadline; this
 * lane instead memoizes one long-lived client, and the budget must cover the
 * connection-file read plus dial and auth. Failing it leaves the provider
 * uninitialized, which silently degrades embeddings to no-ops rather than
 * surfacing an error, so the wait is deliberately generous.
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
    // The live catalog omits dims; it is adopted from the first embed response
    // envelope and pinned for the provider's lifetime.
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
    call<Response = unknown>(
        moduleId: string,
        method: string,
        params?: unknown,
        options?: {
            timeoutMs?: number;
            identity?: { project_root: string; harness: string; session: string };
            targetKind?: "management_surface" | "tool_provider";
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
}) => Promise<{ ok: boolean; reason: string; storage: StorageReadiness | null }>;

let configuredManagedDemandStart: SynapseDemandStart | undefined;

export function configureSynapseManagedDemandStart(
    demandStart: SynapseDemandStart | undefined,
): void {
    configuredManagedDemandStart = demandStart;
}

/**
 * A managed cold start may take the full native start budget plus the storage
 * probe. A per-query timeout here would detach every waiter mid-startup and
 * demote the lane to its fallback while the shared startup still succeeds.
 */
const SYNAPSE_DEMAND_STARTUP_BUDGET_MS = OUTER_AGGREGATE_MS + STORAGE_HARD_BUDGET_MS;
/** A failed demand is not retried per embed call; each retry spawns a native lifecycle process. */
const SYNAPSE_DEMAND_RETRY_BACKOFF_MS = 5_000;

function defaultConnectionFile(): string {
    // The managed lifecycle owner publishes the daemon under the lifecycle
    // data root; dialing must agree byte-for-byte with that resolver or a
    // demand can report ready while this client dials a different path. The
    // application-storage resolver only backstops environments where no
    // lifecycle root resolves at all.
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
    /** Ledger receipt this failure was recorded against, when one exists. */
    ledgerRowId?: number;

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
 * Permanent codes divide by what they are evidence about, and only lane-wide
 * evidence may condemn the lane.
 *
 * Page-scoped: `idempotency_conflict` and `page_terminal` describe one ledger
 * row's disposition, and `schema_violation` describes one request — its own
 * items' content, or the shape of the reply to that request. A text over the
 * host's per-input cap is a property of that row, so every other page of the
 * lane remains embeddable.
 *
 * Lane-wide: `artifact_invalid`, `substitution_rejected`, `not_certified`, and
 * `probe_required` describe the model the lane serves. They hold for every page
 * the lane would submit, so they disable it until the lane is rediscovered.
 */
function isPageScopedSynapseCode(code: string): boolean {
    return (
        code === "idempotency_conflict" || code === "page_terminal" || code === "schema_violation"
    );
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
    else if (normalized.includes("abort")) mapped = "cancelled";
    // The host's shutdown teardown rejects in-flight work with the wire code
    // `cancelled` ("the host is shutting down"). That is evidence about one
    // host incarnation, not about this caller or the lane, so it stays in
    // the retryable transport class: a retry within the caller's deadline
    // can land on the restarted incarnation. Only a local abort (code or
    // name carrying "abort") maps to the never-retried `cancelled` class.
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
 * Request parameters for one managed Synapse call: either the literal params
 * object, or a builder invoked per attempt with that attempt's remaining
 * deadline so retried requests carry a fresh `deadline_ms`.
 */
type SynapseCallParams =
    | Record<string, unknown>
    | ((deadlineMs: number) => Record<string, unknown>);

interface PollDelayState {
    nextDelayMs: number;
    defaultDelayMs: number;
}

/**
 * The canonical R13 pending rule for one `embed.result` reply: a reply that
 * neither reports `done:true` nor carries a cursored vector page is queue
 * state, never termination, so the only correct response is to wait and poll
 * again. Returns the bounded wait, or null when the reply is a page the caller
 * must consume. Escalating intervals have a positive floor, and the served
 * `retry_after_ms` remains their cap.
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
    // Consume-then-escalate: the first pending reply waits the jittered
    // fast-first seed (the first poll itself was issued immediately, so a
    // job that finishes faster than the seed never pays it), and every
    // later pending waits the escalated value with a positive floor.
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
    // The live catalog serves {model_id, fingerprints[], state} per entry with
    // table_epoch on the envelope; dims and recommended_batch arrive only on
    // embed responses. Accept both that shape and the field-per-entry form so a
    // future catalog enrichment does not need a parser change.
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
        // recommended_batch arrives either as a bare row count (early servers) or as
        // the measured policy object {rows, token_budget}. Accept both; a lane
        // without a measured policy omits the field and keeps client defaults.
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
    // The live envelope carries vectors: [{id, vector, content_sha256}] for
    // every embed op, including single-text queries; older sketches used a
    // top-level vector/embedding field, kept as a fallback.
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

let sharedClient: SynapseClientLike | null = null;
let sharedClientFile: string | null = null;
let sharedClientPromise: Promise<SynapseClientLike> | null = null;

const factoryClients = new WeakMap<() => Promise<SynapseClientLike>, Promise<SynapseClientLike>>();

async function getSharedClient(
    options: SynapseEmbeddingProviderOptions,
): Promise<SynapseClientLike> {
    const factory = options.clientFactory;
    if (factory) {
        // Factory clients (tests, embedded fixtures) memoize per factory, never
        // in the module-global slot: a cached fixture client would otherwise
        // leak across providers and poison every later real connection in the
        // same process.
        let promise = factoryClients.get(factory);
        if (!promise) {
            promise = factory();
            factoryClients.set(factory, promise);
            promise.catch(() => {
                // Evict only our own rejected promise so a later call can
                // build a fresh client instead of reusing the poisoned one.
                if (factoryClients.get(factory) === promise) factoryClients.delete(factory);
            });
        }
        return promise;
    }
    const file = options.connectionFile ?? defaultConnectionFile();
    if (sharedClient && sharedClientFile === file) return sharedClient;
    if (sharedClientPromise && sharedClientFile === file) return sharedClientPromise;
    const promise = McHostClient.connect({
        connectionFile: file,
        handshakeTimeoutMs: SYNAPSE_HANDSHAKE_TIMEOUT_MS,
    }).then((client) => {
        if (sharedClientPromise === promise && sharedClientFile === file) {
            sharedClient = client;
        } else {
            // A connect for a different connection file superseded this one
            // while it was in flight; close the orphan instead of leaking it
            // or publishing it under the newer file's cache slot.
            client.close();
        }
        return client;
    });
    promise.catch(() => {
        // Evict only our own rejected promise so a later call can
        // reconnect instead of reusing the poisoned one.
        if (sharedClientPromise === promise) {
            sharedClientPromise = null;
            sharedClientFile = null;
        }
    });
    sharedClientFile = file;
    sharedClientPromise = promise;
    return promise;
}

export class SynapseEmbeddingProvider implements EmbeddingProvider {
    modelId: string;
    maxInputTokens: number;
    maxInputBytes: number;
    metadata: SynapseLaneMetadata | null;

    /// Deadline basis for every ledger page this provider opens. Resolved once
    /// so the provider's own page deadlines and any external reopen of the same
    /// row share one basis instead of each falling back independently.
    readonly pageTimeoutMs: number;

    private readonly options: SynapseEmbeddingProviderOptions;
    private readonly connectionOrigin: ConnectionOrigin;
    private readonly demandStart: SynapseDemandStart | undefined;
    private client: SynapseClientLike | null = null;
    private initialized = false;
    private initializing: Promise<boolean> | null = null;
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
     * Page split honors both halves of the service's measured policy: at most
     * batchLimit rows AND (when the lane publishes one) at most the token budget
     * per call, estimated at 4 chars/token. Splitting on whichever limit hits
     * first keeps a page's GPU/ANE occupancy inside the measured knee, so one
     * oversized page cannot recreate the uninterruptible-latency regression the
     * budget exists to bound. A single item over budget still ships alone: the
     * service truncates per its own contract, the client never drops work.
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
     * Demand the shared managed daemon inside the initialization flight, so
     * concurrent initializers share one demand and one native invocation. A
     * missing lifecycle owner keeps this path passive (dial-only): explicit
     * and CLI contexts must be able to reach an already-running daemon.
     */
    private async demandManagedLane(): Promise<void> {
        if (this.connectionOrigin !== "managed-default" || !this.demandStart) return;
        if (Date.now() < this.demandFailedUntilMs) {
            throw new SynapseEmbeddingError(
                "transport",
                "managed Synapse demand recently failed; backing off",
            );
        }
        const outcome = await this.demandStart({
            origin: this.connectionOrigin,
            capability: "synapse",
            deadlineMs: SYNAPSE_DEMAND_STARTUP_BUDGET_MS,
        });
        if (!outcome.ok) {
            this.demandFailedUntilMs = Date.now() + SYNAPSE_DEMAND_RETRY_BACKOFF_MS;
            throw new SynapseEmbeddingError(
                "transport",
                `managed Synapse demand failed: ${outcome.reason}`,
            );
        }
    }

    async initialize(signal?: AbortSignal): Promise<boolean> {
        if (this.initialized) return true;
        if (this.permanentFailure) return false;
        if (this.initializing) {
            const shared = this.initializing;
            if (!signal) return shared;
            try {
                return await raceSignal(shared, signal);
            } catch {
                // Detach only. The shared initialization remains owned by the
                // provider and can complete for another waiter.
                return false;
            }
        }
        this.initializing = (async () => {
            try {
                await this.demandManagedLane();
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
                    // Rediscovery matches by model name only, so a daemon that
                    // rotated the artifact between routing and this call answers
                    // with a different lane. A registration that pinned an
                    // identity already keyed its destination rows to it, and
                    // those keys do not follow this metadata, so adopting the
                    // rotated lane would store its vectors under the pinned
                    // lane's key. Refuse; routing rediscovers and rebuilds the
                    // registration under the new identity.
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
            // Detach only. The shared initialization remains owned by the
            // provider and can complete for another waiter.
            return false;
        }
    }

    async embed(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
        if (!(await this.initialize(signal)) || signal?.aborted || !this.metadata) return null;
        try {
            // retryEmbeddings=true permits a retry after an ambiguous send
            // even though embed.query carries no request_key: the operation
            // is a pure computation over its input with no daemon-side state,
            // so a duplicate dispatch wastes compute but corrupts nothing.
            // embed.batch/embed.result carry request_key because they create
            // ledger state the daemon must dedupe.
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
            const page = this.nextPage(items, start);
            start += page.length;
            try {
                const requestKey = this.requestKey(page);
                let body: unknown = {};
                let restarted = false;
                // One absolute deadline for the whole page: submission and the
                // poll sequence that follows it draw on the same budget, and a
                // resubmission after `module_restarted` inherits what is left
                // rather than restarting the clock.
                const deadlineAt = this.now() + this.pageTimeoutMs;
                for (;;) {
                    try {
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
                // A page-scoped code answers for this page only, so the
                // remaining pages keep their turn on a live lane.
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
        const ready = await this.initialize();
        if (!ready || !this.metadata) {
            for (const [applicationGroup, groupItems] of groups) {
                result.failures.push({
                    applicationGroup,
                    items: groupItems.map(({ id, contentSha256 }) => ({ id, contentSha256 })),
                    rowId: null,
                    code: this.permanentFailure ? "artifact_invalid" : "transport",
                    message: "Synapse lane is unavailable",
                    disposition: this.permanentFailure ? "permanent" : "retryable",
                });
            }
            return result;
        }
        for (const [applicationGroup, groupItems] of groups) {
            // Pages are cut inside one group only, so a provider page can
            // never span two application transaction groups (R18).
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
                try {
                    result.receipts.push(
                        await this.runDetailedPage(page, applicationGroup, context, signal),
                    );
                } catch (error) {
                    const classified = classifyError(error);
                    // `logCallFailure` owns the lane verdict: it condemns the
                    // lane only for lane-wide evidence, so a page-scoped code
                    // reported here leaves the remaining groups embeddable.
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
                // A sibling process took this page identity between the read
                // and the create, and the partial unique index rejected the
                // loser. The winner's row IS this page, so attach to it instead
                // of failing a request whose job is already running.
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
                // A permanent disposition is this page identity's answer:
                // obsoleting the row and rebuilding it would resubmit the same
                // rejected request on every pass. A changed request identity
                // (content hashes, table epoch, or fingerprint) hashes to a
                // different request key and gets its own row.
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
            // A ready row without applied destinations means the vectors were
            // lost with the process; re-derive them from the retained job (R20).
            // An already-expired page deadline makes the re-derive impossible
            // (collectJobPages times out before its first poll, and the
            // recovery signal `module_restarted` would never be observed), so
            // such a row is obsoleted and rebuilt like a restarted module.
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
                        // The failure is evidence about the retained job's
                        // reply. This page has not been submitted since its
                        // vectors were lost, so it carries no disposition of its
                        // own: recording one would answer for work never
                        // attempted, and a permanent answer would foreclose the
                        // content forever. Retiring the ready row leaves no live
                        // row for this identity, so the next pass opens a fresh
                        // pending page and submits it.
                        markSynapseLedgerObsolete(db, {
                            rowId: row.rowId,
                            expectedStateVersion: row.stateVersion,
                        });
                        classified.ledgerRowId = row.rowId;
                        throw classified;
                    }
                    // A restart forces this page back through submission, which
                    // is the same resubmission the polling path buys with the
                    // page's single durable restart, so the ready path spends
                    // that budget under the same evidence: an unspent restart
                    // inside the original deadline. The rebuilt row seeds
                    // `restart_count` at 0, so an unchecked rebuild here hands
                    // the page a fresh budget on every pass and a restarting
                    // daemon resubmits it without bound. `page_terminal` is the
                    // page-scoped code for a spent budget: it belongs to this
                    // row alone and leaves the lane's other pages runnable.
                    if (row.restartCount !== 0 || (row.deadlineAt ?? 0) <= this.now()) {
                        const terminal = new SynapseEmbeddingError(
                            "page_terminal",
                            "restart budget or page deadline exhausted",
                        );
                        terminal.ledgerRowId = row.rowId;
                        throw terminal;
                    }
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
                const submitted = await this.submitBatchPage(page, requestKey, deadlineAt, signal);
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
                    // A crash between the restart CAS and resubmission leaves a
                    // polling row without a job; resubmit the same page key.
                    const submitted = await this.submitBatchPage(
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
                        // A sibling attempt validated this page and advanced the
                        // row first. Its receipt covers the identical work: the
                        // request key pins the item set, hashes, fingerprint, and
                        // epoch, and `jobId` pins the daemon job those vectors
                        // came from, so the winner's row and the vectors in hand
                        // describe one validated result. Attach to the winner's
                        // version rather than discard the collected vectors. A
                        // winner holding a different job is different work whose
                        // items are unproven here, so it is not a success.
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
                    } catch (casError) {
                        if (!(casError instanceof SynapseLedgerConflictError)) throw casError;
                        // The single durable restart is already spent or the
                        // deadline passed: this page cannot resubmit (R21).
                        // `page_terminal` carries both properties this outcome
                        // needs. It is permanent because a retryable
                        // disposition never spends the budget:
                        // `retrySynapseLedgerPage` returns any retryable row to
                        // `pending` while its deadline is still live and leaves
                        // `restart_count` untouched, so the next pass resubmits
                        // the same page forever. It is a ledger-state code
                        // because the spent budget belongs to this row alone:
                        // the daemon restart it counts is evidence about one
                        // page's history, not about the lane's model artifacts,
                        // and a sibling page holding its own unspent budget can
                        // still complete. It is also the code every later pass
                        // reports for this row once the permanent disposition
                        // lands, so one condition reads the same throughout.
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
        // The first `embed.result` goes out immediately: a job that is
        // already ready pays only the wire round trip, and the fast-first
        // seed is consumed by the first pending reply instead.
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
    private async delay(ms: number, signal?: AbortSignal): Promise<void> {
        if (!signal) {
            await this.sleep(ms);
            return;
        }
        let onAbort: (() => void) | undefined;
        try {
            await Promise.race([
                // First in the array so the listener is registered before the
                // sleep starts, and `aborted` is re-tested inside the executor:
                // an abort that lands between an earlier check and the
                // registration would otherwise be missed for the whole delay,
                // which is the exact failure this method exists to prevent.
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

    /** Lenient polling for `embedItems`/`embedBatch` callers only: it tolerates
     *  pre-canonical hosts (`complete`, `cursor` aliases) and treats a missing
     *  cursor on a reply that carried items as termination. A reply carrying no
     *  items at all is the canonical pending shape, so it defers to the shared
     *  R13 rule in `pendingPollDelay` rather than reading the absent cursor as
     *  completion; the detailed/ledger paths apply that rule in
     *  `collectJobPages` for every reply. */
    private async pollBatch(
        jobId: string,
        requestKey: string,
        servedPollDelayMs: number | undefined,
        deadlineAt: number,
        signal?: AbortSignal,
    ): Promise<unknown> {
        let cursor: unknown = null;
        const allItems: Array<Record<string, unknown>> = [];
        // The caller's absolute page deadline spans submission and polling, as
        // `collectJobPages` already receives one. Re-anchoring it here would
        // grant the poll sequence a second full `pageTimeoutMs` on top of the
        // budget `embed.batch` already spent, so one page could take twice the
        // configured page timeout.
        // The first `embed.result` goes out immediately; the fast-first seed
        // is consumed by the first pending reply (see `pendingPollDelay`).
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
        // One absolute application deadline spans the whole retry sequence:
        // each retry is a new managed call bounded by the remaining budget.
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
            try {
                if (!this.client)
                    throw new SynapseEmbeddingError("transport", "Synapse client is unavailable");
                const attemptParams =
                    typeof params === "function" ? params(attemptDeadlineMs) : params;
                return await this.client.call<T>(
                    this.options.moduleId ?? "synapse",
                    method,
                    attemptParams,
                    {
                        timeoutMs: attemptDeadlineMs,
                        // Synapse registers exactly one provider role, ManagementSurface;
                        // every op (embed.*, models.list, jobs) is dispatched by the JSON
                        // method field over that single route.
                        targetKind: "management_surface",
                        identity: {
                            project_root: this.options.projectRoot,
                            harness: getHarness(),
                            session: this.options.session,
                        },
                    },
                );
            } catch (error) {
                const classified = classifyError(error);
                if (classified.code === "idempotency_conflict") throw classified;
                // R21: module_restarted bypasses generic retry entirely; the
                // caller owns the single durable restart resubmission.
                if (classified.code === "module_restarted") throw classified;
                if (classified.code === "cancelled") throw classified;
                const outcomeUnknown = isMcHostCallError(error) && error.kind === "outcome_unknown";
                const retryable = !classified.permanent && (retryEmbeddings || !outcomeUnknown);
                // `queue_full` is a bounded wait for an admission slot, so
                // its budget is the remaining deadline rather than the fixed
                // four-attempt cap: with the host's default fail-fast
                // admission (max_waiting_queries = 0) a burst drains one
                // service time per slot, and a fixed small cap would abandon
                // the request with most of its deadline unspent.
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
        // The catalog omits dims, so the first embed response pins them; every
        // later response must match the pinned value exactly.
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
    sharedClient?.close();
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
