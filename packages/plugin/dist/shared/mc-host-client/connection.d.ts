/**
 * Bounded connection-generation engine.
 *
 * One `ConnectionGeneration` owns correlation allocation, pending entries,
 * terminal settlement, stream collection, route notifications, aggregate
 * memory policy, and one idempotent retirement path. Transport mechanics —
 * the `node:net` socket, dial, auth byte I/O, incremental framing, and the
 * single bounded FIFO writer — live below the complete-frame channel
 * boundary in `TcpFrameChannel` (KTD1); the generation owns no socket. It
 * owns no route cache and no reconnect policy; the facade layer above
 * reacts to retirement but is never imported here.
 *
 * Send-outcome boundary: a queued request is classified `not_sent` until
 * the channel begins publishing its bytes — the instant immediately before
 * `socket.write()` is invoked for any of them. After publication starts,
 * only a matching terminal frame is authoritative; losing the terminal
 * (retirement, timeout, abort, EOF, error, close) classifies the request
 * `outcome_unknown`. Local write completion proves local handling only,
 * never peer receipt.
 */
import { type AuthCredentials } from "./auth";
import { type Deadline } from "./deadline";
import { ByteBudget, type DirectFrameBody, type FrameChannelHandlers, ReceiveLease, type SetupFrameChannel } from "./frame-channel";
import { AdmissionClass, Priority } from "./types";
export type RetirementReason = "setup_failed" | "auth_failed" | "setup_deadline" | "socket_error" | "eof" | "socket_closed" | "socket_timeout" | "protocol_violation" | "role_violation" | "frame_deadline" | "connection_goodbye" | "control_capacity_exhausted" | "cleanup_deadline" | "write_failed" | "quarantined" | "ambiguous_route_open" | "negotiation_failed" | "owner_close";
export interface RetirementInfo {
    readonly reason: RetirementReason;
    readonly error?: unknown;
}
/** How a pending entry treats host StreamData/StreamEnd frames (KTD11). */
export type PendingMode = "unary" | "stream";
/**
 * Redacted per-frame diagnostics metadata (KTD12): header identity and byte
 * counts only, never body bytes, key material, or mutable engine state. The
 * hook must be read-only; exceptions are swallowed and cannot affect
 * protocol work.
 */
export interface ConnectionDiagnosticEvent {
    readonly type: "enqueue" | "write_start" | "write_complete" | "header" | "dispatch";
    readonly frameType: number;
    readonly channel: number;
    readonly epoch: number;
    readonly corr: bigint;
    readonly len: number;
}
export interface JsonReceiveBody {
    readonly kind: "json";
    readonly byteLength: number;
    readonly text: string | null;
    readonly value: unknown;
    readonly valid: boolean;
}
export type RequestReceiveBody = JsonReceiveBody | ReceiveLease;
/** One observed matching terminal. `stream` holds stream-mode StreamData bodies. */
export interface RequestTerminal {
    kind: "response" | "error" | "stream_end";
    body: RequestReceiveBody;
    flags: number;
    stream: RequestReceiveBody[];
    /**
     * A StreamData frame arrived before this terminal. Unary mode drains
     * stream bodies privately, so `stream` stays empty there and cannot
     * report it; a caller that must prove the host produced no response
     * data before a terminal reads this instead.
     */
    sawStream: boolean;
}
export interface RequestParams {
    channel: number;
    epoch: number;
    body: Uint8Array | DirectFrameBody;
    /** Absolute operation deadline; covers queueing, writing, and terminal wait. */
    deadline: Deadline;
    mode?: PendingMode;
    responseMode?: "json" | "binary";
    binary?: boolean;
    priority?: Priority;
    admissionClass?: AdmissionClass;
}
/** Separate caller-result and cleanup-ticket settlement (KTD10). */
export interface AbortHandle {
    /**
     * Resolves on the original terminal, generation retirement, or the
     * bounded cleanup deadline (whose expiry forces retirement). Pre-write
     * aborts resolve it immediately.
     */
    cleanup: Promise<void>;
}
export interface PendingRequest {
    correlation: bigint;
    result: Promise<RequestTerminal>;
    abort(): AbortHandle;
}
export interface ConnectionGenerationOptions {
    host?: string;
    port?: number;
    setupSocket?: string;
    /**
     * Validated connection-file credentials. `daemonVer` is the file's
     * `daemon_ver`, which the handshake requires the peer to report back.
     */
    credentials: AuthCredentials;
    /** Frame deadline starting at the FIRST header byte (wire doc 6.3). */
    frameDeadlineMs?: number;
    /** Injectable body cap for scaled tests; defaults to the exact 64 MiB limit. */
    maxBodyLen?: number;
    /** One aggregate cap over reader, decoded, queued, and pending bytes. */
    memoryCapBytes?: number;
    maxQueuedFrames?: number;
    maxQueuedBytes?: number;
    controlReserveFrames?: number;
    /** Bounded cleanup-ticket deadline for post-write aborts. */
    cleanupTicketMs?: number;
    /** Test seam so correlation exhaustion is reachable; defaults to 1n. */
    firstCorrelation?: bigint;
    /** @internal Not part of the consumer contract. */
    channelFactory?: (args: {
        budget: ByteBudget;
        maxBodyLen: number;
        handlers: FrameChannelHandlers;
    }) => SetupFrameChannel;
    /**
     * @internal Not part of the consumer contract. Identity a candidate
     * generation adopts from the already-authenticated generation that
     * negotiated it. A `channelFactory` channel runs no handshake and can
     * report no identity of its own, so this is the candidate's only source.
     */
    inheritedIdentity?: {
        daemonVer: string;
        daemonId: Uint8Array | null;
    };
    /** Nonce source passthrough to U2's handshake. */
    generateNonce?: (length: number) => Uint8Array;
    onRetired?: (info: RetirementInfo) => void;
    /** Route Goodbye events; the generation owns no route cache (KTD6). */
    onRouteGoodbye?: (channel: number, epoch: number) => void;
    /**
     * onPendingZero signals an owner that outstanding work has drained.
     * Retirement does not invoke onPendingZero.
     */
    onPendingZero?: () => void;
    /**
     * Fires after any ReceiveLease minted by this generation's channel is
     * released. A caller-held binary or stream lease keeps a draining
     * generation's storage aliased after its pending set empties, so an
     * owner deferring retirement on `activeReceiveLeases` re-checks here.
     */
    onLeaseReleased?: () => void;
    /** Bounded read-only diagnostics hook (KTD12); see ConnectionDiagnosticEvent. */
    onDiagnostic?: (event: ConnectionDiagnosticEvent) => void;
}
export interface ConnectionStats {
    memoryUsed: number;
    memoryPeak: number;
    memoryCap: number;
    readerHeldBytes: number;
    queueHeldBytes: number;
    pendingHeldBytes: number;
    queuedDataFrames: number;
    queuedControlFrames: number;
    pendingRequests: number;
    /** Live ReceiveLeases minted by the channel and not yet released. */
    activeReceiveLeases: number;
    droppedFrames: number;
    activeTimers: number;
    readPaused: boolean;
    retired: boolean;
}
/**
 * The sole pending-entry, correlation, and terminal owner for one
 * connection generation (KTD6); its `TcpFrameChannel` owns the transport.
 * Construct, then `start()` exactly once; every setup failure routes
 * through the same idempotent retirement.
 */
export declare class ConnectionGeneration {
    readonly retired: Promise<RetirementInfo>;
    /** Server-reported daemon version after a successful handshake. */
    daemonVer: string | null;
    /** Daemon ID retained from the handshake, when the channel supplies one. */
    authenticatedDaemonId: Uint8Array | null;
    private readonly channel;
    /**
     * The same channel as {@link channel} when this generation dials and
     * authenticates for itself, and the only source of a proven identity.
     * Null for a `channelFactory` channel, which runs no handshake.
     */
    private readonly authChannel;
    private readonly budget;
    private readonly cleanupTicketMs;
    private readonly inheritedIdentity;
    private readonly onRetired?;
    private readonly onRouteGoodbyeHook?;
    private readonly onPendingZeroHook?;
    private readonly onLeaseReleasedHook?;
    private readonly onDiagnostic?;
    private retiredInfo;
    private resolveRetired;
    private startState;
    private phase;
    private readonly timers;
    private nextCorr;
    private corrExhausted;
    private readonly pending;
    private droppedFrameCount;
    private pendingHeld;
    constructor(options: ConnectionGenerationOptions);
    /**
     * Single-flight dial + authentication under `deadline`. Any failure
     * (dial error, auth failure, deadline) retires the generation exactly
     * once and rejects; no socket or timer survives a failed setup.
     */
    start(deadline: Deadline): Promise<void>;
    isRetired(): boolean;
    stats(): ConnectionStats;
    /**
     * Synchronously admit one Request to the channel's writer FIFO and
     * allocate its correlation with admission (KTD7), so writer-enqueue
     * order equals correlation order. Throws a `not_sent` McHostCallError
     * when admission is refused; nothing was allocated or queued in that
     * case.
     */
    request(params: RequestParams): PendingRequest;
    /** Best-effort correlation-scoped routed Cancel through reserved capacity. */
    enqueueCancel(channel: number, epoch: number, corr: bigint): void;
    /** Route Goodbye: nonzero channel, current epoch, correlation 0. */
    enqueueRouteGoodbye(channel: number, epoch: number): void;
    /** Connection Goodbye: channel 0, epoch 0, correlation 0. */
    enqueueConnectionGoodbye(): void;
    /**
     * Idempotent retirement: freezes the shared budget, clears every
     * generation timer, settles each pending identity exactly once (queued
     * work `not_sent`, invoked work `outcome_unknown`), completes all
     * cleanup tickets, discards the channel (which destroys the socket),
     * and emits exactly one notification. Every late listener, callback,
     * and timer becomes a no-op.
     */
    retire(reason: RetirementReason, error?: unknown): void;
    private setup;
    private dispatch;
    private dispatchToPending;
    private consumeResponseBody;
    private handleRouteGoodbye;
    /** Settle the caller result exactly once (identity guard on the flag). */
    private settleCallerResolve;
    private settleCallerReject;
    /** Remove a settled/abandoned entry and complete its cleanup ticket. */
    private finishEntry;
    private clearEntryDeadline;
    private resolveTicket;
    /**
     * Remove the entry's frame from the channel queue while still
     * unpublished. Returns true only when the channel proved the frame was
     * never published; `false` is a possible send, so the caller must not
     * settle `not_sent` (the ticket contract) — a replayed "unsent" frame
     * that later publishes would reach the host twice.
     */
    private cancelQueuedFrame;
    private onRequestDeadline;
    /**
     * Caller abort (KTD10). Pre-write: remove the queued frame and settle
     * both caller and ticket as done (`not_sent`). Post-write: settle the
     * caller `outcome_unknown` immediately and return a cleanup ticket that
     * resolves on the original terminal, generation retirement, or its own
     * bounded deadline — whose expiry forces retirement.
     */
    private abortEntry;
    private enqueueControlHeader;
    /**
     * Resolve once every queued frame byte has been handed to the socket and
     * every write callback fired, the generation retires, or `deadline`
     * expires — a bounded, best-effort primitive for the facade's awaitable
     * Goodbye teardown. Never blocks retirement.
     */
    flushWrites(deadline: Deadline): Promise<void>;
    private emitDiagnostic;
    private chargePending;
    private releasePending;
    private armTimer;
    /**
     * Deadline-bound timer whose callback implies `deadline.isExpired()`.
     * Request and setup deadline errors feed replay-token gates that
     * re-sample `isExpired()`; a single-shot timer can fire fractionally
     * early and let the token spend a spurious extra attempt. Re-arms
     * stay inside the retirement-gated tracked timer set. The returned
     * cancel function stays valid across re-arms.
     */
    private armDeadlineTimer;
    private disarmTimer;
}
//# sourceMappingURL=connection.d.ts.map