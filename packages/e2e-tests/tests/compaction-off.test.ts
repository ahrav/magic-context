/// <reference types="bun-types" />

/**
 *
 * Compaction-off preserves memory injection while disabling compaction mutations.
 *
 *   1. `<project-memory>` injects on EVERY main-agent pass (memory survives).
 *   2. The tagger writes ZERO rows and emits no §N§ prefixes.
 *   3. No compartments are ever created (historian never fires).
 * No drops fire past the execute threshold because compaction-off disables all mutating gates.
 * `fail_closed_blocking: true` remains inert when compaction is off.
 *   5. The per-session mode record commits to "off".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { seedProjectMemoryClaim } from "../../plugin/src/features/magic-context/test-claim-database";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { TestHarness } from "../src/harness";
import { openTestDb } from "../src/test-db";
import { isHistorianRequest } from "../src/cache-analysis";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            compaction: { enabled: false },
            // `fail_closed_blocking: true` must remain inert when compaction is off.
            // Prompts must succeed without blocking or cancellation.
            fail_closed_blocking: true,
            // `execute_threshold_percentage` remains 5% so compaction-off gates must suppress drops.
            execute_threshold_percentage: 5,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

function computeDirIdentity(directory: string): string {
    return resolveProjectIdentity(realpathSync(pathResolve(directory)));
}

function seedMemory(h: TestHarness, projectIdentity: string, content: string): void {
    const dbPath = join(h.opencode.env.dataDir, "cortexkit", "magic-context", "context.db");
    const db = openTestDb(dbPath, { readwrite: true });
    try {
        seedProjectMemoryClaim(
            db as unknown as Parameters<typeof seedProjectMemoryClaim>[0],
            { projectIdentity, category: "PROJECT_RULES", content },
        );
    } finally {
        db.close();
    }
}

function readModeRecord(h: TestHarness, sessionId: string): string | null {
    try {
        const row = h
            .contextDb()
            .prepare("SELECT compaction_mode_record FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { compaction_mode_record: string | null } | undefined;
        return row?.compaction_mode_record ?? null;
    } catch {
        return null;
    }
}

describe("compaction-off mode (issue #266 S3)", () => {
    it(
        "keeps memory injection, writes no tags, creates no compartments, drops nothing",
        async () => {
            h.mock.reset();
            h.mock.setDefault({
                text: "ack",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 0,
                },
            });

            // The bootstrap turn creates context.db.
            const bootstrapId = await h.createSession();
            await h.sendPrompt(bootstrapId, "bootstrap turn");
            await h.waitFor(() => h.hasContextDb(), {
                timeoutMs: 10_000,
                label: "plugin initialized",
            });

            const projectIdentity = computeDirIdentity(h.opencode.env.workdir);
            seedMemory(
                h,
                projectIdentity,
                "off-mode seeded directive: always prefer bun over npm for running scripts",
            );

            const sessionId = await h.createSession();
            h.mock.reset();
            h.mock.setDefault({
                text: "assistant ok",
                usage: {
                    input_tokens: 20_000,
                    output_tokens: 50,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            });

            let mainCalls = 0;
            h.mock.addMatcher((body) => {
                // Route hidden MC children (historian) away; in off mode they
                // never fire, but keep the guard so an unexpected spawn can't
                // poison the main-agent usage ramp.
                if (isHistorianRequest(body)) {
                    return null;
                }
                mainCalls += 1;
                return {
                    text: `assistant turn ${mainCalls}`,
                    usage: {
                        // Reported usage exceeds the 5% execute threshold.
                        input_tokens: 20_000 + mainCalls * 10_000,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            for (let i = 1; i <= 3; i += 1) {
                await h.sendPrompt(sessionId, `off-mode turn ${i} ${h.ballast(1_500)}`, {
                    timeoutMs: 60_000,
                });
            }

            expect(mainCalls).toBeGreaterThanOrEqual(3);

            // The request filter excludes title-generator requests because OpenCode's title agent echoes conversation text; retained requests are main-agent turns.
            const requests = h.mock.requests();
            const mainRequests = requests.filter((req) => {
                const bodyText = JSON.stringify(req.body);
                if (!bodyText.includes("off-mode turn")) return false;
                const sys = req.body.system;
                const sysText =
                    sys === undefined || sys === null ? "" : JSON.stringify(sys);
                return !sysText.includes("title generator");
            });
            expect(mainRequests.length).toBeGreaterThanOrEqual(3);

            for (const req of mainRequests) {
                const bodyText = JSON.stringify(req.body);
                expect(bodyText).toContain("<project-memory>");
                expect(bodyText).toContain("off-mode seeded directive");
                expect(bodyText).not.toMatch(/§\d+§/);
            }

            expect(h.countTags(sessionId)).toBe(0);
            expect(h.countCompartments(sessionId)).toBe(0);
            await h.waitFor(() => readModeRecord(h, sessionId) === "off", {
                timeoutMs: 10_000,
                label: "mode record committed to off",
            });

            const pendingOps = h
                .contextDb()
                .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                .get(sessionId) as { n: number } | undefined;
            expect(pendingOps?.n ?? 0).toBe(0);
        },
        180_000,
    );
});
