/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
    getLastCompartmentEndMessage,
} from "../../features/magic-context/compartment-storage";
import {
    acquireWrapupInProgress,
    getWrapupInProgressState,
    incrementHistorianFailure,
} from "../../features/magic-context/storage";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { executeContextRecompWithResult, registerActiveCompartmentRun } from "./compartment-runner";
import { createLiveSessionState, type LiveSessionState } from "./live-session-state";
import { setRawMessageProvider } from "./read-session-chunk";
import { type ManagedWrapupContext, runManagedWrapup } from "./wrapup-orchestrator";

function createDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function liveState(): LiveSessionState {
    return createLiveSessionState();
}

function messages(count: number, words = "alpha beta gamma delta epsilon zeta") {
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} ${words}` }],
    }));
}

async function withProvider<T>(sessionId: string, count: number, fn: () => Promise<T>): Promise<T> {
    const raw = messages(count);
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => raw,
        getMessageCount: () => raw.length,
    });
    try {
        return await fn();
    } finally {
        unregister();
    }
}

function stealWrapupMarker(db: Database, sessionId: string): void {
    const state = getWrapupInProgressState(db, sessionId);
    expect(state).not.toBeNull();
    db.prepare("UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?").run(
        JSON.stringify({
            ...state,
            holderId: "foreign-holder",
            updatedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
        }),
        sessionId,
    );
}

function appendRange(db: Database, sessionId: string, start: number, end: number): void {
    if (end < start) return;
    appendCompartments(db, sessionId, [
        {
            sequence: getCompartments(db, sessionId).length,
            startMessage: start,
            endMessage: end,
            startMessageId: `m-${start}`,
            endMessageId: `m-${end}`,
            title: `Wrapped ${start}-${end}`,
            content: `Wrapped ${start}-${end}`,
        },
    ]);
}

function baseCtx(db: Database, state = liveState()): ManagedWrapupContext {
    return {
        client: {} as never,
        db,
        liveSessionState: state,
        directory: "/tmp/project",
        historianChunkTokens: 10,
        historianTimeoutMs: 1_000,
        memoryEnabled: false,
        autoPromote: false,
        fallbackModels: [],
        runMigration: false,
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
        contextLimit: 100,
        executeThresholdPercentage: 50,
        hasPendingNaturalBust: () => false,
    };
}

describe("runManagedWrapup", () => {
    it("drains multiple chunks and lets the runner decide actual final-chunk keep", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-multi";
            const forceKeepFlags: boolean[] = [];
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                forceKeepFlags.push(deps.forceKeepLastCompartment === true);
                const before = Math.max(1, getLastCompartmentEndMessage(db, sessionId) + 1);
                const end = Math.min(deps.boundarySnapshot.eligibleEndOrdinal - 1, before + 2);
                appendRange(db, sessionId, before, end);
                deps.onCompartmentStatePublished?.(sessionId);
            });

            const result = await withProvider(sessionId, 12, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 3 }),
            );

            expect(result).toContain("Wrapped up 9 messages into 3 compartments");
            expect(result).toContain(
                "If you want it applied on the very next message, run /ctx-flush first.",
            );
            expect(forceKeepFlags).toEqual([true, true, true]);
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(9);
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
            expect(ctx.liveSessionState.deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
            expect(ctx.liveSessionState.deferredMaterializationSessions.has(sessionId)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    it("no-ops within keep-N without acquiring the marker or running the historian", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-noop";
            const runner = mock(async () => {});
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = runner;

            const result = await withProvider(sessionId, 3, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 3 }),
            );

            expect(result).toBe("Nothing to wrap up — only 3 messages above the last compartment.");
            expect(runner).not.toHaveBeenCalled();
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("aborts when wrapup marker ownership is lost and leaves the foreign marker", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-ownership-lost";
            let calls = 0;
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                calls += 1;
                appendRange(db, sessionId, 1, 3);
                deps.onCompartmentStatePublished?.(sessionId);
                stealWrapupMarker(db, sessionId);
            });

            const result = await withProvider(sessionId, 10, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("another process took over this session's wrapup");
            expect(calls).toBe(1);
            expect(getWrapupInProgressState(db, sessionId)?.holderId).toBe("foreign-holder");
        } finally {
            closeQuietly(db);
        }
    });

    it("stops on no progress and releases the marker", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-no-progress";
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async () => {});

            const result = await withProvider(sessionId, 8, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("made no forward progress");
            expect(result).toContain("Run /ctx-wrapup again to continue");
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("bounds waiting for a foreign compartment lease and releases the wrapup marker", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-lease-timeout";
            const foreignHolder = "foreign-lease-holder";
            expect(acquireCompartmentLease(db, sessionId, foreignHolder)).not.toBeNull();
            const ctx = baseCtx(db);
            ctx.wrapupLeaseWaitTimeoutMs = 0;
            ctx.runCompartmentAgentForWrapup = mock(async () => {});

            const result = await withProvider(sessionId, 8, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("Timed out waiting");
            expect(ctx.runCompartmentAgentForWrapup).not.toHaveBeenCalled();
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
            releaseCompartmentLease(db, sessionId, foreignHolder);
        } finally {
            closeQuietly(db);
        }
    });

    it("reports a mid-loop historian failure while preserving published chunks", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-failure";
            let call = 0;
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                call += 1;
                if (call === 1) {
                    appendRange(db, sessionId, 1, 3);
                    deps.onCompartmentStatePublished?.(sessionId);
                    return;
                }
                incrementHistorianFailure(db, sessionId, "scripted failure");
            });

            const result = await withProvider(sessionId, 10, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("historian failed");
            expect(result).toContain("Run /ctx-wrapup again to continue");
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(3);
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects concurrent wrapups and recomp-kind active runs", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-concurrent";
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async () => {});
            acquireWrapupInProgress(db, sessionId, {
                holderId: "other-holder",
                messagesToKeep: 2,
                anchorRawMessageCount: 10,
                targetEligibleEndOrdinal: 8,
                lastCompartmentEnd: 0,
                chunkIndex: 1,
                expectedChunks: 3,
            });
            const busy = await withProvider(sessionId, 10, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );
            expect(busy).toContain("already running");

            const recompSkip = await executeContextRecompWithResult({
                ...ctx,
                sessionId,
            } as never);
            expect(recompSkip.published).toBe(false);
            expect(recompSkip.message).toContain("/ctx-wrapup is already compacting");
        } finally {
            closeQuietly(db);
        }

        const db2 = createDb();
        let releaseActive!: () => void;
        const active = new Promise<void>((resolve) => {
            releaseActive = resolve;
        });
        try {
            const sessionId = "ses-wrapup-recomp-active";
            registerActiveCompartmentRun(sessionId, active, "recomp");
            const result = await withProvider(sessionId, 10, () =>
                runManagedWrapup(baseCtx(db2), sessionId, { messagesToKeep: 2 }),
            );
            expect(result).toContain("Another Magic Context rebuild is already running");
            expect(getWrapupInProgressState(db2, sessionId)).toBeNull();
        } finally {
            releaseActive();
            await active;
            closeQuietly(db2);
        }
    });

    it("suppresses the flush hint when a natural bust is already pending", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-flush-hint";
            const ctx = baseCtx(db);
            ctx.hasPendingNaturalBust = () => true;
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                appendRange(db, sessionId, 1, deps.boundarySnapshot.eligibleEndOrdinal - 1);
                deps.onCompartmentStatePublished?.(sessionId);
            });

            const result = await withProvider(sessionId, 6, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("materializes on your next message");
            expect(result).not.toContain("ctx-flush");
        } finally {
            closeQuietly(db);
        }
    });

    it("forwards the user-memory collection gate to every wrapup chunk", async () => {
        for (const userMemoriesEnabled of [true, false]) {
            const db = createDb();
            try {
                const sessionId = `ses-wrapup-user-memories-${userMemoriesEnabled}`;
                const seen: Array<boolean | undefined> = [];
                const ctx = baseCtx(db);
                ctx.userMemoriesEnabled = userMemoriesEnabled;
                ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                    seen.push(deps.experimentalUserMemories);
                    const before = Math.max(1, getLastCompartmentEndMessage(db, sessionId) + 1);
                    const end = Math.min(deps.boundarySnapshot.eligibleEndOrdinal - 1, before + 2);
                    appendRange(db, sessionId, before, end);
                    deps.onCompartmentStatePublished?.(sessionId);
                });

                await withProvider(sessionId, 10, () =>
                    runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
                );

                expect(seen.length).toBeGreaterThan(0);
                for (const flag of seen) {
                    expect(flag).toBe(userMemoriesEnabled);
                }
            } finally {
                closeQuietly(db);
            }
        }
    });
});
