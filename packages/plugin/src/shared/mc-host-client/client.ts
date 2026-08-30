/**
 * Thin routed and managed consumer facade over the connection-generation
 * engine.
 *
 * `McHostClient` owns connection coalescing (single-flight connect), reconnect
 * after generation retirement (reread the connection file plus full reauth),
 * the managed-route cache, control-plane response validation, and bounded
 * redacted diagnostics. The generation layer below never imports this file.
 *
 * Replay ownership: raw `request()` never replays a body. Managed
 * `call()` owns exactly one replay token per call, spendable only on a
 * proven `not_sent` or a terminal `unknown_channel` (route evicted first),
 * only while the caller is active and the operation deadline is live.
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

/** Preserves the repo's current 2-second TypeScript handshake budget. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
/** Matches npm subc-client 0.4.1 `DEFAULT_REQUEST_TIMEOUT_MS`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** One bounded route-open deadline shared by the whole managed retry loop. */
const DEFAULT_ROUTE_OPEN_DEADLINE_MS = 30_000;
/** Separate bounded shutdown deadline for route and connection Goodbye. */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
export const DEFAULT_RECOVERY_DEADLINE_MS = 30_000;
/** Channel-0 control bodies are capped below the frame limit (wire doc 7.1). */
const MAX_CONTROL_BODY_LEN = 65_536;
/**
 * Escalating retry schedule shared by the allowlisted route.open retry
 * backoff and the stale-success replacement pacing in both setup loops.
 */
const SETUP_RETRY_BASE_MS = 100;
const SETUP_RETRY_CAP_MS = 2_000;
const DEFAULT_MAX_DIAGNOSTIC_EVENTS_PER_SECOND = 500;
const MAX_DIAGNOSTIC_STRING_LEN = 128;

export const SUBC_MODULE_ID_ENV = "SUBC_MODULE_ID";
export const SUBC_LAUNCH_NONCE_ENV = "SUBC_LAUNCH_NONCE";

const DEFAULT_MANAGED_TARGET_KIND: ManagedRouteKind = "management_surface";

/**
 * One immutable, redacted diagnostics snapshot (KTD12): frame identity,
 * byte counts, and connection metadata only — never key, proof, nonce,
 * body bytes, or full bind identity.
 */
export interface McHostDiagnosticsEvent {
    readonly type: ConnectionDiagnosticEvent["type"] | "connected" | "parse" | "retired";
    /** Wall-clock milliseconds assigned at emission. */
    readonly atMs: number;
    readonly frameType?: number;
    readonly channel?: number;
    readonly epoch?: number;
    readonly corr?: bigint;
    readonly len?: number;
    readonly daemonVer?: string;
    readonly pid?: number;
    readonly reason?: string;
    /** Negotiated transport name on `connected` events. */
    readonly transport?: string;
    /** Closed-set TCP fallback reason on `connected` events, if any. */
    readonly fallbackReason?: FallbackReason;
}

export type McHostDiagnosticsObserver = (event: McHostDiagnosticsEvent) => void;

/**
 * Facade construction options. `ConnectOptions` is the consumer surface;
 * the rest are bounded policy knobs and injectable test seams.
 */
export interface McHostClientOptions extends ConnectOptions {
    /** Injectable monotonic clock for every operation deadline. */
    clock?: MonotonicClock;
    /** Injectable backoff sleep for deterministic retry tests. */
    sleep?: (ms: number) => Promise<void>;
    requestTimeoutMs?: number;
    routeOpenDeadlineMs?: number;
    shutdownDeadlineMs?: number;
    /**
     * Test seam forwarded to the connection-file read's `afterOpen` hook;
     * lets tests race a snapshot against deadlines deterministically.
     * @internal Not part of the consumer contract.
     */
    connectionFileAfterOpen?: () => void | Promise<void>;
    /**
     * Read-only diagnostics observer (KTD12). Events are frozen, size- and
     * rate-bounded, and redacted; observer exceptions are swallowed and
     * excess events are dropped rather than blocking protocol work.
     */
    diagnostics?: McHostDiagnosticsObserver;
    maxDiagnosticEventsPerSecond?: number;
    /** Bounded generation-policy overrides for tests (queue caps, deadlines). */
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
    /** Opaque token binding this connection's route handles. */
    readonly token: object;
    readonly snapshot: ConnectionSnapshot;
    readonly liveRoutes: Map<number, RouteHandle>;
    /** The selected transport remains fixed from publication until retirement. */
    transport: string;
    /** Closed-set reason when the selection was an explicit TCP fallback. */
    fallbackReason?: FallbackReason;
    role?: "shadow";
}

/**
 * One client-wide re-upgrade episode: fenced to the exact source primary, bounded by one immutable deadline, and cancellable so owner close and primary retirement release every shadow connection permit (KTD5-KTD7).
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
     * Set by `closeRoute` while an open is in flight; the open must not
     * install its handle and instead sends best-effort route Goodbye.
     */
    closed: boolean;
}

/**
 * One shared setup operation (a connect or a managed route open) with
 * explicit replacement eligibility (KTD1). The creator awaits `promise`
 * directly; a joiner races it against its own stage deadline. `replaceable`
 * turns true only at the exact owner-budget-exhaustion exits (KTD3), so a
 * surviving joiner may coalesce one replacement; permanent failures and
 * close outcomes leave it false.
 */
interface SetupFlight<T> {
    promise: Promise<T>;
    replaceable: boolean;
}

/**
 * Race a shared flight against the caller's own stage deadline (KTD2). The
 * rejection implies `stage.isExpired()`: `armExpiryTimer` re-arms until the
 * clock provably crosses the end, and a fulfillment that settles after
 * expiry is rejected rather than adopted. `flight` has a creation-time
 * rejection observer, preventing unhandled rejections when a caller
 * abandons it after losing the race.
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
        // The stage is authoritative over timer delivery order on both
        // branches: a settlement queued ahead of an overdue timer callback
        // must not let the caller adopt setup that exceeded its own stage
        // budget, nor report the shared flight's failure as its own.
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
 * Escalating bounded pacer for the stale-success re-entry (KTD4
 * fall-through) in a setup loop. A stale success settles without consuming
 * the caller's budget, so an unpaced re-entry would replace flights at
 * socket speed while the daemon keeps retiring fresh setup (for example a
 * Goodbye coalesced into the same read chunk as the final setup bytes).
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
 * `clearSlot` receives this flight's identity on settlement, so an old
 * flight never clears a newer one (KTD1). Two-phase construction is safe:
 * `promise` is assigned before anything can read it, since `run` only
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
    /** Retained-item ceiling for a stream-mode request. */
    maxStreamItems?: number;
    binary?: boolean;
    /**
     * Retain the raw wire Error terminal on the thrown failure. Only the
     * negotiation family needs it (legacy-fallback classification reads the
     * exact bytes); every other request leaves it off so a peer-controlled
     * body — up to the frame limit — is not held alive by a caller's error
     * outside the channel's released reader charge.
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
 * The closed set of route.open rejection codes meaning "the target is
 * momentarily unavailable but a later route.open could succeed" (wire doc
 * 10.2). A rejected route.open is provably pre-send for the application
 * body, so retrying it never risks a duplicate dispatch.
 */
function isRetryableRouteOpenCode(code: string | undefined): boolean {
    return (
        code === "unknown_module" ||
        code === "module_reloading" ||
        code === "target_unavailable" ||
        code === "module_timeout"
    );
}

/** True when the connection file exists; parity with npm subc-client 0.4.1. */
export async function connectionFileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Reconnect-transience classification, semantics-compatible with npm
 * subc-client 0.4.1. Recognition works cross-bundle by error `name` and
 * `kind`/`code` shape, not only `instanceof`.
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
 * Shadow recovery retries only discovery and dial failures; authentication
 * and protocol failures stop the episode permanently. Recognition is
 * name/code-based so a different bundled copy of an error class still
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
 * The consumer-facing client: connect, route open, raw request, managed
 * call, catalog, and bounded close over one active connection generation.
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
    /** Draining generation slot; occupied from promotion until drain completes (KTD7). */
    private predecessor: ActiveConnection | null = null;
    /** At most one client-wide recovery episode (KTD5). */
    private recovery: RecoveryEpisode | null = null;
    /** RouteHandles opened by the managed-route cache, not caller-owned raw handles; the drain closes orphaned managed handles at pending-zero while raw handles wait for their caller's explicit close (R10). */
    private readonly managedHandles = new WeakSet<RouteHandle>();
    private readonly routes = new Map<string, CachedManagedRoute>();
    /** In-flight route.open attempts, drained bounded during owner close. */
    private readonly pendingRouteOpens = new Set<Promise<void>>();
    /**
     * In-flight route.open attempts per connection. A route.open terminal
     * empties the pending set BEFORE its awaiting continuation inserts the
     * new handle into `liveRoutes`, so a pending-zero retirement check
     * alone would retire a draining predecessor between those two steps
     * and hand the caller an immediately-stale handle.
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
     * Read the connection file, dial, and authenticate under one handshake
     * deadline, then return the ready client.
     */
    static async connect(options: McHostClientOptions): Promise<McHostClient> {
        const client = new McHostClient(options);
        await client.ensureConnection(Deadline.start(client.handshakeTimeoutMs, client.clock));
        return client;
    }

    /** The daemon version reported by the current connection, if any. */
    get daemonVer(): string | null {
        return this.active?.snapshot.daemonVer ?? null;
    }

    /**
     * Handshake-retained peer identity for the current connection, or null
     * when no authenticated generation is live. Lifecycle policy must use
     * this, never {@link publication}, for compatibility and fencing.
     */
    get authenticated(): AuthenticatedPeer | null {
        const active = this.active;
        if (!active || active.generation.isRetired()) return null;
        const daemonVer = active.generation.daemonVer;
        const daemonId = active.generation.authenticatedDaemonId;
        if (daemonVer === null || daemonId === null) return null;
        return {
            daemonVer,
            // Copied, like every other crossing of this value (`auth.ts`,
            // `transport-provider.ts`): callers must not be able to mutate the
            // retained identity that authorizes compatibility and fencing.
            daemonId: daemonId.slice(),
            proof: "current",
        };
    }

    /**
     * Connection-file `daemon_ver`/`pid` for the current connection, or null.
     * Untrusted display metadata only: it must never authorize
     * compatibility, shutdown, or cleanup.
     */
    get publication(): PublicationDiagnostics | null {
        const active = this.active;
        if (!active) return null;
        return { daemonVer: active.snapshot.daemonVer, pid: active.snapshot.pid };
    }

    /**
     * Open a route and return its connection-bound immutable handle. One
     * attempt under one bounded deadline; retry policy belongs to owners
     * above (managed `call()` owns its own allowlisted retry loop).
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
     * Send one routed request on exactly the supplied route generation and
     * return the JSON-parsed response body. Never replays the body.
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
     * Collect one bounded JSON stream through StreamEnd, preserving item order.
     * The stream is bounded by both the connection's pending byte budget and a
     * retained-item ceiling, so a peer cannot make the client hold unbounded
     * per-item decode overhead under the byte budget alone.
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
     * Managed route + request convenience: opens and caches a route keyed by
     * (target kind, module id, identity, consumer identity), reconnecting
     * and reopening after retirement. Sends `{method, params}` and returns
     * the JSON-parsed response. Owns exactly one body-replay token.
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
                    // The host proved no dispatch; evict the dead route and
                    // spend the one token on a fresh-route retry (KTD8).
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

    /** List catalog entries through a validated tagged `catalog.list`. */
    async catalogList(options: { timeoutMs?: number } = {}): Promise<CatalogEntry[]> {
        return (await this.catalogSnapshot(options)).modules;
    }

    /**
     * One strictly validated `catalog.list`: tagged generation, closed-shape
     * host `subc_ops`, and per-module id/version/roles/control_ops. Any
     * duplicate, missing field, or out-of-bounds value is a terminal
     * `malformed_control_response` — never a cast.
     *
     * Unknown fields are *ignored*, not rejected: wire doc §7.1 makes forward
     * compatibility the rule for this family, so a newer daemon adding a field
     * must not strand an older client. The negotiation family (§7.7.1) is the
     * one closed-shape exception and is validated elsewhere.
     *
     * `timeoutMs` overrides the client-wide request timeout so a caller holding
     * an aggregate deadline can spend only the time it has left here instead of
     * starting a fresh full-length request budget.
     */
    async catalogSnapshot(options: { timeoutMs?: number } = {}): Promise<CatalogSnapshot> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "catalog.list" });
        const parsed = await this.controlRequest(active, bodyText, "catalog.list", deadline);
        return parseCatalogResponse(parsed);
    }

    /**
     * Bounded authenticated `host.shutdown`. Resolves only after the host's
     * correlated success response is fully received — the caller-observable
     * stop-commit point. Never called by `close()`/`closeAsync()`; ordinary
     * client close remains connection teardown only.
     */
    async hostShutdown(options: { timeoutMs?: number } = {}): Promise<void> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "host.shutdown" });
        await this.controlRequest(active, bodyText, "host.shutdown", deadline);
    }

    /** Read host-owned component readiness without opening a routed module. */
    async hostStatus(options: { timeoutMs?: number } = {}): Promise<HostStatusSnapshot> {
        const deadline = Deadline.start(options.timeoutMs ?? this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "host.status" });
        const parsed = await this.controlRequest(active, bodyText, "host.status", deadline);
        return parseHostStatusResponse(parsed);
    }

    /**
     * Tear down exactly the supplied route generation: evict caches, send
     * route Goodbye, and await the write bounded by the shutdown deadline.
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
     * Synchronous close for existing callers: fires the bounded async
     * teardown and returns immediately. New code should prefer
     * `closeAsync()`.
     */
    close(): void {
        void this.closeAsync();
    }

    /**
     * Awaitable owner close under one bounded shutdown deadline: drain
     * in-flight route.open attempts (so a late success becomes route
     * Goodbye instead of a cached route), send connection Goodbye
     * best-effort, flush, then retire the generation. Idempotent.
     */
    closeAsync(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closeStarted = true;
        this.closePromise = this.runClose();
        return this.closePromise;
    }

    // ------------------------------------------------------------------
    // Connection ownership: single-flight connect and retirement reaction.
    // ------------------------------------------------------------------

    private async ensureConnection(
        deadline: Deadline,
        expectedDaemonId?: Uint8Array,
    ): Promise<ActiveConnection> {
        // R1: one immutable handshake stage per caller, derived once from its
        // own operation deadline and kept through every join and replacement.
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
                // KTD2: the owner awaits its bounded operation directly to keep
                // existing error and retirement behavior; a joiner races the
                // shared flight against its own stage.
                conn = owner
                    ? await flight.promise
                    : await raceAgainstStage(flight.promise, stage, connectionStageError);
            } catch (error) {
                // A joiner whose own stage expired detaches without mutating
                // the shared flight (R2). Only owner-budget exhaustion of a
                // joined flight authorizes one coalesced replacement (R3).
                if (owner || !flight.replaceable || stage.isExpired() || this.closeStarted) {
                    throw error;
                }
                continue;
            }
            // KTD4: adopt only a still-current, non-retired generation; a
            // stale success re-enters recovery under the unchanged stage.
            if (this.active === conn && !conn.generation.isRetired()) {
                this.assertExpectedDaemon(conn.generation, expectedDaemonId);
                return conn;
            }
            if (stage.isExpired()) throw connectionStageError();
            // Pace the replacement dial unless a live candidate is already
            // installed (the loop head adopts it without new I/O).
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
        // Reconnect rereads the file and reauthenticates from scratch (wire
        // doc Section 12); credentials are never cached across generations.
        let snapshot: ConnectionSnapshot;
        try {
            snapshot = await readConnectionFile(this.connectionFile, {
                deadline: stage,
                afterOpen: this.connectionFileAfterOpen,
            });
        } catch (error) {
            // KTD3: the connection-file stage budget is the failure authority.
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
            // Skip per-frame event allocation entirely when no observer is
            // configured; the generation's hook check short-circuits on
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
            // KTD3: only the setup-deadline retirement is an owner-budget
            // exit; auth, socket, and protocol failures never authorize a
            // replacement.
            if (retiredReason === "setup_deadline") flight.replaceable = true;
            throw error;
        }
        if (this.closeStarted) {
            generation.retire("owner_close");
            throw new McHostClientError("client closed", "client_closed");
        }
        // KTD4 stale-success: a generation that retired during its own setup
        // (for example a Goodbye coalesced into the final handshake chunk)
        // skips negotiation; ensureConnection re-enters recovery under the
        // caller's unchanged stage.
        if (generation.isRetired()) return conn;
        // R5/KTD5: negotiate on authenticated channel 0 BEFORE publication,
        // so no caller can observe a generation without a selection.
        let selection: NegotiateResponse;
        try {
            selection = await this.negotiateTransport(generation, stage);
        } catch (error) {
            generation.retire("negotiation_failed", error);
            // KTD3: negotiation that died on the owner's setup stage is
            // owner-budget exhaustion; survivors may coalesce one
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
                // KTD3: activation that died on the owner's setup stage is
                // owner-budget exhaustion, exactly like the earlier stages;
                // survivors may coalesce one replacement.
                if (stage.isExpired()) flight.replaceable = true;
                throw error;
            }
        }
        // The authenticated bootstrap becomes the finalized generation with
        // its negotiation correlation consumed; the selection stays sticky
        // until retirement (KTD5).
        // KTD4 stale-success: the frame pump can retire the generation in
        // the same batch that resolved the negotiation (a coalesced Goodbye
        // or EOF). A dead generation must not be published or reported
        // connected; the returned stale conn re-enters recovery in
        // ensureConnection like the pre-negotiation stale-success path.
        if (generation.isRetired()) return conn;
        conn.fallbackReason = selection.reason;
        this.active = conn;
        this.emitConnected(conn, conn.fallbackReason);
        // R11: exact `unavailable` is the only fallback that starts an automatic shared-memory recovery probe; every other reason and reasonless TCP stay sticky.
        if (conn.fallbackReason === "unavailable") this.startRecovery(conn);
        return conn;
    }

    /**
     * Send the versioned offer as the generation's first channel-0 request.
     * Only a strictly decoded selection continues; every failure — including
     * any wire Error terminal — propagates so setup fails closed without
     * same-generation TCP fallback (KTD7).
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
                // Every Error terminal fails closed with a bounded error:
                // the raw body is peer-controlled and its message must not
                // enter caller-visible error graphs (R14). There is no
                // `unsupported_operation` continuation. The distinct code
                // makes version skew self-describing: a host that does not
                // implement `transport.negotiate` answers this request with
                // an Error terminal.
                throw new McHostCallError(
                    "terminal",
                    "transport negotiation failed: host returned an error terminal (host may predate transport negotiation; restart or upgrade the mc-host daemon)",
                    "host_negotiation_rejected",
                );
            }
            throw error;
        }
        try {
            // Strict decode against the sent offers: an unoffered selection
            // or any version/field violation is malformed, never fallback
            // evidence (R12). Negotiation-family responses must be UTF-8
            // JSON with `binary = 0`.
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
     * KTD4 activate-then-commit barrier over one injected provider
     * candidate: activation at candidate correlation 1 consumes the one-use
     * token, commit at correlation 2 finalizes, and only then is the
     * candidate generation published — with its application correlation
     * allocator already at 3 — while the bootstrap retires. Any failure or
     * uncertainty closes BOTH channels without TCP continuation (R12).
     */
    private async activateCandidate(
        bootstrap: ActiveConnection,
        grant: Extract<NegotiateResponse, { kind: "grant" }>,
        stage: Deadline,
    ): Promise<ActiveConnection> {
        const conn = await this.prepareCandidate(bootstrap, grant, stage);
        // Atomic promotion: publish the finalized candidate, then retire the
        // bootstrap; the host already replaced it after the commit response
        // reached local completion.
        this.active = conn;
        bootstrap.generation.retire("owner_close");
        this.emitConnected(conn);
        return conn;
    }

    /**
     * Run one grant through candidate construction, activation, and commit
     * without publishing. Any failure or uncertainty retires BOTH the
     * candidate and the bootstrap. A shadow caller passes its episode's
     * `shadow` generation set so the candidate's retirement callbacks stay
     * episode-internal until promotion clears the role.
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
            // Unreachable through the decoder (a selection must name a sent
            // offer), kept as a fail-closed guard.
            const failure = new McHostCallError(
                "terminal",
                "host granted a transport with no installed provider",
                "negotiation_failed",
            );
            bootstrap.generation.retire("negotiation_failed", failure);
            throw failure;
        }
        const snapshot = bootstrap.snapshot;
        // A candidate channel performs no handshake: its authority is the
        // bootstrap's, carried across the activate-then-commit barrier. The
        // identity is read here, before the candidate exists, so the candidate
        // inherits it instead of adopting whatever its channel reports.
        const inheritedDaemonVer = bootstrap.generation.daemonVer;
        const inheritedDaemonId = bootstrap.generation.authenticatedDaemonId;
        if (inheritedDaemonVer === null || inheritedDaemonId === null) {
            // The bootstrap authenticates before it can negotiate, so this is
            // unreachable; kept as a fail-closed guard because promotion off an
            // unauthenticated generation would publish an identity that nothing
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
            // The generation constructor invokes the channel factory — and
            // therefore the provider's `connect()` — synchronously, so a
            // throwing provider surfaces here, before the activation `try`
            // below exists to retire the channels.
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
                    // The provider gets its own copy: a provider that retains
                    // and mutates the array must not reach the identity this
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
            // Negotiation-family responses must be UTF-8 JSON with
            // `binary = 0`; a mismatched flag is malformed, never
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
            // Drain completion (or a failed predecessor) is internal handoff
            // traffic under a live primary, never a client-level `retired`.
            this.predecessor = null;
            return;
        }
        if (this.active === conn) {
            this.active = null;
            for (const cached of this.routes.values()) {
                cached.handle = null;
            }
            // The episode is fenced to this exact source primary (KTD6);
            // cancel it so in-flight shadow permits are released promptly.
            if (this.recovery !== null && this.recovery.source === conn) {
                this.cancelRecovery(this.recovery);
            }
        } else if (this.active !== null) {
            // A non-active generation retiring while another connection is
            // published is internal handoff traffic — the bootstrap retiring
            // under a freshly promoted candidate. Emitting `retired` here
            // would interleave a spurious client-level event with the
            // candidate's `connected`. Setup failures still emit: no
            // connection is published while a setup flight runs.
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

    /** The live connection owning `handle`: the primary or the draining predecessor. */
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
     * Managed-route cache eligibility: only the primary may serve a cached
     * managed handle, so new managed acquisitions never land on a draining
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
     * `closeRoute` uses the returned keys to mark and evict every cached
     * entry for `handle`; the other callers only need the detach.
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
    // Fresh-generation TCP-to-shared-memory re-upgrade (R9-R11).
    // ------------------------------------------------------------------

    /**
     * Begin one client-wide recovery episode fenced to `source`. Only an
     * exact `unavailable` TCP fallback reaches this point; the deadline is
     * created once here and never reset by any retry (KTD5).
     */
    private startRecovery(source: ActiveConnection): void {
        if (this.closeStarted) return;
        const prior = this.recovery;
        // A prior episode is fenced to a superseded primary; cancel it so
        // its shadow permits are released before the new episode dials.
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
            // An occupied predecessor slot defers the whole attempt: wait
            // without creating a candidate so no third generation and no
            // extra connection permit exist while two are still draining.
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
     * One full fresh setup attempt: reread the connection file, dial,
     * authenticate, negotiate, and — on a grant — activate and commit,
     * all bounded by the episode deadline. Retries only discovery/dial
     * transients and repeated exact `unavailable`; every other outcome
     * stops the episode permanently (KTD6).
     */
    private async shadowAttempt(episode: RecoveryEpisode): Promise<ShadowOutcome> {
        const stage = episode.deadline.stage(this.handshakeTimeoutMs);
        let snapshot: ConnectionSnapshot;
        try {
            snapshot = await readConnectionFile(this.connectionFile, {
                deadline: stage,
            });
        } catch (error) {
            // Only discovery churn retries: a daemon rewriting its
            // connection file mid-restart surfaces as a briefly missing
            // file, a replaced-during-read race, or an expired stage (the
            // loop's episode deadline bounds repeats). Every other
            // connection-file failure — permissions, ownership, malformed
            // content — is permanent validation evidence and stops the
            // episode, matching the reconnect path's terminal
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
                // Malformed negotiation and host error terminals stop the
                // episode; they are never fallback or retry evidence.
                generation.retire("negotiation_failed", error);
                return { kind: "stop" };
            }
            if (selection.kind === "tcp") {
                generation.retire("owner_close");
                // Repeated exact `unavailable` keeps the episode alive under
                // its ORIGINAL deadline; a reasonless selection, a legacy
                // fallback, and every other reason stop it permanently.
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
                // Grant attachment, activation, and commit failures stop
                // recovery; prepareCandidate already retired both channels,
                // releasing the shadow permits.
                return { kind: "stop" };
            }
            // The host replaced the bootstrap at commit; only the committed
            // candidate survives to the promotion fence.
            generation.retire("owner_close");
            return { kind: "promote", conn };
        } finally {
            episode.shadowGenerations.delete(generation);
        }
    }

    /**
     * Source-fenced publication: the shadow commit becomes the primary only
     * while the exact source primary is still published and the predecessor
     * slot is free; any other state retires the candidate instead (KTD6).
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
     * Retire the draining predecessor once no pending work AND no live
     * route handles remain on it. Orphaned managed-cache routes close at
     * pending-zero; caller-owned raw handles keep the drain open until
     * their explicit close (R10).
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
        // A route.open whose terminal already settled but whose awaiting
        // continuation has not yet recorded the handle keeps the drain
        // open; the continuation's completion re-invokes this check.
        if ((this.routeOpenCounts.get(pred) ?? 0) > 0) return;
        // A settled binary or stream terminal hands its ReceiveLease to the
        // caller, whose storage aliases the channel until an explicit
        // release; retirement force-releases every lease, so a drain with
        // live leases stays open and each release re-invokes this check.
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
    // Requests: one pending entry, caller abort, terminal classification.
    // ------------------------------------------------------------------

    /**
     * Run one request to its terminal. A wire Error terminal becomes a
     * `terminal` McHostCallError with the canonical body's stable code. On a
     * caller abort, the rejection carries the cleanup ticket, and a
     * post-write routed abort enqueues a correlation-scoped Cancel; channel
     * 0 never sees Cancel (KTD9 handles it by retirement in the caller).
     */
    private async awaitRequest(
        generation: ConnectionGeneration,
        params: RequestParams,
    ): Promise<RequestTerminal> {
        // The one publication choke point every request-shaped method passes
        // through: the daemon-binding gate runs here, before any byte is
        // enqueued, so no publisher can forget it.
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
                        // A stream frame ahead of the terminal means the
                        // host produced response data, which cannot prove a
                        // no-dispatch rejection. Read the arrival flag, not
                        // `stream`: unary mode drains stream bodies
                        // privately and always reports an empty array.
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

    /** Send one channel-0 control request and validate the tagged response. */
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
    // Route opening: validation, close races, and ambiguous-open handling.
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
            // The settled continuation may have been the last obligation
            // holding a draining predecessor open (its handle is in
            // `liveRoutes` now, or the attempt failed): re-evaluate.
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
            // KTD9: an ambiguous channel-0 route.open (possible send, no
            // terminal) has no handle and Cancel is illegal on channel 0,
            // so retire the generation before any recovery.
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
            // KTD9 owner-close race: never cache the late route; best-effort
            // Goodbye (a failed enqueue retires the generation internally).
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
    // Managed route cache and its bounded allowlisted retry loop.
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
        // The key stays daemon-independent so one logical binding owns one slot:
        // a rotation retires the generation, so `isPrimaryLiveHandle` already
        // refuses a handle from the previous daemon, and `assertExpectedDaemon`
        // fences publication. Keying by identity instead would strand one entry
        // per rotation and let a caller without an expectation open a second
        // concurrent route for the same target.
        const key = routeCacheKey(target, identity, consumerIdentity);
        // R1: one immutable route-open stage per caller, derived once and
        // kept through every join and replacement decision.
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
            // Only the primary serves cached managed handles: a handle left on a draining predecessor is stale for NEW managed acquisitions even while raw callers still use it (R10).
            if (cached.handle && this.isPrimaryLiveHandle(cached.handle)) {
                const active = this.active;
                // Without a live connection the identity cannot be refreshed;
                // the cached handle stays authoritative for its channel.
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
                // KTD2: owner awaits directly; a joiner races its own stage.
                handle = owner
                    ? await flight.promise
                    : await raceAgainstStage(flight.promise, stage, routeStageError);
            } catch (error) {
                if (owner || !flight.replaceable || stage.isExpired() || this.closeStarted) {
                    throw error;
                }
                continue;
            }
            // KTD4: adopt only the cache's current live handle for this route
            // identity; a stale success recovers here, before any body-replay
            // token is considered.
            if (
                this.routes.get(key) === cached &&
                cached.handle === handle &&
                this.isPrimaryLiveHandle(handle)
            ) {
                return handle;
            }
            if (stage.isExpired()) throw routeStageError();
            // Pace the replacement open unless a live handle is already
            // installed (the loop head adopts it without new I/O).
            const current = this.routes.get(key);
            if (!(current?.handle && this.isPrimaryLiveHandle(current.handle))) {
                await pace();
                if (stage.isExpired()) throw routeStageError();
            }
        }
    }

    /**
     * Open one cached managed route under one bounded route-open deadline.
     * Only the allowlisted momentary route.open rejections retry (with
     * bounded backoff); transient connection failures reconnect; the
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
                // KTD3: the owner's route-open budget is the failure authority.
                flight.replaceable = true;
                throw routeStageError();
            }
            let active: ActiveConnection;
            try {
                active = await this.ensureConnection(deadline, expectedDaemonId);
            } catch (error) {
                if (error instanceof McHostCallError) throw error;
                // KTD3: a snapshot that outlives its stage names the clamped
                // handshake budget, not the route budget, so it reconnects
                // like any transient setup failure; every other
                // connection-file failure stays terminal.
                const transient =
                    isConsumerReconnectTransient(error) ||
                    (error instanceof ConnectionFileError && error.code === "deadline_expired");
                if (transient && !this.closeStarted) {
                    if (await backoff()) continue;
                    // KTD3: transient reconnects ended only because the
                    // owner's budget ran out.
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
                    // KTD3: the allowlisted retry budget is owner budget.
                    flight.replaceable = true;
                    throw new McHostCallError(
                        "not_sent",
                        `route.open failed for module ${cached.target.module_id}: ${error.code} (route-open retry budget exhausted)`,
                        error.code,
                        error,
                    );
                }
                if (error.kind === "not_sent" || error.kind === "outcome_unknown") {
                    // A local encode rejection is deterministic: the same
                    // oversized control body fails every attempt, so neither
                    // retry nor replacement can change the outcome.
                    if (error.code === "control_body_too_large") throw error;
                    // An ambiguous open already retired its generation; the
                    // next loop iteration reconnects under the same deadline.
                    if (await backoff()) continue;
                    // KTD3: this transient surfaced only because the owner's
                    // budget ran out; survivors may coalesce one replacement.
                    flight.replaceable = true;
                    throw error;
                }
                throw error;
            }
        }
    }

    // ------------------------------------------------------------------
    // Bounded owner close.
    // ------------------------------------------------------------------

    private async runClose(): Promise<void> {
        const deadline = Deadline.start(this.shutdownDeadlineMs, this.clock);
        // Cancel shadow publication FIRST: a commit racing owner close must not publish, and every shadow connection permit is released (R11).
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
        // Primary and predecessor close under the same bounded deadline.
        const conns = [this.active, this.predecessor].filter(
            (conn): conn is ActiveConnection => conn !== null && !conn.generation.isRetired(),
        );
        for (const conn of conns) conn.generation.enqueueConnectionGoodbye();
        await Promise.all(conns.map((conn) => conn.generation.flushWrites(deadline)));
        for (const conn of conns) conn.generation.retire("owner_close");
    }

    // ------------------------------------------------------------------
    // Bounded, redacted diagnostics.
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
            // Observer exceptions must never affect protocol work (KTD12).
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
// Body encoding and terminal classification helpers.
// ----------------------------------------------------------------------

function encodeBody(body: unknown): DirectFrameBody {
    if (body instanceof Uint8Array) return bytesFrameBody(body);
    const text = JSON.stringify(body);
    if (text === undefined) throw new TypeError("request body is not JSON serializable");
    return utf8FrameBody(text);
}

/** Canonical compact `route.open` request body (wire doc 7.2). */
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
        // A quarantined release throws after onRelease has already accounted
        // the outcome; the unexpected_binary_response error must win here.
        if (!body.isReleased()) {
            try {
                body.release();
            } catch {
                // Quarantine is already accounted by onRelease before the throw.
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

/** Canonical `ErrorBody {code, message, retry_after_ms?}` into a terminal error. */
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
 * A `catalog.list` response is an ordinary control response, so it follows the
 * wire doc Section 7.1 rule: unknown fields are ignored, both at the top level
 * and inside each module entry, which lets a host add backward-compatible
 * fields without breaking this client. The negotiation family (Section 7.7.1)
 * is the only closed-shape exception and is decoded elsewhere. Ignoring
 * unknown fields never relaxes the required ones: every field this snapshot
 * exposes is still rejected when absent, wrong-typed, or out of bounds.
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
        // Count-bounded but deliberately not element-validated: `roles` is an
        // opaque pass-through the protocol requires to survive intact, so it is
        // typed `unknown[]` rather than cast to a shape this client would be
        // guessing at. The whole body is already capped by
        // MAX_CONTROL_BODY_LEN, so an unvalidated element is not a resource
        // risk; any consumer that interprets a role must narrow it itself.
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
 * Negotiation-path failure sanitizer: a wire Error terminal carries
 * peer-controlled text, so it is replaced with a bounded failure before it
 * can enter retirement info or caller-visible error graphs (R14). Every
 * other failure keeps `wrapNegotiationError` semantics.
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
        // Code-point sort (NOT localeCompare), matching `shared/stable-json.ts`:
        // the key must not depend on the runtime's collation.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([provider, fingerprint]) => `${provider}:${fingerprint}`)
        .join(",");
    return `${target.kind}\0${target.module_id}\0${identity.project_root}\0${identity.harness}\0${identity.session}\0${credentialPart}\0${consumerPart}`;
}
