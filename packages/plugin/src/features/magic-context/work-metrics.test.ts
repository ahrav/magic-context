import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import {
    computeOpenCodeWorkMetrics,
    computeOpenCodeWorkMetricsIncremental,
    computePiWorkMetrics,
    emptyWorkMetricsCarry,
} from "./work-metrics";

function createOpenCodeFixture(): Database {
    const db = new Database(":memory:");
    // Unique timestamps preserve insertion order because the oracle SQL breaks time_created ties by id.
    db.exec(
        "CREATE TABLE message (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, time_created INTEGER, data TEXT)",
    );
    return db;
}

function insertAssistant(
    db: Database,
    sessionId: string,
    time: number,
    agent: string,
    input: number,
    output: number,
    cacheRead = 0,
    cacheWrite = 0,
): void {
    db.prepare("INSERT INTO message (session_id, time_created, data) VALUES (?, ?, ?)").run(
        sessionId,
        time,
        JSON.stringify({
            role: "assistant",
            agent,
            tokens: { input, output, cache: { read: cacheRead, write: cacheWrite } },
        }),
    );
}

describe("work metrics", () => {
    test("computes linear growth", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "build", 100, 10);
        insertAssistant(db, "ses", 2, "build", 150, 20);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 170,
            totalInputTokens: 150,
        });
    });

    test("clamps execute drops and sums phase peaks", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "build", 100, 1);
        insertAssistant(db, "ses", 2, "build", 200, 2);
        insertAssistant(db, "ses", 3, "build", 80, 3);
        insertAssistant(db, "ses", 4, "build", 120, 4);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 244,
            totalInputTokens: 320,
        });
    });

    test("partitions by agent", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "a", 100, 10);
        insertAssistant(db, "ses", 2, "b", 500, 20);
        insertAssistant(db, "ses", 3, "a", 150, 30);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 700,
            totalInputTokens: 650,
        });
    });

    test("empty sessions are zero", () => {
        const db = createOpenCodeFixture();
        expect(computeOpenCodeWorkMetrics(db, "missing")).toEqual({
            newWorkTokens: 0,
            totalInputTokens: 0,
        });
    });

    test("Pi metrics mirror the delta and phase-peak logic", () => {
        expect(
            computePiWorkMetrics([
                {
                    role: "assistant",
                    usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
                },
                {
                    role: "assistant",
                    usage: { input: 200, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
                { role: "assistant", usage: { input: 80, output: 3, cacheRead: 0, cacheWrite: 0 } },
                {
                    role: "assistant",
                    usage: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
                },
            ]),
        ).toEqual({ newWorkTokens: 244, totalInputTokens: 320 });
    });

    // The incremental fold must match the window-function oracle while processing only rows after its watermark.

    function createIncrementalFixture(): Database {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
        return db;
    }

    function insertWithId(
        db: Database,
        id: string,
        sessionId: string,
        time: number,
        agent: string,
        input: number,
        output: number,
    ): void {
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        ).run(
            id,
            sessionId,
            time,
            JSON.stringify({ role: "assistant", agent, tokens: { input, output } }),
        );
    }

    test("incremental cold start equals the window-function oracle", () => {
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 1);
        insertWithId(db, "m2", "ses", 2, "build", 200, 2);
        insertWithId(db, "m3", "ses", 3, "build", 80, 3);
        insertWithId(db, "m4", "ses", 4, "build", 120, 4);
        insertWithId(db, "m5", "ses", 5, "a", 500, 9);

        const oracle = computeOpenCodeWorkMetrics(db, "ses");
        const { metrics } = computeOpenCodeWorkMetricsIncremental(
            db,
            "ses",
            emptyWorkMetricsCarry(),
        );
        expect(metrics).toEqual(oracle);
    });

    test("incremental resume across polls equals a single full scan", () => {
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 1);
        insertWithId(db, "m2", "ses", 2, "build", 200, 2);

        const carry = emptyWorkMetricsCarry();
        const first = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        expect(first.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));

        // A second poll must fold only new rows.
        insertWithId(db, "m3", "ses", 3, "build", 80, 3);
        insertWithId(db, "m4", "ses", 4, "build", 120, 4);
        const second = computeOpenCodeWorkMetricsIncremental(db, "ses", first.carry);
        expect(second.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("most-recent row stays volatile until a newer row supersedes it", () => {
        // A poll before and after finalizing a stream-start row must each match the oracle.
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 5);
        insertWithId(db, "m2", "ses", 2, "build", 0, 0); // freshly-created, not yet finalized

        const carry = emptyWorkMetricsCarry();
        const midStream = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        expect(midStream.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));

        // After finalization, the held-back last row must be folded again with its updated tokens.
        db.prepare("UPDATE message SET data = ? WHERE id = ?").run(
            JSON.stringify({
                role: "assistant",
                agent: "build",
                tokens: { input: 250, output: 7 },
            }),
            "m2",
        );
        const finalized = computeOpenCodeWorkMetricsIncremental(db, "ses", midStream.carry);
        expect(finalized.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("idle re-poll with no new rows is stable", () => {
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 1);
        insertWithId(db, "m2", "ses", 2, "build", 150, 2);
        const carry = emptyWorkMetricsCarry();
        const a = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        const b = computeOpenCodeWorkMetricsIncremental(db, "ses", a.carry);
        expect(b.metrics).toEqual(a.metrics);
        expect(b.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("same-timestamp rows: oracle SQL and incremental fold agree on (time_created, id) order", () => {
        // Both paths must order rows with equal time_created by id, or their LAG and phase windows diverge.
        const db = createIncrementalFixture();
        insertWithId(db, "m3", "ses", 5, "build", 80, 3);
        insertWithId(db, "m1", "ses", 5, "build", 100, 1);
        insertWithId(db, "m4", "ses", 5, "build", 120, 4);
        insertWithId(db, "m2", "ses", 5, "build", 200, 2);

        const oracle = computeOpenCodeWorkMetrics(db, "ses");
        const { metrics } = computeOpenCodeWorkMetricsIncremental(
            db,
            "ses",
            emptyWorkMetricsCarry(),
        );
        expect(oracle).toEqual({ newWorkTokens: 244, totalInputTokens: 320 });
        expect(metrics).toEqual(oracle);
    });

    test("same-timestamp resume across polls equals a full scan", () => {
        // Splitting equal-time_created rows across polls must still match the oracle on the second poll.
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 5, "build", 100, 1);
        insertWithId(db, "m2", "ses", 5, "build", 200, 2);
        const carry = emptyWorkMetricsCarry();
        const first = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        expect(first.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));

        insertWithId(db, "m3", "ses", 5, "build", 80, 3);
        insertWithId(db, "m4", "ses", 5, "build", 120, 4);
        const second = computeOpenCodeWorkMetricsIncremental(db, "ses", first.carry);
        expect(second.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("live OpenCode smoke targets stay within 1%", () => {
        if (process.env.MAGIC_CONTEXT_RUN_LIVE_OPENCODE_SMOKE !== "1") return;
        const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
        if (!existsSync(dbPath)) return;
        const db = new Database(dbPath, { readonly: true });
        const cases = [
            ["ses_331acff95fferWZOYF1pG0cjOn", 122_527_859, 345_669_836],
            ["ses_227ce5788ffeRPA9THoPLOQreO", 11_847_315, 71_309_730],
        ] as const;
        for (const [sessionId, expectedNewWork, expectedTotalInput] of cases) {
            const actual = computeOpenCodeWorkMetrics(db, sessionId);
            expect(Math.abs(actual.newWorkTokens - expectedNewWork) / expectedNewWork).toBeLessThan(
                0.01,
            );
            expect(
                Math.abs(actual.totalInputTokens - expectedTotalInput) / expectedTotalInput,
            ).toBeLessThan(0.01);
        }
    });
});
