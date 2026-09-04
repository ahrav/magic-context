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
import { type AuthCredentials, type AuthResult } from "./auth";
import type { Deadline } from "./deadline";
import { BoundedFrameProducer, type ByteBudget, type DirectFrameBody, type FrameChannel, type FrameChannelHandlers, type FrameChannelStats, type FrameSendHooks, type FrameSendTicket, type OutboundFrame, type ProducerFrameHeader } from "./frame-channel";
import { type EnvelopeHeader } from "./protocol";
export interface TcpFrameChannelOptions {
    host?: string;
    port?: number;
    setupSocket?: string;
    /**
     * Validated connection-file credentials. `daemonVer` is the file's
     * `daemon_ver`, which the handshake requires the peer to report back
     * (wire doc Section 5.2).
     */
    credentials: AuthCredentials;
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
    /** Test/profile seam for segmented direct producer reservations. */
    producerSpanBytes?: number;
    /** Nonce source passthrough to the pure auth handshake. */
    generateNonce?: (length: number) => Uint8Array;
    handlers: FrameChannelHandlers;
}
/**
 * The sole socket, framing, writer-queue, and transport-timer owner for one
 * connection generation. Construct with wired handlers, `start()` exactly
 * once to dial and authenticate, then `beginFrames()` to transfer auth
 * leftover bytes and begin frame delivery.
 */
export declare class TcpFrameChannel implements FrameChannel {
    private readonly socket;
    private readonly host?;
    private readonly port?;
    private readonly setupSocket?;
    private readonly credentials;
    private readonly budget;
    private readonly frameDeadlineMs;
    private readonly maxBodyLen;
    private readonly maxQueuedFrames;
    private readonly maxQueuedBytes;
    private readonly controlReserveFrames;
    private readonly producerSpanBytes;
    private readonly generateNonce?;
    private readonly handlers;
    private closed;
    private startState;
    private phase;
    private authResult;
    private readonly timers;
    private connectWaiter;
    private authChunks;
    private authOffset;
    private authBuffered;
    private authWaiter;
    private inbox;
    private inboxOffset;
    private inboxBuffered;
    private readonly headerBuf;
    private headerFilled;
    private versionChecked;
    private bodyHeader;
    private bodyBuf;
    private bodyFilled;
    private deferredHeader;
    private frameTimer;
    private readPaused;
    private queue;
    private readonly flushWaiters;
    private dataFramesQueued;
    private dataBytesQueued;
    private reservedDataFrames;
    private reservedDataBytes;
    private controlFramesQueued;
    private pumping;
    private awaitingDrain;
    private currentItem;
    private readerHeld;
    private queueHeld;
    private quarantinedBytes;
    private readonly receiveLeases;
    private readonly producerReservations;
    private readonly copyCounter;
    constructor(options: TcpFrameChannelOptions);
    /**
     * Single-flight dial plus authentication under `deadline`. The proven
     * identity lands in {@link authenticated} rather than the resolution
     * value, so identity is readable only from the channel that proved it.
     * Leftover post-auth bytes stay buffered until `beginFrames()`, so the
     * owner can finish its own setup checks before any frame dispatches.
     */
    start(deadline: Deadline): Promise<void>;
    /**
     * Peer identity the handshake proved, or null until `start()` resolves.
     * The daemon version here equals the connection-file `daemon_ver` the
     * credentials carried; the handshake admits no other value.
     */
    get authenticated(): AuthResult | null;
    /** Transfer auth-leftover bytes into the frame reader and begin delivery. */
    beginFrames(): void;
    isClosed(): boolean;
    stats(): FrameChannelStats;
    produce(header: ProducerFrameHeader, body: DirectFrameBody, hooks?: FrameSendHooks, _deadline?: Deadline): FrameSendTicket;
    reserve(header: ProducerFrameHeader, capacity: number, hooks?: FrameSendHooks): BoundedFrameProducer;
    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket;
    private prepareDataFrame;
    private enqueuePreparedData;
    /** Pure-header control frames use reserved capacity; exhaustion fails the channel. */
    sendControl(header: EnvelopeHeader): void;
    /**
     * Resolve once every queued frame byte has been handed to the socket and
     * every write callback fired, the channel closes, or `deadline` expires
     * — a bounded, best-effort primitive for the owner's graceful finish.
     * Never blocks close.
     */
    flush(deadline: Deadline): Promise<void>;
    /**
     * Idempotent owner close (abortive discard): drops queued frames, clears
     * every transport timer, rejects in-flight dial/auth waits, resolves
     * flush waiters, freezes the shared budget, and destroys the socket.
     * Never fires `onClosed`.
     */
    close(error?: unknown): void;
    private fail;
    private teardown;
    private waitForConnect;
    private createAuthIo;
    private serveAuthWaiter;
    private moveAuthLeftoverToInbox;
    private onData;
    private takeFromInbox;
    /**
     * Parse coalesced/fragmented bytes incrementally. Admission blocks (a
     * deferred header) halt the loop before body allocation, so a deferral
     * can never re-enter delivery; `maybeResumeAdmission` restarts it.
     */
    private processInbox;
    /**
     * Aggregate-budget admission for one declared body, checked BEFORE
     * allocation. When the body does not fit, the socket pauses and the
     * header defers until pressure clears (KTD7).
     */
    private admitBody;
    private maybeResumeAdmission;
    private completeFrame;
    private enqueueReservedItem;
    private enqueueItem;
    private cancelQueuedItem;
    /**
     * The one logical writer: every byte of one frame reaches the socket
     * before any byte of another frame. A `false` return from
     * `socket.write()` parks the pump on `'drain'`; the interrupted frame's
     * remaining buffers continue before any other frame.
     */
    private pump;
    private writerIdle;
    private settleFlushWaiters;
    private emitDiagnostic;
    private chargeReader;
    private releaseReader;
    private chargeQueue;
    private releaseQueue;
    private armTimer;
    private disarmTimer;
}
//# sourceMappingURL=tcp-frame-channel.d.ts.map