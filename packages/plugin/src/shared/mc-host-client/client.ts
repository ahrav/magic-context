/**
 * `McHostClient` is a routed and managed consumer facade over the connection-generation engine.
 * engine.
 *
 * `McHostClient` coalesces concurrent connection attempts into one connect operation.
 * `McHostClient` rereads the connection file and fully reauthenticates after generation retirement.
 * `McHostClient` caches managed routes and validates control-plane responses.
 * `McHostClient` bounds and redacts diagnostics; the generation layer never imports this module.
 *
 * `request()` never replays a body.
 * `call()` owns one replay token per call.
 * `call()` spends its replay token only after proven `not_sent` or terminal `unknown_channel`, after evicting the route.
 * `call()` spends its replay token only while the caller is active and the operation deadline remains live.
 * `outcome_unknown` is never replayed by any facade path.
 */

import { access } from "node:fs/promises";
import {
    type ConnectionDiagnosticEvent,
    ConnectionGeneration,
    type ConnectionGenerationOptions,
    type JsonReceiveBody,
    type PendingRequest,
    type RequestTerminal,
    type RetirementInfo,
    type RetirementReason,
} from "./connection";
import {
    ConnectionFileError,
    type ConnectionSnapshot,
    readConnectionFile,
} from "./connection-file";
import { credentialFingerprints } from "./credential-fingerprint";
import { armExpiryTimer, Deadline, type MonotonicClock } from "./deadline";
import {
    DAEMON_GENERATION_CHANGED_CODE,
    isMcHostCallError,
    McHostCallError,
    McHostClientError,
    SocketTimeoutError,
} from "./errors";
import { bytesFrameBody, type DirectFrameBody, ReceiveLease, utf8FrameBody } from "./frame-channel";
import { flagsBinary } from "./protocol";
import {
    belongsToConnection,
    createRouteHandle,
    newConnectionToken,
    type RouteHandle,
    StaleRouteHandleError,
} from "./route-handle";
import {
    ACTIVATION_CORRELATION,
    commitRequestJson,
    decodeActivateResponse,
    decodeCommitResponse,
    decodeNegotiateResponse,
    encodeActivateRequest,
    encodeNegotiateRequest,
    type FallbackReason,
    NEGOTIATION_VERSION,
    type NegotiateResponse,
    NegotiationError,
    TRANSPORT_TCP,
} from "./transport-negotiation";
import {
    type ClientTransportProvider,
    ClientTransportRegistry,
    sanitizedCandidateFactory,
} from "./transport-provider";
import type {
    AuthenticatedPeer,
    BindIdentity,
    CatalogEntry,
    CatalogSnapshot,
    ConnectOptions,
    ConsumerIdentity,
    HostStatusSnapshot,
    ManagedCallOptions,
    ManagedRouteKind,
    PublicationDiagnostics,
    RequestOptions,
    RouteTarget,
} from "./types";
import { sameDaemonId } from "./types";

/** `DEFAULT_HANDSHAKE_TIMEOUT_MS` applies to the TypeScript handshake. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
/* */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** `call()` shares one route-open deadline across the managed retry loop. */
const DEFAULT_ROUTE_OPEN_DEADLINE_MS = 30_000;
/** `shutdown()` uses a separate deadline for route and connection Goodbye. */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
export const DEFAULT_RECOVERY_DEADLINE_MS = 30_000;
/** `MAX_CONTROL_BODY_LEN` keeps channel-0 control bodies below the frame limit. */
const MAX_CONTROL_BODY_LEN = 65_536;
/**
 * `SETUP_RETRY_*` governs allowlisted `route.open` retries and stale-success replacement pacing in both setup loops.
 */
const SETUP_RETRY_BASE_MS = 100;
const SETUP_RETRY_CAP_MS = 2_000;
const DEFAULT_MAX_DIAGNOSTIC_EVENTS_PER_SECOND = 500;
const MAX_DIAGNOSTIC_STRING_LEN = 128;

export const SUBC_MODULE_ID_ENV = "SUBC_MODULE_ID";
export const SUBC_LAUNCH_NONCE_ENV = "SUBC_LAUNCH_NONCE";

const DEFAULT_MANAGED_TARGET_KIND: ManagedRouteKind = "management_surface";

/**
 * A diagnostics event contains only redacted frame identity, byte counts, and connection metadata.
 * Diagnostics events exclude keys, proofs, nonces, body bytes, and full bind identities.
 */
export interface McHostDiagnosticsEvent {
    readonly type: ConnectionDiagnosticEvent["type"] | "connected" | "parse" | "retired";
    /** `timestampMs` records wall-clock milliseconds at emission. */
    readonly atMs: number;
    readonly frameType?: number;
    readonly channel?: number;
    readonly epoch?: number;
    readonly corr?: bigint;
    readonly len?: number;
    readonly daemonVer?: string;
    readonly pid?: number;
    readonly reason?: string;
    /** `connected` events include the negotiated transport name. */
    readonly transport?: string;
    /** `connected` events include a closed-set TCP fallback reason when one exists. */
    readonly fallbackReason?: FallbackReason;
}

export type McHostDiagnosticsObserver = (event: McHostDiagnosticsEvent) => void;

/**
 * `ConnectOptions` defines consumer-facing construction options; remaining options bound policy or inject dependencies.
 */
export interface McHostClientOptions extends ConnectOptions {
    /** The clock supplies monotonic time for every operation deadline. */
    clock?: MonotonicClock;
    /** The sleep function injects backoff delays so retries are deterministic in tests. */
    sleep?: (ms: number) => Promise<void>;
    requestTimeoutMs?: number;
    routeOpenDeadlineMs?: number;
    shutdownDeadlineMs?: number;
    /**
     * The `afterOpen` hook is forwarded to connection-file reads so tests can race snapshots against deadlines deterministically.
     */
    connectionFileAfterOpen?: () => void | Promise<void>;
    /**
     * The diagnostics observer receives frozen, size- and rate-bounded redacted events; observer exceptions are swallowed.
     * excess events are dropped rather than blocking protocol work.
     */
    diagnostics?: McHostDiagnosticsObserver;
    maxDiagnosticEventsPerSecond?: number;
    /** Tests can override bounded generation policy, including queue caps and deadlines. */
    generationOptions?: Partial<
        Pick<
            ConnectionGenerationOptions,
            | "frameDeadlineMs"
            | "maxBodyLen"
            | "memoryCapBytes"
            | "maxQueuedFrames"
            | "maxQueuedBytes"
            | "controlReserveFrames"
            | "cleanupTicketMs"
            | "generateNonce"
        >
    >;
    /** @internal Not part of the consumer contract. */
    transportProviders?: readonly ClientTransportProvider[];
}

interface ActiveConnection {
    readonly generation: ConnectionGeneration;
    /** `connectionToken` binds this connection's route handles. */
    readonly token: object;
    readonly snapshot: ConnectionSnapshot;
    readonly liveRoutes: Map<number, RouteHandle>;
    /** The selected transport remains fixed from publication until retirement. */
    transport: string;
    /** `fallbackReason` records a closed-set reason only when selection is an explicit TCP fallback. */
    fallbackReason?: FallbackReason;
    role?: "shadow";
}

/**
 * A re-upgrade episode is fenced to its source primary and immutable deadline; cancellation releases every shadow permit when the owner closes or the primary retires.
 */
interface RecoveryEpisode {
    readonly source: ActiveConnection;
    readonly deadline: Deadline;
    cancelled: boolean;
    readonly shadowGenerations: Set<ConnectionGeneration>;
}

type ShadowOutcome =
    | { kind: "promote"; conn: ActiveConnection }
    | { kind: "retry" }
    | { kind: "stop" };

interface CachedManagedRoute {
    readonly target: Extract<RouteTarget, { kind: ManagedRouteKind }>;
    identity: BindIdentity;
    readonly consumerIdentity: ConsumerIdentity | undefined;
    handle: RouteHandle | null;
    opening: SetupFlight<RouteHandle> | null;
    /**
     * `closeRoute` marks an in-flight open as closed; the open must not install its handle and instead sends best-effort route Goodbye.
     */
    closed: boolean;
}

/**
 * `SetupFlight` shares a connect or managed route open and records explicit replacement eligibility.
 * `SetupFlight`'s creator awaits `promise` directly; each joiner races it against its own stage deadline.
 * `replaceable` becomes true only at owner-budget-exhaustion exits, so a surviving joiner may coalesce one replacement; permanent failures and close outcomes leave it false.
 */
interface SetupFlight<T> {
    promise: Promise<T>;
    replaceable: boolean;
}

/**
 * `raceAgainstStage` rejects only after `stage.isExpired()`; `armExpiryTimer` re-arms until expiry and rejects post-expiry fulfillment.
 * `flight`'s creation-time rejection observer prevents unhandled rejections when callers abandon the flight after losing the race.
 */
async function raceAgainstStage<T>(
    flight: Promise<T>,
    stage: Deadline,
    makeError: () => Error,
): Promise<T> {
    let cancelTimer: (() => void) | undefined;
    try {
        const result = await Promise.race([
            flight,
            new Promise<never>((_resolve, reject) => {
                cancelTimer = armExpiryTimer(stage, () => reject(makeError()));
            }),
        ]);
        // `raceAgainstStage` rejects setup that settles after the caller's stage expires, even when its settlement callback runs before the expiry timer; it does not attribute the shared flight's failure to that caller.
        if (stage.isExpired()) throw makeError();
        return result;
    } catch (error) {
        if (stage.isExpired()) throw makeError();
        throw error;
    } finally {
        cancelTimer?.();
    }
}

function connectionStageError(): SocketTimeoutError {
    return new SocketTimeoutError(
        "connection setup stage expired before the shared connect completed",
    );
}

function routeStageError(): McHostCallError {
    return new McHostCallError(
        "not_sent",
        "route.open deadline expired before a route was opened",
        "deadline_expired",
    );
}

/**
 * Stale-success re-entry in a setup loop uses an escalating bounded pacer.
 * A stale success does not consume the caller's budget, so the pacer prevents socket-speed flight replacement while the daemon retires fresh setup.
 * Each wait is clamped to the caller's stage, so pacing never extends it.
 */
function makeReplacementPacer(
    stage: Deadline,
    sleep: (ms: number) => Promise<void>,
): () => Promise<void> {
    let delayMs = SETUP_RETRY_BASE_MS;
    return async () => {
        await sleep(stage.stageBudgetMs(delayMs));
        delayMs = Math.min(delayMs * 2, SETUP_RETRY_CAP_MS);
    };
}

/**
 * `clearSlot` receives the settling flight's identity, so an old flight cannot clear a newer flight.
 * writes `replaceable`.
 */
function makeSetupFlight<T>(
    run: (flight: SetupFlight<T>) => Promise<T>,
    clearSlot: (flight: SetupFlight<T>) => void,
): SetupFlight<T> {
    const flight = { replaceable: false } as SetupFlight<T>;
    flight.promise = run(flight).finally(() => clearSlot(flight));
    flight.promise.catch(() => {});
    return flight;
}

interface RequestParams {
    channel: number;
    epoch: number;
    body: Uint8Array | DirectFrameBody;
    deadline: Deadline;
    options: RequestOptions;
    responseMode?: "json" | "binary";
    mode?: "unary" | "stream";
    /** The ceiling limits retained items for each stream-mode request. */
    maxStreamItems?: number;
    binary?: boolean;
    /**
     * Only negotiation requests retain the raw wire Error terminal because legacy-fallback classification requires its exact bytes.
     */
    captureErrorTerminal?: boolean;
}

function errorCode(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") return code;
    }
    return undefined;
}

function causeMessage(cause: unknown): string {
    if (cause === undefined) return "";
    return `: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/**
 * These `route.open` rejection codes indicate transient target unavailability, so a later `route.open` may succeed.
 */
function isRetryableRouteOpenCode(code: string | undefined): boolean {
    return (
        code === "unknown_module" ||
        code === "module_reloading" ||
        code === "target_unavailable" ||
        code === "module_timeout"
    );
}

/* */
export async function connectionFileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Recognition works cross-bundle by error `name` and `kind`/`code` shape, not only `instanceof`.
 */
export function isConsumerReconnectTransient(err: unknown): boolean {
    if (err instanceof McHostCallError) {
        return err.kind === "not_sent" || err.kind === "outcome_unknown";
    }
    const name = err instanceof Error ? err.name : undefined;
    if (name === "SocketClosedError" || name === "SocketTimeoutError" || name === "AuthError") {
        return true;
    }
    if (name === "McHostCallError") {
        const kind = (err as { kind?: unknown }).kind;
        return kind === "not_sent" || kind === "outcome_unknown";
    }
    if (name === "McHostClientError" || name === "ConnectionFileError") return false;
    const code = errorCode(err);
    return (
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        code === "ETIMEDOUT" ||
        code === "ENOENT"
    );
}

/**
 * Shadow recovery retries discovery and dial failures only.
 * Authentication and protocol failures stop the recovery episode permanently.
 * classifies correctly.
 */
function isShadowDialTransient(err: unknown): boolean {
    const name = err instanceof Error ? err.name : undefined;
    if (name === "AuthError") return false;
    if (name === "SocketClosedError" || name === "SocketTimeoutError") return true;
    const code = errorCode(err);
    return (
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        code === "ETIMEDOUT" ||
        code === "ENOENT"
    );
}

/**
 */
export class McHostClient {
    private readonly connectionFile: string;
    private readonly handshakeTimeoutMs: number;
    private readonly requestTimeoutMs: number;
    private readonly routeOpenDeadlineMs: number;
    private readonly shutdownDeadlineMs: number;
    private readonly recoveryDeadlineMs = DEFAULT_RECOVERY_DEADLINE_MS;
    private readonly defaultIdentity: BindIdentity | undefined;
    private readonly defaultTargetKind: ManagedRouteKind;
    private readonly credentialSource: Record<string, string | undefined> | undefined;
    private readonly clock: MonotonicClock | undefined;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly connectionFileAfterOpen: (() => void | Promise<void>) | undefined;
    private readonly generationOptions: McHostClientOptions["generationOptions"];
    private readonly diagnostics: McHostDiagnosticsObserver | undefined;
    private readonly maxDiagnosticEventsPerSecond: number;
    private readonly transportRegistry: ClientTransportRegistry;

    private active: ActiveConnection | null = null;
    private connecting: SetupFlight<ActiveConnection> | null = null;
    /** The draining generation slot remains occupied from promotion until drain completes. */
    private predecessor: ActiveConnection | null = null;
    /** The client runs at most one recovery episode at a time. */
    private recovery: RecoveryEpisode | null = null;
    /** The managed-route cache owns these `RouteHandle`s; callers own raw handles. On pending-zero, drain closes orphaned managed handles but waits for callers to close raw handles. */
    private readonly managedHandles = new WeakSet<RouteHandle>();
    private readonly routes = new Map<string, CachedManagedRoute>();
    /** Owner close bounds draining in-flight `route.open` attempts. */
    private readonly pendingRouteOpens = new Set<Promise<void>>();
    /**
     * The pending set prevents retirement between a `route.open` terminal and insertion of its handle into `liveRoutes`.
     */
    private readonly routeOpenCounts = new Map<ActiveConnection, number>();
    private closeStarted = false;
    private closePromise: Promise<void> | null = null;

    private diagWindowStartMs = 0;
    private diagWindowCount = 0;

    private constructor(options: McHostClientOptions) {
        this.connectionFile = options.connectionFile;
        this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.routeOpenDeadlineMs = options.routeOpenDeadlineMs ?? DEFAULT_ROUTE_OPEN_DEADLINE_MS;
        this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
        this.defaultIdentity = options.identity;
        this.defaultTargetKind = options.targetKind ?? DEFAULT_MANAGED_TARGET_KIND;
        this.credentialSource = options.credentialSource;
        this.clock = options.clock;
        this.sleep =
            options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.connectionFileAfterOpen = options.connectionFileAfterOpen;
        this.generationOptions = options.generationOptions;
        this.diagnostics = options.diagnostics;
        this.maxDiagnosticEventsPerSecond =
            options.maxDiagnosticEventsPerSecond ?? DEFAULT_MAX_DIAGNOSTIC_EVENTS_PER_SECOND;
        this.transportRegistry = new ClientTransportRegistry(options.transportProviders ?? []);
    }

    /**
     * Connection setup shares one handshake deadline across file reading, dialing, and authentication.
     */
    static async connect(options: McHostClientOptions): Promise<McHostClient> {
        const client = new McHostClient(options);
        await client.ensureConnection(Deadline.start(client.handshakeTimeoutMs, client.clock));
        return client;
    }

    /* */
    get daemonVer(): string | null {
        return this.active?.snapshot.daemonVer ?? null;
    }

    /**
     * Lifecycle policy must use the retained peer identity, not {@link publication}, for compatibility and fencing.
     */
    get authenticated(): AuthenticatedPeer | null {
        const active = this.active;
        if (!active || active.generation.isRetired()) return null;
        const daemonVer = active.generation.daemonVer;
        const daemonId = active.generation.authenticatedDaemonId;
        if (daemonVer === null || daemonId === null) return null;
        return {
            daemonVer,
            // The client copies `daemonId` so callers cannot mutate the retained identity used for compatibility and fencing.
            daemonId: daemonId.slice(),
            proof: "current",
        };
    }

    /**
     * Publication metadata is untrusted display metadata and must never authorize compatibility, shutdown, or cleanup.
     */
    get publication(): PublicationDiagnostics | null {
        const active = this.active;
        if (!active) return null;
        return { daemonVer: active.snapshot.daemonVer, pid: active.snapshot.pid };
    }

    /**
     * routeOpen makes one attempt under one bounded deadline and returns a connection-bound immutable handle.
     * Retry policy belongs to callers; managed call() owns an allowlisted retry loop.
     */
    async routeOpen(
        target: RouteTarget,
        identity: BindIdentity,
        options: Pick<RequestOptions, "expectedDaemonId"> = {},
    ): Promise<RouteHandle> {
        const deadline = Deadline.start(this.routeOpenDeadlineMs, this.clock);
        const active = await this.ensureConnection(deadline, options.expectedDaemonId);
        return this.controlRouteOpen(
            active,
            target,
            this.identityForConnection(active, identity),
            this.envConsumerIdentity(),
            deadline,
        );
    }

    /**
     * request sends one routed request on the supplied route generation and never replays the body.
     */
    async request(
        handle: RouteHandle,
        body: unknown,
        options: RequestOptions = {},
    ): Promise<unknown> {
        const active = this.requireLiveHandle(handle);
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const terminal = await this.awaitRequest(active.generation, {
            channel: handle.channel,
            epoch: handle.epoch,
            body: encodeBody(body),
            deadline,
            options,
        });
        return parseResponseJson(terminal);
    }

    /** Caller releases the returned ReceiveLease. */
    async requestBinary(
        handle: RouteHandle,
        body: Uint8Array,
        options: RequestOptions = {},
    ): Promise<ReceiveLease> {
        const active = this.requireLiveHandle(handle);
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const terminal = await this.awaitRequest(active.generation, {
            channel: handle.channel,
            epoch: handle.epoch,
            body: bytesFrameBody(body),
            deadline,
            options,
            responseMode: "binary",
            binary: true,
        });
        if (terminal.kind !== "response" || !(terminal.body instanceof ReceiveLease)) {
            throw new McHostCallError(
                "terminal",
                "binary request did not receive a binary response",
                "expected_binary_response",
            );
        }
        return terminal.body;
    }

    /**
     * The stream is bounded by the connection pending-byte budget and a retained-item ceiling, preventing unbounded per-item decode overhead under the byte budget alone.
     */
    async requestStream<Item = unknown>(
        handle: RouteHandle,
        body: unknown,
        options: RequestOptions & { maxStreamItems?: number } = {},
    ): Promise<Item[]> {
        const active = this.requireLiveHandle(handle);
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const terminal = await this.awaitRequest(active.generation, {
            channel: handle.channel,
            epoch: handle.epoch,
            body: encodeBody(body),
            deadline,
            options,
            mode: "stream",
            ...(options.maxStreamItems === undefined
                ? {}
                : { maxStreamItems: options.maxStreamItems }),
        });
        if (terminal.kind !== "stream_end") {
            throw new McHostCallError(
                "terminal",
                "stream request did not receive StreamEnd",
                "expected_stream_response",
            );
        }
        return terminal.stream.map((item) => {
            const json = requireJsonReceiveBody(item);
            if (!json.valid) {
                throw new McHostCallError(
                    "terminal",
                    "stream item body was not valid JSON",
                    "invalid_response_body",
                );
            }
            return json.value as Item;
        });
    }

    /**
     * call() caches routes by target kind, module ID, identity, and consumer identity and reopens them after retirement.
     * call() replays a request at most once after an unknown-channel or not-sent failure while the caller remains active and before the deadline.
     */
    async call<Response = unknown>(
        moduleId: string,
        method: string,
        params?: unknown,
        options: ManagedCallOptions = {},
    ): Promise<Response> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const body = utf8FrameBody(
            JSON.stringify(params === undefined ? { method } : { method, params }),
        );
        let replaySpent = false;
        for (;;) {
            const handle = await this.managedRouteHandle(moduleId, options, deadline);
            try {
                const active = this.requireLiveHandle(handle);
                const terminal = await this.awaitRequest(active.generation, {
                    channel: handle.channel,
                    epoch: handle.epoch,
                    body,
                    deadline,
                    options,
                });
                return parseResponseJson<Response>(terminal);
            } catch (error) {
                const err = toManagedCallError(error);
                const callerActive = !this.closeStarted && options.signal?.aborted !== true;
                const mayReplay = !replaySpent && callerActive && !deadline.isExpired();
                if (err.kind === "terminal" && err.code === "unknown_channel" && mayReplay) {
                    // The host proved no dispatch; evict the dead route.
                    replaySpent = true;
                    this.evictHandle(handle);
                    continue;
                }
                if (err.kind === "not_sent" && mayReplay) {
                    replaySpent = true;
                    continue;
                }
                throw err;
            }
        }
    }

    /* */
    async catalogList(options: { timeoutMs?: number } = {}): Promise<CatalogEntry[]> {
        return (await this.catalogSnapshot(options)).modules;
    }

    /**
     * catalog.list requires a tagged generation, closed-shape host subc_ops, and per-module id, version, roles, and control_ops.
     * Any duplicate, missing field, or out-of-bounds value throws malformed_control_response; the response is never cast.
     *
     * Unknown fields are ignored, not rejected.
     * The parser ignores unknown fields so newer daemons can add fields without stranding older clients.
     * The negotiation family permits fields that closed-shape responses reject.
     *
     * timeoutMs overrides the client-wide request timeout so callers can spend only their remaining aggregate-deadline budget.
     */
    async catalogSnapshot(options: { timeoutMs?: number } = {}): Promise<CatalogSnapshot> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "catalog.list" });
        const parsed = await this.controlRequest(active, bodyText, "catalog.list", deadline);
        return parseCatalogResponse(parsed);
    }

    /**
     * host.shutdown resolves only after its correlated success response is fully received.
     * host.shutdown resolves only after its correlated success response is fully received—the caller-observable stop-commit point.
     * `close()` and `closeAsync()` never call `host.shutdown`; they only tear down the connection.
     * `close()` and `closeAsync()` perform connection teardown only.
     */
    async hostShutdown(options: { timeoutMs?: number } = {}): Promise<void> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "host.shutdown" });
        await this.controlRequest(active, bodyText, "host.shutdown", deadline);
    }

    /** The readiness operation reads host-owned component readiness without opening a routed module. */
    async hostStatus(options: { timeoutMs?: number } = {}): Promise<HostStatusSnapshot> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "host.status" });
        const parsed = await this.controlRequest(active, bodyText, "host.status", deadline);
        return parseHostStatusResponse(parsed);
    }

    /**
     * Route teardown removes exactly the supplied route generation.
     * Route teardown evicts caches, sends route Goodbye, and awaits the write within the shutdown deadline.
     */
    async closeRoute(handle: RouteHandle): Promise<void> {
        const conn = this.requireLiveHandle(handle);
        conn.liveRoutes.delete(handle.channel);
        for (const [key, cached] of this.detachCachedHandle(handle)) {
            cached.closed = true;
            this.routes.delete(key);
        }
        conn.generation.enqueueRouteGoodbye(handle.channel, handle.epoch);
        await conn.generation.flushWrites(Deadline.start(this.shutdownDeadlineMs, this.clock));
        if (this.predecessor === conn) this.maybeRetirePredecessor();
    }

    /**
     * close() starts bounded asynchronous teardown and returns immediately.
     * `closeAsync()`.
     */
    close(): void {
        void this.closeAsync();
    }

    /**
     * closeAsync() uses one bounded shutdown deadline.
     * closeAsync() drains in-flight route.open attempts.
     * A late route.open success sends route Goodbye instead of entering the route cache.
     * closeAsync() sends connection Goodbye best-effort, flushes, retires the generation, and is idempotent.
     */
    closeAsync(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closeStarted = true;
        this.closePromise = this.runClose();
        return this.closePromise;
    }

    // ------------------------------------------------------------------
    // The connection owner replaces a retired generation.
    // ------------------------------------------------------------------

    private async ensureConnection(
        deadline: Deadline,
        expectedDaemonId?: Uint8Array,
    ): Promise<ActiveConnection> {
        // Each caller derives one immutable handshake stage from its operation deadline and retains it through every join and replacement.
        const stage = deadline.stage(this.handshakeTimeoutMs);
        const pace = makeReplacementPacer(stage, this.sleep);
        for (;;) {
            if (this.closeStarted) throw new McHostClientError("client closed", "client_closed");
            const active = this.active;
            if (active && !active.generation.isRetired()) {
                this.assertExpectedDaemon(active.generation, expectedDaemonId);
                return active;
            }
            let flight = this.connecting;
            let owner = false;
            if (!flight) {
                owner = true;
                flight = makeSetupFlight(
                    (f) => this.openConnection(stage, f),
                    (f) => {
                        if (this.connecting === f) this.connecting = null;
                    },
                );
                this.connecting = flight;
            }
            let conn: ActiveConnection;
            try {
                // The owner awaits its bounded operation directly so timeout and retirement errors propagate unchanged.
                // Each joiner waits on the shared flight against its own stage.
                conn = owner
                    ? await flight.promise
                    : await raceAgainstStage(flight.promise, stage, connectionStageError);
            } catch (error) {
                // A joiner whose stage expires detaches without mutating the shared flight.
                // Only owner-budget exhaustion of a joined flight authorizes one coalesced replacement.
                if (owner || !flight.replaceable || stage.isExpired() || this.closeStarted) {
                    throw error;
                }
                continue;
            }
            // The connection owner adopts only a still-current, non-retired generation; a stale success re-enters recovery under the unchanged stage.
            if (this.active === conn && !conn.generation.isRetired()) {
                this.assertExpectedDaemon(conn.generation, expectedDaemonId);
                return conn;
            }
            if (stage.isExpired()) throw connectionStageError();
            // The loop head adopts a live candidate without new I/O; otherwise, pace the replacement dial.
            const candidate = this.active;
            if (!candidate || candidate.generation.isRetired()) {
                await pace();
                if (stage.isExpired()) throw connectionStageError();
            }
        }
    }

    private async openConnection(
        stage: Deadline,
        flight: SetupFlight<ActiveConnection>,
    ): Promise<ActiveConnection> {
        // Reconnect rereads the file and reauthenticates; credentials are not cached across generations.
        let snapshot: ConnectionSnapshot;
        try {
            snapshot = await readConnectionFile(this.connectionFile, {
                deadline: stage,
                afterOpen: this.connectionFileAfterOpen,
            });
        } catch (error) {
            // Only `ConnectionFileError` with code `deadline_expired` makes `flight` replaceable.
            if (error instanceof ConnectionFileError && error.code === "deadline_expired") {
                flight.replaceable = true;
            }
            throw error;
        }
        let conn: ActiveConnection | null = null;
        let retiredReason: RetirementReason | null = null;
        const generation = new ConnectionGeneration({
            host: snapshot.endpoint.host,
            port: snapshot.endpoint.port,
            credentials: {
                key: snapshot.key,
                daemonId: snapshot.daemonId,
                daemonVer: snapshot.daemonVer,
            },
            onRetired: (info) => {
                retiredReason = info.reason;
                if (conn) this.onGenerationRetired(conn, info);
            },
            onRouteGoodbye: (channel, epoch) => {
                if (conn) this.onRouteGoodbye(conn, channel, epoch);
            },
            onPendingZero: () => {
                if (conn) this.onPendingDrained(conn);
            },
            onLeaseReleased: () => {
                if (conn) this.onPendingDrained(conn);
            },
            // An absent observer avoids per-frame event allocation.
            // undefined.
            onDiagnostic: this.diagnostics ? (event) => this.emitDiagnostics(event) : undefined,
            ...this.generationOptions,
        });
        conn = {
            generation,
            token: newConnectionToken(),
            snapshot,
            liveRoutes: new Map(),
            transport: TRANSPORT_TCP,
        };
        try {
            await generation.start(stage);
        } catch (error) {
            // Only retirement with reason `setup_deadline` makes `flight` replaceable; auth, socket, and protocol failures do not.
            // replacement.
            if (retiredReason === "setup_deadline") flight.replaceable = true;
            throw error;
        }
        if (this.closeStarted) {
            generation.retire("owner_close");
            throw new McHostClientError("client closed", "client_closed");
        }
        // A generation retired during setup skips negotiation; `ensureConnection` recovers under the caller's unchanged stage.
        // A Goodbye coalesced into the final handshake chunk can retire the generation during setup.
        if (generation.isRetired()) return conn;
        // `negotiateTransport` runs on authenticated channel 0 before publication, so no caller observes a generation without a selection.
        let selection: NegotiateResponse;
        try {
            selection = await this.negotiateTransport(generation, stage);
        } catch (error) {
            generation.retire("negotiation_failed", error);
            // Negotiation expiry on the owner's setup stage makes `flight` replaceable; survivors may coalesce one replacement.
            // replacement.
            if (stage.isExpired()) flight.replaceable = true;
            throw error;
        }
        if (this.closeStarted) {
            generation.retire("owner_close");
            throw new McHostClientError("client closed", "client_closed");
        }
        if (selection.kind === "grant") {
            try {
                return await this.activateCandidate(conn, selection, stage);
            } catch (error) {
                // Activation expiry on the owner's setup stage makes `flight` replaceable; survivors may coalesce one replacement.
                if (stage.isExpired()) flight.replaceable = true;
                throw error;
            }
        }
        // The frame pump can retire the generation in the batch that resolves negotiation, so a retired generation must not be published or reported connected.
        // A coalesced Goodbye or EOF can retire the generation in the batch that resolves negotiation.
        if (generation.isRetired()) return conn;
        conn.fallbackReason = selection.reason;
        this.active = conn;
        this.emitConnected(conn, conn.fallbackReason);
        // Only exact `unavailable` starts an automatic shared-memory recovery probe; every other reason and reasonless TCP remain sticky.
        if (conn.fallbackReason === "unavailable") this.startRecovery(conn);
        return conn;
    }

    /**
     * `negotiateTransport` sends the versioned offer as the generation's first channel-0 request.
     * Only a strictly decoded selection continues; every failure, including a wire `Error` terminal, propagates so setup fails closed without same-generation TCP fallback.
     */
    private async negotiateTransport(
        generation: ConnectionGeneration,
        stage: Deadline,
    ): Promise<NegotiateResponse> {
        const offers = this.transportRegistry.offers();
        const body = encodeNegotiateRequest({ negotiationVersion: NEGOTIATION_VERSION, offers });
        let terminal: RequestTerminal;
        try {
            terminal = await this.awaitRequest(generation, {
                channel: 0,
                epoch: 0,
                body,
                deadline: stage,
                options: {},
                captureErrorTerminal: true,
            });
        } catch (error) {
            if (
                error instanceof McHostCallError &&
                error.kind === "terminal" &&
                error.errorTerminal !== undefined
            ) {
                // Every `Error` terminal fails closed with a bounded error.
                // The raw body's message must not enter caller-visible error graphs.
                // The decoder uses `host_negotiation_rejected` to distinguish negotiation rejection.
                throw new McHostCallError(
                    "terminal",
                    "transport negotiation failed: host returned an error terminal (host may predate transport negotiation; restart or upgrade the mc-host daemon)",
                    "host_negotiation_rejected",
                );
            }
            throw error;
        }
        try {
            // The decoder rejects selections absent from the sent offers so an invalid selection cannot enable fallback.
            // Version and field violations are malformed, not fallback evidence.
            // Negotiation responses require UTF-8 JSON with `binary = 0`.
            if (flagsBinary(terminal.flags)) {
                throw new NegotiationError("malformed_json", "flags");
            }
            return decodeNegotiateResponse(
                requireJsonReceiveBody(terminal.body).text ?? "",
                offers,
            );
        } catch (error) {
            throw wrapNegotiationError(error);
        }
    }

    /**
     * Any failure retires the candidate and bootstrap without publishing either.
     */
    private async activateCandidate(
        bootstrap: ActiveConnection,
        grant: Extract<NegotiateResponse, { kind: "grant" }>,
        stage: Deadline,
    ): Promise<ActiveConnection> {
        const conn = await this.prepareCandidate(bootstrap, grant, stage);
        this.active = conn;
        bootstrap.generation.retire("owner_close");
        this.emitConnected(conn);
        return conn;
    }

    /**
     * Any failure retires the candidate and bootstrap without publishing either.
     * Any failure retires the candidate and bootstrap without publishing either.
     * A shadow caller passes its episode's `shadow` set so candidate retirement callbacks remain episode-internal until promotion clears the shadow role.
     * A shadow caller passes its episode's `shadow` set so candidate retirement callbacks remain episode-internal until promotion clears the shadow role.
     */
    private async prepareCandidate(
        bootstrap: ActiveConnection,
        grant: Extract<NegotiateResponse, { kind: "grant" }>,
        stage: Deadline,
        shadow?: Set<ConnectionGeneration>,
    ): Promise<ActiveConnection> {
        const provider = this.transportRegistry.find(
            grant.selected.transport,
            grant.selected.capabilityVersion,
        );
        if (!provider) {
            // The sent-offers guard fails closed when a selection is absent from the sent offers.
            const failure = new McHostCallError(
                "terminal",
                "host granted a transport with no installed provider",
                "negotiation_failed",
            );
            bootstrap.generation.retire("negotiation_failed", failure);
            throw failure;
        }
        const snapshot = bootstrap.snapshot;
        // A candidate channel performs no handshake; it inherits the bootstrap's authority.
        // The candidate inherits the bootstrap's authority across activation and commit.
        // The candidate inherits the bootstrap identity instead of adopting the channel-reported identity.
        // The candidate inherits the bootstrap identity instead of adopting the channel-reported identity.
        const inheritedDaemonVer = bootstrap.generation.daemonVer;
        const inheritedDaemonId = bootstrap.generation.authenticatedDaemonId;
        if (inheritedDaemonVer === null || inheritedDaemonId === null) {
            // `activateCandidate` fails closed if the bootstrap identity is unauthenticated.
            // proved.
            const failure = new McHostCallError(
                "terminal",
                "transport promotion requires an authenticated bootstrap identity",
                "negotiation_failed",
            );
            bootstrap.generation.retire("negotiation_failed", failure);
            throw failure;
        }
        let conn: ActiveConnection | null = null;
        let candidate: ConnectionGeneration;
        try {
            // The `ConnectionGeneration` constructor invokes the channel factory synchronously.
            // The `ConnectionGeneration` constructor invokes `provider.connect()` synchronously.
            // The activation `try` cannot retire channels created before the constructor throws.
            candidate = new ConnectionGeneration({
                host: snapshot.endpoint.host,
                port: snapshot.endpoint.port,
                credentials: {
                    key: snapshot.key,
                    daemonId: snapshot.daemonId,
                    daemonVer: snapshot.daemonVer,
                },
                channelFactory: sanitizedCandidateFactory(
                    grant.selected.transport,
                    provider,
                    grant.descriptor,
                    // A provider that mutates its retained array cannot mutate the candidate's inherited identity.
                    // candidate inherits.
                    inheritedDaemonId.slice(),
                ),
                inheritedIdentity: {
                    daemonVer: inheritedDaemonVer,
                    daemonId: inheritedDaemonId,
                },
                firstCorrelation: ACTIVATION_CORRELATION,
                onRetired: (info) => {
                    if (conn) this.onGenerationRetired(conn, info);
                },
                onRouteGoodbye: (channel, epoch) => {
                    if (conn) this.onRouteGoodbye(conn, channel, epoch);
                },
                onPendingZero: () => {
                    if (conn) this.onPendingDrained(conn);
                },
                onLeaseReleased: () => {
                    if (conn) this.onPendingDrained(conn);
                },
                onDiagnostic: this.diagnostics ? (event) => this.emitDiagnostics(event) : undefined,
                ...this.generationOptions,
            });
        } catch (error) {
            const failure = wrapNegotiationError(error);
            bootstrap.generation.retire("negotiation_failed", failure);
            throw failure;
        }
        shadow?.add(candidate);
        conn = {
            generation: candidate,
            token: newConnectionToken(),
            snapshot,
            liveRoutes: new Map(),
            transport: grant.selected.transport,
            ...(shadow !== undefined ? { role: "shadow" as const } : {}),
        };
        try {
            await candidate.start(stage);
            const activate = await this.awaitRequest(candidate, {
                channel: 0,
                epoch: 0,
                body: encodeActivateRequest(grant.activationToken),
                deadline: stage,
                options: {},
                captureErrorTerminal: true,
            });
            // Negotiation-family responses must be UTF-8 JSON with `binary = 0`.
            // promotion evidence.
            if (flagsBinary(activate.flags)) {
                throw new NegotiationError("malformed_json", "flags");
            }
            decodeActivateResponse(requireJsonReceiveBody(activate.body).text ?? "");
            const commit = await this.awaitRequest(candidate, {
                channel: 0,
                epoch: 0,
                body: commitRequestJson(),
                deadline: stage,
                options: {},
                captureErrorTerminal: true,
            });
            if (flagsBinary(commit.flags)) {
                throw new NegotiationError("malformed_json", "flags");
            }
            decodeCommitResponse(requireJsonReceiveBody(commit.body).text ?? "");
        } catch (error) {
            const failure = boundedNegotiationFailure(error);
            candidate.retire("negotiation_failed", failure);
            bootstrap.generation.retire("negotiation_failed", failure);
            throw failure;
        }
        if (this.closeStarted || candidate.isRetired()) {
            const failure = this.closeStarted
                ? new McHostClientError("client closed", "client_closed")
                : new McHostCallError(
                      "not_sent",
                      "candidate channel retired before promotion",
                      "negotiation_failed",
                  );
            const reason = this.closeStarted ? "owner_close" : "negotiation_failed";
            candidate.retire(reason, failure);
            bootstrap.generation.retire(reason, failure);
            throw failure;
        }
        return conn;
    }

    private onGenerationRetired(conn: ActiveConnection, info: RetirementInfo): void {
        // Shadow teardown is episode-internal; the recovery loop owns it.
        if (conn.role === "shadow") return;
        if (this.predecessor === conn) {
            // Drain completion and a failed predecessor are internal handoff states.
            // Drain completion and a failed predecessor never emit client-level `retired` while a primary is live.
            this.predecessor = null;
            return;
        }
        if (this.active === conn) {
            this.active = null;
            for (const cached of this.routes.values()) {
                cached.handle = null;
            }
            // The episode is fenced to this exact source primary.
            // The client cancels the fenced episode so in-flight shadow permits are released.
            if (this.recovery !== null && this.recovery.source === conn) {
                this.cancelRecovery(this.recovery);
            }
        } else if (this.active !== null) {
            // The client does not emit `retired` when a non-active generation retires after another connection is published.
            // The bootstrap can retire after a candidate is promoted.
            // Emitting `retired` for the bootstrap would interleave a spurious client-level event with the candidate's `connected` event.
            // Setup failures emit `retired` because no connection is published during setup.
            return;
        }
        this.emitDiagnostics({ type: "retired", reason: info.reason });
    }

    private onRouteGoodbye(conn: ActiveConnection, channel: number, epoch: number): void {
        if (this.active !== conn && this.predecessor !== conn) return;
        const handle = conn.liveRoutes.get(channel);
        if (!handle || handle.epoch !== epoch) return;
        conn.liveRoutes.delete(channel);
        this.detachCachedHandle(handle);
        if (this.predecessor === conn) this.maybeRetirePredecessor();
    }

    /** The primary or draining predecessor owns `handle`. */
    private connectionFor(handle: RouteHandle): ActiveConnection | null {
        for (const conn of [this.active, this.predecessor]) {
            if (
                conn !== null &&
                !conn.generation.isRetired() &&
                belongsToConnection(handle, conn.token) &&
                conn.liveRoutes.get(handle.channel) === handle
            ) {
                return conn;
            }
        }
        return null;
    }

    /**
     * Only the primary may serve a cached managed handle.
     * New managed acquisitions never use a draining connection.
     * predecessor (R10).
     */
    private isPrimaryLiveHandle(handle: RouteHandle): boolean {
        const conn = this.connectionFor(handle);
        return conn !== null && conn === this.active;
    }

    private requireLiveHandle(handle: RouteHandle): ActiveConnection {
        const conn = this.connectionFor(handle);
        if (conn === null) throw new StaleRouteHandleError(handle);
        return conn;
    }

    private assertExpectedDaemon(
        generation: ConnectionGeneration,
        expectedDaemonId?: Uint8Array,
    ): void {
        if (expectedDaemonId === undefined) return;
        if (!sameDaemonId(generation.authenticatedDaemonId, expectedDaemonId)) {
            throw new McHostCallError(
                "not_sent",
                "authenticated daemon changed after lifecycle compatibility validation",
                DAEMON_GENERATION_CHANGED_CODE,
            );
        }
    }

    private evictHandle(handle: RouteHandle): void {
        const conn = this.connectionFor(handle);
        if (conn !== null) conn.liveRoutes.delete(handle.channel);
        this.detachCachedHandle(handle);
    }

    /**
     * `closeRoute` uses the returned keys to mark and evict every cached entry for `handle`.
     * Callers that do not own `handle` only detach the route.
     */
    private detachCachedHandle(handle: RouteHandle): [string, CachedManagedRoute][] {
        const detached: [string, CachedManagedRoute][] = [];
        for (const [key, cached] of this.routes) {
            if (cached.handle === handle) {
                cached.handle = null;
                detached.push([key, cached]);
            }
        }
        return detached;
    }

    private emitConnected(conn: ActiveConnection, fallbackReason?: FallbackReason): void {
        this.emitDiagnostics({
            type: "connected",
            daemonVer: conn.snapshot.daemonVer.slice(0, MAX_DIAGNOSTIC_STRING_LEN),
            pid: conn.snapshot.pid,
            transport: conn.transport,
            ...(fallbackReason !== undefined ? { fallbackReason } : {}),
        });
    }

    // ------------------------------------------------------------------
    // Fresh generations can re-upgrade from TCP to shared memory.
    // ------------------------------------------------------------------

    /**
     * The client begins one recovery episode fenced to `source`.
     * Only an exact `unavailable` TCP fallback starts recovery.
     * The recovery deadline is created once and is not reset by retries.
     */
    private startRecovery(source: ActiveConnection): void {
        if (this.closeStarted) return;
        const prior = this.recovery;
        // The client cancels the prior episode so its shadow permits are released before the new episode dials.
        if (prior !== null) this.cancelRecovery(prior);
        const episode: RecoveryEpisode = {
            source,
            deadline: Deadline.start(this.recoveryDeadlineMs, this.clock),
            cancelled: false,
            shadowGenerations: new Set(),
        };
        this.recovery = episode;
        void this.runRecoveryEpisode(episode)
            .catch(() => {})
            .finally(() => {
                if (this.recovery === episode) this.recovery = null;
            });
    }

    private cancelRecovery(episode: RecoveryEpisode): void {
        episode.cancelled = true;
        for (const generation of [...episode.shadowGenerations]) {
            generation.retire("owner_close");
        }
    }

    private recoveryStopped(episode: RecoveryEpisode): boolean {
        return (
            episode.cancelled ||
            this.closeStarted ||
            this.active !== episode.source ||
            episode.source.generation.isRetired()
        );
    }

    private async runRecoveryEpisode(episode: RecoveryEpisode): Promise<void> {
        let delayMs = SETUP_RETRY_BASE_MS;
        const pace = async (): Promise<void> => {
            await this.sleep(episode.deadline.stageBudgetMs(delayMs));
            delayMs = Math.min(delayMs * 2, SETUP_RETRY_CAP_MS);
        };
        for (;;) {
            if (this.recoveryStopped(episode) || episode.deadline.isExpired()) return;
            // The recovery loop creates no candidate while two generations drain, so a third generation and extra connection permit cannot exist.
            if (this.predecessor !== null) {
                await pace();
                continue;
            }
            const outcome = await this.shadowAttempt(episode);
            if (outcome.kind === "promote") {
                this.finishPromotion(episode, outcome.conn);
                return;
            }
            if (outcome.kind === "stop") return;
            await pace();
        }
    }

    /**
     * The episode deadline bounds all retries.
     * The episode retries discovery and dial transients and repeated exact `unavailable`; it stops for every other outcome.
     */
    private async shadowAttempt(episode: RecoveryEpisode): Promise<ShadowOutcome> {
        const stage = episode.deadline.stage(this.handshakeTimeoutMs);
        let snapshot: ConnectionSnapshot;
        try {
            snapshot = await readConnectionFile(this.connectionFile, {
                deadline: stage,
            });
        } catch (error) {
            // The episode retries `deadline_expired` because the episode deadline bounds subsequent attempts.
            // classification (KTD6).
            if (
                error instanceof ConnectionFileError &&
                (error.code === "not_found" ||
                    error.code === "replaced_during_read" ||
                    error.code === "deadline_expired")
            ) {
                return { kind: "retry" };
            }
            return { kind: "stop" };
        }
        const generation = new ConnectionGeneration({
            host: snapshot.endpoint.host,
            port: snapshot.endpoint.port,
            credentials: {
                key: snapshot.key,
                daemonId: snapshot.daemonId,
                daemonVer: snapshot.daemonVer,
            },
            ...this.generationOptions,
        });
        episode.shadowGenerations.add(generation);
        try {
            try {
                await generation.start(stage);
            } catch (error) {
                return { kind: isShadowDialTransient(error) ? "retry" : "stop" };
            }
            if (this.recoveryStopped(episode)) {
                generation.retire("owner_close");
                return { kind: "stop" };
            }
            if (generation.isRetired()) return { kind: "retry" };
            let selection: NegotiateResponse;
            try {
                selection = await this.negotiateTransport(generation, stage);
            } catch (error) {
                // Malformed negotiation and host-error terminals stop the episode; they are never fallback or retry evidence.
                generation.retire("negotiation_failed", error);
                return { kind: "stop" };
            }
            if (selection.kind === "tcp") {
                generation.retire("owner_close");
                // Repeated exact `unavailable` keeps the episode alive under its original deadline; a reasonless selection, legacy fallback, or other reason stops the episode.
                return { kind: selection.reason === "unavailable" ? "retry" : "stop" };
            }
            const bootstrap: ActiveConnection = {
                generation,
                token: newConnectionToken(),
                snapshot,
                liveRoutes: new Map(),
                transport: TRANSPORT_TCP,
                role: "shadow",
            };
            let conn: ActiveConnection;
            try {
                conn = await this.prepareCandidate(
                    bootstrap,
                    selection,
                    stage,
                    episode.shadowGenerations,
                );
            } catch {
                // Grant attachment, activation, and commit failures stop recovery.
                // `prepareCandidate` has already retired the source and candidate channels, releasing their shadow permits.
                return { kind: "stop" };
            }
            // The host replaces the bootstrap at commit; only the committed candidate reaches the promotion fence.
            generation.retire("owner_close");
            return { kind: "promote", conn };
        } finally {
            episode.shadowGenerations.delete(generation);
        }
    }

    /**
     * The promotion path publishes the shadow commit only while the exact source primary remains published and the predecessor slot is free; otherwise it retires the candidate.
     */
    private finishPromotion(episode: RecoveryEpisode, conn: ActiveConnection): void {
        episode.shadowGenerations.delete(conn.generation);
        if (
            this.recoveryStopped(episode) ||
            this.predecessor !== null ||
            conn.generation.isRetired()
        ) {
            conn.generation.retire("owner_close");
            return;
        }
        conn.role = undefined;
        this.predecessor = episode.source;
        this.active = conn;
        this.emitConnected(conn);
        this.maybeRetirePredecessor();
    }

    private onPendingDrained(conn: ActiveConnection): void {
        if (this.predecessor === conn) this.maybeRetirePredecessor();
    }

    /**
     * The client retires the draining predecessor only after pending work and live route handles reach zero.
     * Caller-owned raw handles keep the drain open until their explicit close.
     */
    private maybeRetirePredecessor(): void {
        const pred = this.predecessor;
        if (pred === null) return;
        if (pred.generation.isRetired()) {
            this.predecessor = null;
            return;
        }
        const stats = pred.generation.stats();
        if (stats.pendingRequests > 0) return;
        // The continuation may not yet have recorded the handle; keep the drain open until its completion re-invokes this check.
        if ((this.routeOpenCounts.get(pred) ?? 0) > 0) return;
        // A settled binary or stream terminal transfers its ReceiveLease to the caller; its storage aliases the channel until explicit release.
        // The drain remains open while live leases remain; each release re-invokes this check.
        if (stats.activeReceiveLeases > 0) return;
        for (const [channel, handle] of [...pred.liveRoutes]) {
            if (!this.managedHandles.has(handle)) continue;
            pred.liveRoutes.delete(channel);
            pred.generation.enqueueRouteGoodbye(handle.channel, handle.epoch);
            this.detachCachedHandle(handle);
        }
        if (pred.liveRoutes.size > 0) return;
        this.predecessor = null;
        const generation = pred.generation;
        generation.enqueueConnectionGoodbye();
        void generation
            .flushWrites(Deadline.start(this.shutdownDeadlineMs, this.clock))
            .catch(() => {})
            .finally(() => generation.retire("owner_close"));
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    /**
     * Wire Error terminals become a `terminal` McHostCallError with the canonical body's stable code.
     * A caller abort rejects with the cleanup ticket.
     * A post-write routed abort enqueues a correlation-scoped Cancel; channel 0 never receives Cancel.
     * A channel-0 caller abort retires the generation.
     */
    private async awaitRequest(
        generation: ConnectionGeneration,
        params: RequestParams,
    ): Promise<RequestTerminal> {
        // The daemon-binding gate runs before `generation.request` sends any bytes.
        this.assertExpectedDaemon(generation, params.options.expectedDaemonId);
        const signal = params.options.signal;
        const pending: PendingRequest = generation.request({
            channel: params.channel,
            epoch: params.epoch,
            body: params.body,
            deadline: params.deadline,
            mode: params.mode ?? "unary",
            ...(params.maxStreamItems === undefined
                ? {}
                : { maxStreamItems: params.maxStreamItems }),
            responseMode: params.responseMode,
            binary: params.binary,
            priority: params.options.priority,
            admissionClass: params.options.admissionClass,
        });
        let cleanup: Promise<void> | null = null;
        const onAbort = (): void => {
            cleanup = pending.abort().cleanup;
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const terminal = await pending.result;
            if (terminal.kind === "error") {
                const errorBody = requireJsonReceiveBody(terminal.body);
                const failure = terminalFromErrorBody(errorBody);
                if (params.captureErrorTerminal === true) {
                    failure.errorTerminal = {
                        bodyText: errorBody.text,
                        flags: terminal.flags,
                        // A stream frame before the terminal proves that the host produced response data, so it cannot establish a no-dispatch rejection.
                        // The terminal handler reads the arrival flag rather than `stream`: unary mode drains stream bodies privately and reports an empty array.
                        streamed: terminal.sawStream,
                    };
                }
                throw failure;
            }
            return terminal;
        } catch (error) {
            if (cleanup !== null && error instanceof McHostCallError) {
                if (error.kind === "outcome_unknown" && params.channel !== 0) {
                    generation.enqueueCancel(params.channel, params.epoch, pending.correlation);
                }
                error.cleanup = cleanup;
            }
            throw error;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }

    /* */
    private async controlRequest(
        active: ActiveConnection,
        bodyText: string,
        expectedOp: string,
        deadline: Deadline,
    ): Promise<Record<string, unknown>> {
        const body = Buffer.from(bodyText, "utf8");
        if (body.length > MAX_CONTROL_BODY_LEN) {
            throw new McHostCallError(
                "not_sent",
                `channel-0 control body of ${body.length} bytes exceeds the ${MAX_CONTROL_BODY_LEN}-byte cap`,
                "control_body_too_large",
            );
        }
        const terminal = await this.awaitRequest(active.generation, {
            channel: 0,
            epoch: 0,
            body,
            deadline,
            options: {},
        });
        const responseBody = requireJsonReceiveBody(terminal.body);
        const parsed = responseBody.valid ? responseBody.value : undefined;
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed) ||
            (parsed as { op?: unknown }).op !== expectedOp
        ) {
            throw new McHostCallError(
                "terminal",
                `control response was not a tagged ${expectedOp} object`,
                "malformed_control_response",
            );
        }
        this.emitDiagnostics({
            type: "parse",
            channel: 0,
            epoch: 0,
            len: responseBody.byteLength,
        });
        return parsed as Record<string, unknown>;
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private controlRouteOpen(
        active: ActiveConnection,
        target: RouteTarget,
        identity: BindIdentity,
        consumerIdentity: ConsumerIdentity | undefined,
        deadline: Deadline,
    ): Promise<RouteHandle> {
        const run = this.runRouteOpen(active, target, identity, consumerIdentity, deadline);
        const tracked = run.then(
            () => undefined,
            () => undefined,
        );
        this.pendingRouteOpens.add(tracked);
        this.routeOpenCounts.set(active, (this.routeOpenCounts.get(active) ?? 0) + 1);
        void tracked.finally(() => {
            this.pendingRouteOpens.delete(tracked);
            const remaining = (this.routeOpenCounts.get(active) ?? 1) - 1;
            if (remaining <= 0) this.routeOpenCounts.delete(active);
            else this.routeOpenCounts.set(active, remaining);
            // The settled continuation may release the last obligation holding a draining predecessor open, so the client re-evaluates the predecessor.
            if (this.predecessor === active) this.maybeRetirePredecessor();
        });
        return run;
    }

    private async runRouteOpen(
        active: ActiveConnection,
        target: RouteTarget,
        identity: BindIdentity,
        consumerIdentity: ConsumerIdentity | undefined,
        deadline: Deadline,
    ): Promise<RouteHandle> {
        const bodyText = routeOpenBody(target, identity, consumerIdentity);
        let parsed: Record<string, unknown>;
        try {
            parsed = await this.controlRequest(active, bodyText, "route.open", deadline);
        } catch (error) {
            // An ambiguous channel-0 `route.open` may have been sent but has no terminal or handle; because Cancel is illegal on channel 0, the client retires the generation before recovery.
            if (error instanceof McHostCallError && error.kind === "outcome_unknown") {
                active.generation.retire("ambiguous_route_open", error);
            }
            throw error;
        }
        const channel = parsed.route_channel;
        const epoch = parsed.route_epoch;
        let handle: RouteHandle;
        try {
            if (typeof channel !== "number" || typeof epoch !== "number") {
                throw new RangeError("route.open response carried no numeric route handle");
            }
            handle = createRouteHandle(channel, epoch, active.token);
        } catch (error) {
            throw new McHostCallError(
                "terminal",
                `route.open returned a malformed route handle${causeMessage(error)}`,
                "malformed_control_response",
                error,
            );
        }
        if (this.closeStarted) {
            // During an owner-close race, the client does not cache a late route and enqueues Goodbye best-effort because failed enqueue retires the generation internally.
            active.generation.enqueueRouteGoodbye(handle.channel, handle.epoch);
            throw new McHostCallError(
                "not_sent",
                "route was closed before route.open completed",
                "route_closed",
            );
        }
        active.liveRoutes.set(handle.channel, handle);
        return handle;
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private async managedRouteHandle(
        moduleId: string,
        options: ManagedCallOptions,
        deadline: Deadline,
    ): Promise<RouteHandle> {
        const baseIdentity = options.identity ?? this.defaultIdentity;
        if (!baseIdentity) {
            throw new McHostCallError(
                "terminal",
                "managed call requires a BindIdentity in McHostClient.connect({ identity }) or call(..., { identity })",
                "missing_identity",
            );
        }
        const identity = baseIdentity;
        const kind = options.targetKind ?? this.defaultTargetKind;
        const target = { kind, module_id: moduleId } as Extract<
            RouteTarget,
            { kind: ManagedRouteKind }
        >;
        const consumerIdentity = this.envConsumerIdentity();
        // The daemon-independent key ensures one logical binding owns one slot.
        // Generation retirement makes `isPrimaryLiveHandle` reject handles from the previous daemon.
        // `assertExpectedDaemon` fences publication after daemon rotation.
        // Keying by identity would strand one cache entry per daemon rotation.
        // Identity-based keys would let callers without a daemon expectation open a second route for the same target.
        const key = routeCacheKey(target, identity, consumerIdentity);
        // One immutable route-open stage per caller is derived once and kept through every join and replacement decision.
        const stage = deadline.stage(this.routeOpenDeadlineMs);
        const pace = makeReplacementPacer(stage, this.sleep);
        for (;;) {
            let cached = this.routes.get(key);
            if (!cached) {
                cached = {
                    target,
                    identity,
                    consumerIdentity,
                    handle: null,
                    opening: null,
                    closed: false,
                };
                this.routes.set(key, cached);
            }
            // Only the primary serves cached managed handles: a handle left on a draining predecessor is stale for new managed acquisitions even while raw callers still use it.
            if (cached.handle && this.isPrimaryLiveHandle(cached.handle)) {
                const active = this.active;
                // Without a live connection, the identity cannot be refreshed, so the cached handle remains authoritative for its channel.
                if (active === null) return cached.handle;
                const currentIdentity = this.identityForConnection(active, baseIdentity);
                if (
                    JSON.stringify(currentIdentity.credential_fingerprints ?? {}) ===
                    JSON.stringify(cached.identity.credential_fingerprints ?? {})
                ) {
                    return cached.handle;
                }
                active.liveRoutes.delete(cached.handle.channel);
                active.generation.enqueueRouteGoodbye(cached.handle.channel, cached.handle.epoch);
                cached.handle = null;
                cached.identity = currentIdentity;
            }
            let flight = cached.opening;
            let owner = false;
            if (!flight) {
                owner = true;
                const slot = cached;
                flight = makeSetupFlight(
                    (f) => this.openCachedRoute(slot, stage, f, options.expectedDaemonId),
                    (f) => {
                        if (slot.opening === f) slot.opening = null;
                    },
                );
                cached.opening = flight;
            }
            let handle: RouteHandle;
            try {
                // The owner awaits directly; a joiner races its own stage.
                handle = owner
                    ? await flight.promise
                    : await raceAgainstStage(flight.promise, stage, routeStageError);
            } catch (error) {
                if (owner || !flight.replaceable || stage.isExpired() || this.closeStarted) {
                    throw error;
                }
                continue;
            }
            // Before considering any body-replay token, stale-success handling adopts only the cache's current live handle for this route identity.
            if (
                this.routes.get(key) === cached &&
                cached.handle === handle &&
                this.isPrimaryLiveHandle(handle)
            ) {
                return handle;
            }
            if (stage.isExpired()) throw routeStageError();
            // The loop head adopts an installed live handle without new I/O.
            const current = this.routes.get(key);
            if (!(current?.handle && this.isPrimaryLiveHandle(current.handle))) {
                await pace();
                if (stage.isExpired()) throw routeStageError();
            }
        }
    }

    /**
     * The owner opens one cached managed route under a bounded route-open deadline.
     * Only allowlisted momentary `route.open` rejections retry with bounded backoff.
     * Transient connection failures reconnect.
     * application body is never sent before route success.
     */
    private async openCachedRoute(
        cached: CachedManagedRoute,
        deadline: Deadline,
        flight: SetupFlight<RouteHandle>,
        expectedDaemonId?: Uint8Array,
    ): Promise<RouteHandle> {
        let delayMs = SETUP_RETRY_BASE_MS;
        const backoff = async (): Promise<boolean> => {
            await this.sleep(deadline.stageBudgetMs(delayMs));
            delayMs = Math.min(delayMs * 2, SETUP_RETRY_CAP_MS);
            return !deadline.isExpired();
        };
        for (;;) {
            if (cached.closed || this.closeStarted) {
                throw new McHostCallError(
                    "not_sent",
                    "route was closed before route.open completed",
                    "route_closed",
                );
            }
            if (deadline.isExpired()) {
                // The owner's route-open budget determines when route opening fails.
                flight.replaceable = true;
                throw routeStageError();
            }
            let active: ActiveConnection;
            try {
                active = await this.ensureConnection(deadline, expectedDaemonId);
            } catch (error) {
                if (error instanceof McHostCallError) throw error;
                // A stage-expired snapshot reconnects under the clamped handshake budget; other `ConnectionFileError`s are terminal.
                // A snapshot that outlives its stage uses the clamped handshake budget, not the route budget, and reconnects as a transient setup failure.
                // Every other connection-file failure is terminal.
                const transient =
                    isConsumerReconnectTransient(error) ||
                    (error instanceof ConnectionFileError && error.code === "deadline_expired");
                if (transient && !this.closeStarted) {
                    if (await backoff()) continue;
                    // Transient reconnects continue until the owner's budget expires or a connection succeeds.
                    flight.replaceable = true;
                }
                throw new McHostCallError(
                    transient ? "not_sent" : "terminal",
                    `route.open could not run because connect failed${causeMessage(error)}`,
                    errorCode(error),
                    error,
                );
            }
            if (cached.handle && this.isPrimaryLiveHandle(cached.handle)) return cached.handle;
            cached.identity = this.identityForConnection(active, cached.identity);
            try {
                const handle = await this.controlRouteOpen(
                    active,
                    cached.target,
                    cached.identity,
                    cached.consumerIdentity,
                    deadline,
                );
                if (cached.closed) {
                    active.liveRoutes.delete(handle.channel);
                    active.generation.enqueueRouteGoodbye(handle.channel, handle.epoch);
                    throw new McHostCallError(
                        "not_sent",
                        "route was closed before route.open completed",
                        "route_closed",
                    );
                }
                cached.handle = handle;
                this.managedHandles.add(handle);
                return handle;
            } catch (error) {
                if (!isMcHostCallError(error)) {
                    throw new McHostCallError(
                        "terminal",
                        `route.open failed for module ${cached.target.module_id}${causeMessage(error)}`,
                        errorCode(error),
                        error,
                    );
                }
                if (error.code === "route_closed" || this.closeStarted) throw error;
                if (error.kind === "terminal" && isRetryableRouteOpenCode(error.code)) {
                    if (await backoff()) continue;
                    // The allowlisted retry budget is the owner's budget.
                    flight.replaceable = true;
                    throw new McHostCallError(
                        "not_sent",
                        `route.open failed for module ${cached.target.module_id}: ${error.code} (route-open retry budget exhausted)`,
                        error.code,
                        error,
                    );
                }
                if (error.kind === "not_sent" || error.kind === "outcome_unknown") {
                    // When `error.code` is `control_body_too_large`, retries and replacements cannot change the deterministic encoding failure.
                    if (error.code === "control_body_too_large") throw error;
                    // An `outcome_unknown` channel-0 `route.open` retires the generation because Cancel is illegal on channel 0 and no terminal or handle exists.
                    // next loop iteration reconnects under the same deadline.
                    if (await backoff()) continue;
                    // After the owner's route-open budget expires, remaining callers may coalesce on one replacement route.
                    flight.replaceable = true;
                    throw error;
                }
                throw error;
            }
        }
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private async runClose(): Promise<void> {
        const deadline = Deadline.start(this.shutdownDeadlineMs, this.clock);
        // Cancelling shadow publication before waiting for a connection prevents a racing commit from publishing and releases every shadow-connection permit.
        if (this.recovery !== null) this.cancelRecovery(this.recovery);
        if (this.connecting) {
            try {
                await this.connecting.promise;
            } catch {
                // A failed connect has nothing to tear down.
            }
        }
        if (this.pendingRouteOpens.size > 0) {
            let cancelWait: (() => void) | undefined;
            const wait = new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.max(0, deadline.remainingMs()));
                cancelWait = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            try {
                await Promise.race([Promise.all([...this.pendingRouteOpens]), wait]);
            } finally {
                cancelWait?.();
            }
        }
        const conns = [this.active, this.predecessor].filter(
            (conn): conn is ActiveConnection => conn !== null && !conn.generation.isRetired(),
        );
        for (const conn of conns) conn.generation.enqueueConnectionGoodbye();
        await Promise.all(conns.map((conn) => conn.generation.flushWrites(deadline)));
        for (const conn of conns) conn.generation.retire("owner_close");
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private emitDiagnostics(event: Omit<McHostDiagnosticsEvent, "atMs">): void {
        const observer = this.diagnostics;
        if (!observer) return;
        const now = Date.now();
        if (now - this.diagWindowStartMs >= 1_000) {
            this.diagWindowStartMs = now;
            this.diagWindowCount = 0;
        }
        this.diagWindowCount += 1;
        if (this.diagWindowCount > this.maxDiagnosticEventsPerSecond) return;
        try {
            observer(Object.freeze({ ...event, atMs: now }));
        } catch {
            // Observer exceptions must never affect protocol work.
        }
    }

    private envConsumerIdentity(): ConsumerIdentity | undefined {
        const moduleId = process.env[SUBC_MODULE_ID_ENV];
        const launchNonce = process.env[SUBC_LAUNCH_NONCE_ENV];
        if (!moduleId || !launchNonce) return undefined;
        return { module_id: moduleId, launch_nonce: launchNonce };
    }

    private identityForConnection(active: ActiveConnection, identity: BindIdentity): BindIdentity {
        if (
            this.credentialSource === undefined ||
            (identity.harness !== "opencode" && identity.harness !== "pi")
        ) {
            return identity;
        }
        const fingerprints = credentialFingerprints(
            active.snapshot.key,
            identity.harness,
            this.credentialSource,
        );
        return Object.keys(fingerprints).length === 0
            ? identity
            : { ...identity, credential_fingerprints: fingerprints };
    }
}

// ----------------------------------------------------------------------
// ----------------------------------------------------------------------

function encodeBody(body: unknown): DirectFrameBody {
    if (body instanceof Uint8Array) return bytesFrameBody(body);
    const text = JSON.stringify(body);
    if (text === undefined) throw new TypeError("request body is not JSON serializable");
    return utf8FrameBody(text);
}

/* */
function routeOpenBody(
    target: RouteTarget,
    identity: BindIdentity,
    consumerIdentity: ConsumerIdentity | undefined,
): string {
    const canonicalTarget =
        target.kind === "internal_service"
            ? { kind: target.kind, module_id: target.module_id, service_id: target.service_id }
            : { kind: target.kind, module_id: target.module_id };
    const canonicalIdentity = {
        project_root: identity.project_root,
        harness: identity.harness,
        session: identity.session,
        ...(identity.credential_fingerprints === undefined
            ? {}
            : { credential_fingerprints: identity.credential_fingerprints }),
    };
    return JSON.stringify(
        consumerIdentity
            ? {
                  op: "route.open",
                  target: canonicalTarget,
                  identity: canonicalIdentity,
                  consumer_identity: {
                      module_id: consumerIdentity.module_id,
                      launch_nonce: consumerIdentity.launch_nonce,
                  },
              }
            : { op: "route.open", target: canonicalTarget, identity: canonicalIdentity },
    );
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function requireJsonReceiveBody(body: RequestTerminal["body"]): JsonReceiveBody {
    if (body instanceof ReceiveLease) {
        // A quarantined release throws only after `onRelease` accounts for the outcome.
        // The method throws `unexpected_binary_response` only after `onRelease` accounts for the quarantined outcome.
        if (!body.isReleased()) {
            try {
                body.release();
            } catch {
                // `onRelease` must run before the throw so it accounts for quarantine.
            }
        }
        throw new McHostCallError(
            "terminal",
            "response body was unexpectedly binary",
            "unexpected_binary_response",
        );
    }
    return body;
}

/* */
function terminalFromErrorBody(body: JsonReceiveBody): McHostCallError {
    if (typeof body.value === "object" && body.value !== null && !Array.isArray(body.value)) {
        const parsed = body.value as {
            code?: unknown;
            message?: unknown;
            retry_after_ms?: unknown;
        };
        const code = typeof parsed.code === "string" ? parsed.code : undefined;
        const message = typeof parsed.message === "string" ? parsed.message : undefined;
        const error = new McHostCallError("terminal", message ?? "mc-host error", code);
        if (
            typeof parsed.retry_after_ms === "number" &&
            Number.isSafeInteger(parsed.retry_after_ms) &&
            parsed.retry_after_ms >= 0
        ) {
            error.retry_after_ms = parsed.retry_after_ms;
        }
        return error;
    }
    return new McHostCallError("terminal", body.text || "mc-host error");
}

function parseResponseJson<Response = JsonValue>(terminal: RequestTerminal): Response {
    const body = requireJsonReceiveBody(terminal.body);
    if (body.valid) return body.value as Response;
    throw new McHostCallError(
        "terminal",
        "response body was not valid JSON",
        "invalid_response_body",
    );
}

const MAX_CATALOG_MODULES = 64;
const MAX_CATALOG_OPS = 32;
const MAX_CATALOG_ROLES = 32;
const MAX_CATALOG_STRING_LEN = 128;
const OP_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function malformedCatalog(detail: string): McHostCallError {
    return new McHostCallError(
        "terminal",
        `catalog.list response rejected: ${detail}`,
        "malformed_control_response",
    );
}

function requireOpArray(value: unknown, field: string, allowEmpty: boolean): string[] {
    if (!Array.isArray(value)) throw malformedCatalog(`${field} is not an array`);
    if (!allowEmpty && value.length === 0) throw malformedCatalog(`${field} is empty`);
    if (value.length > MAX_CATALOG_OPS) throw malformedCatalog(`${field} exceeds the entry cap`);
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== "string" || !OP_NAME_PATTERN.test(entry)) {
            throw malformedCatalog(`${field} carries a non-operation entry`);
        }
        if (seen.has(entry)) throw malformedCatalog(`${field} carries a duplicate entry`);
        seen.add(entry);
    }
    return value as string[];
}

function parseHostStatusResponse(parsed: Record<string, unknown>): HostStatusSnapshot {
    const keys = Object.keys(parsed).sort();
    const expected = ["health", "metrics", "op"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new McHostCallError(
            "terminal",
            "host.status response rejected: unexpected shape",
            "malformed_control_response",
        );
    }
    if (parsed.op !== "host.status") {
        throw new McHostCallError(
            "terminal",
            "host.status response rejected: operation mismatch",
            "malformed_control_response",
        );
    }
    const health = parsed.health;
    if (health !== "ok" && health !== "degraded" && health !== "failing") {
        throw new McHostCallError(
            "terminal",
            "host.status response rejected: invalid health",
            "malformed_control_response",
        );
    }
    if (
        parsed.metrics === null ||
        typeof parsed.metrics !== "object" ||
        Array.isArray(parsed.metrics)
    ) {
        throw new McHostCallError(
            "terminal",
            "host.status response rejected: metrics are not an object",
            "malformed_control_response",
        );
    }
    return {
        health,
        metrics: parsed.metrics as Record<string, unknown>,
    };
}

/**
 * The decoder treats `catalog.list` as an open-shape control response: it ignores unknown fields but rejects missing, ill-typed, or out-of-bounds required fields.
 * The decoder rejects responses whose required exposed fields are absent, ill-typed, or out of bounds.
 */
function parseCatalogResponse(parsed: Record<string, unknown>): CatalogSnapshot {
    const generation = parsed.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
        throw malformedCatalog("generation is not a nonnegative integer");
    }
    const subcOps = requireOpArray(parsed.subc_ops, "subc_ops", false);
    const rawModules = parsed.modules;
    if (!Array.isArray(rawModules)) throw malformedCatalog("modules is not an array");
    if (rawModules.length > MAX_CATALOG_MODULES) {
        throw malformedCatalog("modules exceeds the entry cap");
    }
    const seenIds = new Set<string>();
    const modules: CatalogEntry[] = rawModules.map((raw) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw malformedCatalog("module entry is not an object");
        }
        const record = raw as Record<string, unknown>;
        const moduleId = record.module_id;
        if (
            typeof moduleId !== "string" ||
            moduleId.length === 0 ||
            moduleId.length > MAX_CATALOG_STRING_LEN
        ) {
            throw malformedCatalog("module_id is not a bounded nonempty string");
        }
        if (seenIds.has(moduleId)) throw malformedCatalog("duplicate module_id");
        seenIds.add(moduleId);
        const moduleVersion = record.module_version;
        if (
            typeof moduleVersion !== "string" ||
            moduleVersion.length === 0 ||
            moduleVersion.length > MAX_CATALOG_STRING_LEN
        ) {
            throw malformedCatalog("module_version is not a bounded nonempty string");
        }
        const roles = record.roles;
        if (!Array.isArray(roles) || roles.length > MAX_CATALOG_ROLES) {
            throw malformedCatalog("roles is not a bounded array");
        }
        const controlOps = requireOpArray(record.control_ops, "control_ops", true);
        return {
            module_id: moduleId,
            module_version: moduleVersion,
            roles,
            control_ops: controlOps,
        };
    });
    return { generation, subcOps, modules };
}

function wrapNegotiationError(error: unknown): Error {
    if (error instanceof NegotiationError) {
        return new McHostCallError(
            "terminal",
            `transport negotiation failed: ${error.message}`,
            "negotiation_failed",
            error,
        );
    }
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * Wire `Error` failures use a bounded error before retirement info or callers receive them; other failures retain `wrapNegotiationError` semantics.
 */
function boundedNegotiationFailure(error: unknown): Error {
    if (
        error instanceof McHostCallError &&
        error.kind === "terminal" &&
        error.errorTerminal !== undefined
    ) {
        return new McHostCallError(
            "terminal",
            "transport negotiation failed: host error terminal",
            "negotiation_failed",
        );
    }
    return wrapNegotiationError(error);
}

function toManagedCallError(error: unknown): McHostCallError {
    if (error instanceof McHostCallError) return error;
    if (error instanceof StaleRouteHandleError) {
        return new McHostCallError(
            "not_sent",
            `managed request used a stale route handle${causeMessage(error)}`,
            error.code,
            error,
        );
    }
    return new McHostCallError(
        "terminal",
        `managed call failed${causeMessage(error)}`,
        errorCode(error),
        error,
    );
}

function routeCacheKey(
    target: Extract<RouteTarget, { kind: ManagedRouteKind }>,
    identity: BindIdentity,
    consumerIdentity: ConsumerIdentity | undefined,
): string {
    const consumerPart = consumerIdentity
        ? `${consumerIdentity.module_id}\0${consumerIdentity.launch_nonce}`
        : "";
    const credentialPart = Object.entries(identity.credential_fingerprints ?? {})
        // Sort with UTF-16 code-unit comparison so the key does not depend on runtime collation.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([provider, fingerprint]) => `${provider}:${fingerprint}`)
        .join(",");
    return `${target.kind}\0${target.module_id}\0${identity.project_root}\0${identity.harness}\0${identity.session}\0${credentialPart}\0${consumerPart}`;
}
