import { describe, expect, test } from "bun:test";
import {
    NativeChannel,
    type NativeReceiveLease,
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
} from "@magic-context/mc-shm-native";
import { ConnectionGeneration } from "./connection";
import { Deadline } from "./deadline";
import { ByteBudget, ReceiveLease } from "./frame-channel";
import { FrameType, PROTOCOL_VERSION, encodeHeader, type EnvelopeHeader } from "./protocol";
import { ShmFrameChannel } from "./shm-frame-channel";
import { createExplicitShmTestProvider } from "./shm-transport-provider";

function responseHeader(
    ty: FrameType,
    corr: bigint,
    length: number,
    flags = 0,
): EnvelopeHeader {
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
        credentials: { key: new Uint8Array(32), daemonId: new Uint8Array(16) },
        channelFactory: ({ budget, handlers }) => {
            channel = new ShmFrameChannel({ nativeChannel: pair.first, budget, handlers });
            return channel;
        },
    });
    await generation.start(Deadline.start(2_000));
    if (!channel) throw new Error("missing shared-memory channel");
    return { generation, channel, peer: pair.second };
}

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
            publish(peer, responseHeader(FrameType.StreamEnd, stream.correlation, 0), new Uint8Array());
            const streamTerminal = await stream.result;
            expect(streamTerminal.stream.map((body) => ("value" in body ? body.value : null))).toEqual([
                { item: 1 },
            ]);
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
            for (const fill of [
                (cursor: { view(): Uint8Array; write(bytes: Uint8Array): void }) => {
                    alias = cursor.view();
                    cursor.write(Buffer.from([1, 2]));
                },
                (cursor: { view(): Uint8Array; write(bytes: Uint8Array): void }) => {
                    alias = cursor.view();
                    cursor.write(Buffer.alloc(5));
                },
                (cursor: { view(): Uint8Array; write(bytes: Uint8Array): void }) => {
                    alias = cursor.view();
                    cursor.write(Buffer.alloc(4));
                    throw new Error("fill failed");
                },
            ]) {
                expect(() =>
                    generation.request({
                        channel: 7,
                        epoch: 1,
                        body: { byteLength: 4, fill },
                        deadline: Deadline.start(50),
                    }),
                ).toThrow();
                expect(alias?.byteLength).toBe(0);
                expect(peer.poll(() => {})).toBe(false);
            }
        } finally {
            generation.retire("owner_close");
            peer.close();
        }
    });

    test("handler throw releases JSON lease before fail-close", async () => {
        if (!probeCapabilities().available) return;
        const pair = NativeChannel.createTestPair();
        let alias: Uint8Array | undefined;
        const channel = new ShmFrameChannel({
            nativeChannel: pair.first,
            budget: new ByteBudget(1024),
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
