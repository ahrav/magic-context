/**
 * Bounded connection-generation engine.
 *
 * One `ConnectionGeneration` owns the `node:net` socket, dial, the auth
 * byte-I/O adaptation over U2's pure handshake, the incremental frame
 * reader, the single bounded FIFO writer, correlation allocation, pending
 * entries, aggregate memory accounting, and one idempotent retirement path.
 * It owns no route cache and no reconnect policy; the facade layer above
 * reacts to retirement but is never imported here.
 *
 * Send-outcome boundary: a queued request is classified `not_sent`
 * until the writer invokes `socket.write()` for any of its bytes. After
 * invocation, only a matching terminal frame is authoritative; losing the
 * terminal (retirement, timeout, abort, EOF, error, close) classifies the
 * request `outcome_unknown`. A successful write callback proves local
 * handling only, never peer receipt.
 */

import { Socket } from "node:net";
import { type AuthByteIo, AuthError, authenticateClient } from "./auth";
import { armExpiryTimer, type Deadline } from "./deadline";
import { SocketClosedError, SocketTimeoutError, SubcCallError } from "./errors";
import {
    buildFlags,
    DecodeError,
    decodeHeader,
    type EnvelopeHeader,
    encodeHeader,
    FROZEN_PREFIX_LEN,
    FrameType,
    HEADER_LEN,
    isLegalHostToConsumerType,
    MAX_CORRELATION,
    MAX_FRAME_BODY_LEN,
    PROTOCOL_VERSION,
} from "./protocol";
import { AdmissionClass, Priority } from "./types";

/** Idle header wait is unbounded; this bounds one frame once its first header byte arrives. */
const DEFAULT_FRAME_DEADLINE_MS = 30_000;
const DEFAULT_MAX_QUEUED_FRAMES = 256;
/** Reserved writer slots for pure-header Pong/Cancel/Goodbye cleanup frames. */
const DEFAULT_CONTROL_RESERVE_FRAMES = 32;
const DEFAULT_CLEANUP_TICKET_MS = 5_000;
/**
 * Hard cap on pre-handshake buffering. Auth messages are a `u32` length plus
 * at most 4,096 bytes each, so a legal exchange never approaches this; the
 * aggregate memory cap only covers frame bodies and cannot bound this phase.
 */
const MAX_AUTH_BUFFERED_BYTES = 65_536;
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

/** Header identity retained for diagnostics events about one queued frame. */
interface FrameMeta {
    ty: number;
    channel: number;
    epoch: number;
    corr: bigint;
    len: number;
}

interface QueuedItem {
    /** Header buffer, then optionally the body buffer; written in order. */
    buffers: Buffer[];
    bytes: number;
    control: boolean;
    entry: PendingEntry | null;
    meta: FrameMeta | null;
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
    queuedItem: QueuedItem | null;
    ticket: CleanupTicket | null;
}

function pendingKey(channel: number, epoch: number, corr: bigint): string {
    return `${channel}:${epoch}:${corr}`;
}

function asBuffer(bytes: Uint8Array): Buffer {
    return Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Header-only legality beyond `validateHeader`: direction and the direct
 * profile's identity/body rules that are decidable BEFORE body allocation
 * (wire doc Section 6.2 table). A violation retires without resync.
 */
function headerViolation(
    header: EnvelopeHeader,
): { reason: RetirementReason; detail: string } | null {
    if (!isLegalHostToConsumerType(header.ty)) {
        return { reason: "role_violation", detail: `role-invalid frame type ${header.ty}` };
    }
    switch (header.ty) {
        case FrameType.Response:
        case FrameType.Error:
        case FrameType.StreamData:
        case FrameType.StreamEnd:
            if (header.corr === 0n) {
                return {
                    reason: "protocol_violation",
                    detail: "terminal/stream frame with corr 0",
                };
            }
            if (header.ty === FrameType.StreamEnd && header.len !== 0) {
                return { reason: "protocol_violation", detail: "StreamEnd with a non-empty body" };
            }
            return null;
        case FrameType.Ping:
            if (header.channel !== 0 || header.corr === 0n) {
                return {
                    reason: "protocol_violation",
                    detail: "Ping outside 0/0/nonzero identity",
                };
            }
            return null;
        case FrameType.Push:
            if (header.corr !== 0n || header.channel === 0) {
                return {
                    reason: "protocol_violation",
                    detail: "Push outside routed corr-0 identity",
                };
            }
            return null;
        case FrameType.Goodbye:
            if (header.corr !== 0n) {
                return { reason: "protocol_violation", detail: "Goodbye with nonzero correlation" };
            }
            return null;
        default:
            return null;
    }
}

/**
 * The sole `net.Socket`, frame, pending-entry, memory, and terminal owner
 * for one connection generation (KTD6). Construct, then `start()` exactly
 * once; every setup failure routes through the same idempotent retirement.
 */
export class ConnectionGeneration {
    readonly retired: Promise<RetirementInfo>;
    /** Server-reported daemon version after a successful handshake. */
    daemonVer: string | null = null;

    private readonly socket: Socket;
    private readonly host: string;
    private readonly port: number;
    private readonly credentials: { key: Uint8Array; daemonId: Uint8Array };
    private readonly frameDeadlineMs: number;
    private readonly maxBodyLen: number;
    private readonly memoryCap: number;
    private readonly maxQueuedFrames: number;
    private readonly maxQueuedBytes: number;
    private readonly controlReserveFrames: number;
    private readonly cleanupTicketMs: number;
    private readonly generateNonce?: (length: number) => Uint8Array;
    private readonly onRetired?: (info: RetirementInfo) => void;
    private readonly onRouteGoodbyeHook?: (channel: number, epoch: number) => void;
    private readonly onDiagnostic?: (event: ConnectionDiagnosticEvent) => void;

    private retiredInfo: RetirementInfo | null = null;
    private resolveRetired!: (info: RetirementInfo) => void;
    private startState: "idle" | "started" = "idle";
    private phase: "setup" | "frames" = "setup";
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();

    // Auth-phase byte buffering (the socket adapted to U2's AuthByteIo).
    private authChunks: Buffer[] = [];
    private authOffset = 0;
    private authBuffered = 0;
    private authWaiter: {
        need: number;
        resolve: (bytes: Uint8Array) => void;
        reject: (error: unknown) => void;
    } | null = null;

    // Incremental frame reader.
    private inbox: Buffer[] = [];
    private inboxOffset = 0;
    private inboxBuffered = 0;
    private readonly headerBuf = Buffer.alloc(HEADER_LEN);
    private headerFilled = 0;
    private versionChecked = false;
    private bodyHeader: EnvelopeHeader | null = null;
    private bodyBuf: Buffer | null = null;
    private bodyFilled = 0;
    private deferredHeader: EnvelopeHeader | null = null;
    private frameTimer: ReturnType<typeof setTimeout> | null = null;
    private readPaused = false;

    // Single bounded FIFO writer.
    private queue: QueuedItem[] = [];
    private readonly flushWaiters: {
        resolve: () => void;
        timer: ReturnType<typeof setTimeout>;
    }[] = [];
    private dataFramesQueued = 0;
    private dataBytesQueued = 0;
    private controlFramesQueued = 0;
    private pumping = false;
    private awaitingDrain = false;
    private currentItem: { item: QueuedItem; index: number } | null = null;

    // Consumer correlation namespace (host Ping correlations are never stored).
    private nextCorr: bigint;
    private corrExhausted = false;

    private readonly pending = new Map<string, PendingEntry>();
    private droppedFrameCount = 0;

    // One aggregate memory owner (KTD7).
    private memUsed = 0;
    private memPeak = 0;
    private readerHeld = 0;
    private queueHeld = 0;
    private pendingHeld = 0;

    constructor(options: ConnectionGenerationOptions) {
        this.host = options.host;
        this.port = options.port;
        this.credentials = options.credentials;
        this.frameDeadlineMs = options.frameDeadlineMs ?? DEFAULT_FRAME_DEADLINE_MS;
        this.maxBodyLen = options.maxBodyLen ?? MAX_FRAME_BODY_LEN;
        this.memoryCap = options.memoryCapBytes ?? this.maxBodyLen + DEFAULT_MEMORY_OVERHEAD_BYTES;
        this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
        this.maxQueuedBytes = options.maxQueuedBytes ?? this.maxBodyLen + 65_536;
        this.controlReserveFrames = options.controlReserveFrames ?? DEFAULT_CONTROL_RESERVE_FRAMES;
        this.cleanupTicketMs = options.cleanupTicketMs ?? DEFAULT_CLEANUP_TICKET_MS;
        this.generateNonce = options.generateNonce;
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
        this.socket = new Socket();
        // Every lifecycle listener is attached before connect() is invoked.
        this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
        this.socket.on("end", () =>
            this.retire("eof", new SocketClosedError("peer closed the connection")),
        );
        this.socket.on("error", (error: Error) => this.retire("socket_error", error));
        this.socket.on("close", () =>
            this.retire("socket_closed", new SocketClosedError("connection closed")),
        );
        this.socket.on("timeout", () =>
            this.retire("socket_timeout", new SocketTimeoutError("socket inactivity timeout")),
        );
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
                this.retire(error instanceof AuthError ? "auth_failed" : "setup_failed", error);
            }
            throw error;
        }
    }

    isRetired(): boolean {
        return this.retiredInfo !== null;
    }

    stats(): ConnectionStats {
        return {
            memoryUsed: this.memUsed,
            memoryPeak: this.memPeak,
            memoryCap: this.memoryCap,
            readerHeldBytes: this.readerHeld,
            queueHeldBytes: this.queueHeld,
            pendingHeldBytes: this.pendingHeld,
            queuedDataFrames: this.dataFramesQueued,
            queuedControlFrames: this.controlFramesQueued,
            pendingRequests: this.pending.size,
            droppedFrames: this.droppedFrameCount,
            activeTimers: this.timers.size,
            readPaused: this.readPaused,
            retired: this.retiredInfo !== null,
        };
    }

    /**
     * Synchronously admit one Request to the writer FIFO and allocate its
     * correlation with admission (KTD7), so writer-enqueue order equals
     * correlation order. Throws a `not_sent` SubcCallError when admission
     * is refused; nothing was allocated or queued in that case.
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
        const body = asBuffer(params.body);
        const flags = buildFlags(
            false,
            params.priority ?? Priority.Interactive,
            false,
            params.admissionClass ?? AdmissionClass.Normal,
        );
        const corr = this.nextCorr;
        // Encoding validates every header field before the correlation is
        // committed, so a rejected request can never burn a correlation.
        const headerBytes = Buffer.from(
            encodeHeader({
                len: body.length,
                ver: PROTOCOL_VERSION,
                ty: FrameType.Request,
                flags,
                channel: params.channel,
                epoch: params.epoch,
                corr,
            }),
        );
        const totalBytes = HEADER_LEN + body.length;
        if (
            this.dataFramesQueued + 1 > this.maxQueuedFrames ||
            this.dataBytesQueued + totalBytes > this.maxQueuedBytes
        ) {
            throw new SubcCallError("not_sent", "writer queue is full", "writer_queue_full");
        }
        if (this.memUsed + totalBytes > this.memoryCap) {
            throw new SubcCallError(
                "not_sent",
                "aggregate connection memory cap would be exceeded",
                "memory_cap",
            );
        }
        if (corr === MAX_CORRELATION) {
            this.corrExhausted = true;
        } else {
            this.nextCorr = corr + 1n;
        }
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
            queuedItem: null,
            ticket: null,
        };
        const meta: FrameMeta = {
            ty: FrameType.Request,
            channel: params.channel,
            epoch: params.epoch,
            corr,
            len: body.length,
        };
        const item: QueuedItem = {
            buffers: body.length > 0 ? [headerBytes, body] : [headerBytes],
            bytes: totalBytes,
            control: false,
            entry,
            meta,
        };
        entry.queuedItem = item;
        this.pending.set(key, entry);
        entry.cancelDeadlineTimer = this.armDeadlineTimer(params.deadline, () =>
            this.onRequestDeadline(entry),
        );
        this.enqueueItem(item);
        this.emitDiagnostic("enqueue", meta);
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
     * Idempotent retirement: snapshots queued-versus-invoked work, clears
     * every timer, settles each pending identity exactly once (queued work
     * `not_sent`, invoked work `outcome_unknown`), completes all cleanup
     * tickets, destroys the socket, and emits exactly one notification.
     * Every late listener, callback, and timer becomes a no-op.
     */
    retire(reason: RetirementReason, error?: unknown): void {
        if (this.retiredInfo) return;
        const info: RetirementInfo = Object.freeze({ reason, error });
        this.retiredInfo = info;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.frameTimer = null;
        if (this.authWaiter) {
            const waiter = this.authWaiter;
            this.authWaiter = null;
            waiter.reject(
                error instanceof Error
                    ? error
                    : new SocketClosedError(`connection retired during setup: ${reason}`),
            );
        }
        this.queue = [];
        this.currentItem = null;
        this.dataFramesQueued = 0;
        this.dataBytesQueued = 0;
        this.controlFramesQueued = 0;
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
        for (const waiter of this.flushWaiters.splice(0)) {
            waiter.resolve();
        }
        this.inbox = [];
        this.inboxOffset = 0;
        this.inboxBuffered = 0;
        this.authChunks = [];
        this.authOffset = 0;
        this.authBuffered = 0;
        this.bodyHeader = null;
        this.bodyBuf = null;
        this.bodyFilled = 0;
        this.deferredHeader = null;
        this.memUsed = 0;
        this.readerHeld = 0;
        this.queueHeld = 0;
        this.pendingHeld = 0;
        this.socket.destroy();
        this.resolveRetired(info);
        try {
            this.onRetired?.(info);
        } catch {
            // Observer exceptions must not affect retirement.
        }
    }

    // ------------------------------------------------------------------
    // Setup: dial + auth byte-I/O adaptation.
    // ------------------------------------------------------------------

    private async setup(deadline: Deadline): Promise<void> {
        const cancelSetupTimer = this.armDeadlineTimer(deadline, () =>
            this.retire(
                "setup_deadline",
                new SocketTimeoutError("connection setup deadline expired"),
            ),
        );
        try {
            await this.waitForConnect();
            this.socket.setNoDelay(true);
            const result = await authenticateClient(
                this.createAuthIo(),
                this.credentials,
                deadline,
                { generateNonce: this.generateNonce },
            );
            if (this.retiredInfo) {
                throw new SocketClosedError(
                    `connection retired during setup: ${this.retiredInfo.reason}`,
                );
            }
            this.daemonVer = result.daemonVer;
            this.phase = "frames";
            this.moveAuthLeftoverToInbox();
        } finally {
            cancelSetupTimer();
        }
        this.processInbox();
    }

    private waitForConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onConnect = (): void => resolve();
            this.socket.once("connect", onConnect);
            void this.retired.then((info) => {
                this.socket.removeListener("connect", onConnect);
                reject(
                    info.error instanceof Error
                        ? info.error
                        : new SocketClosedError(`connection retired during dial: ${info.reason}`),
                );
            });
            this.socket.connect({ host: this.host, port: this.port });
        });
    }

    private createAuthIo(): AuthByteIo {
        return {
            readExact: (n: number, _deadline: Deadline): Promise<Uint8Array> =>
                new Promise((resolve, reject) => {
                    if (this.retiredInfo) {
                        reject(
                            new SocketClosedError(
                                `connection retired during setup: ${this.retiredInfo.reason}`,
                            ),
                        );
                        return;
                    }
                    if (this.authWaiter) {
                        reject(new Error("concurrent auth readExact is not supported"));
                        return;
                    }
                    this.authWaiter = { need: n, resolve, reject };
                    this.serveAuthWaiter();
                }),
            write: (bytes: Uint8Array, _deadline: Deadline): Promise<void> =>
                new Promise((resolve, reject) => {
                    if (this.retiredInfo) {
                        reject(
                            new SocketClosedError(
                                `connection retired during setup: ${this.retiredInfo.reason}`,
                            ),
                        );
                        return;
                    }
                    try {
                        this.socket.write(asBuffer(bytes), (error) => {
                            if (error) reject(error);
                            else resolve();
                        });
                    } catch (error) {
                        reject(error);
                    }
                }),
        };
    }

    private serveAuthWaiter(): void {
        const waiter = this.authWaiter;
        if (!waiter || this.authBuffered < waiter.need) return;
        const out = Buffer.allocUnsafe(waiter.need);
        let copied = 0;
        while (copied < waiter.need) {
            const head = this.authChunks[0] as Buffer;
            const available = head.length - this.authOffset;
            const take = Math.min(available, waiter.need - copied);
            head.copy(out, copied, this.authOffset, this.authOffset + take);
            copied += take;
            this.authOffset += take;
            if (this.authOffset === head.length) {
                this.authChunks.shift();
                this.authOffset = 0;
            }
        }
        this.authBuffered -= waiter.need;
        this.authWaiter = null;
        waiter.resolve(out);
    }

    private moveAuthLeftoverToInbox(): void {
        while (this.authChunks.length > 0) {
            const head = this.authChunks.shift() as Buffer;
            const rest = this.authOffset > 0 ? head.subarray(this.authOffset) : head;
            this.authOffset = 0;
            if (rest.length > 0) {
                this.inbox.push(rest);
                this.inboxBuffered += rest.length;
            }
        }
        this.authBuffered = 0;
    }

    // ------------------------------------------------------------------
    // Incremental frame reader.
    // ------------------------------------------------------------------

    private onData(chunk: Buffer): void {
        if (this.retiredInfo) return;
        if (this.phase === "setup") {
            this.authChunks.push(chunk);
            this.authBuffered += chunk.length;
            if (this.authBuffered > MAX_AUTH_BUFFERED_BYTES) {
                this.retire(
                    "protocol_violation",
                    new AuthError(
                        "peer streamed more pre-handshake bytes than any legal auth exchange",
                        "message_too_large",
                    ),
                );
                return;
            }
            this.serveAuthWaiter();
            return;
        }
        this.inbox.push(chunk);
        this.inboxBuffered += chunk.length;
        this.processInbox();
    }

    private takeFromInbox(dest: Buffer, destOffset: number, want: number): number {
        let copied = 0;
        while (copied < want && this.inbox.length > 0) {
            const head = this.inbox[0] as Buffer;
            const available = head.length - this.inboxOffset;
            const take = Math.min(available, want - copied);
            head.copy(dest, destOffset + copied, this.inboxOffset, this.inboxOffset + take);
            copied += take;
            this.inboxOffset += take;
            if (this.inboxOffset === head.length) {
                this.inbox.shift();
                this.inboxOffset = 0;
            }
        }
        this.inboxBuffered -= copied;
        return copied;
    }

    /**
     * Parse coalesced/fragmented bytes incrementally. Admission blocks (a
     * deferred header) halt the loop before body allocation, so a deferral
     * can never re-enter dispatch; `maybeResumeAdmission` restarts it.
     */
    private processInbox(): void {
        while (this.retiredInfo === null && this.deferredHeader === null) {
            const bodyHeader = this.bodyHeader;
            const bodyBuf = this.bodyBuf;
            if (bodyHeader !== null && bodyBuf !== null) {
                this.bodyFilled += this.takeFromInbox(
                    bodyBuf,
                    this.bodyFilled,
                    bodyHeader.len - this.bodyFilled,
                );
                if (this.bodyFilled < bodyHeader.len) return;
                this.bodyHeader = null;
                this.bodyBuf = null;
                this.bodyFilled = 0;
                this.completeFrame(bodyHeader, bodyBuf);
                continue;
            }
            if (this.inboxBuffered === 0) return;
            if (this.headerFilled === 0 && this.frameTimer === null) {
                // The frame deadline starts at the FIRST header byte; the
                // idle wait before it is unbounded (wire doc 6.3).
                this.frameTimer = this.armTimer(this.frameDeadlineMs, () =>
                    this.retire(
                        "frame_deadline",
                        new SocketTimeoutError("frame did not complete within its deadline"),
                    ),
                );
            }
            this.headerFilled += this.takeFromInbox(
                this.headerBuf,
                this.headerFilled,
                HEADER_LEN - this.headerFilled,
            );
            if (!this.versionChecked && this.headerFilled >= FROZEN_PREFIX_LEN) {
                this.versionChecked = true;
                const ver = this.headerBuf[4];
                if (ver !== PROTOCOL_VERSION) {
                    this.retire(
                        "protocol_violation",
                        new DecodeError(
                            `unsupported envelope version ${ver}`,
                            "unsupported_version",
                        ),
                    );
                    return;
                }
            }
            if (this.headerFilled < HEADER_LEN) return;
            let header: EnvelopeHeader;
            try {
                header = decodeHeader(this.headerBuf);
            } catch (error) {
                this.retire("protocol_violation", error);
                return;
            }
            const violation = headerViolation(header);
            if (violation) {
                this.retire(
                    violation.reason,
                    new DecodeError(violation.detail, "role_or_identity_violation"),
                );
                return;
            }
            if (header.len > this.maxBodyLen) {
                this.retire(
                    "protocol_violation",
                    new DecodeError(
                        `frame body length ${header.len} exceeds the ${this.maxBodyLen}-byte cap`,
                        "frame_body_too_large",
                    ),
                );
                return;
            }
            this.emitDiagnostic("header", {
                ty: header.ty,
                channel: header.channel,
                epoch: header.epoch,
                corr: header.corr,
                len: header.len,
            });
            this.headerFilled = 0;
            this.versionChecked = false;
            if (header.len === 0) {
                this.completeFrame(header, EMPTY_BODY);
                continue;
            }
            if (!this.admitBody(header)) return;
        }
    }

    /**
     * Aggregate-memory admission for one declared body, checked BEFORE
     * allocation. When the body does not fit, the socket pauses and the
     * header defers until pressure clears (KTD7).
     */
    private admitBody(header: EnvelopeHeader): boolean {
        if (this.memUsed + header.len > this.memoryCap) {
            this.deferredHeader = header;
            this.readPaused = true;
            this.socket.pause();
            return false;
        }
        this.bodyHeader = header;
        this.bodyBuf = Buffer.allocUnsafe(header.len);
        this.bodyFilled = 0;
        this.chargeReader(header.len);
        return true;
    }

    private maybeResumeAdmission(): void {
        if (this.retiredInfo || this.deferredHeader === null) return;
        const header = this.deferredHeader;
        if (this.memUsed + header.len > this.memoryCap) return;
        this.deferredHeader = null;
        this.bodyHeader = header;
        this.bodyBuf = Buffer.allocUnsafe(header.len);
        this.bodyFilled = 0;
        this.chargeReader(header.len);
        if (this.readPaused) {
            this.readPaused = false;
            this.socket.resume();
        }
        this.processInbox();
    }

    private completeFrame(header: EnvelopeHeader, body: Uint8Array): void {
        if (this.frameTimer !== null) {
            this.disarmTimer(this.frameTimer);
            this.frameTimer = null;
        }
        // Reader accumulation releases first; a retained stream body is
        // re-charged as pending ownership inside dispatch (a transfer, not
        // a duplicate full-body copy).
        if (header.len > 0) this.releaseReader(header.len);
        this.dispatch(header, body);
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
                this.removeQueuedItem(entry);
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

    private onRequestDeadline(entry: PendingEntry): void {
        if (this.pending.get(entry.key) !== entry || entry.callerSettled) return;
        if (!entry.writeInvoked) {
            this.removeQueuedItem(entry);
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
            this.removeQueuedItem(entry);
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
    // Single bounded FIFO writer.
    // ------------------------------------------------------------------

    /** Pure-header control frames use reserved capacity; exhaustion retires. */
    private enqueueControlHeader(header: EnvelopeHeader): void {
        if (this.retiredInfo) return;
        if (this.controlFramesQueued >= this.controlReserveFrames) {
            this.retire(
                "control_capacity_exhausted",
                new SubcCallError(
                    "terminal",
                    "reserved control-frame capacity exhausted; required cleanup cannot queue safely",
                    "control_capacity_exhausted",
                ),
            );
            return;
        }
        let headerBytes: Buffer;
        try {
            headerBytes = Buffer.from(encodeHeader(header));
        } catch (error) {
            this.retire("protocol_violation", error);
            return;
        }
        const meta: FrameMeta = {
            ty: header.ty,
            channel: header.channel,
            epoch: header.epoch,
            corr: header.corr,
            len: 0,
        };
        const item: QueuedItem = {
            buffers: [headerBytes],
            bytes: HEADER_LEN,
            control: true,
            entry: null,
            meta,
        };
        this.enqueueItem(item);
        this.emitDiagnostic("enqueue", meta);
    }

    private enqueueItem(item: QueuedItem): void {
        this.queue.push(item);
        if (item.control) {
            this.controlFramesQueued++;
        } else {
            this.dataFramesQueued++;
            this.dataBytesQueued += item.bytes;
        }
        this.chargeQueue(item.bytes);
        this.pump();
    }

    private removeQueuedItem(entry: PendingEntry): void {
        const item = entry.queuedItem;
        if (!item) return;
        entry.queuedItem = null;
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.dataFramesQueued--;
        this.dataBytesQueued -= item.bytes;
        this.releaseQueue(item.bytes);
    }

    /**
     * The one logical writer: every byte of one frame reaches the socket
     * before any byte of another frame. A `false` return from
     * `socket.write()` parks the pump on `'drain'`; the interrupted frame's
     * remaining buffers continue before any other frame.
     */
    private pump(): void {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.retiredInfo === null && !this.awaitingDrain) {
                if (this.currentItem === null) {
                    const item = this.queue.shift();
                    if (!item) return;
                    if (item.control) {
                        this.controlFramesQueued--;
                    } else {
                        this.dataFramesQueued--;
                        this.dataBytesQueued -= item.bytes;
                    }
                    if (item.entry) {
                        // KTD4 possible-send boundary: marked immediately
                        // before socket.write() is invoked for its bytes.
                        item.entry.writeInvoked = true;
                        item.entry.queuedItem = null;
                    }
                    this.currentItem = { item, index: 0 };
                    if (item.meta) this.emitDiagnostic("write_start", item.meta);
                }
                const current = this.currentItem;
                while (current.index < current.item.buffers.length) {
                    const buf = current.item.buffers[current.index] as Buffer;
                    current.index++;
                    let accepted: boolean;
                    try {
                        accepted = this.socket.write(buf, () => this.releaseQueue(buf.length));
                    } catch (error) {
                        this.retire("write_failed", error);
                        return;
                    }
                    if (this.retiredInfo) return;
                    if (!accepted) {
                        this.awaitingDrain = true;
                        this.socket.once("drain", () => {
                            this.awaitingDrain = false;
                            this.pump();
                        });
                        return;
                    }
                }
                if (current.item.meta) this.emitDiagnostic("write_complete", current.item.meta);
                this.currentItem = null;
            }
        } finally {
            this.pumping = false;
        }
    }

    /**
     * Resolve once every queued frame byte has been handed to the socket and
     * every write callback fired, the generation retires, or `deadline`
     * expires — a bounded, best-effort primitive for the facade's awaitable
     * Goodbye teardown. Never blocks retirement.
     */
    flushWrites(deadline: Deadline): Promise<void> {
        if (this.retiredInfo !== null || this.writerIdle()) return Promise.resolve();
        return new Promise((resolve) => {
            const waiter = {
                resolve,
                timer: this.armTimer(deadline.remainingMs(), () => {
                    const index = this.flushWaiters.indexOf(waiter);
                    if (index >= 0) this.flushWaiters.splice(index, 1);
                    resolve();
                }),
            };
            this.flushWaiters.push(waiter);
        });
    }

    private writerIdle(): boolean {
        return this.queue.length === 0 && this.currentItem === null && this.queueHeld === 0;
    }

    private settleFlushWaiters(): void {
        if (this.flushWaiters.length === 0 || !this.writerIdle()) return;
        for (const waiter of this.flushWaiters.splice(0)) {
            this.disarmTimer(waiter.timer);
            waiter.resolve();
        }
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
    // One aggregate memory owner (KTD7).
    // ------------------------------------------------------------------

    private charge(bytes: number): void {
        this.memUsed += bytes;
        if (this.memUsed > this.memPeak) this.memPeak = this.memUsed;
    }

    private chargeReader(bytes: number): void {
        this.readerHeld += bytes;
        this.charge(bytes);
    }

    private releaseReader(bytes: number): void {
        if (this.retiredInfo) return;
        this.readerHeld -= bytes;
        this.memUsed -= bytes;
        this.maybeResumeAdmission();
    }

    private chargeQueue(bytes: number): void {
        this.queueHeld += bytes;
        this.charge(bytes);
    }

    private releaseQueue(bytes: number): void {
        if (this.retiredInfo) return;
        this.queueHeld -= bytes;
        this.memUsed -= bytes;
        this.settleFlushWaiters();
        this.maybeResumeAdmission();
    }

    private chargePending(bytes: number): void {
        this.pendingHeld += bytes;
        this.charge(bytes);
    }

    private releasePending(bytes: number): void {
        if (this.retiredInfo) return;
        this.pendingHeld -= bytes;
        this.memUsed -= bytes;
        this.maybeResumeAdmission();
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
