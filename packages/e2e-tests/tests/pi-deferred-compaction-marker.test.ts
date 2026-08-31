/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PiTestHarness } from "../src/pi-harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { openTestDb } from "../src/test-db";
import { isHistorianRequest } from "../src/cache-analysis";

/**
 *
 * Historian writes the pending marker to `session_meta.pending_pi_compaction_marker_state`.
 * Historian writes `pending_pi_compaction_marker_state` in the publish transaction.
 * The next materializing context pass calls `sessionManager.appendCompaction()`.
 * Deferring `appendCompaction()` preserves Anthropic's prompt cache until the next materialization pass.
 * The marker changes `getBranch()` only when the materialization pass applies pending tool drops.
 *
 *
 *      column (`pending_pi_compaction_marker_state`).
 * `fromHook: true` identifies an extension-generated compaction entry.
 * `firstKeptEntryId` must identify an entry in the visible branch.
 * Pi leaves `pending_compaction_marker_state` unset because OpenCode owns that deferred-marker path.
 *
 *
 * `firstKeptEntryId` must be non-empty.
 * `findFirstKeptEntryId` must use the same ordinal mapping as `convertEntriesToRawMessages`.
 * `convertEntriesToRawMessages` emits synthetic-user `RawMessage`s at `toolResult`→`assistant` transitions.
 * Mismatched ordinal mappings can prevent `findFirstKeptEntryId` from reaching `lastCompactedOrdinal` in tool-heavy sessions.
 * If `findFirstKeptEntryId` returns `null`, Pi does not call `appendCompaction()`.
 */

interface MarkerRow {
    pending_compaction_marker_state: string | null;
    pending_pi_compaction_marker_state: string | null;
    compaction_marker_state: string | null;
}

function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ content?: unknown }> | undefined;
    if (!messages) return null;
    for (const message of messages) {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
            const text = (block as { text?: unknown } | null)?.text;
            if (typeof text !== "string" || !text.includes("<new_messages>")) continue;
            const ordinals = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
            if (ordinals.length > 0) return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
        }
    }
    return null;
}

function readMarkerRow(h: PiTestHarness, sessionId: string): MarkerRow | null {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                `SELECT pending_compaction_marker_state,
                        pending_pi_compaction_marker_state,
                        compaction_marker_state
                 FROM session_meta WHERE session_id = ?`,
            )
            .get(sessionId) as MarkerRow | null;
    } finally {
        db.close();
    }
}

function latestSessionFile(h: PiTestHarness): string | null {
    const roots = [join(h.env.agentDir, "sessions"), h.env.agentDir];
    const files: string[] = [];
    const visit = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
        }
    };
    for (const root of roots) visit(root);
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
}

function readCompactionEntries(h: PiTestHarness): Array<Record<string, unknown>> {
    const file = latestSessionFile(h);
    if (!file) return [];
    return readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === "compaction");
}

/**
 * A Pi compartment row is the durable post-publish checkpoint.
 * Historian writes Pi compartments in the publish transaction.
 */
function readCompartmentCount(h: PiTestHarness, sessionId: string): number {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS c FROM compartments WHERE session_id = ? AND harness = 'pi'",
            )
            .get(sessionId) as { c: number } | undefined;
        return row?.c ?? 0;
    } finally {
        db.close();
    }
}

describe("pi compaction marker", () => {
    // TODO: Determine why historian publication does not create a durable compartment row in e2e.
    // Pressure at or above 95% uses the emergency path.
    // TODO: Determine why historian publication does not create a durable compartment row in e2e.
    // The transient pending_pi_compaction_marker_state can clear before polling observes it.
    // The next drain pass clears pending_pi_compaction_marker_state before polling observes it.
    // TODO: Determine why historian publication does not create a Pi compartment row in e2e.
    //      warmup sequence.
    //
    // packages/pi-plugin/src/compaction-marker-manager-pi.test.ts plus
    //
    // TODO: Determine why historian publication does not create a Pi compartment row in e2e.
    // TODO: Determine why historian publication does not create a Pi compartment row in e2e.
    // assertion adjustment.
    it.skip("defers native compaction entry and drains on next materializing pass", async () => {
        // Pi pressure includes input, cacheRead, and cacheWrite.
        // Pressure at or above 95% uses the emergency path.
        // The test keeps pressure below 95% to avoid the emergency path.
        // A 90% spike exceeds the 40% execute threshold while remaining below the 95% emergency threshold.
        const h = await PiTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: {
                execute_threshold_percentage: 40,
                historian: { model: "anthropic/claude-haiku-4-5" },
            },
        });
        try {
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body) ?? { start: 1, end: 2 };
                return {
                    text: buildMockHistorianPayload({
                        start: range.start,
                        end: range.end,
                        title: "pi compaction marker chunk",
                        body: "Pi historian publication used by the compaction marker e2e.",
                    }),
                    usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
                };
            });
            h.mock.setDefault({
                text: "fill",
                usage: { input_tokens: 1_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
            });

            let sessionId: string | null = null;
            for (let i = 1; i <= 10; i++) {
                const turn = await h.sendPrompt(`pi marker warmup turn ${i}: durable context for historian ${h.ballast(3_000)}`, {
                    timeoutMs: 60_000,
                });
                sessionId = turn.sessionId;
            }
            expect(sessionId).toBeTruthy();

            // The 90% spike exceeds the 40% execute threshold without entering the 95% emergency path.
            // recovery path.
            h.mock.setDefault({
                text: "big",
                usage: { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 0 },
            });
            await h.sendPrompt("pi marker trigger turn crosses execute threshold", { timeoutMs: 60_000 });

            h.mock.setDefault({
                text: "after-trigger",
                usage: { input_tokens: 500, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
            });
            await h.sendPrompt("pi marker post-trigger turn lets historian publish", { timeoutMs: 60_000 });

            // A Pi compartment row is the durable post-publish checkpoint.
            // subagent.
            //
            // `pending_pi_compaction_marker_state` can clear before polling observes it.
            // The next drain pass clears `pending_pi_compaction_marker_state`; do not wait for it.
            await h.waitFor(
                () => (readCompartmentCount(h, sessionId!) > 0 ? true : null),
                { timeoutMs: 300_000, label: "Pi historian publishes compartment row" },
            );

            // An additional prompt forces a materializing pass so the deferred drain runs.
            // The added prompt ensures deferred history is present and the pass consumes history.
            h.mock.setDefault({
                text: "drain-trigger",
                usage: { input_tokens: 600, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 600 },
            });
            await h.sendPrompt("pi marker drain turn materializes the deferred marker", {
                timeoutMs: 60_000,
            });

            // Pi's drain runs at end-of-pipeline only when deferred history is present and the pass consumed history.
            // The compaction-entry wait resolves immediately when the post-trigger turn already ran the drain.
            const compactions = await h.waitFor(
                () => {
                    const entries = readCompactionEntries(h);
                    return entries.length > 0 ? entries : null;
                },
                { timeoutMs: 120_000, label: "Pi native compaction entry written to JSONL" },
            );

            expect(compactions.length).toBeGreaterThan(0);
            const latest = compactions.at(-1)!;

            // `fromHook=true` attributes the entry to the magic-context extension, not Pi's own compactor.
            expect(latest.fromHook).toBe(true);

            expect(typeof latest.firstKeptEntryId).toBe("string");
            expect((latest.firstKeptEntryId as string).length).toBeGreaterThan(0);

            // `pending_compaction_marker_state` is OpenCode-only; Pi never writes it.
            // Pi's drain clears `pending_pi_compaction_marker_state`.
            const row = readMarkerRow(h, sessionId!);
            expect(row?.pending_compaction_marker_state ?? null).toBeNull();
            expect(row?.pending_pi_compaction_marker_state ?? null).toBeNull();
        } finally {
            await h.dispose();
        }
    }, 600_000);
});
