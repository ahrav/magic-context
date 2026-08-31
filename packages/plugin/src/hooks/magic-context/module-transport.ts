import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type {
    AuthorityDrainResponse,
    AuthorityStatus,
    ChangefeedPage,
} from "../../features/magic-context/context-authority";
import { getDataDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import {
    AdmissionClass,
    armExpiryTimer,
    type BindIdentity,
    BROCA_CREDENTIAL_NAMES,
    BROCA_CREDENTIAL_ROW_CAP_BYTES,
    BROCA_CREDENTIAL_VALUE_CAP_BYTES,
    DAEMON_GENERATION_CHANGED_CODE,
    Deadline,
    evictProcessMcHostClient,
    isConsumerReconnectTransient,
    isMcHostCallError,
    McHostCallError,
    type McHostClient,
    type McHostClientOptions,
    Priority,
    processMcHostClient,
    type RouteHandle,
    type RouteTarget,
    SocketClosedError,
    SocketTimeoutError,
    StaleRouteHandleError,
    sameDaemonId,
} from "../../shared/mc-host-client";
import {
    type ConnectionOrigin,
    createManagedLifecyclePolicy,
    type NativeStartupEnvelope,
    resolveConnectionOrigin,
    type StorageReadiness,
    WaiterDetachedError,
} from "../../shared/mc-host-lifecycle";
import { qualifiedHarnessClosures } from "../../shared/mc-host-lifecycle/generated-production-inputs";
import { defaultConnectionFilePath } from "../../shared/mc-host-lifecycle/paths";
import { isRecord } from "../../shared/record-type-guard";
import {
    buildClaimEffectDeliveryWireBody,
    buildClaimIntentAckWireBody,
    buildClaimIntentInspectWireBody,
    buildClaimIntentStageWireBody,
    buildClaimMirrorReceiptWireBody,
    buildClaimMirrorSnapshotWireBody,
    type ClaimEffectDeliveryRequest,
    type ClaimEffectDeliveryResponse,
    type ClaimIntentAckRequest,
    type ClaimIntentAckResponse,
    type ClaimIntentInspectRequest,
    type ClaimIntentInspectResponse,
    type ClaimIntentStageRequest,
    type ClaimIntentStageResponse,
    type ClaimMirrorReceiptRequest,
    type ClaimMirrorReceiptResponse,
    type ClaimMirrorSnapshotRequest,
    type ClaimMirrorSnapshotResponse,
    decodeClaimEffectDeliveryResponse,
    decodeClaimIntentAckResponse,
    decodeClaimIntentInspectResponse,
    decodeClaimIntentStageResponse,
    decodeClaimMirrorReceiptResponse,
    decodeClaimMirrorSnapshotResponse,
    type ModuleAuthorityMethod,
    type ModuleMethod,
} from "./module-wire";

const DEFAULT_MODULE_ID = "magic-context";
const CONNECT_BACKOFF_INITIAL_MS = 1_000;
const CONNECT_BACKOFF_MAX_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const MODULE_SEND_TIMEOUT_MS = 15_000;
const TRANSFORM_SEND_TIMEOUT_MS = 5_000;
/** Consumers use this deadline for the module's exported `historian::MAX_WRAPUP_REQUEST_BUDGET`. */
export const MAX_WRAPUP_REQUEST_BUDGET_MS = 3_800_000;
const SERIAL_LANE_MAX_WAITERS = 16;
const SERIAL_LANE_MAX_WAITERS_PER_SESSION = 8;
const SERIAL_LANE_MIN_REMAINING_MS = 25;
const CANONICAL_ROOT_CACHE_MAX_ENTRIES = 256;

function getDefaultConnectionFile(): string {
    // Dial the lifecycle resolver's path exactly; otherwise a ready demand can target a different daemon. Use application storage only when no lifecycle root resolves.
    return defaultConnectionFilePath(getDataDir());
}

export interface ManagedDemandResult {
    ok: boolean;
    reason: string;
    storage: StorageReadiness | null;
    authenticatedDaemonId?: Uint8Array;
}

export type ManagedDemandStart = (request: {
    origin: ConnectionOrigin;
    capability: "magic-context" | "synapse";
    signal?: AbortSignal;
    deadlineMs?: number;
    startupEnvelope?: NativeStartupEnvelope;
}) => Promise<ManagedDemandResult>;

export interface McHostModuleTransportOptions {
    connectionFile?: string;
    moduleId?: string;
    requestTimeoutMs?: number;
    routeSessionPrefix?: string;
    demandStart?: ManagedDemandStart;
}

export interface LazyManagedDemandStartOptions {
    declaringModuleUrl: string;
    parentPackageName: string;
}

let configuredManagedDemandStart: ManagedDemandStart | undefined;

function managedCredentialSourceVersion(env: Record<string, string | undefined>): string {
    const hash = createHash("sha256").update("mc-host-route-credentials-v1");
    for (const name of BROCA_CREDENTIAL_NAMES) {
        const value = env[name] ?? "";
        hash.update(`${Buffer.byteLength(name)}:${name}`);
        hash.update(`${Buffer.byteLength(value)}:${value}`);
    }
    return hash.digest("hex");
}

interface GeneratedHarnessClosure {
    readonly manifest_sha256: string;
    readonly source_roots: readonly string[];
    readonly platforms: readonly string[];
    readonly anchors: Record<
        string,
        {
            readonly from: "executable" | "interpreter" | "entrypoint";
            readonly source_path: string;
        }
    >;
}

function closureCandidate(
    closure: GeneratedHarnessClosure,
    executable: string,
    entrypoint: string | undefined,
    resolvePath: (path: string) => string,
): { manifest_sha256: string; source_roots: Record<string, string> } | undefined {
    const platform =
        process.platform === "linux" && process.arch === "x64"
            ? "linux-x64-gnu"
            : process.platform === "darwin" && process.arch === "arm64"
              ? "darwin-arm64"
              : process.platform === "darwin" && process.arch === "x64"
                ? "darwin-x64"
                : undefined;
    if (platform === undefined || !closure.platforms.includes(platform)) {
        return undefined;
    }
    const sourceRoots: Record<string, string> = {};
    for (const root of closure.source_roots) {
        const anchor = closure.anchors[root];
        if (anchor === undefined) return undefined;
        const unresolved = anchor.from === "entrypoint" ? entrypoint : executable;
        if (unresolved === undefined || !unresolved.startsWith("/")) {
            return undefined;
        }
        let actual: string;
        try {
            actual = resolvePath(unresolved);
        } catch {
            return undefined;
        }
        const suffix = `/${anchor.source_path}`;
        if (!actual.endsWith(suffix)) return undefined;
        sourceRoots[root] = actual.slice(0, -suffix.length) || "/";
    }
    return {
        manifest_sha256: closure.manifest_sha256,
        source_roots: sourceRoots,
    };
}

export function buildManagedStartupEnvelope(
    parentPackageName: string,
    env: Record<string, string | undefined> = process.env,
    executable: string = process.execPath,
    entrypoint: string | undefined = process.argv[1],
    resolvePath: (path: string) => string = realpathSync.native,
): NativeStartupEnvelope {
    const credentials: Record<string, string> = {};
    let rowBytes = 0;
    for (const name of BROCA_CREDENTIAL_NAMES) {
        const value = env[name];
        if (value === undefined || value.length === 0) continue;
        const valueBytes = Buffer.byteLength(value);
        if (valueBytes > BROCA_CREDENTIAL_VALUE_CAP_BYTES) {
            const error = new Error("managed credential value exceeds its size cap") as Error & {
                code?: string;
            };
            error.code = "credential_value_too_large";
            throw error;
        }
        rowBytes += Buffer.byteLength(name) + valueBytes;
        if (rowBytes > BROCA_CREDENTIAL_ROW_CAP_BYTES) {
            const error = new Error("managed credential row exceeds its size cap") as Error & {
                code?: string;
            };
            error.code = "credential_row_too_large";
            throw error;
        }
        credentials[name] = value;
    }
    const opencode =
        parentPackageName === "@cortexkit/opencode-magic-context"
            ? closureCandidate(
                  qualifiedHarnessClosures.harnesses.opencode,
                  executable,
                  entrypoint,
                  resolvePath,
              )
            : undefined;
    const pi =
        parentPackageName === "@cortexkit/pi-magic-context"
            ? closureCandidate(
                  qualifiedHarnessClosures.harnesses.pi,
                  executable,
                  entrypoint,
                  resolvePath,
              )
            : undefined;
    return {
        schema: 1,
        ...(opencode === undefined ? {} : { opencode }),
        ...(pi === undefined ? {} : { pi }),
        ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
    };
}

export function createLazyManagedDemandStart(
    options: LazyManagedDemandStartOptions,
): ManagedDemandStart {
    let policy: ReturnType<typeof createManagedLifecyclePolicy> | undefined;
    return async (request): Promise<ManagedDemandResult> => {
        // Start the caller deadline before synchronous policy preparation, which can block abort timers; `demandStart` rejects non-positive residuals before native startup.
        const startedAt = performance.now();
        policy ??= createManagedLifecyclePolicy({
            mode: "mutating",
            declaringModuleUrl: options.declaringModuleUrl,
            parentPackageName: options.parentPackageName,
        });
        const preparationMs = performance.now() - startedAt;
        const deadlineMs =
            request.deadlineMs === undefined ? undefined : request.deadlineMs - preparationMs;
        const outcome = await policy.demandStart({
            ...request,
            ...(deadlineMs === undefined ? {} : { deadlineMs }),
            startupEnvelope:
                request.startupEnvelope ?? buildManagedStartupEnvelope(options.parentPackageName),
        });
        return {
            ok: outcome.result.ok,
            reason: outcome.result.reason,
            storage: outcome.storage,
            ...(outcome.authenticatedDaemonId === undefined
                ? {}
                : { authenticatedDaemonId: outcome.authenticatedDaemonId }),
        };
    };
}

export function configureManagedDemandStart(demandStart: ManagedDemandStart | undefined): void {
    configuredManagedDemandStart = demandStart;
}

function errorChainSome(
    error: unknown,
    predicate: (value: Record<string, unknown>) => boolean,
): boolean {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (predicate(current)) return true;
        current = current.cause;
    }
    return false;
}

/** Recognize route errors by wire-visible shape because plugin bundles can use a different client copy.
 * */
function isStaleOrDeadRouteFailure(error: unknown): boolean {
    return errorChainSome(error, (current) => {
        const code = typeof current.code === "string" ? current.code : "";
        const name = typeof current.name === "string" ? current.name : "";
        const message = typeof current.message === "string" ? current.message : "";
        return (
            [
                "stale_route_handle",
                "route_closed",
                "unknown_channel",
                "unrecognized_channel",
                "route_gone",
            ].includes(code) ||
            name === "StaleRouteHandleError" ||
            /route handle \(\d+,\s*\d+\) is not live on the current connection/i.test(message) ||
            /\b(?:unknown|unrecognized) channel\b/i.test(message)
        );
    });
}

function isConnectionFailure(error: unknown): boolean {
    if (
        error instanceof SocketClosedError ||
        error instanceof SocketTimeoutError ||
        error instanceof StaleRouteHandleError ||
        isConsumerReconnectTransient(error) ||
        isStaleOrDeadRouteFailure(error)
    ) {
        return true;
    }
    return errorChainSome(error, (current) => {
        const code = typeof current.code === "string" ? current.code : "";
        const message = typeof current.message === "string" ? current.message : "";
        return (
            [
                "ENOENT",
                "ECONNREFUSED",
                "ECONNRESET",
                "EPIPE",
                "ETIMEDOUT",
                "request_deadline",
                "deadline_exceeded_no_drop_observed",
                "connection_dropped",
                DAEMON_GENERATION_CHANGED_CODE,
                "MC_HOST_CONNECTION_BACKOFF",
            ].includes(code) ||
            /\bclient closed\b|\bconnection closed\b|\bclosed the connection\b/i.test(message)
        );
    });
}

/**
 * Recognize `McHostCallError.kind` through the cross-bundle check, which requires an `Error` with the wire-visible name; validate `kind` at runtime because foreign bundle fields are untyped.
 */
function mcHostCallErrorKind(error: unknown): McHostCallError["kind"] | undefined {
    if (!isMcHostCallError(error)) return undefined;
    const kind: unknown = error.kind;
    return kind === "not_sent" || kind === "outcome_unknown" || kind === "terminal"
        ? kind
        : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
    if (isRecord(error) && typeof error.code === "string") return error.code;
    return undefined;
}

/** The facade throws `McHostCallError` only before any body write. */
function isStaleRouteHandleFailure(error: unknown): boolean {
    if (error instanceof StaleRouteHandleError) return true;
    return (
        isRecord(error) &&
        (error.name === "StaleRouteHandleError" || error.code === "stale_route_handle")
    );
}

/** Attach a bounded cleanup ticket when caller abort can race a possible send. */
function cleanupTicketOf(error: unknown): Promise<void> | null {
    if (!isRecord(error) || error.name !== "McHostCallError") return null;
    const cleanup = (error as { cleanup?: unknown }).cleanup;
    return cleanup instanceof Promise ? (cleanup as Promise<void>) : null;
}

interface CachedRoute {
    route: RouteHandle;
    generation: number;
    credentialSourceVersion?: string;
}

interface EnsuredRoute {
    client: McHostClient;
    route: RouteHandle;
    routeKey: string;
    generation: number;
    /**
     * Capture the connection's certified identity once so concurrent invalidation cannot remove the fence between route open and body send.
     */
    expectedDaemonId?: Uint8Array;
}

/**
 * `expectedDaemonId` is absent when no lifecycle owner certifies identity, as with an explicit connection file; `null` means no demand has settled for the live connection.
 */
interface ConnectionCertification {
    expectedDaemonId?: Uint8Array;
}

/** `CertifiedConnection` pairs a client with certification validated during dialing. */
interface CertifiedConnection extends ConnectionCertification {
    client: McHostClient;
}

export interface ModuleTransportGenerationChangedResult {
    transport_status: "connection_generation_changed";
    previous_generation: number;
    current_generation: number;
}

export function isModuleTransportGenerationChangedResult(
    value: unknown,
): value is ModuleTransportGenerationChangedResult {
    return (
        isRecord(value) &&
        value.transport_status === "connection_generation_changed" &&
        typeof value.previous_generation === "number" &&
        typeof value.current_generation === "number"
    );
}

interface SerialLaneWaiter {
    signal?: AbortSignal;
    deadline: Deadline;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
    timer: ReturnType<typeof setTimeout>;
    settled: boolean;
}

interface SerialLane {
    active: boolean;
    waiters: SerialLaneWaiter[];
}

interface OpeningRoute {
    client: McHostClient;
    generation: number;
    state: {
        /** `closeSession` sets `closed` during an in-flight open; the open then skips caching its route. */
        closed: boolean;
    };
    promise: Promise<EnsuredRoute>;
}

export class McHostModuleTransport {
    private readonly connectionFile: string;
    private readonly connectionOrigin: ConnectionOrigin;
    private readonly demandStart: ManagedDemandStart | undefined;
    private readonly moduleId: string;
    private readonly requestTimeoutMs: number;
    private readonly routeSessionPrefix: string;
    private client: McHostClient | null = null;
    private clientCacheOptions: McHostClientOptions | null = null;
    private routes = new Map<string, CachedRoute>();
    private routeOpenings = new Map<string, OpeningRoute>();
    private canonicalRootCache = new Map<string, string>();
    // `sessionLanes` preserves request order within each session while independent sessions overlap.
    // Both the aggregate and per-session counts cap queued work; active calls are not waiters.
    private sessionLanes = new Map<string, SerialLane>();
    private queuedLaneWaiters = 0;
    private wrapupSessions = new Map<string, number>();
    private nextProbeMs = 0;
    // A caller that joins the in-flight dial inherits the dial's demand certification.
    // A caller that joins the in-flight dial does not demand certification again.
    private connectionPromise: Promise<CertifiedConnection> | null = null;
    private authorityProjectRoot = "";
    /**
     * `authorityBindRoot` binds authority and mirror routes to the filesystem root.
     * `BindIdentity.project_root` requires a filesystem path, not an MC project identity.
     */
    private authorityBindRoot = "";
    private backoffMs = CONNECT_BACKOFF_INITIAL_MS;
    private connectionGeneration = 0;
    /**
     * `connectionCertification` is `null` until a demand settles for the live connection.
     * An absent `expectedDaemonId` marks a passive connection with no lifecycle owner.
     * A passive connection has no lifecycle owner that can name a daemon.
     * A passive connection remains reusable because no daemon identity exists to re-check.
     */
    private connectionCertification: ConnectionCertification | null = null;
    private stateSyncCapabilityCache: {
        generation: number;
        capabilities: { state_sync_deltas?: boolean };
    } | null = null;

    /** Returns the capability snapshot for the currently live SUBC connection. */
    getCachedStateSyncCapabilities(): { state_sync_deltas?: boolean } | undefined {
        const cached = this.stateSyncCapabilityCache;
        if (!cached || cached.generation !== this.connectionGeneration) return undefined;
        return cached.capabilities;
    }

    /** A module signal that can change wire capabilities clears the cached snapshot. */
    invalidateStateSyncCapabilities(): void {
        this.stateSyncCapabilityCache = null;
    }

    async stateSyncCapabilities(args: {
        sessionId: string;
        projectRoot: string;
    }): Promise<{ state_sync_deltas?: boolean }> {
        const cached = this.getCachedStateSyncCapabilities();
        if (cached) return cached;
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "session.status",
            body: { method: "session.status", v: 1, session_id: args.sessionId },
        });
        const raw = isRecord(response) ? response : {};
        const value = isRecord(raw.result) ? raw.result : raw;
        const epochs = isRecord(value.epochs) ? value.epochs : {};
        const capabilities = { state_sync_deltas: epochs.state_sync_deltas === true };
        this.stateSyncCapabilityCache = { generation: this.connectionGeneration, capabilities };
        return capabilities;
    }

    constructor(
        connectionFileOrOptions?: string | McHostModuleTransportOptions,
        moduleId = DEFAULT_MODULE_ID,
        requestTimeoutMs = MODULE_SEND_TIMEOUT_MS,
        routeSessionPrefix = "",
    ) {
        const options =
            typeof connectionFileOrOptions === "object"
                ? connectionFileOrOptions
                : {
                      connectionFile: connectionFileOrOptions,
                      moduleId,
                      requestTimeoutMs,
                      routeSessionPrefix,
                  };
        this.connectionOrigin = resolveConnectionOrigin({ connectionFile: options.connectionFile });
        this.connectionFile = options.connectionFile ?? getDefaultConnectionFile();
        this.moduleId = options.moduleId ?? DEFAULT_MODULE_ID;
        this.requestTimeoutMs = options.requestTimeoutMs ?? MODULE_SEND_TIMEOUT_MS;
        this.routeSessionPrefix = options.routeSessionPrefix ?? "";
        this.demandStart = options.demandStart ?? configuredManagedDemandStart;
    }

    private deadlineError(detail: string): Error & { code?: string } {
        const error = new Error(`module transport deadline expired ${detail}`) as Error & {
            code?: string;
        };
        error.code = "ETIMEDOUT";
        return error;
    }

    private laneTimeoutError(): Error & { code?: string } {
        return this.deadlineError("while queued");
    }

    private connectionChangedError(detail: string): Error & { code?: string } {
        const error = new Error(detail) as Error & { code?: string };
        error.code = "ECONNRESET";
        return error;
    }

    private async beforeDeadline<T>(
        operation: Promise<T>,
        deadline: Deadline,
        detail: string,
        makeError: () => Error = () => this.deadlineError(detail),
    ): Promise<T> {
        // The race can abandon `operation` when the deadline fires first or the caller's catch invalidates the connection.
        // An abandoned `operation` promise can reject after the race settles.
        // `close()` can reject an abandoned `operation` promise by failing pending requests with `client closed`.
        // An unhandled rejection from an abandoned promise makes Bun print a stack to host stderr.
        // A no-op handler subscribed before the race handles post-race rejections.
        // The race still receives `operation`'s original settlement.
        // The no-op handler receives post-race rejections instead of the process-level unhandled hook.
        operation.catch(() => {});
        if (deadline.remainingMs() <= 0) throw makeError();
        let cancelTimer: (() => void) | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<T>((_resolve, reject) => {
                    // `armExpiryTimer` rejects only after `deadline.isExpired()` returns `true`.
                    // Treat a timer rejection as expiry only when `deadline.isExpired()` confirms it.
                    // An early timer rejection would allow the pre-send replay token to spend a second connect and route open.
                    cancelTimer = armExpiryTimer(deadline, () => reject(makeError()));
                }),
            ]);
        } finally {
            cancelTimer?.();
        }
    }

    private cleanupLane(sessionId: string, lane: SerialLane): void {
        if (
            !lane.active &&
            lane.waiters.length === 0 &&
            this.sessionLanes.get(sessionId) === lane
        ) {
            this.sessionLanes.delete(sessionId);
        }
    }

    private laneRelease(sessionId: string, lane: SerialLane): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            lane.active = false;
            this.dispatchNextLaneWaiter(sessionId, lane);
        };
    }

    private dispatchNextLaneWaiter(sessionId: string, lane: SerialLane): void {
        if (lane.active) return;
        while (lane.waiters.length > 0) {
            const waiter = lane.waiters.shift();
            if (!waiter) continue;
            this.queuedLaneWaiters = Math.max(0, this.queuedLaneWaiters - 1);
            if (waiter.settled) continue;
            waiter.settled = true;
            clearTimeout(waiter.timer);
            waiter.signal?.removeEventListener("abort", waiter.onAbort);
            if (waiter.signal?.aborted) {
                waiter.reject(waiter.signal.reason ?? new Error("module transport call aborted"));
                continue;
            }
            if (waiter.deadline.remainingMs() < SERIAL_LANE_MIN_REMAINING_MS) {
                waiter.reject(this.laneTimeoutError());
                continue;
            }
            lane.active = true;
            waiter.resolve(this.laneRelease(sessionId, lane));
            return;
        }
        this.cleanupLane(sessionId, lane);
    }

    private queueFullError(): Error & { code?: string } {
        const error = new Error("module transport queue is full") as Error & { code?: string };
        error.code = "EBUSY";
        return error;
    }

    private acquireCorrectnessLane(
        sessionId: string,
        signal: AbortSignal | undefined,
        deadline: Deadline,
    ): Promise<() => void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error("module transport call aborted"));
        }
        if (deadline.remainingMs() < SERIAL_LANE_MIN_REMAINING_MS) {
            return Promise.reject(this.laneTimeoutError());
        }
        const lane = this.sessionLanes.get(sessionId) ?? { active: false, waiters: [] };
        this.sessionLanes.set(sessionId, lane);
        if (!lane.active && lane.waiters.length === 0) {
            lane.active = true;
            return Promise.resolve(this.laneRelease(sessionId, lane));
        }
        if (
            this.queuedLaneWaiters >= SERIAL_LANE_MAX_WAITERS ||
            lane.waiters.length >= SERIAL_LANE_MAX_WAITERS_PER_SESSION
        ) {
            return Promise.reject(this.queueFullError());
        }
        return new Promise<() => void>((resolve, reject) => {
            const waiter = {} as SerialLaneWaiter;
            const removeAndReject = (error: unknown): void => {
                if (waiter.settled) return;
                waiter.settled = true;
                clearTimeout(waiter.timer);
                signal?.removeEventListener("abort", waiter.onAbort);
                const index = lane.waiters.indexOf(waiter);
                if (index >= 0) {
                    lane.waiters.splice(index, 1);
                    this.queuedLaneWaiters = Math.max(0, this.queuedLaneWaiters - 1);
                }
                reject(error);
                this.cleanupLane(sessionId, lane);
            };
            waiter.signal = signal;
            waiter.deadline = deadline;
            waiter.resolve = resolve;
            waiter.reject = reject;
            waiter.settled = false;
            waiter.onAbort = () =>
                removeAndReject(signal?.reason ?? new Error("module transport call aborted"));
            waiter.timer = setTimeout(
                () => removeAndReject(this.laneTimeoutError()),
                Math.max(0, deadline.remainingMs()),
            );
            signal?.addEventListener("abort", waiter.onAbort, { once: true });
            lane.waiters.push(waiter);
            this.queuedLaneWaiters += 1;
        });
    }

    async call(args: {
        sessionId: string;
        projectRoot: string;
        method: ModuleMethod;
        body: unknown;
        signal?: AbortSignal;
        /** `call()` does not retry after reconnecting; callers rebuild for the new connection. */
        generationSensitive?: boolean;
        /** Producer-backed calls can outlive the default transport budget. */
        timeoutMs?: number;
    }): Promise<unknown> {
        const wrapupInFlight = (this.wrapupSessions.get(args.sessionId) ?? 0) > 0;
        const operationTimeoutMs =
            args.timeoutMs ??
            (args.method === "session.wrapup" ||
            (args.method === "session.status" && wrapupInFlight)
                ? MAX_WRAPUP_REQUEST_BUDGET_MS
                : args.method === "transform"
                  ? Math.min(this.requestTimeoutMs, TRANSFORM_SEND_TIMEOUT_MS)
                  : this.requestTimeoutMs);
        // `operationDeadline` is an immutable absolute deadline created before session-lane admission.
        // `operationDeadline` is shared by connect, route open, and request.
        // The deadline covers admission, connect, route opening, request, and permitted replay; cleanup uses the facade's separate bounded ticket.
        const deadline = Deadline.start(operationTimeoutMs);
        const tracksWrapup = args.method === "session.wrapup";
        if (tracksWrapup) {
            this.wrapupSessions.set(
                args.sessionId,
                (this.wrapupSessions.get(args.sessionId) ?? 0) + 1,
            );
        }
        const finishWrapupTracking = (): void => {
            if (!tracksWrapup) return;
            const remaining = (this.wrapupSessions.get(args.sessionId) ?? 1) - 1;
            if (remaining > 0) this.wrapupSessions.set(args.sessionId, remaining);
            else this.wrapupSessions.delete(args.sessionId);
        };
        let releaseLane: (() => void) | undefined;
        try {
            releaseLane = await this.acquireCorrectnessLane(args.sessionId, args.signal, deadline);
        } catch (error) {
            finishWrapupTracking();
            throw error;
        }
        // A post-write abort creates a bounded cleanup ticket.
        // A post-write abort settles the caller promptly while the session lane remains fenced until the cleanup ticket resolves; the facade retires the generation on expiry.
        // A post-write abort settles the caller promptly while the session lane remains fenced until the cleanup ticket resolves; the facade retires the generation on expiry.
        let cleanupTicket: Promise<void> | null = null;
        try {
            // This layer uses the facade's replay-free routeOpen/request primitives and solely decides whether to resend a body.
            // This layer uses only the facade's replay-free `routeOpen`/`request` primitives, so it alone decides whether to resend a body.
            // This layer uses only the facade's replay-free `routeOpen`/`request` primitives, so it alone decides whether to resend a body.
            let replaySpent = false;
            for (;;) {
                let ensuredRoute: EnsuredRoute | null = null;
                let requestInvoked = false;
                try {
                    if (args.signal?.aborted) {
                        throw args.signal.reason ?? new Error("module transport call aborted");
                    }
                    ensuredRoute = await this.ensureRoute(
                        args.sessionId,
                        args.projectRoot,
                        deadline,
                        args.signal,
                    );
                    if (args.signal?.aborted) {
                        throw args.signal.reason ?? new Error("module transport call aborted");
                    }
                    requestInvoked = true;
                    const response = await this.beforeDeadline(
                        ensuredRoute.client.request(ensuredRoute.route, args.body, {
                            priority: Priority.Background,
                            admissionClass: AdmissionClass.Normal,
                            timeoutMs: Math.max(1, deadline.remainingMs()),
                            signal: args.signal,
                            ...(ensuredRoute.expectedDaemonId === undefined
                                ? {}
                                : { expectedDaemonId: ensuredRoute.expectedDaemonId }),
                        }),
                        deadline,
                        "waiting for the module response",
                        // A local deadline after `request` invocation means the body may be on the wire, never `not_sent`.
                        // A local deadline after `request` invocation means the body may be on the wire, never `not_sent`.
                        () =>
                            new McHostCallError(
                                "outcome_unknown",
                                "module transport deadline expired waiting for the module response",
                                "request_deadline",
                            ),
                    );
                    if (
                        this.client !== ensuredRoute.client ||
                        this.connectionGeneration !== ensuredRoute.generation
                    ) {
                        throw this.connectionChangedError(
                            "subc connection changed while awaiting the module response",
                        );
                    }
                    return response;
                } catch (error) {
                    cleanupTicket = cleanupTicketOf(error);
                    const kind = mcHostCallErrorKind(error);
                    const callerAborted = args.signal?.aborted === true;
                    // The retry path evicts the route and retries once when the host proves no dispatch.
                    const unknownChannel =
                        kind === "terminal" && errorCodeOf(error) === "unknown_channel";
                    // The code treats a facade `not_sent`, a stale handle rejected before write, or a failure before `request()` as proven pre-send.
                    // The code treats a facade `not_sent`, a stale handle rejected before write, or a failure before `request()` as proven pre-send.
                    const provenNotSent =
                        kind === "not_sent" ||
                        isStaleRouteHandleFailure(error) ||
                        (!requestInvoked && isConnectionFailure(error));
                    const replayEligible = unknownChannel || provenNotSent;
                    const previousGeneration =
                        ensuredRoute?.generation ?? this.connectionGeneration;
                    if (unknownChannel || isStaleRouteHandleFailure(error)) {
                        // Route-level proof evicts the dead route while retaining the connection; the facade reconnects internally when its generation retires.
                        // Route-level proof evicts the dead route while retaining the connection; the facade reconnects internally when its generation retires.
                        // Route-level proof evicts the dead route while retaining the connection; the facade reconnects internally when its generation retires.
                        if (ensuredRoute) {
                            this.dropRoute(ensuredRoute.routeKey, ensuredRoute.route);
                        }
                        // Recovery binds a new route, but an internal facade reconnect does not advance `connectionGeneration`. Because the cached snapshot was probed through the evicted route, the generation counter cannot prove that it describes the module reached by the new route.
                        // Recovery binds a new route, but an internal facade reconnect does not advance `connectionGeneration`. Because the cached snapshot was probed through the evicted route, the generation counter cannot prove that it describes the module reached by the new route.
                        // Because the cached snapshot was probed through the evicted route, the generation counter cannot prove that it describes the module reached by the new route.
                        // Because the cached snapshot was probed through the evicted route, the generation counter cannot prove that it describes the module reached by the new route.
                        // The generation counter cannot expire the cached snapshot because it was probed through the evicted route.
                        this.invalidateStateSyncCapabilities();
                    } else if (cleanupTicket === null && isConnectionFailure(error)) {
                        // A possible send invalidates the route without resending the body.
                        // A post-write abort relies on the bounded cleanup ticket instead of resending a possibly sent body.
                        // After a possible send, a post-write abort uses Cancel and the cleanup ticket rather than resending the body.
                        if (ensuredRoute) {
                            this.dropRoute(ensuredRoute.routeKey, ensuredRoute.route);
                            this.invalidateConnection(ensuredRoute.client);
                        } else {
                            this.invalidateConnection();
                        }
                    }
                    if (replayEligible && args.generationSensitive && !callerAborted) {
                        // Recovery does not cross a route or connection generation.
                        return {
                            transport_status: "connection_generation_changed",
                            previous_generation: previousGeneration,
                            current_generation: this.connectionGeneration,
                        } satisfies ModuleTransportGenerationChangedResult;
                    }
                    if (replayEligible && !replaySpent && !callerAborted && !deadline.isExpired()) {
                        replaySpent = true;
                        continue;
                    }
                    // `outcome_unknown` and all other unhandled outcomes propagate.
                    throw error;
                }
            }
        } finally {
            finishWrapupTracking();
            if (cleanupTicket) {
                const release = releaseLane;
                void cleanupTicket.catch(() => {}).finally(() => release());
            } else {
                releaseLane();
            }
        }
    }

    private async authorityRequest(
        sessionId: string,
        projectRoot: string,
        method: ModuleAuthorityMethod,
        body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const response = (await this.call({
            sessionId,
            projectRoot,
            method,
            body: { ...body, method, v: 1 },
        })) as unknown;
        if (isRecord(response) && isRecord(response.result)) return response.result;
        if (isRecord(response)) return response;
        throw new Error(`module returned an invalid ${method} response`);
    }

    setAuthorityBindRoot(root: string): void {
        this.authorityBindRoot = root;
    }

    private bindRootForAuthority(): string {
        return this.authorityBindRoot.length > 0 ? this.authorityBindRoot : process.cwd();
    }

    async authorityStatus(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{ authority: AuthorityStatus | null }> {
        this.authorityProjectRoot = args.project;
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            args.project,
            projectRoot ?? this.bindRootForAuthority(),
            "authority.status",
            body,
        );
        return { authority: (response.authority as AuthorityStatus | null) ?? null };
    }

    async authorityPrepare(args: Record<string, unknown>): Promise<{ authority: AuthorityStatus }> {
        this.authorityProjectRoot = String(args.project ?? "");
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            String(args.project ?? "authority"),
            typeof projectRoot === "string" ? projectRoot : this.bindRootForAuthority(),
            "authority.prepare",
            body,
        );
        if (!isRecord(response.authority)) throw new Error("authority.prepare omitted authority");
        // `isRecord(response.authority)` only proves that `response.authority` is an object; the cast assumes `AuthorityStatus` fields.
        return { authority: response.authority as unknown as AuthorityStatus };
    }

    async authoritySeed(
        args: Record<string, unknown>,
    ): Promise<{ seeded: number; module_row_ids?: number[] }> {
        this.authorityProjectRoot = String(args.project ?? "");
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            String(args.project ?? "authority"),
            typeof projectRoot === "string" ? projectRoot : this.bindRootForAuthority(),
            "authority.seed",
            body,
        );
        return {
            seeded: typeof response.seeded === "number" ? response.seeded : 0,
            module_row_ids: Array.isArray(response.module_row_ids)
                ? response.module_row_ids.filter((id): id is number => typeof id === "number")
                : undefined,
        };
    }

    async authorityDrain(args: Record<string, unknown>): Promise<AuthorityDrainResponse> {
        this.authorityProjectRoot = String(args.project ?? this.authorityProjectRoot);
        const method = String(args.method ?? "authority.drain.step") as Parameters<
            McHostModuleTransport["authorityRequest"]
        >[2];
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            String(args.project ?? "authority"),
            typeof projectRoot === "string" ? projectRoot : this.bindRootForAuthority(),
            method,
            body,
        );
        if (isRecord(response.authority)) {
            // `isRecord(response.authority)` only proves that `response.authority` is an object; the cast assumes `AuthorityStatus` fields.
            return { authority: response.authority as unknown as AuthorityStatus };
        }
        if (typeof response.code === "string") {
            return {
                code: response.code,
                retryable: response.retryable === true,
            };
        }
        throw new Error("authority.drain omitted authority");
    }

    async mirrorPull(args: {
        domain: "memories" | "notes";
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{ page: ChangefeedPage }> {
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            `mirror:${args.domain}`,
            projectRoot ?? this.bindRootForAuthority(),
            "mirror.pull",
            body,
        );
        if (!isRecord(response.page)) throw new Error("mirror.pull omitted page");
        // `isRecord(response.page)` only proves that `response.page` is an object; the cast assumes `ChangefeedPage` fields.
        return { page: response.page as unknown as ChangefeedPage };
    }

    async claimIntentStage(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentStageRequest;
    }): Promise<ClaimIntentStageResponse> {
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "claim.intent.stage",
            body: buildClaimIntentStageWireBody(args.request),
        });
        return decodeClaimIntentStageResponse(response, args.request);
    }

    async claimIntentInspect(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentInspectRequest;
    }): Promise<ClaimIntentInspectResponse> {
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "claim.intent.inspect",
            body: buildClaimIntentInspectWireBody(args.request),
        });
        return decodeClaimIntentInspectResponse(response);
    }

    async claimIntentAck(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentAckRequest;
    }): Promise<ClaimIntentAckResponse> {
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "claim.intent.ack",
            body: buildClaimIntentAckWireBody(args.request),
        });
        return decodeClaimIntentAckResponse(response, args.request);
    }

    async claimEffectsApply(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimEffectDeliveryRequest;
    }): Promise<ClaimEffectDeliveryResponse> {
        // `receipt.effects` must be nonempty because its last effect is the delivery checkpoint.
        // An empty `receipt.effects` list violates the upstream receipt contract; it is not a zero acknowledgement.
        const expectedEffectId = args.request.receipt.effects.at(-1)?.id;
        if (expectedEffectId === undefined) {
            throw new Error(
                `claim effect receipt ${args.request.receipt.receiptId} has no effects`,
            );
        }
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "claim.effects.apply",
            body: buildClaimEffectDeliveryWireBody(args.request),
        });
        return decodeClaimEffectDeliveryResponse(response, expectedEffectId);
    }

    async claimMirrorReplace(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorSnapshotRequest;
    }): Promise<ClaimMirrorSnapshotResponse> {
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "claim.mirror.replace",
            body: buildClaimMirrorSnapshotWireBody(args.request),
        });
        return decodeClaimMirrorSnapshotResponse(response, args.request);
    }

    async claimMirrorApply(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorReceiptRequest;
    }): Promise<ClaimMirrorReceiptResponse> {
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "claim.mirror.apply",
            body: buildClaimMirrorReceiptWireBody(args.request),
        });
        return decodeClaimMirrorReceiptResponse(response, args.request);
    }

    async deleteSession(sessionId: string, projectRoot: string): Promise<void> {
        await this.call({
            sessionId,
            projectRoot,
            method: "session.delete",
            body: { method: "session.delete", v: 1, session_id: sessionId },
        });
    }

    closeSession(sessionId: string): void {
        const client = this.client;
        const prefix = `${sessionId}\0`;
        // Closing the session fences in-flight opens so a late `route.open` success cannot repopulate the cache.
        // Closing the session fences in-flight opens so a late `route.open` success cannot repopulate the cache.
        let closedOpenings = false;
        for (const [key, opening] of [...this.routeOpenings.entries()]) {
            if (!key.startsWith(prefix)) continue;
            opening.state.closed = true;
            this.routeOpenings.delete(key);
            closedOpenings = true;
        }
        const routes = [...this.routes.entries()].filter(([key]) => key.startsWith(prefix));
        for (const [key, cachedRoute] of routes) {
            this.routes.delete(key);
            if (client) {
                void client.closeRoute(cachedRoute.route).catch((error: unknown) => {
                    if (this.client === client && isConnectionFailure(error)) {
                        this.invalidateConnection(client);
                    }
                });
            }
        }
        if (routes.length === 0 && !closedOpenings && this.sessionLanes.get(sessionId)?.active) {
            this.invalidateConnection(client);
        }
    }

    private async ensureRoute(
        sessionId: string,
        rawProjectRoot: string,
        deadline: Deadline = Deadline.start(this.requestTimeoutMs),
        signal?: AbortSignal,
    ): Promise<EnsuredRoute> {
        // The transport canonicalizes resolvable roots because transform and tool lanes can report symlink and resolved spellings, while the module keys lineage by `(session, root)` in a different filesystem namespace.
        // The transport canonicalizes resolvable roots because transform and tool lanes can report symlink and resolved spellings, while the module keys lineage by `(session, root)` in a different filesystem namespace.
        // The transport canonicalizes resolvable roots because transform and tool lanes can report symlink and resolved spellings, while the module keys lineage by `(session, root)` in a different filesystem namespace.
        // The transport canonicalizes resolvable roots because transform and tool lanes can report symlink and resolved spellings, while the module keys lineage by `(session, root)` in a different filesystem namespace.
        // The transport canonicalizes resolvable roots because transform and tool lanes can report symlink and resolved spellings, while the module keys lineage by `(session, root)` in a different filesystem namespace.
        // The transport canonicalizes resolvable roots because transform and tool lanes can report symlink and resolved spellings, while the module keys lineage by `(session, root)` in a different filesystem namespace.
        const projectRoot = this.canonicalRoot(rawProjectRoot);
        // One identity may legitimately have multiple filesystem routes, such as worktrees. Reusing a route across roots would bind authority to the wrong tree.
        // One identity may legitimately have multiple filesystem routes, such as worktrees. Reusing a route across roots would bind authority to the wrong tree.
        const routeKey = `${sessionId}\0${projectRoot}`;
        // The cache key includes credentials so credential rotation invalidates routes, including routes to explicit credential-bearing daemons.
        // The cache key includes credentials so credential rotation invalidates routes, including routes to explicit credential-bearing daemons.
        // The cache key includes credentials so credential rotation invalidates routes, including routes to explicit credential-bearing daemons.
        // The cache key includes credentials so credential rotation invalidates routes, including routes to explicit credential-bearing daemons.
        // The cache key includes credentials so credential rotation invalidates routes, including routes to explicit credential-bearing daemons.
        const credentialSourceVersion = managedCredentialSourceVersion(process.env);
        // The cache reads a route only after connection settlement, and its generation must match the current connection.
        // The cache reads a route only after connection settlement, and its generation must match the current connection.
        const { client, expectedDaemonId } = await this.ensureConnected(deadline, signal);
        // Capturing expectedDaemonId prevents concurrent invalidation from changing the connection fence to no expectation during later awaits.
        const fence = expectedDaemonId === undefined ? {} : { expectedDaemonId };
        const generation = this.connectionGeneration;
        const existing = this.routes.get(routeKey);
        if (
            existing?.generation === generation &&
            (existing.credentialSourceVersion ?? "") === (credentialSourceVersion ?? "")
        ) {
            return { client, route: existing.route, routeKey, generation, ...fence };
        }
        if (existing) {
            this.routes.delete(routeKey);
            const closeRoute = (client as Partial<McHostClient>).closeRoute;
            if (typeof closeRoute === "function") {
                await closeRoute.call(client, existing.route).catch(() => undefined);
            }
        }
        const opening = this.routeOpenings.get(routeKey);
        if (opening?.client === client && opening.generation === generation) {
            return await opening.promise;
        }

        const state = { closed: false };
        const promise = (async (): Promise<EnsuredRoute> => {
            const target: RouteTarget = { kind: "tool_provider", module_id: this.moduleId };
            const identity: BindIdentity = {
                project_root: projectRoot,
                harness: getHarness(),
                session: `${this.routeSessionPrefix}${sessionId}`,
            };
            const route = await this.beforeDeadline(
                client.routeOpen(target, identity, fence),
                deadline,
                "opening the module route",
            );
            if (
                state.closed ||
                this.client !== client ||
                generation !== this.connectionGeneration
            ) {
                await client.closeRoute(route).catch(() => undefined);
                throw this.connectionChangedError(
                    "subc connection changed while opening module route",
                );
            }
            this.routes.set(routeKey, {
                route,
                generation,
                ...(credentialSourceVersion === undefined ? {} : { credentialSourceVersion }),
            });
            return { client, route, routeKey, generation, ...fence };
        })();
        const routeOpening: OpeningRoute = { client, generation, state, promise };
        this.routeOpenings.set(routeKey, routeOpening);
        try {
            return await routeOpening.promise;
        } finally {
            if (this.routeOpenings.get(routeKey) === routeOpening) {
                this.routeOpenings.delete(routeKey);
            }
        }
    }

    private dropRoute(routeKey: string, route?: RouteHandle): void {
        const existing = this.routes.get(routeKey);
        if (!existing || (route && existing.route !== route)) return;
        this.routes.delete(routeKey);
    }

    /** Per-instance memoization resolves symlinks; missing paths retain their input spelling.
     * Canonicalization preserves the input spelling when the path is gone, so a missing path does not fail the request. */
    private canonicalRoot(root: string): string {
        const cached = this.canonicalRootCache.get(root);
        if (cached !== undefined) {
            this.canonicalRootCache.delete(root);
            this.canonicalRootCache.set(root, cached);
            return cached;
        }
        let resolved = root;
        try {
            resolved = realpathSync.native(root);
        } catch {
            // Gone or unreadable roots keep their observed spelling.
        }
        this.canonicalRootCache.set(root, resolved);
        while (this.canonicalRootCache.size > CANONICAL_ROOT_CACHE_MAX_ENTRIES) {
            const oldestRoot = this.canonicalRootCache.keys().next().value as string | undefined;
            if (oldestRoot === undefined) break;
            this.canonicalRootCache.delete(oldestRoot);
        }
        return resolved;
    }

    private clientOptions(deadline?: Deadline): McHostClientOptions {
        // Derive the handshake stage from the operation deadline without ever
        // extending the preserved 2-second handshake budget (plan KTD5).
        const handshakeTimeoutMs = deadline
            ? Math.max(1, deadline.stageBudgetMs(HANDSHAKE_TIMEOUT_MS))
            : HANDSHAKE_TIMEOUT_MS;
        return {
            connectionFile: this.connectionFile,
            handshakeTimeoutMs,
            credentialSource: process.env,
        };
    }

    private async demandManagedReadiness(
        deadline?: Deadline,
        signal?: AbortSignal,
    ): Promise<Uint8Array | undefined> {
        if (this.connectionOrigin !== "managed-default") return undefined;
        if (!this.demandStart) return undefined;
        const outcome = await this.demandStart({
            origin: this.connectionOrigin,
            capability: "magic-context",
            ...(signal ? { signal } : {}),
            ...(deadline ? { deadlineMs: Math.max(0, deadline.remainingMs()) } : {}),
        });
        if (!outcome.ok) {
            const error = new Error(`managed mc-host demand failed: ${outcome.reason}`) as Error & {
                code?: string;
            };
            error.code = outcome.reason;
            throw error;
        }
        if (outcome.storage !== "ready") {
            const code =
                outcome.storage === "starting" ? "storage_starting" : "storage_unavailable";
            const error = new Error(
                `managed mc-host storage is ${outcome.storage ?? "unknown"}`,
            ) as Error & { code?: string };
            error.code = code;
            throw error;
        }
        if (outcome.authenticatedDaemonId === undefined) {
            throw Object.assign(
                new Error("managed lifecycle compatibility returned no daemon identity"),
                { code: "incompatible_daemon" },
            );
        }
        return outcome.authenticatedDaemonId;
    }

    private async ensureConnected(
        deadline?: Deadline,
        signal?: AbortSignal,
    ): Promise<CertifiedConnection> {
        const cached = this.client;
        if (cached) {
            if (this.connectionOrigin !== "managed-default") {
                return { client: cached };
            }
            const certified = this.connectionCertification;
            if (certified) {
                const expected = certified.expectedDaemonId;
                if (expected === undefined) return { client: cached };
                const actual = cached.authenticated?.daemonId;
                // Only an identity that is present and different is a real rotation.
                if (actual === null || actual === undefined || sameDaemonId(actual, expected)) {
                    return { client: cached, expectedDaemonId: expected };
                }
            }
            this.invalidateConnection(cached);
        }
        const joinable = this.connectionPromise;
        if (joinable) {
            if (signal?.aborted) {
                throw signal.reason ?? new Error("module transport call aborted");
            }
            return await joinable;
        }
        // The transport must not re-probe an unreachable daemon at full request rate.
        if (Date.now() < this.nextProbeMs) {
            throw this.connectionBackoffError();
        }
        let expectedDaemonId: Uint8Array | undefined;
        try {
            expectedDaemonId = await this.demandManagedReadiness(deadline, signal);
        } catch (error) {
            //
            // WaiterDetachedError reflects one caller's signal or deadline and must not arm the transport-wide backoff.
            // Arming backoff for WaiterDetachedError would apply one caller's cancellation to later transport demands.
            // is healthy.
            if (!(error instanceof WaiterDetachedError)) {
                this.nextProbeMs = Date.now() + this.backoffMs;
                this.backoffMs = Math.min(this.backoffMs * 2, CONNECT_BACKOFF_MAX_MS);
            }
            throw error;
        }
        // certification owns a copy of expectedDaemonId so callers cannot mutate the array used by an active connection fence.
        const certification: ConnectionCertification =
            expectedDaemonId === undefined
                ? {}
                : { expectedDaemonId: Uint8Array.from(expectedDaemonId) };
        this.connectionCertification = certification;
        if (signal?.aborted) {
            throw signal.reason ?? new Error("module transport call aborted");
        }
        // Another caller can have opened a dial while this demand was awaiting.
        const raced = this.connectionPromise;
        if (raced) {
            const joined = await raced;
            if (
                expectedDaemonId !== undefined &&
                !sameDaemonId(joined.client.authenticated?.daemonId, expectedDaemonId)
            ) {
                this.invalidateConnection(joined.client);
                throw this.connectionChangedError(
                    "daemon changed after lifecycle compatibility validation",
                );
            }
            return joined;
        }
        const generation = this.connectionGeneration;
        const connecting = (async (): Promise<CertifiedConnection> => {
            let candidate: McHostClient | null = null;
            try {
                const options = this.clientOptions(deadline);
                candidate = await processMcHostClient(options);
                if (
                    expectedDaemonId !== undefined &&
                    !sameDaemonId(candidate.authenticated?.daemonId, expectedDaemonId)
                ) {
                    // The owner cache retains this resolved client; closing it without eviction serves a closed instance to later callers under the same key.
                    await evictProcessMcHostClient(options, candidate);
                    candidate.close();
                    throw this.connectionChangedError(
                        "daemon changed after lifecycle compatibility validation",
                    );
                }
                if (generation !== this.connectionGeneration) {
                    // On generation mismatch, the catch skips `invalidateConnection`, so this branch evicts and closes `candidate`.
                    await evictProcessMcHostClient(options, candidate);
                    candidate.close();
                    throw this.connectionChangedError("subc connection attempt was superseded");
                }
                this.client = candidate;
                this.clientCacheOptions = options;
                this.routes.clear();
                this.backoffMs = CONNECT_BACKOFF_INITIAL_MS;
                this.nextProbeMs = 0;
                return { client: candidate, ...certification };
            } catch (error) {
                if (generation === this.connectionGeneration) this.invalidateConnection();
                this.nextProbeMs = Date.now() + this.backoffMs;
                this.backoffMs = Math.min(this.backoffMs * 2, CONNECT_BACKOFF_MAX_MS);
                throw error;
            }
        })();
        this.connectionPromise = connecting;
        try {
            return await connecting;
        } finally {
            if (this.connectionPromise === connecting) this.connectionPromise = null;
        }
    }

    private connectionBackoffError(): Error & { code?: string } {
        const error = new Error(
            `mc-host connection backoff active until ${this.nextProbeMs}`,
        ) as Error & { code?: string };
        error.code = "MC_HOST_CONNECTION_BACKOFF";
        return error;
    }

    private invalidateConnection(client: McHostClient | null = this.client): void {
        if (client && this.client !== client) return;
        this.connectionGeneration += 1;
        this.connectionCertification = null;
        this.invalidateStateSyncCapabilities();
        const superseded = this.client;
        const supersededOptions = this.clientCacheOptions;
        this.client = null;
        this.clientCacheOptions = null;
        this.routes.clear();
        this.routeOpenings.clear();
        // A retained entry holds a resolved client whose channel owns a polling interval and two ring mappings, and `handshakeTimeoutMs` is deadline-derived, so reconnects do not reuse one entry.
        if (superseded && supersededOptions) {
            void evictProcessMcHostClient(supersededOptions, superseded).then(
                () => superseded.closeAsync().catch(() => undefined),
                () => undefined,
            );
        }
    }
}

export const __moduleTransportTest = {
    isConnectionFailure,
    isStaleOrDeadRouteFailure,
    managedCredentialSourceVersion,
};
