/// <reference types="bun-types" />

/**
 * The cold-start seed preserves TS drops as frozen reductions so the first Rust pass does not re-expand dropped content.
 *
 * ctx_reduce must create a `[dropped §N§]` reduction in TS state.
 * The restart uses the same data directory so `opencode.db` and `context.db` persist.
 * The first Rust pass must preserve the drop rather than re-expand it.
 * The served wire must be smaller than the raw message array.
 *
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

/**
 * */
function rawArrayBytes(h: RustTestHarness, sessionId: string): number {
    const ocPath = join(h.env.dataDir, "opencode", "opencode.db");
    const db = new Database(ocPath, { readonly: true });
    try {
        const parts = db
            .prepare(
                "SELECT p.data AS data FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ?",
            )
            .all(sessionId) as Array<{ data: string }>;
        return parts.reduce((sum, part) => sum + Buffer.byteLength(part.data), 0);
    } finally {
        db.close();
    }
}

describe.skipIf(!rustPrereqs.ok)("rust invariant: cold-start drop seed", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        // The test uses a small context limit and real content ballast so true raw content crosses the execute threshold.
        // rawArrayBytes measures persisted part data instead of mock usage.
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            startInTsMode: true,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("seeds TS dropped-tag state into the first rust pass without context expansion", async () => {
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
            await h.sendPrompt(sessionId, `turn ${i}: ${h.ballast(1_500)}`);
        }
        await Bun.sleep(500);

        const tsWire = h.lastMainWireSerialized();
        const tags = [...new Set([...tsWire.matchAll(/§(\d+)§/g)].map((m) => Number(m[1])))].sort(
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
                tools.find((t) => /ctx_reduce/.test(String((t as { name?: unknown })?.name ?? ""))) as
                    | { name?: string }
                    | undefined
            )?.name;
            if (!name) return null;
            dropEmitted = true;
            return {
                content: [
                    { type: "tool_use", id: `toolu_reduce_${Date.now()}`, name, input: { drop: String(dropTag) } },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 8_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
            };
        });
        await h.sendPrompt(sessionId, `turn 4: reduce tag ${dropTag}`);

        // Real-content pressure causes the pending drop to apply during an execute pass.
        for (let i = 5; i <= 7; i += 1) {
            h.mock.setDefault({
                text: `pressure ${i}`,
                usage: { input_tokens: 20_000, output_tokens: 20, cache_creation_input_tokens: 2_000 },
            });
            await h.sendPrompt(sessionId, `turn ${i}: ${h.ballast(1_500)}`);
        }
        await Bun.sleep(800);

        expect(dropEmitted).toBe(true);
        const tsFinalWire = h.lastMainWireSerialized();
        expect(tsFinalWire).toContain("[dropped");
        const tsWireBytes = h.lastMainWireBytes();
        const rawBytes = rawArrayBytes(h, sessionId);

        await h.restart({
            rust: true,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });

        // The cold-start seed must translate the TS frozen reduction so the drop is reproduced rather than re-expanded.
        h.mock.setDefault({
            text: "after flip",
            usage: { input_tokens: 20_000, output_tokens: 20, cache_creation_input_tokens: 2_000 },
        });
        await h.sendPrompt(sessionId, `turn 8: after flip ${h.ballast(300)}`);
        await Bun.sleep(800);

        const rustPasses = await h.waitForRustPasses(1);
        expect(rustPasses.length).toBeGreaterThan(0);
        const rustWire = h.lastMainWireSerialized();
        const rustWireBytes = h.lastMainWireBytes();

        // The first Rust wire must retain the `[dropped …]` marker from the seeded frozen reduction.
        expect(rustWire).toContain("[dropped");

        // The first Rust wire is smaller than the raw message array.
        expect(rustWireBytes).toBeLessThan(rawBytes);

        expect(rustWireBytes).toBeLessThan(tsWireBytes * 2);
    }, 300_000);
});
