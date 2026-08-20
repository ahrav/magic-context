/// <reference types="bun-types" />

/**
 * Compaction-off mode end-to-end (issue #266 S3).
 *
 * Boots a real `opencode serve` with `compaction.enabled: false` and proves the
 * additive-only contract through the full stack — config → boot resolution →
 * transform gating → mode transition → m[0]/m[1] injection:
 *
 *   1. `<project-memory>` injects on EVERY main-agent pass (memory survives).
 *   2. The tagger writes ZERO rows and emits no §N§ prefixes.
 *   3. No compartments are ever created (historian never fires).
 *   4. No drops fire even deep past the execute threshold (all mutating gates
 *      are off), and `fail_closed_blocking: true` stays inert.
 *   5. The per-session mode record commits to "off".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { insertMemory } from "../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { Database } from "../../plugin/src/shared/sqlite";
import { TestHarness } from "../src/harness";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            compaction: { enabled: false },
            // Deliberately armed: compaction-off must make it inert, and the
            // prompts below must still succeed (no blocking, no cancellation).
            fail_closed_blocking: true,
            // Low execute threshold: in ON mode these turns would fire drops;
            // in off mode nothing may fire.
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
    const db = new Database(dbPath);
    try {
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content,
            sourceType: "historian",
        });
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

            // Bootstrap so the plugin creates context.db.
            const bootstrapId = await h.createSession();
            await h.sendPrompt(bootstrapId, "bootstrap turn");
            await h.waitFor(() => h.hasContextDb(), {
                timeoutMs: 10_000,
                label: "plugin initialized",
            });

            // Seed a memory for the workdir project identity.
            const projectIdentity = computeDirIdentity(h.opencode.env.workdir);
            seedMemory(
                h,
                projectIdentity,
                "off-mode seeded directive: always prefer bun over npm for running scripts",
            );

            // Fresh session for the assertions.
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
                const sys = body.system;
                const sysText =
                    sys === undefined || sys === null ? "" : JSON.stringify(sys);
                // Route hidden MC children (historian) away; in off mode they
                // never fire, but keep the guard so an unexpected spawn can't
                // poison the main-agent usage ramp.
                if (sysText.includes("the hippocampus of a long-running coding agent")) {
                    return null;
                }
                mainCalls += 1;
                return {
                    text: `assistant turn ${mainCalls}`,
                    usage: {
                        // Grow reported usage well past the 5% execute threshold.
                        input_tokens: 20_000 + mainCalls * 10_000,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            // Drive several turns with real content mass.
            for (let i = 1; i <= 3; i += 1) {
                await h.sendPrompt(sessionId, `off-mode turn ${i} ${h.ballast(1_500)}`, {
                    timeoutMs: 60_000,
                });
            }

            expect(mainCalls).toBeGreaterThanOrEqual(3);

            // Isolate the main-agent turn requests. OpenCode's title agent echoes
            // the conversation text too, so exclude anything whose system prompt is
            // the title generator; what remains are the real main-agent turns.
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

            // Every main-agent turn carries the injected <project-memory>.
            for (const req of mainRequests) {
                const bodyText = JSON.stringify(req.body);
                expect(bodyText).toContain("<project-memory>");
                expect(bodyText).toContain("off-mode seeded directive");
                // No §N§ tag prefixes anywhere on the wire.
                expect(bodyText).not.toMatch(/§\d+§/);
            }

            // Zero tag rows, zero compartments, mode record committed to off.
            expect(h.countTags(sessionId)).toBe(0);
            expect(h.countCompartments(sessionId)).toBe(0);
            await h.waitFor(() => readModeRecord(h, sessionId) === "off", {
                timeoutMs: 10_000,
                label: "mode record committed to off",
            });

            // No pending ops queued (drops never ran).
            const pendingOps = h
                .contextDb()
                .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                .get(sessionId) as { n: number } | undefined;
            expect(pendingOps?.n ?? 0).toBe(0);
        },
        180_000,
    );
});
