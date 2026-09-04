/**
 * Reusable semantic contract suite for the complete-frame channel (KTD8).
 *
 * Every scenario is expressed against a provider-neutral factory, so TCP
 * runs the inventory now and a later provider (for example shared memory)
 * registers its own factory and reruns the same scenarios unchanged.
 * Adapter-specific behavior (socket fragmentation, auth leftover, EOF
 * variants) belongs in each adapter's own suite, not here.
 *
 * Runtime-neutral: `node:assert/strict` only — no bun:test — so the same
 * scenarios also execute under Node 24 through the existing bundle runner.
 */
import { ByteBudget, type FrameChannel, type FrameChannelCloseReason, type InboundFrame } from "../frame-channel";
import { type EnvelopeHeader } from "../protocol";
/** One frame decoded by the remote end's own independent decoder. */
export interface ContractPeerFrame {
    ty: number;
    flags: number;
    channel: number;
    epoch: number;
    corr: bigint;
    len: number;
    body: Uint8Array;
}
export interface ContractPeerFrameFields {
    ty: number;
    flags?: number;
    channel?: number;
    epoch?: number;
    corr?: bigint;
    body?: Uint8Array;
    /** Overrides for malformed frames; default to the true values. */
    len?: number;
    ver?: number;
}
/** The remote end of a channel under contract test. */
export interface ContractPeer {
    readonly frames: readonly ContractPeerFrame[];
    send(fields: ContractPeerFrameFields): Promise<void>;
    /** Deliver several frames as one coalesced burst when the transport allows. */
    sendBurst(fields: ContractPeerFrameFields[]): Promise<void>;
    waitFor(check: () => boolean, timeoutMs?: number): Promise<void>;
    /** Backpressure: stop consuming the channel's outbound bytes. */
    pauseReading(): void;
    resumeReading(): void;
    /** Clean end-of-stream toward the channel. */
    end(): void;
    /** Abortive teardown toward the channel. */
    destroy(): void;
}
export interface ContractChannelOverrides {
    frameDeadlineMs?: number;
    maxBodyLen?: number;
    memoryCapBytes?: number;
    maxQueuedFrames?: number;
    maxQueuedBytes?: number;
    controlReserveFrames?: number;
    producerSpanBytes?: number;
}
export interface ContractReceivedFrame {
    header: EnvelopeHeader;
    body: Uint8Array;
}
/** One live channel/peer pair plus the factory-recorded observations. */
export interface FrameChannelContractHandle {
    channel: FrameChannel;
    budget: ByteBudget;
    peer: ContractPeer;
    /** Whether releasing a lease must revoke aliases before backing storage is reused. */
    reusesReceiveStorage: boolean;
    /** The contract factory retains owned bodies after the provider releases each inbound lease. */
    received: ContractReceivedFrame[];
    /** Channel-detected closes, in order (owner close never records here). */
    closes: {
        reason: FrameChannelCloseReason;
        error: unknown;
    }[];
    /** Scenario-installed hook, run before each delivery is recorded. */
    frameHook: ((frame: InboundFrame) => boolean | undefined) | null;
    cleanup(): Promise<void>;
}
export type FrameChannelContractFactory = (overrides?: ContractChannelOverrides) => Promise<FrameChannelContractHandle>;
export interface FrameChannelContractScenario {
    name: string;
    run(create: FrameChannelContractFactory): Promise<void>;
}
/** Run one scenario with automatic cleanup of every created handle. */
export declare function runFrameChannelContractScenario(scenario: FrameChannelContractScenario, factory: FrameChannelContractFactory): Promise<void>;
export declare const frameChannelContractScenarios: readonly FrameChannelContractScenario[];
/** Live, authenticated TCP channel/peer pair for the contract suite. */
export declare const tcpFrameChannelContractFactory: FrameChannelContractFactory;
//# sourceMappingURL=frame-channel-contract.d.ts.map