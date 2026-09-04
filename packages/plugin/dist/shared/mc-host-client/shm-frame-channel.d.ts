import { NativeChannel, type NativeDescriptor } from "@cortexkit/mc-shm-native";
import type { Deadline } from "./deadline";
import { BoundedFrameProducer, type ByteBudget, type DirectFrameBody, type FrameChannelHandlers, type FrameChannelStats, type FrameSendHooks, type FrameSendTicket, type OutboundFrame, type ProducerFrameHeader, type SetupFrameChannel } from "./frame-channel";
import { type EnvelopeHeader } from "./protocol";
export interface ShmFrameChannelOptions {
    descriptor?: NativeDescriptor;
    nativeChannel?: NativeChannel;
    budget: ByteBudget;
    maxBodyLen: number;
    handlers: FrameChannelHandlers;
}
export declare class ShmFrameChannel implements SetupFrameChannel {
    private readonly options;
    private native;
    private readonly copies;
    private timer;
    private closed;
    private readonly receiveLeases;
    private quarantinedBytes;
    private heldBytes;
    constructor(options: ShmFrameChannelOptions);
    start(deadline: Deadline): Promise<void>;
    beginFrames(): void;
    produce(header: ProducerFrameHeader, body: DirectFrameBody, hooks?: FrameSendHooks, deadline?: Deadline): FrameSendTicket;
    reserve(header: ProducerFrameHeader, capacity: number, hooks?: FrameSendHooks): BoundedFrameProducer;
    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket;
    sendControl(header: EnvelopeHeader): void;
    flush(_deadline: Deadline): Promise<void>;
    close(): void;
    isClosed(): boolean;
    stats(): FrameChannelStats;
    private attached;
    /**
     * The configured frame limit and integer validity are enforced before
     * any budget charge or native call: a non-safe length (`NaN`, negative,
     * fractional) would poison `ByteBudget.used`, and the shared-memory
     * path must reject the same over-limit bodies TCP rejects.
     */
    private assertBodyBounds;
    private publishFrame;
    private admitPublication;
    private releasePublication;
    private poll;
}
//# sourceMappingURL=shm-frame-channel.d.ts.map