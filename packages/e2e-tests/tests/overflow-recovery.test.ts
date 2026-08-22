/// <reference types="bun-types" />

/**
 * Context-overflow recovery (issue #32 regression test).
 *
 * Scenario: a model with a MISDETECTED context limit — the plugin (and
 * everything downstream) believes the model has a 128K window, but the real
 * provider limit is 120K. This is the exact trap from issue #32 where
 * `lemonade/GLM-4.7-Flash-GGUF` (a local GGUF model) is not in models.dev,
 * so `resolveContextLimit()` falls back to the 128K default while the real
 * runtime limit is smaller.
 *
 * ## What this verifies (end-to-end)
 *
 * 1. **Detection** — When the provider returns an overflow error, the plugin
 *    parses it against the shared overflow pattern set and records:
 *       - `session_meta.needs_emergency_recovery = 1`
 *       - `session_meta.detected_context_limit = <real limit parsed from error>`
 *
 * 2. **Pressure correction** — The very next transform pass resolves context
 *    limit from `session_meta.detected_context_limit` (the persisted real
 *    limit) instead of the models.dev / default fallback, so pressure math
 *    finally reflects reality.
 *
 * 3. **Recovery** — The emergency recovery flag forces the percentage to 95%
 *    even if the model's self-reported usage still looks low, which fires
 *    the existing 95% emergency path (abort + historian + aggressive drops).
 *    NOTE: recovery runs on a transform pass AFTER detection. On opencode
 *    <=1.15 an overflow triggered in-turn compaction (a second pass same
 *    turn), so recovery completed same-turn. On opencode >=1.16 (commit
 *    7e09660c3, "respect disabled auto compaction on overflow") a session
 *    with `compaction.auto:false` — the Magic Context default — errors the
 *    turn and goes idle with NO in-turn second pass, so recovery fires on
 *    the user's NEXT prompt. The plugin is correct in both cases; this test
 *    drives a follow-up turn and asserts on persisted state so it is
 *    version-agnostic.
 *
 * 4. **Completion** — When historian successfully publishes a compartment,
 *    the recovery flag is cleared so future turns aren't stuck at 95%.
 *    `detected_context_limit` remains — it's the authoritative real limit
 *    and remains valuable for future pressure math.
 *
 * ## Why this is an e2e test, not a unit test
 *
 * Unit tests already cover the pattern matcher, storage helpers, and the
 * `resolveContextLimit` session-override path individually. What this test
 * verifies is the integration: that the `session.error` event from OpenCode
 * actually reaches our handler, the persisted state is actually read by the
 * next transform, and the historian actually clears the flag.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorian(body: Record<string, unknown>): boolean {
    if (JSON.stringify(body.messages ?? "").includes("<new_messages>")) return true;
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

interface SessionMetaRow {
    needs_emergency_recovery: number | null;
    detected_context_limit: number | null;
}

let h: TestHarness;

beforeAll(async () => {
    // modelContextLimit is what the plugin *believes* — the default. The
    // mock provider then tells it the real limit is smaller via the overflow
    // error (matching the issue #32 scenario where lemonade accepts the
    // request at the plugin's default 128k but rejects somewhere under that).
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

            // Phase 1: answer main-agent turns normally so we have some
            // history to compartmentalize before overflow hits.
            let mainCalls = 0;
            let mainShouldOverflow = false;
            let historianCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                mainCalls++;

                // On the Nth main request, return a context-overflow error
                // with a reported real limit of 120000. This mimics
                // lemonade/LMStudio-style errors — non-SSE JSON body with an
                // Anthropic-shaped error envelope and a message string that
                // matches the overflow regex set and carries the real limit.
                if (mainShouldOverflow) {
                    mainShouldOverflow = false;
                    return {
                        error: {
                            status: 400,
                            type: "invalid_request_error",
                            // Matches the Groq pattern:
                            //   /reduce the length of the messages/i
                            // and the extractor pulls out 120000 as the real limit.
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
                if (!isHistorian(body)) return null;
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

            // Build a few turns of history so historian has something to
            // compartmentalize once triggered.
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

            // Baseline: no overflow state yet.
            const before = readState();
            expect(before.needs_emergency_recovery ?? 0).toBe(0);
            expect(before.detected_context_limit).toBeFalsy();

            const historianBeforeOverflow = historianCalls;

            // Flip the switch: the next main request will return a context-overflow
            // error from the provider.
            mainShouldOverflow = true;

            // Fire the turn that will overflow. The provider returns 400, so the
            // SDK throws. What opencode does next depends on its version:
            //   - opencode <=1.15: an overflow set `needsCompaction`, which ran
            //     opencode's compaction flow IN-TURN — producing a second
            //     transform pass on which our recovery fired same-turn.
            //   - opencode >=1.16 (commit 7e09660c3, "respect disabled auto
            //     compaction on overflow"): with `compaction.auto:false` (what
            //     every Magic Context user sets), opencode now errors the turn
            //     and goes idle — NO in-turn compaction, no second transform
            //     pass. Recovery therefore fires on the user's NEXT prompt.
            // Either way, DETECTION happens on this turn via the session.error
            // event; RECOVERY may be deferred to the next turn. The test asserts
            // detection here, then drives a follow-up turn and asserts recovery —
            // version-agnostic across both behaviors.
            try {
                await h.sendPrompt(sessionId, "user turn that will overflow", {
                    timeoutMs: 30_000,
                });
            } catch {
                // expected — provider returned 400
            }

            // Detection must persist on the overflow turn itself (the session.error
            // handler records the real limit + arms recovery), independent of when
            // the recovery historian actually runs.
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
                // Rust delegates the transform/recovery ladder to ck-mc rather
                // than the OpenCode-only fail-closed request sequencing below.
                // Its successful historian fold is also unavailable without the
                // hermetic Broca runner, so retain the shared overflow-detection
                // assertion and report the excluded completion contract.
                console.log(`[rust-e2e] overflow recovery mock-capture assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                expect(afterOverflow.detected_context_limit).toBe(120000);
                return;
            }

            // Drive the recovery turn. On opencode >=1.16 this is the pass that
            // bumps to 95% and fires the emergency historian; on <=1.15 recovery
            // already completed in-turn and this is just a normal follow-up (the
            // waitFor below still passes because the flag is already cleared and
            // the historian already ran). The follow-up prompt itself may succeed
            // or throw depending on timing — either is fine; we assert on state.
            try {
                await h.sendPrompt(sessionId, "follow-up turn that drives recovery", {
                    timeoutMs: 30_000,
                });
            } catch {
                // tolerated — recovery is asserted via persisted state, not the
                // prompt's own resolution.
            }
            if (recoveryWasPendingBeforeFollowup) {
                const recoveryStillPending = (readState().needs_emergency_recovery ?? 0) === 1;
                if (recoveryStillPending) {
                    // The historian did not publish, so the prompt is still the
                    // doomed shape: the fail-closed transform must interrupt the
                    // run before OpenCode emits another main-model request.
                    // Historian traffic is counted separately by the matcher above.
                    expect(mainCalls).toBe(mainCallsBeforeFollowup);
                }
                // Otherwise the recovery pass force-fired the historian, blocked
                // until it published, and the fold materialized in that same pass
                // — the prompt is compacted and no longer doomed, so the
                // fail-closed gate deliberately lets the request proceed
                // (aborting after a successful in-pass fold would interrupt a
                // healthy request). Main-model calls advancing is the success
                // path here; the end-state assertions below prove the recovery
                // actually completed rather than leaked.
            }

            // Wait for the recovery cycle to complete. End state evidence:
            //   - detected_context_limit persisted (proves detection worked)
            //   - needs_emergency_recovery cleared to 0 (proves historian ran
            //     the recovery path to completion — clearEmergencyRecovery
            //     only fires inside the successful-publication transaction)
            //   - at least one compartment was written (proves historian
            //     published, not just attempted)
            //   - at least one new historian HTTP request was received
            //     (proves the emergency path triggered the historian)
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

            // Final state assertions — documents the intended post-recovery shape.
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
                if (isHistorian(body)) return null;
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

            // Give the event bus time to deliver.
            await Bun.sleep(1_500);

            const ctx = h.contextDb();
            const row = ctx
                .prepare(
                    "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as SessionMetaRow | undefined;

            // Rate-limit errors must NOT trigger recovery. This guards against
            // an overly broad pattern match in overflow-detection.ts.
            expect(row?.needs_emergency_recovery ?? 0).toBe(0);
            expect(row?.detected_context_limit ?? null).toBeFalsy();
        },
        30_000,
    );
});
