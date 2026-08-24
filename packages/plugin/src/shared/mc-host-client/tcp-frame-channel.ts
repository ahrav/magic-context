/**
 * TCP implementation of the complete-frame channel boundary (KTD7).
 *
 * `TcpFrameChannel` owns the `node:net` socket, dial, the auth byte-I/O
 * adaptation over the pure handshake, auth-leftover transfer, the
 * incremental frame reader (fragmentation, coalescing, first-header-byte
 * frame deadlines), the single bounded FIFO writer with reserved control
 * capacity, inbound admission backpressure (socket pause/resume against
 * the shared byte budget), and socket teardown. It never imports the
 * generation engine: frames, failures, and diagnostics flow out through
 * the handlers wired at construction.
 */

import { Socket } from "node:net";
import { type AuthByteIo, AuthError, type AuthResult, authenticateClient } from "./auth";
import type { Deadline } from "./deadline";
import { SocketClosedError, SocketTimeoutError, SubcCallError } from "./errors";
import {
    type ByteBudget,
    type FrameChannel,
    type FrameChannelCloseReason,
    type FrameChannelDiagnosticType,
    type FrameChannelHandlers,
    type FrameChannelStats,
    type FrameMeta,
    type FrameSendHooks,
    type FrameSendTicket,
    headerViolation,
    type OutboundFrame,
} from "./frame-channel";
import {
    DecodeError,
    decodeHeader,
    type EnvelopeHeader,
    encodeHeader,
    FROZEN_PREFIX_LEN,
    HEADER_LEN,
    MAX_FRAME_BODY_LEN,
    PROTOCOL_VERSION,
} from "./protocol";

/** Idle header wait is unbounded; this bounds one frame once its first header byte arrives. */
const DEFAULT_FRAME_DEADLINE_MS = 30_000;
const DEFAULT_MAX_QUEUED_FRAMES = 256;
/** Reserved writer slots for pure-header Pong/Cancel/Goodbye cleanup frames. */
const DEFAULT_CONTROL_RESERVE_FRAMES = 32;
/**
 * Hard cap on pre-handshake buffering. Auth messages are a `u32` length plus
 * at most 4,096 bytes each, so a legal exchange never approaches this; the
 * aggregate memory cap only covers frame bodies and cannot bound this phase.
 */
const MAX_AUTH_BUFFERED_BYTES = 65_536;
const EMPTY_BODY = new Uint8Array(0);

export interface TcpFrameChannelOptions {
    host: string;
    port: number;
    credentials: { key: Uint8Array; daemonId: Uint8Array };
    /**
     * Shared aggregate byte budget (KTD7). The channel registers itself as
     * the budget's release observer so paused inbound admission and flush
     * waiters re-check whenever any owner releases bytes.
     */
    budget: ByteBudget;
    /** Frame deadline starting at the FIRST header byte (wire doc 6.3). */
    frameDeadlineMs?: number;
    /** Injectable body cap for scaled tests; defaults to the exact 64 MiB limit. */
    maxBodyLen?: number;
    maxQueuedFrames?: number;
    maxQueuedBytes?: number;
    controlReserveFrames?: number;
    /** Nonce source passthrough to the pure auth handshake. */
    generateNonce?: (length: number) => Uint8Array;
    handlers: FrameChannelHandlers;
}

interface QueuedItem {
    /** Header buffer, then optionally the body buffer; written in order. */
    buffers: Buffer[];
    bytes: number;
    control: boolean;
    hooks: FrameSendHooks | null;
    meta: FrameMeta;
}

function asBuffer(bytes: Uint8Array): Buffer {
    return Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function metaFromHeader(header: EnvelopeHeader): FrameMeta {
    return {
        ty: header.ty,
        channel: header.channel,
        epoch: header.epoch,
        corr: header.corr,
        len: header.len,
    };
}

/**
 * The sole socket, framing, writer-queue, and transport-timer owner for one
 * connection generation. Construct with wired handlers, `start()` exactly
 * once to dial and authenticate, then `beginFrames()` to transfer auth
 * leftover bytes and begin frame delivery.
 */
export class TcpFrameChannel implements FrameChannel {
    private readonly socket: Socket;
    private readonly host: string;
    private readonly port: number;
    private readonly credentials: { key: Uint8Array; daemonId: Uint8Array };
    private readonly budget: ByteBudget;
    private readonly frameDeadlineMs: number;
    private readonly maxBodyLen: number;
    private readonly maxQueuedFrames: number;
    private readonly maxQueuedBytes: number;
    private readonly controlReserveFrames: number;
    private readonly generateNonce?: (length: number) => Uint8Array;
    private readonly handlers: FrameChannelHandlers;

    private closed = false;
    private startState: "idle" | "started" = "idle";
    private phase: "setup" | "frames" = "setup";
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private connectWaiter: { resolve: () => void; reject: (error: unknown) => void } | null = null;

    // Auth-phase byte buffering (the socket adapted to the pure AuthByteIo).
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

    // Byte charges this channel currently holds against the shared budget.
    private readerHeld = 0;
    private queueHeld = 0;

    constructor(options: TcpFrameChannelOptions) {
        this.host = options.host;
        this.port = options.port;
        this.credentials = options.credentials;
        this.budget = options.budget;
        this.frameDeadlineMs = options.frameDeadlineMs ?? DEFAULT_FRAME_DEADLINE_MS;
        this.maxBodyLen = options.maxBodyLen ?? MAX_FRAME_BODY_LEN;
        this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
        this.maxQueuedBytes = options.maxQueuedBytes ?? this.maxBodyLen + 65_536;
        this.controlReserveFrames = options.controlReserveFrames ?? DEFAULT_CONTROL_RESERVE_FRAMES;
        this.generateNonce = options.generateNonce;
        this.handlers = options.handlers;
        this.budget.onRelease = () => {
            this.settleFlushWaiters();
            this.maybeResumeAdmission();
        };
        this.socket = new Socket();
        // Every lifecycle listener is attached before connect() is invoked.
        this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
        this.socket.on("end", () => {
            // Stream end while a frame is partially received (header or body
            // bytes pending) is a truncated-frame failure, distinct from a
            // clean close at a frame boundary.
            const midFrame =
                this.headerFilled > 0 || this.bodyHeader !== null || this.deferredHeader !== null;
            this.fail(
                midFrame ? "truncated_frame" : "eof",
                new SocketClosedError(
                    midFrame
                        ? "peer closed the connection mid-frame"
                        : "peer closed the connection",
                ),
            );
        });
        this.socket.on("error", (error: Error) => this.fail("socket_error", error));
        this.socket.on("close", () =>
            this.fail("socket_closed", new SocketClosedError("connection closed")),
        );
        this.socket.on("timeout", () =>
            this.fail("socket_timeout", new SocketTimeoutError("socket inactivity timeout")),
        );
        this.socket.once("connect", () => {
            const waiter = this.connectWaiter;
            this.connectWaiter = null;
            waiter?.resolve();
        });
    }

    /**
     * Single-flight dial plus authentication under `deadline`. Leftover
     * post-auth bytes stay buffered until `beginFrames()`, so the owner can
     * finish its own setup checks before any frame dispatches.
     */
    async start(deadline: Deadline): Promise<AuthResult> {
        if (this.startState !== "idle") {
            throw new Error("TcpFrameChannel.start() is single-flight per channel");
        }
        this.startState = "started";
        await this.waitForConnect();
        this.socket.setNoDelay(true);
        const result = await authenticateClient(this.createAuthIo(), this.credentials, deadline, {
            generateNonce: this.generateNonce,
        });
        if (this.closed) {
            throw new SocketClosedError("frame channel closed during authentication");
        }
        return result;
    }

    /** Transfer auth-leftover bytes into the frame reader and begin delivery. */
    beginFrames(): void {
        if (this.closed || this.phase === "frames") return;
        this.phase = "frames";
        this.moveAuthLeftoverToInbox();
        this.processInbox();
    }

    isClosed(): boolean {
        return this.closed;
    }

    stats(): FrameChannelStats {
        return {
            readerHeldBytes: this.readerHeld,
            queueHeldBytes: this.queueHeld,
            queuedDataFrames: this.dataFramesQueued,
            queuedControlFrames: this.controlFramesQueued,
            readPaused: this.readPaused,
            activeTimers: this.timers.size,
        };
    }

    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket {
        if (this.closed) {
            throw new SubcCallError("not_sent", "frame channel is closed", "channel_closed");
        }
        // Encoding validates every header field before any state changes,
        // so a rejected frame can never burn a correlation upstream.
        const headerBytes = Buffer.from(encodeHeader(frame.header));
        const body = asBuffer(frame.body);
        const totalBytes = HEADER_LEN + body.length;
        if (
            this.dataFramesQueued + 1 > this.maxQueuedFrames ||
            this.dataBytesQueued + totalBytes > this.maxQueuedBytes
        ) {
            throw new SubcCallError("not_sent", "writer queue is full", "writer_queue_full");
        }
        if (this.budget.wouldExceed(totalBytes)) {
            throw new SubcCallError(
                "not_sent",
                "aggregate connection memory cap would be exceeded",
                "memory_cap",
            );
        }
        const item: QueuedItem = {
            buffers: body.length > 0 ? [headerBytes, body] : [headerBytes],
            bytes: totalBytes,
            control: false,
            hooks: hooks ?? null,
            meta: metaFromHeader(frame.header),
        };
        this.enqueueItem(item);
        return {
            bytes: totalBytes,
            cancel: () => this.cancelQueuedItem(item),
        };
    }

    /** Pure-header control frames use reserved capacity; exhaustion fails the channel. */
    sendControl(header: EnvelopeHeader): void {
        if (this.closed) return;
        if (this.controlFramesQueued >= this.controlReserveFrames) {
            this.fail(
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
            this.fail("protocol_violation", error);
            return;
        }
        this.enqueueItem({
            buffers: [headerBytes],
            bytes: HEADER_LEN,
            control: true,
            hooks: null,
            meta: metaFromHeader(header),
        });
    }

    /**
     * Resolve once every queued frame byte has been handed to the socket and
     * every write callback fired, the channel closes, or `deadline` expires
     * — a bounded, best-effort primitive for the owner's graceful finish.
     * Never blocks close.
     */
    flush(deadline: Deadline): Promise<void> {
        if (this.closed || this.writerIdle()) return Promise.resolve();
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

    /**
     * Idempotent owner close (abortive discard): drops queued frames, clears
     * every transport timer, rejects in-flight dial/auth waits, resolves
     * flush waiters, freezes the shared budget, and destroys the socket.
     * Never fires `onClosed`.
     */
    close(error?: unknown): void {
        this.teardown(error);
    }

    // ------------------------------------------------------------------
    // Failure and teardown.
    // ------------------------------------------------------------------

    private fail(reason: FrameChannelCloseReason, error: unknown): void {
        if (this.closed) return;
        this.teardown(error);
        try {
            this.handlers.onClosed(reason, error);
        } catch {
            // Observer exceptions must not affect teardown.
        }
    }

    private teardown(error?: unknown): void {
        if (this.closed) return;
        this.closed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.frameTimer = null;
        const rejectError =
            error instanceof Error ? error : new SocketClosedError("frame channel closed");
        if (this.connectWaiter) {
            const waiter = this.connectWaiter;
            this.connectWaiter = null;
            waiter.reject(rejectError);
        }
        if (this.authWaiter) {
            const waiter = this.authWaiter;
            this.authWaiter = null;
            waiter.reject(rejectError);
        }
        this.queue = [];
        this.currentItem = null;
        this.dataFramesQueued = 0;
        this.dataBytesQueued = 0;
        this.controlFramesQueued = 0;
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
        this.readerHeld = 0;
        this.queueHeld = 0;
        this.budget.freeze();
        this.socket.destroy();
    }

    // ------------------------------------------------------------------
    // Setup: dial + auth byte-I/O adaptation.
    // ------------------------------------------------------------------

    private waitForConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new SocketClosedError("frame channel is closed"));
                return;
            }
            this.connectWaiter = { resolve, reject };
            this.socket.connect({ host: this.host, port: this.port });
        });
    }

    private createAuthIo(): AuthByteIo {
        return {
            readExact: (n: number, _deadline: Deadline): Promise<Uint8Array> =>
                new Promise((resolve, reject) => {
                    if (this.closed) {
                        reject(new SocketClosedError("frame channel is closed"));
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
                    if (this.closed) {
                        reject(new SocketClosedError("frame channel is closed"));
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
        if (this.closed) return;
        if (this.phase === "setup") {
            this.authChunks.push(chunk);
            this.authBuffered += chunk.length;
            if (this.authBuffered > MAX_AUTH_BUFFERED_BYTES) {
                this.fail(
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
     * can never re-enter delivery; `maybeResumeAdmission` restarts it.
     */
    private processInbox(): void {
        while (!this.closed && this.deferredHeader === null) {
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
                    this.fail(
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
                    this.fail(
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
                this.fail("protocol_violation", error);
                return;
            }
            const violation = headerViolation(header);
            if (violation) {
                this.fail(
                    violation.reason,
                    new DecodeError(violation.detail, "role_or_identity_violation"),
                );
                return;
            }
            if (header.len > this.maxBodyLen) {
                this.fail(
                    "protocol_violation",
                    new DecodeError(
                        `frame body length ${header.len} exceeds the ${this.maxBodyLen}-byte cap`,
                        "frame_body_too_large",
                    ),
                );
                return;
            }
            this.emitDiagnostic("header", metaFromHeader(header));
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
     * Aggregate-budget admission for one declared body, checked BEFORE
     * allocation. When the body does not fit, the socket pauses and the
     * header defers until pressure clears (KTD7).
     */
    private admitBody(header: EnvelopeHeader): boolean {
        if (this.budget.wouldExceed(header.len)) {
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
        if (this.closed || this.deferredHeader === null) return;
        const header = this.deferredHeader;
        if (this.budget.wouldExceed(header.len)) return;
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
        // The transient reader charge releases at delivery; a receiver that
        // retains the body re-charges the retained bytes itself (a
        // transfer, not a duplicate full-body copy).
        if (header.len > 0) this.releaseReader(header.len);
        this.handlers.onFrame({ header, body });
    }

    // ------------------------------------------------------------------
    // Single bounded FIFO writer.
    // ------------------------------------------------------------------

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

    private cancelQueuedItem(item: QueuedItem): boolean {
        const index = this.queue.indexOf(item);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        if (item.control) {
            this.controlFramesQueued--;
        } else {
            this.dataFramesQueued--;
            this.dataBytesQueued -= item.bytes;
        }
        this.releaseQueue(item.bytes);
        return true;
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
            while (!this.closed && !this.awaitingDrain) {
                if (this.currentItem === null) {
                    const item = this.queue.shift();
                    if (!item) return;
                    if (item.control) {
                        this.controlFramesQueued--;
                    } else {
                        this.dataFramesQueued--;
                        this.dataBytesQueued -= item.bytes;
                    }
                    // KTD4 possible-send boundary: published immediately
                    // before socket.write() is invoked for its bytes.
                    if (item.hooks?.onPublish) {
                        try {
                            item.hooks.onPublish();
                        } catch {
                            // Hook exceptions must not affect the writer.
                        }
                    }
                    this.currentItem = { item, index: 0 };
                    this.emitDiagnostic("write_start", item.meta);
                }
                const current = this.currentItem;
                while (current.index < current.item.buffers.length) {
                    const buf = current.item.buffers[current.index] as Buffer;
                    current.index++;
                    let accepted: boolean;
                    try {
                        accepted = this.socket.write(buf, () => this.releaseQueue(buf.length));
                    } catch (error) {
                        this.fail("write_failed", error);
                        return;
                    }
                    if (this.closed) return;
                    if (!accepted) {
                        this.awaitingDrain = true;
                        this.socket.once("drain", () => {
                            this.awaitingDrain = false;
                            this.pump();
                        });
                        return;
                    }
                }
                if (current.item.hooks?.onComplete) {
                    try {
                        current.item.hooks.onComplete();
                    } catch {
                        // Hook exceptions must not affect the writer.
                    }
                }
                this.emitDiagnostic("write_complete", current.item.meta);
                this.currentItem = null;
            }
        } finally {
            this.pumping = false;
        }
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

    private emitDiagnostic(type: FrameChannelDiagnosticType, meta: FrameMeta): void {
        const hook = this.handlers.onDiagnostic;
        if (!hook) return;
        try {
            hook(type, meta);
        } catch {
            // Observer exceptions must never affect transport work.
        }
    }

    // ------------------------------------------------------------------
    // Shared-budget charges held by this channel.
    // ------------------------------------------------------------------

    private chargeReader(bytes: number): void {
        this.readerHeld += bytes;
        this.budget.charge(bytes);
    }

    private releaseReader(bytes: number): void {
        if (this.closed) return;
        this.readerHeld -= bytes;
        this.budget.release(bytes);
    }

    private chargeQueue(bytes: number): void {
        this.queueHeld += bytes;
        this.budget.charge(bytes);
    }

    private releaseQueue(bytes: number): void {
        if (this.closed) return;
        this.queueHeld -= bytes;
        this.budget.release(bytes);
    }

    // ------------------------------------------------------------------
    // Timers.
    // ------------------------------------------------------------------

    private armTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
        const timer = setTimeout(
            () => {
                this.timers.delete(timer);
                if (!this.closed) fn();
            },
            Math.max(0, ms),
        );
        this.timers.add(timer);
        return timer;
    }

    private disarmTimer(timer: ReturnType<typeof setTimeout>): void {
        clearTimeout(timer);
        this.timers.delete(timer);
    }
}
