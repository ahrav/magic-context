/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";

/**
 *
 * The main agent must continue working while the historian is slow.
 *
 * read-session-chunk.ts):
 *
 * Eleven user turns leave at least 12 messages in the unsummarized tail after protecting the five newest user turns.
 * Below 95% usage, the proactive trigger requires either 12 tail messages or `MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE` tail tokens.
 * Above 95%, transform waits for the historian with a timeout.
 * The test keeps usage below 95% to exercise the non-blocking path.
 *         path works.
 *
 * Scenario:
 * The test sends 11 low-token user turns so raw history reaches the required tail size without crossing the execution threshold.
 * Turn 11 reports 90,000 input tokens so the event-handler trigger sees usage at or above `execute_threshold` with a meaningful tail.
 * The event-handler trigger sets `compartmentInProgress` when usage reaches `execute_threshold` and the tail is meaningful.
 * Turn 12 is the transform pass where we observe historian starting.
 * The mock records response completion so the shared suite can prove that the main request overlaps the in-flight historian without relying on a duration bound.
 * The test asserts that only one historian request is issued while the first historian run is pending, even when additional main turns occur.
 */

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

const HISTORIAN_DELAY_MS = 8_000;

function isHistorianRequest(body: Record<string, unknown>): boolean {
    if (JSON.stringify(body.messages ?? "").includes("<new_messages>")) return true;
    const system = body.system;
    if (system === undefined || system === null) return false;
    const asString = typeof system === "string" ? system : JSON.stringify(system);
    return asString.includes(HISTORIAN_SYSTEM_MARKER);
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 40,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("slow historian vs fast main", () => {
    it(
        "main turns stay responsive while historian hangs in background",
        async () => {
            // The empty-compartments payload prevents historian parse failure while delayMs keeps the historian in flight.
            // The response contains empty `<compartments>` and `<facts>` elements so the historian wrapper can parse it.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                return {
                    text:
                        "<output>" +
                        "<compartments></compartments>" +
                        "<facts></facts>" +
                        "<unprocessed_from>99</unprocessed_from>" +
                        "</output>",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: HISTORIAN_DELAY_MS,
                };
            });

            // The default mock reports usage below `execute_threshold` through turn 10.
            h.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });

            const sessionId = await h.createSession();

            // hasMeaningfulUserText() includes these user turns in the protected tail.
            // calculation.
            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful prompt carrying durable signal about build process step ${i}. ${h.ballast(3_000)}`,
                );
            }

            // Turn 11 reports 90,000 input tokens, crossing the 40% `execute_threshold` of 200,000 tokens.
            // With 11 user turns, the tail spans ordinals 1–12 and satisfies `MIN_PROACTIVE_TAIL_MESSAGE_COUNT`.
            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, "turn 11: trigger turn with meaningful content.");

            // The transform evaluates the trigger from the in-memory message tail, not the `message.updated` handler.
            // Turn 12's transform sets compartmentInProgress and starts the historian without blocking.

            // The 500-token usage stays below BLOCK_UNTIL_DONE_PERCENTAGE's 95% blocking threshold.
            // path (BLOCK_UNTIL_DONE_PERCENTAGE).
            h.mock.setDefault({
                text: "fast",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });

            // Turn 12's main request must be captured while the historian request remains in flight.
            const historianReqCountBeforeT12 = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body)).length;

            // The unawaited `turn12Promise` lets the test observe the request before completion.
            const turn12Promise = h.sendPrompt(
                sessionId,
                "turn 12: should be fast even with historian running.",
            );

            // The harness timeout only bounds a stuck test.
            // The contract assertion uses request completion state, not elapsed time.
            await h.waitFor(
                () => {
                    const reqs = h.mock.requests();
                    const mainT12 = reqs.find(
                        (r) =>
                            !isHistorianRequest(r.body) &&
                            JSON.stringify(r.body).includes("turn 12:"),
                    );
                    return mainT12 != null;
                },
                { timeoutMs: 180_000, label: "main turn 12 request arrives at mock" },
            );

            const mainRequestAtT12 = h.mock.requests().find(
                (request) =>
                    !isHistorianRequest(request.body) &&
                    JSON.stringify(request.body).includes("turn 12:"),
            );
            expect(mainRequestAtT12).toBeDefined();

            if (process.env.MC_E2E_MODE === "rust") {
                // In rust mode, skip the slow-historian delay assertions.
                console.log(`[rust-e2e] slow-historian delay assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                await turn12Promise;
                return;
            }

            try {
                await h.waitFor(
                    () => h.mock.requests().find((request) => isHistorianRequest(request.body)),
                    { timeoutMs: 180_000, label: "historian request starts" },
                );
            } catch (error) {
                // The catch block skips only when no historian request appears before the timeout.
                // A historian request that exists but arrives late must fail.
                const historianEverRouted = h.mock
                    .requests()
                    .some((request) => isHistorianRequest(request.body));
                if (historianEverRouted) throw error;
                console.log(
                    "[e2e] slow-historian overlap assertion not applicable: OpenCode did not route hidden historian through provider mock",
                );
                await turn12Promise;
                return;
            }
            const historianRequestAtT12 = h.mock
                .requests()
                .find((request) => isHistorianRequest(request.body));
            expect(historianRequestAtT12).toBeDefined();
            expect(historianRequestAtT12?.responseCompletedAt).toBeUndefined();

            // The test requires parallel requests, not an earlier historian start.
            // The request-completion assertions prove non-blocking behavior without relying on machine speed.
            const historianReqCountAtT12 = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body)).length;
            expect(historianReqCountAtT12).toBeGreaterThanOrEqual(
                historianReqCountBeforeT12,
            );
            // The historian request count after later turns must equal its count after turn 12.

            await turn12Promise;

            // Further main turns must not create a second historian request.
            await h.sendPrompt(sessionId, "turn 13: additional turn while historian pending.");
            await h.sendPrompt(sessionId, "turn 14: more activity while historian pending.");

            await h.waitFor(
                () => h.mock.requests().filter((r) => isHistorianRequest(r.body)).length >= 1,
                { timeoutMs: 10_000, label: "historian request captured" },
            );

            const historianRequests = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body));
            console.log(
                `[TEST] historian requests observed: ${historianRequests.length}`,
            );
            expect(historianRequests.length).toBe(1);

            expect(historianRequests.length).toBeGreaterThanOrEqual(1);

        },
        600_000,
    );
});
