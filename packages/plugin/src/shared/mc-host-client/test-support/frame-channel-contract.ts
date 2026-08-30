/**
 * Reusable semantic contract suite for the complete-frame channel.
 *
 * Every scenario is expressed against the mandatory shared-memory channel.
 *
 * Runtime-neutral: `node:assert/strict` only — no bun:test — so the same
 * scenarios also execute under Node 24 through the existing bundle runner.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { McHostCallError } from "../errors";
import {
    type ByteBudget,
    type FrameChannel,
    type FrameChannelCloseReason,
    type InboundFrame,
    type OutboundFrame,
    ProducerError,
    type ProducerFrameHeader,
} from "../frame-channel";
import { type EnvelopeHeader, FrameType, PROTOCOL_VERSION } from "../protocol";

export async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
    const startedAt = Date.now();
    while (!check()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
        await delay(5);
    }
}

function expectMcHostCallError(
    error: unknown,
    kind: McHostCallError["kind"],
    code?: string,
): McHostCallError {
    assert.ok(error instanceof McHostCallError, `expected McHostCallError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
}

const CHANNEL = 5;
const EPOCH = 9;
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
    maxBodyLen?: number;
    memoryCapBytes?: number;
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
    /** The contract factory retains owned bodies after the channel releases each inbound lease. */
    received: ContractReceivedFrame[];
    /** Channel-detected closes, in order (owner close never records here). */
    closes: { reason: FrameChannelCloseReason; error: unknown }[];
    /** Scenario-installed hook, run before each delivery is recorded. */
    frameHook: ((frame: InboundFrame) => boolean | undefined) | null;
    cleanup(): Promise<void>;
}

export type FrameChannelContractFactory = (
    overrides?: ContractChannelOverrides,
) => Promise<FrameChannelContractHandle>;

export interface FrameChannelContractScenario {
    name: string;
    run(create: FrameChannelContractFactory): Promise<void>;
}

/** Run one scenario with automatic cleanup of every created handle. */
export async function runFrameChannelContractScenario(
    scenario: FrameChannelContractScenario,
    factory: FrameChannelContractFactory,
): Promise<void> {
    const handles: FrameChannelContractHandle[] = [];
    const tracked: FrameChannelContractFactory = async (overrides) => {
        const handle = await factory(overrides);
        handles.push(handle);
        return handle;
    };
    try {
        await scenario.run(tracked);
    } finally {
        for (const handle of handles) {
            await handle.cleanup();
        }
    }
}

function requestFrame(corr: bigint, body: Uint8Array): OutboundFrame {
    return {
        header: {
            len: body.length,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: 0,
            channel: CHANNEL,
            epoch: EPOCH,
            corr,
        },
        body,
    };
}

function producerHeader(corr: bigint): ProducerFrameHeader {
    return {
        ver: PROTOCOL_VERSION,
        ty: FrameType.Request,
        flags: 0,
        channel: CHANNEL,
        epoch: EPOCH,
        corr,
    };
}

function requestCorrs(peer: ContractPeer): bigint[] {
    return peer.frames.filter((frame) => frame.ty === FrameType.Request).map((frame) => frame.corr);
}

export const frameChannelContractScenarios: readonly FrameChannelContractScenario[] = [
    {
        // One logical writer preserves FIFO admission while inbound frames
        // keep making progress in wire order.
        name: "concurrent send and receive preserve FIFO order",
        async run(create) {
            const h = await create();
            for (let i = 1; i <= 6; i++) {
                h.channel.send(requestFrame(BigInt(i), Buffer.from([i])));
            }
            for (let i = 1; i <= 3; i++) {
                await h.peer.send({
                    ty: FrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: BigInt(100 + i),
                    body: Buffer.from(`r${i}`),
                });
            }
            await h.peer.waitFor(() => requestCorrs(h.peer).length >= 6);
            assert.deepEqual(requestCorrs(h.peer), [1n, 2n, 3n, 4n, 5n, 6n]);
            const bodies = h.peer.frames
                .filter((frame) => frame.ty === FrameType.Request)
                .map((frame) => frame.body[0]);
            assert.deepEqual(bodies, [1, 2, 3, 4, 5, 6]);
            await waitUntil(() => h.received.length >= 3);
            assert.deepEqual(
                h.received.map((frame) => frame.header.corr),
                [101n, 102n, 103n],
            );
        },
    },
    {
        // Publication start and local completion are distinct and fire
        // exactly once, in order; completion never claims peer receipt —
        // both fire while the peer is provably not consuming. commentlint: allow(JUDGE)
        name: "publication and local completion fire exactly once, in order",
        async run(create) {
            const h = await create();
            h.peer.pauseReading();
            const events: string[] = [];
            const ticket = h.channel.send(requestFrame(1n, Buffer.from("once")), {
                onPublish: () => events.push("publish"),
                onComplete: () => events.push("complete"),
            });
            await waitUntil(() => events.length >= 2);
            assert.deepEqual(events, ["publish", "complete"]);
            assert.equal(
                requestCorrs(h.peer).length,
                0,
                "completion fired before the peer consumed anything",
            );
            // A published frame is no longer cancellable.
            assert.equal(ticket.cancel(), false);
            h.peer.resumeReading();
            await h.peer.waitFor(() => requestCorrs(h.peer).length >= 1);
            assert.deepEqual(events, ["publish", "complete"]);
        },
    },
    {
        name: "byte saturation refuses admission at the aggregate cap",
        async run(create) {
            const capped = await create({ memoryCapBytes: 1_000 });
            let overCap: unknown;
            try {
                capped.channel.send(requestFrame(1n, Buffer.alloc(2_000)));
            } catch (error) {
                overCap = error;
            }
            expectMcHostCallError(overCap, "not_sent", "memory_cap");
        },
    },
    {
        // Coalesced frames deliver in wire order, each from the single
        // delivery loop — never recursively from within another delivery.
        name: "coalesced frames deliver in order without recursive re-entry",
        async run(create) {
            const h = await create();
            let depth = 0;
            let maxDepth = 0;
            h.frameHook = () => {
                depth++;
                maxDepth = Math.max(maxDepth, depth);
                depth--;
                return undefined;
            };
            await h.peer.sendBurst(
                [1n, 2n, 3n].map((corr) => ({
                    ty: FrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr,
                    body: Buffer.from(`c${corr}`),
                })),
            );
            await waitUntil(() => h.received.length === 3);
            assert.deepEqual(
                h.received.map((frame) => frame.header.corr),
                [1n, 2n, 3n],
            );
            assert.equal(maxDepth, 1);
        },
    },
    {
        name: "bounded producers commit empty, boundary, segmented, and large bodies exactly",
        async run(create) {
            const h = await create({});
            const sizes = [0, 64, 65, 1 << 20];
            for (let i = 0; i < sizes.length; i++) {
                const size = sizes[i] as number;
                const source = new Uint8Array(size).fill(i + 1);
                const producer = h.channel.reserve(producerHeader(BigInt(i + 1)), size);
                const aliases: Uint8Array[] = [];
                let offset = 0;
                while (offset < source.length) {
                    const view = producer.view();
                    const take = Math.min(view.length, source.length - offset);
                    view.set(source.subarray(offset, offset + take));
                    aliases.push(view);
                    producer.advance(take);
                    offset += take;
                }
                producer.commit(size);
                assert.equal(producer.written, size);
                for (const alias of aliases) assert.equal(alias.byteLength, 0);
            }
            await h.peer.waitFor(() => requestCorrs(h.peer).length === sizes.length, 60_000);
            assert.deepEqual(
                h.peer.frames
                    .filter((frame) => frame.ty === FrameType.Request)
                    .map((frame) => frame.body.length),
                sizes,
            );
            assert.equal(h.channel.stats().ownedAdapterCopies, 0);
        },
    },
    {
        name: "underfill, overflow, and abort return reservations without publication",
        async run(create) {
            const h = await create({ maxBodyLen: 64, memoryCapBytes: 1_024 });

            const underfill = h.channel.reserve(producerHeader(1n), 8);
            underfill.write(Buffer.from("four"));
            assert.throws(
                () => underfill.commit(8),
                (error) => error instanceof ProducerError && error.code === "producer_underfill",
            );

            const overflow = h.channel.reserve(producerHeader(2n), 8);
            assert.throws(
                () => overflow.write(Buffer.alloc(9)),
                (error) => error instanceof ProducerError && error.code === "producer_overflow",
            );

            h.channel.reserve(producerHeader(3n), 8).abort();
            assert.equal(h.channel.stats().queueHeldBytes, 0);
            assert.equal(h.channel.stats().queuedDataFrames, 0);
            assert.equal(h.budget.used, 0);
            assert.equal(requestCorrs(h.peer).length, 0);

            const valid = h.channel.reserve(producerHeader(4n), 4);
            valid.write(Buffer.from("good"));
            valid.commit(4);
            await h.peer.waitFor(() => requestCorrs(h.peer).includes(4n));
            const published = h.peer.frames.find((frame) => frame.corr === 4n);
            assert.equal(Buffer.from(published?.body ?? []).toString(), "good");
        },
    },
    {
        name: "owned receive adapter copies once after transport lease release",
        async run(create) {
            const h = await create();
            h.frameHook = (frame) => {
                const segment = frame.body.segment(0);
                assert.equal(segment.byteOffset, 0);
                assert.equal(segment.byteLength, segment.buffer.byteLength);
                return undefined;
            };
            await h.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                body: Buffer.from("owned"),
            });
            await waitUntil(() => h.received.length === 1);
            assert.equal(Buffer.from(h.received[0]?.body ?? []).toString(), "owned");
            assert.equal(h.channel.stats().activeReceiveLeases, 0);
            assert.equal(h.channel.stats().ownedAdapterCopies, 1);
        },
    },
    {
        name: "close revokes active receive aliases before storage reuse",
        async run(create) {
            const h = await create();
            const held: { frame: InboundFrame | null; alias: Uint8Array | null } = {
                frame: null,
                alias: null,
            };
            h.frameHook = (frame) => {
                held.frame = frame;
                held.alias = frame.body.segment(0);
                return true;
            };
            await h.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                body: Buffer.from("lease"),
            });
            await waitUntil(() => held.frame !== null);
            assert.equal(held.alias?.byteLength, 5);
            h.channel.close();
            assert.equal(held.alias?.byteLength, h.reusesReceiveStorage ? 0 : 5);
            assert.equal(held.frame?.body.isReleased(), true);
            assert.equal(h.channel.stats().activeReceiveLeases, 0);
            assert.throws(() => held.frame?.body.segment(0), /released/);
        },
    },
];
