/**
 * Shared runtime-neutral test helpers for the mc-host-client suites.
 * `node:assert/strict` only — no bun:test — so runtime-neutral callers
 * (like the adversarial scenario runner) can import everything here.
 */
import { ConnectionGeneration, type ConnectionGenerationOptions } from "../connection";
import { Deadline } from "../deadline";
import { McHostCallError } from "../errors";
import { BoundedFrameProducer, type DirectFrameBody, type FrameChannelHandlers, type FrameChannelStats, type FrameSendHooks, type FrameSendTicket, type OutboundFrame, type ProducerFrameHeader, type SetupFrameChannel } from "../frame-channel";
import { type EnvelopeHeader } from "../protocol";
import type { OpaqueObject } from "../transport-negotiation";
import type { ClientTransportProvider } from "../transport-provider";
import { FakePeer, type FakePeerOptions } from "./fake-peer";
/** Await a promise that MUST reject and return its rejection value. */
export declare function rejection(promise: Promise<unknown>): Promise<unknown>;
export declare function waitUntil(check: () => boolean, timeoutMs?: number): Promise<void>;
export declare function expectMcHostCallError(error: unknown, kind: McHostCallError["kind"], code?: string): McHostCallError;
export declare function writeConnectionFile(filePath: string, peer: FakePeer): Promise<void>;
/** Peer/generation factory whose creations are tracked for cleanup. */
export interface ScenarioContext {
    /** Start a tracked fake peer; closed by `cleanup()`. */
    startPeer(options?: FakePeerOptions): Promise<FakePeer>;
    /** Construct a tracked, unstarted generation dialing `peer`. */
    createGeneration(peer: FakePeer, overrides?: Partial<ConnectionGenerationOptions>): ConnectionGeneration;
    /** Construct AND start a tracked generation under `deadlineMs`. */
    dial(peer: FakePeer, overrides?: Partial<ConnectionGenerationOptions>, deadlineMs?: number): Promise<ConnectionGeneration>;
}
export interface TrackedHarness extends ScenarioContext {
    /** Retire every tracked generation, then close every tracked peer. */
    cleanup(): Promise<void>;
}
export declare function createTrackedHarness(): TrackedHarness;
/** One complete frame observed by the host half of the paired channel. */
export interface CandidateHostFrame {
    header: EnvelopeHeader;
    body: Uint8Array;
}
/**
 * Scriptable host half of one in-process paired candidate channel. Tests
 * set `onFrame` to script activation, commit, and application responses;
 * `close` fails the client half like a lost channel.
 */
export declare class FakeCandidateHost {
    readonly frames: CandidateHostFrame[];
    onFrame: ((frame: CandidateHostFrame, host: FakeCandidateHost) => void) | null;
    private channel;
    private readonly waiters;
    /** True once the client half was closed or failed. */
    get channelClosed(): boolean;
    attach(channel: FakeCandidateChannel): void;
    receive(frame: CandidateHostFrame): void;
    /** Deliver one frame to the client half. */
    send(header: Omit<EnvelopeHeader, "len" | "ver">, body?: Uint8Array): void;
    /** Deliver one JSON Response on channel 0 to the client half. */
    respondJson(corr: bigint, value: unknown): void;
    /** Fail the client half with a channel-detected loss. */
    close(error?: Error): void;
    waitFor(check: () => boolean, timeoutMs?: number): Promise<void>;
}
interface FakeCandidateChannelOptions {
    startError?: Error;
    /** `start()` returns a promise that never settles and ignores close. */
    startHang?: boolean;
    closeError?: Error;
}
/**
 * Client half of the paired candidate channel. Frames transfer in-process
 * as complete `{header, body}` objects; publication and completion hooks
 * fire synchronously at `send`, so a queued-cancel is never possible and
 * `cancel()` reports a possible send.
 */
declare class FakeCandidateChannel implements SetupFrameChannel {
    private readonly host;
    private readonly handlers;
    private readonly options;
    private closed;
    private began;
    private readonly inbox;
    private readonly leases;
    private readonly copies;
    constructor(host: FakeCandidateHost, handlers: FrameChannelHandlers, options: FakeCandidateChannelOptions);
    start(_deadline: Deadline): Promise<void>;
    beginFrames(): void;
    produce(header: ProducerFrameHeader, body: DirectFrameBody, hooks?: FrameSendHooks, _deadline?: Deadline): FrameSendTicket;
    reserve(header: ProducerFrameHeader, capacity: number, hooks?: FrameSendHooks): BoundedFrameProducer;
    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket;
    sendControl(header: EnvelopeHeader): void;
    flush(_deadline: Deadline): Promise<void>;
    close(_error?: unknown): void;
    isClosed(): boolean;
    stats(): FrameChannelStats;
    deliver(header: EnvelopeHeader, body: Uint8Array): void;
    failFromPeer(error: Error): void;
}
export interface FakeProviderOptions {
    transport?: string;
    capabilityVersion?: number;
    parameters?: OpaqueObject;
    /** Thrown from `connect` to exercise the sanitized provider boundary. */
    connectError?: Error;
    /** Rejected from the channel's `start` for the same boundary. */
    startError?: Error;
    /** The channel's `start` never settles, exercising the retirement race. */
    startHang?: boolean;
}
export interface FakePairedProvider extends ClientTransportProvider {
    readonly host: FakeCandidateHost;
    connectCount: number;
    lastDescriptor: OpaqueObject | null;
}
/** One injected provider paired with a scriptable in-process host half. */
export declare function createFakePairedProvider(options?: FakeProviderOptions): FakePairedProvider;
/**
 * Default host-half script: acknowledge `transport.activate` when the token
 * matches, acknowledge `transport.commit`, and hand every other Request to
 * `onRequest`.
 */
export declare function candidateAutoResponder(expectedToken: string, onRequest?: (frame: CandidateHostFrame, host: FakeCandidateHost) => void): (frame: CandidateHostFrame, host: FakeCandidateHost) => void;
export {};
//# sourceMappingURL=test-util.d.ts.map