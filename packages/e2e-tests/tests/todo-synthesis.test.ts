
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import {
    TODO_MODEL_CONTEXT_LIMIT,
    runOpenCodeTodoScenario,
    type OpenCodeTodoScenario,
} from "../src/incident-pool/scenarios/parity-synthetic-todo";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: TODO_MODEL_CONTEXT_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
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

const SCENARIOS: Array<{
    name: string;
    scenario: OpenCodeTodoScenario;
    timeout: number;
}> = [
    {
        name: "captures todowrite args into last_todo_state",
        scenario: "capture",
        timeout: 60_000,
    },
    {
        name: "injects a synthetic todowrite pair on a cache-busting pass",
        scenario: "injection",
        timeout: 90_000,
    },
    {
        name: "replays the persisted synthetic pair byte-identically on defer passes",
        scenario: "replay",
        timeout: 120_000,
    },
    {
        name: "defer replay ignores a newer real todowrite until the next cache-bust",
        scenario: "newer-deferral",
        timeout: 120_000,
    },
    {
        name: "self-heals legacy anchors with empty stateJson and replays them on defer",
        scenario: "legacy-heal",
        timeout: 120_000,
    },
    {
        name: "skips todowrite capture and synthetic injection for subagents",
        scenario: "subagent-gate",
        timeout: 90_000,
    },
    {
        name: "clears the persisted synthetic anchor when the latest todo state is terminal-only",
        scenario: "terminal-clear",
        timeout: 120_000,
    },
];

describe("synthetic todowrite e2e", () => {
    for (const scenario of SCENARIOS) {
        it(
            scenario.name,
            async () => {
                expect(await runOpenCodeTodoScenario(h, scenario.scenario)).toEqual([]);
            },
            scenario.timeout,
        );
    }
});
