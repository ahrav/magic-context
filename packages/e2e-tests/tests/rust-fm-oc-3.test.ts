/// <reference types="bun-types" />

/** FM-OC-3: a parked session self-heals when a killed external module returns. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import {
    assertLoudModuleFailure,
    assertMessagesHaveNoPlaceholders,
    driveToSteadyState,
    RUST_FAILURE_PARK_THRESHOLD,
    RUST_PARK_RETRY_INTERVAL,
    rustPrereqs,
    sendOutagePasses,
    sessionLogLines,
} from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust failure-mode drill FM-OC-3: parked self-heal", () => {
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
        "recovers within the exported retry budget without restarting the session",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 2);
            const healthyVersions = h
                .readRustPasses()
                .map((pass) => pass.rowVersion)
                .filter((version) => version > 0);
            const outagePasses = RUST_FAILURE_PARK_THRESHOLD * 2;

            await h.mcHost.crashHost();
            await sendOutagePasses(h, sessionId, 4, outagePasses, "FM-OC-3 outage");
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).find((line) =>
                        line.includes("mc_rust_park_transition"),
                    ),
                { label: "FM-OC-3 park transition" },
            );

            await h.mcHost.restartHost();
            const recoveryStart = h.readRustPasses().length;
            await sendOutagePasses(
                h,
                sessionId,
                4 + outagePasses,
                RUST_PARK_RETRY_INTERVAL * 2,
                "FM-OC-3 recovery",
            );

            const passes = await h.waitFor(
                () => {
                    const observed = h.readRustPasses();
                    return observed
                        .slice(recoveryStart)
                        .some((pass) => pass.servedFrom === "transform")
                        ? observed
                        : undefined;
                },
                { label: "FM-OC-3 recovered transform" },
            );
            const recovery = passes.slice(recoveryStart);
            expect(recovery.length).toBeLessThanOrEqual(RUST_PARK_RETRY_INTERVAL * 2);
            expect(recovery.some((pass) => pass.servedFrom === "transform")).toBe(true);

            const recoveryVersions = recovery
                .map((pass) => pass.rowVersion)
                .filter((version) => version > 0);
            expect(recoveryVersions.length).toBeGreaterThan(0);
            const allVersions = [...healthyVersions, ...recoveryVersions];
            expect(allVersions.every((version, index) => index === 0 || version >= allVersions[index - 1]!)).toBe(
                true,
            );
            expect(recoveryVersions.at(-1)).toBeGreaterThan(healthyVersions.at(-1) ?? 0);
            const lines = sessionLogLines(h, sessionId);
            expect(lines.some((line) => line.includes("mc_rust_park_transition"))).toBe(true);
            assertLoudModuleFailure(h, sessionId);
            assertMessagesHaveNoPlaceholders(h.lastMainMessages(), sessionId);
        },
        300_000,
    );
});
