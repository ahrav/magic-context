/// <reference types="bun-types" />

/**
 *
 * The plugin and downstream components use a misdetected 128K context limit.
 * The test reproduces a configured limit that exceeds the provider limit.
 * `lemonade/GLM-4.7-Flash-GGUF` is a local GGUF model absent from models.dev.
 * `resolveContextLimit()` falls back to the 128K default.
 * The provider runtime limit is smaller than 128K.
 *
 *
 * The plugin parses provider overflow errors with the shared overflow patterns.
 * The plugin sets `session_meta.needs_emergency_recovery` to `1`.
 * The plugin stores the limit parsed from the error in `session_meta.detected_context_limit`.
 *
 * The next transform resolves its context limit from `session_meta.detected_context_limit`.
 * `session_meta.detected_context_limit` persists the provider's parsed context limit.
 * Pressure calculations stop using the models.dev/default fallback after detection.
 * Pressure calculations use the detected provider limit.
 *
 * `needs_emergency_recovery` forces pressure to 95%.
 * The forced 95% pressure overrides low self-reported usage.
 * At 95%, the emergency path aborts, invokes historian, and drops context.
 * Recovery runs on the transform pass after detection.
 * OpenCode <=1.15 runs a second in-turn compaction pass after overflow.
 * OpenCode <=1.15 can complete recovery in the same turn.
 * OpenCode >=1.16 runs recovery on a follow-up turn.
 * The test drives a follow-up turn and asserts persisted state to support both OpenCode behaviors.
 *    version-agnostic.
 *
 * When historian publishes a compartment, it clears the recovery flag.
 * Clearing `needs_emergency_recovery` prevents future turns from remaining at 95% pressure.
 *
 *
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";
import { isHistorianRequest } from "../src/cache-analysis";

interface SessionMetaRow {
    needs_emergency_recovery: number | null;
    detected_context_limit: number | null;
}

let h: TestHarness;

beforeAll(async () => {
    // The provider can accept the configured limit but enforce a smaller actual limit.
    h = await TestHarness.create({
        modelContextLimit: 128_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("context overflow recovery", () => {
    it(
        "detects provider overflow, persists real limit, triggers emergency recovery, clears flag on historian success",
        async () => {
            h.mock.reset();

            let mainCalls = 0;
            let mainShouldOverflow = false;
            let historianCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorianRequest(body)) return null;
                mainCalls++;

                if (mainShouldOverflow) {
                    mainShouldOverflow = false;
                    return {
                        error: {
                            status: 400,
                            type: "invalid_request_error",
                            // The error message must match `/reduce the length of the messages/i`.
                            // The extractor reads 120000 as the context limit.
                            message:
                                "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.",
                        },
                    };
                }

                return {
                    text: `assistant turn ${mainCalls}`,
                    usage: {
                        input_tokens: 500 + mainCalls * 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                historianCalls++;
                const msgs = body.messages as Array<{ content?: unknown }> | undefined;
                const flat = JSON.stringify(msgs ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 0;
                const end = rangeHdr ? Number(rangeHdr[2]) : 0;
                return {
                    text: buildMockHistorianPayload({
                        start,
                        end,
                        title: "Overflow recovery",
                        body: "Summary.",
                    }),
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            const sessionId = await h.createSession();

            // Historian needs history to compartmentalize.
            for (let i = 1; i <= 6; i++) {
                await h.sendPrompt(sessionId, `user turn ${i}: some work ${h.ballast(2_000)}`, {
                    timeoutMs: 30_000,
                });
            }

            const ctx = h.contextDb();
            const readState = (): SessionMetaRow => {
                const row = ctx
                    .prepare(
                        "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId) as SessionMetaRow | undefined;
                return row ?? { needs_emergency_recovery: null, detected_context_limit: null };
            };

            const before = readState();
            expect(before.needs_emergency_recovery ?? 0).toBe(0);
            expect(before.detected_context_limit).toBeFalsy();

            const historianBeforeOverflow = historianCalls;

            mainShouldOverflow = true;

            // A 400 response causes the SDK call to throw.
            // with `compaction.auto:false`, OpenCode errors the turn and goes idle with no in-turn compaction or second transform pass.
            // Recovery can run during the failing turn or on the next prompt.
            // The `session.error` event detects overflow on the failing turn.
            try {
                await h.sendPrompt(sessionId, "user turn that will overflow", {
                    timeoutMs: 30_000,
                });
            } catch {
                // The provider returns 400 for this prompt.
            }

            // The `session.error` handler persists the real limit and arms recovery on the overflow turn, regardless of when historian recovery runs.
            const afterOverflow = await h.waitFor(
                () => {
                    const s = readState();
                    if (s.detected_context_limit !== 120000) return false;
                    return s;
                },
                {
                    timeoutMs: 15_000,
                    intervalMs: 100,
                    label: "overflow detected (real limit persisted)",
                },
            );
            expect(afterOverflow.detected_context_limit).toBe(120000);

            const recoveryWasPendingBeforeFollowup =
                (readState().needs_emergency_recovery ?? 0) === 1;
            const mainCallsBeforeFollowup = mainCalls;

            if (process.env.MC_E2E_MODE === "rust") {
                // Rust delegates the transform/recovery ladder to `McHandler` instead of using OpenCode's fail-closed request sequencing.
                // Rust requires the hermetic Broca runner for a successful historian fold.
                console.log(`[rust-e2e] overflow recovery mock-capture assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                expect(afterOverflow.detected_context_limit).toBe(120000);
                return;
            }

            // On OpenCode >=1.16, the follow-up triggers the 95% emergency-historian pass.
            // On OpenCode <=1.15, recovery completes during the overflow turn.
            // `sendPrompt` may resolve or reject; persisted state determines recovery.
            try {
                await h.sendPrompt(sessionId, "follow-up turn that drives recovery", {
                    timeoutMs: 30_000,
                });
            } catch {
            }
            if (recoveryWasPendingBeforeFollowup) {
                const recoveryStillPending = (readState().needs_emergency_recovery ?? 0) === 1;
                if (recoveryStillPending) {
                    // While `needs_emergency_recovery === 1`, the fail-closed transform must interrupt the run.
                    // The fail-closed transform must interrupt before OpenCode emits another main-model request.
                    expect(mainCalls).toBe(mainCallsBeforeFollowup);
                }
                // A successful follow-up recovery pass force-fires and waits for the historian.
                // The recovery pass waits for historian publication before the fold materializes.
            }

            // `h.countCompartments(sessionId) >= 1` confirms publication rather than only an attempt.
            let afterRecovery: SessionMetaRow;
            try {
                afterRecovery = await h.waitFor(
                    () => {
                        const s = readState();
                        if (s.detected_context_limit !== 120000) return false;
                        if ((s.needs_emergency_recovery ?? 0) !== 0) return false;
                        if (h.countCompartments(sessionId) < 1) return false;
                        return s;
                    },
                    {
                        timeoutMs: 20_000,
                        intervalMs: 100,
                        label: "overflow detected, recovery completed, flag cleared",
                    },
                );
            } catch (err) {
                const stderrTail = h.opencode.stderr().slice(-2000);
                const currentState = readState();
                throw new Error(
                    `overflow recovery did not complete: ${String(err)}\n` +
                        `\ncurrent state: ${JSON.stringify(currentState)}\n` +
                        `historian calls: ${historianCalls} (was ${historianBeforeOverflow})\n` +
                        `compartments: ${h.countCompartments(sessionId)}\n` +
                        `\nopencode stderr tail:\n${stderrTail}`,
                );
            }

            expect(afterRecovery.detected_context_limit).toBe(120000);
            expect(afterRecovery.needs_emergency_recovery).toBe(0);
            expect(h.countCompartments(sessionId)).toBeGreaterThanOrEqual(1);
        },
        180_000,
    );

    it(
        "ignores non-overflow errors (rate limits, auth)",
        async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (isHistorianRequest(body)) return null;
                return {
                    error: {
                        status: 429,
                        type: "rate_limit_error",
                        message: "Rate limit exceeded. Please try again later.",
                    },
                };
            });

            const sessionId = await h.createSession();

            try {
                await h.sendPrompt(sessionId, "this will rate-limit", { timeoutMs: 15_000 });
            } catch {
                // expected
            }

            await Bun.sleep(1_500);

            const ctx = h.contextDb();
            const row = ctx
                .prepare(
                    "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as SessionMetaRow | undefined;

            expect(row?.needs_emergency_recovery ?? 0).toBe(0);
            expect(row?.detected_context_limit ?? null).toBeFalsy();
        },
        30_000,
    );
});
