/**
 * These scenarios exercise runtime-neutral fresh-generation re-upgrades.
 *
 * Each scenario runs a real `McHostClient` against an independent `FakePeer` and an in-process fake paired provider using only `node:assert/strict`.
 * `run-mc-host-client-node.ts` also runs these scenarios under Node 24.
 * `shm-recovery.test.ts` wraps each scenario in a Bun test and adds Bun-specific cases.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    DEFAULT_RECOVERY_DEADLINE_MS,
    McHostClient,
    type McHostClientOptions,
    type McHostDiagnosticsEvent,
} from "../client";
import type { BindIdentity, RouteTarget } from "../types";
import {
    encodePeerFrame,
    FakePeer,
    type FakePeerConnection,
    type PeerFrame,
    PeerFrameType,
} from "./fake-peer";
import {
    candidateAutoResponder,
    createFakePairedProvider,
    type FakePairedProvider,
    waitUntil,
    writeConnectionFile,
} from "./test-util";

export const RECOVERY_GRANT_TOKEN = "00112233445566778899aabbccddeeff";

const IDENTITY: BindIdentity = {
    project_root: "/workspace/project",
    harness: "opencode",
    session: "recovery-1",
};
const TOOL_TARGET: RouteTarget = { kind: "tool_provider", module_id: "magic-context" };

export interface RecoveryScenario {
    name: string;
    run(ctx: RecoveryContext): Promise<void>;
}

/* */
export interface RecoveryContext {
    startPeer(options?: Parameters<typeof FakePeer.start>[0]): Promise<FakePeer>;
    connect(peer: FakePeer, overrides?: Partial<McHostClientOptions>): Promise<McHostClient>;
    /* */
    lastConnectionFile: string;
}

export async function runRecoveryScenario(scenario: RecoveryScenario): Promise<void> {
    const peers: FakePeer[] = [];
    const clients: McHostClient[] = [];
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc-shm-recovery-"));
    let fileCounter = 0;
    const ctx: RecoveryContext = {
        lastConnectionFile: "",
        async startPeer(options = {}) {
            const peer = await FakePeer.start(options);
            peers.push(peer);
            return peer;
        },
        async connect(peer, overrides = {}) {
            fileCounter += 1;
            const filePath = path.join(tmpDir, `conn-${fileCounter}.json`);
            await writeConnectionFile(filePath, peer);
            ctx.lastConnectionFile = filePath;
            const client = await McHostClient.connect({
                connectionFile: filePath,
                shutdownDeadlineMs: 1_000,
                identity: IDENTITY,
                ...overrides,
            });
            clients.push(client);
            return client;
        },
    };
    try {
        await scenario.run(ctx);
    } finally {
        for (const client of clients) {
            await client.closeAsync().catch(() => {});
        }
        for (const peer of peers) {
            await peer.close();
        }
        await rm(tmpDir, { recursive: true, force: true });
    }
}

// ----------------------------------------------------------------------
// The shared helpers script peer-side frames and do not encode production traffic.
// ----------------------------------------------------------------------

export function tcpSelectionBody(reason?: string): Record<string, unknown> {
    return {
        op: "transport.negotiate",
        negotiation_version: 1,
        selected: { transport: "tcp", capability_version: 1 },
        ...(reason !== undefined ? { reason } : {}),
    };
}

export function grantSelectionBody(transport = "fake.shm"): Record<string, unknown> {
    return {
        op: "transport.negotiate",
        negotiation_version: 1,
        selected: { transport, capability_version: 1 },
        activation_token: RECOVERY_GRANT_TOKEN,
        descriptor: {},
    };
}

function respondJson(conn: FakePeerConnection, corr: bigint, value: unknown): void {
    conn.socket.write(
        encodePeerFrame({
            ty: PeerFrameType.Response,
            corr,
            body: Buffer.from(JSON.stringify(value), "utf8"),
        }),
    );
}

/**
 * The helper scripts every `transport.negotiate` across all connections in accept order; `bodies(index)` returns the response body for negotiation `index` or `null` to suppress its response.
 */
export function scriptNegotiations(
    peer: FakePeer,
    bodies: (index: number, frame: PeerFrame, conn: FakePeerConnection) => unknown,
): () => number {
    let index = 0;
    peer.negotiateMode = (frame, conn) => {
        const body = bodies(index, frame, conn);
        index += 1;
        if (body === null) return;
        respondJson(conn, frame.corr, body);
    };
    return () => index;
}

function isControlOp(frame: PeerFrame, op: string): boolean {
    if (frame.ty !== PeerFrameType.Request || frame.channel !== 0) return false;
    try {
        return (JSON.parse(frame.body.toString("utf8")) as { op?: unknown }).op === op;
    } catch {
        return false;
    }
}

/** Stopping suppresses route responses without removing the socket data listener. */
export function serveTcpRoutes(conn: FakePeerConnection, firstChannel: number): () => void {
    let seen = 0;
    let stopped = false;
    let nextChannel = firstChannel;
    const channels = new Set<number>();
    const poll = (): void => {
        if (stopped) return;
        for (; seen < conn.frames.length; seen++) {
            const frame = conn.frames[seen] as PeerFrame;
            if (isControlOp(frame, "route.open")) {
                const channel = nextChannel;
                nextChannel += 1;
                channels.add(channel);
                respondJson(conn, frame.corr, {
                    op: "route.open",
                    route_channel: channel,
                    route_epoch: 1,
                });
            } else if (frame.ty === PeerFrameType.Request && channels.has(frame.channel)) {
                conn.socket.write(
                    encodePeerFrame({
                        ty: PeerFrameType.Response,
                        channel: frame.channel,
                        epoch: 1,
                        corr: frame.corr,
                        body: Buffer.from(JSON.stringify({ served: "tcp" }), "utf8"),
                    }),
                );
            }
        }
    };
    conn.socket.on("data", () => setImmediate(poll));
    poll();
    return () => {
        stopped = true;
    };
}

/** The default provider-host script serves managed routes on channel 5. */
export function recoveryProvider(): FakePairedProvider {
    const provider = createFakePairedProvider();
    provider.host.onFrame = candidateAutoResponder(RECOVERY_GRANT_TOKEN, (frame, host) => {
        let parsed: { op?: unknown } | undefined;
        try {
            parsed = JSON.parse(Buffer.from(frame.body).toString("utf8")) as { op?: unknown };
        } catch {
            parsed = undefined;
        }
        if (parsed?.op === "route.open") {
            host.respondJson(frame.header.corr, {
                op: "route.open",
                route_channel: 5,
                route_epoch: 1,
            });
            return;
        }
        if (frame.header.channel === 5) {
            host.send(
                {
                    ty: PeerFrameType.Response,
                    flags: 0,
                    channel: 5,
                    epoch: 1,
                    corr: frame.header.corr,
                },
                Buffer.from(JSON.stringify({ served: "shm" }), "utf8"),
            );
        }
    });
    return provider;
}

function connectedTransports(events: McHostDiagnosticsEvent[]): string[] {
    return events.filter((e) => e.type === "connected").map((e) => e.transport ?? "");
}

/** The helper executes `turns` `setImmediate` turns without timer delays. */
export async function settle(turns = 10): Promise<void> {
    for (let index = 0; index < turns; index++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

// ----------------------------------------------------------------------
// ----------------------------------------------------------------------

export const shmRecoveryScenarios: readonly RecoveryScenario[] = [
    {
        // The scenario commits TCP with `unavailable`, serves managed and raw traffic, retries repeated `unavailable`, then commits shared memory before the original deadline; only managed calls opened afterward use shared memory.
        name: "unavailable TCP re-upgrades to shared memory while old traffic drains",
        async run(ctx) {
            const provider = recoveryProvider();
            const peer = await ctx.startPeer();
            let allowGrant = false;
            scriptNegotiations(peer, (index) => {
                if (index === 0) return tcpSelectionBody("unavailable");
                return allowGrant ? grantSelectionBody() : tcpSelectionBody("unavailable");
            });
            const events: McHostDiagnosticsEvent[] = [];
            const client = await ctx.connect(peer, {
                transportProviders: [provider],
                diagnostics: (event) => events.push(event),
            });
            const conn1 = peer.connections[0] as FakePeerConnection;
            serveTcpRoutes(conn1, 7);

            // Managed and raw traffic complete on the committed TCP primary
            // Shadow attempts keep failing with repeated `unavailable`.
            const rawHandle = await client.routeOpen(TOOL_TARGET, IDENTITY);
            assert.deepEqual(await client.request(rawHandle, { n: 1 }), { served: "tcp" });
            assert.deepEqual(await client.call("magic-context", "m1"), { served: "tcp" });
            await waitUntil(() => peer.connections.length >= 2, 10_000);

            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);
            assert.equal(events.filter((e) => e.type === "retired").length, 0);

            // New managed acquisitions route only through the promoted shared-memory generation.
            assert.deepEqual(await client.call("magic-context", "m2"), { served: "shm" });
            assert.ok(
                provider.host.frames.some(
                    (f) => f.header.ty === PeerFrameType.Request && f.header.channel === 5,
                ),
            );

            // The raw TCP handle remains usable on its generation until explicit close; the predecessor retires only after both its pending set and route set are empty.
            assert.deepEqual(await client.request(rawHandle, { n: 2 }), { served: "tcp" });
            assert.equal(conn1.socket.destroyed, false);
            await client.closeRoute(rawHandle);
            await waitUntil(
                () => conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 0),
                10_000,
            );
        },
    },
    {
        // A `route.open` terminal can empty the predecessor's pending set before its awaiting continuation records the handle in `liveRoutes`; retirement must wait for that continuation, and the raw handle remains usable until explicit close.
        name: "a route.open resolving during predecessor drain keeps the handle usable",
        async run(ctx) {
            const provider = recoveryProvider();
            const peer = await ctx.startPeer();
            let allowGrant = false;
            scriptNegotiations(peer, (index) => {
                if (index === 0) return tcpSelectionBody("unavailable");
                return allowGrant ? grantSelectionBody() : tcpSelectionBody("unavailable");
            });
            const events: McHostDiagnosticsEvent[] = [];
            const client = await ctx.connect(peer, {
                transportProviders: [provider],
                diagnostics: (event) => events.push(event),
            });
            const conn1 = peer.connections[0] as FakePeerConnection;

            // The test withholds `route.open` so promotion makes `conn1` the predecessor while `client.routeOpen` remains pending.
            const pendingOpen = client.routeOpen(TOOL_TARGET, IDENTITY);
            await conn1.waitFor(() =>
                conn1.frames.some((frame) => isControlOp(frame, "route.open")),
            );
            const openFrame = conn1.frames.find((frame) =>
                isControlOp(frame, "route.open"),
            ) as PeerFrame;

            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);

            const answered = new Set<bigint>();
            const serveChannel = (): void => {
                for (const frame of conn1.frames) {
                    if (
                        frame.ty !== PeerFrameType.Request ||
                        frame.channel !== 7 ||
                        answered.has(frame.corr)
                    ) {
                        continue;
                    }
                    answered.add(frame.corr);
                    conn1.socket.write(
                        encodePeerFrame({
                            ty: PeerFrameType.Response,
                            channel: 7,
                            epoch: 1,
                            corr: frame.corr,
                            body: Buffer.from(JSON.stringify({ served: "tcp" }), "utf8"),
                        }),
                    );
                }
            };
            conn1.socket.on("data", () => setImmediate(serveChannel));

            // A terminal can reach pending-zero while `conn1` is the draining predecessor before `routeOpen` resumes.
            // The `routeOpen` continuation must not retire the generation before returning the handle.
            respondJson(conn1, openFrame.corr, {
                op: "route.open",
                route_channel: 7,
                route_epoch: 1,
            });
            const rawHandle = await pendingOpen;
            await settle();

            assert.equal(conn1.socket.destroyed, false, "predecessor retired early");
            assert.deepEqual(await client.request(rawHandle, { n: 1 }), { served: "tcp" });

            // The explicit close releases the last drain obligation.
            await client.closeRoute(rawHandle);
            await waitUntil(
                () => conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 0),
                10_000,
            );
        },
    },
    {
        // A binary terminal can empty the predecessor's pending set before `requestBinary` receives its `ReceiveLease`; draining must retain the lease until the caller releases it.
        // Retirement force-releases each channel lease owned by the retiring generation.
        // A pending-zero retirement with no live routes can release a channel lease before the caller receives it.
        // The drain must remain open until the caller releases the `ReceiveLease`.
        name: "a binary response resolving during predecessor drain keeps its lease usable",
        async run(ctx) {
            const provider = recoveryProvider();
            const peer = await ctx.startPeer();
            let allowGrant = false;
            scriptNegotiations(peer, (index) => {
                if (index === 0) return tcpSelectionBody("unavailable");
                return allowGrant ? grantSelectionBody() : tcpSelectionBody("unavailable");
            });
            const events: McHostDiagnosticsEvent[] = [];
            const client = await ctx.connect(peer, {
                transportProviders: [provider],
                diagnostics: (event) => events.push(event),
            });
            const conn1 = peer.connections[0] as FakePeerConnection;

            // The test opens a raw route while `conn1` is primary and keeps the binary response pending across promotion.
            const stopServing = serveTcpRoutes(conn1, 7);
            const rawHandle = await client.routeOpen(TOOL_TARGET, IDENTITY);
            stopServing();
            const pendingBinary = client.requestBinary(rawHandle, new Uint8Array([1, 2, 3]));
            await conn1.waitFor(() =>
                conn1.frames.some(
                    (frame) => frame.ty === PeerFrameType.Request && frame.channel === 7,
                ),
            );

            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);

            // Closing the last raw route while the request remains pending leaves the pending entry as the drain obligation.
            await client.closeRoute(rawHandle);
            assert.equal(conn1.socket.destroyed, false);

            // A binary terminal can reach pending-zero on the draining predecessor before `requestBinary` resumes.
            // The `requestBinary` continuation must not retire the generation before returning its lease.
            const requestFrame = conn1.frames.find(
                (frame) => frame.ty === PeerFrameType.Request && frame.channel === 7,
            ) as PeerFrame;
            conn1.socket.write(
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    flags: 1, // FLAG_BINARY
                    channel: 7,
                    epoch: 1,
                    corr: requestFrame.corr,
                    body: Buffer.from([0xaa, 0xbb, 0xcc]),
                }),
            );
            const lease = await pendingBinary;
            await settle();

            assert.equal(conn1.socket.destroyed, false, "predecessor retired early");
            assert.equal(lease.isReleased(), false, "lease force-released during drain");
            const owned = lease.takeOwned();
            assert.deepEqual([...owned], [0xaa, 0xbb, 0xcc]);

            // The lease release was the last drain obligation.
            await waitUntil(
                () => conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 0),
                10_000,
            );
        },
    },
    {
        // After daemon restart, old pending work retains its outcome classification; reconnect uses exact `unavailable`, and a fresh commit serves only later managed calls.
        name: "daemon restart surfaces outcome_unknown once and never replays on the new generation",
        async run(ctx) {
            const provider = recoveryProvider();
            const peer = await ctx.startPeer();
            scriptNegotiations(peer, (index) => {
                if (index === 0) return tcpSelectionBody();
                if (index === 1) return tcpSelectionBody("unavailable");
                return grantSelectionBody();
            });
            const events: McHostDiagnosticsEvent[] = [];
            const client = await ctx.connect(peer, {
                transportProviders: [provider],
                diagnostics: (event) => events.push(event),
            });
            const conn1 = peer.connections[0] as FakePeerConnection;
            const stopServing = serveTcpRoutes(conn1, 7);
            const rawHandle = await client.routeOpen(TOOL_TARGET, IDENTITY);

            // If the connection closes before a terminal arrives, the pending entry must classify the outcome as `outcome_unknown` exactly once.
            // exactly once.
            stopServing();
            const pending = client.request(rawHandle, { marker: "replay-canary-77" });
            let surfaced = 0;
            const settled = pending.catch((error: unknown) => {
                surfaced += 1;
                return error;
            });
            await conn1.waitFor(() =>
                conn1.frames.some((f) => f.channel === 7 && f.ty === PeerFrameType.Request),
            );
            conn1.destroy();
            const error = (await settled) as { kind?: string };
            assert.equal(surfaced, 1);
            assert.equal(error.kind, "outcome_unknown");

            const call = client.call<{ served: string }>("magic-context", "after-restart");
            await waitUntil(() => peer.connections.length >= 2, 10_000);
            const conn2 = peer.connections[1] as FakePeerConnection;
            serveTcpRoutes(conn2, 21);
            assert.ok(["tcp", "shm"].includes((await call).served));

            // Recovery promotes a fresh shared-memory generation; only later managed calls use it.
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);
            assert.deepEqual(await client.call("magic-context", "later"), { served: "shm" });

            // The unknown-outcome body is never re-issued on ANY generation.
            const providerText = provider.host.frames
                .map((f) => Buffer.from(f.body).toString("utf8"))
                .join("\n");
            assert.ok(!providerText.includes("replay-canary-77"));
            const conn2Text = conn2.frames.map((f) => f.body.toString("utf8")).join("\n");
            assert.ok(!conn2Text.includes("replay-canary-77"));
        },
    },
    {
        // Only `unavailable` and `capability_version_mismatch` (§7.7.3) are fallback reasons; every other reason is malformed and fails closed before probe logic runs.
        name: "no other fallback reason or reasonless TCP starts a recovery probe",
        async run(ctx) {
            const reasons: (string | undefined)[] = [undefined, "capability_version_mismatch"];
            for (const reason of reasons) {
                const label = `reason=${reason ?? "none"}`;
                const provider = recoveryProvider();
                const peer = await ctx.startPeer();
                const negotiations = scriptNegotiations(peer, () => tcpSelectionBody(reason));
                let paces = 0;
                const client = await ctx.connect(peer, {
                    transportProviders: [provider],
                    // A zero `paces` count proves recovery did not invoke pacing.
                    sleep: async () => {
                        paces += 1;
                    },
                });
                serveTcpRoutes(peer.connections[0] as FakePeerConnection, 7);
                assert.deepEqual(
                    await client.call("magic-context", "m1"),
                    { served: "tcp" },
                    label,
                );
                await client.closeAsync();
                await settle();
                assert.equal(negotiations(), 1, label);
                assert.equal(peer.connections.length, 1, label);
                assert.equal(provider.connectCount, 0, label);
                assert.equal(paces, 0, label);
            }
            // The exact `unsupported_operation` terminal is not fallback evidence (§7.7.3); negotiation fails closed without a same-generation TCP continuation or recovery probe.
            const provider = recoveryProvider();
            const peer = await ctx.startPeer({ negotiate: "unsupported-op" });
            let paces = 0;
            let failure: unknown;
            try {
                await ctx.connect(peer, {
                    transportProviders: [provider],
                    sleep: async () => {
                        paces += 1;
                    },
                });
            } catch (error) {
                failure = error;
            }
            assert.ok(failure instanceof Error, "legacy terminal must fail closed");
            assert.equal((failure as { code?: string }).code, "host_negotiation_rejected");
            await settle();
            assert.equal(provider.connectCount, 0);
            assert.equal(paces, 0);
        },
    },
    {
        // Recovery attempts stop at the original 30-second episode deadline when every shadow selection returns `unavailable`.
        name: "recovery attempts stop at the original 30s deadline despite repeated unavailable",
        async run(ctx) {
            let now = 0;
            const clock = (): number => now;
            const sleep = async (ms: number): Promise<void> => {
                now += Math.max(1, ms);
                await delay(1);
            };
            const provider = recoveryProvider();
            const peer = await ctx.startPeer();
            scriptNegotiations(peer, () => tcpSelectionBody("unavailable"));
            const client = await ctx.connect(peer, {
                transportProviders: [provider],
                clock,
                sleep,
            });
            // The escalating pacer sums to the 30s window in bounded steps.
            await waitUntil(() => now >= DEFAULT_RECOVERY_DEADLINE_MS, 15_000);
            await client.closeAsync();
            await settle();
            const settledCount = peer.connections.length;
            await settle();
            assert.equal(peer.connections.length, settledCount);
            assert.ok(settledCount <= 25, `unbounded attempts: ${settledCount}`);
            assert.equal(provider.connectCount, 0);
        },
    },
    {
        // Malformed connection-file content ends the recovery episode instead of being reread until the 30-second deadline.
        name: "a permanently invalid connection file stops the recovery episode",
        async run(ctx) {
            let now = 0;
            const clock = (): number => now;
            const sleep = async (ms: number): Promise<void> => {
                now += Math.max(1, ms);
                await delay(1);
            };
            const provider = recoveryProvider();
            const peer = await ctx.startPeer();
            scriptNegotiations(peer, () => tcpSelectionBody("unavailable"));
            const client = await ctx.connect(peer, {
                transportProviders: [provider],
                clock,
                sleep,
            });
            serveTcpRoutes(peer.connections[0] as FakePeerConnection, 7);
            assert.deepEqual(await client.call("magic-context", "m1"), { served: "tcp" });

            // Permanent validation evidence stops probes instead of pacing until the episode deadline.
            await writeFile(ctx.lastConnectionFile, "{ not json", { mode: 0o600 });
            let pacedToDeadline = true;
            try {
                await waitUntil(() => now >= DEFAULT_RECOVERY_DEADLINE_MS, 1_000);
            } catch {
                pacedToDeadline = false;
            }
            assert.equal(
                pacedToDeadline,
                false,
                "recovery kept rereading a permanently invalid connection file",
            );
            // The committed TCP primary is untouched by the stopped episode.
            assert.deepEqual(await client.call("magic-context", "m2"), { served: "tcp" });
        },
    },
];
