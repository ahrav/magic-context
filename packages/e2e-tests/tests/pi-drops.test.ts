/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

let h: PiTestHarness;

beforeAll(async () => {
    //
    h = await PiTestHarness.create({
        modelContextLimit: 200,
        magicContextConfig: { protected_tags: 1, execute_threshold_percentage: 20 },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi drops", () => {
    it("drains pending_ops when drops are queued", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "first response",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });

        const first = await h.sendPrompt("first pi drop target", { timeoutMs: 60_000 });
        expect(first.sessionId).toBeTruthy();
        await h.waitFor(() => h.countTags(first.sessionId!) > 0, { label: "tag ready" });

        const writable = openTestDb(h.contextDbPath());
        try {
            writable
                .prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, 'pi')",
                )
                .run(first.sessionId!, Date.now());
        } finally {
            writable.close();
        }

        h.mock.reset();
        h.mock.setDefault({
            text: "second response",
            usage: { input_tokens: 110, output_tokens: 10, cache_creation_input_tokens: 110 },
        });
        const second = await h.sendPrompt("second pi turn drains pending ops", {
            timeoutMs: 60_000,
            continueSession: true,
        });
        expect(second.exitCode).toBeNull();

        expect(h.countPendingOps(first.sessionId!)).toBe(0);
        expect(h.countDroppedTags(first.sessionId!)).toBeGreaterThan(0);
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("dropped §1§");
    }, 60_000);
});
