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
    isMcHostCallError,
    McHostCallError,
    McHostClientError,
    SocketTimeoutError,
} from "./errors";
import { bytesFrameBody, type DirectFrameBody, ReceiveLease, utf8FrameBody } from "./frame-channel";
import {
    belongsToConnection,
    createRouteHandle,
    newConnectionToken,
    type RouteHandle,
    StaleRouteHandleError,
} from "./route-handle";
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
    /** Sole application transport. */
    readonly transport?: "shm";
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
}

interface ActiveConnection {
    readonly generation: ConnectionGeneration;
    /** Opaque token binding this connection's route handles. */
    readonly token: object;
    readonly snapshot: ConnectionSnapshot;
    readonly liveRoutes: Map<number, RouteHandle>;
    /** Sole application transport. */
    transport: "shm";
}

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
    binary?: boolean;
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
    if (name === "SocketClosedError" || name === "SocketTimeoutError") {
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
    private readonly credentialSource: Record<string, string | undefined> | undefined;
    private readonly clock: MonotonicClock | undefined;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly connectionFileAfterOpen: (() => void | Promise<void>) | undefined;
    private readonly diagnostics: McHostDiagnosticsObserver | undefined;
    private readonly maxDiagnosticEventsPerSecond: number;

    private active: ActiveConnection | null = null;
    private connecting: SetupFlight<ActiveConnection> | null = null;
    /** Route handles opened by the managed-route cache. */
    private readonly managedHandles = new WeakSet<RouteHandle>();
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
        this.credentialSource = options.credentialSource;
        this.clock = options.clock;
        this.sleep =
            options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.connectionFileAfterOpen = options.connectionFileAfterOpen;
        this.diagnostics = options.diagnostics;
        this.maxDiagnosticEventsPerSecond =
            options.maxDiagnosticEventsPerSecond ?? DEFAULT_MAX_DIAGNOSTIC_EVENTS_PER_SECOND;
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
            // Callers must not mutate the retained identity used for fencing.
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
    async routeOpen(target: RouteTarget, identity: BindIdentity): Promise<RouteHandle> {
        const deadline = Deadline.start(this.routeOpenDeadlineMs, this.clock);
        const active = await this.ensureConnection(deadline);
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
    async catalogList(): Promise<CatalogEntry[]> {
        return (await this.catalogSnapshot()).modules;
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
     */
    async catalogSnapshot(): Promise<CatalogSnapshot> {
        const deadline = Deadline.start(this.requestTimeoutMs, this.clock);
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
            // A stale success re-enters setup under the unchanged stage.
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
            setupSocket: snapshot.setupSocket,
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
            // Skip per-frame event allocation entirely when no observer is
            // configured; the generation's hook check short-circuits on
            // undefined.
            onDiagnostic: this.diagnostics ? (event) => this.emitDiagnostics(event) : undefined,
        });
        conn = {
            generation,
            token: newConnectionToken(),
            snapshot,
            liveRoutes: new Map(),
            transport: "shm",
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
        // A generation that retires during setup is never published.
        if (generation.isRetired()) return conn;
        if (this.closeStarted) {
            generation.retire("owner_close");
            throw new McHostClientError("client closed", "client_closed");
        }
        if (generation.isRetired()) return conn;
        this.active = conn;
        this.emitConnected(conn);
        return conn;
    }

    private onGenerationRetired(conn: ActiveConnection, info: RetirementInfo): void {
        if (this.active === conn) {
            this.active = null;
            for (const cached of this.routes.values()) {
                cached.handle = null;
            }
        }
        this.emitDiagnostics({ type: "retired", reason: info.reason });
    }

    private onRouteGoodbye(conn: ActiveConnection, channel: number, epoch: number): void {
        if (this.active !== conn) return;
        const handle = conn.liveRoutes.get(channel);
        if (!handle || handle.epoch !== epoch) return;
        conn.liveRoutes.delete(channel);
        this.detachCachedHandle(handle);
    }

    /** Returns the live mandatory-ring connection owning `handle`. */
    private connectionFor(handle: RouteHandle): ActiveConnection | null {
        const conn = this.active;
        return conn !== null &&
            !conn.generation.isRetired() &&
            belongsToConnection(handle, conn.token) &&
            conn.liveRoutes.get(handle.channel) === handle
            ? conn
            : null;
    }

    /**
     * Managed-route cache eligibility: only the primary may serve a cached
     * managed handle.
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

    private emitConnected(conn: ActiveConnection): void {
        this.emitDiagnostics({
            type: "connected",
            daemonVer: conn.snapshot.daemonVer.slice(0, MAX_DIAGNOSTIC_STRING_LEN),
            pid: conn.snapshot.pid,
            transport: conn.transport,
        });
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
        void tracked.finally(() => {
            this.pendingRouteOpens.delete(tracked);
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
            // so retire the generation before reconnecting.
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
            // Only the active generation serves cached managed handles.
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
        const conns =
            this.active !== null && !this.active.generation.isRetired() ? [this.active] : [];
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
