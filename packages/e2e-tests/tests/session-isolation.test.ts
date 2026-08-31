/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 *
 *  1. Session isolation — tags and session_meta rows stay scoped to their
 *     own session IDs even when two sessions run in the same project.
 *  2. Session deletion cleanup — when `client.session.delete()` fires, the
 *     plugin clears the session's tags and session_meta via the
 *     `session.deleted` event. The context.db must not accumulate orphan
 *     rows for deleted sessions.
 */

const RUST_MODE = process.env.MC_E2E_MODE === "rust";

let h: TestHarness;

async function rustSessionStatus(
    sessionId: string,
): Promise<Record<string, unknown>> {
    const stack = h.mcHostStack;
    if (!stack)
        throw new Error("Rust lifecycle check requires the hermetic module stack");
    return stack.primaryStatus(
        sessionId,
        h.opencode.env.workdir,
        "session.status",
    );
}

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 80,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("session lifecycle", () => {
    it("tags and session_meta are scoped per session", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 50,
                cache_read_input_tokens: 50,
            },
        });

        const a = await h.createSession();
        const b = await h.createSession();

        await h.sendPrompt(a, "session A turn 1");
        await h.sendPrompt(a, "session A turn 2");
        await h.sendPrompt(b, "session B turn 1");

        // Each session gets its own tags and session_meta row. The plugin
        // must not mix them even in the same project/workdir.
        const tagsA = RUST_MODE
            ? Number((await rustSessionStatus(a)).tag_count ?? 0)
            : h.countTags(a);
        const tagsB = RUST_MODE
            ? Number((await rustSessionStatus(b)).tag_count ?? 0)
            : h.countTags(b);
        console.log(`[TEST] tags A=${tagsA} B=${tagsB}`);

        expect(tagsA).toBeGreaterThan(0);
        expect(tagsB).toBeGreaterThan(0);
        expect(tagsA).toBeGreaterThan(tagsB);

        const metaRows = h
            .contextDb()
            .prepare("SELECT session_id FROM session_meta WHERE session_id IN (?, ?)")
            .all(a, b) as Array<{ session_id: string }>;
        const seen = new Set(metaRows.map((r) => r.session_id));
        expect(seen.has(a)).toBe(true);
        expect(seen.has(b)).toBe(true);
    }, 60_000);

    it("session deletion clears tags and session_meta", async () => {
            h.mock.reset();
            h.mock.setDefault({
                text: "ok",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 50,
                },
            });

            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "lifecycle turn 1");
            await h.sendPrompt(sessionId, "lifecycle turn 2");

            // Rust mode stores tags in module state; TypeScript mode stores them in context.db.
        const tagCountBefore = RUST_MODE
            ? Number((await rustSessionStatus(sessionId)).tag_count ?? 0)
            : h.countTags(sessionId);
        expect(tagCountBefore).toBeGreaterThan(0);
            const metaBefore = h
                .contextDb()
                .prepare("SELECT COUNT(*) AS n FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { n: number };
            expect(metaBefore.n).toBe(1);

            // SdkClient lacks a delete signature, so call fetch directly.
            const del = await fetch(
                `${h.opencode.url}/session/${encodeURIComponent(sessionId)}`,
                { method: "DELETE" },
            );
            expect(del.ok).toBe(true);

            // The session.deleted handler runs asynchronously.
            // The delay lets the asynchronous `session.deleted` handler finish before cleanup assertions.
        if (RUST_MODE) {
            const deadline = Date.now() + 15_000;
            let tagCountAfter = tagCountBefore;
            while (Date.now() < deadline) {
                tagCountAfter = Number(
                    (await rustSessionStatus(sessionId)).tag_count ?? 0,
            );
                if (tagCountAfter === 0) break;
                await Bun.sleep(100);
            }
            expect(tagCountAfter).toBe(0);
        } else {
            await h.waitFor(() => h.countTags(sessionId) === 0, {
                timeoutMs: 5_000,
                label: "tags cleared",
            });
            expect(h.countTags(sessionId)).toBe(0);
        }
            const metaAfter = h
                .contextDb()
                .prepare("SELECT COUNT(*) AS n FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { n: number };
            expect(metaAfter.n).toBe(0);
    }, 60_000);
});
