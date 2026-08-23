import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    connectionFileExists,
    isConsumerReconnectTransient,
    SubcClient,
    type SubcClientOptions,
    type SubcDiagnosticsEvent,
} from "./client";
import { SocketClosedError, SubcCallError, SubcError } from "./errors";
import type { RouteHandle } from "./route-handle";
import { StaleRouteHandleError } from "./route-handle";
import {
    encodePeerFrame,
    FakePeer,
    type FakePeerConnection,
    type PeerFrame,
    PeerFrameType,
} from "./test-support/fake-peer";
import { rejection, waitUntil, writeConnectionFile } from "./test-support/test-util";
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
let clients: SubcClient[] = [];
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
    client: SubcClient;
    filePath: string;
}

async function connected(overrides: Partial<SubcClientOptions> = {}): Promise<ConnectedHarness> {
    const peer = await startPeer();
    const filePath = freshFilePath();
    await writeConnectionFile(filePath, peer);
    const client = await SubcClient.connect({
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
    kind: SubcCallError["kind"],
    code?: string,
): SubcCallError {
    expect(error).toBeInstanceOf(SubcCallError);
    const callError = error as SubcCallError;
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
    client: SubcClient,
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
    client: SubcClient,
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
 * Must be called before the dial is triggered.
 */
function stallNextConnection(peer: FakePeer): Promise<FakePeerConnection> {
    return peer.waitForConnection().then((conn) => {
        conn.pauseReading();
        return conn;
    });
}

const isRoutedFrame = (frame: PeerFrame): boolean =>
    frame.ty === PeerFrameType.Request && frame.channel !== 0;

describe("SubcClient facade", () => {
    test("completes tagged catalog, route open, opaque JSON request, and route Goodbye", async () => {
        const { client, conn } = await connected();
        const cursor = frameCursor(conn);

        const catalogPromise = client.catalogList();
        const catalogFrame = await cursor.next((f) => isControlOp(f, "catalog.list"));
        expect(catalogFrame.body.toString("utf8")).toBe('{"op":"catalog.list"}');
        const entry = { module_id: "magic-context", roles: [], control_ops: ["route.open"] };
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

    test("canonical Error body becomes a terminal SubcCallError with its stable code", async () => {
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

        const error = (await callPromise.catch((e) => e)) as SubcCallError;
        expect(error).toBeInstanceOf(SubcCallError);
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
        const events: SubcDiagnosticsEvent[] = [];
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
        await sendResponse(conn2, catalogFrame.corr, { op: "catalog.list", modules: [] });
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
        const events: SubcDiagnosticsEvent[] = [];
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
        const events: SubcDiagnosticsEvent[] = [];
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
        const events: SubcDiagnosticsEvent[] = [];
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
        const events: SubcDiagnosticsEvent[] = [];
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
            expect(types.has(required as SubcDiagnosticsEvent["type"])).toBe(true);
        }
        const connectedEvent = events.find((e) => e.type === "connected") as SubcDiagnosticsEvent;
        expect(connectedEvent.daemonVer).toBe("fake-peer/0.0.1");
        expect(connectedEvent.pid).toBe(process.pid);

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
        const events: SubcDiagnosticsEvent[] = [];
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
        expect(afterClose).toBeInstanceOf(SubcError);
        expect((afterClose as SubcError).code).toBe("client_closed");
    });

    test("reconnect and managed route open are single-flight across concurrent calls", async () => {
        const events: SubcDiagnosticsEvent[] = [];
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
        expect(conn.frames.length).toBe(0);
    });
});

describe("deadline-independent setup coalescing", () => {
    interface ReconnectHarness extends ConnectedHarness {
        events: SubcDiagnosticsEvent[];
    }

    /** Connect, then retire the first generation so the next call redials. */
    async function retiredHarness(
        overrides: Partial<SubcClientOptions> = {},
    ): Promise<ReconnectHarness> {
        const events: SubcDiagnosticsEvent[] = [];
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
        const { client, conn, peer } = await connected({ identity: IDENTITY });
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
        expect(isConsumerReconnectTransient(new SubcCallError("not_sent", "x"))).toBe(true);
        expect(isConsumerReconnectTransient(new SubcCallError("outcome_unknown", "x"))).toBe(true);
        expect(isConsumerReconnectTransient(new SubcCallError("terminal", "x"))).toBe(false);
        expect(isConsumerReconnectTransient(new SubcError("nope"))).toBe(false);
        expect(
            isConsumerReconnectTransient(
                Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
            ),
        ).toBe(true);
        expect(isConsumerReconnectTransient(new Error("plain"))).toBe(false);
    });
});
