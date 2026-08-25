/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface HistorianStatus {
    last_failure?: string | null;
    failure_backoff_at_ms?: number | null;
}

describe.skipIf(!rustPrereqs.ok)("rust historian: direct Broca backend", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                historian: { model: "fixture/deterministic" },
                compressor: { enabled: false },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    async function status(sessionId: string): Promise<HistorianStatus> {
        const response = await h.mcHost.primaryStatus(sessionId, h.env.workdir);
        const historian = response.historian;
        return historian && typeof historian === "object"
            ? (historian as HistorianStatus)
            : {};
    }

    async function driveHistorian(sessionId: string): Promise<void> {
        for (let i = 1; i <= 10; i += 1) {
            h.mock.setDefault({
                text: `historian backend assistant ${i}`,
                usage: {
                    input_tokens: 3_000 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(
                sessionId,
                `historian turn ${i}: ${h.ballast(2_000)}`,
            );
        }
        h.mock.setDefault({
            text: "historian trigger",
            usage: {
                input_tokens: 27_000,
                output_tokens: 20,
                cache_creation_input_tokens: 2_000,
            },
        });
        await h.sendPrompt(sessionId, `historian trigger: ${h.ballast(2_000)}`);
        h.mock.setDefault({
            text: "historian follow-up",
            usage: {
                input_tokens: 500,
                output_tokens: 20,
                cache_creation_input_tokens: 0,
            },
        });
        await h.sendPrompt(
            sessionId,
            "historian follow-up starts the Broca run",
        );
    }

    async function waitForBackend(
        predicate: (
            counters: Awaited<ReturnType<typeof h.mcHost.backendCounters>>,
        ) => boolean,
    ): Promise<Awaited<ReturnType<typeof h.mcHost.backendCounters>>> {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            const counters = await h.mcHost.backendCounters();
            if (predicate(counters)) return counters;
            await Bun.sleep(100);
        }
        throw new Error(
            `Broca backend was not reached\n${h.mcHost.hostLog().slice(-8_000)}`,
        );
    }

    it("reaches the real Broca route through the controlled backend", async () => {
        await h.mcHost.backendSuccess();
        const sessionId = await h.createSession();
        await driveHistorian(sessionId);

        const counters = await waitForBackend((value) => value.completed >= 1);
        expect(counters.started).toBeGreaterThanOrEqual(1);
        expect(counters.completed).toBeGreaterThanOrEqual(1);
    }, 300_000);

    it("records a typed backend failure without killing a provider process", async () => {
        const before = await h.mcHost.backendCounters();
        await h.mcHost.failNextBackendCall();
        const sessionId = await h.createSession();
        await driveHistorian(sessionId);

        const counters = await waitForBackend(
            (value) => value.failed > before.failed,
        );
        expect(counters.failed).toBe(before.failed + 1);

        const deadline = Date.now() + 120_000;
        let failed: HistorianStatus = {};
        while (Date.now() < deadline) {
            failed = await status(sessionId);
            if (failed.last_failure) break;
            await Bun.sleep(100);
        }
        expect(failed.last_failure).toMatch(/backend|broca|fixture|terminal/i);
        expect(failed.failure_backoff_at_ms ?? 0).toBeGreaterThan(0);
    }, 300_000);
});
