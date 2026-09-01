/// <reference types="bun-types" />

/**
 * A warm Rust output cache can serve duplicate Anthropic tool_use IDs when a cache-busting selection pass consumes a queued ctx_reduce drop.
 * Anthropic rejects duplicate tool_use IDs with HTTP 400.
 * A continued transform does not prove that Anthropic accepted the request.
 * failure.
 *
 * A historical tool call may replay in later requests but may occur only once per served messages array.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import {
    DUPLICATE_ID_SKIP_REASON,
    duplicateIdInfraEnabled,
    driveToSteadyState,
    printSkip,
    rustPrereqs,
} from "../src/rust-scenario-support";

interface ServedMessage {
    content?: unknown;
}

function duplicateToolUseIds(messages: readonly ServedMessage[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (!block || typeof block !== "object") continue;
            const candidate = block as { type?: unknown; id?: unknown };
            if (candidate.type !== "tool_use" || typeof candidate.id !== "string") continue;
            if (!seen.add(candidate.id)) duplicates.add(candidate.id);
        }
    }

    return [...duplicates];
}

function visibleTags(wire: string): number[] {
    return [...new Set([...wire.matchAll(/§(\d+)§/g)].map((match) => Number(match[1])))]
        .sort((a, b) => a - b);
}

const active = rustPrereqs.ok && duplicateIdInfraEnabled();

describe.skipIf(!rustPrereqs.ok)("rust incident regression: duplicate tool-use ids", () => {
    it.skipIf(active)("is gated on a broca-capable selection-bust runner", () => {
        printSkip("duplicate-tool-use-ids", DUPLICATE_ID_SKIP_REASON);
        expect(duplicateIdInfraEnabled()).toBe(false);
    });

    let h: RustTestHarness;

    beforeEach(async () => {
        if (!active) return;
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

    it.skipIf(!active)(
        "keeps every served messages array tool-use-id unique when a drop is consumed",
        async () => {
            const sessionId = await h.createSession();

            // The test requires a HARD pass and three SOFT+ defers before queuing the drop.
            await driveToSteadyState(h, sessionId, 3);
            const warmPasses = await h.waitForRustPasses(4);
            expect(warmPasses.some((pass) => pass.decision === "SOFT+")).toBe(true);
            expect(warmPasses.some((pass) => pass.servedFrom === "transform")).toBe(true);
            const beforeDropPassCount = warmPasses.length;

            const tags = visibleTags(h.lastMainWireSerialized());
            expect(tags.length).toBeGreaterThan(0);
            const dropTag = tags[0]!;

            // OpenCode persists the real model's ctx_reduce tool call, and the plugin queues the requested drop.
            let dropEmitted = false;
            h.mock.addMatcher((body) => {
                if (dropEmitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
                    return null;
                }
                if (!Array.isArray(body.tools)) return null;
                const name = (
                    body.tools.find((tool) =>
                        /ctx_reduce/.test(String((tool as { name?: unknown })?.name ?? "")),
                    ) as { name?: string } | undefined
                )?.name;
                if (!name) return null;

                dropEmitted = true;
                return {
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_duplicate_id_regression",
                            name,
                            input: { drop: String(dropTag) },
                        },
                    ],
                    stop_reason: "tool_use",
                    usage: {
                        input_tokens: 8_000,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                };
            });

            await h.sendPrompt(sessionId, `queue drop ${dropTag}: ${h.ballast(1_500)}`);
            expect(dropEmitted).toBe(true);

            // Shortening this session's durable cache TTL forces the next pass to bypass the warmed serialized-output caches.
            h.setSessionCacheTtl(sessionId, "1");

            // The final wire must show that the queued drop was consumed.
            for (let i = 5; i <= 7; i += 1) {
                h.mock.setDefault({
                    text: `selection pressure ${i}`,
                    usage: {
                        input_tokens: 3_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `pressure turn ${i}: ${h.ballast(2_500)}`);
                await Bun.sleep(800);
            }
            const passes = await h.waitForRustPasses(beforeDropPassCount + 3);
            const afterDrop = passes.slice(beforeDropPassCount);
            expect(afterDrop.some((pass) => pass.applied && pass.decision !== "SOFT+")).toBe(true);
            expect(afterDrop.some((pass) => pass.servedFrom === "transform")).toBe(true);
            expect(afterDrop.at(-1)?.decision).not.toBe("parked");
            expect(h.lastMainWireSerialized()).toContain(`[dropped §${dropTag}§]`);

            // The test checks every provider-facing served array because a duplicate tool-use ID can occur before the final array.
            for (const request of h.mainRequests()) {
                expect(duplicateToolUseIds(request.body.messages ?? [])).toEqual([]);
            }
        },
        300_000,
    );
});
