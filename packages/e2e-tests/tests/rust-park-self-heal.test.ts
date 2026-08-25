/// <reference types="bun-types" />

/**
 * Incident regression #4: consecutive module failures parked the adapter
 * permanently while every dashboard read green.
 *
 * The bug: when the module became unavailable (or rejected) for a stretch, the
 * adapter parked the session after three consecutive failures and never
 * recovered — usage climbed past threshold with zero folds. The park self-heal
 * fix (now MERGED into this branch's base) re-primes and resumes serving once the
 * module is healthy again, and arms park recovery on pressure (a parked session
 * retries sooner at ≥90% usage) with a fail-closed abort at ≥95% so it never
 * replays stale bytes into a provider-proven overflow.
 *
 * This file has TWO arms exercising different fault shapes; both assert the
 * shipped OUTCOME (no permanent park; transform resumes) not the mechanism:
 *
 *  A. module-restart recovery — kill and restart the McHandler module mid-session
 *     against the same daemon + store. The raw array is unchanged, so the
 *     adapter's ordinal state stays valid; the only failure window is the brief
 *     reconnect. A module restart mid-session must recover on the following
 *     passes with no permanent degradation.
 *
 *  B. park-then-heal — force three+ consecutive failures so the adapter actually
 *     PARKS (module killed and kept down), then restore the module and assert the
 *     session un-parks and resumes serving. This is the arm the merged
 *     park-self-heal fix makes pass; before it, a prolonged outage parked
 *     permanently and never recovered.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust incident regression: park self-heal", () => {
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

    // Arm A — always active where prereqs are met.
    it("recovers after a mid-session module restart without permanent degradation", async () => {
        const sessionId = await h.createSession();
        await driveToSteadyState(h, sessionId, 3);

        const before = h.readRustPasses();
        expect(before.some((p) => p.servedFrom === "transform")).toBe(true);
        const beforeCount = before.length;

        // Kill and restart the module against the same daemon + store. This is the
        // clean fault-injection window the daemon supervises: the store's
        // single-writer lease is released and re-acquired, and the plugin's subc
        // client transparently reconnects on its next call.
        await h.mcHost.restartHost();
        await Bun.sleep(500);

        // Subsequent passes must recover. The first may fail during the reconnect
        // window; what matters is the session does not permanently degrade.
        for (let i = 4; i <= 7; i += 1) {
            h.mock.setDefault({
                text: `post-restart assistant ${i}`,
                usage: {
                    input_tokens: 2_000 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `post-restart turn ${i}: ${h.ballast(400)}`);
            await Bun.sleep(300);
        }

        const all = await h.waitForRustPasses(beforeCount + 4);
        const after = all.slice(beforeCount);

        // Wedge-free recovery: the module served real transforms again after the
        // restart, and the session is not left permanently parked.
        expect(after.some((p) => p.servedFrom === "transform")).toBe(true);
        expect(after.at(-1)!.decision).not.toBe("parked");
    }, 300_000);

    // Arm B — the merged park-self-heal fix makes this pass.
    it(
        "un-parks and resumes serving after the module recovers from a prolonged outage",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 3);
            const beforeCount = h.readRustPasses().length;

            // Prolonged outage: kill the module and keep it down across several
            // passes so the adapter crosses its three-failure park threshold.
            await h.mcHost.crashHost();
            for (let i = 4; i <= 8; i += 1) {
                h.mock.setDefault({
                    text: `outage assistant ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `outage turn ${i}: ${h.ballast(400)}`);
                await Bun.sleep(300);
            }

            // Restore the module and drive enough passes for the self-heal probe
            // cadence to retry and recover.
            await h.mcHost.restartHost();
            await Bun.sleep(500);
            for (let i = 9; i <= 18; i += 1) {
                h.mock.setDefault({
                    text: `recovery assistant ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `recovery turn ${i}: ${h.ballast(400)}`);
                await Bun.sleep(300);
            }

            const all = await h.waitForRustPasses(beforeCount + 15);
            const recovery = all.slice(beforeCount + 5);

            // Outcome: after the module recovers the session un-parks and serves
            // real transforms again — no permanent park.
            expect(recovery.some((p) => p.servedFrom === "transform")).toBe(true);
            expect(recovery.at(-1)!.decision).not.toBe("parked");
        },
        300_000,
    );
});
