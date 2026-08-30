/**
 * Shared runtime-neutral test helpers for the mc-host-client suites.
 * `node:assert/strict` only — no bun:test — so runtime-neutral callers
 * (like the adversarial scenario runner) can import everything here.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectionGeneration, type ConnectionGenerationOptions } from "../connection";
import { Deadline } from "../deadline";
import { McHostCallError } from "../errors";
import {
    BoundedFrameProducer,
    CopyCounter,
    type DirectFrameBody,
    type FrameChannelHandlers,
    type FrameChannelStats,
    type FrameSendHooks,
    type FrameSendTicket,
    type InboundFrame,
    type OutboundFrame,
    type ProducerFrameHeader,
    ReceiveLease,
    type SetupFrameChannel,
} from "../frame-channel";
import { type EnvelopeHeader, FrameType, PROTOCOL_VERSION } from "../protocol";
import type { OpaqueObject } from "../transport-negotiation";
import type { CandidateChannelArgs, ClientTransportProvider } from "../transport-provider";
import { FakePeer, type FakePeerOptions } from "./fake-peer";

/** Await a promise that MUST reject and return its rejection value. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => {
            throw new Error("promise unexpectedly resolved");
        },
        (error: unknown) => error,
    );
}

export async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
    const startedAt = Date.now();
    while (!check()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("waitUntil timed out");
        }
        await delay(5);
    }
}

export function expectMcHostCallError(
    error: unknown,
    kind: McHostCallError["kind"],
    code?: string,
): McHostCallError {
    assert.ok(error instanceof McHostCallError, `expected McHostCallError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
}

export async function writeConnectionFile(filePath: string, peer: FakePeer): Promise<void> {
    const json = JSON.stringify({
        schema: 1,
        wire_version: 2,
        endpoints: [{ host: "127.0.0.1", port: peer.port }],
        key: Array.from(peer.key),
        daemon_id: Array.from(peer.daemonId),
        pid: process.pid,
        daemon_ver: "fake-peer/0.0.1",
    });
    await writeFile(filePath, json, { mode: 0o600 });
}

/** Peer/generation factory whose creations are tracked for cleanup. */
export interface ScenarioContext {
    /** Start a tracked fake peer; closed by `cleanup()`. */
    startPeer(options?: FakePeerOptions): Promise<FakePeer>;
    /** Construct a tracked, unstarted generation dialing `peer`. */
    createGeneration(
        peer: FakePeer,
        overrides?: Partial<ConnectionGenerationOptions>,
    ): ConnectionGeneration;
    /** Construct AND start a tracked generation under `deadlineMs`. */
    dial(
        peer: FakePeer,
        overrides?: Partial<ConnectionGenerationOptions>,
        deadlineMs?: number,
    ): Promise<ConnectionGeneration>;
}

export interface TrackedHarness extends ScenarioContext {
    /** Retire every tracked generation, then close every tracked peer. */
    cleanup(): Promise<void>;
}

export function createTrackedHarness(): TrackedHarness {
    const peers: FakePeer[] = [];
    const generations: ConnectionGeneration[] = [];
    const harness: TrackedHarness = {
        async startPeer(options?: FakePeerOptions): Promise<FakePeer> {
            const peer = await FakePeer.start(options);
            peers.push(peer);
            return peer;
        },
        createGeneration(
            peer: FakePeer,
            overrides: Partial<ConnectionGenerationOptions> = {},
        ): ConnectionGeneration {
            const generation = new ConnectionGeneration({
                host: "127.0.0.1",
                port: peer.port,
                credentials: {
                    key: peer.key,
                    daemonId: peer.daemonId,
                    daemonVer: peer.daemonVer,
                },
                ...overrides,
            });
            generations.push(generation);
            return generation;
        },
        async dial(
            peer: FakePeer,
            overrides: Partial<ConnectionGenerationOptions> = {},
            deadlineMs = 2_000,
        ): Promise<ConnectionGeneration> {
            const generation = harness.createGeneration(peer, overrides);
            await generation.start(Deadline.start(deadlineMs));
            return generation;
        },
        async cleanup(): Promise<void> {
            for (const generation of generations) {
                generation.retire("owner_close");
            }
            for (const peer of peers) {
                await peer.close();
            }
        },
    };
    return harness;
}

// ----------------------------------------------------------------------
// In-process paired candidate transport for injected-provider tests.
// ----------------------------------------------------------------------

/** One complete frame observed by the host half of the paired channel. */
export interface CandidateHostFrame {
    header: EnvelopeHeader;
    body: Uint8Array;
}

interface CandidateWaiter {
    check: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Scriptable host half of one in-process paired candidate channel. Tests
 * set `onFrame` to script activation, commit, and application responses;
 * `close` fails the client half like a lost channel.
 */
class FakeCandidateHost {
    readonly frames: CandidateHostFrame[] = [];
    onFrame: ((frame: CandidateHostFrame, host: FakeCandidateHost) => void) | null = null;
    private channel: FakeCandidateChannel | null = null;
    private readonly waiters: CandidateWaiter[] = [];

    /** True once the client half was closed or failed. */
    get channelClosed(): boolean {
        return this.channel?.isClosed() ?? false;
    }

    attach(channel: FakeCandidateChannel): void {
        this.channel = channel;
    }

    receive(frame: CandidateHostFrame): void {
        this.frames.push(frame);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
            const waiter = this.waiters[i] as CandidateWaiter;
            if (waiter.check()) {
                this.waiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.resolve();
            }
        }
        this.onFrame?.(frame, this);
    }

    /** Deliver one frame to the client half. */
    send(header: Omit<EnvelopeHeader, "len" | "ver">, body: Uint8Array = new Uint8Array(0)): void {
        this.channel?.deliver(
            { ...header, len: body.length, ver: PROTOCOL_VERSION },
            new Uint8Array(body),
        );
    }

    /** Deliver one JSON Response on channel 0 to the client half. */
    respondJson(corr: bigint, value: unknown): void {
        this.send(
            { ty: FrameType.Response, flags: 0, channel: 0, epoch: 0, corr },
            Buffer.from(JSON.stringify(value), "utf8"),
        );
    }

    /** Fail the client half with a channel-detected loss. */
    close(error?: Error): void {
        this.channel?.failFromPeer(error ?? new Error("fake candidate host closed"));
    }

    waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
        if (check()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter: CandidateWaiter = {
                check,
                resolve,
                reject,
                timer: setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(
                        new Error(
                            `fake candidate host timed out waiting; have ${this.frames.length} frames`,
                        ),
                    );
                }, timeoutMs),
            };
            this.waiters.push(waiter);
        });
    }
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
class FakeCandidateChannel implements SetupFrameChannel {
    private closed = false;
    private began = false;
    private readonly inbox: InboundFrame[] = [];
    private readonly leases = new Set<ReceiveLease>();
    private readonly copies = new CopyCounter();

    constructor(
        private readonly host: FakeCandidateHost,
        private readonly handlers: FrameChannelHandlers,
        private readonly options: FakeCandidateChannelOptions,
    ) {}

    async start(_deadline: Deadline): Promise<void> {
        if (this.options.startHang) return new Promise<void>(() => {});
        if (this.options.startError) throw this.options.startError;
    }

    beginFrames(): void {
        if (this.closed || this.began) return;
        this.began = true;
        while (this.inbox.length > 0) {
            const frame = this.inbox.shift() as InboundFrame;
            this.handlers.onFrame(frame);
        }
    }

    produce(
        header: ProducerFrameHeader,
        body: DirectFrameBody,
        hooks?: FrameSendHooks,
        _deadline?: Deadline,
    ): FrameSendTicket {
        const producer = this.reserve(header, body.byteLength, hooks);
        try {
            body.fill(producer);
            return producer.commit(body.byteLength);
        } catch (error) {
            producer.abort();
            throw error;
        }
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
            (segments, exactLength) => {
                const body = new Uint8Array(exactLength);
                let offset = 0;
                for (const segment of segments) {
                    body.set(segment, offset);
                    offset += segment.byteLength;
                }
                this.copies.record();
                return {
                    publish: () => {
                        if (!held || this.closed) {
                            throw new McHostCallError(
                                "not_sent",
                                "frame channel is closed",
                                "channel_closed",
                            );
                        }
                        held = false;
                        hooks?.onPublish?.();
                        this.host.receive({
                            header: { ...header, len: exactLength },
                            body,
                        });
                        hooks?.onComplete?.();
                        return { cancel: () => false };
                    },
                };
            },
            () => {
                held = false;
            },
        );
    }

    send(frame: OutboundFrame, hooks?: FrameSendHooks): FrameSendTicket {
        if (this.closed) {
            throw new McHostCallError("not_sent", "frame channel is closed", "channel_closed");
        }
        const body = new Uint8Array(frame.body);
        this.copies.record();
        hooks?.onPublish?.();
        this.host.receive({ header: frame.header, body });
        hooks?.onComplete?.();
        return { cancel: () => false };
    }

    sendControl(header: EnvelopeHeader): void {
        if (this.closed) return;
        this.host.receive({ header, body: new Uint8Array(0) });
    }

    flush(_deadline: Deadline): Promise<void> {
        return Promise.resolve();
    }

    close(_error?: unknown): void {
        for (const lease of [...this.leases]) {
            try {
                lease.release();
            } catch (error) {
                void error;
            }
        }
        this.closed = true;
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
            activeTimers: 0,
            activeReceiveLeases: this.leases.size,
            quarantinedBytes: 0,
            ownedAdapterCopies: this.copies.copies,
        };
    }

    deliver(header: EnvelopeHeader, body: Uint8Array): void {
        if (this.closed) return;
        let lease: ReceiveLease;
        lease = new ReceiveLease(
            body.byteLength === 0 ? [] : [body],
            () => {
                this.leases.delete(lease);
            },
            this.copies,
        );
        this.leases.add(lease);
        const frame = { header, body: lease };
        if (!this.began) {
            this.inbox.push(frame);
            return;
        }
        this.handlers.onFrame(frame);
    }

    failFromPeer(error: Error): void {
        if (this.closed) return;
        this.closed = true;
        this.handlers.onClosed("socket_closed", this.options.closeError ?? error);
    }
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
export function createFakePairedProvider(options: FakeProviderOptions = {}): FakePairedProvider {
    const host = new FakeCandidateHost();
    const provider: FakePairedProvider = {
        transport: options.transport ?? "fake.shm",
        capabilityVersion: options.capabilityVersion ?? 1,
        parameters: options.parameters,
        host,
        connectCount: 0,
        lastDescriptor: null,
        connect(descriptor: OpaqueObject, args: CandidateChannelArgs): SetupFrameChannel {
            provider.connectCount += 1;
            provider.lastDescriptor = descriptor;
            if (options.connectError) throw options.connectError;
            const channel = new FakeCandidateChannel(host, args.handlers, {
                startError: options.startError,
                startHang: options.startHang,
            });
            host.attach(channel);
            return channel;
        },
    };
    return provider;
}

function candidateBodyJson(frame: CandidateHostFrame): { op?: unknown } | undefined {
    try {
        return JSON.parse(Buffer.from(frame.body).toString("utf8")) as { op?: unknown };
    } catch {
        return undefined;
    }
}

/**
 * Default host-half script: acknowledge `transport.activate` when the token
 * matches, acknowledge `transport.commit`, and hand every other Request to
 * `onRequest`.
 */
export function candidateAutoResponder(
    expectedToken: string,
    onRequest?: (frame: CandidateHostFrame, host: FakeCandidateHost) => void,
): (frame: CandidateHostFrame, host: FakeCandidateHost) => void {
    return (frame, host) => {
        if (frame.header.ty !== FrameType.Request) return;
        const parsed = candidateBodyJson(frame) as
            | { op?: unknown; activation_token?: unknown }
            | undefined;
        if (parsed?.op === "transport.activate") {
            if (parsed.activation_token !== expectedToken) {
                host.send(
                    {
                        ty: FrameType.Error,
                        flags: 0,
                        channel: 0,
                        epoch: 0,
                        corr: frame.header.corr,
                    },
                    Buffer.from(
                        JSON.stringify({ code: "invalid_control_request", message: "bad token" }),
                        "utf8",
                    ),
                );
                return;
            }
            host.respondJson(frame.header.corr, {
                op: "transport.activate",
                negotiation_version: 1,
            });
            return;
        }
        if (parsed?.op === "transport.commit") {
            host.respondJson(frame.header.corr, {
                op: "transport.commit",
                negotiation_version: 1,
            });
            return;
        }
        onRequest?.(frame, host);
    };
}
