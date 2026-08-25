import {
    NativeChannel,
    type NativeDescriptor,
    type NativeReceiveLease,
    type ProducerCursor,
} from "@magic-context/mc-shm-native";
import type { Deadline } from "./deadline";
import { SubcCallError } from "./errors";
import {
    BoundedFrameProducer,
    type ByteBudget,
    CopyCounter,
    type DirectFrameBody,
    type FrameChannelHandlers,
    type FrameChannelStats,
    type FrameSendHooks,
    type FrameSendTicket,
    type OutboundFrame,
    type ProducerFrameHeader,
    ReceiveLease,
    type SetupFrameChannel,
} from "./frame-channel";
import { decodeHeader, encodeHeader, type EnvelopeHeader } from "./protocol";

export interface ShmFrameChannelOptions {
    descriptor?: NativeDescriptor;
    nativeChannel?: NativeChannel;
    budget: ByteBudget;
    handlers: FrameChannelHandlers;
}

export class ShmFrameChannel implements SetupFrameChannel {
    private readonly native: NativeChannel;
    private readonly copies = new CopyCounter();
    private timer: ReturnType<typeof setInterval> | null = null;
    private closed = false;
    private readonly receiveLeases = new Set<ReceiveLease>();
    private quarantinedBytes = 0;

    constructor(private readonly options: ShmFrameChannelOptions) {
        if (!options.nativeChannel && !options.descriptor) {
            throw new Error("shared-memory channel requires an attachment");
        }
        this.native = options.nativeChannel ?? NativeChannel.attach(options.descriptor as NativeDescriptor);
    }

    async start(_deadline: Deadline): Promise<{ daemonVer: string }> {
        return { daemonVer: "shared-memory-test" };
    }

    beginFrames(): void {
        if (this.timer !== null) return;
        this.timer = setInterval(() => this.poll(), 0);
    }

    produce(
        header: ProducerFrameHeader,
        body: DirectFrameBody,
        hooks?: FrameSendHooks,
        deadline?: Deadline,
    ): FrameSendTicket {
        if (this.closed) throw new SubcCallError("not_sent", "shared-memory channel closed");
        let published = false;
        this.native.produce(
            encodeHeader({ ...header, len: body.byteLength }),
            body.byteLength,
            (cursor: ProducerCursor) => body.fill(cursor),
            () => {
                published = true;
                try {
                    hooks?.onPublish?.();
                } catch {
                    // Send hooks cannot change publication.
                }
            },
            deadline?.remainingMs() ?? 0,
        );
        try {
            hooks?.onComplete?.();
        } catch {
            // Send hooks cannot change completion.
        }
        return { cancel: () => !published };
    }

    reserve(
        header: ProducerFrameHeader,
        capacity: number,
        hooks?: FrameSendHooks,
    ): BoundedFrameProducer {
        const spans = capacity === 0 ? [] : [new Uint8Array(new ArrayBuffer(capacity))];
        let held = true;
        return new BoundedFrameProducer(
            spans,
            capacity,
            (segments, exactLength) => ({
                publish: () => {
                    if (!held) throw new SubcCallError("not_sent", "reservation released");
                    const body = new Uint8Array(exactLength);
                    let offset = 0;
                    for (const segment of segments) {
                        body.set(segment, offset);
                        offset += segment.byteLength;
                    }
                    this.copies.record();
                    held = false;
                    return this.send({ header: { ...header, len: exactLength }, body }, hooks);
                },
            }),
            () => {
                held = false;
            },
        );
    }

    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket {
        this.copies.record();
        return this.produce(
            frame.header,
            {
                byteLength: frame.body.byteLength,
                fill: (cursor) => cursor.write(frame.body),
            },
            hooks,
        );
    }

    sendControl(header: EnvelopeHeader): void {
        this.produce(header, { byteLength: 0, fill: () => {} });
    }

    async flush(_deadline: Deadline): Promise<void> {}

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        for (const lease of [...this.receiveLeases]) {
            try {
                lease.release();
            } catch {
                continue;
            }
        }
        this.native.close();
    }

    isClosed(): boolean {
        return this.closed;
    }

    stats(): FrameChannelStats {
        return {
            readerHeldBytes: 0,
            queueHeldBytes: 0,
            queuedDataFrames: 0,
            queuedControlFrames: 0,
            readPaused: false,
            activeTimers: this.timer === null ? 0 : 1,
            activeReceiveLeases: this.receiveLeases.size,
            quarantinedBytes: this.quarantinedBytes,
            ownedAdapterCopies: this.copies.copies,
        };
    }

    private poll(): void {
        if (this.closed) return;
        try {
            while (
                this.native.poll((nativeLease: NativeReceiveLease) => {
                    const header = decodeHeader(nativeLease.header);
                    const segments = Array.from({ length: nativeLease.segmentCount }, (_, index) =>
                        nativeLease.segment(index),
                    );
                    let lease: ReceiveLease;
                    lease = new ReceiveLease(
                        segments,
                        (outcome) => {
                            this.receiveLeases.delete(lease);
                            if (outcome === "quarantined") this.quarantinedBytes += header.len;
                        },
                        this.copies,
                        () => {
                            nativeLease.release();
                            return "released";
                        },
                    );
                    this.receiveLeases.add(lease);
                    try {
                        this.options.handlers.onFrame({ header, body: lease });
                    } catch (error) {
                        lease.release();
                        throw error;
                    }
                })
            ) {}
        } catch (error) {
            this.options.handlers.onClosed("protocol_violation", error);
            this.close();
        }
    }
}
