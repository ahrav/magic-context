import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { acquireWrapupInProgress } from "../../features/magic-context/storage-meta-persisted";
import type { LiveSessionState } from "./live-session-state";
import {
    contextualizeUpgradeReason,
    extractRecompReason,
    isRecompComplete,
    isRecompFailure,
    isRecompSkip,
    type ManagedRecompContext,
    runManagedUpgrade,
} from "./recomp-orchestrator";

const tempDirs: string[] = [];
const originalXdg = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`);
    process.env.XDG_DATA_HOME = dir;
    tempDirs.push(dir);
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdg;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function makeLiveSessionState(): LiveSessionState {
    return {
        liveModelBySession: new Map(),
        sessionDirectoryBySession: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        recompProgressBySession: new Map(),
    } as unknown as LiveSessionState;
}

function makeCtx(
    db: ReturnType<typeof openDatabase>,
    directory: string,
    overrides?: Partial<ManagedRecompContext>,
): ManagedRecompContext {
    return {
        client: {} as ManagedRecompContext["client"],
        db,
        liveSessionState: makeLiveSessionState(),
        directory,
        historianChunkTokens: 10_000,
        historianTimeoutMs: 60_000,
        memoryEnabled: true,
        autoPromote: false,
        fallbackModels: [],
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
        ...overrides,
    } as ManagedRecompContext;
}

describe("runManagedUpgrade — wrapup guard", () => {
    it("skips before migration-only upgrade work while wrapup is active", async () => {
        useTempDataHome("recomp-orch-wrapup-guard-");
        const db = openDatabase();
        const dir = "/tmp/recomp-orch-wrapup-guard";
        const sessionId = "ses-wrapup-upgrade";
        const acquired = acquireWrapupInProgress(db, sessionId, {
            holderId: "wrapup-holder",
            messagesToKeep: 2,
            anchorRawMessageCount: 10,
            targetEligibleEndOrdinal: 8,
            lastCompartmentEnd: 0,
            chunkIndex: 1,
            expectedChunks: 2,
        });
        expect(acquired.ok).toBe(true);

        const ctx = makeCtx(db, dir);
        const message = await runManagedUpgrade(ctx, sessionId);

        expect(message).toContain("## Session Upgrade — Skipped");
        expect(message).toContain("/ctx-wrapup is already compacting");
    });
});

describe("runManagedUpgrade — already-upgraded guard", () => {
    it("is a no-op when there are no legacy compartments and migration is done", async () => {
        useTempDataHome("recomp-orch-noop-");
        const db = openDatabase();
        const dir = "/tmp/recomp-orch-noop";

        // A `legacy: 0` compartment exercises the no-legacy guard.
        appendCompartments(db, "ses-up", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: "v2 comp",
                content: "body",
                legacy: 0,
                p1: "body",
            },
        ]);

        const ctx = makeCtx(db, dir);
        const message = await runManagedUpgrade(ctx, "ses-up");

        expect(message).toContain("Already Up To Date");
        expect(isRecompFailure(message)).toBe(false);
        const prog = ctx.liveSessionState.recompProgressBySession.get("ses-up");
        // A `done` phase may auto-clear after its grace period; it must never become `failed`.
        expect(prog?.phase === "done" || prog === undefined).toBe(true);
    });

    it("reports no history when the session has zero compartments and migration done", async () => {
        useTempDataHome("recomp-orch-empty-");
        const db = openDatabase();
        const dir = "/tmp/recomp-orch-empty";

        const ctx = makeCtx(db, dir);
        const message = await runManagedUpgrade(ctx, "ses-empty");

        expect(message).toContain("Already Up To Date");
        expect(message).toContain("no compartment history");
    });
});

describe("runManagedRecomp clears stale emergency recovery", () => {
    // runManagedRecomp clears `needs_emergency_recovery` only when the terminal phase is `"done"`, not `"skipped"` or `"failed"`.
    const SRC = readFileSync(join(import.meta.dir, "recomp-orchestrator.ts"), "utf8");

    it("clears the flag only in the done terminal phase", () => {
        expect(SRC).toContain("clearEmergencyRecovery(ctx.db, sessionId)");
        const doneGate = SRC.indexOf('terminalPhase === "done"');
        const clearCall = SRC.indexOf("clearEmergencyRecovery(ctx.db, sessionId)");
        expect(doneGate).toBeGreaterThan(-1);
        expect(clearCall).toBeGreaterThan(doneGate);
    });
});

describe("recomp message helpers", () => {
    it("isRecompFailure detects Failed/Skipped headings only", () => {
        expect(isRecompFailure("## Magic Recomp — Failed\n\nreason")).toBe(true);
        expect(isRecompFailure("## Session Upgrade — Skipped")).toBe(true);
        expect(isRecompFailure("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(false);
        expect(isRecompFailure("## Session Upgrade — Already Up To Date")).toBe(false);
    });

    it("isRecompComplete requires a positive — Complete heading (Partial is NOT complete)", () => {
        // A `"— Partial"` result rebuilt only a prefix, so the upgrade gate requires `isRecompComplete` rather than `!isRecompFailure`.
        // Because `"— Partial"` is neither `"— Failed"` nor `"— Skipped"`, `!isRecompFailure` would treat it as successful.
        // Treating a partial result as successful would run migration and report `"Complete"` while tierless legacy rows remain.
        expect(isRecompComplete("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(true);
        expect(isRecompComplete("## Session Upgrade — Complete")).toBe(true);
        expect(isRecompComplete("## Magic Recomp — Partial\n\nRemaining 40-99 not rebuilt")).toBe(
            false,
        );
        expect(isRecompFailure("## Magic Recomp — Partial\n\nx")).toBe(false);
        // Lease-busy no-op has no status suffix → neither complete nor failure.
        expect(isRecompComplete("## Magic Recomp\n\nHistorian is already running…")).toBe(false);
        expect(isRecompComplete("## Magic Recomp — Failed\n\nx")).toBe(false);
    });

    it("treats the lease/activeRuns skip messages as failures (— Skipped suffix)", () => {
        // No-op messages must not allow the upgrade to run migration or report `"complete"`.
        expect(
            isRecompFailure(
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            ),
        ).toBe(true);
        expect(
            isRecompFailure(
                "## Magic Recomp — Skipped\n\nAnother process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            ),
        ).toBe(true);
    });

    it("isRecompSkip distinguishes a transient lease-busy skip from a hard failure", () => {
        // A skip reports a lease-busy or already-running no-op.
        // A lease-busy or already-running no-op must report `"skipped"`, not `"failed"`, so the progress entry auto-clears.
        expect(
            isRecompSkip(
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            ),
        ).toBe(true);
        // A lease-busy or already-running no-op has no `"— Skipped"` heading.
        expect(isRecompSkip("## Magic Recomp\n\nHistorian is already running…")).toBe(true);
        expect(
            isRecompSkip(
                "## Magic Recomp\n\nAnother process is already mutating compartment state",
            ),
        ).toBe(true);
        // A genuine failure or a normal completion is NOT a skip.
        expect(isRecompSkip("## Magic Recomp — Failed\n\nHistorian returned no output")).toBe(
            false,
        );
        expect(isRecompSkip("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(false);
    });

    it("extractRecompReason strips markdown headings and blank lines", () => {
        expect(
            extractRecompReason(
                "## Magic Recomp — Failed\n\nHistorian returned no usable compartments.",
            ),
        ).toBe("Historian returned no usable compartments.");
    });

    it("contextualizeUpgradeReason rewrites /ctx-recomp -> /ctx-session-upgrade", () => {
        // The upgrade flow must not surface shared recomp skip text verbatim because it directs users to `/ctx-recomp`, which is not this flow's command.
        const out = contextualizeUpgradeReason(
            "Historian returned no usable compartments. Try `/ctx-recomp` again.",
        );
        expect(out).not.toContain("/ctx-recomp");
        expect(out).toContain("/ctx-session-upgrade");
    });

    it("contextualizeUpgradeReason names historian.model for flat v1 output", () => {
        const out = contextualizeUpgradeReason(
            "Historian returned invalid compartment output: compartment 1 is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers",
        );
        expect(out).toContain("`historian.model`");
        expect(out).toContain("magic-context.jsonc");
        expect(out).toContain("No compartments were rewritten");
    });

    it("contextualizeUpgradeReason reframes the lease-busy skip as transient", () => {
        const out = contextualizeUpgradeReason(
            "Another process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
        );
        expect(out).toContain("/ctx-session-upgrade");
        expect(out).not.toContain("/ctx-recomp`"); // no stray recomp command
        expect(out.toLowerCase()).toMatch(/temporary|wait|comparter/);
    });
});
