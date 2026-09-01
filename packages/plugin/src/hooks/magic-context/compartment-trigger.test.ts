/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    closeDatabase,
    insertTag,
    markProtectedTailPolicyV3Seeded,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import type { SessionMeta } from "../../features/magic-context/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { checkCompartmentTrigger, type InMemoryTailSource } from "./compartment-trigger";
import type { RawMessage } from "./read-session-raw";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Cleanup may fail with EBUSY on Windows. */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; text?: string }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
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
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            if (message.text) {
                insertPart.run(
                    message.id,
                    sessionId,
                    timestamp,
                    timestamp,
                    JSON.stringify({ type: "text", text: message.text }),
                );
            }
        });
    } finally {
        closeQuietly(db);
    }
}

function makeSessionMeta(sessionId: string, lastContextPercentage: number): SessionMeta {
    return {
        sessionId,
        counter: 0,
        cacheTtl: "5m",
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: null,
        isSubagent: false,
        lastContextPercentage,
        lastInputTokens: 0,
        observedSafeInputTokens: 0,
        cacheAlertSent: false,
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        lastTransformError: null,
        systemPromptHash: "",
        systemPromptTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        clearedReasoningThroughTag: 0,
        lastTodoState: "",
    };
}

function rawTextMessage(ordinal: number, id: string, role: string, text: string): RawMessage {
    return {
        ordinal,
        id,
        role,
        parts: [{ type: "text", text }],
        version: null,
    };
}

function observedRawTextMessage(
    ordinal: number,
    id: string,
    role: string,
    text: string,
): { message: RawMessage; partReads: () => number } {
    let reads = 0;
    const message = {
        ordinal,
        id,
        role,
        get parts() {
            reads += 1;
            return [{ type: "text", text }];
        },
        version: null,
    } as RawMessage;
    return { message, partReads: () => reads };
}

function inMemoryTail(messages: RawMessage[], absoluteMessageCount?: number): InMemoryTailSource {
    return {
        messages,
        absoluteMessageCount:
            absoluteMessageCount ?? Math.max(0, ...messages.map((message) => message.ordinal)),
    };
}

function seedTriggerPolicy(db: Database, sessionId: string): void {
    markProtectedTailPolicyV3Seeded(db, sessionId, 1);
}

function insertCoveredMessageTag(
    db: Database,
    sessionId: string,
    messageId: string,
    tagNumber: number,
    tokenCount: number | null,
): void {
    insertTag(
        db,
        sessionId,
        messageId,
        "message",
        Math.max(1, tokenCount ?? 1),
        tagNumber,
        0,
        null,
        0,
        null,
        null,
        {
            tokenCount,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        },
    );
}

describe("checkCompartmentTrigger", () => {
    it("cheap-skips the in-memory tail below the proactive floor when persisted plus untagged tokens are under budget", () => {
        useTempDataHome("compartment-trigger-memory-skip-");
        const db = openDatabase();
        const triggerBudget = 1_000;

        const fullSessionId = "ses-memory-under-full";
        seedTriggerPolicy(db, fullSessionId);
        insertCoveredMessageTag(db, fullSessionId, "m-full-1", 1, null);
        const fullResult = checkCompartmentTrigger(
            db,
            fullSessionId,
            makeSessionMeta(fullSessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            triggerBudget,
            undefined,
            undefined,
            undefined,
            undefined,
            inMemoryTail([
                rawTextMessage(1, "m-full-1", "user", "small tail"),
                rawTextMessage(2, "m-full-2", "assistant", "small response"),
            ]),
        );
        expect(fullResult).toEqual({ shouldFire: false });

        const skippedSessionId = "ses-memory-under-skip";
        seedTriggerPolicy(db, skippedSessionId);
        const first = observedRawTextMessage(1, "m-skip-1", "user", "small tail");
        const second = observedRawTextMessage(2, "m-skip-2", "assistant", "small response");
        insertCoveredMessageTag(db, skippedSessionId, "m-skip-1", 1, 100);
        insertCoveredMessageTag(db, skippedSessionId, "m-skip-2", 2, 50);

        const result = checkCompartmentTrigger(
            db,
            skippedSessionId,
            makeSessionMeta(skippedSessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            triggerBudget,
            undefined,
            undefined,
            undefined,
            undefined,
            inMemoryTail([first.message, second.message], 50_000),
        );

        expect(result).toEqual(fullResult);
        expect(first.partReads()).toBe(0);
        expect(second.partReads()).toBe(0);
    });

    it("falls through when a large untagged in-memory message pushes the upper bound over budget", () => {
        useTempDataHome("compartment-trigger-memory-large-untagged-");
        const db = openDatabase();
        const sessionId = "ses-memory-large-untagged";
        const triggerBudget = 1_000;
        seedTriggerPolicy(db, sessionId);
        const covered = observedRawTextMessage(1, "m-covered", "user", "covered prefix");
        insertCoveredMessageTag(db, sessionId, "m-covered", 1, 100);

        const result = checkCompartmentTrigger(
            db,
            sessionId,
            makeSessionMeta(sessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            triggerBudget,
            undefined,
            undefined,
            undefined,
            undefined,
            inMemoryTail([
                covered.message,
                rawTextMessage(2, "m-new-large", "assistant", "large paste ".repeat(8_000)),
            ]),
        );

        expect(result.shouldFire).toBe(false);
        expect(covered.partReads()).toBeGreaterThan(0);
    });

    it("does NOT cheap-skip below-floor tags when inMemoryTail is undefined (no historian suppression)", () => {
        // When inMemoryTail is undefined, the cheap gate uses floor 0 so the bound includes below-floor tags.
        // Using floor 0 keeps the cheap gate conservative and falls through to the authoritative path.
        // The authoritative check then fires when the eligible head exceeds tail_size.
        useTempDataHome("compartment-trigger-belowfloor-undefined-tail-");
        const sessionId = "ses-belowfloor-undefined";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "a ".repeat(3500) },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "b ".repeat(3500) },
            { id: "m-4", role: "assistant", text: "done" },
            { id: "m-5", role: "user", text: "c ".repeat(3500) },
            { id: "m-6", role: "assistant", text: "done" },
            { id: "m-7", role: "user", text: "protected 1" },
            { id: "m-8", role: "user", text: "protected 2" },
            { id: "m-9", role: "user", text: "protected 3" },
            { id: "m-10", role: "user", text: "protected 4" },
            { id: "m-11", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        insertCoveredMessageTag(db, sessionId, "m-1", 1, 3500);
        insertCoveredMessageTag(db, sessionId, "m-3", 2, 3500);
        insertCoveredMessageTag(db, sessionId, "m-5", 3, 3500);

        // taggerFloorOverride exceeds every tag to simulate a collapsed floor without inMemoryTail.
        // A bound of 0 must not cheap-skip tags 1–3.
        const result = checkCompartmentTrigger(
            db,
            sessionId,
            makeSessionMeta(sessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            1_000,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined, // inMemoryTail undefined — the regressing condition
            10_000, // taggerFloorOverride well above the tags' numbers (1..3)
        );

        expect(result.shouldFire).toBe(true);
    });

    it("falls through when the in-memory upper bound equals the trigger budget", () => {
        useTempDataHome("compartment-trigger-memory-equality-");
        const db = openDatabase();
        const sessionId = "ses-memory-equality";
        const triggerBudget = 1_000;
        seedTriggerPolicy(db, sessionId);
        const covered = observedRawTextMessage(1, "m-equal", "user", "covered exact bound");
        insertCoveredMessageTag(db, sessionId, "m-equal", 1, triggerBudget);

        const result = checkCompartmentTrigger(
            db,
            sessionId,
            makeSessionMeta(sessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            triggerBudget,
            undefined,
            undefined,
            undefined,
            undefined,
            inMemoryTail([covered.message]),
        );

        expect(result.shouldFire).toBe(false);
        expect(covered.partReads()).toBeGreaterThan(0);
    });

    it("falls through for an in-memory tail when the persisted token bound has null counts", () => {
        useTempDataHome("compartment-trigger-memory-null-count-");
        const db = openDatabase();
        const sessionId = "ses-memory-null-count";
        seedTriggerPolicy(db, sessionId);
        const covered = observedRawTextMessage(1, "m-null", "user", "covered null count");
        insertCoveredMessageTag(db, sessionId, "m-null", 1, null);

        const result = checkCompartmentTrigger(
            db,
            sessionId,
            makeSessionMeta(sessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            1_000,
            undefined,
            undefined,
            undefined,
            undefined,
            inMemoryTail([covered.message]),
        );

        expect(result.shouldFire).toBe(false);
        expect(covered.partReads()).toBeGreaterThan(0);
    });

    it("keeps above-proactive-floor in-memory behavior unchanged by always running the full inspection", () => {
        useTempDataHome("compartment-trigger-memory-above-floor-");
        const db = openDatabase();
        const sessionId = "ses-memory-above-floor";
        seedTriggerPolicy(db, sessionId);
        const covered = observedRawTextMessage(1, "m-above", "user", "covered tiny tail");
        insertCoveredMessageTag(db, sessionId, "m-above", 1, 10);

        const result = checkCompartmentTrigger(
            db,
            sessionId,
            makeSessionMeta(sessionId, 64),
            { percentage: 64, inputTokens: 128_000 },
            64,
            65,
            1_000,
            undefined,
            undefined,
            undefined,
            undefined,
            inMemoryTail([covered.message]),
        );

        expect(result.shouldFire).toBe(false);
        expect(covered.partReads()).toBeGreaterThan(0);
    });
    it("fires proactively near the execute threshold when pending drops are insufficient and the unsummarized tail is meaningful", () => {
        useTempDataHome("compartment-trigger-proactive-");
        createOpenCodeDb("ses-proactive", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "a ".repeat(7000) },
            { id: "m-4", role: "assistant", text: "b ".repeat(7000) },
            { id: "m-5", role: "user", text: "protected tail 1" },
            { id: "m-6", role: "user", text: "protected tail 2" },
            { id: "m-7", role: "user", text: "protected tail 3" },
            { id: "m-8", role: "user", text: "protected tail 4" },
            { id: "m-9", role: "user", text: "protected tail 5" },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-proactive", "m-1", "message", 950, 1);
        insertTag(db, "ses-proactive", "m-2", "message", 50, 2);
        queuePendingOp(db, "ses-proactive", 2, "drop", 1);

        const result = checkCompartmentTrigger(
            db,
            "ses-proactive",
            makeSessionMeta("ses-proactive", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            6500,
        );

        expect(result).toMatchObject({ shouldFire: true, reason: "projected_headroom" });
    });

    it("does not fire proactively when pending drops already project usage below the post-drop target", () => {
        useTempDataHome("compartment-trigger-projected-");
        createOpenCodeDb("ses-projected", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "a ".repeat(5000) },
            { id: "m-4", role: "assistant", text: "b ".repeat(5000) },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-projected", "m-1", "message", 800, 1);
        insertTag(db, "ses-projected", "m-2", "message", 200, 2);
        queuePendingOp(db, "ses-projected", 1, "drop", 1);

        const result = checkCompartmentTrigger(
            db,
            "ses-projected",
            makeSessionMeta("ses-projected", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            6500,
        );

        expect(result).toEqual({ shouldFire: false });
    });

    it("projects aged reasoning only when the provider can clear it from the wire", () => {
        // Providers that cannot clear aged reasoning must fire at 36.8% pressure because excluding it projects 11.0%, below the 16.2% target.
        useTempDataHome("compartment-trigger-unavailable-reasoning-");
        const sessionId = "ses-unavailable-reasoning";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "a ".repeat(3500) },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "b ".repeat(3500) },
            { id: "m-4", role: "assistant", text: "done" },
            { id: "m-5", role: "user", text: "c ".repeat(3500) },
            { id: "m-6", role: "assistant", text: "done" },
            { id: "m-7", role: "user", text: "protected tail 1" },
            { id: "m-8", role: "user", text: "protected tail 2" },
            { id: "m-9", role: "user", text: "protected tail 3" },
            { id: "m-10", role: "user", text: "protected tail 4" },
            { id: "m-11", role: "user", text: "protected tail 5" },
        ]);
        const db = openDatabase();
        // Excluding tag 1's aged reasoning leaves 300 reclaimable bytes.
        // The provider gate excludes the 700 aged reasoning bytes from reclaimable bytes.
        insertTag(db, sessionId, "m-1", "message", 299, 1, 700);
        insertTag(db, sessionId, "m-11", "message", 1, 51);
        const runTrigger = (reasoningProjection: {
            providerID?: string;
            canClearReasoning?: boolean;
        }) =>
            checkCompartmentTrigger(
                db,
                sessionId,
                makeSessionMeta(sessionId, 36.8),
                { percentage: 36.8, inputTokens: 736_000 },
                36.8,
                21.6,
                6500,
                50,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                reasoningProjection,
            );

        // Including the 700 reasoning bytes as reclaimable projects 11.0%.
        expect(runTrigger({ providerID: "opencode" })).toMatchObject({
            shouldFire: true,
            reason: "projected_headroom",
        });
        // Anthropic clears reasoning through its empty-content sentinel, so aged bytes remain reclaimable and suppress this fire.
        expect(runTrigger({ providerID: "anthropic" })).toEqual({ shouldFire: false });
        // Pi clears typed thinking for every provider, so its shared trigger capability preserves the reclaimable-byte projection for OpenCode-like IDs.
        expect(runTrigger({ providerID: "opencode", canClearReasoning: true })).toEqual({
            shouldFire: false,
        });
    });

    it("does not force-fire at 80% when pending drops are enough to bring usage below target", () => {
        useTempDataHome("compartment-trigger-force-skip-");
        createOpenCodeDb("ses-force-skip", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "follow-up" },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-force-skip", "m-1", "message", 800, 1);
        insertTag(db, "ses-force-skip", "m-2", "message", 200, 2);
        queuePendingOp(db, "ses-force-skip", 1, "drop", 1);

        const result = checkCompartmentTrigger(
            db,
            "ses-force-skip",
            makeSessionMeta("ses-force-skip", 79),
            { percentage: 82, inputTokens: 164_000 },
            79,
            65,
            6500,
        );

        expect(result).toEqual({ shouldFire: false });
    });

    it("keeps raised-threshold usage below the force band on the proactive ladder", () => {
        useTempDataHome("compartment-trigger-derived-force-band-");
        const sessionId = "ses-derived-force-band";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "a ".repeat(3500) },
            { id: "m-2", role: "assistant", text: "b ".repeat(3500) },
            { id: "m-3", role: "user", text: "live prompt" },
            { id: "m-4", role: "assistant", text: "live response" },
        ]);
        const db = openDatabase();
        insertCoveredMessageTag(db, sessionId, "m-1", 1, 7_000);

        // With T=90, the force band starts at 92.
        // T=90's proactive floor prevents the runnable head from force-firing.
        expect(
            checkCompartmentTrigger(
                db,
                sessionId,
                makeSessionMeta(sessionId, 85),
                { percentage: 86, inputTokens: 17_200 },
                85,
                90,
                6_500,
                undefined,
                undefined,
                undefined,
                20_000,
            ),
        ).toEqual({ shouldFire: false });
    });

    it("force-fires at the unchanged default-config band", () => {
        useTempDataHome("compartment-trigger-default-force-band-");
        const sessionId = "ses-default-force-band";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "a ".repeat(3500) },
            { id: "m-2", role: "assistant", text: "b ".repeat(3500) },
            { id: "m-3", role: "user", text: "live prompt" },
            { id: "m-4", role: "assistant", text: "live response" },
        ]);
        const db = openDatabase();

        expect(
            checkCompartmentTrigger(
                db,
                sessionId,
                makeSessionMeta(sessionId, 84),
                { percentage: 85, inputTokens: 17_000 },
                84,
                65,
                6_500,
                undefined,
                undefined,
                undefined,
                20_000,
            ),
        ).toMatchObject({ shouldFire: true, reason: "force_band" });
    });

    it("does not fire when only unsummarized history is inside the protected tail", () => {
        useTempDataHome("compartment-trigger-protected-only-");
        createOpenCodeDb("ses-protected-only", [
            { id: "m-1", role: "user", text: "a".repeat(200) },
            { id: "m-2", role: "user", text: "b".repeat(200) },
            { id: "m-3", role: "user", text: "c".repeat(200) },
        ]);
        const db = openDatabase();

        //#when
        const result = checkCompartmentTrigger(
            db,
            "ses-protected-only",
            makeSessionMeta("ses-protected-only", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            6500,
        );

        // No eligible prefix prevents `checkCompartmentTrigger` from firing.
        expect(result).toEqual({ shouldFire: false });
    });

    it("fires proactively when meaningful eligible history exists before protected tail", () => {
        useTempDataHome("compartment-trigger-eligible-prefix-");
        createOpenCodeDb("ses-eligible-prefix", [
            { id: "m-1", role: "user", text: "a ".repeat(3500) },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "b ".repeat(3500) },
            { id: "m-4", role: "assistant", text: "done" },
            { id: "m-5", role: "user", text: "c ".repeat(3500) },
            { id: "m-6", role: "assistant", text: "done" },
            { id: "m-7", role: "user", text: "protected 1" },
            { id: "m-8", role: "user", text: "protected 2" },
            { id: "m-9", role: "user", text: "protected 3" },
            { id: "m-10", role: "user", text: "protected 4" },
            { id: "m-11", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const result = checkCompartmentTrigger(
            db,
            "ses-eligible-prefix",
            makeSessionMeta("ses-eligible-prefix", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            6500,
        );

        // The eligible prefix spans `m-1` through `m-6` and satisfies the meaningful-history threshold.
        expect(result).toMatchObject({ shouldFire: true, reason: "projected_headroom" });
    });

    it("does NOT tail_size-fire a tool-heavy tail whose narratable (TC) content is thin", () => {
        // The chunked view reduces each tool output to a one-line `TC:` summary.
        // True-raw includes the tool output; narratable content contains only `TC:` summaries and short questions.
        // `tail_size` must use narratable content rather than true-raw content.
        useTempDataHome("compartment-trigger-tool-heavy-");
        const sessionId = "ses-tool-heavy-thin";
        const messages: Array<{ id: string; role: string; text?: string }> = [];
        for (let i = 1; i <= 6; i++) {
            messages.push({ id: `m-u${i}`, role: "user", text: `short question ${i}` });
            // The tool output counts fully toward true-raw content but collapses to a `TC:` line.
            messages.push({ id: `m-a${i}`, role: "assistant", text: undefined });
        }
        for (let i = 1; i <= 5; i++) {
            messages.push({ id: `m-p${i}`, role: "user", text: `protected ${i}` });
        }
        createOpenCodeDb(sessionId, messages);
        const ocPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
        const oc = new Database(ocPath);
        try {
            const insertPart = oc.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            );
            for (let i = 1; i <= 6; i++) {
                insertPart.run(
                    `m-a${i}`,
                    sessionId,
                    i * 2,
                    i * 2,
                    JSON.stringify({
                        type: "tool",
                        callID: `read:${i}`,
                        tool: "read",
                        state: {
                            status: "completed",
                            input: { filePath: `/tmp/file-${i}.ts` },
                            output: `line of file content ${i} `.repeat(1600),
                        },
                    }),
                );
            }
        } finally {
            closeQuietly(oc);
        }
        const db = openDatabase();
        // Tag-token rows keep the live-tail upper bound above `triggerBudget`, so the pre-gate does not short-circuit before `tail_size`.
        // The pre-gate must not short-circuit because `tail_size` runs only after it.
        for (let i = 1; i <= 6; i++) {
            insertTag(
                db,
                sessionId,
                `read:${i}`,
                "tool",
                40_000,
                i,
                0,
                "read",
                64,
                `m-a${i}`,
                null,
                {
                    tokenCount: 10_000,
                    inputTokenCount: 16,
                    reasoningTokenCount: 0,
                },
            );
        }

        // At 25% pressure, proactive triggers cannot fire.
        // `tail_size` is the only trigger eligible at 25% pressure.
        const result = checkCompartmentTrigger(
            db,
            sessionId,
            makeSessionMeta(sessionId, 25),
            { percentage: 25, inputTokens: 50_000 },
            25,
            65,
            5_000,
        );

        // `tail_size` must not fire when narratable content is thin at 25% pressure.
        expect(result.shouldFire).toBe(false);
    });
});
