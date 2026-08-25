/// <reference types="bun-types" />

/** FM-OC-2: a dead module crosses the failure threshold and parks with a loud token. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import {
    assertLoudModuleFailure,
    assertMessagesHaveNoPlaceholders,
    driveToSteadyState,
    lineageScopedTagCount,
    RUST_FAILURE_PARK_THRESHOLD,
    rustPrereqs,
    sessionLogLines,
    sendOutagePasses,
} from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust failure-mode drill FM-OC-2: park transition", () => {
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
        "continues through the outage and emits a machine-readable park transition",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 2);
            const beforeCount = h.readRustPasses().length;
            const droppedBefore = lineageScopedTagCount(h, sessionId, "dropped");
            const outagePasses = RUST_FAILURE_PARK_THRESHOLD * 2;

            await h.mcHost.crashHost();
            await sendOutagePasses(h, sessionId, 4, outagePasses, "FM-OC-2 outage");
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).find((line) =>
                        line.includes("mc_rust_park_transition"),
                    ),
                { label: "FM-OC-2 park transition" },
            );

            const passes = await h.waitForRustPasses(beforeCount + outagePasses);
            const outage = passes.slice(beforeCount);
            expect(outage.every((pass) => pass.servedFrom === "lkg" || pass.servedFrom === "raw" || pass.decision === "parked")).toBe(
                true,
            );

            const lines = assertLoudModuleFailure(h, sessionId);
            const transition = lines.find((line) => line.includes("mc_rust_park_transition"));
            expect(transition).toContain(`failure_passes=${RUST_FAILURE_PARK_THRESHOLD}`);
            expect(
                sessionLogLines(h, sessionId).some((line) => line.includes("failure_passes=")),
            ).toBe(true);
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);
            expect(lineageScopedTagCount(h, sessionId, "dropped")).toBe(droppedBefore);
        },
        300_000,
    );
});
