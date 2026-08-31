/**
 *
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { PendingRequest } from "../connection";
import { Deadline } from "../deadline";
import { encodePeerFrame, PeerFrameType } from "./fake-peer";
import {
    createTrackedHarness,
    expectMcHostCallError,
    rejection,
    type ScenarioContext,
} from "./test-util";

export interface AdversarialScenario {
    name: string;
    run(ctx: ScenarioContext): Promise<void>;
}

/* */
export async function runAdversarialScenario(scenario: AdversarialScenario): Promise<void> {
    const harness = createTrackedHarness();
    try {
        await scenario.run(harness);
    } finally {
        await harness.cleanup();
    }
}

const CHANNEL = 5;
const EPOCH = 9;

export const adversarialScenarios: readonly AdversarialScenario[] = [
    {
        name: "auth rejection retires once without emitting ClientAuth",
        async run(ctx) {
            const peer = await ctx.startPeer({ authMode: "wrong-proof" });
            const retirements: string[] = [];
            const generation = ctx.createGeneration(peer, {
                onRetired: (info) => retirements.push(info.reason),
            });
            const error = await rejection(generation.start(Deadline.start(2_000)));
            assert.equal((error as Error).name, "AuthError");
            assert.ok(generation.isRetired());
            assert.deepEqual(retirements, ["auth_failed"]);
            assert.equal(generation.stats().activeTimers, 0);
            const connection = await peer.waitForConnection();
            // The client must not send a second authentication message.
            await connection.closed;
            assert.equal(connection.authMessages.length, 1);
        },
    },
    {
        name: "stalled auth fails under the setup deadline with one retirement",
        async run(ctx) {
            const peer = await ctx.startPeer({ authMode: "stall" });
            const retirements: string[] = [];
            const generation = ctx.createGeneration(peer, {
                onRetired: (info) => retirements.push(info.reason),
            });
            await rejection(generation.start(Deadline.start(150)));
            assert.ok(generation.isRetired());
            assert.equal(retirements.length, 1);
            assert.equal(generation.stats().activeTimers, 0);
            const connection = await peer.waitForConnection();
            await connection.closed;
            assert.equal(connection.authMessages.length, 1);
        },
    },
    {
        name: "every split point of a header and body decodes",
        async run(ctx) {
            const peer = await ctx.startPeer();
            const generation = await ctx.dial(peer);
            const connection = await peer.waitForConnection();
            const body = Buffer.from("split-me");
            const frameLen = 21 + body.length;
            for (let split = 1; split < frameLen; split++) {
                const request = generation.request({
                    channel: CHANNEL,
                    epoch: EPOCH,
                    body: Buffer.from(`probe-${split}`),
                    deadline: Deadline.start(2_000),
                });
                await connection.waitFor(() =>
                    connection.frames.some(
                        (frame) =>
                            frame.ty === PeerFrameType.Request &&
                            frame.corr === request.correlation,
                    ),
                );
                await connection.send(
                    {
                        ty: PeerFrameType.Response,
                        channel: CHANNEL,
                        epoch: EPOCH,
                        corr: request.correlation,
                        body,
                    },
                    { splits: [split] },
                );
                const terminal = await request.result;
                assert.equal(terminal.kind, "response");
                assert.deepEqual(
                    Buffer.from("text" in terminal.body ? (terminal.body.text ?? "") : ""),
                    body,
                );
            }
            const request = generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("probe-3way"),
                deadline: Deadline.start(2_000),
            });
            await connection.send(
                {
                    ty: PeerFrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: request.correlation,
                    body,
                },
                { splits: [3, 21, 25], delayMs: 1 },
            );
            assert.equal((await request.result).kind, "response");
            assert.ok(!generation.isRetired());
        },
    },
    {
        name: "coalesced frames in one data event all dispatch",
        async run(ctx) {
            const peer = await ctx.startPeer();
            const generation = await ctx.dial(peer);
            const connection = await peer.waitForConnection();
            const first = generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("a"),
                deadline: Deadline.start(2_000),
            });
            const second = generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("b"),
                deadline: Deadline.start(2_000),
            });
            await connection.waitFor(
                () =>
                    connection.frames.filter((frame) => frame.ty === PeerFrameType.Request)
                        .length >= 2,
            );
            const coalesced = Buffer.concat([
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: first.correlation,
                    body: Buffer.from("ra"),
                }),
                encodePeerFrame({ ty: PeerFrameType.Ping, corr: 77n }),
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: second.correlation,
                    body: Buffer.from("rb"),
                }),
            ]);
            await connection.sendRaw(coalesced);
            const firstBody = (await first.result).body;
            const secondBody = (await second.result).body;
            assert.deepEqual(
                Buffer.from("text" in firstBody ? (firstBody.text ?? "") : ""),
                Buffer.from("ra"),
            );
            assert.deepEqual(
                Buffer.from("text" in secondBody ? (secondBody.text ?? "") : ""),
                Buffer.from("rb"),
            );
            await connection.waitFor(() =>
                connection.frames.some(
                    (frame) => frame.ty === PeerFrameType.Pong && frame.corr === 77n,
                ),
            );
            assert.ok(!generation.isRetired());
        },
    },
    {
        // The non-reading peer applies backpressure while concurrent requests enqueue.
        // The peer's independent decoder verifies complete frames in enqueue order.
        // Correlations increase strictly monotonically in enqueue order.
        name: "backpressure preserves frame ordering and monotonic correlations",
        async run(ctx) {
            const peer = await ctx.startPeer();
            const generation = await ctx.dial(peer);
            const connection = await peer.waitForConnection();
            connection.pauseReading();
            const requestCount = 16;
            const requests: PendingRequest[] = [];
            for (let i = 0; i < requestCount; i++) {
                requests.push(
                    generation.request({
                        channel: CHANNEL,
                        epoch: EPOCH,
                        body: Buffer.alloc(262_144, i + 1),
                        deadline: Deadline.start(10_000),
                    }),
                );
            }
            await delay(50);
            connection.resumeReading();
            await connection.waitFor(
                () =>
                    connection.frames.filter((frame) => frame.ty === PeerFrameType.Request)
                        .length >= requestCount,
                10_000,
            );
            assert.equal(connection.corruption, null);
            const received = connection.frames.filter(
                (frame) => frame.ty === PeerFrameType.Request,
            );
            for (let i = 0; i < requestCount; i++) {
                const frame = received[i];
                const request = requests[i];
                assert.ok(frame !== undefined && request !== undefined);
                assert.equal(frame.corr, request.correlation);
                assert.equal(frame.len, 262_144);
                assert.equal(frame.body[0], i + 1);
                if (i > 0) {
                    const previous = received[i - 1];
                    assert.ok(previous !== undefined);
                    assert.ok(frame.corr > previous.corr, "correlations must be monotonic");
                }
                await connection.send({
                    ty: PeerFrameType.Response,
                    channel: CHANNEL,
                    epoch: EPOCH,
                    corr: frame.corr,
                    body: Buffer.from([i]),
                });
            }
            for (const request of requests) {
                assert.equal((await request.result).kind, "response");
            }
        },
    },
    {
        // A request removed before `socket.write()` is `not_sent`.
        // A reset after `socket.write()` and before a terminal is `outcome_unknown`.
        // A matching Error after `socket.write()` is the known terminal.
        name: "send outcomes classify not_sent, outcome_unknown, and terminal",
        async run(ctx) {
            // A request aborted before `socket.write()` is `not_sent`.
            const peerA = await ctx.startPeer();
            const generationA = await ctx.dial(peerA);
            const connectionA = await peerA.waitForConnection();
            connectionA.pauseReading();
            const wedge = generationA.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.alloc(8 * 1024 * 1024),
                deadline: Deadline.start(10_000),
            });
            const queued = generationA.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("never-written"),
                deadline: Deadline.start(10_000),
            });
            const abortHandle = queued.abort();
            expectMcHostCallError(await rejection(queued.result), "not_sent", "aborted");
            await abortHandle.cleanup;
            wedge.abort();
            generationA.retire("owner_close");

            // A reset after `socket.write()` and before a terminal is `outcome_unknown`.
            const peerB = await ctx.startPeer();
            const generationB = await ctx.dial(peerB);
            const connectionB = await peerB.waitForConnection();
            const reset = generationB.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("reset-race"),
                deadline: Deadline.start(5_000),
            });
            connectionB.destroy();
            expectMcHostCallError(await rejection(reset.result), "outcome_unknown");
            assert.ok(generationB.isRetired());

            // A matching Error frame after `socket.write()` is the authoritative known outcome, not `outcome_unknown`.
            // A matching Error frame after `socket.write()` is the authoritative known outcome, not `outcome_unknown`.
            const peerC = await ctx.startPeer();
            const generationC = await ctx.dial(peerC);
            const connectionC = await peerC.waitForConnection();
            const errored = generationC.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("will-error"),
                deadline: Deadline.start(5_000),
            });
            await connectionC.waitFor(() =>
                connectionC.frames.some((frame) => frame.corr === errored.correlation),
            );
            const errorBody = Buffer.from('{"code":"cancelled","message":"nope"}');
            await connectionC.send({
                ty: PeerFrameType.Error,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: errored.correlation,
                body: errorBody,
            });
            const terminal = await errored.result;
            assert.equal(terminal.kind, "error");
            assert.deepEqual(
                Buffer.from("text" in terminal.body ? (terminal.body.text ?? "") : ""),
                errorBody,
            );
            assert.ok(!generationC.isRetired());
        },
    },
    {
        // A post-write abort settles the caller before the original terminal.
        // A post-write abort leaves the cleanup ticket pending until the original terminal arrives.
        // The cleanup ticket completes exactly once when the original terminal arrives.
        name: "post-write abort settles the caller and the cleanup ticket independently",
        async run(ctx) {
            const peer = await ctx.startPeer();
            const generation = await ctx.dial(peer);
            const connection = await peer.waitForConnection();
            const request = generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("abort-me"),
                deadline: Deadline.start(10_000),
            });
            await connection.waitFor(() =>
                connection.frames.some((frame) => frame.corr === request.correlation),
            );
            const handle = request.abort();
            expectMcHostCallError(await rejection(request.result), "outcome_unknown", "aborted");
            generation.enqueueCancel(CHANNEL, EPOCH, request.correlation);
            let cleanupResolved = 0;
            void handle.cleanup.then(() => {
                cleanupResolved++;
            });
            await delay(30);
            assert.equal(cleanupResolved, 0, "cleanup ticket must await the terminal");
            await connection.send({
                ty: PeerFrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: request.correlation,
                body: Buffer.from("late-terminal"),
            });
            await handle.cleanup;
            await delay(10);
            assert.equal(cleanupResolved, 1);
            await connection.waitFor(() =>
                connection.frames.some(
                    (frame) =>
                        frame.ty === PeerFrameType.Cancel && frame.corr === request.correlation,
                ),
            );
            // The generation stays usable after private cleanup.
            const followUp = generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("after-cleanup"),
                deadline: Deadline.start(2_000),
            });
            await connection.waitFor(() =>
                connection.frames.some((frame) => frame.corr === followUp.correlation),
            );
            await connection.send({
                ty: PeerFrameType.Response,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: followUp.correlation,
                body: Buffer.from("ok"),
            });
            assert.equal((await followUp.result).kind, "response");
        },
    },
];
