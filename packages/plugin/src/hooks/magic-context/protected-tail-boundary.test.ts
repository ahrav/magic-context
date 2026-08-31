/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
    deriveMinForceEligibleTokens,
    deriveProtectedTailTokenTarget,
    MIN_FORCE_ELIGIBLE_TOKENS_CAP,
    selectPerRunCap,
} from "./protected-tail-boundary";
import { buildTrueRawTokenIndexFromTokenCountsForTest } from "./read-session-true-raw-tokens";

describe("protected-tail size walk", () => {
    it("finds the largest ordinal whose suffix still covers the target tokens", () => {
        const index = buildTrueRawTokenIndexFromTokenCountsForTest("canary", [100, 100, 100]);

        expect(index.findSuffixStartForTokens(150)).toBe(2);
        expect(index.findSuffixStartForTokens(301)).toBe(1);
        expect(index.findSuffixStartForTokens(300)).toBe(1);
        expect(index.findSuffixStartForTokens(0)).toBe(4);
    });
});

describe("per-run cap tiers", () => {
    // usable = round(contextLimit * executeThresholdPercentage / 100); the
    // snapshot below fixes usable = 100_000 unless a case overrides it.
    const base = { contextLimit: 125_000, executeThresholdPercentage: 80 };

    it("selects the tier by usage percentage at the 80 and 95 boundaries", () => {
        const N = 100;
        // usable = 100_000: fraction term wins in every tier.
        expect(selectPerRunCap({ ...base, N, usagePercentage: 79.9 })).toBe(25_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 80 })).toBe(35_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 94.9 })).toBe(35_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 95 })).toBe(50_000);
    });

    it("treats out-of-domain usage values as the non-emergency tier", () => {
        const N = 100;
        expect(selectPerRunCap({ ...base, N, usagePercentage: -1 })).toBe(25_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: Number.NaN })).toBe(25_000);
    });

    it("never shrinks the cap when pressure rises across a tier boundary", () => {
        for (const N of [100, 60_000, 200_000]) {
            const nonEmergency = selectPerRunCap({ ...base, N, usagePercentage: 50 });
            const force80 = selectPerRunCap({ ...base, N, usagePercentage: 80 });
            const force95 = selectPerRunCap({ ...base, N, usagePercentage: 95 });
            expect(force80).toBeGreaterThanOrEqual(nonEmergency);
            expect(force95).toBeGreaterThanOrEqual(force80);
        }
    });

    it("clamps the usable fraction at each tier's absolute term", () => {
        // usable = 1_000_000: every tier's fraction exceeds its absolute clamp.
        const big = { contextLimit: 1_250_000, executeThresholdPercentage: 80, N: 100 };
        expect(selectPerRunCap({ ...big, usagePercentage: 50 })).toBe(100_000);
        expect(selectPerRunCap({ ...big, usagePercentage: 80 })).toBe(150_000);
        expect(selectPerRunCap({ ...big, usagePercentage: 95 })).toBe(250_000);
    });

    it("keeps the N-proportional floor when it exceeds the clamped fraction", () => {
        // 2N / 3N / 4N all exceed each tier's absolute term at N = 60_000.
        const N = 60_000;
        expect(selectPerRunCap({ ...base, N, usagePercentage: 50 })).toBe(120_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 80 })).toBe(180_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 95 })).toBe(240_000);
    });

    it("caps each tier at its maximum even for a huge N", () => {
        const N = 400_000;
        expect(selectPerRunCap({ ...base, N, usagePercentage: 50 })).toBe(250_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 80 })).toBe(500_000);
        expect(selectPerRunCap({ ...base, N, usagePercentage: 95 })).toBe(750_000);
    });
});

describe("protected-tail N clamp", () => {
    it("keeps 8K and 12K windows from collapsing to a 1-token protected tail", () => {
        const eightK = deriveProtectedTailTokenTarget({
            contextLimit: 8_000,
            executeThresholdPercentage: 65,
            usagePercentage: 30,
        });
        const twelveK = deriveProtectedTailTokenTarget({
            contextLimit: 12_000,
            executeThresholdPercentage: 65,
            usagePercentage: 95,
        });

        expect(eightK.ceilingN).toBe(2_080);
        expect(eightK.N).toBe(2_000);
        expect(twelveK.ceilingN).toBe(3_120);
        expect(twelveK.N).toBe(2_000);
        expect(eightK.effectiveFloor).toBeLessThanOrEqual(eightK.ceilingN);
        expect(twelveK.effectiveFloor).toBeLessThanOrEqual(twelveK.ceilingN);
    });

    it("derives the force-head minimum from the scaled tail size", () => {
        expect(MIN_FORCE_ELIGIBLE_TOKENS_CAP).toBe(1_000);
        expect(deriveMinForceEligibleTokens(8)).toBe(1);
        expect(deriveMinForceEligibleTokens(16_000)).toBe(1_000);
    });
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
    resolveWrapupProtectedTailBoundary,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";

const boundaryTempDirs: string[] = [];
const originalBoundaryXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
    process.env.XDG_DATA_HOME = originalBoundaryXdg;
    for (const dir of boundaryTempDirs) rmSync(dir, { recursive: true, force: true });
    boundaryTempDirs.length = 0;
});

function useBoundaryTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    boundaryTempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createBoundaryOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; parts: unknown[]; rawData?: string }>,
): Database {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const insertMessage = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
        "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    messages.forEach((message, index) => {
        const timestamp = index + 1;
        insertMessage.run(
            message.id,
            sessionId,
            timestamp,
            timestamp,
            message.rawData ??
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
        );
        message.parts.forEach((part) => {
            insertPart.run(message.id, sessionId, timestamp, timestamp, JSON.stringify(part));
        });
    });
    return db;
}

function createContextDb(): Database {
    return createDirectTestDatabase().db;
}

describe("protected-tail boundary integration", () => {
    it("exposes a runnable head for a sparse #132-shaped session under pressure", () => {
        useBoundaryTempDataHome("protected-tail-132-");
        const sessionId = "ses-132";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            {
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "start the long autonomous task" }],
            },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "working" }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "continue" }] },
            ...Array.from({ length: 20 }, (_, index) => ({
                id: `m${index + 4}`,
                role: "assistant",
                parts: [{ type: "text", text: `autonomous output ${index} `.repeat(1000) }],
            })),
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });

            expect(snapshot.protectedTailStart).toBeGreaterThan(1);
            expect(hasRunnableCompartmentWindow(snapshot)).toBe(true);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("accepts a fresh zero-compartment snapshot (offset clamp parity with the resolver)", () => {
        // Snapshot validation clamps offsets to the resolver's minimum of 1.
        // Snapshot validation clamps offsets to the resolver's minimum of 1.
        // Snapshot validation clamps offsets to the resolver's minimum of 1.
        useBoundaryTempDataHome("protected-tail-first-");
        const sessionId = "ses-first-compartment";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible".repeat(800) }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "reply".repeat(800) }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });
            expect(snapshot.offset).toBe(1);
            expect(validateBoundarySnapshot({ db, snapshot })).toEqual({ ok: true });
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });
    it("validates fresh snapshots when malformed rows create ordinal gaps", () => {
        useBoundaryTempDataHome("protected-tail-ordinal-gap-");
        const sessionId = "ses-ordinal-gap";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible".repeat(800) }] },
            { id: "bad-json", role: "assistant", rawData: "{not json", parts: [] },
            { id: "m3", role: "assistant", parts: [{ type: "text", text: "reply".repeat(800) }] },
            { id: "m4", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });

            expect(snapshot.rawMessageCountAtTrigger).toBe(4);
            expect(validateBoundarySnapshot({ db, snapshot })).toEqual({ ok: true });
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("never crosses the newest meaningful user message on routine passes (live-prompt floor)", () => {
        // The protected tail includes the newest meaningful user message when a later assistant/tool suffix alone satisfies N.
        // The protected tail includes the newest meaningful user message when a later assistant/tool suffix alone satisfies N.
        // The protected tail includes the newest meaningful user message when a later assistant/tool suffix alone satisfies N.
        // The protected tail includes the newest meaningful user message when a later assistant/tool suffix alone satisfies N.
        useBoundaryTempDataHome("protected-tail-live-prompt-");
        const sessionId = "ses-live-prompt-floor";
        const messages: Array<{ id: string; role: string; parts: unknown[] }> = [];
        // The old messages provide eligible content mass.
        for (let i = 1; i <= 4; i++) {
            messages.push({
                id: `m-old-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                parts: [{ type: "text", text: `old content ${i} `.repeat(600) }],
            });
        }
        // The newest meaningful user message is the live prompt.
        messages.push({
            id: "m-live-prompt",
            role: "user",
            parts: [{ type: "text", text: "Okay now let's check open issues before we start." }],
        });
        // The assistant/tool suffix alone satisfies N.
        // The assistant/tool suffix alone satisfies N.
        for (let i = 1; i <= 4; i++) {
            messages.push({
                id: `m-tail-a${i}`,
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        callID: `read:${i}`,
                        tool: "read",
                        state: {
                            status: "completed",
                            input: { filePath: `/tmp/f${i}.ts` },
                            output: `tool output ${i} `.repeat(2000),
                        },
                    },
                ],
            });
        }
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, messages);
        const db = createContextDb();
        try {
            const livePromptOrdinal = 5;
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 50, inputTokens: 32_000 },
                usageSource: "live",
            });
            // The live prompt and all later messages remain protected.
            expect(snapshot.protectedTailStart).toBeLessThanOrEqual(livePromptOrdinal);

            // At T=90, 85% is below the derived 92% force threshold.
            // The 92% force threshold prevents force compaction from crossing the prompt.
            const raisedThreshold = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 90,
                usage: { percentage: 85, inputTokens: 54_400 },
                usageSource: "live",
            });
            expect(raisedThreshold.protectedTailStart).toBeLessThanOrEqual(livePromptOrdinal);

            // Default configurations lift the floor at the 85% band.
            const defaultThreshold = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 85, inputTokens: 54_400 },
                usageSource: "live",
            });
            expect(defaultThreshold.protectedTailStart).toBeGreaterThan(livePromptOrdinal);

            // Emergency-scaled re-resolution may cross the floor.
            // Emergency-scaled re-resolution may cross the floor.
            // Emergency-scaled re-resolution may cross the floor so sparse sessions remain compactable.
            const emergency = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 96, inputTokens: 61_000 },
                usageSource: "live",
                emergencyTailScale: 0.25,
            });
            expect(emergency.protectedTailStart).toBeGreaterThanOrEqual(
                snapshot.protectedTailStart,
            );
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("does not let an interrupted (dead) open tool arc at the eligible-head edge freeze the historian", () => {
        // The resolver ignores a running tool call with no output at the boundary to preserve a nonempty eligible head.
        // The resolver ignores a running tool call with no output at the boundary to preserve a nonempty eligible head.
        // The resolver ignores a running tool call with no output at the boundary to preserve a nonempty eligible head.
        // The resolver ignores a running tool call with no output at the boundary to preserve a nonempty eligible head.
        useBoundaryTempDataHome("protected-tail-dead-arc-");
        const sessionId = "ses-dead-open-arc";
        const messages: Array<{ id: string; role: string; parts: unknown[] }> = [];
        messages.push({
            id: "m-dead-bash",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    callID: "toolu_dead",
                    tool: "bash",
                    // The arc is open because it has input, status "running", and no output.
                    state: { status: "running", input: { command: "sleep 999" } },
                },
            ],
        });
        for (let i = 1; i <= 8; i++) {
            messages.push({
                id: `m-conv-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                parts: [{ type: "text", text: `conversation turn ${i} `.repeat(800) }],
            });
        }
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, messages);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 60, inputTokens: 38_000 },
                usageSource: "live",
            });
            // The resolver ignores the dead arc so the eligible head remains nonempty.
            expect(snapshot.eligibleEndOrdinal).toBeGreaterThan(snapshot.offset);
            expect(snapshot.trueRawEligibleTokens).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("manual-full-recomp is not frozen by a stale (dead) open tool arc at offset", () => {
        // A dead open arc before the recent window does not block manual-full-recomp.
        // A dead open arc before the recent window does not block manual-full-recomp.
        // Dead open arcs older than the recent window are excluded from the manual-full-recomp eligible range.
        useBoundaryTempDataHome("protected-tail-recomp-dead-arc-");
        const sessionId = "ses-recomp-dead-open-arc";
        const messages: Array<{ id: string; role: string; parts: unknown[] }> = [];
        messages.push({
            id: "m-dead-bash",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    callID: "toolu_dead",
                    tool: "bash",
                    state: { status: "running", input: { command: "sleep 999" } },
                },
            ],
        });
        for (let i = 1; i <= 8; i++) {
            messages.push({
                id: `m-conv-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                parts: [{ type: "text", text: `conversation turn ${i} `.repeat(800) }],
            });
        }
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, messages);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "manual-full-recomp",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usageSource: "manual-none",
            });
            expect(snapshot.eligibleEndOrdinal).toBeGreaterThan(snapshot.offset);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("bails out when a boundary snapshot's eligible raw range changes", () => {
        useBoundaryTempDataHome("protected-tail-stale-");
        const sessionId = "ses-stale-boundary";
        // m1 and m2 must exceed the 256-token hysteresis snap so the eligible range remains nonempty.
        // A nonempty eligible range is required to produce a fingerprint for invalidation.
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible ".repeat(400) }] },
            {
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "also eligible ".repeat(400) }],
            },
            { id: "m3", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 8_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 5_000 },
                usageSource: "live",
            });
            opencodeDb
                .prepare(
                    "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                )
                .run("m1", sessionId, 1, 1, JSON.stringify({ type: "text", text: "late edit" }));

            expect(validateBoundarySnapshot({ db, snapshot })).toEqual(
                expect.objectContaining({ ok: false, reason: "stale_snapshot" }),
            );
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });
});

it("manual full recomp protects an in-progress open tool arc", () => {
    useBoundaryTempDataHome("protected-tail-manual-open-arc-");
    const sessionId = "ses-manual-open-arc";
    const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "eligible" }] },
        {
            id: "m2",
            role: "assistant",
            parts: [{ type: "tool", callID: "call-open", state: { input: { command: "long" } } }],
        },
        { id: "m3", role: "assistant", parts: [{ type: "text", text: "still running" }] },
    ]);
    const db = createContextDb();
    try {
        const snapshot = resolveOpenCodeProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-full-recomp",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
        });

        expect(snapshot.protectedTailStart).toBe(2);
        expect(snapshot.eligibleEndOrdinal).toBe(2);
    } finally {
        closeQuietly(db);
        closeQuietly(opencodeDb);
    }
});

import type { RawMessage } from "./read-session-raw";
import {
    buildToolArcs,
    buildTrueRawTokenIndex,
    computeRawRangeFingerprint,
    fenceBoundaryForToolArcs,
} from "./read-session-true-raw-tokens";

it("fingerprints and true-raw tokens change when nested tool output grows with the same id and part count", () => {
    const short: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [{ type: "tool", callID: "call-1", state: { output: "short" } }],
        },
    ];
    const long: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [{ type: "tool", callID: "call-1", state: { output: "long ".repeat(2000) } }],
        },
    ];

    expect(computeRawRangeFingerprint(short, 1, 2)).not.toBe(
        computeRawRangeFingerprint(long, 1, 2),
    );
    const shortTokens = buildTrueRawTokenIndex("ses-cache", short, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "same-session",
    }).rangeTokens(1, 2);
    const longTokens = buildTrueRawTokenIndex("ses-cache", long, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "same-session",
    }).rangeTokens(1, 2);
    expect(longTokens).toBeGreaterThan(shortTokens);
});

it("fingerprints same-length edits to counted content fields", () => {
    const before: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [
                { type: "text", text: "alpha" },
                { type: "thinking", thinking: "bravo" },
                { type: "tool", callID: "call-1", state: { input: { q: "one" }, output: "delta" } },
            ],
        },
    ];
    const after: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [
                { type: "text", text: "omega" },
                { type: "thinking", thinking: "gamma" },
                { type: "tool", callID: "call-1", state: { input: { q: "two" }, output: "sigma" } },
            ],
        },
    ];

    expect(computeRawRangeFingerprint(before, 1, 2)).not.toBe(
        computeRawRangeFingerprint(after, 1, 2),
    );
});

it("moves a candidate boundary forward to the first later open tool invocation", () => {
    expect(
        fenceBoundaryForToolArcs(10, [{ callId: "open", invOrdinal: 20, resOrdinal: null }], 9, 10),
    ).toBe(20);
});

it("ignores a stale open arc older than the recent-open-arc cutoff (does not fence the boundary)", () => {
    expect(
        fenceBoundaryForToolArcs(50, [{ callId: "dead", invOrdinal: 5, resOrdinal: null }], 1, 50),
    ).toBe(50);
});

it("still protects a recent open arc at/after the recent-open-arc cutoff", () => {
    expect(
        fenceBoundaryForToolArcs(50, [{ callId: "live", invOrdinal: 60, resOrdinal: null }], 1, 50),
    ).toBe(60);
});

it("classifies property-presence tool states for open and null-output arcs", () => {
    expect(
        buildToolArcs([
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [{ type: "tool", callID: "empty-open", providerExecuted: false, state: {} }],
            },
        ]),
    ).toEqual([{ callId: "empty-open", invOrdinal: 1, resOrdinal: null }]);

    expect(
        buildToolArcs([
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [
                    { type: "tool", callID: "null-output", state: { input: { command: "x" } } },
                ],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "user",
                parts: [{ type: "tool", callID: "null-output", state: { output: null } }],
            },
        ]),
    ).toEqual([{ callId: "null-output", invOrdinal: 1, resOrdinal: 2 }]);
});

it("bails a snapshot when the current context limit differs from the trigger limit", () => {
    useBoundaryTempDataHome("protected-tail-model-switch-");
    const sessionId = "ses-model-switch";
    const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "eligible" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "tail".repeat(2000) }] },
    ]);
    const db = createContextDb();
    try {
        const snapshot = resolveOpenCodeProtectedTailBoundary({
            db,
            sessionId,
            mode: "trigger",
            contextLimit: 1_000_000,
            executeThresholdPercentage: 65,
            usage: { percentage: 85, inputTokens: 500_000 },
            usageSource: "live",
        });
        expect(validateBoundarySnapshot({ db, snapshot, currentContextLimit: 8_000 })).toEqual(
            expect.objectContaining({ ok: false, reason: "model_or_limit_changed" }),
        );
    } finally {
        closeQuietly(db);
        closeQuietly(opencodeDb);
    }
});

function pressureGateSnapshot(
    sessionId: string,
    executeThresholdPercentage: number,
): ProtectedTailBoundarySnapshot {
    return {
        sessionId,
        mode: "trigger",
        offset: 1,
        offsetMessageId: "m1",
        protectedTailStart: 2,
        protectedTailStartMessageId: "m2",
        eligibleEndOrdinal: 1,
        eligibleEndMessageId: null,
        rawMessageCountAtTrigger: 2,
        rawLastMessageIdAtTrigger: "m2",
        N: 2_000,
        usagePercentage: 85,
        usageInputTokens: 85_000,
        usageSource: "live",
        contextLimit: 100_000,
        executeThresholdPercentage,
        triggerBudget: 5_000,
        priorBoundaryOrdinal: 1,
        migrationFloorActive: false,
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "pressure-gate-test",
        createdAt: 1,
        rawRangeFingerprint: "stable",
        trueRawEligibleTokens: 500,
        oversizeAtomicUnit: false,
        boundaryReason: "size-walk",
    };
}

it("keeps runnable-window and no-head gates below a raised force band", () => {
    const raised = pressureGateSnapshot("ses-raised-pressure-gates", 90);
    const defaultThreshold = pressureGateSnapshot("ses-default-pressure-gates", 65);

    // The configured force threshold is 92%, not 80%.
    expect(hasRunnableCompartmentWindow(raised)).toBe(false);
    expect(hasRunnableCompartmentWindow(defaultThreshold)).toBe(true);

    const db = createContextDb();
    try {
        expect(recordHighPressureNoEligibleHead(db, raised)).toBe(0);
        expect(recordHighPressureNoEligibleHead(db, defaultThreshold)).toBe(1);
    } finally {
        closeQuietly(db);
    }
});

it("treats an emergency-scaled complete small head as runnable even below the force token floor", () => {
    expect(
        hasRunnableCompartmentWindow({
            sessionId: "ses-small-head",
            mode: "trigger",
            offset: 1,
            rawMessageCount: 2,
            protectedTailStart: 2,
            eligibleEndOrdinal: 2,
            N: 2_000,
            usableTokens: 7_800,
            usagePercentage: 82,
            usageInputTokens: 9_840,
            usageSource: "live",
            contextLimit: 12_000,
            executeThresholdPercentage: 65,
            trueRawEligibleTokens: 1,
            trueRawTailTokens: 2_000,
            boundaryReason: "size-walk",
            rawRangeFingerprint: "stable",
        }),
    ).toBe(true);
});

describe("wrapup protected-tail boundary", () => {
    it("counts raw messages of any role and keeps the newest N raw", () => {
        useBoundaryTempDataHome("wrapup-boundary-meaningful-");
        const sessionId = "ses-wrapup-meaningful";
        createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "a" }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "ignored", ignored: true }] },
            { id: "m4", role: "user", parts: [{ type: "text", text: "two" }] },
            { id: "m5", role: "assistant", parts: [{ type: "text", text: "b" }] },
            { id: "m6", role: "user", parts: [{ type: "text", text: "three" }] },
            { id: "m7", role: "assistant", parts: [{ type: "text", text: "c" }] },
            { id: "m8", role: "user", parts: [{ type: "text", text: "four" }] },
        ]);
        const db = createContextDb();
        const plan = resolveWrapupProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-wrapup",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
            messagesToKeep: 2,
        });

        expect(plan.rawMessagesAboveLastCompartment).toBe(8);
        // Keeping 2 of 8 raw messages yields candidate ordinal 7, which snaps backward to user message m6 at ordinal 6.
        expect(plan.targetProtectedTailStart).toBe(6);
        expect(plan.snapshot.eligibleEndOrdinal).toBeGreaterThan(1);
        expect(plan.snapshot.eligibleEndOrdinal).toBeLessThanOrEqual(6);
        closeQuietly(db);
    });

    it("snaps outward so a closed tool arc is not split at the keep watermark", () => {
        useBoundaryTempDataHome("wrapup-boundary-arc-");
        const sessionId = "ses-wrapup-arc";
        createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
            {
                id: "m2",
                role: "assistant",
                parts: [{ type: "tool", id: "t1", state: { status: "pending" } }],
            },
            { id: "m3", role: "user", parts: [{ type: "text", text: "two" }] },
            {
                id: "m4",
                role: "tool",
                parts: [{ type: "tool_result", id: "t1", content: "result" }],
            },
            { id: "m5", role: "user", parts: [{ type: "text", text: "three" }] },
        ]);
        const db = createContextDb();
        const plan = resolveWrapupProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-wrapup",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
            messagesToKeep: 2,
        });

        expect(plan.targetProtectedTailStart).toBe(1);
        expect(plan.snapshot.boundaryReason).toBe("manual-wrapup-user-snap");
        closeQuietly(db);
    });

    it("re-fences after user snap when the snapped user is inside an earlier tool arc", () => {
        useBoundaryTempDataHome("wrapup-boundary-refence-");
        const sessionId = "ses-wrapup-refence";
        createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
            {
                id: "m2",
                role: "assistant",
                parts: [{ type: "tool", id: "outer", state: { status: "pending" } }],
            },
            { id: "m3", role: "user", parts: [{ type: "text", text: "queued while outer runs" }] },
            { id: "m4", role: "assistant", parts: [{ type: "text", text: "still working" }] },
            {
                id: "m5",
                role: "assistant",
                parts: [{ type: "tool", id: "inner", state: { status: "pending" } }],
            },
            {
                id: "m6",
                role: "tool",
                parts: [{ type: "tool_result", id: "outer", content: "outer result" }],
            },
            { id: "m7", role: "user", parts: [{ type: "text", text: "queued while inner runs" }] },
            {
                id: "m8",
                role: "tool",
                parts: [{ type: "tool_result", id: "inner", content: "inner result" }],
            },
            { id: "m9", role: "user", parts: [{ type: "text", text: "newest kept" }] },
        ]);
        const db = createContextDb();
        const plan = resolveWrapupProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-wrapup",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
            messagesToKeep: 2,
        });

        expect(plan.targetProtectedTailStart).toBeLessThanOrEqual(2);
        closeQuietly(db);
    });
});
