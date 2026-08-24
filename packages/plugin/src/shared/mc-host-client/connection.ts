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

import { AuthError } from "./auth";
import { armExpiryTimer, type Deadline } from "./deadline";
import { SocketClosedError, SocketTimeoutError, SubcCallError } from "./errors";
import {
    ByteBudget,
    type FrameChannelCloseReason,
    type FrameChannelHandlers,
    type FrameMeta,
    type FrameSendTicket,
    type SetupFrameChannel,
} from "./frame-channel";
import {
    buildFlags,
    type EnvelopeHeader,
    FrameType,
    MAX_CORRELATION,
    MAX_FRAME_BODY_LEN,
    PROTOCOL_VERSION,
} from "./protocol";
import { TcpFrameChannel } from "./tcp-frame-channel";
import { AdmissionClass, Priority } from "./types";

const DEFAULT_CLEANUP_TICKET_MS = 5_000;
/**
 * How long setup lets a retired channel's `start()` settle before the
 * retirement cause wins the race: long enough for a rejection triggered by
 * the same event-loop turn as the retirement, short enough that a provider
 * promise that never settles cannot meaningfully extend teardown.
 */
const RETIREMENT_SETTLE_GRACE_MS = 50;
/**
 * Fixed header/control overhead admitted above one maximum body (KTD7): the
 * aggregate cap must still accept one exact 64 MiB frame plus headers,
 * reserved control frames, and small control-plane bodies.
 */
const DEFAULT_MEMORY_OVERHEAD_BYTES = 1_048_576;
const EMPTY_BODY = new Uint8Array(0);

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
    | "ambiguous_route_open"
    | "negotiation_failed"
    | "owner_close";

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

/** One observed matching terminal. `stream` holds stream-mode StreamData bodies. */
export interface RequestTerminal {
    kind: "response" | "error" | "stream_end";
    body: Uint8Array;
    flags: number;
    stream: Uint8Array[];
}

export interface RequestParams {
    channel: number;
    epoch: number;
    body: Uint8Array;
    /** Absolute operation deadline; covers queueing, writing, and terminal wait. */
    deadline: Deadline;
    mode?: PendingMode;
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
    host: string;
    port: number;
    credentials: { key: Uint8Array; daemonId: Uint8Array };
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
    /** Nonce source passthrough to U2's handshake. */
    generateNonce?: (length: number) => Uint8Array;
    onRetired?: (info: RetirementInfo) => void;
    /** Route Goodbye events; the generation owns no route cache (KTD6). */
    onRouteGoodbye?: (channel: number, epoch: number) => void;
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
    writeInvoked: boolean;
    callerSettled: boolean;
    sawStream: boolean;
    streamItems: Uint8Array[];
    heldBytes: number;
    resolve: (terminal: RequestTerminal) => void;
    reject: (error: unknown) => void;
    /** Cancels the deadline timer chain; stays valid across re-arms. */
    cancelDeadlineTimer: (() => void) | null;
    sendTicket: FrameSendTicket | null;
    ticket: CleanupTicket | null;
}

function pendingKey(channel: number, epoch: number, corr: bigint): string {
    return `${channel}:${epoch}:${corr}`;
}

/**
 * The sole pending-entry, correlation, and terminal owner for one
 * connection generation (KTD6); its `TcpFrameChannel` owns the transport.
 * Construct, then `start()` exactly once; every setup failure routes
 * through the same idempotent retirement.
 */
export class ConnectionGeneration {
    readonly retired: Promise<RetirementInfo>;
    /** Server-reported daemon version after a successful handshake. */
    daemonVer: string | null = null;

    private readonly channel: SetupFrameChannel;
    private readonly budget: ByteBudget;
    private readonly cleanupTicketMs: number;
    private readonly onRetired?: (info: RetirementInfo) => void;
    private readonly onRouteGoodbyeHook?: (channel: number, epoch: number) => void;
    private readonly onDiagnostic?: (event: ConnectionDiagnosticEvent) => void;

    private retiredInfo: RetirementInfo | null = null;
    private resolveRetired!: (info: RetirementInfo) => void;
    private startState: "idle" | "started" = "idle";
    private phase: "setup" | "frames" = "setup";
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();

    // Consumer correlation namespace (host Ping correlations are never stored).
    private nextCorr: bigint;
    private corrExhausted = false;

    private readonly pending = new Map<string, PendingEntry>();
    private droppedFrameCount = 0;

    // Pending-retention share of the one aggregate budget (KTD7).
    private pendingHeld = 0;

    constructor(options: ConnectionGenerationOptions) {
        const maxBodyLen = options.maxBodyLen ?? MAX_FRAME_BODY_LEN;
        this.budget = new ByteBudget(
            options.memoryCapBytes ?? maxBodyLen + DEFAULT_MEMORY_OVERHEAD_BYTES,
        );
        this.cleanupTicketMs = options.cleanupTicketMs ?? DEFAULT_CLEANUP_TICKET_MS;
        this.onRetired = options.onRetired;
        this.onRouteGoodbyeHook = options.onRouteGoodbye;
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
        };
        this.channel = options.channelFactory
            ? options.channelFactory({ budget: this.budget, maxBodyLen, handlers })
            : new TcpFrameChannel({
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
    }

    /**
     * Single-flight dial + authentication under `deadline`. Any failure
     * (dial error, auth failure, deadline) retires the generation exactly
     * once and rejects; no socket or timer survives a failed setup.
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
                // An auth-layer deadline observation is the same owner-budget
                // exhaustion the setup timer reports: auth I/O that completes
                // after expiry but before the timer callback runs must not
                // masquerade as an authentication failure.
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
            droppedFrames: this.droppedFrameCount,
            activeTimers: this.timers.size + channel.activeTimers,
            readPaused: channel.readPaused,
            retired: this.retiredInfo !== null,
        };
    }

    /**
     * Synchronously admit one Request to the channel's writer FIFO and
     * allocate its correlation with admission (KTD7), so writer-enqueue
     * order equals correlation order. Throws a `not_sent` SubcCallError
     * when admission is refused; nothing was allocated or queued in that
     * case.
     */
    request(params: RequestParams): PendingRequest {
        if (this.retiredInfo) {
            throw new SubcCallError(
                "not_sent",
                `connection generation is retired (${this.retiredInfo.reason})`,
                "connection_retired",
            );
        }
        if (this.phase !== "frames") {
            throw new SubcCallError(
                "not_sent",
                "connection generation has not completed setup",
                "connection_not_ready",
            );
        }
        if (this.corrExhausted) {
            throw new SubcCallError(
                "not_sent",
                "correlation space exhausted after u64::MAX; retire the generation",
                "correlations_exhausted",
            );
        }
        if (params.deadline.isExpired()) {
            throw new SubcCallError(
                "not_sent",
                "request deadline expired before queue admission",
                "deadline_expired",
            );
        }
        const flags = buildFlags(
            false,
            params.priority ?? Priority.Interactive,
            false,
            params.admissionClass ?? AdmissionClass.Normal,
        );
        const corr = this.nextCorr;
        const header: EnvelopeHeader = {
            len: params.body.length,
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
        // Rejections are always meaningful to the caller, but a caller that
        // aborted (or a test tearing down) may not await; keep the runtime
        // from reporting them as unhandled.
        result.catch(() => {});
        const entry: PendingEntry = {
            key,
            channel: params.channel,
            epoch: params.epoch,
            corr,
            mode: params.mode ?? "unary",
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
        // The entry is registered before channel admission so a synchronous
        // channel failure mid-publication settles it through retirement.
        this.pending.set(key, entry);
        let ticket: FrameSendTicket;
        try {
            // The channel validates the encoded header and refuses a full
            // queue or an over-cap frame BEFORE any state changes, so the
            // correlation is committed only after successful admission.
            ticket = this.channel.send(
                { header, body: params.body },
                {
                    // KTD4 possible-send boundary: fired immediately before
                    // socket.write() is invoked for any of this frame's bytes.
                    onPublish: () => {
                        entry.writeInvoked = true;
                    },
                },
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
            len: params.body.length,
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

    /** Best-effort correlation-scoped routed Cancel through reserved capacity. */
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

    /** Route Goodbye: nonzero channel, current epoch, correlation 0. */
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

    /** Connection Goodbye: channel 0, epoch 0, correlation 0. */
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
     * Idempotent retirement: freezes the shared budget, clears every
     * generation timer, settles each pending identity exactly once (queued
     * work `not_sent`, invoked work `outcome_unknown`), completes all
     * cleanup tickets, discards the channel (which destroys the socket),
     * and emits exactly one notification. Every late listener, callback,
     * and timer becomes a no-op.
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
                        new SubcCallError(
                            "outcome_unknown",
                            `connection generation retired (${reason}) after a possible send`,
                            "generation_retired",
                            error,
                        ),
                    );
                } else {
                    entry.reject(
                        new SubcCallError(
                            "not_sent",
                            `connection generation retired (${reason}) before any byte was written`,
                            "generation_retired",
                            error,
                        ),
                    );
                }
            }
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
    // Setup: channel dial + auth, then frame delivery.
    // ------------------------------------------------------------------

    private async setup(deadline: Deadline): Promise<void> {
        const cancelSetupTimer = this.armDeadlineTimer(deadline, () =>
            this.retire(
                "setup_deadline",
                new SocketTimeoutError("connection setup deadline expired"),
            ),
        );
        try {
            // Raced against retirement: a provider channel whose start()
            // never settles — or ignores the close() that retirement issues
            // — must not strand setup after the timer above has already
            // retired this generation. Retirement waits one grace beat
            // before winning: a start() rejection caused by the same
            // failure (the auth reader observing the socket close) settles
            // within the window and keeps its richer classification, and
            // both branches attach handlers, so no promise is left
            // unhandled.
            const result = await new Promise<{ daemonVer: string }>((resolve, reject) => {
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
                    (value) => settle(() => resolve(value)),
                    (error: unknown) =>
                        settle(() =>
                            reject(error instanceof Error ? error : new Error(String(error))),
                        ),
                );
            });
            if (this.retiredInfo) {
                // A channel that ignored close() can still resolve start()
                // inside the grace window; a success after retirement must
                // surface the stored retirement cause, not a fresh generic
                // close error.
                const cause = this.retiredInfo.error;
                throw cause instanceof Error
                    ? cause
                    : new SocketClosedError(
                          `connection retired during setup: ${this.retiredInfo.reason}`,
                      );
            }
            this.daemonVer = result.daemonVer;
            this.phase = "frames";
        } finally {
            cancelSetupTimer();
        }
        // Auth-leftover bytes (a frame coalesced into the final handshake
        // chunk) dispatch here, before setup returns.
        this.channel.beginFrames();
    }

    // ------------------------------------------------------------------
    // Frame dispatch and pending-entry settlement.
    // ------------------------------------------------------------------

    private dispatch(header: EnvelopeHeader, body: Uint8Array): void {
        this.emitDiagnostic("dispatch", {
            ty: header.ty,
            channel: header.channel,
            epoch: header.epoch,
            corr: header.corr,
            len: body.length,
        });
        switch (header.ty) {
            case FrameType.Ping:
                // Echo version, flags, channel, epoch, and correlation via
                // reserved control capacity. Host correlations are a fully
                // separate namespace: nothing is stored or matched here.
                this.enqueueControlHeader({ ...header, ty: FrameType.Pong });
                return;
            case FrameType.Goodbye:
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
                // Compatibility-only: decoded and fenced; no route cache here.
                this.droppedFrameCount++;
                return;
            case FrameType.Response:
            case FrameType.Error:
            case FrameType.StreamData:
            case FrameType.StreamEnd:
                this.dispatchToPending(header, body);
                return;
            default:
                return;
        }
    }

    private dispatchToPending(header: EnvelopeHeader, body: Uint8Array): void {
        // Route epoch is part of the key, so a stale-epoch frame can never
        // reach a live entry; stale/unmatched/duplicate/post-terminal
        // ingress all land here and are dropped.
        const entry = this.pending.get(pendingKey(header.channel, header.epoch, header.corr));
        if (!entry) {
            this.droppedFrameCount++;
            return;
        }
        if (header.ty === FrameType.StreamData) {
            if (entry.callerSettled) return;
            entry.sawStream = true;
            if (entry.mode === "stream") {
                entry.streamItems.push(body);
                entry.heldBytes += body.length;
                this.chargePending(body.length);
            }
            // Unary mode drains a legal stream privately: bytes are dropped.
            return;
        }
        // Terminal: Response, Error, or StreamEnd.
        if (entry.callerSettled) {
            this.finishEntry(entry);
            return;
        }
        if (header.ty === FrameType.Error) {
            this.settleCallerResolve(entry, {
                kind: "error",
                body,
                flags: header.flags,
                stream: entry.mode === "stream" ? entry.streamItems : [],
            });
        } else if (header.ty === FrameType.StreamEnd) {
            if (entry.mode === "stream") {
                this.settleCallerResolve(entry, {
                    kind: "stream_end",
                    body: EMPTY_BODY,
                    flags: header.flags,
                    stream: entry.streamItems,
                });
            } else {
                this.settleCallerReject(
                    entry,
                    new SubcCallError(
                        "terminal",
                        "unary request received a stream; the sequence was drained privately",
                        "unexpected_stream",
                    ),
                );
            }
        } else if (entry.mode === "unary" && entry.sawStream) {
            this.settleCallerReject(
                entry,
                new SubcCallError(
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
            });
        }
        this.finishEntry(entry);
    }

    private handleRouteGoodbye(channel: number, epoch: number): void {
        for (const entry of [...this.pending.values()]) {
            if (entry.channel !== channel || entry.epoch !== epoch) continue;
            if (!entry.writeInvoked) {
                this.cancelQueuedFrame(entry);
                this.settleCallerReject(
                    entry,
                    new SubcCallError(
                        "not_sent",
                        "route closed by host before any request byte was written",
                        "route_gone",
                    ),
                );
            } else {
                this.settleCallerReject(
                    entry,
                    new SubcCallError(
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
            // Observer exceptions must not affect protocol progress.
        }
    }

    /** Settle the caller result exactly once (identity guard on the flag). */
    private settleCallerResolve(entry: PendingEntry, terminal: RequestTerminal): void {
        if (entry.callerSettled) return;
        entry.callerSettled = true;
        this.clearEntryDeadline(entry);
        // Stream-item ownership transfers to the caller with the terminal.
        if (entry.heldBytes > 0) {
            this.releasePending(entry.heldBytes);
            entry.heldBytes = 0;
        }
        entry.resolve(terminal);
    }

    private settleCallerReject(entry: PendingEntry, error: unknown): void {
        if (entry.callerSettled) return;
        entry.callerSettled = true;
        this.clearEntryDeadline(entry);
        entry.reject(error);
    }

    /** Remove a settled/abandoned entry and complete its cleanup ticket. */
    private finishEntry(entry: PendingEntry): void {
        if (this.pending.get(entry.key) === entry) {
            this.pending.delete(entry.key);
        }
        this.clearEntryDeadline(entry);
        if (entry.heldBytes > 0) {
            this.releasePending(entry.heldBytes);
            entry.heldBytes = 0;
        }
        entry.streamItems = [];
        this.resolveTicket(entry);
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

    /** Remove the entry's frame from the channel queue while still unpublished. */
    private cancelQueuedFrame(entry: PendingEntry): void {
        const ticket = entry.sendTicket;
        if (!ticket) return;
        entry.sendTicket = null;
        ticket.cancel();
    }

    private onRequestDeadline(entry: PendingEntry): void {
        if (this.pending.get(entry.key) !== entry || entry.callerSettled) return;
        if (!entry.writeInvoked) {
            this.cancelQueuedFrame(entry);
            this.settleCallerReject(
                entry,
                new SubcCallError(
                    "not_sent",
                    "request deadline expired before any byte was written",
                    "deadline_expired",
                ),
            );
        } else {
            this.settleCallerReject(
                entry,
                new SubcCallError(
                    "outcome_unknown",
                    "request deadline expired after a possible send without a terminal",
                    "deadline_expired",
                ),
            );
        }
        this.finishEntry(entry);
    }

    /**
     * Caller abort (KTD10). Pre-write: remove the queued frame and settle
     * both caller and ticket as done (`not_sent`). Post-write: settle the
     * caller `outcome_unknown` immediately and return a cleanup ticket that
     * resolves on the original terminal, generation retirement, or its own
     * bounded deadline — whose expiry forces retirement.
     */
    private abortEntry(entry: PendingEntry): AbortHandle {
        if (this.pending.get(entry.key) !== entry || entry.callerSettled) {
            return { cleanup: entry.ticket ? entry.ticket.promise : Promise.resolve() };
        }
        if (!entry.writeInvoked) {
            this.cancelQueuedFrame(entry);
            this.settleCallerReject(
                entry,
                new SubcCallError(
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
            new SubcCallError(
                "outcome_unknown",
                "request aborted after a possible send without a terminal",
                "aborted",
            ),
        );
        // Drained-in-private stream items are dropped with the abort.
        if (entry.heldBytes > 0) {
            this.releasePending(entry.heldBytes);
            entry.heldBytes = 0;
            entry.streamItems = [];
        }
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
    // Control frames and graceful finish over the channel.
    // ------------------------------------------------------------------

    private enqueueControlHeader(header: EnvelopeHeader): void {
        if (this.retiredInfo) return;
        this.channel.sendControl(header);
        // A refused control frame failed the channel (and retired this
        // generation) synchronously; only an admitted frame is reported.
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
     * Resolve once every queued frame byte has been handed to the socket and
     * every write callback fired, the generation retires, or `deadline`
     * expires — a bounded, best-effort primitive for the facade's awaitable
     * Goodbye teardown. Never blocks retirement.
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
            // Observer exceptions must never affect protocol work (KTD12).
        }
    }

    // ------------------------------------------------------------------
    // Pending-retention share of the one aggregate budget (KTD7).
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
     * Deadline-bound timer whose callback implies `deadline.isExpired()`.
     * Request and setup deadline errors feed replay-token gates that
     * re-sample `isExpired()`; a single-shot timer can fire fractionally
     * early and let the token spend a spurious extra attempt. Re-arms
     * stay inside the retirement-gated tracked timer set. The returned
     * cancel function stays valid across re-arms.
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
