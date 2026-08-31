/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import {
    type RetrospectiveProjectSession,
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    type RetrospectiveSinceRead,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";
import {
    isRetrospectiveWindowProcessed,
    recordRetrospectiveWindowProcessed,
} from "./storage-task-schedule";
import { parseFrictionGateVerdict } from "./task-executor";

describe("parseFrictionGateVerdict", () => {
    test("clean verdicts: n / y:ords", () => {
        expect(parseFrictionGateVerdict("n")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("y: 3, 7")).toEqual({ hit: true, ordinals: [3, 7] });
        expect(parseFrictionGateVerdict("Y: 5")).toEqual({ hit: true, ordinals: [5] });
        expect(parseFrictionGateVerdict("no")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("yes: 1")).toEqual({ hit: true, ordinals: [1] });
    });

    test("prose-wrapped hit on its own line is still caught", () => {
        const v = "Looking at the lines, the user corrected the agent twice.\ny: 4, 9";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: true, ordinals: [4, 9] });
    });

    test("a stray number in prose BEFORE the verdict line does not fabricate ordinals", () => {
        const v = "I reviewed all 2024 messages.\nn";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: false, ordinals: [] });
    });

    test("ordinals come ONLY from the verdict line, not surrounding prose", () => {
        const v = "Context from 2019 and 2020.\ny: 6\nirrelevant 9999 trailing";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: true, ordinals: [6] });
    });

    test("a prose 'yes…' line (no colon) is NOT a verdict — scanning continues to a real y:N", () => {
        const v = "yes, the user was clearly upset about issue 3 earlier.\ny: 7";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: true, ordinals: [7] });
    });

    test("a prose 'yes…' line with NO following verdict fails safe (no harvested ordinals)", () => {
        expect(parseFrictionGateVerdict("yes the user mentioned 5 and 6 problems")).toEqual({
            hit: false,
            ordinals: [],
        });
    });

    test("'y' with no ordinals is NOT a hit (nothing to deepen on)", () => {
        expect(parseFrictionGateVerdict("y")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("yes, some friction")).toEqual({
            hit: false,
            ordinals: [],
        });
    });

    test("embedded y:<nums> with no clean verdict line is accepted", () => {
        expect(parseFrictionGateVerdict("verdict y: 2, 3 done")).toEqual({
            hit: true,
            ordinals: [2, 3],
        });
    });

    test("garbage fails safe (no hit)", () => {
        expect(parseFrictionGateVerdict("")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("maybe?")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("the answer is unclear")).toEqual({
            hit: false,
            ordinals: [],
        });
    });
});

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});
function freshDb(): Database {
    const database = createDirectTestDatabase().db;
    return database;
}

function u(sessionId: string, ts: number, text: string): RetrospectiveRawMessage {
    return { sessionId, ordinal: 0, role: "user", text, ts };
}

/** The scripted provider's `since` method returns rows with `ts > watermark`.
 * The `before` method returns the newest `count` rows with `ts <= watermark`. */
class ScriptedProvider implements RetrospectiveRawProvider {
    constructor(
        private readonly sessions: string[],
        private readonly rowsBySession: Map<string, RetrospectiveRawMessage[]>,
    ) {}
    listProjectSessions(): RetrospectiveProjectSession[] {
        return this.sessions.map((sessionId) => ({
            sessionId,
            updatedAt: Math.max(
                0,
                ...(this.rowsBySession.get(sessionId) ?? []).map((row) => row.ts),
            ),
        }));
    }
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead {
        // The test provider returns each session's oldest rows first and caps each session independently.
        // The test provider reports whether each per-session result was truncated.
        const limit = Math.max(1, Math.floor(capPerSession));
        const eligible = (this.rowsBySession.get(sessionId) ?? [])
            .filter((r) => r.ts > sinceMs)
            .sort((a, b) => a.ts - b.ts);
        return { messages: eligible.slice(0, limit), truncated: eligible.length > limit };
    }
    readOldestMessageTimesSince(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> {
        const out = new Map<string, number>();
        for (const sessionId of sessionIds) {
            const oldest = (this.rowsBySession.get(sessionId) ?? [])
                .filter((r) => r.ts > sinceMs)
                .sort((a, b) => a.ts - b.ts)[0];
            if (oldest) out.set(sessionId, oldest.ts);
        }
        return out;
    }
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        return (this.rowsBySession.get(sessionId) ?? [])
            .filter((r) => r.ts <= beforeMs)
            .sort((a, b) => a.ts - b.ts)
            .slice(-count);
    }
}

describe("readRetrospectiveScanWindow", () => {
    test("merges since + overlap; maxScannedTs comes ONLY from the since portion", async () => {
        const rows = new Map([
            [
                "s1",
                [
                    u("s1", 100, "old1"),
                    u("s1", 150, "old2"),
                    u("s1", 250, "new1"),
                    u("s1", 300, "new2"),
                ],
            ],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 200, 2);
        const texts = win.messages.map((m) => m.text);
        expect(texts.sort()).toEqual(["new1", "new2", "old1", "old2"]);
        // watermark only advances to the newest SINCE row, never pulled back by overlap.
        expect(win.maxScannedTs).toBe(300);
    });

    test("watermark=0 (never scanned) reads no overlap, only since", async () => {
        const rows = new Map([["s1", [u("s1", 100, "a"), u("s1", 200, "b")]]]);
        const provider = new ScriptedProvider(["s1"], rows);
        const win = await readRetrospectiveScanWindow(provider, "proj", 0, 12);
        expect(win.messages.map((m) => m.text).sort()).toEqual(["a", "b"]);
        expect(win.maxScannedTs).toBe(200);
    });

    test("backlog: keeps the OLDEST since-rows and never advances the watermark past a dropped row (global cap)", async () => {
        // With six post-watermark rows and a global cap of three, the scan keeps the oldest three and stops the watermark below the first dropped row.
        // The scan stops the watermark below the first dropped row so later rows are re-read next run.
        // Stopping below the first dropped row causes every dropped newer row to be re-read next run.
        const rows = new Map([
            [
                "s1",
                [
                    u("s1", 110, "a1"),
                    u("s1", 120, "a2"),
                    u("s1", 130, "a3"),
                    u("s1", 140, "a4"),
                    u("s1", 150, "a5"),
                    u("s1", 160, "a6"),
                ],
            ],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win.messages.map((m) => m.text)).toEqual(["a1", "a2", "a3"]);
        // The watermark is the newest kept timestamp, `a3 @ 130`; `a4` through `a6` are newer and are re-read next run.
        expect(win.maxScannedTs).toBe(130);

        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win2.messages.map((m) => m.text)).toEqual(["a4", "a5", "a6"]);
        expect(win2.maxScannedTs).toBe(160);
    });

    test("same-ms group split by the global cap: watermark clamps below it so the sibling is not lost", async () => {
        // Neither session is saturated, so `saturatedFrontier` remains `+Inf`; the global cap can still split rows with the same timestamp.
        // The global cap keeps `a3` and drops `b3` even though both have timestamp `130`; a timestamp-only watermark of `130` would skip `b3` forever.
        // The watermark must remain below `130` so the next run re-reads dropped `b3`.
        const rows = new Map([
            ["s1", [u("s1", 110, "a1"), u("s1", 120, "a2"), u("s1", 130, "a3")]],
            ["s2", [u("s2", 130, "b3")]],
        ]);
        const provider = new ScriptedProvider(["s1", "s2"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win.messages.map((m) => m.text).sort()).toEqual(["a1", "a2", "a3"]);
        expect(win.maxScannedTs).toBe(129);

        // With a watermark of `129`, the next run re-reads `a3` and previously dropped `b3`; idempotence deduplicates `a3`.
        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win2.messages.map((m) => m.text).sort()).toEqual(["a3", "b3"]);
        expect(win2.maxScannedTs).toBe(130);
    });

    test("backlog: a per-session-saturated batch caps the watermark at its frontier", async () => {
        // When `capPerSession` is `2`, the provider returns the session's oldest two rows and leaves newer rows unseen.
        // The watermark must not pass the last kept timestamp because newer rows remain unseen.
        const rows = new Map([
            ["s1", [u("s1", 110, "a1"), u("s1", 120, "a2"), u("s1", 130, "a3")]],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 2,
        });
        expect(win.messages.map((m) => m.text)).toEqual(["a1", "a2"]);
        // Because the provider returned exactly two rows, saturation sets `frontier` to 119.
        expect(win.maxScannedTs).toBe(119);
    });

    test("saturation uses the explicit `truncated` signal, not messages.length", async () => {
        // A provider can report `truncated=true` after normalization drops rows, even when its normalized output is shorter than its cap.
        // A length-based saturation guess false-negatives after normalization drops rows.
        // The provider's `truncated` signal overrides normalized result length.
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "s1" }],
            readUserMessagesSince: () => ({
                messages: [u("s1", 130, "kept")],
                truncated: true,
            }),
            readUserMessagesBefore: () => [],
        };
        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 5,
        });
        // The explicit truncation signal sets `frontier` to `129` even though one normalized row is below cap `5`.
        expect(win.maxScannedTs).toBe(129);
    });

    test("session cap drains oldest eligible sessions without skipping older backlog", async () => {
        const sessionIds = Array.from({ length: 25 }, (_, i) => `s${25 - i}`);
        const rows = new Map(
            sessionIds.map((sessionId) => {
                const n = Number(sessionId.slice(1));
                return [sessionId, [u(sessionId, 100 + n, `message-${sessionId}`)]] as const;
            }),
        );
        const provider = new ScriptedProvider(sessionIds, rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 20,
        });

        expect(win.messages).toHaveLength(20);
        expect(win.messages.map((m) => m.sessionId)).toEqual(
            Array.from({ length: 20 }, (_, i) => `s${i + 1}`),
        );
        expect(win.maxScannedTs).toBe(120);

        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 20,
        });
        expect(win2.messages.map((m) => m.sessionId)).toEqual(["s21", "s22", "s23", "s24", "s25"]);
        expect(win2.maxScannedTs).toBe(125);

        const scanned = [...win.messages, ...win2.messages].map((message) => message.sessionId);
        expect(new Set(scanned).size).toBe(25);
        expect(scanned.sort()).toEqual(sessionIds.slice().sort());
    });

    test("session cap clamps to the oldest pending message in an excluded long session", async () => {
        const rows = new Map([
            ["recent-short", [u("recent-short", 120, "already later")]],
            [
                "long-session",
                [u("long-session", 115, "older backlog"), u("long-session", 200, "tail")],
            ],
        ]);
        const provider = new ScriptedProvider(["recent-short", "long-session"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 1,
        });
        expect(win.messages.map((m) => m.text)).toEqual(["older backlog", "tail"]);
        expect(win.maxScannedTs).toBe(119);

        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 1,
        });
        expect(win2.messages.map((m) => m.text)).toEqual(["already later"]);
        expect(win2.maxScannedTs).toBe(120);

        const win3 = await readRetrospectiveScanWindow(provider, "proj", win2.maxScannedTs, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 1,
        });
        expect(win3.messages.map((m) => m.text)).toEqual(["tail"]);
        expect(win3.maxScannedTs).toBe(200);
    });

    test("dedupes a row that appears in both since and overlap reads", async () => {
        // The `before` read includes the row at the `since` boundary.
        const rows = new Map([["s1", [u("s1", 200, "boundary"), u("s1", 250, "after")]]]);
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "s1" }],
            readUserMessagesSince: (_s, since) => ({
                messages: (rows.get("s1") ?? []).filter((r) => r.ts > since),
                truncated: false,
            }),
            // The overlap read also returns the boundary row at timestamp 200.
            readUserMessagesBefore: () => [u("s1", 200, "boundary")],
        };
        const win = await readRetrospectiveScanWindow(provider, "proj", 199, 5);
        // The boundary row at timestamp 200 is greater than 199, so both reads return it; deduplication leaves one copy.
        expect(win.messages.filter((m) => m.text === "boundary")).toHaveLength(1);
    });
});

describe("retrospective processed-window idempotence", () => {
    test("record then check round-trips per (project, key)", () => {
        db = freshDb();
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(false);
        recordRetrospectiveWindowProcessed(db, "proj", "k1");
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(true);
        // The database keys processed windows by `(project, key)`.
        expect(isRetrospectiveWindowProcessed(db, "proj", "k2")).toBe(false);
        expect(isRetrospectiveWindowProcessed(db, "other", "k1")).toBe(false);
    });

    test("re-recording the same key is an idempotent no-op (no throw)", () => {
        db = freshDb();
        recordRetrospectiveWindowProcessed(db, "proj", "k1");
        expect(() => recordRetrospectiveWindowProcessed(db, "proj", "k1")).not.toThrow();
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(true);
    });
});
