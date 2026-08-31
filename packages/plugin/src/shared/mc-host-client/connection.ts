/**
 *
 * ConnectionGeneration owns correlation allocation and pending entries.
 * ConnectionGeneration owns terminal settlement, stream collection, route notifications, and aggregate memory policy.
 * ConnectionGeneration has one idempotent retirement path.
 * TcpFrameChannel owns the node:net socket, dialing, authentication byte I/O, and incremental framing.
 * TcpFrameChannel owns the bounded FIFO writer below the complete-frame boundary.
 * TcpFrameChannel owns transport mechanics below the complete-frame boundary; ConnectionGeneration owns no socket.
 * ConnectionGeneration owns no route cache or reconnect policy.
 *
 * A queued request remains `not_sent` until the channel begins `socket.write()`.
 * The channel classifies a request as not_sent until immediately before socket.write() publishes its bytes.
 * After `socket.write()` begins, only a matching terminal frame determines the request outcome.
 * Retirement, timeout, abort, EOF, socket error, or close before a matching terminal frame yields `outcome_unknown`.
 * Local write completion never proves peer receipt.
 */

import { type AuthCredentials, AuthError } from "./auth";
import { armExpiryTimer, type Deadline } from "./deadline";
import { McHostCallError, SocketClosedError, SocketTimeoutError } from "./errors";
import {
    ByteBudget,
    bytesFrameBody,
    type DirectFrameBody,
    type FrameChannelCloseReason,
    type FrameChannelHandlers,
    type FrameMeta,
    type FrameSendTicket,
    ReceiveLease,
    type SetupFrameChannel,
} from "./frame-channel";
import {
    buildFlags,
    type EnvelopeHeader,
    FrameType,
    flagsBinary,
    MAX_CORRELATION,
    MAX_FRAME_BODY_LEN,
    PROTOCOL_VERSION,
} from "./protocol";
import { TcpFrameChannel } from "./tcp-frame-channel";
import { AdmissionClass, Priority } from "./types";

const DEFAULT_CLEANUP_TICKET_MS = 5_000;
/**
 * Setup waits 50 ms for a retired channel's start() to settle before the retirement cause wins.
 * A start() rejection triggered in the retirement event-loop turn can win before the 50 ms grace period expires.
 * A provider promise that never settles cannot extend teardown beyond 50 ms.
 */
const RETIREMENT_SETTLE_GRACE_MS = 50;
/**
 * The aggregate cap admits fixed header and control overhead above one maximum body.
 * The aggregate cap accepts one 64 MiB frame plus headers.
 * The aggregate cap reserves space for control frames and small control-plane bodies.
 */
const DEFAULT_MEMORY_OVERHEAD_BYTES = 1_048_576;
/**
 * A stream-mode request retains at most 100,000 items because the byte budget excludes decoded-item overhead.
 * The pending byte budget does not count decoded object, text, or parsed-value overhead.
 */
const DEFAULT_MAX_STREAM_ITEMS = 100_000;
const EMPTY_JSON_BODY: JsonReceiveBody = Object.freeze({
    kind: "json",
    byteLength: 0,
    text: "",
    value: undefined,
    valid: false,
});

export type RetirementReason =
    | "setup_failed"
    | "auth_failed"
    | "setup_deadline"
    | "socket_error"
    | "eof"
    | "socket_closed"
    | "socket_timeout"
    | "protocol_violation"
    | "role_violation"
    | "frame_deadline"
    | "connection_goodbye"
    | "control_capacity_exhausted"
    | "cleanup_deadline"
    | "write_failed"
    | "quarantined"
    | "ambiguous_route_open"
    | "negotiation_failed"
    | "owner_close";

export interface RetirementInfo {
    readonly reason: RetirementReason;
    readonly error?: unknown;
}

/** PendingMode defines how pending entries treat host StreamData and StreamEnd frames. */
export type PendingMode = "unary" | "stream";

/**
 * Diagnostics metadata includes only header identity and byte counts.
 * Diagnostics metadata excludes body bytes, key material, and mutable engine state.
 * The hook is read-only; swallowed exceptions cannot affect protocol work.
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

/** `terminal` stores one observed matching terminal; `stream` stores stream-mode `StreamData` bodies. */
export interface RequestTerminal {
    kind: "response" | "error" | "stream_end";
    body: RequestReceiveBody;
    flags: number;
    stream: RequestReceiveBody[];
    /**
     * `sawStream` is true when a `StreamData` frame arrives before this terminal.
     * Unary mode drains stream bodies privately and leaves `stream` empty.
     * Callers use `sawStream` to detect response data before a terminal in unary mode.
     * Callers read `sawStream` to prove no response data preceded a terminal.
     */
    sawStream: boolean;
}

export interface RequestParams {
    channel: number;
    epoch: number;
    body: Uint8Array | DirectFrameBody;
    /** deadline is an absolute operation deadline covering queueing, writing, and terminal wait. */
    deadline: Deadline;
    mode?: PendingMode;
    /**
     * `maxStreamItems` limits retained stream items independently of the byte budget.
     * The pending byte budget counts wire bytes only; tiny items can otherwise retain unbounded decode overhead.
     * `maxStreamItems` must be a non-negative safe integer; `0` retains no items and refuses the first item.
     * first item.
     */
    maxStreamItems?: number;
    responseMode?: "json" | "binary";
    binary?: boolean;
    priority?: Priority;
    admissionClass?: AdmissionClass;
}

/** Caller results and cleanup tickets settle independently. */
export interface AbortHandle {
    /**
     * `cleanup` resolves on the original terminal, generation retirement, or cleanup-deadline expiry.
     * Cleanup-deadline expiry forces generation retirement.
     * Pre-write aborts resolve `cleanup` immediately.
     */
    cleanup: Promise<void>;
}

export interface PendingRequest {
    correlation: bigint;
    result: Promise<RequestTerminal>;
    abort(): AbortHandle;
}

export interface ConnectionGenerationOptions {
    host: string;
    port: number;
    /**
     * `credentials.daemonVer` is the connection file's `daemon_ver` value.
     * The handshake requires the peer to report `credentials.daemonVer`.
     */
    credentials: AuthCredentials;
    /** `frameDeadlineMs` measures the frame deadline from the first header byte (wire doc 6.3). */
    frameDeadlineMs?: number;
    /** `maxBodyLen` defaults to exactly 64 MiB and permits scaled tests to lower the cap. */
    maxBodyLen?: number;
    /** `memoryCapBytes` caps reader, decoded, queued, and pending bytes in aggregate. */
    memoryCapBytes?: number;
    maxQueuedFrames?: number;
    maxQueuedBytes?: number;
    controlReserveFrames?: number;
    /** `cleanupTicketMs` sets a bounded cleanup deadline for post-write aborts. */
    cleanupTicketMs?: number;
    /** `firstCorrelation` defaults to 1n and lets tests reach correlation exhaustion. */
    firstCorrelation?: bigint;
    /** @internal */
    channelFactory?: (args: {
        budget: ByteBudget;
        maxBodyLen: number;
        handlers: FrameChannelHandlers;
    }) => SetupFrameChannel;
    /**
     * A candidate generation adopts identity from the authenticated generation that negotiated it.
     * `inheritedIdentity` supplies the identity adopted from the authenticated generation.
     * `channelFactory` channels run no handshake.
     * `inheritedIdentity` is the candidate's only identity source when `channelFactory` supplies no identity.
     */
    inheritedIdentity?: { daemonVer: string; daemonId: Uint8Array | null };
    /** `generateNonce` supplies U2's handshake nonce source. */
    generateNonce?: (length: number) => Uint8Array;
    onRetired?: (info: RetirementInfo) => void;
    /** `onRouteGoodbye` routes Goodbye events because the generation owns no route cache. */
    onRouteGoodbye?: (channel: number, epoch: number) => void;
    /**
     * onPendingZero signals an owner that outstanding work has drained.
     * Retirement does not invoke onPendingZero.
     */
    onPendingZero?: () => void;
    /**
     * `onLeaseReleased` fires only after every `ReceiveLease` minted by this generation's channel is released.
     * A caller-held binary or stream lease keeps the generation draining until the lease is released.
     * A caller-held `ReceiveLease` keeps generation storage aliased after the pending set empties.
     * An owner deferring retirement on `activeReceiveLeases` re-checks after the pending set empties.
     */
    onLeaseReleased?: () => void;
    /** `onDiagnostic` receives bounded, read-only diagnostics; see `ConnectionDiagnosticEvent`. */
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
    /** `activeReceiveLeases` counts `ReceiveLease` instances minted by the channel that remain unreleased. */
    activeReceiveLeases: number;
    droppedFrames: number;
    activeTimers: number;
    readPaused: boolean;
    retired: boolean;
}

interface CleanupTicket {
    promise: Promise<void>;
    resolve: () => void;
    settled: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}

interface PendingEntry {
    key: string;
    channel: number;
    epoch: number;
    corr: bigint;
    mode: PendingMode;
    maxStreamItems: number;
    responseMode: "json" | "binary";
    writeInvoked: boolean;
    callerSettled: boolean;
    sawStream: boolean;
    streamItems: RequestReceiveBody[];
    heldBytes: number;
    resolve: (terminal: RequestTerminal) => void;
    reject: (error: unknown) => void;
    /** The cancellation function cancels the deadline timer chain and remains valid across re-arms. */
    cancelDeadlineTimer: (() => void) | null;
    sendTicket: FrameSendTicket | null;
    ticket: CleanupTicket | null;
}

function pendingKey(channel: number, epoch: number, corr: bigint): string {
    return `${channel}:${epoch}:${corr}`;
}

function consumeJsonBody(lease: ReceiveLease): JsonReceiveBody {
    const byteLength = lease.byteLength;
    let text: string | null = null;
    let value: unknown;
    let valid = false;
    try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        text = "";
        for (let index = 0; index < lease.segmentCount; index++) {
            text += decoder.decode(lease.segment(index), { stream: true });
        }
        text += decoder.decode();
        try {
            value = JSON.parse(text);
            valid = true;
        } catch {
            value = undefined;
        }
        return { kind: "json", byteLength, text, value, valid };
    } catch {
        return { kind: "json", byteLength, text: null, value: undefined, valid: false };
    } finally {
        releaseQuietly(lease);
    }
}

/**
 * `release()` releases a lease without allowing a quarantined outcome to unwind the caller.
 * Dispatch, retirement, and body-consumption paths must catch `release()` errors.
 * An escaping `release()` error would abort teardown or close the channel after a known terminal.
 */
function releaseQuietly(lease: ReceiveLease): void {
    if (lease.isReleased()) return;
    try {
        lease.release();
    } catch {
        // Quarantine is already accounted by onRelease before the throw.
    }
}

function releaseReceiveBodies(bodies: readonly RequestReceiveBody[]): void {
    for (const body of bodies) {
        if (body instanceof ReceiveLease) releaseQuietly(body);
    }
}

/**
 * A connection generation solely owns pending entries, correlations, and terminals; its `TcpFrameChannel` owns the transport.
 * Callers must call `start()` exactly once after construction; every setup failure retires the generation idempotently.
 */
export class ConnectionGeneration {
    readonly retired: Promise<RetirementInfo>;
    /** `daemonVer` stores the server-reported version after a successful handshake. */
    daemonVer: string | null = null;
    /** `authenticatedDaemonId` stores the handshake daemon ID when the channel supplies one. */
    authenticatedDaemonId: Uint8Array | null = null;

    private readonly channel: SetupFrameChannel;
    /**
     * `authChannel` is `channel` when this generation dials and authenticates itself.
     * `authChannel` is the only source of a proven identity when this generation authenticates itself.
     * `authChannel` is null for a `channelFactory` channel, which runs no handshake.
     */
    private readonly authChannel: TcpFrameChannel | null;
    private readonly budget: ByteBudget;
    private readonly cleanupTicketMs: number;
    private readonly inheritedIdentity: { daemonVer: string; daemonId: Uint8Array | null } | null;
    private readonly onRetired?: (info: RetirementInfo) => void;
    private readonly onRouteGoodbyeHook?: (channel: number, epoch: number) => void;
    private readonly onPendingZeroHook?: () => void;
    private readonly onLeaseReleasedHook?: () => void;
    private readonly onDiagnostic?: (event: ConnectionDiagnosticEvent) => void;

    private retiredInfo: RetirementInfo | null = null;
    private resolveRetired!: (info: RetirementInfo) => void;
    private startState: "idle" | "started" = "idle";
    private phase: "setup" | "frames" = "setup";
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();

    // `nextCorr` allocates only consumer correlations; host Ping correlations are never stored.
    private nextCorr: bigint;
    private corrExhausted = false;

    private readonly pending = new Map<string, PendingEntry>();
    private droppedFrameCount = 0;

    // `pendingHeld` tracks the pending-retention share of the aggregate budget.
    private pendingHeld = 0;

    constructor(options: ConnectionGenerationOptions) {
        const maxBodyLen = options.maxBodyLen ?? MAX_FRAME_BODY_LEN;
        this.budget = new ByteBudget(
            options.memoryCapBytes ?? maxBodyLen + DEFAULT_MEMORY_OVERHEAD_BYTES,
        );
        this.cleanupTicketMs = options.cleanupTicketMs ?? DEFAULT_CLEANUP_TICKET_MS;
        // `inheritedIdentity` must not alias a caller-mutable `daemonId` because it authorizes compatibility and fencing.
        this.inheritedIdentity = options.inheritedIdentity
            ? {
                  daemonVer: options.inheritedIdentity.daemonVer,
                  daemonId: options.inheritedIdentity.daemonId?.slice() ?? null,
              }
            : null;
        this.onRetired = options.onRetired;
        this.onRouteGoodbyeHook = options.onRouteGoodbye;
        this.onPendingZeroHook = options.onPendingZero;
        this.onLeaseReleasedHook = options.onLeaseReleased;
        this.onDiagnostic = options.onDiagnostic;
        this.nextCorr = options.firstCorrelation ?? 1n;
        if (this.nextCorr < 1n || this.nextCorr > MAX_CORRELATION) {
            throw new RangeError(`firstCorrelation must be a nonzero u64, got ${this.nextCorr}`);
        }
        this.retired = new Promise((resolve) => {
            this.resolveRetired = resolve;
        });
        const handlers: FrameChannelHandlers = {
            onFrame: (frame) => this.dispatch(frame.header, frame.body),
            onClosed: (reason: FrameChannelCloseReason, error) =>
                this.retire(reason === "truncated_frame" ? "eof" : reason, error),
            onDiagnostic: (type, meta) => this.emitDiagnostic(type, meta),
            onLeaseReleased: () => {
                try {
                    this.onLeaseReleasedHook?.();
                } catch {
                    // Observer exceptions must not affect lease accounting.
                }
            },
        };
        if (options.channelFactory) {
            this.authChannel = null;
            this.channel = options.channelFactory({ budget: this.budget, maxBodyLen, handlers });
        } else {
            this.authChannel = new TcpFrameChannel({
                host: options.host,
                port: options.port,
                credentials: options.credentials,
                budget: this.budget,
                frameDeadlineMs: options.frameDeadlineMs,
                maxBodyLen,
                maxQueuedFrames: options.maxQueuedFrames,
                maxQueuedBytes: options.maxQueuedBytes,
                controlReserveFrames: options.controlReserveFrames,
                generateNonce: options.generateNonce,
                handlers,
            });
            this.channel = this.authChannel;
        }
    }

    /**
     * Dial and authentication run single-flight under `deadline`.
     * Dial errors, authentication failures, and deadline expiry retire the generation exactly once and reject setup.
     * A failed setup leaves no socket or timer alive.
     */
    async start(deadline: Deadline): Promise<void> {
        if (this.startState !== "idle") {
            throw new Error("ConnectionGeneration.start() is single-flight per generation");
        }
        this.startState = "started";
        try {
            await this.setup(deadline);
        } catch (error) {
            if (!this.retiredInfo) {
                // Authentication deadline observations consume the same owner budget.
                // Auth I/O that completes after expiry but before the timer callback runs must not be reported as an authentication failure.
                const reason: RetirementReason =
                    error instanceof AuthError
                        ? error.code === "deadline_expired"
                            ? "setup_deadline"
                            : "auth_failed"
                        : "setup_failed";
                this.retire(reason, error);
            }
            throw error;
        }
    }

    isRetired(): boolean {
        return this.retiredInfo !== null;
    }

    stats(): ConnectionStats {
        const channel = this.channel.stats();
        return {
            memoryUsed: this.budget.used,
            memoryPeak: this.budget.peak,
            memoryCap: this.budget.cap,
            readerHeldBytes: channel.readerHeldBytes,
            queueHeldBytes: channel.queueHeldBytes,
            pendingHeldBytes: this.pendingHeld,
            queuedDataFrames: channel.queuedDataFrames,
            queuedControlFrames: channel.queuedControlFrames,
            pendingRequests: this.pending.size,
            activeReceiveLeases: channel.activeReceiveLeases,
            droppedFrames: this.droppedFrameCount,
            activeTimers: this.timers.size + channel.activeTimers,
            readPaused: channel.readPaused,
            retired: this.retiredInfo !== null,
        };
    }

    /**
     * `request` synchronously admits one `Request` to the channel writer FIFO and allocates its correlation with admission.
     * The client allocates each correlation with writer admission so writer-enqueue order equals correlation order.
     * `request` throws `McHostCallError("not_sent")` when admission is refused.
     * `request` creates no correlation or queue entry when admission is refused.
     * case.
     */
    request(params: RequestParams): PendingRequest {
        if (this.retiredInfo) {
            throw new McHostCallError(
                "not_sent",
                `connection generation is retired (${this.retiredInfo.reason})`,
                "connection_retired",
            );
        }
        if (this.phase !== "frames") {
            throw new McHostCallError(
                "not_sent",
                "connection generation has not completed setup",
                "connection_not_ready",
            );
        }
        if (this.corrExhausted) {
            throw new McHostCallError(
                "not_sent",
                "correlation space exhausted after u64::MAX; retire the generation",
                "correlations_exhausted",
            );
        }
        if (params.deadline.isExpired()) {
            throw new McHostCallError(
                "not_sent",
                "request deadline expired before queue admission",
                "deadline_expired",
            );
        }
        // Empty `StreamData` frames retain one item without charging pending bytes, so `maxStreamItems` is their only bound.
        // `NaN` and `Infinity` make `streamItems.length >= maxStreamItems` false; a fractional ceiling permits `Math.ceil(maxStreamItems)` retained items.
        // A `NaN` or `Infinity` ceiling leaves retention unbounded; reject it before a pending entry exists or any byte reaches the peer.
        const maxStreamItems = params.maxStreamItems ?? DEFAULT_MAX_STREAM_ITEMS;
        if (!Number.isSafeInteger(maxStreamItems) || maxStreamItems < 0) {
            throw new McHostCallError(
                "not_sent",
                `maxStreamItems must be a non-negative safe integer (got ${maxStreamItems})`,
                "invalid_max_stream_items",
            );
        }
        const flags = buildFlags(
            params.binary ?? false,
            params.priority ?? Priority.Interactive,
            false,
            params.admissionClass ?? AdmissionClass.Normal,
        );
        const body = params.body instanceof Uint8Array ? bytesFrameBody(params.body) : params.body;
        const corr = this.nextCorr;
        const header: EnvelopeHeader = {
            len: body.byteLength,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags,
            channel: params.channel,
            epoch: params.epoch,
            corr,
        };
        const key = pendingKey(params.channel, params.epoch, corr);
        let resolveResult!: (terminal: RequestTerminal) => void;
        let rejectResult!: (error: unknown) => void;
        const result = new Promise<RequestTerminal>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        // The request path attaches a rejection handler because callers may abort or not await `result`.
        result.catch(() => {});
        const entry: PendingEntry = {
            key,
            channel: params.channel,
            epoch: params.epoch,
            corr,
            mode: params.mode ?? "unary",
            maxStreamItems,
            responseMode: params.responseMode ?? "json",
            writeInvoked: false,
            callerSettled: false,
            sawStream: false,
            streamItems: [],
            heldBytes: 0,
            resolve: resolveResult,
            reject: rejectResult,
            cancelDeadlineTimer: null,
            sendTicket: null,
            ticket: null,
        };
        // `request` registers the entry before admission so retirement settles it if channel publication fails synchronously.
        this.pending.set(key, entry);
        let ticket: FrameSendTicket;
        try {
            // `request` commits `corr` only after successful channel admission.
            ticket = this.channel.produce(
                {
                    ver: header.ver,
                    ty: header.ty,
                    flags: header.flags,
                    channel: header.channel,
                    epoch: header.epoch,
                    corr: header.corr,
                },
                body,
                {
                    onPublish: () => {
                        entry.writeInvoked = true;
                    },
                },
                params.deadline,
            );
        } catch (error) {
            this.pending.delete(key);
            throw error;
        }
        entry.sendTicket = ticket;
        if (corr === MAX_CORRELATION) {
            this.corrExhausted = true;
        } else {
            this.nextCorr = corr + 1n;
        }
        const meta: FrameMeta = {
            ty: FrameType.Request,
            channel: params.channel,
            epoch: params.epoch,
            corr,
            len: body.byteLength,
        };
        if (!this.retiredInfo) {
            entry.cancelDeadlineTimer = this.armDeadlineTimer(params.deadline, () =>
                this.onRequestDeadline(entry),
            );
            this.emitDiagnostic("enqueue", meta);
        }
        return {
            correlation: corr,
            result,
            abort: () => this.abortEntry(entry),
        };
    }

    /** The client routes a best-effort correlation-scoped `Cancel` through reserved capacity. */
    enqueueCancel(channel: number, epoch: number, corr: bigint): void {
        this.enqueueControlHeader({
            len: 0,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Cancel,
            flags: buildFlags(false, Priority.Passive, false, AdmissionClass.Normal),
            channel,
            epoch,
            corr,
        });
    }

    /* */
    enqueueRouteGoodbye(channel: number, epoch: number): void {
        this.enqueueControlHeader({
            len: 0,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Goodbye,
            flags: buildFlags(false, Priority.Passive, false, AdmissionClass.Normal),
            channel,
            epoch,
            corr: 0n,
        });
    }

    /* */
    enqueueConnectionGoodbye(): void {
        this.enqueueControlHeader({
            len: 0,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Goodbye,
            flags: buildFlags(false, Priority.Passive, false, AdmissionClass.Normal),
            channel: 0,
            epoch: 0,
            corr: 0n,
        });
    }

    /**
     * `retire` invokes `onRetired` once and clears active timers.
     */
    retire(reason: RetirementReason, error?: unknown): void {
        if (this.retiredInfo) return;
        const info: RetirementInfo = Object.freeze({ reason, error });
        this.retiredInfo = info;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.budget.freeze();
        for (const entry of [...this.pending.values()]) {
            if (!entry.callerSettled) {
                entry.callerSettled = true;
                if (entry.writeInvoked) {
                    entry.reject(
                        new McHostCallError(
                            "outcome_unknown",
                            `connection generation retired (${reason}) after a possible send`,
                            "generation_retired",
                            error,
                        ),
                    );
                } else {
                    entry.reject(
                        new McHostCallError(
                            "not_sent",
                            `connection generation retired (${reason}) before any byte was written`,
                            "generation_retired",
                            error,
                        ),
                    );
                }
            }
            releaseReceiveBodies(entry.streamItems);
            entry.streamItems = [];
            this.resolveTicket(entry);
        }
        this.pending.clear();
        this.pendingHeld = 0;
        this.channel.close(
            error instanceof Error
                ? error
                : new SocketClosedError(`connection generation retired (${reason})`),
        );
        this.resolveRetired(info);
        try {
            this.onRetired?.(info);
        } catch {
            // Observer exceptions must not affect retirement.
        }
    }

    // ------------------------------------------------------------------
    // Setup dials and authenticates the channel before frame delivery.
    // ------------------------------------------------------------------

    private async setup(deadline: Deadline): Promise<void> {
        const cancelSetupTimer = this.armDeadlineTimer(deadline, () =>
            this.retire(
                "setup_deadline",
                new SocketTimeoutError("connection setup deadline expired"),
            ),
        );
        try {
            // A provider channel's `start()` may never settle or may ignore `close()` issued during retirement.
            // Deadline retirement must settle setup even if a provider channel's `start()` never settles or ignores `close()`.
            // Retirement waits `RETIREMENT_SETTLE_GRACE_MS` before rejecting setup.
            // Retirement delays its rejection so a related `start()` rejection can preserve its error classification.
            // A `start()` rejection during `RETIREMENT_SETTLE_GRACE_MS` takes precedence over retirement.
            // unhandled.
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                let fallback: ReturnType<typeof setTimeout> | null = null;
                const settle = (complete: () => void): void => {
                    if (settled) return;
                    settled = true;
                    if (fallback !== null) clearTimeout(fallback);
                    complete();
                };
                void this.retired.then((info) => {
                    if (settled) return;
                    fallback = setTimeout(
                        () =>
                            settle(() =>
                                reject(
                                    info.error instanceof Error
                                        ? info.error
                                        : new SocketClosedError(
                                              `connection retired during setup: ${info.reason}`,
                                          ),
                                ),
                            ),
                        RETIREMENT_SETTLE_GRACE_MS,
                    );
                });
                this.channel.start(deadline).then(
                    () => settle(() => resolve()),
                    (error: unknown) =>
                        settle(() =>
                            reject(error instanceof Error ? error : new Error(String(error))),
                        ),
                );
            });
            if (this.retiredInfo) {
                // A channel that ignored close() can still resolve start()
                // A `start()` success after retirement must surface the stored retirement cause rather than a generic close error.
                // close error.
                const cause = this.retiredInfo.error;
                throw cause instanceof Error
                    ? cause
                    : new SocketClosedError(
                          `connection retired during setup: ${this.retiredInfo.reason}`,
                      );
            }
            const identity = this.authChannel?.authenticated ?? this.inheritedIdentity;
            this.daemonVer = identity?.daemonVer ?? null;
            this.authenticatedDaemonId = identity?.daemonId ?? null;
            this.phase = "frames";
        } finally {
            cancelSetupTimer();
        }
        this.channel.beginFrames();
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private dispatch(header: EnvelopeHeader, body: ReceiveLease): void {
        this.emitDiagnostic("dispatch", {
            ty: header.ty,
            channel: header.channel,
            epoch: header.epoch,
            corr: header.corr,
            len: body.byteLength,
        });
        switch (header.ty) {
            case FrameType.Ping:
                releaseQuietly(body);
                this.enqueueControlHeader({ ...header, ty: FrameType.Pong });
                return;
            case FrameType.Goodbye:
                releaseQuietly(body);
                if (header.channel === 0) {
                    this.retire(
                        "connection_goodbye",
                        new SocketClosedError("host sent connection Goodbye"),
                    );
                } else {
                    this.handleRouteGoodbye(header.channel, header.epoch);
                }
                return;
            case FrameType.Push:
                releaseQuietly(body);
                this.droppedFrameCount++;
                return;
            case FrameType.Response:
            case FrameType.Error:
            case FrameType.StreamData:
            case FrameType.StreamEnd:
                this.dispatchToPending(header, body);
                return;
            default:
                releaseQuietly(body);
        }
    }

    private dispatchToPending(header: EnvelopeHeader, lease: ReceiveLease): void {
        const entry = this.pending.get(pendingKey(header.channel, header.epoch, header.corr));
        if (!entry) {
            releaseQuietly(lease);
            this.droppedFrameCount++;
            return;
        }
        if (header.ty === FrameType.StreamData) {
            if (entry.callerSettled) {
                releaseQuietly(lease);
                return;
            }
            entry.sawStream = true;
            if (entry.mode === "unary") {
                releaseQuietly(lease);
                return;
            }
            if (entry.streamItems.length >= entry.maxStreamItems) {
                releaseQuietly(lease);
                this.settleCallerReject(
                    entry,
                    new McHostCallError(
                        "terminal",
                        `stream exceeded ${entry.maxStreamItems} retained items`,
                        "stream_item_limit",
                    ),
                );
                this.finishEntry(entry);
                if (header.channel !== 0) {
                    this.enqueueCancel(header.channel, header.epoch, header.corr);
                }
                return;
            }
            let body: RequestReceiveBody;
            try {
                body = this.consumeResponseBody(entry, header, lease);
            } catch (error) {
                this.settleCallerReject(entry, error);
                this.finishEntry(entry);
                return;
            }
            entry.streamItems.push(body);
            if (!(body instanceof ReceiveLease)) {
                entry.heldBytes += body.byteLength;
                this.chargePending(body.byteLength);
            }
            return;
        }
        if (entry.callerSettled) {
            releaseQuietly(lease);
            this.finishEntry(entry);
            return;
        }
        if (header.ty === FrameType.Error) {
            const body = consumeJsonBody(lease);
            this.settleCallerResolve(entry, {
                kind: "error",
                body,
                flags: header.flags,
                stream: entry.mode === "stream" ? entry.streamItems : [],
                sawStream: entry.sawStream,
            });
        } else if (header.ty === FrameType.StreamEnd) {
            releaseQuietly(lease);
            if (entry.mode === "stream") {
                this.settleCallerResolve(entry, {
                    kind: "stream_end",
                    body: EMPTY_JSON_BODY,
                    flags: header.flags,
                    stream: entry.streamItems,
                    sawStream: entry.sawStream,
                });
            } else {
                this.settleCallerReject(
                    entry,
                    new McHostCallError(
                        "terminal",
                        "unary request received a stream; the sequence was drained privately",
                        "unexpected_stream",
                    ),
                );
            }
        } else {
            let body: RequestReceiveBody;
            try {
                body = this.consumeResponseBody(entry, header, lease);
            } catch (error) {
                this.settleCallerReject(entry, error);
                this.finishEntry(entry);
                return;
            }
            if (entry.mode === "unary" && entry.sawStream) {
                if (body instanceof ReceiveLease) releaseQuietly(body);
                this.settleCallerReject(
                    entry,
                    new McHostCallError(
                        "terminal",
                        "unary request received a stream before its Response",
                        "unexpected_stream",
                    ),
                );
            } else {
                this.settleCallerResolve(entry, {
                    kind: "response",
                    body,
                    flags: header.flags,
                    stream: entry.mode === "stream" ? entry.streamItems : [],
                    sawStream: entry.sawStream,
                });
            }
        }
        this.finishEntry(entry);
    }

    private consumeResponseBody(
        entry: PendingEntry,
        header: EnvelopeHeader,
        lease: ReceiveLease,
    ): RequestReceiveBody {
        if (flagsBinary(header.flags)) {
            if (entry.responseMode === "binary") return lease;
            releaseQuietly(lease);
            throw new McHostCallError(
                "terminal",
                "request received an unexpected binary body",
                "unexpected_binary_response",
            );
        }
        const body = consumeJsonBody(lease);
        if (entry.responseMode === "binary") {
            throw new McHostCallError(
                "terminal",
                "binary request received a JSON body",
                "expected_binary_response",
            );
        }
        return body;
    }

    private handleRouteGoodbye(channel: number, epoch: number): void {
        for (const entry of [...this.pending.values()]) {
            if (entry.channel !== channel || entry.epoch !== epoch) continue;
            if (!entry.writeInvoked && this.cancelQueuedFrame(entry)) {
                this.settleCallerReject(
                    entry,
                    new McHostCallError(
                        "not_sent",
                        "route closed by host before any request byte was written",
                        "route_gone",
                    ),
                );
            } else {
                this.settleCallerReject(
                    entry,
                    new McHostCallError(
                        "outcome_unknown",
                        "route closed by host (route Goodbye) before a matching terminal",
                        "route_gone",
                    ),
                );
            }
            this.finishEntry(entry);
        }
        try {
            this.onRouteGoodbyeHook?.(channel, epoch);
        } catch {
        }
    }

    /* */
    private settleCallerResolve(entry: PendingEntry, terminal: RequestTerminal): void {
        if (entry.callerSettled) return;
        entry.callerSettled = true;
        this.clearEntryDeadline(entry);
        if (entry.heldBytes > 0) {
            this.releasePending(entry.heldBytes);
            entry.heldBytes = 0;
        }
        entry.streamItems = [];
        entry.resolve(terminal);
    }

    private settleCallerReject(entry: PendingEntry, error: unknown): void {
        if (entry.callerSettled) return;
        entry.callerSettled = true;
        this.clearEntryDeadline(entry);
        entry.reject(error);
    }

    /* */
    private finishEntry(entry: PendingEntry): void {
        if (this.pending.get(entry.key) === entry) {
            this.pending.delete(entry.key);
        }
        this.clearEntryDeadline(entry);
        if (entry.heldBytes > 0) {
            this.releasePending(entry.heldBytes);
            entry.heldBytes = 0;
        }
        releaseReceiveBodies(entry.streamItems);
        entry.streamItems = [];
        this.resolveTicket(entry);
        if (this.pending.size === 0 && this.retiredInfo === null) {
            try {
                this.onPendingZeroHook?.();
            } catch {
            }
        }
    }

    private clearEntryDeadline(entry: PendingEntry): void {
        if (entry.cancelDeadlineTimer !== null) {
            entry.cancelDeadlineTimer();
            entry.cancelDeadlineTimer = null;
        }
    }

    private resolveTicket(entry: PendingEntry): void {
        const ticket = entry.ticket;
        if (!ticket || ticket.settled) return;
        ticket.settled = true;
        if (ticket.timer !== null) {
            this.disarmTimer(ticket.timer);
            ticket.timer = null;
        }
        ticket.resolve();
    }

    /**
     */
    private cancelQueuedFrame(entry: PendingEntry): boolean {
        const ticket = entry.sendTicket;
        if (!ticket) return false;
        entry.sendTicket = null;
        return ticket.cancel();
    }

    private onRequestDeadline(entry: PendingEntry): void {
        if (this.pending.get(entry.key) !== entry || entry.callerSettled) return;
        if (!entry.writeInvoked && this.cancelQueuedFrame(entry)) {
            this.settleCallerReject(
                entry,
                new McHostCallError(
                    "not_sent",
                    "request deadline expired before any byte was written",
                    "deadline_expired",
                ),
            );
        } else {
            this.settleCallerReject(
                entry,
                new McHostCallError(
                    "outcome_unknown",
                    "request deadline expired after a possible send without a terminal",
                    "deadline_expired",
                ),
            );
        }
        this.finishEntry(entry);
    }

    /**
     */
    private abortEntry(entry: PendingEntry): AbortHandle {
        if (this.pending.get(entry.key) !== entry || entry.callerSettled) {
            return { cleanup: entry.ticket ? entry.ticket.promise : Promise.resolve() };
        }
        if (!entry.writeInvoked && this.cancelQueuedFrame(entry)) {
            this.settleCallerReject(
                entry,
                new McHostCallError(
                    "not_sent",
                    "request aborted before any byte was written",
                    "aborted",
                ),
            );
            this.finishEntry(entry);
            return { cleanup: Promise.resolve() };
        }
        this.settleCallerReject(
            entry,
            new McHostCallError(
                "outcome_unknown",
                "request aborted after a possible send without a terminal",
                "aborted",
            ),
        );
        if (entry.heldBytes > 0) {
            this.releasePending(entry.heldBytes);
            entry.heldBytes = 0;
        }
        releaseReceiveBodies(entry.streamItems);
        entry.streamItems = [];
        let resolveTicket!: () => void;
        const promise = new Promise<void>((resolve) => {
            resolveTicket = resolve;
        });
        const ticket: CleanupTicket = {
            promise,
            resolve: resolveTicket,
            settled: false,
            timer: null,
        };
        ticket.timer = this.armTimer(this.cleanupTicketMs, () =>
            this.retire(
                "cleanup_deadline",
                new SocketTimeoutError("cleanup ticket deadline expired without a terminal"),
            ),
        );
        entry.ticket = ticket;
        return { cleanup: promise };
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private enqueueControlHeader(header: EnvelopeHeader): void {
        if (this.retiredInfo) return;
        this.channel.sendControl(header);
        if (this.retiredInfo) return;
        this.emitDiagnostic("enqueue", {
            ty: header.ty,
            channel: header.channel,
            epoch: header.epoch,
            corr: header.corr,
            len: 0,
        });
    }

    /**
     */
    flushWrites(deadline: Deadline): Promise<void> {
        return this.channel.flush(deadline);
    }

    private emitDiagnostic(type: ConnectionDiagnosticEvent["type"], meta: FrameMeta): void {
        const hook = this.onDiagnostic;
        if (!hook) return;
        try {
            hook({
                type,
                frameType: meta.ty,
                channel: meta.channel,
                epoch: meta.epoch,
                corr: meta.corr,
                len: meta.len,
            });
        } catch {
        }
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private chargePending(bytes: number): void {
        this.pendingHeld += bytes;
        this.budget.charge(bytes);
    }

    private releasePending(bytes: number): void {
        if (this.retiredInfo) return;
        this.pendingHeld -= bytes;
        this.budget.release(bytes);
    }

    // ------------------------------------------------------------------
    // Timers.
    // ------------------------------------------------------------------

    private armTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
        const timer = setTimeout(
            () => {
                this.timers.delete(timer);
                if (!this.retiredInfo) fn();
            },
            Math.max(0, ms),
        );
        this.timers.add(timer);
        return timer;
    }

    /**
     */
    private armDeadlineTimer(deadline: Deadline, fn: () => void): () => void {
        return armExpiryTimer(deadline, fn, {
            schedule: (fire, ms) => this.armTimer(ms, fire),
            cancel: (handle) => this.disarmTimer(handle as ReturnType<typeof setTimeout>),
        });
    }

    private disarmTimer(timer: ReturnType<typeof setTimeout>): void {
        clearTimeout(timer);
        this.timers.delete(timer);
    }
}
