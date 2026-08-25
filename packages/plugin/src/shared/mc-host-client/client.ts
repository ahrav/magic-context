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
import { armExpiryTimer, Deadline, type MonotonicClock } from "./deadline";
import {
    isMcHostCallError,
    SocketTimeoutError,
    McHostCallError,
    McHostClientError,
} from "./errors";
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
    BindIdentity,
    CatalogEntry,
    ConnectOptions,
    ConsumerIdentity,
    ManagedCallOptions,
    ManagedRouteKind,
    RequestOptions,
    RouteTarget,
} from "./types";

/** Preserves the repo's current 2-second TypeScript handshake budget. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
/** Matches npm subc-client 0.4.1 `DEFAULT_REQUEST_TIMEOUT_MS`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** One bounded route-open deadline shared by the whole managed retry loop. */
const DEFAULT_ROUTE_OPEN_DEADLINE_MS = 30_000;
/** Separate bounded shutdown deadline for route and connection Goodbye. */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
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
    /** Opt-in for the trusted-symlink connection-file form (wire doc 4.2). */
    trustedSymlink?: boolean;
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
    /** The selected transport remains fixed from publication until retirement. */
    transport: string;
    /** Closed-set reason when the selection was an explicit TCP fallback. */
    fallbackReason?: FallbackReason;
}

interface CachedManagedRoute {
    readonly key: string;
    readonly target: Extract<RouteTarget, { kind: ManagedRouteKind }>;
    readonly identity: BindIdentity;
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
    body: Uint8Array;
    deadline: Deadline;
    options: RequestOptions;
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
 * The consumer-facing client: connect, route open, raw request, managed
 * call, catalog, and bounded close over one active connection generation.
 */
export class McHostClient {
    private readonly connectionFile: string;
    private readonly handshakeTimeoutMs: number;
    private readonly requestTimeoutMs: number;
    private readonly routeOpenDeadlineMs: number;
    private readonly shutdownDeadlineMs: number;
    private readonly defaultIdentity: BindIdentity | undefined;
    private readonly defaultTargetKind: ManagedRouteKind;
    private readonly clock: MonotonicClock | undefined;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly trustedSymlink: boolean;
    private readonly connectionFileAfterOpen: (() => void | Promise<void>) | undefined;
    private readonly generationOptions: McHostClientOptions["generationOptions"];
    private readonly diagnostics: McHostDiagnosticsObserver | undefined;
    private readonly maxDiagnosticEventsPerSecond: number;
    private readonly transportRegistry: ClientTransportRegistry;

    private active: ActiveConnection | null = null;
    private connecting: SetupFlight<ActiveConnection> | null = null;
    private readonly liveRoutes = new Map<number, RouteHandle>();
    private readonly routes = new Map<string, CachedManagedRoute>();
    /** In-flight route.open attempts, drained bounded during owner close. */
    private readonly pendingRouteOpens = new Set<Promise<void>>();
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
        this.clock = options.clock;
        this.sleep =
            options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.trustedSymlink = options.trustedSymlink ?? false;
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
     * Open a route and return its connection-bound immutable handle. One
     * attempt under one bounded deadline; retry policy belongs to owners
     * above (managed `call()` owns its own allowlisted retry loop).
     */
    async routeOpen(target: RouteTarget, identity: BindIdentity): Promise<RouteHandle> {
        const deadline = Deadline.start(this.routeOpenDeadlineMs, this.clock);
        const active = await this.ensureConnection(deadline);
        return this.controlRouteOpen(
            active,
            target,
            identity,
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
        const body = Buffer.from(
            JSON.stringify(params === undefined ? { method } : { method, params }),
            "utf8",
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
    async catalogList(): Promise<CatalogEntry[]> {
        const deadline = Deadline.start(this.requestTimeoutMs, this.clock);
        const active = await this.ensureConnection(deadline);
        const bodyText = JSON.stringify({ op: "catalog.list" });
        const parsed = await this.controlRequest(active, bodyText, "catalog.list", deadline);
        const modules = parsed.modules ?? [];
        if (!Array.isArray(modules)) {
            throw new McHostCallError(
                "terminal",
                "catalog.list response carried a non-array modules field",
                "malformed_control_response",
            );
        }
        return modules as CatalogEntry[];
    }

    /**
     * Tear down exactly the supplied route generation: evict caches, send
     * route Goodbye, and await the write bounded by the shutdown deadline.
     */
    async closeRoute(handle: RouteHandle): Promise<void> {
        const active = this.requireLiveHandle(handle);
        this.liveRoutes.delete(handle.channel);
        for (const [key, cached] of this.routes) {
            if (cached.handle === handle) {
                cached.closed = true;
                cached.handle = null;
                this.routes.delete(key);
            }
        }
        active.generation.enqueueRouteGoodbye(handle.channel, handle.epoch);
        await active.generation.flushWrites(Deadline.start(this.shutdownDeadlineMs, this.clock));
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

    private async ensureConnection(deadline: Deadline): Promise<ActiveConnection> {
        // R1: one immutable handshake stage per caller, derived once from its
        // own operation deadline and kept through every join and replacement.
        const stage = deadline.stage(this.handshakeTimeoutMs);
        const pace = makeReplacementPacer(stage, this.sleep);
        for (;;) {
            if (this.closeStarted) throw new McHostClientError("client closed", "client_closed");
            const active = this.active;
            if (active && !active.generation.isRetired()) return active;
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
            if (this.active === conn && !conn.generation.isRetired()) return conn;
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
                trustedSymlink: this.trustedSymlink,
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
            credentials: { key: snapshot.key, daemonId: snapshot.daemonId },
            onRetired: (info) => {
                retiredReason = info.reason;
                if (conn) this.onGenerationRetired(conn, info);
            },
            onRouteGoodbye: (channel, epoch) => {
                if (conn) this.onRouteGoodbye(conn, channel, epoch);
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
        this.liveRoutes.clear();
        this.emitDiagnostics({
            type: "connected",
            daemonVer: snapshot.daemonVer.slice(0, MAX_DIAGNOSTIC_STRING_LEN),
            pid: snapshot.pid,
            transport: conn.transport,
            ...(conn.fallbackReason !== undefined ? { fallbackReason: conn.fallbackReason } : {}),
        });
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
                // legacy `unsupported_operation` continuation.
                throw new McHostCallError(
                    "terminal",
                    "transport negotiation failed: host error terminal",
                    "negotiation_failed",
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
            return decodeNegotiateResponse(terminal.body, offers);
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
                credentials: { key: snapshot.key, daemonId: snapshot.daemonId },
                channelFactory: sanitizedCandidateFactory(
                    grant.selected.transport,
                    provider,
                    grant.descriptor,
                ),
                firstCorrelation: ACTIVATION_CORRELATION,
                onRetired: (info) => {
                    if (conn) this.onGenerationRetired(conn, info);
                },
                onRouteGoodbye: (channel, epoch) => {
                    if (conn) this.onRouteGoodbye(conn, channel, epoch);
                },
                onDiagnostic: this.diagnostics ? (event) => this.emitDiagnostics(event) : undefined,
                ...this.generationOptions,
            });
        } catch (error) {
            const failure = wrapNegotiationError(error);
            bootstrap.generation.retire("negotiation_failed", failure);
            throw failure;
        }
        conn = {
            generation: candidate,
            token: newConnectionToken(),
            snapshot,
            transport: grant.selected.transport,
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
            decodeActivateResponse(activate.body);
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
            decodeCommitResponse(commit.body);
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
        // Atomic promotion: publish the finalized candidate, then retire the
        // bootstrap; the host already replaced it after the commit response
        // reached local completion.
        this.active = conn;
        this.liveRoutes.clear();
        bootstrap.generation.retire("owner_close");
        this.emitDiagnostics({
            type: "connected",
            daemonVer: snapshot.daemonVer.slice(0, MAX_DIAGNOSTIC_STRING_LEN),
            pid: snapshot.pid,
            transport: conn.transport,
        });
        return conn;
    }

    private onGenerationRetired(conn: ActiveConnection, info: RetirementInfo): void {
        if (this.active === conn) {
            this.active = null;
            this.liveRoutes.clear();
            for (const cached of this.routes.values()) {
                cached.handle = null;
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
        if (this.active !== conn) return;
        const handle = this.liveRoutes.get(channel);
        if (!handle || handle.epoch !== epoch) return;
        this.liveRoutes.delete(channel);
        for (const cached of this.routes.values()) {
            if (cached.handle === handle) cached.handle = null;
        }
    }

    private isLiveHandle(handle: RouteHandle): boolean {
        const active = this.active;
        return (
            active !== null &&
            !active.generation.isRetired() &&
            belongsToConnection(handle, active.token) &&
            this.liveRoutes.get(handle.channel) === handle
        );
    }

    private requireLiveHandle(handle: RouteHandle): ActiveConnection {
        if (!this.isLiveHandle(handle)) throw new StaleRouteHandleError(handle);
        return this.active as ActiveConnection;
    }

    private evictHandle(handle: RouteHandle): void {
        if (this.liveRoutes.get(handle.channel) === handle) {
            this.liveRoutes.delete(handle.channel);
        }
        for (const cached of this.routes.values()) {
            if (cached.handle === handle) cached.handle = null;
        }
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
        const signal = params.options.signal;
        const pending: PendingRequest = generation.request({
            channel: params.channel,
            epoch: params.epoch,
            body: params.body,
            deadline: params.deadline,
            mode: "unary",
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
                const failure = terminalFromErrorBody(terminal.body);
                if (params.captureErrorTerminal === true) {
                    failure.errorTerminal = {
                        body: terminal.body,
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
        let parsed: unknown;
        try {
            parsed = JSON.parse(Buffer.from(terminal.body).toString("utf8"));
        } catch {
            parsed = undefined;
        }
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
        this.emitDiagnostics({ type: "parse", channel: 0, epoch: 0, len: terminal.body.length });
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
        void tracked.finally(() => this.pendingRouteOpens.delete(tracked));
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
        this.liveRoutes.set(handle.channel, handle);
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
        const identity = options.identity ?? this.defaultIdentity;
        if (!identity) {
            throw new McHostCallError(
                "terminal",
                "managed call requires a BindIdentity in McHostClient.connect({ identity }) or call(..., { identity })",
                "missing_identity",
            );
        }
        const kind = options.targetKind ?? this.defaultTargetKind;
        const target = { kind, module_id: moduleId } as Extract<
            RouteTarget,
            { kind: ManagedRouteKind }
        >;
        const consumerIdentity = this.envConsumerIdentity();
        const key = routeCacheKey(target, identity, consumerIdentity);
        // R1: one immutable route-open stage per caller, derived once and
        // kept through every join and replacement decision.
        const stage = deadline.stage(this.routeOpenDeadlineMs);
        const pace = makeReplacementPacer(stage, this.sleep);
        for (;;) {
            let cached = this.routes.get(key);
            if (!cached) {
                cached = {
                    key,
                    target,
                    identity,
                    consumerIdentity,
                    handle: null,
                    opening: null,
                    closed: false,
                };
                this.routes.set(key, cached);
            }
            if (cached.handle && this.isLiveHandle(cached.handle)) return cached.handle;
            let flight = cached.opening;
            let owner = false;
            if (!flight) {
                owner = true;
                const slot = cached;
                flight = makeSetupFlight(
                    (f) => this.openCachedRoute(slot, stage, f),
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
                this.isLiveHandle(handle)
            ) {
                return handle;
            }
            if (stage.isExpired()) throw routeStageError();
            // Pace the replacement open unless a live handle is already
            // installed (the loop head adopts it without new I/O).
            const current = this.routes.get(key);
            if (!(current?.handle && this.isLiveHandle(current.handle))) {
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
                active = await this.ensureConnection(deadline);
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
            if (cached.handle && this.isLiveHandle(cached.handle)) return cached.handle;
            try {
                const handle = await this.controlRouteOpen(
                    active,
                    cached.target,
                    cached.identity,
                    cached.consumerIdentity,
                    deadline,
                );
                if (cached.closed) {
                    this.liveRoutes.delete(handle.channel);
                    active.generation.enqueueRouteGoodbye(handle.channel, handle.epoch);
                    throw new McHostCallError(
                        "not_sent",
                        "route was closed before route.open completed",
                        "route_closed",
                    );
                }
                cached.handle = handle;
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
        const active = this.active;
        if (active && !active.generation.isRetired()) {
            active.generation.enqueueConnectionGoodbye();
            await active.generation.flushWrites(deadline);
            active.generation.retire("owner_close");
        }
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
}

// ----------------------------------------------------------------------
// Body encoding and terminal classification helpers.
// ----------------------------------------------------------------------

function encodeBody(body: unknown): Uint8Array {
    return body instanceof Uint8Array ? body : Buffer.from(JSON.stringify(body), "utf8");
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

/** Canonical `ErrorBody {code, message}` into a `terminal` McHostCallError. */
function terminalFromErrorBody(body: Uint8Array): McHostCallError {
    const text = Buffer.from(body).toString("utf8");
    try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed === "object" && parsed !== null) {
            const code = typeof parsed.code === "string" ? parsed.code : undefined;
            const message = typeof parsed.message === "string" ? parsed.message : undefined;
            return new McHostCallError("terminal", message ?? "subc error", code);
        }
    } catch {
        // Fall through to the opaque-body form.
    }
    return new McHostCallError("terminal", text || "subc error");
}

function parseResponseJson<Response = unknown>(terminal: RequestTerminal): Response {
    try {
        return JSON.parse(Buffer.from(terminal.body).toString("utf8"));
    } catch (error) {
        throw new McHostCallError(
            "terminal",
            "response body was not valid JSON",
            "invalid_response_body",
            error,
        );
    }
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
    return `${target.kind}\0${target.module_id}\0${identity.project_root}\0${identity.harness}\0${identity.session}\0${consumerPart}`;
}
