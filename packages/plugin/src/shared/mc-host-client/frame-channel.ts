import { Buffer } from "node:buffer";
import type { Deadline } from "./deadline";
import { type EnvelopeHeader, FrameType, isLegalHostToConsumerType } from "./protocol";

export type FrameChannelCloseReason =
    | "socket_error"
    | "eof"
    | "truncated_frame"
    | "socket_closed"
    | "socket_timeout"
    | "protocol_violation"
    | "role_violation"
    | "frame_deadline"
    | "write_failed"
    | "control_capacity_exhausted"
    | "quarantined";

export type ProducerFrameHeader = Omit<EnvelopeHeader, "len">;

export class CopyCounter {
    copies = 0;

    record(): void {
        this.copies++;
    }
}

export type ReceiveReleaseOutcome = "released" | "quarantined";

export class ReceiveLease {
    private released = false;
    private readonly originalLengths: readonly number[];

    constructor(
        private readonly leasedSegments: readonly Uint8Array[],
        private readonly onRelease: (outcome: ReceiveReleaseOutcome) => void,
        private readonly copies: CopyCounter,
        private readonly detachAliases?: () => ReceiveReleaseOutcome,
    ) {
        for (const segment of leasedSegments) {
            if (
                !(segment.buffer instanceof ArrayBuffer) ||
                segment.byteOffset !== 0 ||
                segment.byteLength !== segment.buffer.byteLength
            ) {
                throw new RangeError("receive segment must have an exact-bounds ArrayBuffer");
            }
        }
        this.originalLengths = leasedSegments.map((segment) => segment.byteLength);
    }

    get byteLength(): number {
        this.assertActive();
        return this.originalLengths.reduce((total, length) => total + length, 0);
    }

    get segmentCount(): number {
        this.assertActive();
        return this.leasedSegments.length;
    }

    segment(index: number): Uint8Array {
        this.assertActive();
        const segment = this.leasedSegments[index];
        if (!segment) throw new RangeError(`receive segment ${index} does not exist`);
        return segment;
    }

    takeOwned(): Uint8Array {
        this.assertActive();
        const owned = new Uint8Array(this.byteLength);
        let offset = 0;
        for (const segment of this.leasedSegments) {
            owned.set(segment, offset);
            offset += segment.byteLength;
        }
        this.copies.record();
        this.release();
        return owned;
    }

    release(): boolean {
        if (this.released) return false;
        this.released = true;
        let outcome: ReceiveReleaseOutcome = "released";
        if (this.detachAliases) {
            try {
                outcome = this.detachAliases();
            } catch {
                outcome = "quarantined";
            }
        } else {
            for (let i = 0; i < this.leasedSegments.length; i++) {
                const segment = this.leasedSegments[i] as Uint8Array;
                const expected = this.originalLengths[i] as number;
                const buffer = segment.buffer;
                if (!(buffer instanceof ArrayBuffer) || (expected > 0 && buffer.byteLength === 0)) {
                    outcome = "quarantined";
                    continue;
                }
                try {
                    structuredClone(buffer, { transfer: [buffer] });
                } catch {
                    outcome = "quarantined";
                    continue;
                }
                if (buffer.byteLength !== 0) outcome = "quarantined";
            }
        }
        this.onRelease(outcome);
        if (outcome === "quarantined") {
            throw new Error("receive lease alias state is uncertain; storage quarantined");
        }
        return true;
    }

    isReleased(): boolean {
        return this.released;
    }

    [Symbol.dispose](): void {
        this.release();
    }

    private assertActive(): void {
        if (this.released) throw new Error("receive lease is released");
    }
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

const BODY_MATERIALIZERS = new WeakMap<DirectFrameBody, () => MaterializedFrameBody>();

export function frameBodyMaterializer(
    body: DirectFrameBody,
): (() => MaterializedFrameBody) | undefined {
    return BODY_MATERIALIZERS.get(body);
}

export function bytesFrameBody(bytes: Uint8Array): DirectFrameBody {
    const body: DirectFrameBody = {
        byteLength: bytes.byteLength,
        fill: (cursor) => cursor.write(bytes),
    };
    BODY_MATERIALIZERS.set(body, () => ({ bytes: Buffer.from(bytes), copied: true }));
    return body;
}

const UTF8_ENCODER = new TextEncoder();
const SPLIT_CODE_POINT = new Uint8Array(4);

export function utf8FrameBody(text: string): DirectFrameBody {
    const byteLength = Buffer.byteLength(text, "utf8");
    const body: DirectFrameBody = {
        byteLength,
        fill: (cursor) => writeUtf8(cursor, text, byteLength),
    };
    BODY_MATERIALIZERS.set(body, () => ({ bytes: Buffer.from(text, "utf8"), copied: false }));
    return body;
}

function writeUtf8(cursor: FrameProducerCursor, text: string, byteLength: number): void {
    const initialWritten = cursor.written;
    let offset = 0;
    while (offset < text.length) {
        const view = cursor.view();
        const encoded = UTF8_ENCODER.encodeInto(text.slice(offset), view);
        if (encoded.read > 0) {
            cursor.advance(encoded.written);
            offset += encoded.read;
            continue;
        }

        // When encodeInto cannot consume the next scalar, fixed scratch lets
        // cursor.write split that scalar across transport spans.
        const sourceCodePoint = text.codePointAt(offset);
        if (sourceCodePoint === undefined) throw new RangeError("invalid UTF-16 input");
        const codePoint =
            sourceCodePoint >= 0xd800 && sourceCodePoint <= 0xdfff ? 0xfffd : sourceCodePoint;
        const width = encodeCodePoint(codePoint, SPLIT_CODE_POINT);
        cursor.write(SPLIT_CODE_POINT.subarray(0, width));
        offset += sourceCodePoint > 0xffff ? 2 : 1;
    }
    if (cursor.written - initialWritten !== byteLength) {
        throw new RangeError("UTF-8 producer length mismatch");
    }
}

function encodeCodePoint(codePoint: number, out: Uint8Array): number {
    if (codePoint <= 0x7f) {
        out[0] = codePoint;
        return 1;
    }
    if (codePoint <= 0x7ff) {
        out[0] = 0xc0 | (codePoint >> 6);
        out[1] = 0x80 | (codePoint & 0x3f);
        return 2;
    }
    if (codePoint <= 0xffff) {
        out[0] = 0xe0 | (codePoint >> 12);
        out[1] = 0x80 | ((codePoint >> 6) & 0x3f);
        out[2] = 0x80 | (codePoint & 0x3f);
        return 3;
    }
    out[0] = 0xf0 | (codePoint >> 18);
    out[1] = 0x80 | ((codePoint >> 12) & 0x3f);
    out[2] = 0x80 | ((codePoint >> 6) & 0x3f);
    out[3] = 0x80 | (codePoint & 0x3f);
    return 4;
}

export interface FrameSendHooks {
    onPublish?: () => void;
    onComplete?: () => void;
}

export interface FrameSendTicket {
    cancel(): boolean;
}

export type ProducerErrorCode =
    | "producer_aborted"
    | "producer_overflow"
    | "producer_underfill"
    | "producer_commit_outside_reservation";

export class ProducerError extends Error {
    constructor(readonly code: ProducerErrorCode) {
        super(code);
        this.name = "ProducerError";
    }
}

interface PreparedProducerCommit {
    publish(): FrameSendTicket;
}

export class BoundedFrameProducer implements FrameProducerCursor {
    private cursor = 0;
    private active = true;

    constructor(
        private readonly producerSegments: readonly Uint8Array[],
        readonly capacity: number,
        private readonly prepareCommit: (
            segments: readonly Uint8Array[],
            exactLength: number,
        ) => PreparedProducerCommit,
        private readonly releaseReservation: () => void,
        private readonly detachOnCommit = true,
    ) {
        try {
            const available = producerSegments.reduce((total, segment) => {
                if (
                    !(segment.buffer instanceof ArrayBuffer) ||
                    segment.byteOffset !== 0 ||
                    segment.byteLength !== segment.buffer.byteLength
                ) {
                    throw new RangeError("producer segment must have an exact-bounds ArrayBuffer");
                }
                return total + segment.byteLength;
            }, 0);
            if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > available) {
                throw new RangeError("producer capacity exceeds reserved spans");
            }
        } catch (error) {
            this.active = false;
            this.releaseReservation();
            throw error;
        }
    }

    get written(): number {
        return this.cursor;
    }

    get remaining(): number {
        return this.capacity - this.cursor;
    }

    view(): Uint8Array {
        this.assertActive();
        let offset = this.cursor;
        for (const segment of this.producerSegments) {
            if (offset < segment.byteLength) {
                return segment.subarray(
                    offset,
                    Math.min(segment.byteLength, offset + this.remaining),
                );
            }
            offset -= segment.byteLength;
        }
        return new Uint8Array(new ArrayBuffer(0));
    }

    advance(bytes: number): void {
        this.assertActive();
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining) {
            this.abortWith("producer_overflow");
        }
        this.cursor += bytes;
    }

    write(bytes: Uint8Array): void {
        this.assertActive();
        if (bytes.byteLength > this.remaining) this.abortWith("producer_overflow");
        let sourceOffset = 0;
        let absolute = this.cursor;
        for (const segment of this.producerSegments) {
            if (sourceOffset === bytes.byteLength) break;
            if (absolute >= segment.byteLength) {
                absolute -= segment.byteLength;
                continue;
            }
            const take = Math.min(segment.byteLength - absolute, bytes.byteLength - sourceOffset);
            segment.set(bytes.subarray(sourceOffset, sourceOffset + take), absolute);
            sourceOffset += take;
            absolute = 0;
        }
        this.cursor += bytes.byteLength;
    }

    commit(exactLength: number): FrameSendTicket {
        this.assertActive();
        if (!Number.isSafeInteger(exactLength) || exactLength < 0 || exactLength > this.capacity) {
            this.abortWith("producer_commit_outside_reservation");
        }
        if (this.cursor !== exactLength) this.abortWith("producer_underfill");

        let prepared: PreparedProducerCommit;
        try {
            prepared = this.prepareCommit(this.committedSegments(exactLength), exactLength);
            if (this.detachOnCommit) this.detachProducerAliases();
        } catch (error) {
            this.abort();
            throw error;
        }
        this.active = false;
        try {
            return prepared.publish();
        } catch (error) {
            this.releaseReservation();
            throw error;
        }
    }

    abort(): void {
        if (!this.active) return;
        this.active = false;
        this.releaseReservation();
        this.detachProducerAliases(false);
    }

    private committedSegments(exactLength: number): readonly Uint8Array[] {
        const committed: Uint8Array[] = [];
        let remaining = exactLength;
        for (const segment of this.producerSegments) {
            if (remaining === 0) break;
            const take = Math.min(segment.byteLength, remaining);
            committed.push(segment.subarray(0, take));
            remaining -= take;
        }
        return committed;
    }

    private detachProducerAliases(strict = true): void {
        for (const segment of this.producerSegments) {
            const buffer = segment.buffer;
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) continue;
            try {
                structuredClone(buffer, { transfer: [buffer] });
            } catch (error) {
                if (strict) throw error;
            }
            if (strict && buffer.byteLength !== 0) {
                throw new Error("producer alias detachment failed");
            }
        }
    }

    private abortWith(code: ProducerErrorCode): never {
        this.abort();
        throw new ProducerError(code);
    }

    private assertActive(): void {
        if (!this.active) throw new ProducerError("producer_aborted");
    }
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
    produce(
        header: ProducerFrameHeader,
        body: DirectFrameBody,
        hooks?: FrameSendHooks,
        deadline?: Deadline,
    ): FrameSendTicket;
    reserve(
        header: ProducerFrameHeader,
        capacity: number,
        hooks?: FrameSendHooks,
    ): BoundedFrameProducer;
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

export class ByteBudget {
    used = 0;
    peak = 0;
    onRelease: (() => void) | null = null;
    private frozen = false;

    constructor(readonly cap: number) {}

    wouldExceed(bytes: number): boolean {
        return this.used + bytes > this.cap;
    }

    charge(bytes: number): void {
        this.used += bytes;
        if (this.used > this.peak) this.peak = this.used;
    }

    release(bytes: number): void {
        if (this.frozen) return;
        this.used -= bytes;
        this.onRelease?.();
    }

    freeze(): void {
        this.frozen = true;
        this.used = 0;
    }
}

export function headerViolation(
    header: EnvelopeHeader,
): { reason: "role_violation" | "protocol_violation"; detail: string } | null {
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
