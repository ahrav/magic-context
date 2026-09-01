/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../../features/magic-context/memory/storage-claim-current-state";
import { reserveProtectedTailDrainTokens } from "../../features/magic-context/storage-meta-persisted";
import { getPrimerCandidatesForProject } from "../../features/magic-context/storage-primers";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { getUserMemoryCandidates } from "../../features/magic-context/user-memory/storage-user-memory";
import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runCompartmentAgent } from "./compartment-runner";
import {
    type ProtectedTailBoundarySnapshot,
    resolveWrapupProtectedTailBoundary,
} from "./protected-tail-boundary";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

function createDb(): Database {
    return createDirectTestDatabase().db;
}

function projectClaims(db: Database, projectIdentity: string) {
    const result = readProjectMemoryCurrentState(db, {
        projectIds: resolveProjectIdsForIdentities(db, [projectIdentity]),
        lifecycleStates: ["active"],
        surface: "maintenance_hygiene",
        workspaceEpoch: "wrapup-test",
    });
    if (result.status !== "ok") throw new Error(result.reasons.join(", "));
    return result.items;
}

function rawMessages(count: number): RawMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} with enough content` }],
    }));
}

function withProviderMessages<T>(
    sessionId: string,
    messages: RawMessage[],
    fn: () => Promise<T>,
): Promise<T> {
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => messages,
        getMessageCount: () => messages.length,
    });
    return fn().finally(unregister);
}

function withProvider<T>(sessionId: string, count: number, fn: () => Promise<T>): Promise<T> {
    return withProviderMessages(sessionId, rawMessages(count), fn);
}

function alternatingMessages(count: number): RawMessage[] {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${index + 1} ${text} ${text} ${text}` }],
    }));
}

function completedArcMessages(): RawMessage[] {
    return [
        {
            ordinal: 1,
            id: "m-1",
            role: "user",
            parts: [{ type: "text", text: "Inspect the failing flow." }],
        },
        {
            ordinal: 2,
            id: "m-2",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "wrapup-call",
                    state: { input: { path: "src/flow.ts" } },
                },
            ],
        },
        {
            ordinal: 3,
            id: "m-3",
            role: "user",
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "wrapup-call",
                    state: { output: "flow contents" },
                },
            ],
        },
        {
            ordinal: 4,
            id: "m-4",
            role: "assistant",
            parts: [{ type: "text", text: "Applied the fix." }],
        },
        {
            ordinal: 5,
            id: "m-5",
            role: "user",
            parts: [{ type: "text", text: "Keep this live tail." }],
        },
    ];
}

function historianXml(): string {
    return `<output>
<compartments>
<compartment start="1" end="1" title="Wrapped" episode_type="debug" importance="50">
<p1>Detailed wrapup.</p1><p2>Short wrapup.</p2><p3>Tiny wrapup.</p3><p4>wrapup</p4>
</compartment>
</compartments>
<facts><PROJECT_RULES>
* Keep regression tests around wrapup promotion.
</PROJECT_RULES></facts>
<user_observations>
* User prefers regression tests for wrapup behavior.
</user_observations>
<primer_candidates>
<primer at_compartment="1">How does wrapup promotion work?</primer>
</primer_candidates>
<meta><messages_processed>1-1</messages_processed><unprocessed_from>2</unprocessed_from></meta>
</output>`;
}

function twoCompartmentHistorianXml(): string {
    return `<output>
<compartments>
<compartment start="1" end="2" title="First wrapped" episode_type="debug" importance="50">
<p1>First durable wrapup.</p1><p2>First.</p2><p3>First.</p3><p4>wrapup</p4>
</compartment>
<compartment start="3" end="4" title="Provisional wrapped" episode_type="debug" importance="50">
<p1>Provisional wrapup.</p1><p2>Provisional.</p2><p3>Prov.</p3><p4>wrapup</p4>
</compartment>
</compartments>
<facts><PROJECT_RULES>
* Mid-loop wrapup facts must promote.
</PROJECT_RULES></facts>
<meta><messages_processed>1-4</messages_processed><unprocessed_from>5</unprocessed_from></meta>
</output>`;
}

function client(output = historianXml()): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp/wrapup-runner" } })),
            create: mock(async () => ({ data: { id: `child-${Math.random()}` } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: output }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

function wrapupSnapshot(
    db: Database,
    sessionId: string,
    usagePercentage = 0,
): ProtectedTailBoundarySnapshot {
    return resolveWrapupProtectedTailBoundary({
        db,
        sessionId,
        mode: "manual-wrapup",
        contextLimit: 20,
        executeThresholdPercentage: 50,
        usage: { percentage: usagePercentage, inputTokens: 0 },
        usageSource: "test",
        providerShapeVersion: "test-v1",
        cacheNamespace: "test",
        messagesToKeep: 1,
    }).snapshot;
}

async function runWithLease(args: {
    db: Database;
    sessionId: string;
    snapshot: ProtectedTailBoundarySnapshot;
    forceKeepLastCompartment?: boolean;
    forceDrainQuota?: boolean;
    refreshBoundarySnapshot?: Parameters<typeof runCompartmentAgent>[0]["refreshBoundarySnapshot"];
    historianChunkTokens?: number;
    output?: string;
}) {
    const holderId = `holder-${Math.random()}`;
    expect(acquireCompartmentLease(args.db, args.sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgent({
            client: client(args.output),
            db: args.db,
            sessionId: args.sessionId,
            historianChunkTokens: args.historianChunkTokens ?? 10_000,
            historianTimeoutMs: 5_000,
            boundarySnapshot: args.snapshot,
            currentContextLimit: 20,
            directory: "/tmp/wrapup-runner",
            memoryEnabled: true,
            autoPromote: true,
            experimentalUserMemories: true,
            fallbackModels: [],
            compartmentLeaseHolderId: holderId,
            forceKeepLastCompartment: args.forceKeepLastCompartment,
            forceDrainQuota: args.forceDrainQuota,
            refreshBoundarySnapshot: args.refreshBoundarySnapshot,
        });
    } finally {
        releaseCompartmentLease(args.db, args.sessionId, holderId);
    }
}

describe("runCompartmentAgent wrapup controls", () => {
    it("persists a forced final compartment but skips facts, user observations, and primers", async () => {
        const project = resolveProjectIdentity("/tmp/wrapup-runner");
        for (const forceKeepLastCompartment of [true, false]) {
            const db = createDb();
            const sessionId = `ses-force-${forceKeepLastCompartment}`;
            try {
                await withProvider(sessionId, 3, () =>
                    runWithLease({
                        db,
                        sessionId,
                        snapshot: wrapupSnapshot(db, sessionId),
                        forceKeepLastCompartment,
                        forceDrainQuota: true,
                    }),
                );

                expect(getCompartments(db, sessionId)).toHaveLength(1);
                if (forceKeepLastCompartment) {
                    expect(projectClaims(db, project)).toHaveLength(0);
                    expect(getUserMemoryCandidates(db)).toHaveLength(0);
                    expect(getPrimerCandidatesForProject(db, project)).toHaveLength(0);
                } else {
                    expect(projectClaims(db, project).length).toBeGreaterThan(0);
                }
            } finally {
                closeQuietly(db);
            }
        }
    });

    it("downgrades forced final keep on token-capped chunks so discard-last healing still applies", async () => {
        const db = createDb();
        const sessionId = "ses-force-mid-loop-has-more";
        const project = resolveProjectIdentity("/tmp/wrapup-runner");
        try {
            const messages = alternatingMessages(10);
            await withProviderMessages(sessionId, messages, async () => {
                const snapshot = {
                    ...wrapupSnapshot(db, sessionId),
                    protectedTailStart: 9,
                    protectedTailStartMessageId: "m-9",
                    eligibleEndOrdinal: 9,
                    eligibleEndMessageId: "m-8",
                    rawRangeFingerprint: "",
                    trueRawEligibleTokens: 1_000,
                };
                const chunk = readSessionChunk(sessionId, 220, 1, snapshot.eligibleEndOrdinal);
                expect(chunk.hasMore).toBe(true);
                expect(chunk.endIndex).toBeGreaterThanOrEqual(4);
                expect(chunk.endIndex).toBeLessThanOrEqual(6);

                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    forceKeepLastCompartment: true,
                    forceDrainQuota: true,
                    historianChunkTokens: 220,
                    output: twoCompartmentHistorianXml(),
                });
            });

            // discard-last skips promotion to avoid double-storing unanchored facts on reread.
            expect(getCompartments(db, sessionId)).toHaveLength(1);
            expect(getCompartments(db, sessionId)[0]?.endMessage).toBe(2);
            expect(projectClaims(db, project)).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("does not let wrapup discard-last reopen a completed invocation/result arc", async () => {
        const db = createDb();
        const sessionId = "ses-wrapup-discard-arc";
        try {
            await withProviderMessages(sessionId, completedArcMessages(), async () => {
                const snapshot = {
                    ...wrapupSnapshot(db, sessionId),
                    protectedTailStart: 5,
                    protectedTailStartMessageId: "m-5",
                    eligibleEndOrdinal: 5,
                    eligibleEndMessageId: "m-4",
                    rawRangeFingerprint: "",
                    trueRawEligibleTokens: 1_000,
                };
                const chunk = readSessionChunk(sessionId, 10_000, 1, 5);
                expect(chunk.completedToolArcs).toEqual([{ start: 2, end: 3 }]);

                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    forceDrainQuota: true,
                    output: twoCompartmentHistorianXml(),
                });
            });

            expect(
                getCompartments(db, sessionId).map((compartment) => compartment.endMessage),
            ).toEqual([2, 4]);
        } finally {
            closeQuietly(db);
        }
    });

    it("forceDrainQuota bypasses an exhausted protected-tail drain window", async () => {
        const db = createDb();
        const sessionId = "ses-quota-bypass";
        try {
            await withProvider(sessionId, 3, async () => {
                const snapshot = wrapupSnapshot(db, sessionId, 83);
                const usable = Math.max(
                    1,
                    Math.round((snapshot.contextLimit * snapshot.executeThresholdPercentage) / 100),
                );
                const perRunCap = 3;
                expect(
                    reserveProtectedTailDrainTokens({
                        db,
                        sessionId,
                        runId: "exhaust-window",
                        trueRawTokens: 9,
                        usagePercentage: snapshot.usagePercentage,
                        usable,
                        perRunCap,
                        executeThresholdPercentage: snapshot.executeThresholdPercentage,
                    }).ok,
                ).toBe(true);

                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    forceDrainQuota: true,
                });
            });
            expect(getCompartments(db, sessionId)).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    it("uses refreshBoundarySnapshot when the initial boundary snapshot is stale", async () => {
        const db = createDb();
        const sessionId = "ses-refresh-boundary";
        try {
            await withProvider(sessionId, 3, async () => {
                const fresh = wrapupSnapshot(db, sessionId);
                const stale = {
                    ...fresh,
                    rawMessageCountAtTrigger: 1,
                    rawLastMessageIdAtTrigger: "m-1",
                    rawRangeFingerprint: "stale-fingerprint",
                };
                const refresh = mock(() => fresh);
                await runWithLease({
                    db,
                    sessionId,
                    snapshot: stale,
                    forceDrainQuota: true,
                    refreshBoundarySnapshot: refresh,
                });
                expect(refresh).toHaveBeenCalled();
            });
            expect(getCompartments(db, sessionId)[0]?.endMessage).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});
