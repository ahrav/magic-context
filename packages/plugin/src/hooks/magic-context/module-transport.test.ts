/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _resetHarnessForTesting } from "../../shared/harness";
import {
    Deadline,
    McHostCallError,
    type McHostClient,
    type RouteHandle,
    StaleRouteHandleError,
} from "../../shared/mc-host-client";
import {
    FakePeer,
    type FakePeerConnection,
    PEER_PROTOCOL_VERSION,
    type PeerFrame,
    PeerFrameType,
} from "../../shared/mc-host-client/test-support/fake-peer";
import {
    rejection,
    waitUntil,
    writeConnectionFile,
} from "../../shared/mc-host-client/test-support/test-util";
import {
    __moduleTransportTest,
    buildManagedStartupEnvelope,
    McHostModuleTransport,
} from "./module-transport";

let tempDir = "";
let fileCounter = 0;
let peers: FakePeer[] = [];
let transports: McHostModuleTransport[] = [];
let savedModuleId: string | undefined;
let savedLaunchNonce: string | undefined;

beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "module-transport-facade-"));
    savedModuleId = process.env.SUBC_MODULE_ID;
    savedLaunchNonce = process.env.SUBC_LAUNCH_NONCE;
});

afterAll(() => {
    if (savedModuleId === undefined) delete process.env.SUBC_MODULE_ID;
    else process.env.SUBC_MODULE_ID = savedModuleId;
    if (savedLaunchNonce === undefined) delete process.env.SUBC_LAUNCH_NONCE;
    else process.env.SUBC_LAUNCH_NONCE = savedLaunchNonce;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
    peers = [];
    transports = [];
    _resetHarnessForTesting();
    delete process.env.SUBC_MODULE_ID;
    delete process.env.SUBC_LAUNCH_NONCE;
});

afterEach(async () => {
    for (const transport of transports) {
        (transport as unknown as { invalidateConnection(): void }).invalidateConnection();
    }
    for (const peer of peers) {
        await peer.close();
    }
});

async function startPeer(): Promise<FakePeer> {
    const peer = await FakePeer.start();
    peers.push(peer);
    return peer;
}

async function writeConnFile(peer: FakePeer): Promise<string> {
    fileCounter += 1;
    const filePath = join(tempDir, `subc-connection-${fileCounter}.json`);
    await writeConnectionFile(filePath, peer);
    return filePath;
}

function trackTransport(transport: McHostModuleTransport): McHostModuleTransport {
    transports.push(transport);
    return transport;
}

async function peerTransport(
    requestTimeoutMs = 5_000,
): Promise<{ peer: FakePeer; transport: McHostModuleTransport }> {
    const peer = await startPeer();
    const connectionFile = await writeConnFile(peer);
    const transport = trackTransport(
        new McHostModuleTransport(connectionFile, "magic-context", requestTimeoutMs),
    );
    return { peer, transport };
}

function bodyJson(frame: PeerFrame): unknown {
    try {
        return JSON.parse(frame.body.toString("utf8"));
    } catch {
        return undefined;
    }
}

function isRouteOpen(frame: PeerFrame): boolean {
    if (frame.ty !== PeerFrameType.Request || frame.channel !== 0) return false;
    const parsed = bodyJson(frame) as { op?: unknown } | undefined;
    return parsed?.op === "route.open";
}

const isRoutedRequest =
    (channel?: number) =>
    (frame: PeerFrame): boolean =>
        frame.ty === PeerFrameType.Request &&
        frame.channel !== 0 &&
        (channel === undefined || frame.channel === channel);

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

/** Every routed application body the peer ever observed, across connections. */
function routedBodies(peer: FakePeer): PeerFrame[] {
    return peer.connections.flatMap((conn) => conn.frames.filter(isRoutedRequest()));
}

function expectCallError(error: unknown, kind: McHostCallError["kind"], code?: string): void {
    expect((error as Error).name).toBe("McHostCallError");
    expect((error as McHostCallError).kind).toBe(kind);
    if (code !== undefined) expect((error as McHostCallError).code).toBe(code);
}

function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe("McHostModuleTransport", () => {
    it("builds a closed bounded startup credential snapshot at demand time", () => {
        const envelope = buildManagedStartupEnvelope(
            "@cortexkit/opencode-magic-context",
            {
                ANTHROPIC_API_KEY: "anthropic-secret",
                OPENAI_API_KEY: "openai-secret",
                AWS_ACCESS_KEY_ID: "ambient-aws",
                HTTPS_PROXY: "ambient-proxy",
                PATH: "/attacker/bin",
                LD_PRELOAD: "/attacker/lib.so",
            },
            "/opt/opencode/bin/opencode.exe",
            undefined,
            (path) => path,
        );

        expect(envelope).toEqual({
            schema: 1,
            opencode: {
                manifest_sha256: "e7e86cd1e1e639fb60aed6dfc3c33cd04244f767f6681a13bf26c90429279f2d",
                source_roots: {
                    runtime: "/opt/opencode/bin",
                },
            },
            credentials: {
                ANTHROPIC_API_KEY: "anthropic-secret",
                OPENAI_API_KEY: "openai-secret",
            },
        });
        expect(() =>
            buildManagedStartupEnvelope(
                "@cortexkit/pi-magic-context",
                { ANTHROPIC_API_KEY: "x".repeat(16 * 1024 + 1) },
                "/opt/pi/bin/pi",
            ),
        ).toThrow(/size cap/);
        expect(
            buildManagedStartupEnvelope(
                "@cortexkit/pi-magic-context",
                {},
                "/opt/node/bin/node",
                "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
                (path) => path,
            ),
        ).toEqual({
            schema: 1,
            pi: {
                manifest_sha256: "cc87481ce798bd84b9cd0d1dd809bc4c72cea9435303705362a3b2be493674e6",
                source_roots: {
                    "pi-install": "/opt/pi",
                    runtime: "/opt/node/bin",
                },
            },
        });
    });

    it("resolves an npm .bin Pi entrypoint before deriving closure roots", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-pi-bin-"));
        try {
            const node = join(root, "node", "bin", "node");
            const cli = join(
                root,
                "install",
                "node_modules",
                "@earendil-works",
                "pi-coding-agent",
                "dist",
                "cli.js",
            );
            const binDir = join(root, "install", "node_modules", ".bin");
            mkdirSync(join(root, "node", "bin"), { recursive: true });
            mkdirSync(join(cli, ".."), { recursive: true });
            mkdirSync(binDir, { recursive: true });
            writeFileSync(node, "node");
            writeFileSync(cli, "cli");
            const shim = join(binDir, "pi");
            symlinkSync("../@earendil-works/pi-coding-agent/dist/cli.js", shim);

            expect(
                buildManagedStartupEnvelope("@cortexkit/pi-magic-context", {}, node, shim),
            ).toEqual({
                schema: 1,
                pi: {
                    manifest_sha256:
                        "cc87481ce798bd84b9cd0d1dd809bc4c72cea9435303705362a3b2be493674e6",
                    source_roots: {
                        "pi-install": join(root, "install"),
                        runtime: join(root, "node", "bin"),
                    },
                },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps construction inert and demands managed storage readiness before connecting", async () => {
        const events: string[] = [];
        const transport = trackTransport(
            new McHostModuleTransport({
                requestTimeoutMs: 100,
                demandStart: async () => {
                    events.push("demand");
                    return { ok: false, reason: "storage_starting", storage: "starting" };
                },
            }),
        );

        expect(events).toEqual([]);
        await expect(
            transport.call({
                sessionId: "managed-demand",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            }),
        ).rejects.toMatchObject({ code: "storage_starting" });
        expect(events).toEqual(["demand"]);
    });

    it("a failed demand arms connection backoff instead of re-demanding per call", async () => {
        let demands = 0;
        const transport = trackTransport(
            new McHostModuleTransport({
                requestTimeoutMs: 1_000,
                demandStart: async () => {
                    demands += 1;
                    return { ok: false, reason: "native_payload_missing", storage: null };
                },
            }),
        );
        const args = {
            sessionId: "managed-backoff",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
        } as const;

        await expect(transport.call(args)).rejects.toMatchObject({
            code: "native_payload_missing",
        });
        await expect(transport.call(args)).rejects.toMatchObject({
            code: "MC_HOST_CONNECTION_BACKOFF",
        });
        expect(demands).toBe(1);
    });

    it("credential source changes rebind the managed route before another body", async () => {
        const peer = await startPeer();
        const dataHome = join(tempDir, `managed-home-${++fileCounter}`);
        const connectionFile = join(dataHome, "cortexkit", "run", "subc-connection.json");
        mkdirSync(join(dataHome, "cortexkit", "run"), { recursive: true });
        await writeConnectionFile(connectionFile, peer);
        const oldDataHome = process.env.XDG_DATA_HOME;
        const oldCredential = process.env.ANTHROPIC_API_KEY;
        process.env.XDG_DATA_HOME = dataHome;
        process.env.ANTHROPIC_API_KEY = "first-secret";
        const transport = trackTransport(
            new McHostModuleTransport({
                requestTimeoutMs: 2_000,
                demandStart: async () => ({
                    ok: true,
                    reason: "already_running",
                    storage: "ready",
                }),
            }),
        );
        try {
            const first = transport.call({
                sessionId: "credential-refresh",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            });
            const conn = await peer.waitForConnection();
            await conn.authenticated;
            const cursor = frameCursor(conn);
            const firstOpen = await cursor.next(isRouteOpen);
            const firstFingerprint = (
                bodyJson(firstOpen) as {
                    identity: {
                        credential_fingerprints: { anthropic: string };
                    };
                }
            ).identity.credential_fingerprints.anthropic;
            await sendRouteOpenOk(conn, firstOpen.corr, 7, 77);
            const firstRequest = await cursor.next(isRoutedRequest(7));
            await sendResponse(conn, firstRequest.corr, { ok: true }, 7, 77);
            await first;
            const credentialChangeFrameStart = conn.frames.length;

            process.env.ANTHROPIC_API_KEY = "second-secret";
            const second = transport.call({
                sessionId: "credential-refresh",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            });
            const secondOpen = await cursor.next(isRouteOpen);
            const secondFingerprint = (
                bodyJson(secondOpen) as {
                    identity: {
                        credential_fingerprints: { anthropic: string };
                    };
                }
            ).identity.credential_fingerprints.anthropic;
            expect(secondFingerprint).not.toBe(firstFingerprint);
            await sendRouteOpenOk(conn, secondOpen.corr, 8, 78);
            const secondRequest = await cursor.next(isRoutedRequest(8));
            expect(
                conn.frames
                    .slice(credentialChangeFrameStart)
                    .filter(isRoutedRequest())
                    .map((frame) => frame.channel),
            ).toEqual([8]);
            await sendResponse(conn, secondRequest.corr, { ok: true }, 8, 78);
            await second;
        } finally {
            if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = oldDataHome;
            if (oldCredential === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = oldCredential;
        }
    });

    it("stays passive without a managed lifecycle owner and dials the default file", async () => {
        const peer = await startPeer();
        const dataHome = join(tempDir, `passive-home-${++fileCounter}`);
        const connectionFile = join(dataHome, "cortexkit", "run", "subc-connection.json");
        mkdirSync(join(dataHome, "cortexkit", "run"), { recursive: true });
        await writeConnectionFile(connectionFile, peer);
        const oldDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = dataHome;
        try {
            const transport = trackTransport(
                new McHostModuleTransport({ requestTimeoutMs: 2_000 }),
            );
            const call = transport.call({
                sessionId: "missing-owner",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            });
            const conn = await peer.waitForConnection();
            await conn.authenticated;
            const cursor = frameCursor(conn);
            const routeOpen = await cursor.next(isRouteOpen);
            await sendRouteOpenOk(conn, routeOpen.corr, 7, 77);
            const request = await cursor.next(isRoutedRequest(7));
            await sendResponse(conn, request.corr, { ok: true }, 7, 77);

            await expect(call).resolves.toEqual({ ok: true });
        } finally {
            if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = oldDataHome;
        }
    });

    it("keeps an explicit connection lifecycle-neutral", async () => {
        const peer = await startPeer();
        const connectionFile = await writeConnFile(peer);
        let demands = 0;
        const transport = trackTransport(
            new McHostModuleTransport({
                connectionFile,
                requestTimeoutMs: 1_000,
                demandStart: async () => {
                    demands += 1;
                    return { ok: true, reason: "started", storage: "ready" };
                },
            }),
        );
        const call = transport.call({
            sessionId: "explicit-demand",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
        });
        const conn = await peer.waitForConnection();
        await conn.authenticated;
        const cursor = frameCursor(conn);
        const routeOpen = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, routeOpen.corr, 7, 77);
        const request = await cursor.next(isRoutedRequest(7));
        await sendResponse(conn, request.corr, { ok: true }, 7, 77);

        await expect(call).resolves.toEqual({ ok: true });
        expect(demands).toBe(0);
    });

    it("uses the internal facade while preserving route identity and flat request bytes", async () => {
        const { peer, transport } = await peerTransport(1_000);
        const flatBody = {
            method: "transform",
            v: 1,
            input: [{ id: "m1" }],
        };
        const callPromise = transport.call({
            sessionId: "session-1",
            projectRoot: "/workspace/project",
            method: "transform",
            body: flatBody,
        });

        const conn = await peer.waitForConnection();
        await conn.authenticated;
        expect(conn.clientAuthValid).toBe(true);
        const cursor = frameCursor(conn);
        const routeOpen = await cursor.next(isRouteOpen);
        expect(bodyJson(routeOpen)).toEqual({
            op: "route.open",
            target: { kind: "tool_provider", module_id: "magic-context" },
            identity: {
                project_root: "/workspace/project",
                harness: "opencode",
                session: "session-1",
            },
        });
        expect(routeOpen.ver).toBe(PEER_PROTOCOL_VERSION);
        expect(routeOpen.channel).toBe(0);
        expect(routeOpen.epoch).toBe(0);
        await sendRouteOpenOk(conn, routeOpen.corr, 7, 77);

        const request = await cursor.next(isRoutedRequest(7));
        expect(bodyJson(request)).toEqual(flatBody);
        expect(request.ver).toBe(PEER_PROTOCOL_VERSION);
        expect(request.epoch).toBe(77);
        expect(request.corr > routeOpen.corr).toBe(true);
        // Priority.Background rides in flags bits 1-2; admission stays Normal.
        expect((request.flags >> 1) & 0b11).toBe(2);
        expect((request.flags >> 4) & 0b11).toBe(0);
        await sendResponse(conn, request.corr, { result: { ok: true } }, 7, 77);

        await expect(callPromise).resolves.toEqual({ result: { ok: true } });

        transport.closeSession("session-1");
        const goodbye = await cursor.next((frame) => frame.ty === PeerFrameType.Goodbye);
        expect(goodbye.channel).toBe(7);
        expect(goodbye.epoch).toBe(77);
    });

    it("recognizes a stale route error from a foreign subc-client prototype", () => {
        const foreignStaleRouteError = Object.assign(Object.create(null), {
            name: "StaleRouteHandleError",
            message: "route handle (1, 1) is not live on the current connection",
        });

        expect(foreignStaleRouteError).not.toBeInstanceOf(StaleRouteHandleError);
        expect(__moduleTransportTest.isConnectionFailure(foreignStaleRouteError)).toBe(true);
    });

    it("propagates outcome_unknown without a second body when the connection drops after a possible send", async () => {
        const { peer, transport } = await peerTransport(2_000);
        const failure = transport.call({
            sessionId: "session-dropped",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
        });

        const conn = await peer.waitForConnection();
        await conn.authenticated;
        const cursor = frameCursor(conn);
        const routeOpen = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, routeOpen.corr, 7, 77);
        await cursor.next(isRoutedRequest(7));
        // The body may be on the wire; drop without a terminal.
        conn.destroy();

        expectCallError(await rejection(failure), "outcome_unknown");
        await delay(30);
        // Body-write counting across layers: exactly one possible send, no
        // hidden lower-layer replay, no reconnect resend.
        expect(routedBodies(peer)).toHaveLength(1);
        expect(peer.connections).toHaveLength(1);
    });

    it("bounds a hung module request and propagates outcome_unknown after exactly one body", async () => {
        const { peer, transport } = await peerTransport(500);
        const startedAt = performance.now();
        const failure = transport.call({
            sessionId: "session-hung",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
        });

        const conn = await peer.waitForConnection();
        await conn.authenticated;
        const cursor = frameCursor(conn);
        const routeOpen = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, routeOpen.corr, 7, 77);
        await cursor.next(isRoutedRequest(7));
        // Never answer: the request hangs until the operation deadline.

        expectCallError(await rejection(failure), "outcome_unknown");
        expect(performance.now() - startedAt).toBeLessThan(5_000);
        expect(routedBodies(peer)).toHaveLength(1);
        expect(peer.connections).toHaveLength(1);
    });

    it("evicts the route and retries once on terminal unknown_channel without reconnecting", async () => {
        const { peer, transport } = await peerTransport(5_000);
        const args = {
            sessionId: "session-unknown-channel",
            projectRoot: "/workspace/project",
            method: "transform" as const,
            body: { method: "transform", v: 1 },
        };
        const first = transport.call(args);
        const conn = await peer.waitForConnection();
        await conn.authenticated;
        const cursor = frameCursor(conn);
        const open1 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open1.corr, 7, 77);
        const body1 = await cursor.next(isRoutedRequest(7));
        await sendResponse(conn, body1.corr, { result: { attempt: 1 } }, 7, 77);
        await expect(first).resolves.toEqual({ result: { attempt: 1 } });

        const second = transport.call(args);
        const body2 = await cursor.next(isRoutedRequest(7));
        // Host-proven no dispatch: the route died with the module restart.
        await sendErrorBody(conn, body2.corr, "unknown_channel", 7, 77);
        const open2 = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, open2.corr, 7, 78);
        const body3 = await cursor.next((frame) => isRoutedRequest(7)(frame) && frame.epoch === 78);
        expect(body3.corr > body2.corr).toBe(true);
        expect(bodyJson(body3)).toEqual(args.body);
        await sendResponse(conn, body3.corr, { result: { attempt: 2 } }, 7, 78);

        await expect(second).resolves.toEqual({ result: { attempt: 2 } });
        // One connection throughout: eviction, not connection invalidation.
        expect(peer.connections).toHaveLength(1);
        expect(routedBodies(peer)).toHaveLength(3);
    });

    it("recovers a stale cached route pre-send with a fresh correlation and at most two total body sends", async () => {
        const { peer, transport } = await peerTransport(5_000);
        const args = {
            sessionId: "session-stale-route",
            projectRoot: "/workspace/project",
            method: "transform" as const,
            body: { method: "transform", v: 1 },
        };
        const first = transport.call(args);
        const conn1 = await peer.waitForConnection();
        await conn1.authenticated;
        const cursor1 = frameCursor(conn1);
        const open1 = await cursor1.next(isRouteOpen);
        await sendRouteOpenOk(conn1, open1.corr, 7, 77);
        const body1 = await cursor1.next(isRoutedRequest(7));
        await sendResponse(conn1, body1.corr, { result: { first: true } }, 7, 77);
        await expect(first).resolves.toEqual({ result: { first: true } });

        // The facade generation retires; the transport still caches the route,
        // so the next request hits a stale handle BEFORE any body write.
        conn1.destroy();
        await conn1.closed;
        await delay(50);

        const second = transport.call(args);
        const conn2 = await nthConnection(peer, 2);
        await conn2.authenticated;
        const cursor2 = frameCursor(conn2);
        const open2 = await cursor2.next(isRouteOpen);
        await sendRouteOpenOk(conn2, open2.corr, 9, 1);
        const body2 = await cursor2.next(isRoutedRequest(9));
        expect(bodyJson(body2)).toEqual(args.body);
        await sendResponse(conn2, body2.corr, { result: { second: true } }, 9, 1);

        await expect(second).resolves.toEqual({ result: { second: true } });
        // The pre-send stale handle spent the transport token on a fresh
        // correlation; the second call's body reached exactly one socket.
        expect(conn2.frames.filter(isRoutedRequest())).toHaveLength(1);
        expect(routedBodies(peer)).toHaveLength(2);
    });

    it("aborts after a possible send settle promptly, fence the session lane, and let other sessions proceed", async () => {
        const { peer, transport } = await peerTransport(10_000);
        const controller = new AbortController();
        const callA = transport.call({
            sessionId: "session-fenced",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1, page: "a" },
            signal: controller.signal,
        });
        const conn = await peer.waitForConnection();
        await conn.authenticated;
        const cursor = frameCursor(conn);
        const openA = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, openA.corr, 7, 77);
        const bodyA = await cursor.next(isRoutedRequest(7));
        controller.abort();

        // The caller settles promptly as outcome_unknown with a Cancel queued.
        const abortError = await rejection(callA);
        expectCallError(abortError, "outcome_unknown", "aborted");
        const cancel = await cursor.next((frame) => frame.ty === PeerFrameType.Cancel);
        expect(cancel.channel).toBe(7);
        expect(cancel.corr).toBe(bodyA.corr);

        // Same session waits behind the cleanup ticket; another session runs.
        let callBStarted = false;
        const callB = transport
            .call({
                sessionId: "session-fenced",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1, page: "b" },
            })
            .finally(() => {
                callBStarted = true;
            });
        const callC = transport.call({
            sessionId: "session-independent",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1, page: "c" },
        });
        const openC = await cursor.next(isRouteOpen);
        await sendRouteOpenOk(conn, openC.corr, 9, 1);
        const bodyC = await cursor.next(isRoutedRequest(9));
        await sendResponse(conn, bodyC.corr, { result: { page: "c" } }, 9, 1);
        await expect(callC).resolves.toEqual({ result: { page: "c" } });
        expect(callBStarted).toBe(false);
        expect(conn.frames.filter(isRoutedRequest(7))).toHaveLength(1);

        // The late terminal resolves the cleanup ticket and releases the lane.
        await sendResponse(conn, bodyA.corr, { result: { late: true } }, 7, 77);
        const bodyB = await cursor.next(isRoutedRequest(7));
        expect(bodyJson(bodyB)).toEqual({ method: "transform", v: 1, page: "b" });
        await sendResponse(conn, bodyB.corr, { result: { page: "b" } }, 7, 77);
        await expect(callB).resolves.toEqual({ result: { page: "b" } });
        expect(routedBodies(peer)).toHaveLength(3);
    });

    it("reconnects once when the request provably never reached the socket", async () => {
        const transport = new McHostModuleTransport("unused-connection-file", "magic-context", 100);
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let connectionCount = 0;
        let firstCloseCount = 0;
        const clients = [
            {
                routeOpen: async () => route,
                request: async () => {
                    throw new McHostCallError("not_sent", "client closed", "connection_dropped");
                },
                close: () => {
                    firstCloseCount += 1;
                },
            },
            {
                routeOpen: async () => route,
                request: async () => ({ result: { reconnected: true } }),
                close: () => undefined,
            },
        ] as unknown as McHostClient[];
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            const client = clients[connectionCount++];
            if (!client) throw new Error("unexpected third connection attempt");
            internals.client = client;
            return client;
        };

        await expect(
            transport.call({
                sessionId: "session-client-closed",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            }),
        ).resolves.toEqual({ result: { reconnected: true } });
        expect(connectionCount).toBe(2);
        expect(firstCloseCount).toBe(1);
    });

    it("stops after not_sent then unknown_channel: the transport replay token is single-use", async () => {
        const transport = new McHostModuleTransport(
            "unused-connection-file",
            "magic-context",
            1_000,
        );
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let requestCount = 0;
        let routeOpenCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenCount += 1;
                return route;
            },
            request: async () => {
                requestCount += 1;
                if (requestCount === 1) {
                    throw new McHostCallError("not_sent", "queued rejection", "writer_queue_full");
                }
                throw new McHostCallError("terminal", "error unknown_channel", "unknown_channel");
            },
            close: () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            internals.client = client;
            return client;
        };

        const error = await rejection(
            transport.call({
                sessionId: "session-budget",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            }),
        );
        expectCallError(error, "terminal", "unknown_channel");
        // Two body attempts total; the exhausted budget refuses a third.
        expect(requestCount).toBe(2);
        expect(routeOpenCount).toBe(2);
    });

    it("an aborted caller cannot spend an unspent replay token", async () => {
        const transport = new McHostModuleTransport(
            "unused-connection-file",
            "magic-context",
            1_000,
        );
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const controller = new AbortController();
        let requestCount = 0;
        const client = {
            routeOpen: async () => route,
            request: async () => {
                requestCount += 1;
                controller.abort();
                throw new McHostCallError("not_sent", "request aborted", "aborted");
            },
            close: () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            internals.client = client;
            return client;
        };

        const error = await rejection(
            transport.call({
                sessionId: "session-aborted-token",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
                signal: controller.signal,
            }),
        );
        expectCallError(error, "not_sent", "aborted");
        expect(requestCount).toBe(1);
    });

    it("returns the typed generation change for pre-send recovery when generationSensitive is set", async () => {
        const transport = new McHostModuleTransport("unused-connection-file", "magic-context", 100);
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let requestCount = 0;
        const client = {
            routeOpen: async () => route,
            request: async () => {
                requestCount += 1;
                throw new McHostCallError("not_sent", "client closed", "connection_dropped");
            },
            close: () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            internals.client = client;
            return client;
        };

        await expect(
            transport.call({
                sessionId: "session-generation-sensitive",
                projectRoot: "/workspace/project",
                method: "state_sync",
                body: { method: "state_sync", v: 1 },
                generationSensitive: true,
            }),
        ).resolves.toEqual({
            transport_status: "connection_generation_changed",
            previous_generation: 0,
            current_generation: 1,
        });
        expect(requestCount).toBe(1);
    });

    it("propagates outcome_unknown as an error even when generationSensitive is set", async () => {
        const transport = new McHostModuleTransport("unused-connection-file", "magic-context", 100);
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let requestCount = 0;
        const client = {
            routeOpen: async () => route,
            request: async () => {
                requestCount += 1;
                throw new McHostCallError(
                    "outcome_unknown",
                    "connection dropped mid-request",
                    "connection_dropped",
                );
            },
            close: () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            internals.client = client;
            return client;
        };

        const error = await rejection(
            transport.call({
                sessionId: "session-generation-sensitive-unknown",
                projectRoot: "/workspace/project",
                method: "state_sync",
                body: { method: "state_sync", v: 1 },
                generationSensitive: true,
            }),
        );
        expectCallError(error, "outcome_unknown");
        expect(requestCount).toBe(1);
    });

    it("bounds a half-open route open under the single operation deadline without any body send", async () => {
        const timeoutMs = 30;
        const transport = new McHostModuleTransport(
            "unused-connection-file",
            "magic-context",
            timeoutMs,
        );
        let connectionCount = 0;
        let routeOpenCount = 0;
        const client = {
            routeOpen: () => {
                routeOpenCount += 1;
                return new Promise<never>(() => undefined);
            },
            close: () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            connectionCount += 1;
            internals.client = client;
            return client;
        };
        const startedAt = performance.now();

        const failure = transport.call({
            sessionId: "session-half-open-client",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
        });

        // The single absolute deadline is exhausted by the hang, so the
        // pre-send retry token cannot be spent on a second route open.
        await expect(failure).rejects.toMatchObject({ code: "ETIMEDOUT" });
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(connectionCount).toBe(1);
        expect(routeOpenCount).toBe(1);
    });

    it("bounds a hung stubbed request as outcome_unknown without a second attempt", async () => {
        const timeoutMs = 30;
        const transport = new McHostModuleTransport(
            "unused-connection-file",
            "magic-context",
            timeoutMs,
        );
        const route = { channel: 8, epoch: 88 } as RouteHandle;
        let connectionCount = 0;
        let requestCount = 0;
        const client = {
            routeOpen: async () => route,
            request: () => {
                requestCount += 1;
                return new Promise<never>(() => undefined);
            },
            close: () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureConnected(): Promise<McHostClient>;
        };
        internals.ensureConnected = async () => {
            connectionCount += 1;
            internals.client = client;
            return client;
        };
        const startedAt = performance.now();

        const failure = transport.call({
            sessionId: "session-hung-client",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
        });

        const error = await rejection(failure);
        expectCallError(error, "outcome_unknown", "request_deadline");
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(connectionCount).toBe(1);
        expect(requestCount).toBe(1);
    });

    it("closeSession during an in-flight route open leaves no late cached route", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const routeOpenStarted = deferred();
        const releaseRouteOpen = deferred();
        let closeRouteCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenStarted.resolve();
                await releaseRouteOpen.promise;
                return route;
            },
            closeRoute: async () => {
                closeRouteCount += 1;
            },
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            routes: Map<string, unknown>;
            ensureRoute: (sessionId: string, projectRoot: string) => Promise<unknown>;
        };
        internals.client = client;

        const opening = internals.ensureRoute("close-race-session", "/route-project");
        await routeOpenStarted.promise;
        transport.closeSession("close-race-session");
        releaseRouteOpen.resolve();

        await expect(opening).rejects.toMatchObject({ code: "ECONNRESET" });
        expect(internals.routes.size).toBe(0);
        expect(closeRouteCount).toBe(1);
    });

    it("bounds canonical-root entries with least-recently-used eviction", () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const internals = transport as unknown as {
            canonicalRoot(root: string): string;
            canonicalRootCache: Map<string, string>;
        };
        for (let index = 0; index < 256; index += 1) {
            internals.canonicalRoot(`/missing-canonical-root-${index}`);
        }
        // A cache hit refreshes its recency before the next insert evicts an entry.
        internals.canonicalRoot("/missing-canonical-root-0");
        internals.canonicalRoot("/missing-canonical-root-256");

        expect(internals.canonicalRootCache.size).toBe(256);
        expect(internals.canonicalRootCache.has("/missing-canonical-root-0")).toBe(true);
        expect(internals.canonicalRootCache.has("/missing-canonical-root-1")).toBe(false);
    });

    it("does not expose state-sync capabilities from an earlier connection generation", () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const internals = transport as unknown as {
            connectionGeneration: number;
            stateSyncCapabilityCache: {
                generation: number;
                capabilities: { state_sync_deltas?: boolean };
            } | null;
        };
        internals.connectionGeneration = 1;
        internals.stateSyncCapabilityCache = {
            generation: 1,
            capabilities: { state_sync_deltas: true },
        };

        expect(transport.getCachedStateSyncCapabilities()).toEqual({ state_sync_deltas: true });
        internals.connectionGeneration = 2;
        expect(transport.getCachedStateSyncCapabilities()).toBeUndefined();
    });

    it("allows another session to start while a long wrapup is still in flight", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const wrapupStarted = deferred();
        const statusStarted = deferred();
        const releaseWrapup = deferred();
        let wrapupSettled = false;
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                const method = (body as { method: string }).method;
                if (method === "session.wrapup") {
                    wrapupStarted.resolve();
                    await releaseWrapup.promise;
                } else {
                    statusStarted.resolve();
                }
                return { result: { ok: true } };
            },
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureRoute: (sessionId: string) => Promise<{
                client: McHostClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async (sessionId) => ({
            client,
            route,
            routeKey: `${sessionId}\0/workspace/project`,
            generation: 0,
        });

        const wrapup = transport
            .call({
                sessionId: "session-a",
                projectRoot: "/workspace/project",
                method: "session.wrapup",
                body: { method: "session.wrapup", v: 1 },
            })
            .finally(() => {
                wrapupSettled = true;
            });
        await wrapupStarted.promise;
        const status = transport.call({
            sessionId: "session-b",
            projectRoot: "/workspace/project",
            method: "session.status",
            body: { method: "session.status", v: 1 },
        });

        await statusStarted.promise;
        expect(wrapupSettled).toBe(false);
        await expect(status).resolves.toEqual({ result: { ok: true } });
        releaseWrapup.resolve();
        await expect(wrapup).resolves.toEqual({ result: { ok: true } });
    });

    it("executes one session's state sync, transform, and status strictly in submission order", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const stateSyncStarted = deferred();
        const transformStarted = deferred();
        const releaseStateSync = deferred();
        const releaseTransform = deferred();
        const starts: string[] = [];
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                const method = (body as { method: string }).method;
                starts.push(method);
                if (method === "state_sync") {
                    stateSyncStarted.resolve();
                    await releaseStateSync.promise;
                } else if (method === "transform") {
                    transformStarted.resolve();
                    await releaseTransform.promise;
                }
                return { result: { method } };
            },
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureRoute: () => Promise<{
                client: McHostClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async () => ({
            client,
            route,
            routeKey: "ordered-session\0/workspace/project",
            generation: 0,
        });
        const base = { sessionId: "ordered-session", projectRoot: "/workspace/project" };

        const stateSync = transport.call({
            ...base,
            method: "state_sync",
            body: { method: "state_sync" },
        });
        const transform = transport.call({
            ...base,
            method: "transform",
            body: { method: "transform" },
        });
        const status = transport.call({
            ...base,
            method: "session.status",
            body: { method: "session.status" },
        });

        await stateSyncStarted.promise;
        expect(starts).toEqual(["state_sync"]);
        releaseStateSync.resolve();
        await transformStarted.promise;
        expect(starts).toEqual(["state_sync", "transform"]);
        releaseTransform.resolve();
        await Promise.all([stateSync, transform, status]);
        expect(starts).toEqual(["state_sync", "transform", "session.status"]);
    });

    it("coalesces concurrent connection recovery and retries two sessions on one fresh generation", async () => {
        const transport = new McHostModuleTransport(
            "unused-connection-file",
            "magic-context",
            1_000,
        );
        const oldRouteA = { channel: 7, epoch: 70 } as RouteHandle;
        const oldRouteB = { channel: 8, epoch: 80 } as RouteHandle;
        const oldRequestsStarted = deferred();
        let oldRequestCount = 0;
        let oldCloseCount = 0;
        const oldClient = {
            request: async () => {
                oldRequestCount += 1;
                if (oldRequestCount === 2) oldRequestsStarted.resolve();
                await oldRequestsStarted.promise;
                // Proven pre-send rejections: the replay token may be spent.
                throw new McHostCallError("not_sent", "client closed", "connection_dropped");
            },
            close: () => {
                oldCloseCount += 1;
            },
        } as unknown as McHostClient;
        let routeOpenCount = 0;
        const freshRequestSessions: string[] = [];
        const freshClient = {
            routeOpen: async (_target: unknown, identity: { session: string }) => {
                routeOpenCount += 1;
                return {
                    channel: 20 + routeOpenCount,
                    epoch: 100,
                    session: identity.session,
                } as unknown as RouteHandle;
            },
            request: async (_route: RouteHandle, body: unknown) => {
                const sessionId = (body as { session_id: string }).session_id;
                freshRequestSessions.push(sessionId);
                return { result: { sessionId } };
            },
            close: () => undefined,
        } as unknown as McHostClient;
        let connectCount = 0;
        const internals = transport as unknown as {
            client: McHostClient | null;
            connectionGeneration: number;
            routes: Map<string, { route: RouteHandle; generation: number }>;
            connectClient(): Promise<McHostClient>;
        };
        internals.client = oldClient;
        internals.routes.set("session-a\0/invalidation-a", { route: oldRouteA, generation: 0 });
        internals.routes.set("session-b\0/invalidation-b", { route: oldRouteB, generation: 0 });
        internals.connectClient = async () => {
            connectCount += 1;
            await Bun.sleep(10);
            return freshClient;
        };

        const [responseA, responseB] = await Promise.all([
            transport.call({
                sessionId: "session-a",
                projectRoot: "/invalidation-a",
                method: "transform",
                body: { method: "transform", session_id: "session-a" },
            }),
            transport.call({
                sessionId: "session-b",
                projectRoot: "/invalidation-b",
                method: "transform",
                body: { method: "transform", session_id: "session-b" },
            }),
        ]);

        expect(responseA).toEqual({ result: { sessionId: "session-a" } });
        expect(responseB).toEqual({ result: { sessionId: "session-b" } });
        expect(oldCloseCount).toBe(1);
        expect(connectCount).toBe(1);
        expect(internals.connectionGeneration).toBe(1);
        expect(routeOpenCount).toBe(2);
        expect(freshRequestSessions.sort()).toEqual(["session-a", "session-b"]);
    });

    it("coalesces concurrent route opens for the same session and project", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const routeOpenStarted = deferred();
        const releaseRouteOpen = deferred();
        let routeOpenCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenCount += 1;
                routeOpenStarted.resolve();
                await releaseRouteOpen.promise;
                return route;
            },
            closeRoute: async () => undefined,
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureRoute: (
                sessionId: string,
                projectRoot: string,
            ) => Promise<{ route: RouteHandle }>;
        };
        internals.client = client;

        const first = internals.ensureRoute("route-session", "/route-project");
        const second = internals.ensureRoute("route-session", "/route-project");
        await routeOpenStarted.promise;
        expect(routeOpenCount).toBe(1);
        releaseRouteOpen.resolve();

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.route).toBe(route);
        expect(secondResult.route).toBe(route);
        expect(routeOpenCount).toBe(1);
    });

    it("keeps the aggregate queued-call ceiling across independent session lanes", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const releaseActiveCalls = deferred();
        const allActiveCallsStarted = deferred();
        let activeCallsStarted = 0;
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                if ((body as { active?: boolean }).active) {
                    activeCallsStarted += 1;
                    if (activeCallsStarted === 4) allActiveCallsStarted.resolve();
                    await releaseActiveCalls.promise;
                }
                return { result: { ok: true } };
            },
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureRoute: (sessionId: string) => Promise<{
                client: McHostClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async (sessionId) => ({
            client,
            route,
            routeKey: `${sessionId}\0/workspace/project`,
            generation: 0,
        });
        const sessions = ["cap-a", "cap-b", "cap-c", "cap-d"];
        const activeCalls = sessions.map((sessionId) =>
            transport.call({
                sessionId,
                projectRoot: "/workspace/project",
                method: "session.status",
                body: { method: "session.status", active: true },
            }),
        );
        await allActiveCallsStarted.promise;
        const queuedCalls = sessions.flatMap((sessionId) =>
            Array.from({ length: 4 }, (_, index) =>
                transport.call({
                    sessionId,
                    projectRoot: "/workspace/project",
                    method: "session.status",
                    body: { method: "session.status", index },
                }),
            ),
        );

        await expect(
            transport.call({
                sessionId: sessions[0],
                projectRoot: "/workspace/project",
                method: "session.status",
                body: { method: "session.status", overflow: true },
            }),
        ).rejects.toMatchObject({ code: "EBUSY" });

        releaseActiveCalls.resolve();
        await Promise.all([...activeCalls, ...queuedCalls]);
    });

    it("keeps wrapup and live status calls beyond a 20-second round without raising the generic deadline", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let releaseWrapup: (() => void) | undefined;
        let markWrapupStarted: (() => void) | undefined;
        const wrapupStarted = new Promise<void>((resolve) => {
            markWrapupStarted = resolve;
        });
        const observedTimeouts = new Map<string, number>();
        const client = {
            request: async (_route: RouteHandle, body: unknown, options: { timeoutMs: number }) => {
                const method = (body as { method: string }).method;
                observedTimeouts.set(method, options.timeoutMs);
                if (method === "session.wrapup") {
                    markWrapupStarted?.();
                    await new Promise<void>((resolve) => {
                        releaseWrapup = resolve;
                    });
                }
                return { result: { ok: true } };
            },
        } as unknown as McHostClient;
        const internals = transport as unknown as {
            client: McHostClient | null;
            ensureRoute: () => Promise<{
                client: McHostClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async () => ({
            client,
            route,
            routeKey: "session-wrapup\0/workspace/project",
            generation: 0,
        });

        const wrapup = transport.call({
            sessionId: "session-wrapup",
            projectRoot: "/workspace/project",
            method: "session.wrapup",
            body: { method: "session.wrapup", v: 1 },
        });
        await wrapupStarted;
        const status = transport.call({
            sessionId: "session-wrapup",
            projectRoot: "/workspace/project",
            method: "session.status",
            body: { method: "session.status", v: 1 },
        });
        releaseWrapup?.();
        await expect(wrapup).resolves.toEqual({ result: { ok: true } });
        await expect(status).resolves.toEqual({ result: { ok: true } });
        await transport.call({
            sessionId: "session-generic",
            projectRoot: "/workspace/project",
            method: "session.flush",
            body: { method: "session.flush", v: 1 },
        });

        expect(observedTimeouts.get("session.wrapup")).toBeGreaterThan(20_000);
        expect(observedTimeouts.get("session.status")).toBeGreaterThan(20_000);
        expect(observedTimeouts.get("session.flush")).toBeLessThanOrEqual(15_000);
    });

    it("does not reuse a route cached under an earlier connection generation", async () => {
        const transport = new McHostModuleTransport("unused-connection-file");
        const oldRoute = { channel: 7, epoch: 77 } as RouteHandle;
        const newRoute = { channel: 8, epoch: 88 } as RouteHandle;
        let routeOpenCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenCount += 1;
                return newRoute;
            },
        } as unknown as McHostClient;
        const projectRoot = "/module-transport-generation-test-root";
        const routeKey = `session-generation\0${projectRoot}`;
        const internals = transport as unknown as {
            client: McHostClient | null;
            connectionGeneration: number;
            routes: Map<string, { route: RouteHandle; generation: number }>;
            ensureRoute: (
                sessionId: string,
                rawProjectRoot: string,
            ) => Promise<{ route: RouteHandle; generation: number }>;
        };
        internals.client = client;
        internals.connectionGeneration = 1;
        internals.routes.set(routeKey, { route: oldRoute, generation: 0 });

        const ensured = await internals.ensureRoute("session-generation", projectRoot);

        expect(routeOpenCount).toBe(1);
        expect(ensured.route).toBe(newRoute);
        expect(ensured.generation).toBe(1);
        expect(internals.routes.get(routeKey)).toEqual({ route: newRoute, generation: 1 });
    });
});

async function nthConnection(peer: FakePeer, n: number): Promise<FakePeerConnection> {
    await waitUntil(() => peer.connections.length >= n);
    return peer.connections[n - 1] as FakePeerConnection;
}

describe("beforeDeadline orphan safety", () => {
    it("a request rejecting after the deadline lost the race never raises an unhandled rejection", async () => {
        const transport = new McHostModuleTransport("/nonexistent-connection-file");
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => {
            unhandled.push(error);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            let rejectLater: ((error: Error) => void) | undefined;
            const operation = new Promise<never>((_resolve, reject) => {
                rejectLater = reject;
            });
            const beforeDeadline = (
                transport as unknown as {
                    beforeDeadline(
                        op: Promise<never>,
                        deadline: Deadline,
                        detail: string,
                    ): Promise<never>;
                }
            ).beforeDeadline.bind(transport);
            // Deadline already passed relative to the operation: the race loses immediately.
            await expect(beforeDeadline(operation, Deadline.start(5), "test")).rejects.toThrow();
            // The abandoned operation now rejects — exactly what close() does to
            // every pending request when a connection is invalidated.
            rejectLater?.(new Error("client closed"));
            // Give the runtime a macrotask to surface an unhandled rejection if any.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(unhandled).toHaveLength(0);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
