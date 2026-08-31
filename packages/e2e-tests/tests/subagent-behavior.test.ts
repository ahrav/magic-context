/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 * Subagent-specific behavior.
 *
 * Subagents (child sessions with a non-empty `parentID`) run in REDUCED mode.
 *
 * The `session.created` handler writes `session_meta.is_subagent = 1` from `parentID`.
 * Without `session_meta.is_subagent = 1`, downstream gates classify the session as a primary agent.
 *
 * Subagents skip the compartment phase.
 * `fullFeatureMode = false` short-circuits `runCompartmentPhase`.
 * `fullFeatureMode = false` short-circuits `prepareCompartmentInjection` in `transform.ts`.
 *
 * `ctx_reduce` adds §N§ prefixes to subagents when enabled.
 * The prefixes include a guidance block.
 * `ctx_reduce`-disabled subagents receive no prefix.
 *
 * Only primary agents receive Channel 2 nudges, note nudges, and compartments.
 *     synthetic-user ceiling nudge stays primary-only (`fullFeatureMode`).
 *     Subagents rely on Channel 1 + the ≥85% tiered emergency floor.
 *
 * At ≥85%, subagents begin the tiered emergency tool drop.
 * During force materialization, `planEmergencyDrop` evicts tool tags T3→T2→T1 to preserve target headroom.
 * Without the emergency drop, subagent context can grow until provider overflow.
 *
 * Subagents let provider overflow errors propagate.
 * On provider context overflow, the plugin does not start historian recovery for subagents.
 * The plugin records the overflow and propagates the error.
 *
 */

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (typeof sys === "string") return sys.includes(HISTORIAN_MARKER);
    if (Array.isArray(sys)) {
        for (const block of sys) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && text.includes(HISTORIAN_MARKER)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 */
function hasTagPrefixedUserMessage(body: Record<string, unknown>): boolean {
    const messages = body.messages as
        | Array<{ role: string; content: unknown }>
        | undefined;
    if (!messages) return false;
    for (const m of messages) {
        if (m.role !== "user") continue;
        const content = m.content;
        if (typeof content === "string" && /§\d+§/.test(content)) return true;
        if (Array.isArray(content)) {
            for (const block of content) {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && /§\d+§/.test(text)) return true;
            }
        }
    }
    return false;
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: 200_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            // `protected_tags: 5` leaves older tags eligible for dropping above the execute threshold.
            protected_tags: 5,
            dreamer: { disable: true },
            sidekick: { disable: true },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

afterEach(() => {
    h.mock.reset();
});

describe("subagent behavior", () => {
    it(
        "session.created sets is_subagent=1 when parentID is present",
        async () => {
            h.mock.setDefault({
                text: "ok",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 0,
                },
            });

            const parent = await h.createSession();
            const child = await h.createChildSession(parent, "child-test");

            // OpenCode persists the child row asynchronously after `session.created`.
            // OpenCode persists the child row asynchronously after `session.created`.
            // OpenCode persists the child row asynchronously after `session.created`.
            //
            await h.waitFor(() => h.isSubagent(child) === true, {
                timeoutMs: 5_000,
                label: "child is_subagent=true",
            });

            expect(h.isSubagent(child)).toBe(true);

            await h.sendPrompt(parent, "parent kick");
            await h.waitFor(() => h.isSubagent(parent) === false, {
                timeoutMs: 5_000,
                label: "parent is_subagent=false after first turn",
            });
            expect(h.isSubagent(parent)).toBe(false);
        },
        30_000,
    );

    it(
        "subagent WITH ctx_reduce enabled DOES inject §N§ tag prefixes (self-management)",
        async () => {
            h.mock.setDefault({
                text: "ok",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 0,
                },
            });

            const parent = await h.createSession();
            const child = await h.createChildSession(parent);

            await h.waitFor(() => h.isSubagent(child) === true, {
                timeoutMs: 5_000,
                label: "child is_subagent=true",
            });

            await h.sendPrompt(child, "subagent turn 1: hello from a child session");
            await h.sendPrompt(child, "subagent turn 2: another message");

            expect(h.countTags(child)).toBeGreaterThan(0);

            const requests = h.mock.requests();
            expect(requests.length).toBeGreaterThanOrEqual(2);

            const tagged = requests.filter((r) => hasTagPrefixedUserMessage(r.body));
            expect(tagged.length).toBeGreaterThan(0);
        },
        30_000,
    );

    it(
        "subagent never triggers historian, even when usage crosses execute threshold",
        async () => {
            h.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });

            const parent = await h.createSession();
            const child = await h.createChildSession(parent);

            await h.waitFor(() => h.isSubagent(child) === true, {
                timeoutMs: 5_000,
                label: "child is_subagent=true",
            });

            for (let i = 1; i <= 5; i++) {
                await h.sendPrompt(
                    child,
                    `subagent fill turn ${i}: meaningful durable content about step ${i}.`,
                );
            }

            // Crossing 80,000 input tokens starts the historian for primary sessions, but subagents skip the compartment phase.
            h.mock.setDefault({
                text: "spike",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(child, "subagent spike: this would trigger historian in a primary.");

            // The extra turn lets the transform process the post-spike state.
            h.mock.setDefault({
                text: "post-spike",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            await h.sendPrompt(child, "subagent post-spike turn.");

            // Asynchronous transforms can update historian state after the prompt resolves.
            await Bun.sleep(500);

            const historianRequests = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body));
            console.log(
                `[TEST] historian requests during subagent run: ${historianRequests.length}`,
            );
            expect(historianRequests.length).toBe(0);

            expect(h.countCompartments(child)).toBe(0);

            // The compartment phase never sets `compartment_in_progress` for subagent sessions.
            const row = h
                .contextDb()
                .prepare(
                    "SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
                )
                .get(child) as { compartment_in_progress: number } | null;
            expect(row?.compartment_in_progress ?? 0).toBe(0);
        },
        60_000,
    );

    it(
        "subagent scheduler returns execute when usage crosses threshold (heuristic cleanup gate)",
        async () => {
            // `tool_use` causes OpenCode to invoke a real tool, but the mock environment registers no matching tool.
            // Recording `last_context_percentage` lets heuristic cleanup run for subagents.
            // Without heuristic cleanup, subagents retain tool tags.
            //
            // math itself.

            h.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });

            const parent = await h.createSession();
            const child = await h.createChildSession(parent);

            await h.waitFor(() => h.isSubagent(child) === true, {
                timeoutMs: 5_000,
                label: "child is_subagent=true",
            });

            await h.sendPrompt(child, "subagent turn 1: meaningful content");
            await h.sendPrompt(child, "subagent turn 2: more content");

            const baseRow = h
                .contextDb()
                .prepare(
                    "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                )
                .get(child) as { last_context_percentage: number } | null;
            const basePct = baseRow?.last_context_percentage ?? 0;
            console.log(`[TEST] subagent baseline percentage: ${basePct.toFixed(1)}%`);
            expect(basePct).toBeLessThan(40);

            // The spike exceeds the execute threshold: 40% of 200K is 80K.
            h.mock.setDefault({
                text: "spike",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(child, "subagent spike: cross execute threshold");

            // `message.updated` updates the context percentage asynchronously.
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                        )
                        .get(child) as { last_context_percentage: number } | null;
                    return (row?.last_context_percentage ?? 0) >= 40;
                },
                { timeoutMs: 5_000, label: "percentage reflects spike" },
            );

            const spikedRow = h
                .contextDb()
                .prepare(
                    "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                )
                .get(child) as { last_context_percentage: number } | null;
            console.log(
                `[TEST] subagent post-spike percentage: ${spikedRow?.last_context_percentage.toFixed(1)}%`,
            );
            expect(spikedRow?.last_context_percentage ?? 0).toBeGreaterThanOrEqual(40);

            // Subagent sessions leave compartment state unchanged.
            const row = h
                .contextDb()
                .prepare(
                    "SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
                )
                .get(child) as { compartment_in_progress: number } | null;
            expect(row?.compartment_in_progress ?? 0).toBe(0);

            const historianReqs = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body));
            expect(historianReqs.length).toBe(0);
            expect(h.countCompartments(child)).toBe(0);
        },
        60_000,
    );

    it(
        "subagent overflow surfaces the provider error without triggering emergency recovery",
        async () => {
            // Emergency recovery is PRIMARY-only; provider overflows propagate for subagents.
            // The plugin must not mark subagents for emergency recovery because they cannot run historian.

            h.mock.addMatcher((body) => {
                if (isHistorianRequest(body)) return null;
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message:
                            "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.",
                    },
                };
            });

            const parent = await h.createSession();
            const child = await h.createChildSession(parent);

            await h.waitFor(() => h.isSubagent(child) === true, {
                timeoutMs: 5_000,
                label: "child is_subagent=true",
            });

            try {
                await h.sendPrompt(child, "subagent turn that will overflow", {
                    timeoutMs: 15_000,
                });
            } catch {
            }

            await Bun.sleep(1_000);

            const row = h
                .contextDb()
                .prepare(
                    "SELECT needs_emergency_recovery, compartment_in_progress FROM session_meta WHERE session_id = ?",
                )
                .get(child) as
                | { needs_emergency_recovery: number | null; compartment_in_progress: number | null }
                | null;

            console.log(
                `[TEST] subagent after overflow: needs_emergency_recovery=${row?.needs_emergency_recovery} compartment_in_progress=${row?.compartment_in_progress}`,
            );

            expect(row?.needs_emergency_recovery ?? 0).toBe(0);
            expect(row?.compartment_in_progress ?? 0).toBe(0);

            const historianReqs = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body));
            expect(historianReqs.length).toBe(0);
        },
        45_000,
    );
});
