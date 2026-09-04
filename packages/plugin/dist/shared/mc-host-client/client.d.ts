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
import { type ConnectionDiagnosticEvent, type ConnectionGenerationOptions } from "./connection";
import { type MonotonicClock } from "./deadline";
import { ReceiveLease } from "./frame-channel";
import { type RouteHandle } from "./route-handle";
import { type FallbackReason } from "./transport-negotiation";
import { type ClientTransportProvider } from "./transport-provider";
import type { AuthenticatedPeer, BindIdentity, CatalogEntry, CatalogSnapshot, ConnectOptions, HostStatusSnapshot, ManagedCallOptions, PublicationDiagnostics, RequestOptions, RouteTarget } from "./types";
export declare const DEFAULT_RECOVERY_DEADLINE_MS = 30000;
export declare const SUBC_MODULE_ID_ENV = "SUBC_MODULE_ID";
export declare const SUBC_LAUNCH_NONCE_ENV = "SUBC_LAUNCH_NONCE";
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
    generationOptions?: Partial<Pick<ConnectionGenerationOptions, "frameDeadlineMs" | "maxBodyLen" | "memoryCapBytes" | "maxQueuedFrames" | "maxQueuedBytes" | "controlReserveFrames" | "cleanupTicketMs" | "generateNonce">>;
    /** @internal Not part of the consumer contract. */
    transportProviders?: readonly ClientTransportProvider[];
}
/** True when the connection file exists; parity with npm subc-client 0.4.1. */
export declare function connectionFileExists(path: string): Promise<boolean>;
/**
 * Reconnect-transience classification, semantics-compatible with npm
 * subc-client 0.4.1. Recognition works cross-bundle by error `name` and
 * `kind`/`code` shape, not only `instanceof`.
 */
export declare function isConsumerReconnectTransient(err: unknown): boolean;
/**
 * The consumer-facing client: connect, route open, raw request, managed
 * call, catalog, and bounded close over one active connection generation.
 */
export declare class McHostClient {
    private readonly connectionFile;
    private readonly handshakeTimeoutMs;
    private readonly requestTimeoutMs;
    private readonly routeOpenDeadlineMs;
    private readonly shutdownDeadlineMs;
    private readonly recoveryDeadlineMs;
    private readonly defaultIdentity;
    private readonly defaultTargetKind;
    private readonly credentialSource;
    private readonly clock;
    private readonly sleep;
    private readonly connectionFileAfterOpen;
    private readonly generationOptions;
    private readonly diagnostics;
    private readonly maxDiagnosticEventsPerSecond;
    private readonly transportRegistry;
    private active;
    private connecting;
    /** Draining generation slot; occupied from promotion until drain completes (KTD7). commentlint: allow(JUDGE) */
    private predecessor;
    /** At most one client-wide recovery episode (KTD5). commentlint: allow(JUDGE) */
    private recovery;
    /** RouteHandles opened by the managed-route cache, not caller-owned raw handles; the drain closes orphaned managed handles at pending-zero while raw handles wait for their caller's explicit close (R10). commentlint: allow(JUDGE) */
    private readonly managedHandles;
    private readonly routes;
    /** In-flight route.open attempts, drained bounded during owner close. */
    private readonly pendingRouteOpens;
    /**
     * In-flight route.open attempts per connection. A route.open terminal
     * empties the pending set BEFORE its awaiting continuation inserts the
     * new handle into `liveRoutes`, so a pending-zero retirement check
     * alone would retire a draining predecessor between those two steps
     * and hand the caller an immediately-stale handle.
     */
    private readonly routeOpenCounts;
    private closeStarted;
    private closePromise;
    private diagWindowStartMs;
    private diagWindowCount;
    private constructor();
    /**
     * Read the connection file, dial, and authenticate under one handshake
     * deadline, then return the ready client.
     */
    static connect(options: McHostClientOptions): Promise<McHostClient>;
    /** The daemon version reported by the current connection, if any. */
    get daemonVer(): string | null;
    /**
     * Handshake-retained peer identity for the current connection, or null
     * when no authenticated generation is live. Lifecycle policy must use
     * this, never {@link publication}, for compatibility and fencing.
     */
    get authenticated(): AuthenticatedPeer | null;
    /**
     * Connection-file `daemon_ver`/`pid` for the current connection, or null.
     * Untrusted display metadata only: it must never authorize
     * compatibility, shutdown, or cleanup.
     */
    get publication(): PublicationDiagnostics | null;
    /**
     * Open a route and return its connection-bound immutable handle. One
     * attempt under one bounded deadline; retry policy belongs to owners
     * above (managed `call()` owns its own allowlisted retry loop).
     */
    routeOpen(target: RouteTarget, identity: BindIdentity): Promise<RouteHandle>;
    /**
     * Send one routed request on exactly the supplied route generation and
     * return the JSON-parsed response body. Never replays the body.
     */
    request(handle: RouteHandle, body: unknown, options?: RequestOptions): Promise<unknown>;
    /** Caller releases the returned ReceiveLease. */
    requestBinary(handle: RouteHandle, body: Uint8Array, options?: RequestOptions): Promise<ReceiveLease>;
    /**
     * Managed route + request convenience: opens and caches a route keyed by
     * (target kind, module id, identity, consumer identity), reconnecting
     * and reopening after retirement. Sends `{method, params}` and returns
     * the JSON-parsed response. Owns exactly one body-replay token.
     */
    call<Response = unknown>(moduleId: string, method: string, params?: unknown, options?: ManagedCallOptions): Promise<Response>;
    /** List catalog entries through a validated tagged `catalog.list`. */
    catalogList(): Promise<CatalogEntry[]>;
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
    catalogSnapshot(): Promise<CatalogSnapshot>;
    /**
     * Bounded authenticated `host.shutdown`. Resolves only after the host's
     * correlated success response is fully received — the caller-observable
     * stop-commit point. Never called by `close()`/`closeAsync()`; ordinary
     * client close remains connection teardown only.
     */
    hostShutdown(options?: {
        timeoutMs?: number;
    }): Promise<void>;
    /** Read host-owned component readiness without opening a routed module. */
    hostStatus(options?: {
        timeoutMs?: number;
    }): Promise<HostStatusSnapshot>;
    /**
     * Tear down exactly the supplied route generation: evict caches, send
     * route Goodbye, and await the write bounded by the shutdown deadline.
     */
    closeRoute(handle: RouteHandle): Promise<void>;
    /**
     * Synchronous close for existing callers: fires the bounded async
     * teardown and returns immediately. New code should prefer
     * `closeAsync()`.
     */
    close(): void;
    /**
     * Awaitable owner close under one bounded shutdown deadline: drain
     * in-flight route.open attempts (so a late success becomes route
     * Goodbye instead of a cached route), send connection Goodbye
     * best-effort, flush, then retire the generation. Idempotent.
     */
    closeAsync(): Promise<void>;
    private ensureConnection;
    private openConnection;
    /**
     * Send the versioned offer as the generation's first channel-0 request.
     * Only a strictly decoded selection continues; every failure — including
     * any wire Error terminal — propagates so setup fails closed without
     * same-generation TCP fallback (KTD7).
     */
    private negotiateTransport;
    /**
     * KTD4 activate-then-commit barrier over one injected provider
     * candidate: activation at candidate correlation 1 consumes the one-use
     * token, commit at correlation 2 finalizes, and only then is the
     * candidate generation published — with its application correlation
     * allocator already at 3 — while the bootstrap retires. Any failure or
     * uncertainty closes BOTH channels without TCP continuation (R12).
     */
    private activateCandidate;
    /**
     * Run one grant through candidate construction, activation, and commit
     * without publishing. Any failure or uncertainty retires BOTH the
     * candidate and the bootstrap. A shadow caller passes its episode's
     * `shadow` generation set so the candidate's retirement callbacks stay
     * episode-internal until promotion clears the role.
     */
    private prepareCandidate;
    private onGenerationRetired;
    private onRouteGoodbye;
    /** The live connection owning `handle`: the primary or the draining predecessor. */
    private connectionFor;
    /**
     * Managed-route cache eligibility: only the primary may serve a cached
     * managed handle, so new managed acquisitions never land on a draining
     * predecessor (R10).
     */
    private isPrimaryLiveHandle;
    private requireLiveHandle;
    private evictHandle;
    /**
     * `closeRoute` uses the returned keys to mark and evict every cached
     * entry for `handle`; the other callers only need the detach.
     */
    private detachCachedHandle;
    private emitConnected;
    /**
     * Begin one client-wide recovery episode fenced to `source`. Only an
     * exact `unavailable` TCP fallback reaches this point; the deadline is
     * created once here and never reset by any retry (KTD5). commentlint: allow(JUDGE)
     */
    private startRecovery;
    private cancelRecovery;
    private recoveryStopped;
    private runRecoveryEpisode;
    /**
     * One full fresh setup attempt: reread the connection file, dial,
     * authenticate, negotiate, and — on a grant — activate and commit,
     * all bounded by the episode deadline. Retries only discovery/dial
     * transients and repeated exact `unavailable`; every other outcome
     * stops the episode permanently (KTD6). commentlint: allow(JUDGE)
     */
    private shadowAttempt;
    /**
     * Source-fenced publication: the shadow commit becomes the primary only
     * while the exact source primary is still published and the predecessor
     * slot is free; any other state retires the candidate instead (KTD6). commentlint: allow(JUDGE)
     */
    private finishPromotion;
    private onPendingDrained;
    /**
     * Retire the draining predecessor once no pending work AND no live
     * route handles remain on it. Orphaned managed-cache routes close at
     * pending-zero; caller-owned raw handles keep the drain open until
     * their explicit close (R10). commentlint: allow(JUDGE)
     */
    private maybeRetirePredecessor;
    /**
     * Run one request to its terminal. A wire Error terminal becomes a
     * `terminal` McHostCallError with the canonical body's stable code. On a
     * caller abort, the rejection carries the cleanup ticket, and a
     * post-write routed abort enqueues a correlation-scoped Cancel; channel
     * 0 never sees Cancel (KTD9 handles it by retirement in the caller).
     */
    private awaitRequest;
    /** Send one channel-0 control request and validate the tagged response. */
    private controlRequest;
    private controlRouteOpen;
    private runRouteOpen;
    private managedRouteHandle;
    /**
     * Open one cached managed route under one bounded route-open deadline.
     * Only the allowlisted momentary route.open rejections retry (with
     * bounded backoff); transient connection failures reconnect; the
     * application body is never sent before route success.
     */
    private openCachedRoute;
    private runClose;
    private emitDiagnostics;
    private envConsumerIdentity;
    private identityForConnection;
}
//# sourceMappingURL=client.d.ts.map