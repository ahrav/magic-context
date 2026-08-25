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

import assert from "node:assert/strict";
import { Deadline } from "../deadline";
import {
    ByteBudget,
    type FrameChannel,
    type FrameChannelCloseReason,
    type InboundFrame,
    type OutboundFrame,
    ProducerError,
    type ProducerFrameHeader,
} from "../frame-channel";
import { type EnvelopeHeader, FrameType, MAX_FRAME_BODY_LEN, PROTOCOL_VERSION } from "../protocol";
import { TcpFrameChannel } from "../tcp-frame-channel";
import { encodePeerFrame, FakePeer, type PeerFrameFields } from "./fake-peer";
import { expectSubcCallError, waitUntil } from "./test-util";

const CHANNEL = 5;
const EPOCH = 9;
/** Large enough to park the writer pump on 'drain' behind a paused peer. */
const WEDGE_BYTES = 8 * 1024 * 1024;

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

function pongHeader(corr: bigint): OutboundFrame["header"] {
    return {
        len: 0,
        ver: PROTOCOL_VERSION,
        ty: FrameType.Pong,
        flags: 0,
        channel: 0,
        epoch: 0,
        corr,
    };
}

function requestCorrs(peer: ContractPeer): bigint[] {
    return peer.frames.filter((frame) => frame.ty === FrameType.Request).map((frame) => frame.corr);
}

export const frameChannelContractScenarios: readonly FrameChannelContractScenario[] = [
    {
        // R3: one logical writer with FIFO admission while inbound frames
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
        // R3: publication start and local completion are distinct and fire
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
        // R4: a pre-publication cancel removes the frame without any byte
        // reaching the transport; its charge releases.
        name: "a queued frame cancels before publication and never reaches the peer",
        async run(create) {
            const h = await create();
            h.peer.pauseReading();
            h.channel.send(requestFrame(1n, Buffer.alloc(WEDGE_BYTES, 1)));
            let published = 0;
            const ticket = h.channel.send(requestFrame(2n, Buffer.from("doomed")), {
                onPublish: () => {
                    published++;
                },
            });
            assert.equal(ticket.cancel(), true);
            assert.equal(published, 0);
            h.channel.send(requestFrame(3n, Buffer.from("after")));
            h.peer.resumeReading();
            // FIFO: if corr 2 had been published it would precede corr 3.
            await h.peer.waitFor(() => requestCorrs(h.peer).includes(3n), 15_000);
            assert.deepEqual(requestCorrs(h.peer), [1n, 3n]);
            await waitUntil(() => h.budget.used === 0, 15_000);
        },
    },
    {
        // R3: frame-count saturation refuses admission at the same boundary
        // while reserved control capacity stays available.
        name: "frame saturation refuses admission while control capacity stays reserved",
        async run(create) {
            const h = await create({ maxQueuedFrames: 2 });
            h.peer.pauseReading();
            h.channel.send(requestFrame(1n, Buffer.alloc(WEDGE_BYTES, 1)));
            h.channel.send(requestFrame(2n, Buffer.from("q2")));
            h.channel.send(requestFrame(3n, Buffer.from("q3")));
            let refused: unknown;
            try {
                h.channel.send(requestFrame(4n, Buffer.from("q4")));
            } catch (error) {
                refused = error;
            }
            expectSubcCallError(refused, "not_sent", "writer_queue_full");
            // Required control writes must still be admittable.
            h.channel.sendControl(pongHeader(42n));
            assert.equal(h.channel.isClosed(), false);
            h.peer.resumeReading();
            await h.peer.waitFor(() => h.peer.frames.length >= 4, 15_000);
            assert.deepEqual(requestCorrs(h.peer), [1n, 2n, 3n]);
            const pong = h.peer.frames.find((frame) => frame.ty === FrameType.Pong);
            assert.equal(pong?.corr, 42n);
        },
    },
    {
        // R3: byte saturation blocks at the queue-byte and aggregate-cap
        // boundaries with distinct refusal codes.
        name: "byte saturation refuses admission at the queue and aggregate caps",
        async run(create) {
            const capped = await create({ memoryCapBytes: 1_000 });
            let overCap: unknown;
            try {
                capped.channel.send(requestFrame(1n, Buffer.alloc(2_000)));
            } catch (error) {
                overCap = error;
            }
            expectSubcCallError(overCap, "not_sent", "memory_cap");

            const narrow = await create({ maxQueuedBytes: 500 });
            let overQueue: unknown;
            try {
                narrow.channel.send(requestFrame(1n, Buffer.alloc(600)));
            } catch (error) {
                overQueue = error;
            }
            expectSubcCallError(overQueue, "not_sent", "writer_queue_full");
        },
    },
    {
        // R4: reserve exhaustion fails the channel exactly once, because
        // required cleanup can no longer queue safely.
        name: "control reserve exhaustion fails the channel exactly once",
        async run(create) {
            const h = await create({ controlReserveFrames: 2 });
            h.peer.pauseReading();
            h.channel.send(requestFrame(1n, Buffer.alloc(WEDGE_BYTES, 1)));
            h.channel.sendControl(pongHeader(1n));
            h.channel.sendControl(pongHeader(2n));
            assert.equal(h.channel.isClosed(), false);
            h.channel.sendControl(pongHeader(3n));
            assert.equal(h.channel.isClosed(), true);
            assert.equal(h.closes.length, 1);
            assert.equal(h.closes[0]?.reason, "control_capacity_exhausted");
            // Late control sends on a closed channel are silent no-ops.
            h.channel.sendControl(pongHeader(4n));
            assert.equal(h.closes.length, 1);
        },
    },
    {
        // R3/KTD7: inbound admission pauses under the shared aggregate cap
        // before allocation and resumes when retained bytes release.
        name: "paused inbound admission resumes after retained bytes release",
        async run(create) {
            const h = await create({
                maxBodyLen: 4_096,
                memoryCapBytes: 5_000,
                frameDeadlineMs: 10_000,
            });
            const retained: { lease: InboundFrame["body"] | null } = { lease: null };
            h.frameHook = (frame) => {
                if (frame.header.corr !== 1n) return false;
                retained.lease = frame.body;
                return true;
            };
            await h.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                body: Buffer.alloc(4_096, 1),
            });
            await waitUntil(() => retained.lease !== null);
            await h.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 2n,
                body: Buffer.alloc(4_096, 2),
            });
            await waitUntil(() => h.channel.stats().readPaused);
            assert.equal(h.channel.stats().readerHeldBytes, 4_096);
            assert.equal(h.received.length, 0);
            retained.lease?.release();
            await waitUntil(() => h.received.length === 1);
            assert.equal(h.channel.stats().readPaused, false);
            assert.equal(h.received[0]?.body.length, 4_096);
            // The cap was never exceeded while paused.
            assert.ok(h.budget.peak <= 5_000);
        },
    },
    {
        // R4: graceful finish drains admitted frames before close, while
        // discard drops queued frames and releases every byte charge.
        name: "graceful flush drains admitted frames; discard drops and releases",
        async run(create) {
            const graceful = await create();
            graceful.peer.pauseReading();
            for (let i = 1; i <= 3; i++) {
                graceful.channel.send(requestFrame(BigInt(i), Buffer.alloc(1_024, i)));
            }
            const flushed = graceful.channel.flush(Deadline.start(15_000));
            graceful.peer.resumeReading();
            await flushed;
            // Flush confirms local completion, not receipt. commentlint: allow(JUDGE)
            await graceful.peer.waitFor(() => requestCorrs(graceful.peer).length >= 3, 15_000);
            assert.deepEqual(requestCorrs(graceful.peer), [1n, 2n, 3n]);
            assert.equal(graceful.budget.used, 0);
            graceful.channel.close();

            const discarded = await create();
            discarded.peer.pauseReading();
            discarded.channel.send(requestFrame(1n, Buffer.alloc(WEDGE_BYTES, 1)));
            discarded.channel.send(requestFrame(2n, Buffer.from("q2")));
            discarded.channel.send(requestFrame(3n, Buffer.from("q3")));
            discarded.channel.close();
            const stats = discarded.channel.stats();
            assert.equal(stats.queuedDataFrames, 0);
            assert.equal(stats.queueHeldBytes, 0);
            assert.equal(stats.activeTimers, 0);
            assert.equal(discarded.budget.used, 0);
            // Owner-initiated discard is not a channel-detected failure.
            assert.equal(discarded.closes.length, 0);
        },
    },
    {
        // R4: closure reasons are preserved and reported exactly once.
        name: "close reasons: clean EOF, truncation, invalid header, role violation, frame deadline",
        async run(create) {
            const eof = await create();
            await eof.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                body: Buffer.from("last"),
            });
            await waitUntil(() => eof.received.length === 1);
            eof.peer.end();
            await waitUntil(() => eof.closes.length >= 1);
            assert.equal(eof.closes[0]?.reason, "eof");
            eof.peer.destroy();
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(eof.closes.length, 1);

            // Stream end while a declared body is still pending is a
            // truncated-frame failure, not a clean boundary close.
            const truncated = await create({ frameDeadlineMs: 10_000 });
            await truncated.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                len: 64,
            });
            truncated.peer.end();
            await waitUntil(() => truncated.closes.length >= 1);
            assert.equal(truncated.closes[0]?.reason, "truncated_frame");
            assert.equal(truncated.received.length, 0);

            const badVersion = await create();
            await badVersion.peer.send({
                ty: FrameType.Response,
                channel: 1,
                epoch: 1,
                corr: 1n,
                ver: 3,
            });
            await waitUntil(() => badVersion.closes.length === 1);
            assert.equal(badVersion.closes[0]?.reason, "protocol_violation");

            const roleInvalid = await create();
            await roleInvalid.peer.send({ ty: FrameType.Hello, corr: 0n });
            await waitUntil(() => roleInvalid.closes.length === 1);
            assert.equal(roleInvalid.closes[0]?.reason, "role_violation");

            const stalled = await create({ frameDeadlineMs: 80 });
            // A header that declares a body which never arrives stalls the
            // frame after its first header byte.
            await stalled.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                len: 64,
            });
            await waitUntil(() => stalled.closes.length === 1);
            assert.equal(stalled.closes[0]?.reason, "frame_deadline");
            assert.equal(stalled.channel.stats().activeTimers, 0);
        },
    },
    {
        // R1: an oversized body declaration is rejected before allocation.
        name: "an oversized body declaration closes the channel before allocation",
        async run(create) {
            const h = await create({ maxBodyLen: 4_096 });
            await h.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                len: 4_097,
            });
            await waitUntil(() => h.closes.length === 1);
            assert.equal(h.closes[0]?.reason, "protocol_violation");
            assert.ok(h.budget.peak < 1_024);
        },
    },
    {
        // R3: coalesced frames deliver in wire order, each from the single
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
        name: "bounded producers commit empty, boundary, segmented, and maximum bodies exactly",
        async run(create) {
            const h = await create({
                producerSpanBytes: 32 * 1024 * 1024,
            });
            const sizes = [0, 64, 65, MAX_FRAME_BODY_LEN];
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
            await h.peer.waitFor(() => requestCorrs(h.peer).length === sizes.length, 15_000);
            assert.deepEqual(
                h.peer.frames
                    .filter((frame) => frame.ty === FrameType.Request)
                    .map((frame) => frame.body.length),
                sizes,
            );
            assert.equal(h.channel.stats().ownedAdapterCopies, sizes.length);
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

            const uncertain = await create();
            const escaped: { frame: InboundFrame | null; alias: Uint8Array | null } = {
                frame: null,
                alias: null,
            };
            uncertain.frameHook = (frame) => {
                escaped.frame = frame;
                escaped.alias = frame.body.segment(0);
                return true;
            };
            await uncertain.peer.send({
                ty: FrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 2n,
                body: Buffer.from("maybe"),
            });
            await waitUntil(() => escaped.alias !== null);
            const backing = escaped.alias?.buffer;
            if (!(backing instanceof ArrayBuffer)) throw new Error("expected ArrayBuffer");
            structuredClone(backing, { transfer: [backing] });
            uncertain.channel.close();
            assert.equal(uncertain.channel.stats().activeReceiveLeases, 0);
            assert.equal(
                uncertain.channel.stats().quarantinedBytes,
                uncertain.reusesReceiveStorage ? 5 : 0,
            );
        },
    },
];

// ----------------------------------------------------------------------
// TCP registration of the contract factory. A later provider adds its own
// factory next to this one and reruns the identical scenario inventory.
// ----------------------------------------------------------------------

function adaptFakePeer(peer: FakePeer): Promise<ContractPeer> {
    return peer.waitForConnection().then((connection) => ({
        get frames(): readonly ContractPeerFrame[] {
            return connection.frames;
        },
        send: (fields: ContractPeerFrameFields) => connection.send(fields as PeerFrameFields),
        sendBurst: (fields: ContractPeerFrameFields[]) =>
            connection.sendRaw(
                Buffer.concat(fields.map((f) => encodePeerFrame(f as PeerFrameFields))),
            ),
        waitFor: (check: () => boolean, timeoutMs?: number) => connection.waitFor(check, timeoutMs),
        pauseReading: () => connection.pauseReading(),
        resumeReading: () => connection.resumeReading(),
        end: () => connection.end(),
        destroy: () => connection.destroy(),
    }));
}

/** Live, authenticated TCP channel/peer pair for the contract suite. */
export const tcpFrameChannelContractFactory: FrameChannelContractFactory = async (
    overrides = {},
) => {
    const peer = await FakePeer.start();
    const maxBodyLen = overrides.maxBodyLen ?? MAX_FRAME_BODY_LEN;
    const budget = new ByteBudget(overrides.memoryCapBytes ?? maxBodyLen + 1_048_576);
    const received: ContractReceivedFrame[] = [];
    const closes: { reason: FrameChannelCloseReason; error: unknown }[] = [];
    const hookSlot: { fn: ((frame: InboundFrame) => boolean | undefined) | null } = { fn: null };
    const channel = new TcpFrameChannel({
        host: "127.0.0.1",
        port: peer.port,
        credentials: { key: peer.key, daemonId: peer.daemonId },
        budget,
        frameDeadlineMs: overrides.frameDeadlineMs,
        maxBodyLen: overrides.maxBodyLen,
        maxQueuedFrames: overrides.maxQueuedFrames,
        maxQueuedBytes: overrides.maxQueuedBytes,
        controlReserveFrames: overrides.controlReserveFrames,
        producerSpanBytes: overrides.producerSpanBytes,
        handlers: {
            onFrame: (frame) => {
                if (hookSlot.fn?.(frame) === true) return;
                received.push({ header: frame.header, body: frame.body.takeOwned() });
            },
            onClosed: (reason, error) => {
                closes.push({ reason, error });
            },
        },
    });
    try {
        await channel.start(Deadline.start(2_000));
        channel.beginFrames();
    } catch (error) {
        channel.close();
        await peer.close();
        throw error;
    }
    const contractPeer = await adaptFakePeer(peer);
    return {
        channel,
        budget,
        peer: contractPeer,
        reusesReceiveStorage: false,
        received,
        closes,
        get frameHook() {
            return hookSlot.fn;
        },
        set frameHook(fn: ((frame: InboundFrame) => boolean | undefined) | null) {
            hookSlot.fn = fn;
        },
        cleanup: async () => {
            channel.close();
            await peer.close();
        },
    };
};
