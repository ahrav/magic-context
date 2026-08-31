/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness, type RustPassLine } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const formatTiming = (pass: RustPassLine) => ({
    messages: pass.inputCount,
    adapter_ms: pass.adapterElapsedMs,
    module_ms: pass.moduleElapsedMs,
    prefix_guard_ms: pass.prefixGuardMs,
    state_sync_ms: pass.stateSyncMs,
    wire_build_ms: pass.wireBuildMs,
    wire_messages: pass.wireMessages,
    transport_ms: pass.transportMs,
    transport_pages: pass.transportPages,
    transport_bytes: pass.transportBytes,
});

describe.skipIf(!rustPrereqs.ok)("rust transport: large tail delta", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 50_000_000,
            magicContextConfig: {
                execute_threshold_percentage: 95,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("keeps module paging bounded while preserving a large provider-visible tail", async () => {
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "establish the initial module snapshot");
        await h.waitForRustPasses(1);

        h.appendSyntheticHistory(sessionId, { count: 1_000, textBytes: 1024 });
        await h.restart({
            rust: true,
            magicContextConfig: {
                execute_threshold_percentage: 95,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
        await h.sendPrompt(sessionId, "prime the synthetic big-session snapshot", {
            timeoutMs: 300_000,
        });
        const primed = await h.waitFor(
            () => {
                const passes = h.readRustPasses();
                for (let index = passes.length - 1; index >= 0; index -= 1) {
                    if (passes[index]!.inputCount > 1_000) return passes[index];
                }
                return undefined;
            },
            { timeoutMs: 30_000, label: "primed 1,000-message rust pass" },
        );
        expect(primed.inputCount).toBeGreaterThan(1_000);
        expect(primed.servedFrom).toBe("transform");
        expect(primed.transportPages).toBeGreaterThan(1);

        let settled = primed;
        for (let probe = 0; !settled.applied && probe < 3; probe += 1) {
            const before = h.readRustPasses().length;
            await h.sendPrompt(sessionId, `settle the synthetic big-session snapshot ${probe}`);
            settled = (await h.waitForRustPasses(before + 1)).at(-1)!;
        }
        expect(settled.applied).toBe(true);

        const smallDeltas: RustPassLine[] = [];
        for (let probe = 0; probe < 5; probe += 1) {
            const before = h.readRustPasses().length;
            await h.sendPrompt(sessionId, `small steady-state delta ${probe}`);
            smallDeltas.push((await h.waitForRustPasses(before + 1)).at(-1)!);
        }
        const smallDelta = [...smallDeltas].sort(
            (left, right) => left.adapterElapsedMs - right.adapterElapsedMs,
        )[Math.floor(smallDeltas.length / 2)]!;

        const providerBytesBeforeLargeTail = h.lastMainWireBytes();
        const before = h.readRustPasses().length;
        await h.sendPrompt(sessionId, `large tail delta: ${h.ballast(160_000)}`, {
            timeoutMs: 300_000,
        });
        const largeTailDelta = (await h.waitForRustPasses(before + 1)).at(-1)!;
        const providerBytesAfterLargeTail = h.lastMainWireBytes();

        console.log(
            `[rust-e2e] large tail delta timings ${JSON.stringify({
                primed: formatTiming(primed),
                small_delta_samples: smallDeltas.map(formatTiming),
                small_delta_p50: formatTiming(smallDelta),
                large_tail_delta: formatTiming(largeTailDelta),
                provider_bytes_before: providerBytesBeforeLargeTail,
                provider_bytes_after: providerBytesAfterLargeTail,
            })}`,
        );

        expect(smallDeltas.every((pass) => pass.applied)).toBe(true);
        expect(smallDelta.prefixGuardMs).toBeLessThan(10);
        expect(smallDelta.stateSyncMs).toBeLessThan(15);
        expect(smallDelta.wireBuildMs).toBeLessThan(10);
        if (process.env.MC_RUST_E2E_STRICT_PERF === "1") {
            expect(smallDelta.transportMs).toBeLessThan(30);
            expect(smallDelta.adapterElapsedMs).toBeLessThan(100);
        }
        expect(smallDeltas.every((pass) => pass.wireMessages <= 4)).toBe(true);
        expect(smallDeltas.every((pass) => pass.transportPages === 1)).toBe(true);
        expect(smallDeltas.every((pass) => pass.transportBytes < 512 * 1024)).toBe(true);

        expect(largeTailDelta.applied).toBe(true);
        expect(largeTailDelta.transportPages).toBeGreaterThanOrEqual(1);
        expect(largeTailDelta.transportPages).toBeLessThanOrEqual(6);
        expect(largeTailDelta.wireMessages).toBeLessThanOrEqual(4);
        if (largeTailDelta.transportPages === 1) {
            expect(largeTailDelta.transportBytes).toBeLessThan(512 * 1024);
        } else {
            expect(largeTailDelta.transportBytes).toBeGreaterThan(512 * 1024);
        }
        expect(providerBytesAfterLargeTail).toBeGreaterThan(providerBytesBeforeLargeTail + 512 * 1024);
        expect(h.lastMainWireSerialized()).toContain("large tail delta");
    }, 600_000);
});
