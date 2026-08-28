/**
 * Shared fixtures for historian-eval lane tests. Lives outside the `.test.ts`
 * files so contract, scorer, runner, mutation, and promote tests can share
 * one canonical scenario without importing each other's test registrations.
 */

import { parseScenario, type HistorianEvalScenario } from "./contract";
import { buildHistorianPayload, type PayloadFact } from "./payload";

export function validScenarioRaw(): Record<string, unknown> {
    return {
        schema: "historian-eval-scenario/v1",
        id: "hse-auth-rejected-redis",
        title: "Rejected Redis proposal must not surface as an active claim",
        families: ["proposed-but-rejected"],
        transcript: {
            turns: [
                {
                    user: "Should we use Redis for the session cache?",
                    assistant: "We could; Redis would give us TTL eviction out of the box.",
                },
                {
                    user: "No — we decided against Redis because it adds an operational dependency. Use the in-process LRU cache.",
                    assistant: "Understood: in-process LRU cache for sessions; Redis rejected for the operational dependency.",
                },
                {
                    user: "Also set the cache capacity to 4096 entries.",
                    assistant: "Done: cache capacity is 4096 entries.",
                },
                {
                    user: "Thanks, wrapping up this thread now.",
                    assistant: "Summary recorded; ready for the next task.",
                },
            ],
            epilogueStartIndex: 3,
        },
        trigger: {
            expectedHistorianRuns: 2,
            modelContextLimit: 200_000,
            usageTokensPerTurn: 1_000,
            spikeUsageTokens: 90_000,
            ballastTokensPerTurn: 1_500,
            headroomMarginTokens: 2_000,
        },
        gold: {
            expectedClaims: [
                {
                    id: "exp-lru-cache",
                    category: "ARCHITECTURE",
                    predicate: { kind: "normalized-substring", value: "in-process LRU cache" },
                    sourceTurnRange: [1, 1],
                },
                {
                    id: "exp-cache-capacity",
                    category: "CONFIG_VALUES",
                    predicate: { kind: "normalized-substring", value: "4096" },
                    sourceTurnRange: [2, 2],
                },
            ],
            expectedAbsent: [
                {
                    id: "abs-redis-active",
                    family: "proposed-but-rejected",
                    predicate: { kind: "normalized-substring", value: "use Redis for the session cache" },
                },
            ],
            compartments: { minCount: 1 },
        },
        probes: [
            {
                id: "probe-capacity",
                question: "What is the session cache capacity?",
                answerType: "exact",
                goldAnswer: "4096",
                sourceClaimRef: "exp-cache-capacity",
            },
            {
                id: "probe-store",
                question: "Which cache backs sessions?",
                answerType: "multiple-choice",
                choices: ["redis", "in-process lru"],
                goldAnswer: "in-process lru",
                sourceClaimRef: "exp-lru-cache",
            },
            {
                id: "probe-claim",
                question: "Which claim records the cache architecture?",
                answerType: "claim-id",
                expectedClaimRef: "exp-lru-cache",
            },
        ],
    };
}

export function validScenario(): HistorianEvalScenario {
    return parseScenario(validScenarioRaw());
}

/** Gold-satisfying facts for `validScenario`. */
export function goldFacts(): PayloadFact[] {
    return [
        { category: "ARCHITECTURE", content: "Sessions are cached by the in-process LRU cache; Redis was rejected because it adds an operational dependency." },
        { category: "CONFIG_VALUES", content: "Session cache capacity is 4096 entries." },
    ];
}

/**
 * A raw historian payload that fully satisfies `validScenario`'s gold: one
 * compartment covering the whole synthetic chunk, both gold facts, no
 * forbidden formations.
 */
export function goldenRawOutput(scenario: HistorianEvalScenario = validScenario(), facts: PayloadFact[] = goldFacts()): string {
    const messageCount = scenario.transcript.turns.length * 2;
    return buildHistorianPayload({
        compartments: [
            {
                start: 1,
                end: messageCount,
                title: "Session cache decision",
                body: "Chose the in-process LRU cache over Redis; capacity 4096.",
            },
        ],
        facts,
    });
}
