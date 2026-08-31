/// <reference types="bun-types" />

/* */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import {
    assertLoudModuleFailure,
    assertMessagesHaveNoPlaceholders,
    driveToSteadyState,
    RUST_EMERGENCY_WALL_PCT,
    rustPrereqs,
    sessionLogLines,
} from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust failure-mode drill FM-OC-6: emergency arm order", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40, protected_tags: 1 },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "continues briefly through SIGKILL, then refuses before attempting an LKG replay",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 2);

            let overflowSent = false;
            h.mock.addMatcher((body) => {
                const system = JSON.stringify(body.system ?? "");
                if (overflowSent || !system.includes("## Magic Context")) return null;
                overflowSent = true;
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message:
                            "This model's maximum context length is 80000 tokens. Please reduce the length of the messages.",
                    },
                };
            });

            await h.mcHost.crashHost();
            try {
                await h.sendPrompt(sessionId, `FM-OC-6 arm after SIGKILL: ${h.ballast(400)}`);
            } catch {
                // The raw continuation reaches the provider and arms recovery.
            }
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as
                        | { needs_emergency_recovery?: number; detected_context_limit?: number }
                        | undefined;
                    return row?.needs_emergency_recovery === 1 && row.detected_context_limit === 80_000;
                },
                { label: "provider-proven emergency arm" },
            );

            const requestCountBeforeRefusal = h.mainRequests().length;
            const linesBeforeRefusal = sessionLogLines(h, sessionId);
            const passCountBeforeRefusal = h.readRustPasses().length;
            try {
                await h.sendPrompt(sessionId, `FM-OC-6 armed dead module at ${RUST_EMERGENCY_WALL_PCT}%`);
            } catch {
            }
            await h.waitForRustPasses(passCountBeforeRefusal + 1);
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId)
                        .slice(linesBeforeRefusal.length)
                        .find((line) => line.includes("mc_rust_emergency_refusal before_lkg")),
                { label: "FM-OC-6 emergency refusal before LKG" },
            );

            expect(RUST_EMERGENCY_WALL_PCT).toBe(95);
            expect(h.mainRequests().length).toBe(requestCountBeforeRefusal);
            const lines = assertLoudModuleFailure(h, sessionId);
            const after = lines.slice(linesBeforeRefusal.length);
            const refusalIndex = after.findIndex((line) =>
                line.includes("mc_rust_emergency_refusal before_lkg"),
            );
            expect(refusalIndex).toBeGreaterThanOrEqual(0);
            expect(after[refusalIndex]).toContain("before_lkg");
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);
        },
        300_000,
    );
});
