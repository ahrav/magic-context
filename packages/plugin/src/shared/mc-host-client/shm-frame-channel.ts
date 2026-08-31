import {
    NativeChannel,
    type NativeDescriptor,
    type NativeProducerReservation,
    type NativeReceiveLease,
    type ProducerCursor,
} from "@magic-context/mc-shm-native";
import type { Deadline } from "./deadline";
import { McHostCallError } from "./errors";
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
import { decodeHeader, type EnvelopeHeader, encodeHeader, HEADER_LEN } from "./protocol";

export interface ShmFrameChannelOptions {
    descriptor?: NativeDescriptor;
    nativeChannel?: NativeChannel;
    budget: ByteBudget;
    maxBodyLen: number;
    handlers: FrameChannelHandlers;
}

export class ShmFrameChannel implements SetupFrameChannel {
    private native: NativeChannel | null;
    private readonly copies = new CopyCounter();
    private timer: ReturnType<typeof setInterval> | null = null;
    private closed = false;
    private readonly receiveLeases = new Set<ReceiveLease>();
    private quarantinedBytes = 0;
    private heldBytes = 0;

    constructor(private readonly options: ShmFrameChannelOptions) {
        if (!options.nativeChannel && !options.descriptor) {
            throw new Error("shared-memory channel requires an attachment");
        }
        // start() rejects attachment when the deadline has already expired.
        // The constructor records a descriptor without attaching it.
        // A pre-attached channel is adopted without attachment I/O.
        this.native = options.nativeChannel ?? null;
    }

    async start(deadline: Deadline): Promise<void> {
        if (this.closed) {
            throw new McHostCallError("not_sent", "shared-memory channel closed");
        }
        if (!this.native) {
            if (deadline.remainingMs() <= 0) {
                throw new McHostCallError("not_sent", "shared-memory setup deadline expired");
            }
            this.native = NativeChannel.attach(this.options.descriptor as NativeDescriptor);
        }
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
        if (this.closed) throw new McHostCallError("not_sent", "shared-memory channel closed");
        this.assertBodyBounds(body.byteLength);
        // The native ring capacity does not enforce the aggregate memory cap.
        // Admission uses the shared budget and rejects over-cap bodies with memory_cap.
        const reservedBytes = HEADER_LEN + body.byteLength;
        this.admitPublication(reservedBytes);
        try {
            return this.publishFrame(header, body, hooks, deadline);
        } finally {
            this.releasePublication(reservedBytes);
        }
    }

    reserve(
        header: ProducerFrameHeader,
        capacity: number,
        hooks?: FrameSendHooks,
    ): BoundedFrameProducer {
        if (this.closed) throw new McHostCallError("not_sent", "shared-memory channel closed");
        this.assertBodyBounds(capacity);
        // Reservations retain ring capacity across event-loop turns.
        // Reservation charges remain held until publication or abort.
        const reservedBytes = HEADER_LEN + capacity;
        this.admitPublication(reservedBytes);
        let reservation: NativeProducerReservation;
        try {
            reservation = this.attached().reserve(capacity);
        } catch (error) {
            this.releasePublication(reservedBytes);
            throw error;
        }
        let held = true;
        let charged = true;
        const releaseCharge = (): void => {
            if (!charged) return;
            charged = false;
            this.releasePublication(reservedBytes);
        };
        return new BoundedFrameProducer(
            reservation.segments,
            capacity,
            (_segments, exactLength) => ({
                publish: () => {
                    if (!held) throw new McHostCallError("not_sent", "reservation released");
                    let published = false;
                    reservation.commit(
                        encodeHeader({ ...header, len: exactLength }),
                        exactLength,
                        () => {
                            published = true;
                            try {
                                hooks?.onPublish?.();
                            } catch {
                            }
                        },
                    );
                    held = false;
                    releaseCharge();
                    try {
                        hooks?.onComplete?.();
                    } catch {
                    }
                    return { cancel: () => !published };
                },
            }),
            () => {
                if (!held) return;
                held = false;
                try {
                    reservation.abort();
                } finally {
                    releaseCharge();
                }
            },
            false,
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
        // Closed-channel control sends are no-ops under the FrameChannel contract.
        // FrameChannel requires closed-channel control sends to be no-ops; throwing would unwind frame dispatch or teardown.
        if (this.closed) return;
        // Control frames are uncharged.
        // Control frames are never refused by the memory cap.
        this.publishFrame(header, { byteLength: 0, fill: () => {} });
    }

    async flush(_deadline: Deadline): Promise<void> {}

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        let quarantineError: unknown;
        for (const lease of [...this.receiveLeases]) {
            try {
                lease.release();
            } catch (error) {
                quarantineError ??= error;
            }
        }
        if (quarantineError !== undefined) {
            // When alias state is uncertain, native close is withheld to avoid unmapping a live view.
            // Quarantined bytes are reported when alias state is uncertain.
            this.options.handlers.onClosed("quarantined", quarantineError);
            throw quarantineError;
        }
        if (this.native) this.native.close();
    }

    isClosed(): boolean {
        return this.closed;
    }

    stats(): FrameChannelStats {
        return {
            readerHeldBytes: 0,
            queueHeldBytes: this.heldBytes,
            queuedDataFrames: 0,
            queuedControlFrames: 0,
            readPaused: false,
            activeTimers: this.timer === null ? 0 : 1,
            activeReceiveLeases: this.receiveLeases.size,
            quarantinedBytes: this.quarantinedBytes,
            ownedAdapterCopies: this.copies.copies,
        };
    }

    private attached(): NativeChannel {
        if (!this.native) {
            throw new McHostCallError("not_sent", "shared-memory channel is not started");
        }
        return this.native;
    }

    /**
     * NaN, negative, and fractional lengths are rejected before budget accounting.
     * NaN would poison ByteBudget.used.
     * Reject lengths outside the configured limit before budget accounting.
     */
    private assertBodyBounds(byteLength: number): void {
        if (
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            byteLength > this.options.maxBodyLen
        ) {
            throw new RangeError("producer capacity is outside frame bounds");
        }
    }

    private publishFrame(
        header: ProducerFrameHeader,
        body: DirectFrameBody,
        hooks?: FrameSendHooks,
        deadline?: Deadline,
    ): FrameSendTicket {
        if (this.closed) throw new McHostCallError("not_sent", "shared-memory channel closed");
        let published = false;
        this.attached().produce(
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

    private admitPublication(bytes: number): void {
        if (this.options.budget.wouldExceed(bytes)) {
            throw new McHostCallError(
                "not_sent",
                "aggregate connection memory cap would be exceeded",
                "memory_cap",
            );
        }
        this.options.budget.charge(bytes);
        this.heldBytes += bytes;
    }

    private releasePublication(bytes: number): void {
        this.heldBytes -= bytes;
        this.options.budget.release(bytes);
    }

    private poll(): void {
        if (this.closed) return;
        try {
            // Retained leases at the ring lease bound stop native.poll() without an error.
            // native.poll() returns false, rather than throwing, when retained leases reach the ring lease bound.
            // The interval resumes delivery after a lease release.
            // Only native.poll() failures reach the error handler.
            while (
                this.attached().poll((nativeLease: NativeReceiveLease) => {
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
                            this.options.handlers.onLeaseReleased?.();
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
            try {
                this.close();
            } catch {
            }
        }
    }
}
