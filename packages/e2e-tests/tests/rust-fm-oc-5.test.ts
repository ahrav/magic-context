/// <reference types="bun-types" />

/** FM-OC-5: SIGSTOP makes the real transport time out; SIGCONT restores service. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import {
    assertLoudModuleFailure,
    assertMessagesHaveNoPlaceholders,
    driveToSteadyState,
    rustPrereqs,
} from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust failure-mode drill FM-OC-5: transport hang", () => {
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
        "continues through a transport timeout and recovers after SIGCONT",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 2);
            const beforeCount = h.readRustPasses().length;

            h.mcHost.pauseHost();
            await h.sendPrompt(sessionId, `FM-OC-5 stopped module: ${h.ballast(400)}`);
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);

            h.mcHost.resumeHost();
            await h.sendPrompt(sessionId, `FM-OC-5 continued module: ${h.ballast(400)}`);
            const recovered = await h.waitForRustPasses(beforeCount + 2);
            expect(recovered.slice(beforeCount + 1).some((pass) => pass.servedFrom === "transform")).toBe(
                true,
            );

            const lines = assertLoudModuleFailure(h, sessionId);
            expect(lines.some((line) => line.includes("served_from=lkg") || line.includes("served_from=raw"))).toBe(
                true,
            );
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);
        },
        300_000,
    );
});
