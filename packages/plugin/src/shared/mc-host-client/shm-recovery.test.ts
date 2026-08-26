/**
 * Fresh-generation TCP-to-shared-memory re-upgrade suite (U3, R9-R11).
 *
 * The runtime-neutral key scenarios in
 * `test-support/shm-recovery-scenarios.ts` run here under bun AND under
 * Node 24 through `scripts/run-mc-host-client-adversarial.ts`. The cases
 * below are bun-only detail coverage: promotion fencing, predecessor drain
 * ordering, permit accounting, and probe-stop classification.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SubcClient, type SubcClientOptions, type SubcDiagnosticsEvent } from "./client";
import {
    encodePeerFrame,
    FakePeer,
    type FakePeerConnection,
    type PeerFrame,
    PeerFrameType,
} from "./test-support/fake-peer";
import {
    grantSelectionBody,
    RECOVERY_GRANT_TOKEN,
    type RecoveryScenario,
    recoveryProvider,
    runRecoveryScenario,
    scriptNegotiations,
    serveTcpRoutes,
    settle,
    shmRecoveryScenarios,
    tcpSelectionBody,
} from "./test-support/shm-recovery-scenarios";
import {
    candidateAutoResponder,
    createFakePairedProvider,
    waitUntil,
    writeConnectionFile,
} from "./test-support/test-util";
import type { BindIdentity, RouteTarget } from "./types";

const IDENTITY: BindIdentity = {
    project_root: "/workspace/project",
    harness: "opencode",
    session: "recovery-bun",
};
const TOOL_TARGET: RouteTarget = { kind: "tool_provider", module_id: "magic-context" };

describe("shm re-upgrade key scenarios (runtime-neutral)", () => {
    for (const scenario of shmRecoveryScenarios) {
        test(scenario.name, async () => {
            await runRecoveryScenario(scenario as RecoveryScenario);
        }, 20_000);
    }
});

interface Harness {
    peer: FakePeer;
    client: SubcClient;
    events: SubcDiagnosticsEvent[];
    cleanup(): Promise<void>;
}

async function connectHarness(
    peerSetup: (peer: FakePeer) => void,
    overrides: Partial<SubcClientOptions> = {},
): Promise<Harness> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc-shm-recovery-bun-"));
    const peer = await FakePeer.start();
    peerSetup(peer);
    const filePath = path.join(tmpDir, "conn.json");
    await writeConnectionFile(filePath, peer);
    const events: SubcDiagnosticsEvent[] = [];
    const client = await SubcClient.connect({
        connectionFile: filePath,
        shutdownDeadlineMs: 1_000,
        identity: IDENTITY,
        diagnostics: (event) => events.push(event),
        ...overrides,
    });
    return {
        peer,
        client,
        events,
        async cleanup() {
            await client.closeAsync().catch(() => {});
            await peer.close();
            await rm(tmpDir, { recursive: true, force: true });
        },
    };
}

function connectedTransports(events: SubcDiagnosticsEvent[]): string[] {
    return events.filter((e) => e.type === "connected").map((e) => e.transport ?? "");
}

function liveTcpConnections(peer: FakePeer): number {
    return peer.connections.filter((conn) => !conn.socket.destroyed).length;
}

describe("shm re-upgrade drain and fencing (bun)", () => {
    test("predecessor retires only at pending-zero with all raw routes closed", async () => {
        const provider = recoveryProvider();
        let allowGrant = false;
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index) =>
                    index === 0 || !allowGrant
                        ? tcpSelectionBody("unavailable")
                        : grantSelectionBody(),
                );
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, client, events } = harness;
            const conn1 = peer.connections[0] as FakePeerConnection;
            const stopServing = serveTcpRoutes(conn1, 7);
            const rawHandle = await client.routeOpen(TOOL_TARGET, IDENTITY);

            // A withheld raw response keeps the predecessor pending set
            // nonempty across promotion.
            stopServing();
            const pendingRaw = client.request(rawHandle, { hold: true }, { timeoutMs: 8_000 });
            pendingRaw.catch(() => {});
            await conn1.waitFor(() =>
                conn1.frames.some((f) => f.channel === 7 && f.ty === PeerFrameType.Request),
            );
            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);

            // Route closed but request still pending: no retirement.
            await client.closeRoute(rawHandle);
            await delay(100);
            expect(conn1.socket.destroyed).toBe(false);
            expect(
                conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 0),
            ).toBe(false);

            // The old pending request completes on its own generation
            // with exactly one terminal; pending-zero then retires the
            // predecessor.
            const requestFrame = conn1.frames.find(
                (f) => f.channel === 7 && f.ty === PeerFrameType.Request,
            ) as PeerFrame;
            conn1.socket.write(
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    channel: 7,
                    epoch: 1,
                    corr: requestFrame.corr,
                    body: Buffer.from(JSON.stringify({ served: "tcp-late" }), "utf8"),
                }),
            );
            expect(await pendingRaw).toEqual({ served: "tcp-late" });
            await waitUntil(
                () => conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 0),
                5_000,
            );
            // No duplicate of the held body ever reaches shared memory.
            const providerText = provider.host.frames
                .map((f) => Buffer.from(f.body).toString("utf8"))
                .join("\n");
            expect(providerText).not.toContain("hold");
        } finally {
            await harness.cleanup();
        }
    }, 20_000);

    test("an in-flight managed call settles on the predecessor and its orphaned route closes at pending-zero", async () => {
        const provider = recoveryProvider();
        let allowGrant = false;
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index) =>
                    index === 0 || !allowGrant
                        ? tcpSelectionBody("unavailable")
                        : grantSelectionBody(),
                );
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, client, events } = harness;
            const conn1 = peer.connections[0] as FakePeerConnection;
            // Serve route.open manually, withhold the managed response.
            const openFramePromise = conn1.waitFor(() =>
                conn1.frames.some((f) => {
                    if (f.ty !== PeerFrameType.Request || f.channel !== 0) return false;
                    try {
                        return (
                            (JSON.parse(f.body.toString("utf8")) as { op?: unknown }).op ===
                            "route.open"
                        );
                    } catch {
                        return false;
                    }
                }),
            );
            const managedCall = client.call("magic-context", "held", undefined, {
                timeoutMs: 8_000,
            });
            managedCall.catch(() => {});
            await openFramePromise;
            const open = conn1.frames.find(
                (f) => f.ty === PeerFrameType.Request && f.channel === 0 && f.corr >= 2n,
            ) as PeerFrame;
            conn1.socket.write(
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    corr: open.corr,
                    body: Buffer.from(
                        JSON.stringify({
                            op: "route.open",
                            route_channel: 9,
                            route_epoch: 1,
                        }),
                        "utf8",
                    ),
                }),
            );
            await conn1.waitFor(() =>
                conn1.frames.some((f) => f.channel === 9 && f.ty === PeerFrameType.Request),
            );
            allowGrant = true;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);
            // Predecessor still open: managed terminal not yet observed.
            expect(conn1.socket.destroyed).toBe(false);
            const body = conn1.frames.find(
                (f) => f.channel === 9 && f.ty === PeerFrameType.Request,
            ) as PeerFrame;
            conn1.socket.write(
                encodePeerFrame({
                    ty: PeerFrameType.Response,
                    channel: 9,
                    epoch: 1,
                    corr: body.corr,
                    body: Buffer.from(JSON.stringify({ served: "tcp" }), "utf8"),
                }),
            );
            expect(await managedCall).toEqual({ served: "tcp" });
            // Pending-zero closes the orphaned managed route (route
            // Goodbye on channel 9) and then the whole predecessor.
            await waitUntil(
                () =>
                    conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 9) &&
                    conn1.frames.some((f) => f.ty === PeerFrameType.Goodbye && f.channel === 0),
                5_000,
            );
            // A later managed call reopens on shared memory only.
            expect(await client.call("magic-context", "after")).toEqual({ served: "shm" });
        } finally {
            await harness.cleanup();
        }
    }, 20_000);

    test("an occupied predecessor slot defers the next promotion without forcing closes", async () => {
        const provider = recoveryProvider();
        let grantEnabled = true;
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index) => {
                    if (index === 0) return tcpSelectionBody("unavailable");
                    return grantEnabled ? grantSelectionBody() : tcpSelectionBody("unavailable");
                });
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, client, events } = harness;
            const conn1 = peer.connections[0] as FakePeerConnection;
            serveTcpRoutes(conn1, 7);
            const rawHandle = await client.routeOpen(TOOL_TARGET, IDENTITY);
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 10_000);

            // Retire the shm primary while the raw handle keeps the
            // predecessor occupied; the reconnect commits unavailable
            // TCP and starts a second episode that must wait.
            grantEnabled = false;
            const acceptedBefore = peer.connections.length;
            provider.host.close();
            const call = client.call("magic-context", "during-episode-2", undefined, {
                timeoutMs: 10_000,
            });
            call.catch(() => {});
            await waitUntil(() => peer.connections.length >= acceptedBefore + 1, 10_000);
            const conn2 = peer.connections[acceptedBefore] as FakePeerConnection;
            serveTcpRoutes(conn2, 11);
            expect(await call).toEqual({ served: "tcp" });

            // While the predecessor slot is occupied no shadow dial
            // happens (permits stay at primary+predecessor), and the
            // raw handle is never forced closed.
            await delay(300);
            expect(peer.connections.length).toBe(acceptedBefore + 1);
            expect(liveTcpConnections(peer)).toBeLessThanOrEqual(3);
            expect(await client.request(rawHandle, { still: "alive" })).toEqual({
                served: "tcp",
            });

            // Freeing the slot lets the deferred episode dial and
            // promote a fresh generation.
            grantEnabled = true;
            await client.closeRoute(rawHandle);
            await waitUntil(
                () => connectedTransports(events).filter((t) => t === "fake.shm").length >= 2,
                15_000,
            );
            expect(await client.call("magic-context", "after-episode-2")).toEqual({
                served: "shm",
            });
            // Permit bound across the whole flow: primary, predecessor,
            // and one shadow at most.
            expect(liveTcpConnections(peer)).toBeLessThanOrEqual(3);
        } finally {
            await harness.cleanup();
        }
    }, 25_000);

    test("a stale shadow success racing primary retirement cannot publish and returns its permits", async () => {
        const provider = createFakePairedProvider();
        // The shadow attaches and activates, but its commit response is
        // withheld until the test has retired the primary — the held
        // commit is the stale success.
        let heldCommit: bigint | undefined;
        const auto = candidateAutoResponder(RECOVERY_GRANT_TOKEN);
        provider.host.onFrame = (frame, host) => {
            let op: unknown;
            try {
                op = (JSON.parse(Buffer.from(frame.body).toString("utf8")) as { op?: unknown }).op;
            } catch {
                op = undefined;
            }
            if (op === "transport.commit") {
                heldCommit = frame.header.corr;
                return;
            }
            auto(frame, host);
        };
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index) =>
                    index === 0 ? tcpSelectionBody("unavailable") : grantSelectionBody(),
                );
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, client, events } = harness;
            const conn1 = peer.connections[0] as FakePeerConnection;
            await waitUntil(() => heldCommit !== undefined, 10_000);
            // The shadow candidate attached before the race: the permit
            // and channel-close assertions below always apply.
            expect(provider.connectCount).toBeGreaterThan(0);
            conn1.destroy();
            await waitUntil(() => events.some((e) => e.type === "retired"), 5_000);
            // Retirement cancels the episode and retires the shadow.
            await waitUntil(() => provider.host.channelClosed, 5_000);
            provider.host.respondJson(heldCommit as bigint, {
                op: "transport.commit",
                negotiation_version: 1,
            });
            await settle();
            expect(connectedTransports(events)).not.toContain("fake.shm");
            await waitUntil(() => liveTcpConnections(peer) === 0, 5_000);
            void client;
        } finally {
            await harness.cleanup();
        }
    }, 20_000);

    test("owner close cancels shadow publication before closing primary and predecessor", async () => {
        const provider = createFakePairedProvider();
        provider.host.onFrame = candidateAutoResponder(RECOVERY_GRANT_TOKEN);
        let releaseGrant: (() => void) | undefined;
        const grantHeld = new Promise<void>((resolve) => {
            releaseGrant = resolve;
        });
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index, frame, conn) => {
                    if (index === 0) return tcpSelectionBody("unavailable");
                    void grantHeld.then(() => {
                        conn.socket.write(
                            encodePeerFrame({
                                ty: PeerFrameType.Response,
                                corr: frame.corr,
                                body: Buffer.from(JSON.stringify(grantSelectionBody()), "utf8"),
                            }),
                        );
                    });
                    return null;
                });
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, client, events } = harness;
            await waitUntil(() => peer.connections.length >= 2, 10_000);
            const closePromise = client.closeAsync();
            releaseGrant?.();
            await closePromise;
            await delay(200);
            expect(connectedTransports(events)).not.toContain("fake.shm");
            await waitUntil(() => liveTcpConnections(peer) === 0, 5_000);
        } finally {
            await harness.cleanup();
        }
    }, 20_000);

    test("a post-grant failure during a shadow attempt stops the episode permanently", async () => {
        // The provider host rejects activation (token mismatch): grant
        // attachment succeeded but activation fails, which must stop
        // recovery for the episode without extending any deadline.
        const provider = createFakePairedProvider();
        provider.host.onFrame = candidateAutoResponder("ffffffffffffffffffffffffffffffff");
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index) =>
                    index === 0 ? tcpSelectionBody("unavailable") : grantSelectionBody(),
                );
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, events } = harness;
            await waitUntil(() => provider.connectCount >= 1, 10_000);
            // The activation error retires the candidate; the closed
            // channel marks the failure processed, and the settle turns
            // let the episode's stop decision run to completion.
            await waitUntil(() => provider.host.channelClosed, 10_000);
            await settle();
            const settled = peer.connections.length;
            await settle();
            expect(peer.connections.length).toBe(settled);
            expect(provider.connectCount).toBe(1);
            expect(connectedTransports(events)).not.toContain("fake.shm");
        } finally {
            await harness.cleanup();
        }
    }, 20_000);

    test("shadow permits are bounded at three and returned on failure", async () => {
        const provider = recoveryProvider();
        const maxLive: number[] = [];
        const harness = await connectHarness(
            (peer) => {
                scriptNegotiations(peer, (index) => {
                    maxLive.push(liveTcpConnections(peer));
                    return index < 3 ? tcpSelectionBody("unavailable") : grantSelectionBody();
                });
            },
            { transportProviders: [provider] },
        );
        try {
            const { peer, events } = harness;
            await waitUntil(() => connectedTransports(events).includes("fake.shm"), 15_000);
            // One primary plus at most one shadow before any
            // predecessor exists; never more than three overall.
            expect(Math.max(...maxLive)).toBeLessThanOrEqual(3);
            // Every failed shadow's connection permit was returned.
            await waitUntil(() => liveTcpConnections(peer) <= 1, 5_000);
        } finally {
            await harness.cleanup();
        }
    }, 20_000);
});
