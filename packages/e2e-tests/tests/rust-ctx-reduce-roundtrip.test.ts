/// <reference types="bun-types" />

/**
 *
 * A ctx_reduce drop completes when the next cache-busting pass consumes its ledger entry; a history head may replace its `[dropped §N§]` sentinel.
 *
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface ModuleStatus {
    compartment_count?: number;
    pending_drop_count?: number;
}

describe.skipIf(!rustPrereqs.ok)("rust invariant: ctx_reduce round-trip", () => {

    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "consumes an agent ctx_reduce drop on the next producer-backed bust",
        async () => {
            const sessionId = await h.createSession();


            for (let i = 1; i <= 3; i += 1) {
                h.mock.setDefault({
                    text: `assistant reply ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `ctx_reduce turn ${i}: ${h.ballast(1_500)}`);
            }
            await Bun.sleep(500);

            const wire = h.lastMainWireSerialized();
            const tags = [...new Set([...wire.matchAll(/§(\d+)§/g)].map((m) => Number(m[1])))].sort(
                (a, b) => a - b,
            );
            expect(tags.length).toBeGreaterThan(0);
            const dropTag = tags[0]!;

            let dropEmitted = false;
            h.mock.addMatcher((body) => {
                if (dropEmitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
                    return null;
                }
                const tools = body.tools;
                if (!Array.isArray(tools)) return null;
                const name = (
                    tools.find((t) =>
                        /ctx_reduce/.test(String((t as { name?: unknown })?.name ?? "")),
                    ) as { name?: string } | undefined
                )?.name;
                if (!name) return null;
                dropEmitted = true;
                return {
                    content: [
                        {
                            type: "tool_use",
                            id: `toolu_reduce_${Date.now()}`,
                            name,
                            input: { drop: String(dropTag) },
                        },
                    ],
                    stop_reason: "tool_use",
                    usage: { input_tokens: 8_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
                };
            });
            await h.sendPrompt(sessionId, `ctx_reduce turn 4: reduce tag ${dropTag}`);
            const queued = (await h.mcHost.primaryStatus(
                sessionId,
                h.env.workdir,
                "session.status",
            )) as ModuleStatus;
            expect(queued.pending_drop_count ?? 0).toBeGreaterThan(0);

            // The next turn exceeds the execute threshold, so the bust drains the pending drop.
            for (let i = 5; i <= 10; i += 1) {
                h.mock.setDefault({
                    text: `pressure ${i}`,
                    usage: {
                        input_tokens: 3_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `ctx_reduce pressure turn ${i}: ${h.ballast(2_500)}`);
                await Bun.sleep(200);
            }
            await Bun.sleep(800);

            // The producer may fold the dropped history entry before the final provider request.
            // The producer may replace the transient drop sentinel with m0 before the final provider request.
            // The pending-drop ledger entry proves that the queued command completed.
            expect(dropEmitted).toBe(true);
            const finalStatus = (await h.mcHost.primaryStatus(
                sessionId,
                h.env.workdir,
                "session.status",
            )) as ModuleStatus;
            expect(finalStatus.pending_drop_count ?? -1).toBe(0);
            expect(finalStatus.compartment_count ?? 0).toBeGreaterThan(0);
            expect(await h.mcHost.backendRequestCount()).toBeGreaterThan(0);
            const finalWire = h.lastMainWireSerialized();
            expect(finalWire).toContain("<session-history>");
            expect(finalWire).toContain("Rust reduce e2e chunk");
        },
        300_000,
    );
});
