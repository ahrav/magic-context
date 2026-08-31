/**
 *
 * `TcpFrameChannel` owns the socket, dialing, and auth byte-I/O adaptation.
 * `TcpFrameChannel` transfers auth leftovers from the handshake to frame parsing.
 * The incremental reader handles fragmentation and coalescing.
 * The reader starts each frame deadline at its first header byte.
 * `TcpFrameChannel` pauses and resumes the socket to enforce the shared byte budget.
 * `TcpFrameChannel` never imports the generation engine.
 * `TcpFrameChannel` emits frames, failures, and diagnostics through its handlers.
 */

import { Socket } from "node:net";
import {
    type AuthByteIo,
    type AuthCredentials,
    AuthError,
    type AuthResult,
    authenticateClient,
} from "./auth";
import type { Deadline } from "./deadline";
import { McHostCallError, SocketClosedError, SocketTimeoutError } from "./errors";
import {
    BoundedFrameProducer,
    type ByteBudget,
    CopyCounter,
    type DirectFrameBody,
    type FrameChannel,
    type FrameChannelCloseReason,
    type FrameChannelDiagnosticType,
    type FrameChannelHandlers,
    type FrameChannelStats,
    type FrameMeta,
    type FrameSendHooks,
    type FrameSendTicket,
    frameBodyMaterializer,
    headerViolation,
    type OutboundFrame,
    type ProducerFrameHeader,
    ReceiveLease,
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

/** `DEFAULT_FRAME_DEADLINE_MS` bounds a frame after its first header byte arrives; idle header waits are unbounded. */
const DEFAULT_FRAME_DEADLINE_MS = 30_000;
const DEFAULT_MAX_QUEUED_FRAMES = 256;
/** `DEFAULT_CONTROL_RESERVE_FRAMES` reserves writer slots for pure-header Pong, Cancel, and Goodbye frames. */
const DEFAULT_CONTROL_RESERVE_FRAMES = 32;
/**
 * Auth messages are a `u32` length plus at most 4,096 bytes each; this 65,536-byte cap limits pre-handshake buffering because the aggregate memory cap excludes that phase.
 */
const MAX_AUTH_BUFFERED_BYTES = 65_536;
const EMPTY_BODY = new Uint8Array(0);

export interface TcpFrameChannelOptions {
    host: string;
    port: number;
    /**
     * The handshake requires the peer to report `credentials.daemonVer`.
     */
    credentials: AuthCredentials;
    /**
     * Shared aggregate byte budget. The channel registers as the budget's release observer so paused inbound admission and flush waiters re-check when any owner releases bytes.
     */
    budget: ByteBudget;
    /** `frameDeadlineMs` starts when the first header byte arrives. */
    frameDeadlineMs?: number;
    /** `maxBodyLen` overrides the 64 MiB body limit for scaled tests. */
    maxBodyLen?: number;
    maxQueuedFrames?: number;
    maxQueuedBytes?: number;
    controlReserveFrames?: number;
    /** `producerSpanBytes` configures segmented direct-producer reservations for tests and profiles. */
    producerSpanBytes?: number;
    /* */
    generateNonce?: (length: number) => Uint8Array;
    handlers: FrameChannelHandlers;
}

interface QueuedItem {
    /** The writer writes each item's header before its optional body. */
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
 * `TcpFrameChannel` solely owns one connection's socket, framing, writer queue, and transport timers.
 * The caller must invoke `start()` exactly once after wiring the handlers.
 * The caller must invoke `beginFrames()` after authentication to transfer auth leftovers.
 * `beginFrames()` transfers auth leftovers before frame delivery.
 */
export class TcpFrameChannel implements FrameChannel {
    private readonly socket: Socket;
    private readonly host: string;
    private readonly port: number;
    private readonly credentials: AuthCredentials;
    private readonly budget: ByteBudget;
    private readonly frameDeadlineMs: number;
    private readonly maxBodyLen: number;
    private readonly maxQueuedFrames: number;
    private readonly maxQueuedBytes: number;
    private readonly controlReserveFrames: number;
    private readonly producerSpanBytes: number;
    private readonly generateNonce?: (length: number) => Uint8Array;
    private readonly handlers: FrameChannelHandlers;

    private closed = false;
    private startState: "idle" | "started" = "idle";
    private phase: "setup" | "frames" = "setup";
    private authResult: AuthResult | null = null;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private connectWaiter: { resolve: () => void; reject: (error: unknown) => void } | null = null;

    // `TcpFrameChannel` buffers auth-phase bytes while adapting the socket to `AuthByteIo`.
    private authChunks: Buffer[] = [];
    private authOffset = 0;
    private authBuffered = 0;
    private authWaiter: {
        need: number;
        resolve: (bytes: Uint8Array) => void;
        reject: (error: unknown) => void;
    } | null = null;

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

    private queue: QueuedItem[] = [];
    private readonly flushWaiters: {
        resolve: () => void;
        timer: ReturnType<typeof setTimeout>;
    }[] = [];
    private dataFramesQueued = 0;
    private dataBytesQueued = 0;
    private reservedDataFrames = 0;
    private reservedDataBytes = 0;
    private controlFramesQueued = 0;
    private pumping = false;
    private awaitingDrain = false;
    private currentItem: { item: QueuedItem; index: number } | null = null;

    private readerHeld = 0;
    private queueHeld = 0;
    private quarantinedBytes = 0;
    private readonly receiveLeases = new Set<ReceiveLease>();
    private readonly producerReservations = new Set<BoundedFrameProducer>();
    private readonly copyCounter = new CopyCounter();

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
        this.producerSpanBytes = options.producerSpanBytes ?? this.maxBodyLen;
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
     */
    async start(deadline: Deadline): Promise<void> {
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
        this.authResult = result;
    }

    /**
     * `authenticated` returns null until `start()` resolves, then returns the handshake-proved peer identity.
     */
    get authenticated(): AuthResult | null {
        return this.authResult;
    }

    /* */
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
            activeReceiveLeases: this.receiveLeases.size,
            quarantinedBytes: this.quarantinedBytes,
            ownedAdapterCopies: this.copyCounter.copies,
        };
    }

    produce(
        header: ProducerFrameHeader,
        body: DirectFrameBody,
        hooks?: FrameSendHooks,
        _deadline?: Deadline,
    ): FrameSendTicket {
        const materialize = frameBodyMaterializer(body);
        if (materialize) {
            const fullHeader: EnvelopeHeader = { ...header, len: body.byteLength };
            const admission = this.prepareDataFrame(fullHeader);
            const materialized = materialize();
            if (materialized.bytes.byteLength !== body.byteLength) {
                throw new RangeError("materialized frame body length mismatch");
            }
            if (materialized.copied) this.copyCounter.record();
            return this.enqueuePreparedData(
                fullHeader,
                admission.headerBytes,
                materialized.bytes,
                admission.totalBytes,
                hooks,
            );
        }
        const producer = this.reserve(header, body.byteLength, hooks);
        try {
            body.fill(producer);
            return producer.commit(body.byteLength);
        } catch (error) {
            producer.abort();
            throw error;
        }
    }

    reserve(
        header: ProducerFrameHeader,
        capacity: number,
        hooks?: FrameSendHooks,
    ): BoundedFrameProducer {
        if (this.closed) {
            throw new McHostCallError("not_sent", "frame channel is closed", "channel_closed");
        }
        if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > this.maxBodyLen) {
            throw new RangeError("producer capacity is outside frame bounds");
        }
        encodeHeader({ ...header, len: capacity });
        const reservedBytes = HEADER_LEN + capacity;
        if (
            this.dataFramesQueued + this.reservedDataFrames + 1 > this.maxQueuedFrames ||
            this.dataBytesQueued + this.reservedDataBytes + reservedBytes > this.maxQueuedBytes
        ) {
            throw new McHostCallError("not_sent", "writer queue is full", "writer_queue_full");
        }
        if (this.budget.wouldExceed(reservedBytes)) {
            throw new McHostCallError(
                "not_sent",
                "aggregate connection memory cap would be exceeded",
                "memory_cap",
            );
        }

        this.reservedDataFrames++;
        this.reservedDataBytes += reservedBytes;
        this.chargeQueue(reservedBytes);
        let held = true;
        let copyCharge = 0;
        let producer: BoundedFrameProducer | undefined;
        const release = (): void => {
            if (!held) return;
            held = false;
            if (producer) this.producerReservations.delete(producer);
            this.reservedDataFrames--;
            this.reservedDataBytes -= reservedBytes;
            this.releaseQueue(reservedBytes);
            if (copyCharge > 0) {
                this.releaseQueue(copyCharge);
                copyCharge = 0;
            }
        };
        const spans: Uint8Array[] = [];
        let remaining = capacity;
        const spanBytes = Math.max(1, this.producerSpanBytes);
        try {
            while (remaining > 0) {
                const length = Math.min(remaining, spanBytes);
                spans.push(new Uint8Array(new ArrayBuffer(length)));
                remaining -= length;
            }

            producer = new BoundedFrameProducer(
                spans,
                capacity,
                (segments, exactLength) => {
                    const fullHeader: EnvelopeHeader = { ...header, len: exactLength };
                    const headerBytes = Buffer.from(encodeHeader(fullHeader));
                    if (exactLength > 0) {
                        this.chargeQueue(exactLength);
                        copyCharge = exactLength;
                    }
                    let body: Buffer;
                    try {
                        body = Buffer.allocUnsafeSlow(exactLength);
                        let offset = 0;
                        for (const segment of segments) {
                            body.set(segment, offset);
                            offset += segment.byteLength;
                        }
                    } catch (error) {
                        if (copyCharge > 0) {
                            this.releaseQueue(copyCharge);
                            copyCharge = 0;
                        }
                        throw error;
                    }
                    this.copyCounter.record();
                    const bytes = HEADER_LEN + exactLength;
                    const item: QueuedItem = {
                        buffers: exactLength > 0 ? [headerBytes, body] : [headerBytes],
                        bytes,
                        control: false,
                        hooks: hooks ?? null,
                        meta: metaFromHeader(fullHeader),
                    };
                    return {
                        publish: () => {
                            if (!held || this.closed) {
                                release();
                                throw new McHostCallError(
                                    "not_sent",
                                    "producer reservation was released",
                                    "channel_closed",
                                );
                            }
                            held = false;
                            if (producer) this.producerReservations.delete(producer);
                            this.reservedDataFrames--;
                            this.reservedDataBytes -= reservedBytes;
                            if (capacity > 0) this.releaseQueue(capacity);
                            copyCharge = 0;
                            this.enqueueReservedItem(item);
                            return { cancel: () => this.cancelQueuedItem(item) };
                        },
                    };
                },
                release,
            );
        } catch (error) {
            release();
            throw error;
        }
        this.producerReservations.add(producer);
        return producer;
    }

    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket {
        if (this.closed) {
            throw new McHostCallError("not_sent", "frame channel is closed", "channel_closed");
        }
        if (frame.header.len !== frame.body.length) {
            throw new RangeError(
                `frame header.len (${frame.header.len}) does not match body length (${frame.body.length})`,
            );
        }
        const admission = this.prepareDataFrame(frame.header);
        const body = Buffer.from(frame.body);
        this.copyCounter.record();
        return this.enqueuePreparedData(
            frame.header,
            admission.headerBytes,
            body,
            admission.totalBytes,
            hooks,
        );
    }

    private prepareDataFrame(header: EnvelopeHeader): {
        headerBytes: Buffer;
        totalBytes: number;
    } {
        if (this.closed) {
            throw new McHostCallError("not_sent", "frame channel is closed", "channel_closed");
        }
        if (!Number.isSafeInteger(header.len) || header.len < 0 || header.len > this.maxBodyLen) {
            throw new RangeError("frame body length is outside transport bounds");
        }
        // Encoding validates every header field before state changes.
        const headerBytes = Buffer.from(encodeHeader(header));
        const totalBytes = HEADER_LEN + header.len;
        if (
            this.dataFramesQueued + this.reservedDataFrames + 1 > this.maxQueuedFrames ||
            this.dataBytesQueued + this.reservedDataBytes + totalBytes > this.maxQueuedBytes
        ) {
            throw new McHostCallError("not_sent", "writer queue is full", "writer_queue_full");
        }
        if (this.budget.wouldExceed(totalBytes)) {
            throw new McHostCallError(
                "not_sent",
                "aggregate connection memory cap would be exceeded",
                "memory_cap",
            );
        }
        return { headerBytes, totalBytes };
    }

    private enqueuePreparedData(
        header: EnvelopeHeader,
        headerBytes: Buffer,
        body: Buffer,
        totalBytes: number,
        hooks?: FrameSendHooks,
    ): FrameSendTicket {
        const item: QueuedItem = {
            buffers: body.length > 0 ? [headerBytes, body] : [headerBytes],
            bytes: totalBytes,
            control: false,
            hooks: hooks ?? null,
            meta: metaFromHeader(header),
        };
        this.enqueueItem(item);
        return {
            cancel: () => this.cancelQueuedItem(item),
        };
    }

    /** Pure-header control frames use reserved capacity; exhaustion fails the channel. */
    sendControl(header: EnvelopeHeader): void {
        if (this.closed) return;
        if (this.controlFramesQueued >= this.controlReserveFrames) {
            this.fail(
                "control_capacity_exhausted",
                new McHostCallError(
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
     * The flush operation resolves after every queued frame byte reaches the socket and every write callback fires.
     * The flush operation also resolves when the channel closes or `deadline` expires.
     * The flush operation never blocks channel close.
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
     * Owner close is idempotent and abortively discards queued frames.
     * Owner close clears transport timers and rejects in-flight dial and authentication waits.
     * Owner close never fires `onClosed`.
     */
    close(error?: unknown): void {
        this.teardown(error);
    }

    // ------------------------------------------------------------------
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
        for (const producer of [...this.producerReservations]) producer.abort();
        for (const lease of [...this.receiveLeases]) {
            try {
                lease.release();
            } catch (error) {
                void error;
            }
        }
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
        this.reservedDataFrames = 0;
        this.reservedDataBytes = 0;
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
     */
    private admitBody(header: EnvelopeHeader): boolean {
        if (this.budget.wouldExceed(header.len)) {
            this.deferredHeader = header;
            this.readPaused = true;
            this.socket.pause();
            return false;
        }
        this.bodyHeader = header;
        this.bodyBuf = Buffer.allocUnsafeSlow(header.len);
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
        this.bodyBuf = Buffer.allocUnsafeSlow(header.len);
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
        let lease: ReceiveLease;
        lease = new ReceiveLease(
            header.len === 0 ? [] : [body],
            (outcome) => {
                this.receiveLeases.delete(lease);
                if (outcome === "released") {
                    if (header.len > 0) this.releaseReader(header.len);
                } else {
                    this.quarantinedBytes += header.len;
                }
                this.handlers.onLeaseReleased?.();
            },
            this.copyCounter,
            () => "released",
        );
        this.receiveLeases.add(lease);
        this.handlers.onFrame({ header, body: lease });
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------

    private enqueueReservedItem(item: QueuedItem): void {
        this.queue.push(item);
        this.dataFramesQueued++;
        this.dataBytesQueued += item.bytes;
        this.pump();
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
                    if (item.hooks?.onPublish) {
                        try {
                            item.hooks.onPublish();
                        } catch {
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
                    }
                }
                this.emitDiagnostic("write_complete", current.item.meta);
                this.currentItem = null;
            }
        } finally {
            this.pumping = false;
            this.settleFlushWaiters();
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
        }
    }

    // ------------------------------------------------------------------
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
