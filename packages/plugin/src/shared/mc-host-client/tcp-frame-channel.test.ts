/**
 * Keep TCP fragmentation, authentication leftovers, and FIN/RST cases
 * separate from provider-neutral contract scenarios: only the socket
 * transport has byte-split or EOF variants. commentlint: allow(JUDGE)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { Deadline } from "./deadline";
import { McHostCallError } from "./errors";
import { ByteBudget, type FrameChannelCloseReason, utf8FrameBody } from "./frame-channel";
import { type EnvelopeHeader, FrameType, MAX_FRAME_BODY_LEN, PROTOCOL_VERSION } from "./protocol";
import { TcpFrameChannel } from "./tcp-frame-channel";
import { encodePeerFrame, FakePeer, type FakePeerConnection } from "./test-support/fake-peer";
import {
    frameChannelContractScenarios,
    runFrameChannelContractScenario,
    tcpFrameChannelContractFactory,
} from "./test-support/frame-channel-contract";
import { waitUntil } from "./test-support/test-util";

const CHANNEL = 7;
const EPOCH = 77;

describe("frame channel semantic contract (TCP factory)", () => {
    for (const scenario of frameChannelContractScenarios) {
        test(scenario.name, async () => {
            await runFrameChannelContractScenario(scenario, tcpFrameChannelContractFactory);
        }, 30_000);
    }
});

interface TcpHarness {
    channel: TcpFrameChannel;
    budget: ByteBudget;
    connection: FakePeerConnection;
    received: { header: EnvelopeHeader; body: Uint8Array }[];
    closes: { reason: FrameChannelCloseReason; error: unknown }[];
}

interface TcpHarnessOptions {
    helloTrailer?: Buffer;
    frameDeadlineMs?: number;
    maxBodyLen?: number;
}

function responseFrame(corr: bigint, body: Buffer): Buffer {
    return encodePeerFrame({
        ty: FrameType.Response,
        channel: CHANNEL,
        epoch: EPOCH,
        corr,
        body,
    });
}

describe("TCP adapter specifics", () => {
    const peers: FakePeer[] = [];
    const channels: TcpFrameChannel[] = [];

    afterEach(async () => {
        while (channels.length > 0) {
            channels.pop()?.close();
        }
        while (peers.length > 0) {
            await peers.pop()?.close();
        }
    });

    async function createHarness(options: TcpHarnessOptions = {}): Promise<TcpHarness> {
        const peer = await FakePeer.start();
        peers.push(peer);
        if (options.helloTrailer) peer.helloTrailer = options.helloTrailer;
        const maxBodyLen = options.maxBodyLen ?? MAX_FRAME_BODY_LEN;
        const budget = new ByteBudget(maxBodyLen + 1_048_576);
        const received: { header: EnvelopeHeader; body: Uint8Array }[] = [];
        const closes: { reason: FrameChannelCloseReason; error: unknown }[] = [];
        const channel = new TcpFrameChannel({
            host: "127.0.0.1",
            port: peer.port,
            credentials: { key: peer.key, daemonId: peer.daemonId, daemonVer: peer.daemonVer },
            budget,
            frameDeadlineMs: options.frameDeadlineMs,
            maxBodyLen: options.maxBodyLen,
            handlers: {
                onFrame: (frame) =>
                    received.push({ header: frame.header, body: frame.body.takeOwned() }),
                onClosed: (reason, error) => closes.push({ reason, error }),
            },
        });
        channels.push(channel);
        await channel.start(Deadline.start(2_000));
        channel.beginFrames();
        const connection = await peer.waitForConnection();
        return { channel, budget, connection, received, closes };
    }

    test("every split point of one header and body yields one complete frame", async () => {
        const h = await createHarness();
        const body = Buffer.from("split-me");
        const frameLen = 21 + body.length;
        for (let split = 1; split < frameLen; split++) {
            await h.connection.send(
                {
                    ty: FrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: BigInt(split),
                    body,
                },
                { splits: [split], delayMs: 1 },
            );
            await waitUntil(() => h.received.length === split);
            const frame = h.received[split - 1];
            expect(frame?.header.corr).toBe(BigInt(split));
            expect(Buffer.from(frame?.body ?? []).toString()).toBe("split-me");
        }
        expect(h.closes.length).toBe(0);
    }, 30_000);

    test("auth and first frames arriving in one socket chunk transfer without loss", async () => {
        // Two coalesced frames ride the same write as the ServerHello, so
        // every leftover byte must move from the auth buffer to the frame
        // reader when delivery begins.
        const h = await createHarness({
            helloTrailer: Buffer.concat([
                responseFrame(41n, Buffer.from("first")),
                responseFrame(42n, Buffer.from("second")),
            ]),
        });
        await waitUntil(() => h.received.length === 2);
        expect(h.received.map((frame) => frame.header.corr)).toEqual([41n, 42n]);
        expect(Buffer.from(h.received[0]?.body ?? []).toString()).toBe("first");
        expect(Buffer.from(h.received[1]?.body ?? []).toString()).toBe("second");
        expect(h.closes.length).toBe(0);
    });

    test("coalesced frames split mid-frame still deliver in order", async () => {
        const h = await createHarness();
        const burst = Buffer.concat([
            responseFrame(1n, Buffer.from("a")),
            responseFrame(2n, Buffer.from("bb")),
            responseFrame(3n, Buffer.from("ccc")),
        ]);
        await h.connection.sendRaw(burst, { splits: [25, 30, 46], delayMs: 1 });
        await waitUntil(() => h.received.length === 3);
        expect(h.received.map((frame) => frame.header.corr)).toEqual([1n, 2n, 3n]);
        expect(h.closes.length).toBe(0);
    });

    test("clean EOF at a frame boundary reports eof after full delivery", async () => {
        const h = await createHarness();
        await h.connection.send({
            ty: FrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: 1n,
            body: Buffer.from("done"),
        });
        await waitUntil(() => h.received.length === 1);
        h.connection.end();
        await waitUntil(() => h.closes.length === 1);
        expect(h.closes[0]?.reason).toBe("eof");
        expect(h.received.length).toBe(1);
    });

    test("EOF within a header delivers nothing and reports truncation", async () => {
        const h = await createHarness();
        const partial = responseFrame(1n, Buffer.from("never")).subarray(0, 10);
        await h.connection.sendRaw(Buffer.from(partial));
        await delay(10);
        h.connection.end();
        await waitUntil(() => h.closes.length === 1);
        expect(h.closes[0]?.reason).toBe("truncated_frame");
        expect(h.received.length).toBe(0);
    });

    test("EOF within a body delivers nothing and reports truncation", async () => {
        const h = await createHarness();
        const full = responseFrame(1n, Buffer.alloc(256, 3));
        await h.connection.sendRaw(Buffer.from(full.subarray(0, 21 + 128)));
        await delay(10);
        h.connection.end();
        await waitUntil(() => h.closes.length === 1);
        expect(h.closes[0]?.reason).toBe("truncated_frame");
        expect(h.received.length).toBe(0);
    });

    test("an abrupt peer reset reports one close with a terminal classification", async () => {
        // The load-bearing invariant is exactly-once close reporting. The
        // classification depends on the runtime: `resetAndDestroy()` sends
        // an RST where supported (`socket_error`), but Bun on Linux can
        // still deliver an orderly EOF for the same peer action, so the
        // observed close reason is any terminal classification.
        const h = await createHarness();
        h.connection.reset();
        await waitUntil(() => h.closes.length >= 1);
        expect(["socket_error", "socket_closed", "eof"]).toContain(h.closes[0]?.reason);
        await delay(20);
        expect(h.closes.length).toBe(1);
    });

    test("send() rejects a header.len that does not match the body length", async () => {
        const h = await createHarness();
        const body = Buffer.from("abc");
        expect(() =>
            h.channel.send({
                header: {
                    len: body.length + 2,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Request,
                    flags: 0,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: 1n,
                },
                body,
            }),
        ).toThrow(RangeError);
        expect(h.channel.stats().queuedDataFrames).toBe(0);
    });

    test("send() on a closed channel reports channel_closed even with a length mismatch", async () => {
        const h = await createHarness();
        h.channel.close();
        let refused: unknown;
        try {
            h.channel.send({
                header: {
                    len: 5,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Request,
                    flags: 0,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: 1n,
                },
                body: Buffer.from("abc"),
            });
        } catch (error) {
            refused = error;
        }
        expect(refused).toBeInstanceOf(McHostCallError);
        expect((refused as McHostCallError).kind).toBe("not_sent");
        expect((refused as McHostCallError).code).toBe("channel_closed");
    });

    test("a body stalled mid-transfer hits the frame deadline", async () => {
        const h = await createHarness({ frameDeadlineMs: 100 });
        const full = responseFrame(1n, Buffer.alloc(256, 5));
        await h.connection.sendRaw(Buffer.from(full.subarray(0, 21 + 100)));
        await waitUntil(() => h.closes.length === 1);
        expect(h.closes[0]?.reason).toBe("frame_deadline");
        expect(h.channel.stats().activeTimers).toBe(0);
    });

    test("the producer compatibility copy is charged while spans are still resident", async () => {
        const h = await createHarness();
        const capacity = 1000;
        const producer = h.channel.reserve(
            {
                ver: PROTOCOL_VERSION,
                ty: FrameType.Request,
                flags: 0,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
            },
            capacity,
        );
        producer.write(Buffer.alloc(capacity, 7));
        producer.commit(capacity);
        // Spans (capacity) and the queued copy (capacity) are both charged at
        // the commit boundary, so peak reflects the true double residency.
        expect(h.budget.peak).toBeGreaterThanOrEqual(2 * capacity);
    });

    test("a failed alias detachment during commit releases the copy charge", async () => {
        const h = await createHarness();
        const capacity = 512;
        const producer = h.channel.reserve(
            {
                ver: PROTOCOL_VERSION,
                ty: FrameType.Request,
                flags: 0,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
            },
            capacity,
        );
        producer.write(Buffer.alloc(capacity, 7));
        // Committed spans detach through structuredClone transfer; refusing
        // the transfer fails commit after the compatibility copy is charged,
        // exercising the abort path between prepareCommit and publish.
        const originalClone = globalThis.structuredClone;
        globalThis.structuredClone = (() => {
            throw new Error("alias detachment refused");
        }) as typeof structuredClone;
        try {
            expect(() => producer.commit(capacity)).toThrow("alias detachment refused");
        } finally {
            globalThis.structuredClone = originalClone;
        }
        expect(h.channel.stats().queueHeldBytes).toBe(0);
        expect(h.budget.used).toBe(0);
    });

    test("the built-in UTF-8 producer queues its final TCP buffer directly", async () => {
        const h = await createHarness();
        h.channel.produce(
            {
                ver: PROTOCOL_VERSION,
                ty: FrameType.Request,
                flags: 0,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
            },
            utf8FrameBody("direct"),
        );

        await waitUntil(() => h.connection.frames.length === 1);
        expect(Buffer.from(h.connection.frames[0]?.body ?? []).toString()).toBe("direct");
        expect(h.channel.stats().ownedAdapterCopies).toBe(0);
    });
});
