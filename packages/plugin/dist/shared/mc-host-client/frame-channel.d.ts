import { Buffer } from "node:buffer";
import type { Deadline } from "./deadline";
import { type EnvelopeHeader } from "./protocol";
export type FrameChannelCloseReason = "socket_error" | "eof" | "truncated_frame" | "socket_closed" | "socket_timeout" | "protocol_violation" | "role_violation" | "frame_deadline" | "write_failed" | "control_capacity_exhausted" | "quarantined";
export type ProducerFrameHeader = Omit<EnvelopeHeader, "len">;
export declare class CopyCounter {
    copies: number;
    record(): void;
}
export type ReceiveReleaseOutcome = "released" | "quarantined";
export declare class ReceiveLease {
    private readonly leasedSegments;
    private readonly onRelease;
    private readonly copies;
    private readonly detachAliases?;
    private released;
    private readonly originalLengths;
    constructor(leasedSegments: readonly Uint8Array[], onRelease: (outcome: ReceiveReleaseOutcome) => void, copies: CopyCounter, detachAliases?: (() => ReceiveReleaseOutcome) | undefined);
    get byteLength(): number;
    get segmentCount(): number;
    segment(index: number): Uint8Array;
    takeOwned(): Uint8Array;
    release(): boolean;
    isReleased(): boolean;
    [Symbol.dispose](): void;
    private assertActive;
}
export interface InboundFrame {
    readonly header: EnvelopeHeader;
    readonly body: ReceiveLease;
}
export interface OutboundFrame {
    readonly header: EnvelopeHeader;
    readonly body: Uint8Array;
}
export interface FrameProducerCursor {
    readonly written: number;
    readonly remaining: number;
    view(): Uint8Array;
    advance(bytes: number): void;
    write(bytes: Uint8Array): void;
}
export interface DirectFrameBody {
    readonly byteLength: number;
    fill(cursor: FrameProducerCursor): void;
}
interface MaterializedFrameBody {
    bytes: Buffer;
    copied: boolean;
}
export declare function frameBodyMaterializer(body: DirectFrameBody): (() => MaterializedFrameBody) | undefined;
export declare function bytesFrameBody(bytes: Uint8Array): DirectFrameBody;
export declare function utf8FrameBody(text: string): DirectFrameBody;
export interface FrameSendHooks {
    onPublish?: () => void;
    onComplete?: () => void;
}
export interface FrameSendTicket {
    cancel(): boolean;
}
export type ProducerErrorCode = "producer_aborted" | "producer_overflow" | "producer_underfill" | "producer_commit_outside_reservation";
export declare class ProducerError extends Error {
    readonly code: ProducerErrorCode;
    constructor(code: ProducerErrorCode);
}
interface PreparedProducerCommit {
    publish(): FrameSendTicket;
}
export declare class BoundedFrameProducer implements FrameProducerCursor {
    private readonly producerSegments;
    readonly capacity: number;
    private readonly prepareCommit;
    private readonly releaseReservation;
    private readonly detachOnCommit;
    private cursor;
    private active;
    constructor(producerSegments: readonly Uint8Array[], capacity: number, prepareCommit: (segments: readonly Uint8Array[], exactLength: number) => PreparedProducerCommit, releaseReservation: () => void, detachOnCommit?: boolean);
    get written(): number;
    get remaining(): number;
    view(): Uint8Array;
    advance(bytes: number): void;
    write(bytes: Uint8Array): void;
    commit(exactLength: number): FrameSendTicket;
    abort(): void;
    private committedSegments;
    private detachProducerAliases;
    private abortWith;
    private assertActive;
}
export interface FrameMeta {
    ty: number;
    channel: number;
    epoch: number;
    corr: bigint;
    len: number;
}
export type FrameChannelDiagnosticType = "write_start" | "write_complete" | "header";
export interface FrameChannelHandlers {
    onFrame: (frame: InboundFrame) => void;
    onClosed: (reason: FrameChannelCloseReason, error: unknown) => void;
    onDiagnostic?: (type: FrameChannelDiagnosticType, meta: FrameMeta) => void;
    /**
     * Fires after any ReceiveLease minted by this channel is released,
     * including force-releases during close. Owners draining a connection
     * use it to re-evaluate retirement once callers hand storage back.
     */
    onLeaseReleased?: () => void;
}
export interface FrameChannelStats {
    readerHeldBytes: number;
    queueHeldBytes: number;
    queuedDataFrames: number;
    queuedControlFrames: number;
    readPaused: boolean;
    activeTimers: number;
    activeReceiveLeases: number;
    quarantinedBytes: number;
    ownedAdapterCopies: number;
}
export interface FrameChannel {
    produce(header: ProducerFrameHeader, body: DirectFrameBody, hooks?: FrameSendHooks, deadline?: Deadline): FrameSendTicket;
    reserve(header: ProducerFrameHeader, capacity: number, hooks?: FrameSendHooks): BoundedFrameProducer;
    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket;
    sendControl(header: EnvelopeHeader): void;
    flush(deadline: Deadline): Promise<void>;
    close(error?: unknown): void;
    isClosed(): boolean;
    stats(): FrameChannelStats;
}
/**
 * A {@link FrameChannel} with a bounded setup phase ahead of frame delivery.
 *
 * `start()` reports nothing. Peer identity is proven by a handshake, and only
 * the channel that ran one can name it — through its own accessor — so a
 * setup channel cannot report an identity it never authenticated.
 */
export interface SetupFrameChannel extends FrameChannel {
    start(deadline: Deadline): Promise<void>;
    beginFrames(): void;
}
export declare class ByteBudget {
    readonly cap: number;
    used: number;
    peak: number;
    onRelease: (() => void) | null;
    private frozen;
    constructor(cap: number);
    wouldExceed(bytes: number): boolean;
    charge(bytes: number): void;
    release(bytes: number): void;
    freeze(): void;
}
export declare function headerViolation(header: EnvelopeHeader): {
    reason: "role_violation" | "protocol_violation";
    detail: string;
} | null;
export {};
//# sourceMappingURL=frame-channel.d.ts.map