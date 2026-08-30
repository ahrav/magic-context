import { describe, expect, test } from "bun:test";
import {
    NativeChannel,
    type NativeReceiveLease,
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
} from "@cortexkit/mc-shm-native";
import { ConnectionGeneration } from "./connection";
import { Deadline } from "./deadline";
import {
    ByteBudget,
    type FrameChannelCloseReason,
    type InboundFrame,
    ReceiveLease,
} from "./frame-channel";
import {
    decodeHeader,
    type EnvelopeHeader,
    encodeHeader,
    FrameType,
    PROTOCOL_VERSION,
} from "./protocol";
import { ShmFrameChannel } from "./shm-frame-channel";
import { createExplicitShmTestProvider } from "./shm-transport-provider";
import {
    type ContractPeerFrame,
    type FrameChannelContractFactory,
    frameChannelContractScenarios,
    runFrameChannelContractScenario,
} from "./test-support/frame-channel-contract";
import { waitUntil } from "./test-support/test-util";

function responseHeader(ty: FrameType, corr: bigint, length: number, flags = 0): EnvelopeHeader {
    return {
        len: length,
        ver: PROTOCOL_VERSION,
        ty,
        flags,
        channel: 7,
        epoch: 1,
        corr,
    };
}

function publish(peer: NativeChannel, header: EnvelopeHeader, body: Uint8Array): void {
    peer.produce(encodeHeader(header), body.byteLength, (cursor) => cursor.write(body));
}

function take(peer: NativeChannel): NativeReceiveLease {
    let lease: NativeReceiveLease | undefined;
    expect(peer.poll((value) => (lease = value))).toBe(true);
    if (!lease) throw new Error("missing native lease");
    return lease;
}

async function generationHarness(): Promise<{
    generation: ConnectionGeneration;
    channel: ShmFrameChannel;
    peer: NativeChannel;
}> {
    const pair = NativeChannel.createTestPair();
    let channel: ShmFrameChannel | undefined;
    const generation = new ConnectionGeneration({
        host: "127.0.0.1",
        port: 1,
        credentials: { key: new Uint8Array(32), daemonId: new Uint8Array(16), daemonVer: "test" },
        channelFactory: ({ budget, handlers }) => {
            channel = new ShmFrameChannel({
                nativeChannel: pair.first,
                budget,
                maxBodyLen: 1 << 20,
                handlers,
            });
            return channel;
        },
    });
    await generation.start(Deadline.start(2_000));
    if (!channel) throw new Error("missing shared-memory channel");
    return { generation, channel, peer: pair.second };
}

const shmContractFactory: FrameChannelContractFactory = async () => {
    const pair = NativeChannel.createTestPair();
    const budget = new ByteBudget(128 * 1024 * 1024);
    const frames: ContractPeerFrame[] = [];
    const received: { header: EnvelopeHeader; body: Uint8Array }[] = [];
    const closes: { reason: FrameChannelCloseReason; error: unknown }[] = [];
    const hook: { current: ((frame: InboundFrame) => boolean | undefined) | null } = {
        current: null,
    };
    let reading = true;
    let cleaning = false;
    const channel = new ShmFrameChannel({
        nativeChannel: pair.first,
        budget,
        maxBodyLen: 1 << 20,
        handlers: {
            onFrame: (frame) => {
                if (hook.current?.(frame)) return;
                received.push({ header: frame.header, body: frame.body.takeOwned() });
            },
            onClosed: (reason, error) => closes.push({ reason, error }),
        },
    });
    channel.beginFrames();
    const drain = (): void => {
        if (!reading || cleaning) return;
        while (
            pair.second.poll((lease) => {
                const header = decodeHeader(lease.header);
                const body = new Uint8Array(lease.byteLength);
                let offset = 0;
                for (let index = 0; index < lease.segmentCount; index++) {
                    const segment = lease.segment(index);
                    body.set(segment, offset);
                    offset += segment.byteLength;
                }
                lease.release();
                frames.push({ ...header, body });
            })
        ) {}
    };
    const drainTimer = setInterval(drain, 0);
    const peer = {
        get frames(): readonly ContractPeerFrame[] {
            return frames;
        },
        async send(fields: {
            ty: number;
            flags?: number;
            channel?: number;
            epoch?: number;
            corr?: bigint;
            body?: Uint8Array;
        }): Promise<void> {
            const body = fields.body ?? new Uint8Array();
            publish(
                pair.second,
                {
                    len: body.byteLength,
                    ver: PROTOCOL_VERSION,
                    ty: fields.ty,
                    flags: fields.flags ?? 0,
                    channel: fields.channel ?? 0,
                    epoch: fields.epoch ?? 0,
                    corr: fields.corr ?? 0n,
                },
                body,
            );
        },
        async sendBurst(
            fields: readonly {
                ty: number;
                flags?: number;
                channel?: number;
                epoch?: number;
                corr?: bigint;
                body?: Uint8Array;
            }[],
        ): Promise<void> {
            for (const frame of fields) await this.send(frame);
        },
        waitFor: async (check: () => boolean, timeoutMs?: number) => waitUntil(check, timeoutMs),
        pauseReading: () => {
            reading = false;
        },
        resumeReading: () => {
            reading = true;
            drain();
        },
        end: () => pair.second.close(),
        destroy: () => pair.second.forceClose(),
    };
    return {
        channel,
        budget,
        peer,
        reusesReceiveStorage: true,
        received,
        closes,
        get frameHook() {
            return hook.current;
        },
        set frameHook(value) {
            hook.current = value;
        },
        async cleanup() {
            cleaning = true;
            clearInterval(drainTimer);
            if (!channel.isClosed()) channel.close();
            pair.second.close();
        },
    };
};

const SHM_CONTRACT_SCENARIOS = new Set([
    "concurrent send and receive preserve FIFO order",
    "publication and local completion fire exactly once, in order",
    "underfill, overflow, and abort return reservations without publication",
    "owned receive adapter copies once after transport lease release",
]);

describe("frame channel semantic contract (shared-memory factory)", () => {
    for (const scenario of frameChannelContractScenarios) {
        if (!SHM_CONTRACT_SCENARIOS.has(scenario.name)) continue;
        test(scenario.name, async () => {
            if (!probeCapabilities().available) return;
            await runFrameChannelContractScenario(scenario, shmContractFactory);
        }, 30_000);
    }
});

describe("explicit shared-memory provider", () => {
    test("omits unsupported and non-qualified profiles without registration", () => {
        expect(createExplicitShmTestProvider("production-default")).toBeUndefined();
        const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
        expect(provider === undefined).toBe(!probeCapabilities().available);
        if (provider) {
            expect(provider.transport).toBe("shm");
            expect(provider.capabilityVersion).toBe(1);
        }
    });

    test("propagates JSON and binary leases without owned-adapter copies", async () => {
        if (!probeCapabilities().available) return;
        const { generation, channel, peer } = await generationHarness();
        try {
            const response = generation.request({
                channel: 7,
                epoch: 1,
                body: { byteLength: 2, fill: (cursor) => cursor.write(Buffer.from("{}")) },
                deadline: Deadline.start(2_000),
            });
            take(peer).release();
            const responseBytes = Buffer.from('{"ok":true}');
            publish(
                peer,
                responseHeader(FrameType.Response, response.correlation, responseBytes.length),
                responseBytes,
            );
            const responseTerminal = await response.result;
            expect("value" in responseTerminal.body ? responseTerminal.body.value : null).toEqual({
                ok: true,
            });
            expect(channel.stats().activeReceiveLeases).toBe(0);

            const error = generation.request({
                channel: 7,
                epoch: 1,
                body: Buffer.from("{}"),
                deadline: Deadline.start(2_000),
            });
            take(peer).release();
            const errorBytes = Buffer.from('{"code":"bad","message":"no"}');
            publish(
                peer,
                responseHeader(FrameType.Error, error.correlation, errorBytes.length),
                errorBytes,
            );
            expect((await error.result).kind).toBe("error");
            expect(channel.stats().activeReceiveLeases).toBe(0);

            const stream = generation.request({
                channel: 7,
                epoch: 1,
                body: Buffer.from("{}"),
                deadline: Deadline.start(2_000),
                mode: "stream",
            });
            take(peer).release();
            const item = Buffer.from('{"item":1}');
            publish(
                peer,
                responseHeader(FrameType.StreamData, stream.correlation, item.length),
                item,
            );
            publish(
                peer,
                responseHeader(FrameType.StreamEnd, stream.correlation, 0),
                new Uint8Array(),
            );
            const streamTerminal = await stream.result;
            expect(
                streamTerminal.stream.map((body) => ("value" in body ? body.value : null)),
            ).toEqual([{ item: 1 }]);
            expect(channel.stats().activeReceiveLeases).toBe(0);

            const binary = generation.request({
                channel: 7,
                epoch: 1,
                body: Buffer.from([1]),
                binary: true,
                responseMode: "binary",
                deadline: Deadline.start(2_000),
            });
            take(peer).release();
            publish(
                peer,
                responseHeader(FrameType.Response, binary.correlation, 4, 1),
                Buffer.from([1, 2, 3, 4]),
            );
            const binaryBody = (await binary.result).body;
            expect(binaryBody).toBeInstanceOf(ReceiveLease);
            const lease = binaryBody as ReceiveLease;
            const alias = lease.segment(0);
            expect(() => structuredClone(alias.buffer, { transfer: [alias.buffer] })).toThrow();
            expect(channel.stats().activeReceiveLeases).toBe(1);
            expect(lease.release()).toBe(true);
            expect(lease.release()).toBe(false);
            expect(() => lease.segment(0)).toThrow(/released/);
            expect(alias.byteLength).toBe(0);
            expect(channel.stats().activeReceiveLeases).toBe(0);
            expect(channel.stats().ownedAdapterCopies).toBe(0);
        } finally {
            generation.retire("owner_close");
            peer.close();
        }
    });

    test("callback failure, underfill, and overflow publish nothing", async () => {
        if (!probeCapabilities().available) return;
        const { generation, peer } = await generationHarness();
        try {
            let alias: Uint8Array | undefined;
            const failures = [
                [
                    (cursor: { view(): Uint8Array; write(bytes: Uint8Array): void }) => {
                        alias = cursor.view();
                        cursor.write(Buffer.from([1, 2]));
                    },
                    /producer underfill/,
                ],
                [
                    (cursor: { view(): Uint8Array; write(bytes: Uint8Array): void }) => {
                        alias = cursor.view();
                        cursor.write(Buffer.alloc(5));
                    },
                    /producer overflow/,
                ],
                [
                    (cursor: { view(): Uint8Array; write(bytes: Uint8Array): void }) => {
                        alias = cursor.view();
                        cursor.write(Buffer.alloc(4));
                        throw new Error("fill failed");
                    },
                    /fill failed/,
                ],
            ] as const;
            for (const [fill, expected] of failures) {
                alias = undefined;
                expect(() =>
                    generation.request({
                        channel: 7,
                        epoch: 1,
                        body: { byteLength: 4, fill },
                        deadline: Deadline.start(50),
                    }),
                ).toThrow(expected);
                expect(alias?.byteLength).toBe(0);
                expect(peer.poll(() => {})).toBe(false);

                generation.request({
                    channel: 7,
                    epoch: 1,
                    body: Buffer.from([9]),
                    deadline: Deadline.start(50),
                });
                const valid = take(peer);
                expect(valid.segment(0)[0]).toBe(9);
                valid.release();
            }
        } finally {
            generation.retire("owner_close");
            peer.close();
        }
    });

    test("native reservation publishes directly and cannot cancel after publication", () => {
        if (!probeCapabilities().available) return;
        const pair = NativeChannel.createTestPair();
        const channel = new ShmFrameChannel({
            nativeChannel: pair.first,
            budget: new ByteBudget(1024),
            maxBodyLen: 1 << 20,
            handlers: { onFrame: () => {}, onClosed: () => {} },
        });
        const { len: _len, ...header } = responseHeader(FrameType.Request, 8n, 4);
        const producer = channel.reserve(header, 4);
        const alias = producer.view();
        producer.write(Buffer.from([1, 2, 3, 4]));
        const ticket = producer.commit(4);
        expect(ticket.cancel()).toBe(false);
        expect(alias.byteLength).toBe(0);
        const lease = take(pair.second);
        expect(Array.from(lease.segment(0))).toEqual([1, 2, 3, 4]);
        lease.release();
        expect(channel.stats().ownedAdapterCopies).toBe(0);
        channel.close();
        pair.second.close();
    });

    test("owned receive adapter records exactly one copy", async () => {
        if (!probeCapabilities().available) return;
        const pair = NativeChannel.createTestPair();
        let owned: Uint8Array | undefined;
        const channel = new ShmFrameChannel({
            nativeChannel: pair.first,
            budget: new ByteBudget(1024),
            maxBodyLen: 1 << 20,
            handlers: {
                onFrame: (frame) => {
                    owned = frame.body.takeOwned();
                },
                onClosed: () => {},
            },
        });
        channel.beginFrames();
        publish(pair.second, responseHeader(FrameType.Response, 1n, 4), Buffer.from("once"));
        await waitUntil(() => owned !== undefined);
        expect(Buffer.from(owned ?? []).toString()).toBe("once");
        expect(channel.stats().ownedAdapterCopies).toBe(1);
        channel.close();
        pair.second.close();
    });

    test("close reports quarantine and rejects alias cleanup failure", async () => {
        const closes: { reason: FrameChannelCloseReason; error: unknown }[] = [];
        let delivered = false;
        let nativeCloseCalls = 0;
        const nativeLease = {
            header: encodeHeader(responseHeader(FrameType.Response, 1n, 5)),
            segmentCount: 1,
            segment: () => new Uint8Array(Buffer.from("maybe")),
            release: () => {
                throw new Error("detach failed");
            },
        } as unknown as NativeReceiveLease;
        const native = {
            poll: (deliver: (lease: NativeReceiveLease) => void) => {
                if (delivered) return false;
                delivered = true;
                deliver(nativeLease);
                return true;
            },
            close: () => {
                nativeCloseCalls++;
            },
        } as unknown as NativeChannel;
        const channel = new ShmFrameChannel({
            nativeChannel: native,
            budget: new ByteBudget(1024),
            maxBodyLen: 1 << 20,
            handlers: {
                onFrame: () => {},
                onClosed: (reason, error) => closes.push({ reason, error }),
            },
        });
        channel.beginFrames();
        await waitUntil(() => channel.stats().activeReceiveLeases === 1);
        expect(() => channel.close()).toThrow(
            "receive lease alias state is uncertain; storage quarantined",
        );
        expect(channel.stats().activeReceiveLeases).toBe(0);
        expect(channel.stats().quarantinedBytes).toBe(5);
        expect(closes.map((entry) => entry.reason)).toEqual(["quarantined"]);
        expect(nativeCloseCalls).toBe(0);
    });

    test("produce and reserve enforce the configured frame limit before any charge", () => {
        const budget = new ByteBudget(1 << 30);
        let produceCalls = 0;
        const native = {
            produce: () => {
                produceCalls++;
            },
            reserve: () => {
                throw new Error("reserve must not be reached");
            },
            close: () => {},
        } as unknown as NativeChannel;
        const channel = new ShmFrameChannel({
            nativeChannel: native,
            budget,
            maxBodyLen: 64,
            handlers: { onFrame: () => {}, onClosed: () => {} },
        });
        const header = {
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: 0,
            channel: 7,
            epoch: 1,
            corr: 1n,
        };
        const oversize = { byteLength: 65, fill: () => {} };
        expect(() => channel.produce(header, oversize)).toThrow(RangeError);
        const poisoned = { byteLength: Number.NaN, fill: () => {} };
        expect(() => channel.produce(header, poisoned)).toThrow(RangeError);
        expect(() => channel.reserve(header, 65)).toThrow(RangeError);
        // Nothing was charged and the native ring was never touched.
        expect(budget.used).toBe(0);
        expect(produceCalls).toBe(0);
    });

    test("sendControl after close is a silent no-op", () => {
        let produceCalls = 0;
        const native = {
            produce: () => {
                produceCalls++;
            },
            close: () => {},
        } as unknown as NativeChannel;
        const channel = new ShmFrameChannel({
            nativeChannel: native,
            budget: new ByteBudget(1024),
            maxBodyLen: 1 << 20,
            handlers: {
                onFrame: () => {},
                onClosed: () => {},
            },
        });
        channel.close();
        expect(() => channel.sendControl(responseHeader(FrameType.Pong, 1n, 0))).not.toThrow();
        expect(produceCalls).toBe(0);
    });

    test("handler throw releases JSON lease before fail-close", async () => {
        if (!probeCapabilities().available) return;
        const pair = NativeChannel.createTestPair();
        let alias: Uint8Array | undefined;
        const channel = new ShmFrameChannel({
            nativeChannel: pair.first,
            budget: new ByteBudget(1024),
            maxBodyLen: 1 << 20,
            handlers: {
                onFrame: (frame) => {
                    alias = frame.body.segment(0);
                    throw new Error("decode failed");
                },
                onClosed: () => {},
            },
        });
        channel.beginFrames();
        publish(pair.second, responseHeader(FrameType.Response, 1n, 2), Buffer.from("{}"));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(channel.isClosed()).toBe(true);
        expect(alias?.byteLength).toBe(0);
        pair.second.close();
    });
});
