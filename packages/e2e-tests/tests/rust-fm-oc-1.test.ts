/// <reference types="bun-types" />

/** FM-OC-1: a real module SIGKILL serves the last-known-good wire once, loudly. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import {
    assertExactlyOneLkgOutcome,
    assertLoudModuleFailure,
    assertMessagesHaveNoPlaceholders,
    driveToSteadyState,
    rustPrereqs,
    sessionLogLines,
} from "../src/rust-scenario-support";

const active = rustPrereqs.ok;

describe.skipIf(!active)("rust failure-mode drill FM-OC-1: LKG after SIGKILL", () => {
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
        "continues on the LKG wire and logs the process fault",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 2);
            h.setSessionCacheTtl(sessionId, "0");
            h.mock.setDefault({
                text: "FM-OC-1 LKG capture",
                usage: { input_tokens: 8_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
            });
            await h.sendPrompt(sessionId, `FM-OC-1 capture LKG: ${h.ballast(400)}`);
            await h.waitForRustPasses(4);
            await Bun.sleep(1_000);
            const beforeCount = h.readRustPasses().length;
            const priorWire = JSON.parse(h.lastMainWireSerialized()) as unknown[];

            await h.mcHost.crashHost();
            await h.sendPrompt(sessionId, `FM-OC-1 after SIGKILL: ${h.ballast(400)}`);

            const passes = await h.waitForRustPasses(beforeCount + 1);
            const after = passes.slice(beforeCount);
            const servedLkg = after.some((pass) => pass.servedFrom === "lkg");
            expect(after.some((pass) => pass.servedFrom === "lkg" || pass.servedFrom === "raw")).toBe(true);

            const lines = assertLoudModuleFailure(h, sessionId);
            expect(
                sessionLogLines(h, sessionId).some((line) =>
                    line.includes("rust transform failed; attempting LKG replay"),
                ),
            ).toBe(true);
            assertExactlyOneLkgOutcome(lines, sessionId);
            if (servedLkg) {
                const recoveredWire = JSON.parse(h.lastMainWireSerialized()) as unknown[];
                expect(recoveredWire.slice(0, priorWire.length)).toEqual(priorWire);
                expect(lines.some((line) => line.includes("lkg_replay_served"))).toBe(true);
            } else {
                // OpenCode may revise the prior message while appending the new
                // turn; the shipped seam rejects that LKG and serves loud raw.
                expect(lines.some((line) => line.includes("lkg_content_mismatch"))).toBe(true);
            }
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);
        },
        300_000,
    );
});
