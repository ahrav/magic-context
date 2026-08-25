import {
    NativeChannel,
    type NativeDescriptor,
    type NativeProducerReservation,
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
        // Attachment I/O (fd opens, grant validation, mappings) belongs in
        // the deadline-raced start() phase per the provider contract, so a
        // descriptor is only recorded here; a pre-attached channel carries
        // no attachment I/O and is adopted directly.
        this.native = options.nativeChannel ?? null;
    }

    async start(deadline: Deadline): Promise<{ daemonVer: string }> {
        if (this.closed) {
            throw new SubcCallError("not_sent", "shared-memory channel closed");
        }
        if (!this.native) {
            if (deadline.remainingMs() <= 0) {
                throw new SubcCallError("not_sent", "shared-memory setup deadline expired");
            }
            this.native = NativeChannel.attach(this.options.descriptor as NativeDescriptor);
        }
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
        this.assertBodyBounds(body.byteLength);
        // The native ring's fixed capacity is not the configured aggregate
        // cap: admission consults the shared budget so an over-cap body is
        // refused with `memory_cap`, exactly like the TCP channel. The
        // charge covers the synchronous publication window and is returned
        // once the ring owns the bytes.
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
        if (this.closed) throw new SubcCallError("not_sent", "shared-memory channel closed");
        this.assertBodyBounds(capacity);
        // Reservations hold ring capacity across event-loop turns, so
        // their budget charge is held until publication or abort.
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
                    if (!held) throw new SubcCallError("not_sent", "reservation released");
                    let published = false;
                    reservation.commit(
                        encodeHeader({ ...header, len: exactLength }),
                        exactLength,
                        () => {
                            published = true;
                            try {
                                hooks?.onPublish?.();
                            } catch {
                                // Send hooks cannot change publication.
                            }
                        },
                    );
                    held = false;
                    releaseCharge();
                    try {
                        hooks?.onComplete?.();
                    } catch {
                        // Send hooks cannot change completion.
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
        // Late control sends on a closed channel are silent no-ops per the
        // FrameChannel contract; callers such as enqueueControlHeader do not
        // catch, so a throw here would unwind frame dispatch or teardown.
        if (this.closed) return;
        // Control frames stay uncharged, matching the TCP channel's
        // never-cap-refused control path.
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
            // Alias state is uncertain: unmapping under a live view would
            // trade a bounded leak for a use-after-free, so the native close
            // is withheld and the quarantine is reported.
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
            throw new SubcCallError("not_sent", "shared-memory channel is not started");
        }
        return this.native;
    }

    /**
     * The configured frame limit and integer validity are enforced before
     * any budget charge or native call: a non-safe length (`NaN`, negative,
     * fractional) would poison `ByteBudget.used`, and the shared-memory
     * path must reject the same over-limit bodies TCP rejects.
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
        if (this.closed) throw new SubcCallError("not_sent", "shared-memory channel closed");
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
            throw new SubcCallError(
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
            // Drains until the native side reports no progress. Consumer
            // backpressure (retained leases at the ring's lease bound) is
            // reported by `native.poll()` as `false`, not an error, so the
            // drain pauses at the bound and the interval resumes delivery
            // after a lease release; only genuine failures reach the catch.
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
                // close() rethrows on quarantined leases and has already
                // reported that outcome; an interval callback has no caller
                // to observe the throw, so it must not escape here.
            }
        }
    }
}
