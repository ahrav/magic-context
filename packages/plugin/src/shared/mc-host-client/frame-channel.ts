/**
 * Internal complete-frame channel boundary (KTD1).
 *
 * A channel owns transport mechanics only: it admits complete outbound v2
 * frames into one logical writer, yields complete structurally validated
 * inbound frames, and reports its own failure exactly once. Role,
 * correlation, route, and terminal semantics stay in the generation engine
 * above the boundary. TypeScript is single-threaded, so one object carries
 * both the sender and receiver halves that the Rust contract splits into a
 * clonable sender and a single-owner receiver.
 *
 * Payload ownership: inbound bodies are transport-owned complete views
 * whose transient buffering is charged to the shared {@link ByteBudget};
 * the charge is released at delivery, and a receiver that retains a body
 * re-charges the retained bytes itself.
 *
 * This boundary is private to the client and is not exported from
 * `index.ts`.
 */

import type { Deadline } from "./deadline";
import { type EnvelopeHeader, FrameType, isLegalHostToConsumerType } from "./protocol";

/**
 * Reasons a channel can close itself. Every value except `truncated_frame`
 * is also a generation `RetirementReason`, so a channel failure retires the
 * generation under the same reason string; the generation maps
 * `truncated_frame` to `eof` at the boundary.
 */
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
    | "control_capacity_exhausted";

/** One complete, structurally validated inbound frame. */
export interface InboundFrame {
    readonly header: EnvelopeHeader;
    /**
     * Transport-owned complete body view. Ownership transfers to the
     * receiver at delivery: the channel's transient buffering charge is
     * released, and retained bytes must be re-charged to the shared budget
     * by the retainer.
     */
    readonly body: Uint8Array;
}

/** One complete outbound frame; `header.len` must equal `body.length`. */
export interface OutboundFrame {
    readonly header: EnvelopeHeader;
    readonly body: Uint8Array;
}

export interface FrameSendHooks {
    /**
     * Publication start (KTD4's possible-send boundary): fired exactly once,
     * immediately before the transport begins writing any byte of this
     * frame. Before it fires, the frame is provably unsent.
     */
    onPublish?: () => void;
    /**
     * Local completion: every byte of the frame was handed to the
     * transport. Proves local handling only, never peer receipt.
     */
    onComplete?: () => void;
}

/** Handle for one admitted outbound frame. */
export interface FrameSendTicket {
    /** Total accounted bytes (header plus body). */
    readonly bytes: number;
    /**
     * Remove the frame while it is still queued and unpublished. Returns
     * `false` once publication started or after the channel closed; the
     * caller must treat a `false` as a possible send.
     */
    cancel(): boolean;
}

/** Redacted per-frame identity for diagnostics events. */
export interface FrameMeta {
    ty: number;
    channel: number;
    epoch: number;
    corr: bigint;
    len: number;
}

export type FrameChannelDiagnosticType = "write_start" | "write_complete" | "header";

/** Callbacks wired at channel construction; the channel never imports the generation. */
export interface FrameChannelHandlers {
    /** One complete inbound frame, delivered in wire order. */
    onFrame: (frame: InboundFrame) => void;
    /**
     * Exactly-once channel-detected failure. Owner-initiated `close()`
     * never fires it.
     */
    onClosed: (reason: FrameChannelCloseReason, error: unknown) => void;
    /** Bounded read-only diagnostics hook; exceptions are swallowed. */
    onDiagnostic?: (type: FrameChannelDiagnosticType, meta: FrameMeta) => void;
}

export interface FrameChannelStats {
    readerHeldBytes: number;
    queueHeldBytes: number;
    queuedDataFrames: number;
    queuedControlFrames: number;
    readPaused: boolean;
    activeTimers: number;
}

/**
 * Directional complete-frame channel (KTD1). Implementations own the
 * transport: framing, ordering, backpressure, and transport teardown.
 */
export interface FrameChannel {
    /**
     * Synchronously admit one data frame to the single logical writer.
     * Throws a `not_sent` `SubcCallError` (`writer_queue_full`,
     * `memory_cap`, or `channel_closed`) when admission is refused; a
     * refusal changes no channel state.
     */
    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket;
    /**
     * Admit one pure-header control frame through reserved capacity.
     * Reserve exhaustion fails the channel (`control_capacity_exhausted`)
     * because required cleanup can no longer queue safely.
     */
    sendControl(header: EnvelopeHeader): void;
    /**
     * Resolve once every queued frame byte was handed to the transport and
     * locally acknowledged, the channel closes, or `deadline` expires.
     * Never blocks close.
     */
    flush(deadline: Deadline): Promise<void>;
    /**
     * Idempotent owner close (abortive discard): drop queued frames,
     * release every byte charge, reject in-flight setup waits, and tear the
     * transport down. Never fires `onClosed`.
     */
    close(error?: unknown): void;
    isClosed(): boolean;
    stats(): FrameChannelStats;
}

/** `start()` attaches the transport; callers invoke `beginFrames()` separately to begin frame delivery. */
export interface SetupFrameChannel extends FrameChannel {
    start(deadline: Deadline): Promise<{ daemonVer: string }>;
    beginFrames(): void;
}

/**
 * Neutral aggregate byte-budget owner (KTD7's one aggregate cap), shared
 * between the generation (retained pending bytes) and the channel (reader
 * and writer-queue bytes). Releases notify the channel so paused inbound
 * admission and flush waiters re-check; freezing at retirement turns every
 * late release into a no-op and zeroes the live charge.
 */
export class ByteBudget {
    used = 0;
    peak = 0;
    /** Single release observer (the owning channel). */
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

    /** Idempotent: zero the live charge and ignore every later release. */
    freeze(): void {
        this.frozen = true;
        this.used = 0;
    }
}

/**
 * Header-only legality beyond `validateHeader`: direction and the direct
 * profile's identity/body rules that are decidable BEFORE body allocation
 * (wire doc Section 6.2 table). These are consumer-side rules shared by
 * every channel implementation, so each channel enforces them before it
 * allocates or delivers a body. A violation closes the channel without
 * resync.
 */
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
