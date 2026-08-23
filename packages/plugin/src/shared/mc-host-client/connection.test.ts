import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectionGeneration, type RetirementInfo } from "./connection";
import { Deadline } from "./deadline";
import { MAX_CORRELATION, MAX_FRAME_BODY_LEN } from "./protocol";
import { adversarialScenarios, runAdversarialScenario } from "./test-support/adversarial-scenarios";
import { encodePeerFrame, type FakePeerConnection, PeerFrameType } from "./test-support/fake-peer";
import {
    createTrackedHarness,
    expectSubcCallError as expectCallError,
    rejection,
    type TrackedHarness,
    waitUntil,
} from "./test-support/test-util";

const CHANNEL = 7;
const EPOCH = 77;

let h: TrackedHarness;
beforeEach(() => {
    h = createTrackedHarness();
});
afterEach(async () => {
    await h.cleanup();
});

async function roundTrip(
    generation: ConnectionGeneration,
    connection: FakePeerConnection,
    payload = "ok",
): Promise<void> {
    const request = generation.request({
        channel: CHANNEL,
        epoch: EPOCH,
        body: Buffer.from(payload),
        deadline: Deadline.start(2_000),
    });
    await connection.waitFor(() =>
        connection.frames.some(
            (frame) => frame.ty === PeerFrameType.Request && frame.corr === request.correlation,
        ),
    );
    await connection.send({
        ty: PeerFrameType.Response,
        channel: CHANNEL,
        epoch: EPOCH,
        corr: request.correlation,
        body: Buffer.from(payload),
    });
    const terminal = await request.result;
    expect(terminal.kind).toBe("response");
    expect(Buffer.from(terminal.body).toString()).toBe(payload);
}

describe("shared adversarial scenarios", () => {
    for (const scenario of adversarialScenarios) {
        test(scenario.name, async () => {
            await runAdversarialScenario(scenario);
        }, 20_000);
    }
});

describe("frame deadline and idle behavior", () => {
    test("healthy idle stays open while a stalled body times out after the first header byte", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer, { frameDeadlineMs: 100 });
        const connection = await peer.waitForConnection();
        // Idle wait between frames is unbounded: far longer than the frame
        // deadline with zero bytes on the wire must not retire.
        await delay(250);
        expect(generation.isRetired()).toBe(false);
        await roundTrip(generation, connection);
        await delay(150);
        expect(generation.isRetired()).toBe(false);
        // A frame that stalls after its first header byte hits the frame
        // deadline that started at that byte.
        const stalled = encodePeerFrame({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: 999n,
            body: Buffer.alloc(64),
        }).subarray(0, 10);
        await connection.sendRaw(Buffer.from(stalled));
        const info = await generation.retired;
        expect(info.reason).toBe("frame_deadline");
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("a body that stalls mid-transfer also hits the frame deadline", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer, { frameDeadlineMs: 100 });
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("x"),
            deadline: Deadline.start(5_000),
        });
        const full = encodePeerFrame({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.alloc(256),
        });
        // Header plus half the body, then silence.
        await connection.sendRaw(Buffer.from(full.subarray(0, 21 + 128)));
        const info = await generation.retired;
        expect(info.reason).toBe("frame_deadline");
        expectCallError(await rejection(request.result), "outcome_unknown");
    });
});

describe("writer capacity and reserved control frames", () => {
    test("control frames stay serializable through reserved capacity when the data queue is full", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer, { maxQueuedFrames: 2 });
        const connection = await peer.waitForConnection();
        connection.pauseReading();
        // Wedge the writer: the first frame's bytes reach socket.write()
        // and the socket stops accepting more until 'drain'.
        const wedge = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.alloc(8 * 1024 * 1024, 1),
            deadline: Deadline.start(20_000),
        });
        const q2 = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("q2"),
            deadline: Deadline.start(20_000),
        });
        const q3 = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("q3"),
            deadline: Deadline.start(20_000),
        });
        // Data queue is now at its 2-frame cap.
        let refused: unknown;
        try {
            generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("q4"),
                deadline: Deadline.start(20_000),
            });
        } catch (error) {
            refused = error;
        }
        expectCallError(refused, "not_sent", "writer_queue_full");
        // Required control writes must still be admittable.
        generation.enqueueCancel(CHANNEL, EPOCH, wedge.correlation);
        generation.enqueueRouteGoodbye(CHANNEL, EPOCH);
        await connection.send({ ty: PeerFrameType.Ping, corr: 42n });
        await waitUntil(() => generation.stats().queuedControlFrames === 3);
        expect(generation.isRetired()).toBe(false);
        connection.resumeReading();
        await connection.waitForFrameCount(6, 15_000);
        expect(connection.corruption).toBeNull();
        const types = connection.frames.map((frame) => frame.ty);
        expect(types.filter((ty) => ty === PeerFrameType.Request).length).toBe(3);
        expect(types).toContain(PeerFrameType.Cancel);
        expect(types).toContain(PeerFrameType.Goodbye);
        expect(types).toContain(PeerFrameType.Pong);
        // Request frames arrive complete, in enqueue order, corr-monotonic.
        const requests = connection.frames.filter((frame) => frame.ty === PeerFrameType.Request);
        expect(requests.map((frame) => frame.corr)).toEqual([
            wedge.correlation,
            q2.correlation,
            q3.correlation,
        ]);
        const pong = connection.frames.find((frame) => frame.ty === PeerFrameType.Pong);
        expect(pong?.corr).toBe(42n);
        wedge.abort();
        q2.abort();
        q3.abort();
    }, 20_000);

    test("exhausting reserved control capacity retires the generation", async () => {
        const peer = await h.startPeer();
        const retirements: RetirementInfo[] = [];
        const generation = await h.dial(peer, {
            controlReserveFrames: 2,
            onRetired: (info) => retirements.push(info),
        });
        const connection = await peer.waitForConnection();
        connection.pauseReading();
        generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.alloc(8 * 1024 * 1024, 1),
            deadline: Deadline.start(20_000),
        });
        generation.enqueueCancel(CHANNEL, EPOCH, 1n);
        generation.enqueueRouteGoodbye(CHANNEL, EPOCH);
        expect(generation.isRetired()).toBe(false);
        // Third control frame cannot queue safely: retire.
        generation.enqueueConnectionGoodbye();
        expect(generation.isRetired()).toBe(true);
        expect(retirements.map((info) => info.reason)).toEqual(["control_capacity_exhausted"]);
    }, 20_000);
});

describe("settlement races", () => {
    test("a terminal before the deadline settles once and clears every timer", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        await roundTrip(generation, connection);
        expect(generation.stats().activeTimers).toBe(0);
        expect(generation.stats().pendingRequests).toBe(0);
    });

    test("a deadline before the terminal is outcome_unknown; the late terminal is dropped", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("slow"),
            deadline: Deadline.start(60),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        expectCallError(await rejection(request.result), "outcome_unknown", "deadline_expired");
        expect(generation.stats().activeTimers).toBe(0);
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("late"),
        });
        await waitUntil(() => generation.stats().droppedFrames >= 1);
        expect(generation.isRetired()).toBe(false);
        await roundTrip(generation, connection);
    });

    test("a deadline while still queued is not_sent", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        connection.pauseReading();
        const wedge = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.alloc(8 * 1024 * 1024, 1),
            deadline: Deadline.start(20_000),
        });
        const queued = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("queued"),
            deadline: Deadline.start(50),
        });
        expectCallError(await rejection(queued.result), "not_sent", "deadline_expired");
        wedge.abort();
    }, 20_000);

    test("EOF after write invocation settles outcome_unknown exactly once", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("fin-race"),
            deadline: Deadline.start(5_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        connection.end();
        expectCallError(await rejection(request.result), "outcome_unknown");
        const info = await generation.retired;
        expect(info.reason).toBe("eof");
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("a terminal racing an orderly close wins for its correlation", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("race"),
            deadline: Deadline.start(5_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("won"),
        });
        connection.end();
        const terminal = await request.result;
        expect(terminal.kind).toBe("response");
        await generation.retired;
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("abort racing a terminal settles the caller once and the ticket once", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("abort-race"),
            deadline: Deadline.start(5_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        void connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("terminal"),
        });
        const handle = request.abort();
        const settled = await request.result.then(
            (terminal) => ({ kind: "resolved" as const, terminal }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        // Whichever side won, it won exactly once and cleanup completes.
        if (settled.kind === "rejected") {
            expectCallError(settled.error, "outcome_unknown", "aborted");
        }
        await handle.cleanup;
        expect(generation.stats().activeTimers).toBe(0);
        expect(generation.stats().pendingRequests).toBe(0);
    });
});

describe("host Ping and correlation namespaces", () => {
    test("Pong echoes a Ping whose correlation equals a pending consumer correlation", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("pending"),
            deadline: Deadline.start(5_000),
        });
        expect(request.correlation).toBe(1n);
        // Interactive priority: valid pure-header flags the Pong must echo.
        await connection.send({ ty: PeerFrameType.Ping, corr: 1n, flags: 0b0000_0010 });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.ty === PeerFrameType.Pong),
        );
        const pong = connection.frames.find((frame) => frame.ty === PeerFrameType.Pong);
        expect(pong?.corr).toBe(1n);
        expect(pong?.flags).toBe(0b0000_0010);
        expect(pong?.channel).toBe(0);
        expect(pong?.epoch).toBe(0);
        // The consumer request is untouched by the numerically equal host
        // correlation and settles only on its own terminal.
        expect(generation.stats().pendingRequests).toBe(1);
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: 1n,
            body: Buffer.from("done"),
        });
        expect((await request.result).kind).toBe("response");
    });
});

describe("ingress fencing", () => {
    test("stale, unmatched, duplicate, and post-terminal frames are dropped and counted", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("fence"),
            deadline: Deadline.start(5_000),
        });
        const corr = request.correlation;
        // Stale epoch (route epoch validated before pending lookup).
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH - 1,
            corr,
            body: Buffer.from("stale"),
        });
        // Unmatched correlation.
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: corr + 100n,
            body: Buffer.from("unmatched"),
        });
        await waitUntil(() => generation.stats().droppedFrames === 2);
        // The real terminal.
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr,
            body: Buffer.from("real"),
        });
        expect(Buffer.from((await request.result).body).toString()).toBe("real");
        // Duplicate terminal and post-terminal stream frame.
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr,
            body: Buffer.from("dup"),
        });
        await connection.send({
            ty: PeerFrameType.StreamData,
            channel: CHANNEL,
            epoch: EPOCH,
            corr,
            body: Buffer.from("post"),
        });
        await waitUntil(() => generation.stats().droppedFrames === 4);
        expect(generation.isRetired()).toBe(false);
        await roundTrip(generation, connection);
    });

    test.each([
        ["host-originated Request", { ty: PeerFrameType.Request, channel: 1, epoch: 1, corr: 1n }],
        ["Hello", { ty: PeerFrameType.Hello, corr: 0n }],
        ["HelloAck", { ty: PeerFrameType.HelloAck, corr: 0n }],
    ] as const)("role-invalid %s closes the generation", async (_name, fields) => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        await connection.send(fields);
        const info = await generation.retired;
        expect(info.reason).toBe("role_violation");
    });

    test.each([
        ["Ping outside 0/0/nonzero", { ty: PeerFrameType.Ping, channel: 3, epoch: 4, corr: 1n }],
        [
            "StreamEnd with a body",
            {
                ty: PeerFrameType.StreamEnd,
                channel: CHANNEL,
                epoch: EPOCH,
                corr: 1n,
                body: Buffer.from("x"),
            },
        ],
        ["Goodbye with nonzero corr", { ty: PeerFrameType.Goodbye, corr: 5n }],
        ["terminal with corr 0", { ty: PeerFrameType.Response, channel: 1, epoch: 1, corr: 0n }],
        [
            "reserved flag bits",
            { ty: PeerFrameType.Response, channel: 1, epoch: 1, corr: 1n, flags: 0b1100_0000 },
        ],
        [
            "unsupported version",
            { ty: PeerFrameType.Response, channel: 1, epoch: 1, corr: 1n, ver: 3 },
        ],
    ] as const)("structurally illegal %s closes without resync", async (_name, fields) => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        await connection.send(fields);
        const info = await generation.retired;
        expect(info.reason).toBe("protocol_violation");
    });
});

describe("route and connection Goodbye", () => {
    test("connection Goodbye retires; invoked work becomes outcome_unknown", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("in-flight"),
            deadline: Deadline.start(5_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        await connection.send({ ty: PeerFrameType.Goodbye, channel: 0, epoch: 0, corr: 0n });
        expectCallError(await rejection(request.result), "outcome_unknown");
        const info = await generation.retired;
        expect(info.reason).toBe("connection_goodbye");
    });

    test("route Goodbye fails that route's pending work as terminal route-gone via the hook", async () => {
        const peer = await h.startPeer();
        const routeEvents: Array<[number, number]> = [];
        const generation = await h.dial(peer, {
            onRouteGoodbye: (channel, epoch) => routeEvents.push([channel, epoch]),
        });
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("route-doomed"),
            deadline: Deadline.start(5_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        await connection.send({
            ty: PeerFrameType.Goodbye,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: 0n,
        });
        expectCallError(await rejection(request.result), "outcome_unknown", "route_gone");
        await waitUntil(() => routeEvents.length === 1);
        expect(routeEvents[0]).toEqual([CHANNEL, EPOCH]);
        expect(generation.isRetired()).toBe(false);
        // The connection stays usable on other routes.
        const followUp = generation.request({
            channel: 8,
            epoch: 1,
            body: Buffer.from("other-route"),
            deadline: Deadline.start(2_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === followUp.correlation),
        );
        await connection.send({
            ty: PeerFrameType.Response,
            channel: 8,
            epoch: 1,
            corr: followUp.correlation,
            body: Buffer.from("ok"),
        });
        expect((await followUp.result).kind).toBe("response");
    });
});

describe("stream handling (KTD11)", () => {
    test("a unary caller drains a legal stream, then fails terminally while the connection stays usable", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("unary"),
            deadline: Deadline.start(5_000),
        });
        await connection.send({
            ty: PeerFrameType.StreamData,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("item-1"),
        });
        await connection.send({
            ty: PeerFrameType.StreamData,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("item-2"),
        });
        await connection.send({
            ty: PeerFrameType.StreamEnd,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
        });
        expectCallError(await rejection(request.result), "terminal", "unexpected_stream");
        expect(generation.isRetired()).toBe(false);
        // Drained privately: nothing retained.
        expect(generation.stats().pendingHeldBytes).toBe(0);
        await roundTrip(generation, connection);
    });

    test("a stream-mode caller receives ordered items and the StreamEnd terminal", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("stream"),
            deadline: Deadline.start(5_000),
            mode: "stream",
        });
        await connection.send({
            ty: PeerFrameType.StreamData,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("s1"),
        });
        await connection.send({
            ty: PeerFrameType.StreamData,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body: Buffer.from("s2"),
        });
        await connection.send({
            ty: PeerFrameType.StreamEnd,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
        });
        const terminal = await request.result;
        expect(terminal.kind).toBe("stream_end");
        expect(terminal.stream.map((item) => Buffer.from(item).toString())).toEqual(["s1", "s2"]);
        await waitUntil(() => generation.stats().memoryUsed === 0);
    });
});

describe("memory accounting and the 64 MiB boundary", () => {
    test("one exact 64 MiB frame is accepted without duplicate full-body retention", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("gimme-max"),
            deadline: Deadline.start(25_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        const body = Buffer.alloc(MAX_FRAME_BODY_LEN, 7);
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: request.correlation,
            body,
        });
        const terminal = await request.result;
        expect(terminal.kind).toBe("response");
        expect(terminal.body.length).toBe(MAX_FRAME_BODY_LEN);
        expect(terminal.body[0]).toBe(7);
        expect(terminal.body[MAX_FRAME_BODY_LEN - 1]).toBe(7);
        const stats = generation.stats();
        // Accounting proof, not RSS: the body was charged exactly once (a
        // duplicate full-body copy would exceed the aggregate cap, which
        // only admits one maximum frame plus fixed overhead).
        expect(stats.memoryPeak).toBeGreaterThanOrEqual(MAX_FRAME_BODY_LEN);
        expect(stats.memoryPeak).toBeLessThanOrEqual(stats.memoryCap);
        await waitUntil(() => generation.stats().memoryUsed === 0);
    }, 60_000);

    test("a 64 MiB + 1 declaration is rejected before body allocation", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        // Header only: the declaration alone must close the generation.
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: 1n,
            len: MAX_FRAME_BODY_LEN + 1,
        });
        const info = await generation.retired;
        expect(info.reason).toBe("protocol_violation");
        // Nothing was allocated or charged for the declared body.
        expect(generation.stats().memoryPeak).toBeLessThan(1_024);
    });

    test("pressure pauses the socket before admitting a second large body and resumes when it clears", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer, {
            maxBodyLen: 4_096,
            memoryCapBytes: 5_000,
            frameDeadlineMs: 10_000,
        });
        const connection = await peer.waitForConnection();
        // R1 (stream mode) retains its StreamData privately: 4,096 held.
        const first = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("r1"),
            deadline: Deadline.start(400),
            mode: "stream",
        });
        const second = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("r2"),
            deadline: Deadline.start(10_000),
        });
        await connection.waitFor(
            () =>
                connection.frames.filter((frame) => frame.ty === PeerFrameType.Request).length >= 2,
        );
        await connection.send({
            ty: PeerFrameType.StreamData,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: first.correlation,
            body: Buffer.alloc(4_096, 1),
        });
        await waitUntil(() => generation.stats().pendingHeldBytes === 4_096);
        // The second large body cannot be admitted under the cap: the
        // socket pauses before allocation instead of buffering a second
        // large frame.
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: second.correlation,
            body: Buffer.alloc(4_096, 2),
        });
        await waitUntil(() => generation.stats().readPaused);
        expect(generation.stats().readerHeldBytes).toBe(0);
        // R1's deadline releases its held stream items; pressure clears,
        // the socket resumes, and the deferred body is admitted.
        expectCallError(await rejection(first.result), "outcome_unknown", "deadline_expired");
        const terminal = await second.result;
        expect(terminal.kind).toBe("response");
        expect(terminal.body.length).toBe(4_096);
        expect(generation.stats().readPaused).toBe(false);
        await waitUntil(() => generation.stats().memoryUsed === 0);
    });

    test("admission is refused when a request would exceed the aggregate cap", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer, { memoryCapBytes: 1_000 });
        let refused: unknown;
        try {
            generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.alloc(2_000),
                deadline: Deadline.start(2_000),
            });
        } catch (error) {
            refused = error;
        }
        expectCallError(refused, "not_sent", "memory_cap");
    });
});

describe("correlation lifecycle", () => {
    test("u64::MAX is used once, then further requests are refused until retirement", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer, { firstCorrelation: MAX_CORRELATION });
        const connection = await peer.waitForConnection();
        const last = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("final"),
            deadline: Deadline.start(5_000),
        });
        expect(last.correlation).toBe(MAX_CORRELATION);
        let refused: unknown;
        try {
            generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("one-too-many"),
                deadline: Deadline.start(5_000),
            });
        } catch (error) {
            refused = error;
        }
        expectCallError(refused, "not_sent", "correlations_exhausted");
        // The final correlation still completes normally.
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === MAX_CORRELATION),
        );
        await connection.send({
            ty: PeerFrameType.Response,
            channel: CHANNEL,
            epoch: EPOCH,
            corr: MAX_CORRELATION,
            body: Buffer.from("done"),
        });
        expect((await last.result).kind).toBe("response");
    });

    test("requests against a retired generation are refused as not_sent", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        generation.retire("owner_close");
        let refused: unknown;
        try {
            generation.request({
                channel: CHANNEL,
                epoch: EPOCH,
                body: Buffer.from("too-late"),
                deadline: Deadline.start(2_000),
            });
        } catch (error) {
            refused = error;
        }
        expectCallError(refused, "not_sent", "connection_retired");
    });
});

describe("cleanup tickets (KTD10)", () => {
    test("ticket deadline expiry forces retirement and completes the ticket", async () => {
        const peer = await h.startPeer();
        const retirements: RetirementInfo[] = [];
        const generation = await h.dial(peer, {
            cleanupTicketMs: 80,
            onRetired: (info) => retirements.push(info),
        });
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("never-answered"),
            deadline: Deadline.start(10_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        const handle = request.abort();
        expectCallError(await rejection(request.result), "outcome_unknown", "aborted");
        await handle.cleanup;
        expect(retirements.map((info) => info.reason)).toEqual(["cleanup_deadline"]);
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("retirement completes an outstanding cleanup ticket exactly once", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        const connection = await peer.waitForConnection();
        const request = generation.request({
            channel: CHANNEL,
            epoch: EPOCH,
            body: Buffer.from("abandoned"),
            deadline: Deadline.start(10_000),
        });
        await connection.waitFor(() =>
            connection.frames.some((frame) => frame.corr === request.correlation),
        );
        const handle = request.abort();
        let cleanups = 0;
        void handle.cleanup.then(() => {
            cleanups++;
        });
        generation.retire("owner_close");
        await handle.cleanup;
        await delay(10);
        expect(cleanups).toBe(1);
    });
});

describe("setup failures", () => {
    test("a malformed ServerProof retires once with no leaked socket or timer", async () => {
        const peer = await h.startPeer({ authMode: "malformed" });
        const retirements: RetirementInfo[] = [];
        const generation = h.createGeneration(peer, {
            onRetired: (info) => retirements.push(info),
        });
        const error = await rejection(generation.start(Deadline.start(2_000)));
        expect((error as Error).name).toBe("AuthError");
        expect(retirements.length).toBe(1);
        expect(retirements[0]?.reason).toBe("auth_failed");
        expect(generation.stats().activeTimers).toBe(0);
        const connection = await peer.waitForConnection();
        await connection.closed;
        // No ClientAuth after the malformed server message.
        expect(connection.authMessages.length).toBe(1);
    });

    test("a peer that destroys during the handshake retires exactly once", async () => {
        const peer = await h.startPeer({ authMode: "destroy-on-hello" });
        const retirements: RetirementInfo[] = [];
        const generation = h.createGeneration(peer, {
            onRetired: (info) => retirements.push(info),
        });
        await rejection(generation.start(Deadline.start(2_000)));
        expect(retirements.length).toBe(1);
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("an auth deadline observed mid-handshake retires as setup_deadline", async () => {
        let nowMs = 0;
        const peer = await h.startPeer({ authMode: "stall" });
        const retirements: RetirementInfo[] = [];
        const generation = h.createGeneration(peer, {
            onRetired: (info) => retirements.push(info),
        });
        const failure = rejection(generation.start(Deadline.start(60_000, () => nowMs)));
        const connection = await peer.waitForConnection();
        await waitUntil(() => connection.authMessages.length === 1);
        // The budget expires on the fake clock while the real 60s setup
        // timer stays pending, so the auth reader observes expiry first —
        // the same shape as auth I/O landing ahead of a lagging timer
        // callback. Budget exhaustion must not read as an auth failure.
        nowMs = 60_001;
        await connection.sendRaw(Buffer.from([8, 0, 0, 0]));
        const error = await failure;
        expect((error as Error).name).toBe("AuthError");
        expect((error as { code?: string }).code).toBe("deadline_expired");
        expect(retirements.length).toBe(1);
        expect(retirements[0]?.reason).toBe("setup_deadline");
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("a dial to a closed port retires exactly once", async () => {
        const peer = await h.startPeer();
        const port = peer.port;
        await peer.close();
        const retirements: RetirementInfo[] = [];
        const generation = new ConnectionGeneration({
            host: "127.0.0.1",
            port,
            credentials: { key: Buffer.alloc(32), daemonId: Buffer.alloc(16) },
            onRetired: (info) => retirements.push(info),
        });
        await rejection(generation.start(Deadline.start(2_000)));
        expect(generation.isRetired()).toBe(true);
        expect(retirements.length).toBe(1);
        expect(generation.stats().activeTimers).toBe(0);
    });

    test("start is single-flight per generation", async () => {
        const peer = await h.startPeer();
        const generation = await h.dial(peer);
        await expect(generation.start(Deadline.start(100))).rejects.toThrow(/single-flight/);
    });
});
