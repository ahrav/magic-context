import {
    NativeChannel,
    type NativeProducerReservation,
    type NativeReceiveLease,
    type NativeSetupOptions,
    type ProducerCursor,
} from "@cortexkit/mc-shm-native";
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
    headerViolation,
    type OutboundFrame,
    type ProducerFrameHeader,
    ReceiveLease,
    type SetupFrameChannel,
} from "./frame-channel";
import {
    decodeHeader,
    type EnvelopeHeader,
    encodeHeader,
    HEADER_LEN,
    PROTOCOL_VERSION,
} from "./protocol";

class InboundFrameError extends Error {
    constructor(
        readonly reason: "protocol_violation" | "role_violation",
        message: string,
    ) {
        super(message);
    }
}

export interface ShmFrameChannelOptions {
    /** Injected only by unit tests; production attaches through `setup`. */
    nativeChannel?: NativeChannel;
    setup?: NativeSetupOptions;
    budget: ByteBudget;
    maxBodyLen: number;
    handlers: FrameChannelHandlers;
}

// Explicit reservations have no published frame and may make one bounded capacity probe.
const MAX_RESERVATION_BLOCK_MS = 5;

/** A full ring is backpressure, so callers may retry rather than fail the route. commentlint: allow(JUDGE) */
function ringFullError(cause: unknown): McHostCallError {
    return new McHostCallError(
        "not_sent",
        "shared-memory ring has no capacity for this frame",
        "ring_full",
        cause,
    );
}

function isRingFull(error: unknown): boolean {
    return error instanceof Error && error.message === "shared-memory ring is full";
}

export class ShmFrameChannel implements SetupFrameChannel {
    private native: NativeChannel | null;
    private readonly copies = new CopyCounter();
    private readinessStarted = false;
    private drainScheduled = false;
    private closed = false;
    private readonly receiveLeases = new Set<ReceiveLease>();
    private quarantinedBytes = 0;
    private heldBytes = 0;

    constructor(private readonly options: ShmFrameChannelOptions) {
        if (!options.nativeChannel && !options.setup) {
            throw new Error("shared-memory channel requires an attachment");
        }
        this.native = options.nativeChannel ?? null;
    }

    async start(deadline: Deadline): Promise<void> {
        if (this.closed) {
            throw new McHostCallError("not_sent", "shared-memory channel closed");
        }
        if (!this.native) {
            const setup = this.options.setup;
            if (!setup) throw new Error("shared-memory setup is missing");
            if (deadline.remainingMs() <= 0) {
                throw new McHostCallError("not_sent", "shared-memory setup deadline expired");
            }
            this.native = await NativeChannel.connectSetup({
                ...setup,
                timeoutMs: Math.max(1, Math.ceil(deadline.remainingMs())),
            });
            if (this.closed) {
                this.native.close();
                this.native = null;
                throw new McHostCallError("not_sent", "shared-memory channel closed");
            }
        }
    }

    beginFrames(): void {
        if (this.readinessStarted) return;
        this.readinessStarted = true;
        this.attached().startReadiness(() => this.drainReady());
    }

    produce(
        header: ProducerFrameHeader,
        body: DirectFrameBody,
        hooks?: FrameSendHooks,
        deadline?: Deadline,
    ): FrameSendTicket {
        if (this.closed) throw new McHostCallError("not_sent", "shared-memory channel closed");
        this.assertBodyBounds(body.byteLength);
        // The native ring's fixed capacity is not the configured aggregate
        // cap: admission consults the shared budget so an over-cap body is
        // refused with `memory_cap`. The
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
        if (this.closed) throw new McHostCallError("not_sent", "shared-memory channel closed");
        this.assertBodyBounds(capacity);
        // Reservations hold ring capacity across event-loop turns, so
        // their budget charge is held until publication or abort.
        const reservedBytes = HEADER_LEN + capacity;
        this.admitPublication(reservedBytes);
        let reservation: NativeProducerReservation;
        try {
            reservation = this.attached().reserve(capacity, MAX_RESERVATION_BLOCK_MS);
        } catch (error) {
            this.releasePublication(reservedBytes);
            if (isRingFull(error)) throw ringFullError(error);
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
            activeTimers: 0,
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
        _deadline?: Deadline,
    ): FrameSendTicket {
        if (this.closed) throw new McHostCallError("not_sent", "shared-memory channel closed");
        let published = false;
        try {
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
                0,
            );
        } catch (error) {
            if (isRingFull(error)) throw ringFullError(error);
            throw error;
        }
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

    private drainReady(): void {
        if (this.closed) return;
        try {
            for (let frames = 0; frames < 64; frames += 1) {
                if (
                    !this.attached().drainOne((nativeLease: NativeReceiveLease) => {
                        const header = decodeHeader(nativeLease.header);
                        const violation = headerViolation(header);
                        const structuralError =
                            header.ver !== PROTOCOL_VERSION
                                ? "unsupported protocol version"
                                : header.len !== nativeLease.byteLength
                                  ? "ring frame length mismatch"
                                  : header.len > this.options.maxBodyLen
                                    ? "ring frame exceeds configured body limit"
                                    : null;
                        if (structuralError !== null || violation !== null) {
                            nativeLease.release();
                            throw new InboundFrameError(
                                violation?.reason ?? "protocol_violation",
                                structuralError ?? violation?.detail ?? "invalid ring frame",
                            );
                        }
                        const segments = Array.from(
                            { length: nativeLease.segmentCount },
                            (_, index) => nativeLease.segment(index),
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
                ) {
                    // Readiness includes setup-socket closure. Check only after an empty drain so graceful Goodbye reaches dispatcher first. commentlint: allow(JUDGE)
                    if (this.attached().peerClosed()) {
                        this.options.handlers.onClosed("eof", undefined);
                        try {
                            this.close();
                        } catch {
                            // close() rethrows on quarantined leases; readiness callback has no caller.
                        }
                    }
                    return;
                }
            }
            if (!this.drainScheduled) {
                this.drainScheduled = true;
                queueMicrotask(() => {
                    this.drainScheduled = false;
                    if (!this.closed) this.drainReady();
                });
            }
            return;
        } catch (error) {
            this.options.handlers.onClosed(
                error instanceof InboundFrameError ? error.reason : "protocol_violation",
                error,
            );
            try {
                this.close();
            } catch {
                // close() already reported a quarantined lease. Readiness
                // callbacks have no caller to observe the repeated throw.
            }
        }
    }
}
