/**
 * Runtime-neutral fresh-generation re-upgrade scenarios (U3, R9-R11).
 *
 * Each scenario drives a real `McHostClient` against the independent
 * `FakePeer` plus the in-process fake paired provider using
 * `node:assert/strict` only — no bun:test — so the same key scenarios also
 * execute under Node 24 through `run-mc-host-client-node.ts`.
 * `shm-recovery.test.ts` wraps every scenario in a bun test and adds
 * bun-specific cases on top.
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

/** Tracked peers/clients/tmp files, torn down after each scenario. */
export interface RecoveryContext {
    startPeer(options?: Parameters<typeof FakePeer.start>[0]): Promise<FakePeer>;
    connect(peer: FakePeer, overrides?: Partial<McHostClientOptions>): Promise<McHostClient>;
    /** Path of the connection file written by the most recent `connect`. */
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
// Shared wire helpers (peer-side scripting, never production encoders).
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
 * Script every `transport.negotiate` across ALL connections in accept
 * order: `bodies(index)` returns the response body for the index-th
 * negotiation, or `null` to stay silent.
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

/** Default provider-host script serving managed routes on channel 5. */
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

/** Runs `turns` `setImmediate` turns without timer delays. */
export async function settle(turns = 10): Promise<void> {
    for (let index = 0; index < turns; index++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

// ----------------------------------------------------------------------
// Key scenarios (each maps to one or more U3 test-scenario bullets).
// ----------------------------------------------------------------------

export const shmRecoveryScenarios: readonly RecoveryScenario[] = [
    {
        // AE7/R9-R10: commit TCP with `unavailable`, serve managed and raw
        // traffic, retry repeated unavailable, then commit shared memory
        // before the original deadline; only later managed calls move.
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
            // while shadow attempts keep failing with repeated unavailable.
            const rawHandle = await client.routeOpen(TOOL_TARGET, IDENTITY);
            assert.deepEqual(await client.request(rawHandle, { n: 1 }), { served: "tcp" });
            assert.deepEqual(await client.call("magic-context", "m1"), { served: "tcp" });
            await waitUntil(() => peer.connections.length >= 2, 10_000);

            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);
            assert.equal(events.filter((e) => e.type === "retired").length, 0);

            // New managed acquisitions route through the promoted
            // shared-memory generation only.
            assert.deepEqual(await client.call("magic-context", "m2"), { served: "shm" });
            assert.ok(
                provider.host.frames.some(
                    (f) => f.header.ty === PeerFrameType.Request && f.header.channel === 5,
                ),
            );

            // The raw TCP handle stays usable on its own generation until
            // its explicit close (R10); the predecessor retires only after
            // its pending set and route set are both empty.
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
        // Seeded-defect detector for the pending-zero/continuation race: a
        // route.open terminal empties the predecessor's pending set BEFORE
        // the awaiting continuation records the handle in `liveRoutes`, so
        // retirement must defer until the continuation completes and the
        // caller's raw handle serves until its explicit close (R10).
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

            // Withhold the route.open response so the open is still
            // in flight when promotion turns conn1 into the predecessor.
            const pendingOpen = client.routeOpen(TOOL_TARGET, IDENTITY);
            await conn1.waitFor(() =>
                conn1.frames.some((frame) => isControlOp(frame, "route.open")),
            );
            const openFrame = conn1.frames.find((frame) =>
                isControlOp(frame, "route.open"),
            ) as PeerFrame;

            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);

            // Serve later routed requests on the granted channel.
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

            // The terminal lands while conn1 is the draining predecessor:
            // its arrival reaches pending-zero before the routeOpen
            // continuation resumes, which must not retire the generation
            // out from under the handle.
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
        // Seeded-defect detector for the terminal-lease/retirement race: a
        // binary response settles its terminal and empties the
        // predecessor's pending set BEFORE the awaiting requestBinary
        // continuation receives the ReceiveLease, and retirement
        // force-releases every channel lease, so a pending-zero retirement
        // with no live routes would hand the caller an already-released
        // lease. The drain must stay open until the caller releases it.
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

            // Open the raw route while conn1 is primary, then withhold the
            // binary response so the request is pending across promotion.
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

            // Close the last raw route while the request is still pending:
            // the pending entry alone now holds the drain open.
            await client.closeRoute(rawHandle);
            assert.equal(conn1.socket.destroyed, false);

            // The binary terminal lands on the draining predecessor: its
            // arrival reaches pending-zero before the requestBinary
            // continuation resumes, which must not retire the generation
            // out from under the lease it just handed to the caller.
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
        // AE9/AE15: daemon restart retires old pending work with its
        // existing outcome classification, reconnects over exact
        // `unavailable`, and a fresh commit serves only later managed calls.
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

            // Publish a marked body, then kill the daemon connection before
            // any terminal: the pending entry must classify outcome_unknown
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

            // Recovery promotes a fresh shared-memory generation; only
            // LATER managed calls move to it.
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
        // R11: every non-`unavailable` selection starts no automatic probe.
        // The fallback vocabulary is closed to `unavailable` and
        // `capability_version_mismatch` (§7.7.3); any other reason string is
        // malformed and fails closed before probe logic can even observe it.
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
                    // The injected `sleep` increments `paces` so the test
                    // can assert that no recovery attempt was paced.
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
            // The legacy terminal (exact `unsupported_operation`) is not
            // fallback evidence (§7.7.3): negotiation fails closed with no
            // same-generation TCP continuation and no recovery probe.
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
        // KTD5 seeded-defect detector: the fake clock proves attempts stop
        // at the 30-second episode deadline despite every shadow selection
        // returning `unavailable` (a reset deadline would dial forever).
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
        // KTD6 seeded-defect detector: a permanent connection-file failure
        // (malformed content) stops the recovery episode instead of
        // rereading the invalid file until the 30-second deadline.
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

            // Permanent validation evidence, not discovery churn: probe
            // attempts must stop instead of pacing to the full deadline.
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
