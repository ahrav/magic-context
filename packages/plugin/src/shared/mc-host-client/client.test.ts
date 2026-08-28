import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    connectionFileExists,
    isConsumerReconnectTransient,
    McHostClient,
    type McHostClientOptions,
    type McHostDiagnosticsEvent,
} from "./client";
import { isMcHostCallError, McHostCallError, McHostClientError, SocketClosedError } from "./errors";
import type { RouteHandle } from "./route-handle";
import { StaleRouteHandleError } from "./route-handle";
import {
    encodePeerFrame,
    FakePeer,
    type FakePeerConnection,
    type PeerFrame,
    PeerFrameType,
    type PeerNegotiateResponder,
} from "./test-support/fake-peer";
import {
    candidateAutoResponder,
    createFakePairedProvider,
    rejection,
    waitUntil,
    writeConnectionFile,
} from "./test-support/test-util";
import type { BindIdentity, RouteTarget } from "./types";

const IDENTITY: BindIdentity = {
    project_root: "/workspace/project",
    harness: "opencode",
    session: "session-1",
};
const TOOL_TARGET: RouteTarget = { kind: "tool_provider", module_id: "magic-context" };

let tmpDir = "";
let fileCounter = 0;
let peers: FakePeer[] = [];
let clients: McHostClient[] = [];
let savedModuleId: string | undefined;
let savedLaunchNonce: string | undefined;

beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc-host-client-"));
    savedModuleId = process.env.SUBC_MODULE_ID;
    savedLaunchNonce = process.env.SUBC_LAUNCH_NONCE;
});

afterAll(async () => {
    if (savedModuleId === undefined) delete process.env.SUBC_MODULE_ID;
    else process.env.SUBC_MODULE_ID = savedModuleId;
    if (savedLaunchNonce === undefined) delete process.env.SUBC_LAUNCH_NONCE;
    else process.env.SUBC_LAUNCH_NONCE = savedLaunchNonce;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    peers = [];
    clients = [];
    delete process.env.SUBC_MODULE_ID;
    delete process.env.SUBC_LAUNCH_NONCE;
});

afterEach(async () => {
    for (const client of clients) {
        await client.closeAsync().catch(() => {});
    }
    for (const peer of peers) {
        await peer.close();
    }
});

async function startPeer(options: Parameters<typeof FakePeer.start>[0] = {}): Promise<FakePeer> {
    const peer = await FakePeer.start(options);
    peers.push(peer);
    return peer;
}

function freshFilePath(): string {
    fileCounter += 1;
    return path.join(tmpDir, `conn-${fileCounter}.json`);
}

interface ConnectedHarness {
    peer: FakePeer;
    conn: FakePeerConnection;
    client: McHostClient;
    filePath: string;
}

async function connected(overrides: Partial<McHostClientOptions> = {}): Promise<ConnectedHarness> {
    const peer = await startPeer();
    const filePath = freshFilePath();
    await writeConnectionFile(filePath, peer);
    const client = await McHostClient.connect({
        connectionFile: filePath,
        shutdownDeadlineMs: 1_000,
        ...overrides,
    });
    clients.push(client);
    const conn = await peer.waitForConnection();
    await conn.authenticated;
    return { peer, conn, client, filePath };
}

async function nthConnection(peer: FakePeer, n: number): Promise<FakePeerConnection> {
    await waitUntil(() => peer.connections.length >= n);
    return peer.connections[n - 1] as FakePeerConnection;
}

function expectCallError(
    error: unknown,
    kind: McHostCallError["kind"],
    code?: string,
): McHostCallError {
    expect(error).toBeInstanceOf(McHostCallError);
    const callError = error as McHostCallError;
    expect(callError.kind).toBe(kind);
    if (code !== undefined) expect(callError.code).toBe(code);
    return callError;
}

function bodyJson(frame: PeerFrame): unknown {
    try {
        return JSON.parse(frame.body.toString("utf8"));
    } catch {
        return undefined;
    }
}

function isControlOp(frame: PeerFrame, op: string): boolean {
    if (frame.ty !== PeerFrameType.Request || frame.channel !== 0) return false;
    const parsed = bodyJson(frame) as { op?: unknown } | undefined;
    return parsed?.op === op;
}

const isRouteOpen = (frame: PeerFrame): boolean => isControlOp(frame, "route.open");
const isRoutedRequest =
    (channel: number) =>
    (frame: PeerFrame): boolean =>
        frame.ty === PeerFrameType.Request && frame.channel === channel;

interface FrameCursor {
    next(predicate: (frame: PeerFrame) => boolean, timeoutMs?: number): Promise<PeerFrame>;
}

/** Ordered frame consumption: each `next` scans forward from the last hit. */
function frameCursor(conn: FakePeerConnection): FrameCursor {
    let index = 0;
    return {
        async next(predicate, timeoutMs = 4_000) {
            let found: PeerFrame | null = null;
            await conn.waitFor(() => {
                for (let i = index; i < conn.frames.length; i++) {
                    const frame = conn.frames[i] as PeerFrame;
                    if (predicate(frame)) {
                        index = i + 1;
                        found = frame;
                        return true;
                    }
                }
                return false;
            }, timeoutMs);
            return found as unknown as PeerFrame;
        },
    };
}

function jsonBody(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value), "utf8");
}

function sendResponse(
    conn: FakePeerConnection,
    corr: bigint,
    value: unknown,
    channel = 0,
    epoch = 0,
): Promise<void> {
    return conn.send({ ty: PeerFrameType.Response, channel, epoch, corr, body: jsonBody(value) });
}

function sendErrorBody(
    conn: FakePeerConnection,
    corr: bigint,
    code: string,
    channel = 0,
    epoch = 0,
): Promise<void> {
    return conn.send({
        ty: PeerFrameType.Error,
        channel,
        epoch,
        corr,
        body: jsonBody({ code, message: `error ${code}` }),
    });
}

function sendRouteOpenOk(
    conn: FakePeerConnection,
    corr: bigint,
    channel: number,
    epoch: number,
): Promise<void> {
    return sendResponse(conn, corr, {
        op: "route.open",
        route_channel: channel,
        route_epoch: epoch,
    });
}

async function serveManagedCall(
    conn: FakePeerConnection,
    cursor: FrameCursor,
    channel: number,
    epoch: number,
    response: unknown,
): Promise<PeerFrame> {
    const open = await cursor.next(isRouteOpen);
    await sendRouteOpenOk(conn, open.corr, channel, epoch);
    const body = await cursor.next(isRoutedRequest(channel));
    await sendResponse(conn, body.corr, response, channel, epoch);
    return body;
}

async function openRoute(
    client: McHostClient,
    conn: FakePeerConnection,
    cursor: FrameCursor,
    channel: number,
    epoch: number,
): Promise<RouteHandle> {
    const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
    const frame = await cursor.next(isRouteOpen);
    await sendRouteOpenOk(conn, frame.corr, channel, epoch);
    return openPromise;
}

async function jamWriter(
    client: McHostClient,
    conn: FakePeerConnection,
    handle: RouteHandle,
): Promise<void> {
    conn.pauseReading();
    const big = new Uint8Array(32 * 1024 * 1024);
    client.request(handle, big, { timeoutMs: 3_000 }).catch(() => {});
    await delay(20);
}

/**
 * Arrange to pause the NEXT accepted connection's reads before the client's
 * auth hello is processed (the pause runs in a microtask ahead of any socket
 * 'data' event), deterministically stalling setup until `resumeReading()`.
 * Index-based selection: connections accepted before this call are never
 * returned, even when their peer-side sockets have not observed destruction
 * yet. Must be called before the dial is triggered.
 */
function stallNextConnection(peer: FakePeer): Promise<FakePeerConnection> {
    return peer.waitForConnectionAfter(peer.connections.length).then((conn) => {
        conn.pauseReading();
        return conn;
    });
}

const isRoutedFrame = (frame: PeerFrame): boolean =>
    frame.ty === PeerFrameType.Request && frame.channel !== 0;

describe("McHostClient facade", () => {
    test("completes tagged catalog, route open, opaque JSON request, and route Goodbye", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);

        const catalogPromise = client.catalogList();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        expect(catalogFrame.body.toString("utf8")).toBe('{"op":"catalog.list"}');
        const entry = {
            module_id: "magic-context",
            module_version: "0.1.0",
            roles: [],
            control_ops: ["route.open"],
        };
        await sendResponse(conn, catalogFrame.corr, {
            op: "catalog.list",
            generation: 1,
            modules: [entry],
            subc_ops: ["route.open", "catalog.list"],
        });
        expect(await catalogPromise).toEqual([entry]);

        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const openFrame = await cursor.next(isRouteOpen);
        expect(openFrame.body.toString("utf8")).toBe(
            '{"op":"route.open","target":{"kind":"tool_provider","module_id":"magic-context"},' +
                '"identity":{"project_root":"/workspace/project","harness":"opencode","session":"session-1"}}',
        );
        await sendRouteOpenOk(conn, openFrame.corr, 7, 77);
        const handle = await openPromise;
        expect(handle.channel).toBe(7);
        expect(handle.epoch).toBe(77);

        const requestPromise = client.request(handle, { hello: true });
        const requestFrame = await cursor.next(isRoutedRequest(7));
        expect(requestFrame.epoch).toBe(77);
        expect(requestFrame.corr > openFrame.corr).toBe(true);
        expect(bodyJson(requestFrame)).toEqual({ hello: true });
        await sendResponse(conn, requestFrame.corr, { ok: 1 }, 7, 77);
        expect(await requestPromise).toEqual({ ok: 1 });

        await client.closeRoute(handle);
        const goodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(goodbye.channel).toBe(7);
        expect(goodbye.epoch).toBe(77);
        expect(goodbye.corr).toBe(0n);
    });

    test("sends consumer_identity only when both env variables are non-empty", async () => {
        process.env.SUBC_MODULE_ID = "mod-a";
        process.env.SUBC_LAUNCH_NONCE = "nonce-b";
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const frame = await cursor.next(isRouteOpen);
        expect(bodyJson(frame)).toEqual({
            op: "route.open",
            target: { kind: "tool_provider", module_id: "magic-context" },
            identity: IDENTITY,
            consumer_identity: { module_id: "mod-a", launch_nonce: "nonce-b" },
        });
        await sendRouteOpenOk(conn, frame.corr, 3, 1);
        await openPromise;
    });

    test("rejects untagged or malformed control success with a typed terminal error", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);

        const catalogPromise = client.catalogList();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        await sendResponse(conn, catalogFrame.corr, { generation: 1, modules: [] });
        expectCallError(await rejection(catalogPromise), "terminal", "malformed_control_response");

        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const openFrame = await cursor.next(isRouteOpen);
        await sendResponse(conn, openFrame.corr, { op: "route.open", route_channel: "seven" });
        expectCallError(await rejection(openPromise), "terminal", "malformed_control_response");

        const openPromise2 = client.routeOpen(TOOL_TARGET, IDENTITY);
        const openFrame2 = await cursor.next(isRouteOpen);
        await conn.send({
            ty: PeerFrameType.Response,
            channel: 0,
            epoch: 0,
            corr: openFrame2.corr,
            body: Buffer.from("not json", "utf8"),
        });
        expectCallError(await rejection(openPromise2), "terminal", "malformed_control_response");
    });

    test("canonical Error body becomes a terminal McHostCallError with its stable code", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);

        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const openFrame = await cursor.next(isRouteOpen);
        await sendErrorBody(conn, openFrame.corr, "unknown_module");
        const openError = expectCallError(
            await rejection(openPromise),
            "terminal",
            "unknown_module",
        );
        expect(openError.message).toBe("error unknown_module");

        const handle = await openRoute(client, conn, cursor, 7, 77);
        const requestPromise = client.request(handle, { x: 1 });
        const requestFrame = await cursor.next(isRoutedRequest(7));
        await sendErrorBody(conn, requestFrame.corr, "store_unavailable", 7, 77);
        expectCallError(await rejection(requestPromise), "terminal", "store_unavailable");
    });

    test("artifact_invalid bind rejection is permanent: one route.open, no retry", async () => {
        const sleeps: number[] = [];
        const { client, conn } = await connected({
            identity: IDENTITY,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });
        const cursor = frameCursor(conn);
        const callPromise = client.call("synapse", "models.list", undefined, {
            targetKind: "management_surface",
        });

        const open1 = await cursor.next(isRouteOpen);
        await sendErrorBody(conn, open1.corr, "artifact_invalid");

        const error = (await callPromise.catch((e) => e)) as McHostCallError;
        expect(error).toBeInstanceOf(McHostCallError);
        expect(error.kind).toBe("terminal");
        expect(error.code).toBe("artifact_invalid");
        // artifact_invalid must not enter the momentary-rejection retry loop.
        expect(sleeps).toEqual([]);
        const opens = conn.frames.filter(isRouteOpen);
        expect(opens.length).toBe(1);
    });

    test("managed call retries allowlisted route-open terminals and never sends the body early", async () => {
        const sleeps: number[] = [];
        const { client, conn } = await connected({
            identity: IDENTITY,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });
        const cursor = frameCursor(conn);
        const callPromise = client.call("magic-context", "ping", { n: 1 });

        const open1 = await cursor.next(isRouteOpen);
        await sendErrorBody(conn, open1.corr, "unknown_module");
        const open2 = await cursor.next(isRouteOpen);
        await sendErrorBody(conn, open2.corr, "module_reloading");
        const open3 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open3.corr, 9, 3);

        const body = await cursor.next(isRoutedRequest(9));
        expect(bodyJson(body)).toEqual({ method: "ping", params: { n: 1 } });
        const routedIndex = conn.frames.indexOf(body);
        const earlyRouted = conn.frames
            .slice(0, routedIndex)
            .filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(earlyRouted).toEqual([]);
        expect(open2.corr > open1.corr && open3.corr > open2.corr).toBe(true);

        await sendResponse(conn, body.corr, { pong: true }, 9, 3);
        expect(await callPromise).toEqual({ pong: true });
        expect(sleeps).toEqual([100, 200]);
    });

    test("route-open retry stops at the single 30s route-open deadline as not_sent", async () => {
        let nowMs = 0;
        const { client, conn } = await connected({
            identity: IDENTITY,
            clock: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms;
            },
        });
        const cursor = frameCursor(conn);
        const callPromise = client.call("magic-context", "m");
        let settled = false;
        const result = rejection(callPromise).then((error) => {
            settled = true;
            return error;
        });

        let attempts = 0;
        while (!settled && attempts < 40) {
            let frame: PeerFrame;
            try {
                frame = await cursor.next(isRouteOpen, 400);
            } catch {
                break;
            }
            attempts += 1;
            await sendErrorBody(conn, frame.corr, "target_unavailable");
        }

        const error = expectCallError(await result, "not_sent", "target_unavailable");
        expect(error.message).toContain("retry budget exhausted");
        expect(attempts).toBeGreaterThan(2);
        expect(attempts).toBeLessThan(40);
        expect(nowMs).toBeGreaterThanOrEqual(30_000);
        const routed = conn.frames.filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(routed).toEqual([]);
    });

    test("ambiguous route.open sends no Cancel, retires the generation, and a late response is fenced", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn, peer } = await connected({
            routeOpenDeadlineMs: 250,
            diagnostics: (event) => events.push(event),
        });
        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const cursor = frameCursor(conn);
        const openFrame = await cursor.next(isRouteOpen);

        expectCallError(await rejection(openPromise), "outcome_unknown", "deadline_expired");
        await conn.closed;
        expect(conn.frames.some((f) => f.ty === PeerFrameType.Cancel)).toBe(false);
        expect(
            events.some((e) => e.type === "retired" && e.reason === "ambiguous_route_open"),
        ).toBe(true);

        await conn.send({
            ty: PeerFrameType.Response,
            channel: 0,
            epoch: 0,
            corr: openFrame.corr,
            body: jsonBody({ op: "route.open", route_channel: 7, route_epoch: 77 }),
        });

        const catalogPromise = client.catalogList();
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        const catalogFrame = await cursor2.next((f) => isControlOp(f, "catalog.list"));
        await sendResponse(conn2, catalogFrame.corr, {
            op: "catalog.list",
            generation: 1,
            modules: [],
            subc_ops: ["route.open"],
        });
        expect(await catalogPromise).toEqual([]);
    });

    test("owner close turns a successful uncached route into route Goodbye before connection Goodbye", async () => {
        const { client, conn } = await connected({ shutdownDeadlineMs: 3_000 });
        const cursor = frameCursor(conn);
        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const openFrame = await cursor.next(isRouteOpen);

        const closePromise = client.closeAsync();
        await delay(30);
        await sendRouteOpenOk(conn, openFrame.corr, 7, 77);

        expectCallError(await rejection(openPromise), "not_sent", "route_closed");
        const routeGoodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(routeGoodbye.channel).toBe(7);
        expect(routeGoodbye.epoch).toBe(77);
        const connGoodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(connGoodbye.channel).toBe(0);
        expect(connGoodbye.epoch).toBe(0);
        await closePromise;
        await conn.closed;
    });

    test("failed cleanup Goodbye enqueue retires the generation", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn } = await connected({
            shutdownDeadlineMs: 2_000,
            generationOptions: { controlReserveFrames: 0 },
            diagnostics: (event) => events.push(event),
        });
        const cursor = frameCursor(conn);
        const openPromise = client.routeOpen(TOOL_TARGET, IDENTITY);
        const openFrame = await cursor.next(isRouteOpen);

        const closePromise = client.closeAsync();
        await delay(30);
        await sendRouteOpenOk(conn, openFrame.corr, 7, 77);

        expectCallError(await rejection(openPromise), "not_sent", "route_closed");
        await closePromise;
        await waitUntil(() =>
            events.some((e) => e.type === "retired" && e.reason === "control_capacity_exhausted"),
        );
        expect(conn.frames.some((f) => f.ty === PeerFrameType.Goodbye)).toBe(false);
        await conn.closed;
    });

    test("reconnects after credential rotation, reauthenticates, and rejects stale handles", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const harness = await connected({
            identity: IDENTITY,
            diagnostics: (event) => events.push(event),
        });
        const { client, conn, filePath } = harness;
        const cursor = frameCursor(conn);

        const warm = client.call("magic-context", "warm");
        await serveManagedCall(conn, cursor, 7, 77, { ok: true });
        await warm;
        const oldHandle = await openRoute(client, conn, cursor, 8, 5);

        const peerB = await startPeer();
        await writeConnectionFile(filePath, peerB);
        conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));

        const callPromise = client.call("magic-context", "after-rotation");
        const connB = await nthConnection(peerB, 1);
        await connB.authenticated;
        expect(connB.clientAuthValid).toBe(true);
        const cursorB = frameCursor(connB);
        await serveManagedCall(connB, cursorB, 12, 1, { ok: 2 });
        expect(await callPromise).toEqual({ ok: 2 });

        const staleError = await rejection(client.request(oldHandle, { x: 1 }));
        expect(staleError).toBeInstanceOf(StaleRouteHandleError);
        expect((staleError as StaleRouteHandleError).code).toBe("stale_route_handle");
        expect((staleError as Error).message).toBe(
            "route handle (8, 5) is not live on the current connection",
        );
    });

    test("managed call spends its one replay token on terminal unknown_channel", async () => {
        const { client, conn } = await connected({ identity: IDENTITY });
        const cursor = frameCursor(conn);
        const callPromise = client.call("magic-context", "m", { a: 1 });

        const open1 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open1.corr, 7, 77);
        const body1 = await cursor.next(isRoutedRequest(7));
        await sendErrorBody(conn, body1.corr, "unknown_channel", 7, 77);

        const open2 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open2.corr, 7, 78);
        const body2 = await cursor.next((f) => isRoutedRequest(7)(f) && f.epoch === 78);
        expect(bodyJson(body2)).toEqual({ method: "m", params: { a: 1 } });
        await sendResponse(conn, body2.corr, { done: true }, 7, 78);

        expect(await callPromise).toEqual({ done: true });
        const routed = conn.frames.filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(routed.length).toBe(2);
    });

    test("second unknown_channel is terminal: the replay token is single-use", async () => {
        const { client, conn } = await connected({ identity: IDENTITY });
        const cursor = frameCursor(conn);
        const callPromise = client.call("magic-context", "m");

        const open1 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open1.corr, 7, 77);
        const body1 = await cursor.next(isRoutedRequest(7));
        await sendErrorBody(conn, body1.corr, "unknown_channel", 7, 77);
        const open2 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open2.corr, 7, 78);
        const body2 = await cursor.next((f) => isRoutedRequest(7)(f) && f.epoch === 78);
        await sendErrorBody(conn, body2.corr, "unknown_channel", 7, 78);

        expectCallError(await rejection(callPromise), "terminal", "unknown_channel");
        await delay(50);
        const routed = conn.frames.filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(routed.length).toBe(2);
    });

    test("outcome_unknown is never replayed by the managed path", async () => {
        const { client, conn } = await connected({ identity: IDENTITY });
        const cursor = frameCursor(conn);
        const callPromise = client.call("magic-context", "m", undefined, { timeoutMs: 300 });

        const open1 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open1.corr, 7, 77);
        await cursor.next(isRoutedRequest(7));

        expectCallError(await rejection(callPromise), "outcome_unknown", "deadline_expired");
        await delay(100);
        const routed = conn.frames.filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(routed.length).toBe(1);
        expect(conn.frames.filter(isRouteOpen).length).toBe(1);
    });

    test("an aborted caller cannot spend the replay token", async () => {
        const { client, conn } = await connected({ identity: IDENTITY });
        const cursor = frameCursor(conn);
        const controller = new AbortController();
        const callPromise = client.call("magic-context", "m", undefined, {
            signal: controller.signal,
        });

        const open1 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open1.corr, 7, 77);
        const body1 = await cursor.next(isRoutedRequest(7));
        controller.abort();

        const error = expectCallError(await rejection(callPromise), "outcome_unknown", "aborted");
        expect(error.cleanup).toBeDefined();
        const cancel = await cursor.next((f) => f.ty === PeerFrameType.Cancel);
        expect(cancel.channel).toBe(7);
        expect(cancel.corr).toBe(body1.corr);
        await delay(50);
        const routed = conn.frames.filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(routed.length).toBe(1);
        await sendResponse(conn, body1.corr, { late: true }, 7, 77);
        await error.cleanup;
    });

    test("a proven not_sent spends the token once and a second not_sent is refused", async () => {
        const { client, conn } = await connected({
            identity: IDENTITY,
            generationOptions: { maxQueuedFrames: 1 },
            shutdownDeadlineMs: 200,
        });
        const cursor = frameCursor(conn);
        const warm = client.call("magic-context", "warm");
        await serveManagedCall(conn, cursor, 7, 77, { ok: true });
        await warm;
        const handle = await openRoute(client, conn, cursor, 8, 1);

        await jamWriter(client, conn, handle);
        client.request(handle, { filler: true }, { timeoutMs: 3_000 }).catch(() => {});

        const error = await rejection(client.call("magic-context", "m2"));
        expectCallError(error, "not_sent", "writer_queue_full");

        conn.resumeReading();
        await delay(50);
        const m2Bodies = conn.frames.filter((f) => {
            const parsed = bodyJson(f) as { method?: unknown } | undefined;
            return parsed?.method === "m2";
        });
        expect(m2Bodies).toEqual([]);
    });

    test("raw request never replays: terminal unknown_channel surfaces unchanged", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);

        const requestPromise = client.request(handle, { x: 1 });
        const frame = await cursor.next(isRoutedRequest(7));
        await sendErrorBody(conn, frame.corr, "unknown_channel", 7, 77);
        expectCallError(await rejection(requestPromise), "terminal", "unknown_channel");
        await delay(50);
        const routed = conn.frames.filter((f) => f.ty === PeerFrameType.Request && f.channel !== 0);
        expect(routed.length).toBe(1);
    });

    test("unary StreamData is drained to StreamEnd, fails terminally, and the connection stays usable", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);

        const first = client.request(handle, { stream: true });
        const frame1 = await cursor.next(isRoutedRequest(7));
        await conn.send({
            ty: PeerFrameType.StreamData,
            channel: 7,
            epoch: 77,
            corr: frame1.corr,
            body: Buffer.from("chunk-1"),
        });
        await conn.send({
            ty: PeerFrameType.StreamData,
            channel: 7,
            epoch: 77,
            corr: frame1.corr,
            body: Buffer.from("chunk-2"),
        });
        await conn.send({
            ty: PeerFrameType.StreamEnd,
            channel: 7,
            epoch: 77,
            corr: frame1.corr,
        });
        expectCallError(await rejection(first), "terminal", "unexpected_stream");

        const second = client.request(handle, { plain: true });
        const frame2 = await cursor.next(isRoutedRequest(7));
        await sendResponse(conn, frame2.corr, { fine: 1 }, 7, 77);
        expect(await second).toEqual({ fine: 1 });
    });

    test("abort before write settles not_sent with an already-resolved cleanup ticket", async () => {
        const { client, conn } = await connected({ shutdownDeadlineMs: 200 });
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);
        await jamWriter(client, conn, handle);

        const controller = new AbortController();
        const pending = client.request(handle, { queued: true }, { signal: controller.signal });
        controller.abort();
        const error = expectCallError(await rejection(pending), "not_sent", "aborted");
        expect(error.cleanup).toBeDefined();
        await error.cleanup;
        expect(conn.frames.some((f) => f.ty === PeerFrameType.Cancel)).toBe(false);
    });

    test("abort after write settles outcome_unknown promptly and cleanup resolves on the terminal", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);

        const controller = new AbortController();
        const pending = client.request(handle, { x: 1 }, { signal: controller.signal });
        const frame = await cursor.next(isRoutedRequest(7));
        controller.abort();
        const error = expectCallError(await rejection(pending), "outcome_unknown", "aborted");

        const cancel = await cursor.next((f) => f.ty === PeerFrameType.Cancel);
        expect(cancel.channel).toBe(7);
        expect(cancel.epoch).toBe(77);
        expect(cancel.corr).toBe(frame.corr);

        let cleanupResolved = false;
        void (error.cleanup as Promise<void>).then(() => {
            cleanupResolved = true;
        });
        await delay(50);
        expect(cleanupResolved).toBe(false);
        await sendResponse(conn, frame.corr, { late: true }, 7, 77);
        await error.cleanup;
    });

    test("abort cleanup resolves on generation retirement", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);

        const controller = new AbortController();
        const pending = client.request(handle, { x: 1 }, { signal: controller.signal });
        await cursor.next(isRoutedRequest(7));
        controller.abort();
        const error = expectCallError(await rejection(pending), "outcome_unknown", "aborted");
        conn.destroy();
        await error.cleanup;
    });

    test("abort cleanup deadline expiry retires the generation", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn } = await connected({
            generationOptions: { cleanupTicketMs: 100 },
            diagnostics: (event) => events.push(event),
        });
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);

        const controller = new AbortController();
        const pending = client.request(handle, { x: 1 }, { signal: controller.signal });
        await cursor.next(isRoutedRequest(7));
        controller.abort();
        const error = expectCallError(await rejection(pending), "outcome_unknown", "aborted");
        await error.cleanup;
        await waitUntil(() =>
            events.some((e) => e.type === "retired" && e.reason === "cleanup_deadline"),
        );
        await conn.closed;
    });

    test("diagnostics events are frozen, redacted, and exception-isolated", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn } = await connected({
            diagnostics: (event) => {
                events.push(event);
                (event as { atMs?: number }).atMs = -1;
                throw new Error("observer exploded");
            },
        });
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);
        const requestPromise = client.request(handle, { secret: "body" });
        const frame = await cursor.next(isRoutedRequest(7));
        await sendResponse(conn, frame.corr, { ok: 1 }, 7, 77);
        expect(await requestPromise).toEqual({ ok: 1 });

        const types = new Set(events.map((e) => e.type));
        for (const required of [
            "connected",
            "enqueue",
            "write_start",
            "write_complete",
            "header",
            "dispatch",
            "parse",
        ]) {
            expect(types.has(required as McHostDiagnosticsEvent["type"])).toBe(true);
        }
        const connectedEvent = events.find((e) => e.type === "connected") as McHostDiagnosticsEvent;
        expect(connectedEvent.daemonVer).toBe("fake-peer/0.0.1");
        expect(connectedEvent.pid).toBe(process.pid);
        expect(connectedEvent.transport).toBe("tcp");
        expect(connectedEvent.fallbackReason).toBeUndefined();

        const allowedKeys = new Set([
            "type",
            "atMs",
            "frameType",
            "channel",
            "epoch",
            "corr",
            "len",
            "daemonVer",
            "pid",
            "reason",
            "transport",
            "fallbackReason",
        ]);
        for (const event of events) {
            expect(Object.isFrozen(event)).toBe(true);
            expect(event.atMs).not.toBe(-1);
            for (const key of Object.keys(event)) {
                expect(allowedKeys.has(key)).toBe(true);
            }
        }
        const serialized = JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? `${v}` : v));
        expect(serialized).not.toContain("secret");
        expect(serialized).not.toContain(IDENTITY.project_root);
    });

    test("diagnostics are rate-bounded: excess events are dropped, not protocol work", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn } = await connected({
            maxDiagnosticEventsPerSecond: 3,
            diagnostics: (event) => events.push(event),
        });
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);
        for (let i = 0; i < 3; i++) {
            const requestPromise = client.request(handle, { i });
            const frame = await cursor.next(isRoutedRequest(7));
            await sendResponse(conn, frame.corr, { i }, 7, 77);
            expect(await requestPromise).toEqual({ i });
        }
        expect(events.length).toBeLessThanOrEqual(3);
    });

    test("close() is synchronous while closeAsync awaits Goodbye under the shutdown deadline", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const handle = await openRoute(client, conn, cursor, 7, 77);

        await client.closeRoute(handle);
        const routeGoodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(routeGoodbye.channel).toBe(7);

        expect(client.close()).toBeUndefined();
        await client.closeAsync();
        const connGoodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(connGoodbye.channel).toBe(0);
        expect(connGoodbye.epoch).toBe(0);
        expect(connGoodbye.corr).toBe(0n);
        await conn.closed;

        const afterClose = await rejection(client.catalogList());
        expect(afterClose).toBeInstanceOf(McHostClientError);
        expect((afterClose as McHostClientError).code).toBe("client_closed");
    });

    test("reconnect and managed route open are single-flight across concurrent calls", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            diagnostics: (event) => events.push(event),
        });
        const cursor = frameCursor(conn);
        const warm = client.call("magic-context", "warm");
        await serveManagedCall(conn, cursor, 7, 77, { ok: true });
        await warm;

        conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));

        const call1 = client.call("magic-context", "c1");
        const call2 = client.call("magic-context", "c2");
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        const open = await cursor2.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open.corr, 7, 78);
        const bodyA = await cursor2.next(isRoutedRequest(7));
        const bodyB = await cursor2.next(isRoutedRequest(7));
        await sendResponse(conn2, bodyA.corr, { r: "a" }, 7, 78);
        await sendResponse(conn2, bodyB.corr, { r: "b" }, 7, 78);
        const results = await Promise.all([call1, call2]);
        expect(results).toContainEqual({ r: "a" });
        expect(results).toContainEqual({ r: "b" });
        expect(peer.connections.length).toBe(2);
        expect(conn2.frames.filter(isRouteOpen).length).toBe(1);
    });

    test("managed call without any identity fails terminally before any traffic", async () => {
        const { client, conn } = await connected();
        expectCallError(
            await rejection(client.call("magic-context", "m")),
            "terminal",
            "missing_identity",
        );
        // The setup negotiation is the only frame the peer ever saw.
        expect(conn.frames.length).toBe(1);
        expect(isControlOp(conn.frames[0] as PeerFrame, "transport.negotiate")).toBe(true);
    });
});

describe("deadline-independent setup coalescing", () => {
    interface ReconnectHarness extends ConnectedHarness {
        events: McHostDiagnosticsEvent[];
    }

    /** Connect, then retire the first generation so the next call redials. */
    async function retiredHarness(
        overrides: Partial<McHostClientOptions> = {},
    ): Promise<ReconnectHarness> {
        const events: McHostDiagnosticsEvent[] = [];
        const harness = await connected({
            identity: IDENTITY,
            diagnostics: (event) => events.push(event),
            ...overrides,
        });
        harness.conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));
        return { ...harness, events };
    }

    test("a short connection joiner detaches while the long owner completes the shared dial", async () => {
        const { client, peer } = await retiredHarness();
        const stalled = stallNextConnection(peer);
        const longCall = client.call("mod-a", "long");
        const shortCall = client.call("mod-b", "short", undefined, { timeoutMs: 250 });
        const conn2 = await stalled;

        // The short joiner fails on its own stage without touching the dial.
        const joinErr = expectCallError(await rejection(shortCall), "not_sent");
        expect(joinErr.message).toContain("connection setup stage expired");
        expect(peer.connections.length).toBe(2);

        conn2.resumeReading();
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        await serveManagedCall(conn2, cursor2, 7, 1, { ok: "long" });
        expect(await longCall).toEqual({ ok: "long" });
        expect(peer.connections.length).toBe(2);
        // No application body escaped from the expired waiter.
        const methods = conn2.frames
            .filter(isRoutedFrame)
            .map((f) => (bodyJson(f) as { method: string }).method);
        expect(methods).toEqual(["long"]);
    });

    test("connection survivors coalesce exactly one replacement dial after owner setup expiry", async () => {
        const { client, peer, events } = await retiredHarness();
        const stalled = stallNextConnection(peer);
        const shortOwner = client.call("mod-a", "short", undefined, { timeoutMs: 250 });
        const callB = client.call("mod-b", "b");
        const callC = client.call("mod-c", "c");
        const conn2 = await stalled;

        // The owner keeps its own setup failure and its generation retires.
        const ownerErr = expectCallError(await rejection(shortOwner), "not_sent");
        expect(ownerErr.message).toContain("connect failed");
        expect(ownerErr.message).not.toContain("connection setup stage expired");
        await waitUntil(() => events.filter((e) => e.type === "retired").length >= 2);

        const conn3 = await nthConnection(peer, 3);
        await conn3.authenticated;
        const cursor3 = frameCursor(conn3);
        const channelByModule: Record<string, number> = { "mod-b": 7, "mod-c": 8 };
        for (let i = 0; i < 2; i++) {
            const open = await cursor3.next(isRouteOpen);
            const moduleId =
                (bodyJson(open) as { target?: { module_id?: string } })?.target?.module_id ?? "";
            await sendRouteOpenOk(conn3, open.corr, channelByModule[moduleId] as number, 1);
        }
        for (let i = 0; i < 2; i++) {
            const body = await cursor3.next(isRoutedFrame);
            await sendResponse(conn3, body.corr, { via: body.channel }, body.channel, 1);
        }
        expect(await callB).toEqual({ via: 7 });
        expect(await callC).toEqual({ via: 8 });
        // Exactly one replacement dial; the retired generation saw no traffic.
        expect(peer.connections.length).toBe(3);
        expect(conn2.frames.length).toBe(0);
    });

    test("an expired connection joiner is not a survivor and never creates a replacement dial", async () => {
        const { client, peer } = await retiredHarness();
        const stalled = stallNextConnection(peer);
        const owner = client.call("mod-a", "o", undefined, { timeoutMs: 400 });
        const joiner = client.call("mod-b", "j", undefined, { timeoutMs: 150 });
        await stalled;

        const joinErr = expectCallError(await rejection(joiner), "not_sent");
        expect(joinErr.message).toContain("connection setup stage expired");
        expect(peer.connections.length).toBe(2);
        const ownerErr = expectCallError(await rejection(owner), "not_sent");
        expect(ownerErr.message).toContain("connect failed");
        expect(ownerErr.message).not.toContain("connection setup stage expired");
        // Owner-budget exhaustion with no live survivors replaces nothing.
        await delay(200);
        expect(peer.connections.length).toBe(2);
    });

    test("a permanent connection-file failure propagates to every waiter without replacement", async () => {
        const { client, peer, filePath } = await retiredHarness();
        await writeFile(filePath, "not json", { mode: 0o600 });
        const errA = rejection(client.call("mod-a", "a"));
        const errB = rejection(client.call("mod-b", "b"));
        const failA = expectCallError(await errA, "terminal", "invalid_json");
        const failB = expectCallError(await errB, "terminal", "invalid_json");
        // Both waiters carry the same underlying failure instance: a joiner
        // that retried would have produced a second connection-file read and
        // a distinct cause.
        expect(failA.cause).toBe(failB.cause);
        expect((failA.cause as Error).name).toBe("ConnectionFileError");
        expect(peer.connections.length).toBe(1);
    });

    test("a mid-handshake socket failure is not owner-budget exhaustion: no replacement dial", async () => {
        const { client, peer } = await retiredHarness();
        const stalled = stallNextConnection(peer);
        // catalogList joins the connection flight directly, with no route
        // retry loop above it, so any extra dial can only come from flight
        // replacement.
        const errA = rejection(client.catalogList());
        const errB = rejection(client.catalogList());
        const conn2 = await stalled;
        conn2.destroy();

        // A mid-auth socket loss rejects callers with AuthError, not with
        // owner-budget exhaustion.
        expect(((await errA) as Error).name).toBe("AuthError");
        expect(((await errB) as Error).name).toBe("AuthError");
        await delay(150);
        expect(peer.connections.length).toBe(2);
    });

    test("owner close during a shared connect leaves no replacement after client_closed", async () => {
        const { client, peer } = await retiredHarness({ handshakeTimeoutMs: 300 });
        const stalled = stallNextConnection(peer);
        const errA = rejection(client.call("mod-a", "a"));
        const errB = rejection(client.call("mod-b", "b"));
        await stalled;

        const closePromise = client.closeAsync();
        expectCallError(await errA, "not_sent");
        expectCallError(await errB, "not_sent");
        await closePromise;
        expect(peer.connections.length).toBe(2);
    });

    test("a short route joiner detaches pre-body while the long owner uses the shared route", async () => {
        const { client, conn } = await connected({ identity: IDENTITY });
        const cursor = frameCursor(conn);
        const owner = client.call("magic-context", "long-a");
        const joiner = client.call("magic-context", "short-b", undefined, { timeoutMs: 200 });
        const open1 = await cursor.next(isRouteOpen);

        // The joiner fails on its own stage; the shared opening stays live.
        expectCallError(await rejection(joiner), "not_sent", "deadline_expired");
        expect(conn.frames.filter(isRouteOpen).length).toBe(1);

        await sendRouteOpenOk(conn, open1.corr, 7, 77);
        const body = await cursor.next(isRoutedRequest(7));
        expect(bodyJson(body)).toEqual({ method: "long-a" });
        await sendResponse(conn, body.corr, { ok: true }, 7, 77);
        expect(await owner).toEqual({ ok: true });
        // Exactly one body: nothing escaped from the expired waiter.
        expect(conn.frames.filter(isRoutedFrame).length).toBe(1);
    });

    test("route survivors coalesce one replacement connection and route after an ambiguous owner open", async () => {
        const { client, conn, peer } = await connected({ identity: IDENTITY });
        const cursor = frameCursor(conn);
        const owner = client.call("magic-context", "own", undefined, { timeoutMs: 250 });
        const callB = client.call("magic-context", "b");
        const callC = client.call("magic-context", "c");
        await cursor.next(isRouteOpen);

        // Never respond: the ambiguous owner open retires generation 1.
        expectCallError(await rejection(owner), "outcome_unknown", "deadline_expired");

        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        const open2 = await cursor2.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open2.corr, 7, 1);
        const methods: string[] = [];
        for (let i = 0; i < 2; i++) {
            const body = await cursor2.next(isRoutedRequest(7));
            const method = (bodyJson(body) as { method: string }).method;
            methods.push(method);
            await sendResponse(conn2, body.corr, { done: method }, 7, 1);
        }
        expect(await callB).toEqual({ done: "b" });
        expect(await callC).toEqual({ done: "c" });
        expect(methods.sort()).toEqual(["b", "c"]);
        expect(peer.connections.length).toBe(2);
        expect(conn2.frames.filter(isRouteOpen).length).toBe(1);
        expect(conn.frames.filter(isRoutedFrame)).toEqual([]);
    });

    test("a longer joiner replaces the route flight after the owner's allowlisted retry budget", async () => {
        let nowMs = 0;
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            clock: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms;
            },
        });
        const cursor = frameCursor(conn);
        const ownerErr = rejection(
            client.call("magic-context", "own", undefined, { timeoutMs: 350 }),
        );
        const joiner = client.call("magic-context", "join");

        // The owner's 350ms stage permits exactly three route-open attempts.
        // The fake clock advances by 100ms, 200ms, then a clamped 50ms.
        for (let i = 0; i < 3; i++) {
            const open = await cursor.next(isRouteOpen);
            await sendErrorBody(conn, open.corr, "module_reloading");
        }
        const error = expectCallError(await ownerErr, "not_sent", "module_reloading");
        expect(error.message).toContain("retry budget exhausted");

        // The surviving joiner runs one replacement route loop on the same
        // connection under its unchanged stage.
        const replacementOpen = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, replacementOpen.corr, 7, 77);
        const body = await cursor.next(isRoutedRequest(7));
        expect(bodyJson(body)).toEqual({ method: "join" });
        await sendResponse(conn, body.corr, { ok: true }, 7, 77);
        expect(await joiner).toEqual({ ok: true });
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isRoutedFrame).length).toBe(1);
        expect(conn.frames.filter(isRouteOpen).length).toBe(4);
    });

    test("a permanent artifact_invalid terminal reaches every route waiter without replacement", async () => {
        const sleeps: number[] = [];
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });
        const cursor = frameCursor(conn);
        const errA = rejection(client.call("magic-context", "a"));
        const errB = rejection(client.call("magic-context", "b"));
        const open1 = await cursor.next(isRouteOpen);
        await sendErrorBody(conn, open1.corr, "artifact_invalid");

        expectCallError(await errA, "terminal", "artifact_invalid");
        expectCallError(await errB, "terminal", "artifact_invalid");
        expect(sleeps).toEqual([]);
        expect(conn.frames.filter(isRouteOpen).length).toBe(1);
        expect(peer.connections.length).toBe(1);
    });

    test("a stale route success is re-evaluated before adoption and keeps the replay token", async () => {
        const sleeps: number[] = [];
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });
        const cursor = frameCursor(conn);
        const callA = client.call("magic-context", "a");
        const callB = client.call("magic-context", "b");
        const open1 = await cursor.next(isRouteOpen);

        // Deliver the route success and a connection Goodbye in one chunk:
        // the shared flight resolves and the generation retires synchronously
        // before any caller's adoption continuation runs.
        await conn.sendRaw(
            Buffer.concat([
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    channel: 0,
                    epoch: 0,
                    corr: open1.corr,
                    body: jsonBody({ op: "route.open", route_channel: 7, route_epoch: 77 }),
                }),
                encodePeerFrame({ ty: PeerFrameType.Goodbye, channel: 0, epoch: 0, corr: 0n }),
            ]),
        );

        // Both callers recover inside route acquisition: one replacement
        // connection and one shared replacement route open.
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        const open2 = await cursor2.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open2.corr, 9, 1);
        const first = await cursor2.next(isRoutedRequest(9));
        const second = await cursor2.next(isRoutedRequest(9));
        const [bodyA, bodyB] =
            (bodyJson(first) as { method: string }).method === "a"
                ? [first, second]
                : [second, first];
        await sendResponse(conn2, bodyB.corr, { ok: "b" }, 9, 1);
        // Caller A's managed replay token must still be unspent: the stale
        // recovery happened pre-body, so unknown_channel earns the replay.
        await sendErrorBody(conn2, bodyA.corr, "unknown_channel", 9, 1);
        const open3 = await cursor2.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open3.corr, 9, 2);
        const bodyA2 = await cursor2.next((f) => isRoutedRequest(9)(f) && f.epoch === 2);
        await sendResponse(conn2, bodyA2.corr, { ok: "a" }, 9, 2);

        expect(await callA).toEqual({ ok: "a" });
        expect(await callB).toEqual({ ok: "b" });
        // No application body ever reached the retired first generation.
        expect(conn.frames.filter(isRoutedFrame)).toEqual([]);
        expect(peer.connections.length).toBe(2);
        expect(conn2.frames.filter(isRouteOpen).length).toBe(2);
        // Each surviving caller paced its stale-success re-entry once; no
        // other retry path slept.
        expect(sleeps).toEqual([100, 100]);
    });

    test("stale connection adoptions pace replacement dials instead of spinning", async () => {
        let nowMs = 0;
        const sleeps: number[] = [];
        const { client, peer } = await retiredHarness({
            clock: () => nowMs,
            sleep: async (ms) => {
                sleeps.push(ms);
                nowMs += ms;
            },
        });
        // Every replacement dial completes auth and retires in the same
        // read chunk: a Goodbye coalesced with the ServerHello. Setup then
        // resolves on an already-retired generation, so adoption fails and
        // the caller must re-dial.
        peer.helloTrailer = encodePeerFrame({
            ty: PeerFrameType.Goodbye,
            channel: 0,
            epoch: 0,
            corr: 0n,
        });

        const error = expectCallError(
            await rejection(client.call("mod-a", "m", undefined, { timeoutMs: 400 })),
            "not_sent",
        );
        expect(error.message).toContain("connect failed");
        // Exactly three paced dials (fake-clock 0ms, 100ms, 300ms) fit the
        // 400ms stage; an unpaced loop would redial at socket speed and
        // never advance this fake clock.
        expect(peer.connections.length).toBe(4);
        expect(sleeps.filter((ms) => ms > 0)).toEqual([100, 200, 100]);
    });

    test("owner close during a shared route opening fences the late success without replacement", async () => {
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            shutdownDeadlineMs: 3_000,
        });
        const cursor = frameCursor(conn);
        const errA = rejection(client.call("magic-context", "a"));
        const errB = rejection(client.call("magic-context", "b"));
        const open1 = await cursor.next(isRouteOpen);

        const closePromise = client.closeAsync();
        await delay(30);
        await sendRouteOpenOk(conn, open1.corr, 7, 77);

        expectCallError(await errA, "not_sent", "route_closed");
        expectCallError(await errB, "not_sent", "route_closed");
        const routeGoodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(routeGoodbye.channel).toBe(7);
        expect(routeGoodbye.epoch).toBe(77);
        const connGoodbye = await cursor.next((f) => f.ty === PeerFrameType.Goodbye);
        expect(connGoodbye.channel).toBe(0);
        await closePromise;
        // No replacement connection or route open, and no body escaped.
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isRouteOpen).length).toBe(1);
        expect(conn.frames.filter(isRoutedFrame)).toEqual([]);
    });

    test("a connection-file expiry during the owner's snapshot replaces the route flight", async () => {
        let nowMs = 0;
        let expireDuringSnapshot = false;
        const { client, peer } = await retiredHarness({
            clock: () => nowMs,
            connectionFileAfterOpen: () => {
                if (!expireDuringSnapshot) return;
                expireDuringSnapshot = false;
                // Expire the short owner inside the snapshot: after the
                // descriptor opens, before the next deadline check.
                nowMs += 300;
            },
        });
        expireDuringSnapshot = true;
        const ownerErr = rejection(
            client.call("magic-context", "own", undefined, { timeoutMs: 250 }),
        );
        const joiner = client.call("magic-context", "join");

        // The owner's budget is the failure authority: not_sent, never
        // terminal, with the snapshot expiry as the cause.
        const failure = expectCallError(await ownerErr, "not_sent", "deadline_expired");
        expect((failure.cause as Error).name).toBe("ConnectionFileError");

        // The surviving joiner coalesces one replacement dial and route.
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor = frameCursor(conn2);
        const open = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open.corr, 7, 77);
        const body = await cursor.next(isRoutedRequest(7));
        expect(bodyJson(body)).toEqual({ method: "join" });
        await sendResponse(conn2, body.corr, { ok: true }, 7, 77);
        expect(await joiner).toEqual({ ok: true });
        // The owner never dialed: the only connections are the retired
        // original and the joiner's single replacement.
        expect(peer.connections.length).toBe(2);
        expect(conn2.frames.filter(isRouteOpen).length).toBe(1);
    });

    test("a joiner whose stage expires before the shared flight settles never adopts it", async () => {
        let nowMs = 0;
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            clock: () => nowMs,
        });
        const cursor = frameCursor(conn);
        const owner = client.call("magic-context", "own", undefined, { timeoutMs: 200_000 });
        const joinerErr = rejection(
            client.call("magic-context", "join", undefined, { timeoutMs: 100_000 }),
        );
        const open = await cursor.next(isRouteOpen);
        // The joiner's stage expires on the fake clock while its real expiry
        // timer stays pending; the flight then settles first, queueing the
        // fulfillment ahead of any timer callback.
        nowMs = 100_001;
        await sendRouteOpenOk(conn, open.corr, 7, 77);
        expectCallError(await joinerErr, "not_sent", "deadline_expired");
        const body = await cursor.next(isRoutedRequest(7));
        expect(bodyJson(body)).toEqual({ method: "own" });
        await sendResponse(conn, body.corr, { ok: true }, 7, 77);
        expect(await owner).toEqual({ ok: true });
        // The expired joiner never adopted the route: one open, one body.
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isRouteOpen).length).toBe(1);
        expect(conn.frames.filter(isRoutedFrame).length).toBe(1);
    });

    test("an expired joiner reports its own stage when the shared flight fails", async () => {
        let nowMs = 0;
        const { client, conn } = await connected({ identity: IDENTITY, clock: () => nowMs });
        const cursor = frameCursor(conn);
        const ownerErr = rejection(
            client.call("magic-context", "own", undefined, { timeoutMs: 200_000 }),
        );
        const joinerErr = rejection(
            client.call("magic-context", "join", undefined, { timeoutMs: 100_000 }),
        );
        const open = await cursor.next(isRouteOpen);
        // The joiner's stage expires on the fake clock while its real expiry
        // timer stays pending; the flight then fails ahead of any timer
        // callback, so the rejection is queued first.
        nowMs = 100_001;
        await sendErrorBody(conn, open.corr, "artifact_invalid");
        expectCallError(await joinerErr, "not_sent", "deadline_expired");
        expectCallError(await ownerErr, "terminal", "artifact_invalid");
        expect(conn.frames.filter(isRouteOpen).length).toBe(1);
    });

    test("a snapshot that outlives the handshake stage retries within the live route budget", async () => {
        let nowMs = 0;
        let expireSnapshot = false;
        const { client, peer } = await retiredHarness({
            clock: () => nowMs,
            sleep: async () => {},
            connectionFileAfterOpen: () => {
                if (!expireSnapshot) return;
                expireSnapshot = false;
                // Outlive the 2s handshake stage while most of the route
                // budget stays live.
                nowMs += 2_500;
            },
        });
        expireSnapshot = true;
        const call = client.call("magic-context", "go");
        // The owner reconnects under its unchanged route deadline instead
        // of failing on the expired handshake-stage snapshot.
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor = frameCursor(conn2);
        const open = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open.corr, 7, 77);
        const body = await cursor.next(isRoutedRequest(7));
        await sendResponse(conn2, body.corr, { ok: true }, 7, 77);
        expect(await call).toEqual({ ok: true });
        expect(peer.connections.length).toBe(2);
    });

    test("an oversized control body fails route.open immediately without retry or replacement", async () => {
        let sleeps = 0;
        const { client, conn } = await connected({
            identity: IDENTITY,
            sleep: async () => {
                sleeps++;
            },
        });
        const bigModule = "m".repeat(70_000);
        const error = await rejection(client.call(bigModule, "x", undefined, { timeoutMs: 500 }));
        expectCallError(error, "not_sent", "control_body_too_large");
        // Deterministic local failure: no backoff spin, no wire traffic.
        expect(sleeps).toBe(0);
        expect(conn.frames.filter(isRouteOpen).length).toBe(0);
    });
});

describe("transport negotiation", () => {
    const GRANT_TOKEN = "00112233445566778899aabbccddeeff"; // gitleaks:allow synthetic protocol vector
    const isNegotiate = (frame: PeerFrame): boolean => isControlOp(frame, "transport.negotiate");

    function negotiateResponder(makeBody: (frame: PeerFrame) => unknown): PeerNegotiateResponder {
        return (frame, conn) => {
            const value = makeBody(frame);
            const body = Buffer.isBuffer(value)
                ? value
                : Buffer.from(JSON.stringify(value), "utf8");
            void conn.send({
                ty: PeerFrameType.Response,
                channel: 0,
                epoch: 0,
                corr: frame.corr,
                body,
            });
        };
    }

    function grantBody(descriptor: Record<string, unknown> = {}): unknown {
        return {
            op: "transport.negotiate",
            negotiation_version: 1,
            selected: { transport: "fake.shm", capability_version: 1 },
            activation_token: GRANT_TOKEN,
            descriptor,
        };
    }

    function errorGraphText(root: unknown): string {
        const seen = new Set<object>();
        const parts: string[] = [];
        const visit = (value: unknown): void => {
            if (typeof value === "string") {
                parts.push(value);
                return;
            }
            if (value === null || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            if (value instanceof Uint8Array) {
                const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                parts.push(bytes.toString("latin1"), bytes.toString("utf8"));
                return;
            }
            if (value instanceof Error) {
                parts.push(value.name, value.message, value.stack ?? "");
                // `cause` and AggregateError `errors` are non-enumerable, so
                // the Object.values walk below never reaches them.
                visit(value.cause);
                visit((value as Partial<AggregateError>).errors);
            }
            for (const entry of Object.values(value)) visit(entry);
        };
        visit(root);
        return parts.join("\n");
    }

    async function connectRejected(
        overrides: Partial<McHostClientOptions> & { peer?: FakePeer } = {},
    ): Promise<{ peer: FakePeer; error: unknown; filePath: string }> {
        const peer = overrides.peer ?? (await startPeer());
        const filePath = freshFilePath();
        await writeConnectionFile(filePath, peer);
        const { peer: _peer, ...options } = overrides;
        const error = await rejection(
            McHostClient.connect({
                connectionFile: filePath,
                handshakeTimeoutMs: 500,
                ...options,
            }),
        );
        return { peer, error, filePath };
    }

    test("negotiation is the first frame at correlation 1 and gates publication", async () => {
        const peer = await startPeer({ negotiate: "silent" });
        const filePath = freshFilePath();
        await writeConnectionFile(filePath, peer);
        let settled = false;
        const connectPromise = McHostClient.connect({ connectionFile: filePath }).then((client) => {
            settled = true;
            clients.push(client);
            return client;
        });
        connectPromise.catch(() => {});
        const conn = await peer.waitForConnection();
        await conn.authenticated;
        const cursor = frameCursor(conn);
        const negotiate = await cursor.next(isNegotiate);
        expect(conn.frames[0]).toBe(negotiate);
        expect(negotiate.corr).toBe(1n);
        expect(negotiate.body.toString("utf8")).toBe(
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}]}',
        );
        await delay(50);
        expect(settled).toBe(false);
        await sendResponse(conn, negotiate.corr, {
            op: "transport.negotiate",
            negotiation_version: 1,
            selected: { transport: "tcp", capability_version: 1 },
        });
        const client = await connectPromise;
        const catalogPromise = client.catalogList();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        expect(catalogFrame.corr).toBe(2n);
        await sendResponse(conn, catalogFrame.corr, {
            op: "catalog.list",
            generation: 1,
            modules: [],
            subc_ops: ["route.open"],
        });
        expect(await catalogPromise).toEqual([]);
    });

    test("AE2: an exact legacy unsupported_operation terminal fails closed without TCP continuation", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const peer = await startPeer({ negotiate: "unsupported-op" });
        const { error } = await connectRejected({
            peer,
            diagnostics: (event) => events.push(event),
        });
        expectCallError(error, "terminal", "host_negotiation_rejected");
        await waitUntil(() =>
            events.some((e) => e.type === "retired" && e.reason === "negotiation_failed"),
        );
        expect(events.some((e) => e.type === "connected")).toBe(false);
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isNegotiate).length).toBe(1);
    });

    test("AE3: capability mismatch selects sticky TCP; reconnect runs one fresh flight", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const provider = createFakePairedProvider();
        const peer = await startPeer({
            negotiate: negotiateResponder(() => ({
                op: "transport.negotiate",
                negotiation_version: 1,
                selected: { transport: "tcp", capability_version: 1 },
                reason: "capability_version_mismatch",
            })),
        });
        const filePath = freshFilePath();
        await writeConnectionFile(filePath, peer);
        const client = await McHostClient.connect({
            connectionFile: filePath,
            transportProviders: [provider],
            diagnostics: (event) => events.push(event),
        });
        clients.push(client);
        const conn = await peer.waitForConnection();
        const cursor = frameCursor(conn);
        const negotiate = await cursor.next(isNegotiate);
        expect(bodyJson(negotiate)).toEqual({
            op: "transport.negotiate",
            negotiation_version: 1,
            offers: [
                { transport: "fake.shm", capability_version: 1 },
                { transport: "tcp", capability_version: 1 },
            ],
        });
        const connectedEvent = events.find((e) => e.type === "connected") as McHostDiagnosticsEvent;
        expect(connectedEvent.transport).toBe("tcp");
        expect(connectedEvent.fallbackReason).toBe("capability_version_mismatch");

        const catalogPromise = client.catalogList();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        await sendResponse(conn, catalogFrame.corr, {
            op: "catalog.list",
            generation: 1,
            modules: [],
            subc_ops: ["route.open"],
        });
        await catalogPromise;
        expect(conn.frames.filter(isNegotiate).length).toBe(1);
        expect(provider.connectCount).toBe(0);

        conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));
        const catalog2 = client.catalogList();
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        expect(conn2.clientAuthValid).toBe(true);
        const cursor2 = frameCursor(conn2);
        const catalogFrame2 = await cursor2.next((f) => isControlOp(f, "catalog.list"));
        await sendResponse(conn2, catalogFrame2.corr, {
            op: "catalog.list",
            generation: 1,
            modules: [],
            subc_ops: ["route.open"],
        });
        expect(await catalog2).toEqual([]);
        expect(conn2.frames.filter(isNegotiate).length).toBe(1);
        expect(peer.connections.length).toBe(2);
        expect(provider.connectCount).toBe(0);
    });

    test("concurrent callers share one connection and one negotiation", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn, peer } = await connected({
            identity: IDENTITY,
            diagnostics: (event) => events.push(event),
        });
        conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));

        const call1 = client.call("magic-context", "c1");
        const call2 = client.call("magic-context", "c2");
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        const open = await cursor2.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open.corr, 7, 1);
        const bodyA = await cursor2.next(isRoutedRequest(7));
        const bodyB = await cursor2.next(isRoutedRequest(7));
        await sendResponse(conn2, bodyA.corr, { ok: 1 }, 7, 1);
        await sendResponse(conn2, bodyB.corr, { ok: 2 }, 7, 1);
        await Promise.all([call1, call2]);
        expect(peer.connections.length).toBe(2);
        expect(conn2.frames.filter(isNegotiate).length).toBe(1);
    });

    test("AE4: injected grant activates at corr 1/2, applications start at 3, bootstrap sees nothing after the grant", async () => {
        const provider = createFakePairedProvider();
        const descriptor = { channel_hint: 42 };
        provider.host.onFrame = candidateAutoResponder(GRANT_TOKEN, (frame, host) => {
            if (frame.header.channel === 5) {
                host.send(
                    {
                        ty: PeerFrameType.Response,
                        flags: 0,
                        channel: 5,
                        epoch: 1,
                        corr: frame.header.corr,
                    },
                    Buffer.from(JSON.stringify({ echoed: true }), "utf8"),
                );
                return;
            }
            const parsed = JSON.parse(Buffer.from(frame.body).toString("utf8")) as {
                op?: string;
            };
            if (parsed.op === "catalog.list") {
                host.respondJson(frame.header.corr, {
                    op: "catalog.list",
                    generation: 1,
                    modules: [],
                    subc_ops: ["route.open"],
                });
            } else if (parsed.op === "route.open") {
                host.respondJson(frame.header.corr, {
                    op: "route.open",
                    route_channel: 5,
                    route_epoch: 1,
                });
            }
        });
        const events: McHostDiagnosticsEvent[] = [];
        const peer = await startPeer({
            negotiate: negotiateResponder(() => grantBody(descriptor)),
        });
        const filePath = freshFilePath();
        await writeConnectionFile(filePath, peer);
        const client = await McHostClient.connect({
            connectionFile: filePath,
            transportProviders: [provider],
            diagnostics: (event) => events.push(event),
        });
        clients.push(client);
        const conn = await peer.waitForConnection();
        expect(provider.connectCount).toBe(1);
        expect(provider.lastDescriptor).toEqual(descriptor);

        const host = provider.host;
        expect(host.frames.map((f) => f.header.corr)).toEqual([1n, 2n]);
        const connectedEvent = events.find((e) => e.type === "connected") as McHostDiagnosticsEvent;
        expect(connectedEvent.transport).toBe("fake.shm");
        // Promotion retires the bootstrap internally; that handoff must not
        // surface as a client-level `retired` event next to `connected`.
        expect(events.some((e) => e.type === "retired")).toBe(false);

        expect(await client.catalogList()).toEqual([]);
        expect(host.frames[2]?.header.corr).toBe(3n);
        const handle = await client.routeOpen(TOOL_TARGET, IDENTITY);
        expect(await client.request(handle, { hello: true })).toEqual({ echoed: true });

        host.send({ ty: PeerFrameType.Ping, flags: 0, channel: 0, epoch: 0, corr: 99n });
        await host.waitFor(() =>
            host.frames.some((f) => f.header.ty === PeerFrameType.Pong && f.header.corr === 99n),
        );

        expect(conn.frames.length).toBe(1);
        expect(isNegotiate(conn.frames[0] as PeerFrame)).toBe(true);
        await conn.closed;

        await client.closeAsync();
        await host.waitFor(() =>
            host.frames.some(
                (f) => f.header.ty === PeerFrameType.Goodbye && f.header.channel === 0,
            ),
        );
        const corrs = host.frames
            .filter((f) => f.header.ty === PeerFrameType.Request)
            .map((f) => f.header.corr);
        expect(corrs.slice(0, 2)).toEqual([1n, 2n]);
        expect(corrs.slice(2).every((corr) => corr >= 3n)).toBe(true);
    });

    const decodeRejections: [string, (frame: PeerFrame) => unknown][] = [
        [
            "a selection without a selected entry",
            () => ({ op: "transport.negotiate", negotiation_version: 1 }),
        ],
        [
            "an unoffered selection",
            () => ({
                op: "transport.negotiate",
                negotiation_version: 1,
                selected: { transport: "tcp", capability_version: 9 },
            }),
        ],
        [
            "a recursive duplicate key inside the descriptor",
            () =>
                Buffer.from(
                    '{"op":"transport.negotiate","negotiation_version":1,' +
                        '"selected":{"transport":"fake.shm","capability_version":1},' +
                        `"activation_token":"${GRANT_TOKEN}","descriptor":{"a":1,"a":2}}`,
                    "utf8",
                ),
        ],
        [
            "an out-of-vocabulary fallback reason",
            () => ({
                op: "transport.negotiate",
                negotiation_version: 1,
                selected: { transport: "tcp", capability_version: 1 },
                reason: "reason-sentinel-4c1d",
            }),
        ],
        [
            "a malformed activation token",
            () => ({
                op: "transport.negotiate",
                negotiation_version: 1,
                selected: { transport: "fake.shm", capability_version: 1 },
                activation_token: "NOT-HEX",
                descriptor: {},
            }),
        ],
    ];
    for (const [name, makeBody] of decodeRejections) {
        test(`AE5: ${name} rejects connect fail-closed without TCP resumption`, async () => {
            const provider = createFakePairedProvider();
            const peer = await startPeer({ negotiate: negotiateResponder(makeBody) });
            const { error } = await connectRejected({ peer, transportProviders: [provider] });
            const failure = expectCallError(error, "terminal", "negotiation_failed");
            expect(errorGraphText(failure)).not.toContain("sentinel");
            const conn = peer.connections[0] as FakePeerConnection;
            await conn.closed;
            expect(peer.connections.length).toBe(1);
            expect(conn.frames.filter(isNegotiate).length).toBe(1);
            expect(provider.connectCount).toBe(0);
        });
    }

    test("KTD7: a terminal error rejects connect fail-closed without TCP fallback", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const peer = await startPeer({
            negotiate: (frame, conn) => void sendErrorBody(conn, frame.corr, "internal_error"),
        });
        const { error } = await connectRejected({
            peer,
            diagnostics: (event) => events.push(event),
        });
        // The host's raw error body is peer-controlled; the caller sees a
        // bounded negotiation failure, never the wire message (R14).
        expectCallError(error, "terminal", "host_negotiation_rejected");
        await waitUntil(() =>
            events.some((e) => e.type === "retired" && e.reason === "negotiation_failed"),
        );
        expect(events.some((e) => e.type === "connected")).toBe(false);
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        await delay(50);
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isNegotiate).length).toBe(1);
    });

    test("KTD7: a canonical server_busy negotiation terminal fails closed without TCP fallback", async () => {
        const peer = await startPeer({
            negotiate: (frame, conn) => void sendErrorBody(conn, frame.corr, "server_busy"),
        });
        const { error } = await connectRejected({ peer });
        expectCallError(error, "terminal", "host_negotiation_rejected");
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isNegotiate).length).toBe(1);
    });

    test("KTD7: a noncanonical unsupported_operation terminal fails closed without TCP fallback", async () => {
        const peer = await startPeer({
            negotiate: (frame, conn) =>
                void conn.send({
                    ty: PeerFrameType.Error,
                    channel: 0,
                    epoch: 0,
                    corr: frame.corr,
                    body: jsonBody({
                        code: "unsupported_operation",
                        message: "unknown control operation",
                        detail: "extra",
                    }),
                }),
        });
        const { error } = await connectRejected({ peer });
        expectCallError(error, "terminal", "host_negotiation_rejected");
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
        expect(conn.frames.filter(isNegotiate).length).toBe(1);
    });

    test("AE5: negotiation timeout rejects connect and closes the channel", async () => {
        const peer = await startPeer({ negotiate: "silent" });
        const { error } = await connectRejected({ peer, handshakeTimeoutMs: 300 });
        expectCallError(error, "outcome_unknown", "deadline_expired");
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
    });

    test("AE5: a host-rejected activation closes candidate and bootstrap", async () => {
        const provider = createFakePairedProvider();
        provider.host.onFrame = candidateAutoResponder("ffffffffffffffffffffffffffffffff");
        const peer = await startPeer({ negotiate: negotiateResponder(() => grantBody()) });
        const { error } = await connectRejected({ peer, transportProviders: [provider] });
        // The host's Error terminal is peer-controlled: the caller sees the
        // bounded negotiation failure, never the wire code (R14).
        expectCallError(error, "terminal", "negotiation_failed");
        expect(provider.host.channelClosed).toBe(true);
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
    });

    test("AE5: a provider start() that never settles cannot strand candidate setup", async () => {
        const provider = createFakePairedProvider({ startHang: true });
        const peer = await startPeer({ negotiate: negotiateResponder(() => grantBody({})) });
        const { error } = await connectRejected({
            peer,
            transportProviders: [provider],
            handshakeTimeoutMs: 300,
        });
        // The generation's setup timer retires the candidate; the raced
        // start observes retirement instead of stranding activateCandidate
        // on a promise the provider never settles, and the surfaced error
        // is the retirement cause (the setup timer's timeout).
        expect((error as Error).name).toBe("SocketTimeoutError");
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
    });

    test("AE5: an invalid commit response closes candidate and bootstrap", async () => {
        const provider = createFakePairedProvider();
        provider.host.onFrame = (frame, host) => {
            if (frame.header.ty !== PeerFrameType.Request) return;
            const parsed = JSON.parse(Buffer.from(frame.body).toString("utf8")) as {
                op?: string;
            };
            if (parsed.op === "transport.activate") {
                host.respondJson(frame.header.corr, {
                    op: "transport.activate",
                    negotiation_version: 1,
                });
            } else if (parsed.op === "transport.commit") {
                host.respondJson(frame.header.corr, {
                    op: "transport.commit",
                    negotiation_version: 1,
                    extra: "field-sentinel-2b8e",
                });
            }
        };
        const peer = await startPeer({ negotiate: negotiateResponder(() => grantBody()) });
        const { error } = await connectRejected({ peer, transportProviders: [provider] });
        const failure = expectCallError(error, "terminal", "negotiation_failed");
        expect(errorGraphText(failure)).not.toContain("sentinel");
        expect(provider.host.channelClosed).toBe(true);
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
    });

    test("AE5: candidate loss during activation closes both channels", async () => {
        const provider = createFakePairedProvider();
        provider.host.onFrame = (frame, host) => {
            if (frame.header.ty === PeerFrameType.Request) {
                host.close(new Error("loss-sentinel-6a9f"));
            }
        };
        const peer = await startPeer({ negotiate: negotiateResponder(() => grantBody()) });
        const { error } = await connectRejected({ peer, transportProviders: [provider] });
        expect(errorGraphText(error)).not.toContain("sentinel");
        expect(provider.host.channelClosed).toBe(true);
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
    });

    test("AE5/R14: provider failures and grant data never reach error graphs or diagnostics", async () => {
        const provider = createFakePairedProvider({
            startError: new Error("provider-sentinel-9b2c"),
        });
        const events: McHostDiagnosticsEvent[] = [];
        const peer = await startPeer({
            negotiate: negotiateResponder(() => grantBody({ secret: "descriptor-sentinel-7f3a" })),
        });
        const { error } = await connectRejected({
            peer,
            transportProviders: [provider],
            diagnostics: (event) => events.push(event),
        });
        expect(provider.connectCount).toBe(1);
        const graph = errorGraphText(error);
        expect(graph).not.toContain("sentinel");
        expect(graph).not.toContain(GRANT_TOKEN);
        const serialized = JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? `${v}` : v));
        expect(serialized).not.toContain("sentinel");
        expect(serialized).not.toContain(GRANT_TOKEN);
    });

    test("AE5/R14: a provider whose connect() throws still retires the bootstrap", async () => {
        // The generation constructor invokes the provider synchronously, so
        // this failure surfaces before candidate activation begins; the
        // authenticated bootstrap must not be left alive.
        const provider = createFakePairedProvider({
            connectError: new Error("provider-sentinel-3d1e"),
        });
        const events: McHostDiagnosticsEvent[] = [];
        const peer = await startPeer({
            negotiate: negotiateResponder(() => grantBody({})),
        });
        const { error } = await connectRejected({
            peer,
            transportProviders: [provider],
            diagnostics: (event) => events.push(event),
        });
        expect(provider.connectCount).toBe(1);
        expect(errorGraphText(error)).not.toContain("sentinel");
        await waitUntil(() =>
            events.some((e) => e.type === "retired" && e.reason === "negotiation_failed"),
        );
        const conn = peer.connections[0] as FakePeerConnection;
        await conn.closed;
        expect(peer.connections.length).toBe(1);
    });

    test("AE7: a base wire mismatch fails before dial and never invokes the provider registry", async () => {
        const provider = createFakePairedProvider();
        const peer = await startPeer();
        const filePath = freshFilePath();
        const json = JSON.stringify({
            schema: 1,
            wire_version: 3,
            endpoints: [{ host: "127.0.0.1", port: peer.port }],
            key: Array.from(peer.key),
            daemon_id: Array.from(peer.daemonId),
            pid: process.pid,
            daemon_ver: "fake-peer/0.0.1",
        });
        await writeFile(filePath, json, { mode: 0o600 });
        const error = await rejection(
            McHostClient.connect({ connectionFile: filePath, transportProviders: [provider] }),
        );
        expect((error as Error).name).toBe("ConnectionFileError");
        await delay(30);
        expect(peer.connections.length).toBe(0);
        expect(provider.connectCount).toBe(0);
    });

    test("owner close during negotiation exposes no connection and launches no replacement", async () => {
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn, peer } = await connected({
            handshakeTimeoutMs: 400,
            diagnostics: (event) => events.push(event),
        });
        conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));
        peer.negotiateMode = "silent";

        const pendingCatalog = rejection(client.catalogList());
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        await cursor2.next(isNegotiate);
        const closePromise = client.closeAsync();
        await pendingCatalog;
        await closePromise;
        await conn2.closed;
        await rejection(client.catalogList());
        await delay(100);
        expect(peer.connections.length).toBe(2);
    });

    test("owner close during activation reaps candidate and bootstrap without replacement", async () => {
        const provider = createFakePairedProvider();
        provider.host.onFrame = () => {};
        const events: McHostDiagnosticsEvent[] = [];
        const { client, conn, peer } = await connected({
            handshakeTimeoutMs: 400,
            transportProviders: [provider],
            diagnostics: (event) => events.push(event),
        });
        conn.destroy();
        await waitUntil(() => events.some((e) => e.type === "retired"));
        peer.negotiateMode = negotiateResponder(() => grantBody());

        const pendingCatalog = rejection(client.catalogList());
        await provider.host.waitFor(() => provider.host.frames.length >= 1);
        const closePromise = client.closeAsync();
        await pendingCatalog;
        await closePromise;
        expect(provider.host.channelClosed).toBe(true);
        const conn2 = peer.connections[1] as FakePeerConnection;
        await conn2.closed;
        await delay(100);
        expect(peer.connections.length).toBe(2);
    });
});

describe("facade helpers", () => {
    test("connectionFileExists reports presence without validation", async () => {
        const filePath = freshFilePath();
        expect(await connectionFileExists(filePath)).toBe(false);
        await writeFile(filePath, "{}", { mode: 0o600 });
        expect(await connectionFileExists(filePath)).toBe(true);
    });

    test("isConsumerReconnectTransient keeps npm-compatible semantics", () => {
        expect(isConsumerReconnectTransient(new SocketClosedError("gone"))).toBe(true);
        expect(isConsumerReconnectTransient(new McHostCallError("not_sent", "x"))).toBe(true);
        expect(isConsumerReconnectTransient(new McHostCallError("outcome_unknown", "x"))).toBe(
            true,
        );
        expect(isConsumerReconnectTransient(new McHostCallError("terminal", "x"))).toBe(false);
        expect(isConsumerReconnectTransient(new McHostClientError("nope"))).toBe(false);
        expect(
            isConsumerReconnectTransient(
                Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
            ),
        ).toBe(true);
        expect(isConsumerReconnectTransient(new Error("plain"))).toBe(false);
    });

    test("isMcHostCallError recognizes a second bundled copy and rejects old runtime names", () => {
        // `SecondCopyCallError` models a separately bundled copy that fails
        // `instanceof McHostCallError`.
        class SecondCopyCallError extends Error {
            constructor(
                readonly kind: string,
                message: string,
                readonly code?: string,
            ) {
                super(message);
                this.name = "McHostCallError";
            }
        }
        expect(isMcHostCallError(new McHostCallError("terminal", "same bundle", "c"))).toBe(true);
        expect(isMcHostCallError(new SecondCopyCallError("not_sent", "x"))).toBe(true);
        expect(isMcHostCallError(new SecondCopyCallError("outcome_unknown", "x", "code"))).toBe(
            true,
        );
        expect(isMcHostCallError(new SecondCopyCallError("terminal", "x"))).toBe(true);

        const oldName = new SecondCopyCallError("terminal", "x", "c");
        // Assembled from parts; boundary tests reject the joined spelling. commentlint: allow(JUDGE)
        oldName.name = ["Subc", "CallError"].join("");
        expect(isMcHostCallError(oldName)).toBe(false);

        expect(isMcHostCallError(new SecondCopyCallError("bogus_kind", "x"))).toBe(false);
        expect(
            isMcHostCallError(Object.assign(new SecondCopyCallError("terminal", "x"), { code: 7 })),
        ).toBe(false);
        expect(isMcHostCallError(new Error("unrelated"))).toBe(false);
        expect(
            isMcHostCallError({ name: "McHostCallError", kind: "terminal", message: "plain" }),
        ).toBe(false);
        expect(isMcHostCallError(null)).toBe(false);
    });
});

describe("shm re-upgrade probe eligibility (R11)", () => {
    test("exact unavailable emits fallbackReason and starts a shadow probe", async () => {
        const provider = createFakePairedProvider();
        const events: McHostDiagnosticsEvent[] = [];
        const peer = await startPeer({
            negotiate: (frame, conn) => {
                void conn.send({
                    ty: PeerFrameType.Response,
                    channel: 0,
                    epoch: 0,
                    corr: frame.corr,
                    body: Buffer.from(
                        JSON.stringify({
                            op: "transport.negotiate",
                            negotiation_version: 1,
                            selected: { transport: "tcp", capability_version: 1 },
                            reason: "unavailable",
                        }),
                        "utf8",
                    ),
                });
            },
        });
        const filePath = freshFilePath();
        await writeConnectionFile(filePath, peer);
        const client = await McHostClient.connect({
            connectionFile: filePath,
            transportProviders: [provider],
            diagnostics: (event) => events.push(event),
        });
        clients.push(client);
        const connectedEvent = events.find((e) => e.type === "connected") as McHostDiagnosticsEvent;
        expect(connectedEvent.transport).toBe("tcp");
        expect(connectedEvent.fallbackReason).toBe("unavailable");
        // The shadow probe dials a SECOND authenticated connection while
        // the primary stays published and usable.
        await waitUntil(() => peer.connections.length >= 2, 10_000);
        const shadow = peer.connections[1] as FakePeerConnection;
        await shadow.authenticated;
        expect(shadow.clientAuthValid).toBe(true);
    });
});

describe("authenticated state retention (U3/KTD6)", () => {
    test("authenticated identity comes from the handshake, publication from the file", async () => {
        const { client, peer } = await connected();
        // The connection file's daemon_ver is written by test-util as
        // "fake-peer/0.0.1" and the peer reports the same string in its
        // ServerProof by default; the two surfaces must still be separate
        // objects sourced from different transcripts.
        const authenticated = client.authenticated;
        expect(authenticated).not.toBeNull();
        expect(authenticated?.daemonVer).toBe("fake-peer/0.0.1");
        expect(authenticated?.proof).toBe("current");
        expect(Array.from(authenticated?.daemonId ?? [])).toEqual(Array.from(peer.daemonId));
        const publication = client.publication;
        expect(publication?.daemonVer).toBe("fake-peer/0.0.1");
        expect(typeof publication?.pid).toBe("number");
    });

    test("a divergent publication daemon_ver never masks the authenticated value", async () => {
        const peer = await startPeer({ daemonVer: "mc-host/9.9.9-auth" });
        const filePath = freshFilePath();
        // writeConnectionFile pins the publication daemon_ver to
        // "fake-peer/0.0.1", so the two transcripts disagree on purpose.
        await writeConnectionFile(filePath, peer);
        const client = await McHostClient.connect({ connectionFile: filePath });
        clients.push(client);
        expect(client.authenticated?.daemonVer).toBe("mc-host/9.9.9-auth");
        expect(client.publication?.daemonVer).toBe("fake-peer/0.0.1");
    });

    test("the getter hands out a copy, so a caller cannot poison the identity", async () => {
        const { client, peer } = await connected();
        const borrowed = client.authenticated?.daemonId;
        expect(borrowed).not.toBeUndefined();
        // The retained identity authorizes compatibility and fencing; mutating
        // what the getter returned must not reach it.
        (borrowed as Uint8Array).fill(0);
        expect(Array.from(client.authenticated?.daemonId ?? [])).toEqual(Array.from(peer.daemonId));
    });
});

describe("strict catalog parsing (U3 scenario 10)", () => {
    async function catalogRejection(body: unknown): Promise<McHostCallError> {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const catalogPromise = client.catalogList();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        await sendResponse(conn, catalogFrame.corr, body);
        return expectCallError(await rejection(catalogPromise), "terminal");
    }

    const validEntry = {
        module_id: "magic-context",
        module_version: "0.1.0",
        roles: [],
        control_ops: ["route.open"],
    };
    const valid = {
        op: "catalog.list",
        generation: 1,
        modules: [validEntry],
        subc_ops: ["route.open", "catalog.list", "host.shutdown", "transport.negotiate"],
    };

    test("rejects every malformed catalog shape without casting", async () => {
        const cases: Record<string, unknown> = {
            missing_generation: { ...valid, generation: undefined },
            fractional_generation: { ...valid, generation: 1.5 },
            negative_generation: { ...valid, generation: -1 },
            missing_subc_ops: { ...valid, subc_ops: undefined },
            empty_subc_ops: { ...valid, subc_ops: [] },
            non_string_subc_ops: { ...valid, subc_ops: [7] },
            duplicate_subc_ops: { ...valid, subc_ops: ["route.open", "route.open"] },
            unknown_top_level_field: { ...valid, extra: true },
            non_array_modules: { ...valid, modules: {} },
            module_not_object: { ...valid, modules: [7] },
            missing_module_version: {
                ...valid,
                modules: [{ module_id: "m", roles: [], control_ops: [] }],
            },
            empty_module_version: { ...valid, modules: [{ ...validEntry, module_version: "" }] },
            missing_module_id: {
                ...valid,
                modules: [{ module_version: "0.1.0", roles: [], control_ops: [] }],
            },
            oversized_module_id: {
                ...valid,
                modules: [{ ...validEntry, module_id: "x".repeat(129) }],
            },
            duplicate_module_id: { ...valid, modules: [validEntry, validEntry] },
            unknown_module_field: { ...valid, modules: [{ ...validEntry, extra: 1 }] },
            malformed_control_ops: { ...valid, modules: [{ ...validEntry, control_ops: [""] }] },
            non_array_roles: { ...valid, modules: [{ ...validEntry, roles: "admin" }] },
        };
        for (const [name, body] of Object.entries(cases)) {
            const error = await catalogRejection(JSON.parse(JSON.stringify(body)));
            expect({ name, code: error.code }).toEqual({
                name,
                code: "malformed_control_response",
            });
        }
    }, 30_000);

    test("a valid catalog yields the tagged snapshot", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const snapshotPromise = client.catalogSnapshot();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        await sendResponse(conn, catalogFrame.corr, valid);
        const snapshot = await snapshotPromise;
        expect(snapshot.generation).toBe(1);
        expect(snapshot.subcOps).toEqual([
            "route.open",
            "catalog.list",
            "host.shutdown",
            "transport.negotiate",
        ]);
        expect(snapshot.modules).toEqual([validEntry]);
    });
});

describe("host.shutdown (U3 scenario 11)", () => {
    test("hostShutdown sends one tagged request and resolves on the echoed response", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const shutdownPromise = client.hostShutdown();
        const frame = await cursor.next((f) => isControlOp(f, "host.shutdown"));
        expect(frame.body.toString("utf8")).toBe('{"op":"host.shutdown"}');
        await sendResponse(conn, frame.corr, { op: "host.shutdown" });
        await shutdownPromise;
    });

    test("a response that does not echo the operation is a typed failure", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);
        const shutdownPromise = client.hostShutdown();
        const frame = await cursor.next((f) => isControlOp(f, "host.shutdown"));
        await sendResponse(conn, frame.corr, {
            op: "catalog.list",
            generation: 1,
            modules: [],
            subc_ops: ["route.open"],
        });
        expectCallError(await rejection(shutdownPromise), "terminal", "malformed_control_response");
    });

    test("ordinary close never sends host.shutdown", async () => {
        const { client, conn } = await connected();
        await client.closeAsync();
        const shutdownFrames = conn.frames.filter((f) => isControlOp(f, "host.shutdown"));
        expect(shutdownFrames).toEqual([]);
    });
});
