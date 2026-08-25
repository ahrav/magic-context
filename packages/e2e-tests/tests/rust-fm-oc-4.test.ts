/// <reference types="bun-types" />

/** FM-OC-4: real SIGKILL at provider-proven emergency pressure refuses instead of serving raw bytes. */

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

describe.skipIf(!rustPrereqs.ok)("rust failure-mode drill FM-OC-4: emergency refusal", () => {
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
        "continues briefly through SIGKILL, then bails loudly at the provider-proven wall",
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
                await h.sendPrompt(sessionId, `FM-OC-4 continue after SIGKILL: ${h.ballast(400)}`);
            } catch {
                // The first raw continuation reaches the provider, which proves the limit.
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
            const passCountBeforeRefusal = h.readRustPasses().length;
            try {
                await h.sendPrompt(
                    sessionId,
                    `FM-OC-4 dead module at ${RUST_EMERGENCY_WALL_PCT}%: ${h.ballast(400)}`,
                );
            } catch {
                // OpenCode may surface the refusal as a resolved session error.
            }
            await h.waitForRustPasses(passCountBeforeRefusal + 1);
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).find((line) =>
                        line.includes("mc_rust_emergency_refusal before_lkg"),
                    ),
                { label: "FM-OC-4 emergency refusal" },
            );

            expect(RUST_EMERGENCY_WALL_PCT).toBe(95);
            expect(h.mainRequests().length).toBe(requestCountBeforeRefusal);
            const lines = assertLoudModuleFailure(h, sessionId);
            expect(lines.some((line) => line.includes("mc_rust_emergency_refusal before_lkg"))).toBe(true);
            expect(
                sessionLogLines(h, sessionId)
                    .filter((line) => line.includes("mc_rust_emergency_refusal before_lkg"))
                    .every((line) => !line.includes("lkg_replay_served")),
            ).toBe(true);
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);
        },
        300_000,
    );
});
